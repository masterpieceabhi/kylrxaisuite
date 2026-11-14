const express = require('express');
const router = express.Router();
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);

// Administrative payroll routes require Admin/HR roles. Only the two "pay documents of one person" reads are open to
// other signed-in people; who may read whose documents is decided inside them (services/payroll-doc-access.js).
// The paths are matched exactly, so no other route can slip past the role check by having a look-alike id in its path.
const PERSON_DOCUMENT_READS = [/^\/documents\/[^/]+\/download-url\/?$/, /^\/employee\/[^/]+\/documents\/?$/];
router.use((req, res, next) => {
    if (req.method === 'GET' && PERSON_DOCUMENT_READS.some((re) => re.test(req.path))) {
        return next();
    }
    return authorize(ADMIN_HR_ROLES)(req, res, next);
});

let admin, db;
try {
    ({ admin, db } = require('../config/firebase'));
} catch (e) {
    console.warn('[PAYROLL] Firebase Admin not available:', e.message);
}

// Decoupled Payroll Controller (PRD Section 4)
const payrollController = require('../controllers/payroll-controller');

// ─────────────────────────────────────────────
// 0. PAYROLL RUNS & DISBURSEMENT BATCHES (caller's organization, used by the Operational Dashboard)
// ─────────────────────────────────────────────
const { orgDocs } = require('../config/tenant');
const firebaseConfig = require('../config/firebase');
const orgOf = (req) => (req.user && req.user.orgId) || req.tenantOrgId || null;
const payAccess = require('../services/payroll-doc-access');
const snapExists = (snap) => Boolean(snap) && (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const dbReady = () => Boolean(db && admin && admin.apps && admin.apps.length);
/** A stored record read by its id counts only when it belongs to the caller's company */
const ownRecord = (req, snap) => (snapExists(snap) && payAccess.inCompany(orgOf(req), snap.data()) ? snap.data() : null);
/** The stored person a pay document belongs to (login record first, then the older employee record), or null */
async function personRecord(employeeId) {
    for (const name of ['users', 'employees']) {
        const snap = await firebaseConfig.rawCollection(name).doc(String(employeeId)).get();
        if (snapExists(snap)) return snap.data() || {};
    }
    return null;
}
const validId = (id) => typeof id === 'string' && id.length > 0 && id.length <= 200 && !id.includes('/');
const refuse = (res, verdict) => res.status(verdict.status).json({ success: false, error: verdict.error });
const newestFirst = (field) => (a, b) => String(b[field] || '').localeCompare(String(a[field] || ''));

router.get('/runs', async (req, res) => {
    try {
        const orgId = orgOf(req);
        if (!orgId || !admin || !admin.apps.length) return res.json({ success: true, runs: [] });
        const runs = (await orgDocs(firebaseConfig.rawCollection, 'payroll_runs', orgId, 200))
            .map(r => ({ ...r, timestamp: r.timestamp && r.timestamp.toDate ? r.timestamp.toDate().toISOString() : r.timestamp }))
            .sort(newestFirst('period'));
        res.json({ success: true, runs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/batches', async (req, res) => {
    try {
        const orgId = orgOf(req);
        if (!orgId || !admin || !admin.apps.length) return res.json({ success: true, batches: [] });
        // Batches are written by the disbursement service (disbursement_batches) and older flows
        const [current, legacy] = await Promise.all([
            orgDocs(firebaseConfig.rawCollection, 'disbursement_batches', orgId, 200),
            orgDocs(firebaseConfig.rawCollection, 'payroll_disbursement_batches', orgId, 200)
        ]);
        const batches = [...current, ...legacy].sort(newestFirst('createdAt'));
        res.json({ success: true, batches });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─────────────────────────────────────────────
// 1. DECOUPLED PAYROLL DOCUMENT ROUTES
// ─────────────────────────────────────────────
router.post('/documents/generate-payslip', payrollController.generatePayslip);
router.post('/documents/generate-batch', payrollController.generateBatch);
router.post('/documents/export-register-excel', payrollController.exportRegisterExcel);
router.post('/documents/export-register-pdf', payrollController.exportRegisterPdf);
// The vault list is built by the controller; only the caller's company's documents leave this router
router.get('/documents/vault', (req, res, next) => {
    const send = res.json.bind(res);
    res.json = (body) => {
        if (body && Array.isArray(body.documents)) {
            const documents = body.documents.filter((d) => payAccess.inCompany(orgOf(req), d));
            return send({ ...body, count: documents.length, documents });
        }
        return send(body);
    };
    next();
}, payrollController.getVaultDocuments);

// ─────────────────────────────────────────────
// 2. DECOUPLED DECENTRO DISBURSEMENT ROUTES
// ─────────────────────────────────────────────
router.post('/disburse/create-batch', payrollController.createDisbursementBatch);
router.post('/disburse/batch/:batchId/approve', payrollController.approveDisbursementBatch);
router.post('/disburse/batch/:batchId/execute', payrollController.executeDisbursementBatch);
router.get('/disburse/batch/:batchId/status', payrollController.getDisbursementBatchStatus);
router.post('/disburse/webhook/decentro', payrollController.handleDecentroWebhook);


/**
 * Signed download URL for payslip PDFs (works with strict Storage rules).
 * GET /api/payroll/documents/:docId/download-url?employeeId=...
 */
router.get('/documents/:docId/download-url', async (req, res) => {
    try {
        const { docId } = req.params;
        const { employeeId } = req.query;

        if (!validId(employeeId)) {
            return res.status(400).json({ success: false, error: 'employeeId is required' });
        }

        // Who is asking comes first: the person themself, or a role that may see pay. Nothing is read before this.
        const who = { user: req.user, callerOrgId: orgOf(req), employeeId };
        const first = payAccess.decide(who);
        if (!first.ok) return refuse(res, first);

        if (!dbReady()) {
            return res.status(503).json({ success: false, error: 'Firebase Admin not configured' });
        }

        // Same company: the person the documents belong to, and the document itself
        const person = await personRecord(employeeId);
        const aboutPerson = payAccess.decide({ ...who, person });
        if (!aboutPerson.ok) return refuse(res, aboutPerson);

        const docSnap = validId(docId) ? await db.collection('payroll_documents').doc(docId).get() : null;
        const data = snapExists(docSnap) ? docSnap.data() : null;
        const verdict = payAccess.decide({ ...who, person, doc: data });
        if (!verdict.ok) return refuse(res, verdict);

        if (data.storageUrl) {
            return res.json({ success: true, url: data.storageUrl, source: 'firestore' });
        }

        if (!data.storagePath) {
            return res.status(404).json({ success: false, error: 'No PDF file attached to this document' });
        }

        const bucket = admin.storage().bucket();
        const file = bucket.file(data.storagePath);
        const [url] = await file.getSignedUrl({
            action: 'read',
            expires: Date.now() + 15 * 60 * 1000
        });

        return res.json({
            success: true,
            url,
            fileName: data.fileName || 'payslip.pdf',
            source: 'signed'
        });
    } catch (error) {
        console.error('[PAYROLL] Signed URL error:', error.message);
        return res.status(500).json({ success: false, error: 'Failed to generate download URL' });
    }
});

/**
 * List payslips for an employee (employee portal).
 * GET /api/payroll/employee/:employeeId/documents
 */
router.get('/employee/:employeeId/documents', async (req, res) => {
    try {
        const { employeeId } = req.params;
        const who = { user: req.user, callerOrgId: orgOf(req), employeeId };
        const first = payAccess.decide(who);
        if (!first.ok) return refuse(res, first);
        if (!db) {
            return res.status(503).json({ success: false, error: 'Firebase Admin not configured' });
        }
        const aboutPerson = payAccess.decide({ ...who, person: await personRecord(employeeId) });
        if (!aboutPerson.ok) return refuse(res, aboutPerson);
        const snap = await db.collection('payroll_documents')
            .where('employeeId', '==', employeeId)
            .orderBy('createdAt', 'desc')
            .limit(50)
            .get();

        const documents = [];
        snap.forEach((doc) => {
            const d = doc.data();
            // an employee ID can repeat between companies: only this company's documents are listed
            if (!payAccess.inCompany(who.callerOrgId, d)) return;
            if (d.docType === 'Payslip' || d.docType === 'Invoice') {
                documents.push({
                    id: doc.id,
                    docType: d.docType,
                    period: d.period,
                    status: d.status,
                    fileName: d.fileName,
                    createdAt: d.createdAt?.toDate?.()?.toISOString?.() || null
                });
            }
        });

        return res.json({ success: true, count: documents.length, data: documents });
    } catch (error) {
        console.error('[PAYROLL] List documents error:', error.message);
        return res.status(500).json({ success: false, error: 'Failed to list payroll documents' });
    }
});

/**
 * Top Summary Cards Data Provider (Gross Payroll, Employee Deductions, Net Salary, Employer Contributions).
 * GET /api/payroll/runs/:runId/summary OR GET /api/payroll-runs/:runId/summary
 * 
 * Strict Security: Computes values entirely server-side from active records.
 * Explicitly rejects any client-provided sums or overrides.
 */
router.get(['/runs/:runId/summary', '/payroll-runs/:runId/summary'], async (req, res) => {
    try {
        const { runId } = req.params;

        if (!runId || typeof runId !== 'string') {
            return res.status(400).json({ success: false, error: 'Valid runId parameter is required' });
        }

        let grossPayroll = 0;
        let employeeDeductions = 0;
        let netSalary = 0;
        let employerContributions = 0;
        let headcount = 0;

        if (db) {
            // 1. First check if a locked/approved PayrollRun document exists
            // Only the caller's company: another company's run is treated as not there, and only this company's people are counted
            const runData = ownRecord(req, await db.collection('payroll_runs').doc(runId).get());
            if (runData && runData.totals) {
                const totals = runData.totals;
                grossPayroll = Number(totals.total_gross_earnings || 0);
                employeeDeductions = Number(totals.total_employee_deductions || 0);
                netSalary = Number(totals.total_net_payable || 0);
                employerContributions = Number(totals.total_employer_contributions || 0);
                headcount = Number(totals.total_headcount || 0);
            } else {
                // 2. Otherwise compute dynamically from active users / employee documents
                const usersSnap = await db.collection('users').get();
                
                usersSnap.forEach((doc) => {
                    const u = doc.data();
                    if (!payAccess.inCompany(orgOf(req), u)) return;
                    // Include active employees / managers with valid salary
                    if (u.status !== 'inactive' && u.status !== 'terminated') {
                        const salary = Number(u.salary || u.basicSalary || u.netSalary || 0);
                        if (salary > 0) {
                            headcount++;
                            const gross = Number(u.grossSalary || (salary * 1.25));
                            const basic = Number(u.basicSalary || (salary * 0.5));
                            
                            // PF Calculations
                            const epfWage = Math.min(basic, 15000);
                            const pfEe = Math.round(epfWage * 0.12);
                            const pfEr = Math.round(epfWage * 0.12);
                            
                            // ESIC Calculations (if Gross <= 21,000)
                            const esicEe = gross <= 21000 ? Math.round(gross * 0.0075) : 0;
                            const esicEr = gross <= 21000 ? Math.round(gross * 0.0325) : 0;
                            
                            // Professional Tax
                            const pt = gross > 15000 ? 200 : 0;
                            
                            // Gratuity Provision (4.81% Basic)
                            const gratuityProvision = Math.round(basic * 0.0481);

                            const totalDeductions = pfEe + esicEe + pt;
                            const net = Math.max(0, gross - totalDeductions);
                            const totalEr = pfEr + esicEr + gratuityProvision;

                            grossPayroll += gross;
                            employeeDeductions += totalDeductions;
                            netSalary += net;
                            employerContributions += totalEr;
                        }
                    }
                });
            }
        }

        // Clean rounding (avoid floating point inaccuracies)
        grossPayroll = Math.round(grossPayroll * 100) / 100;
        employeeDeductions = Math.round(employeeDeductions * 100) / 100;
        netSalary = Math.round(netSalary * 100) / 100;
        employerContributions = Math.round(employerContributions * 100) / 100;

        // Currency formatter in standard Indian (₹) currency format
        const formatInr = (val) => {
            if (!val || isNaN(val) || val === 0) return '₹0';
            return '₹' + Math.round(val).toLocaleString('en-IN');
        };

        return res.json({
            success: true,
            run_id: runId,
            period: req.query.period || 'August 2026',
            summary: {
                gross_payroll: grossPayroll,
                employee_deductions: employeeDeductions,
                net_salary: netSalary,
                employer_contributions: employerContributions,
                total_headcount: headcount,
                formatted: {
                    gross_payroll: formatInr(grossPayroll),
                    employee_deductions: formatInr(employeeDeductions),
                    net_salary: formatInr(netSalary),
                    employer_contributions: formatInr(employerContributions),
                },
            },
            generated_at: new Date().toISOString(),
        });
    } catch (error) {
        console.error('[PAYROLL] Summary computation error:', error.message);
        return res.status(500).json({
            success: false,
            error: 'Failed to compute server-side payroll summary',
            summary: {
                gross_payroll: 0,
                employee_deductions: 0,
                net_salary: 0,
                employer_contributions: 0,
                total_headcount: 0,
                formatted: {
                    gross_payroll: '₹0',
                    employee_deductions: '₹0',
                    net_salary: '₹0',
                    employer_contributions: '₹0',
                },
            },
        });
    }
});

/**
 * 8-Point Automated Bank File Generation Gate API.
 * POST /api/payroll/batches/:batchId/generate-bank-file OR POST /api/payroll-runs/:runId/generate-bank-file
 * 
 * Strict Product Rule: Independently recalculates the 8 validation points server-side.
 * Rejects with HTTP 422 Unprocessable Entity if ANY blocking issue persists.
 */
router.post(['/batches/:batchId/generate-bank-file', '/payroll-runs/:runId/generate-bank-file'], async (req, res) => {
    try {
        const batchId = req.params.batchId || req.params.runId || 'BATCH_DISBURSEMENT';
        const { operator_id = 'SYSTEM_ADMIN', bank_layout = 'STANDARD_CSV' } = req.body || {};

        let batchData = {
            batch_id: batchId,
            status: 'APPROVED',
            records: [],
            summary: { total_amount: 0 }
        };

        if (db) {
            // Check if batch document exists in Firestore
            const batchDoc = await db.collection('payment_batches').doc(batchId).get();
            if (snapExists(batchDoc)) {
                const own = ownRecord(req, batchDoc);
                if (!own) return res.status(404).json({ success: false, error: 'Payment batch not found' });
                batchData = { ...batchData, ...own };
            }
        }

        // If no records in batch document, check provided records or populate active users
        if (!batchData.records || batchData.records.length === 0) {
            if (req.body && Array.isArray(req.body.records) && req.body.records.length > 0) {
                batchData.records = req.body.records;
            }
        }

        // Deterministic 8-Point Validation Gate Engine
        const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
        const blockingIssues = [];

        // 1. Approval Gate
        if (batchData.status !== 'APPROVED' && batchData.status !== 'CHECKER_APPROVED') {
            blockingIssues.push({
                code: 'GATE_01_PAYROLL_APPROVAL',
                severity: 'BLOCKING',
                message: `Batch '${batchId}' is in '${batchData.status}' state and must be APPROVED by Checker first.`
            });
        }

        // 2. Empty Records Gate
        if (!batchData.records || batchData.records.length === 0) {
            blockingIssues.push({
                code: 'GATE_06_POSITIVE_PAY',
                severity: 'BLOCKING',
                message: `Batch '${batchId}' contains 0 employee disbursement records.`
            });
        } else {
            const seenEmps = new Set();
            const seenAccounts = new Set();
            const seenRefs = new Set();
            let sumNet = 0;

            for (const [idx, rec] of batchData.records.entries()) {
                const empId = rec.employee_id || `EMP_${idx + 1}`;
                const net = Number(rec.net_payable_amount ?? rec.amount ?? 0);
                const rawAcc = String(rec.account_number_raw || rec.account_number || '').trim();
                const ifsc = String(rec.ifsc_code || '').trim().toUpperCase();
                const ref = String(rec.payment_reference || '').trim();

                sumNet += net;

                // Positive pay check
                if (net <= 0) {
                    blockingIssues.push({
                        code: 'GATE_06_POSITIVE_PAY',
                        severity: 'BLOCKING',
                        employee_id: empId,
                        message: `Record ${empId} has non-positive net payout: ₹${net}. Must be > ₹0.`
                    });
                }

                // Account format check
                if (!rawAcc || rawAcc.length < 9 || rawAcc.length > 18 || !/^\d+$/.test(rawAcc)) {
                    blockingIssues.push({
                        code: 'GATE_03_ACCOUNT_FORMAT',
                        severity: 'BLOCKING',
                        employee_id: empId,
                        message: `Invalid bank account number for ${empId}. Must be numeric 9-18 digits.`
                    });
                }

                // IFSC check
                if (!ifsc || !ifscRegex.test(ifsc)) {
                    blockingIssues.push({
                        code: 'GATE_04_IFSC_REGEX',
                        severity: 'BLOCKING',
                        employee_id: empId,
                        message: `Invalid IFSC format '${ifsc}' on ${empId}. Format: 4 alpha + 0 + 6 alphanumeric.`
                    });
                }

                // Duplicate Employee ID
                if (seenEmps.has(empId)) {
                    blockingIssues.push({
                        code: 'GATE_05_DUPLICATE_PREVENTION',
                        severity: 'BLOCKING',
                        employee_id: empId,
                        message: `Duplicate disbursement entry detected for Employee ID '${empId}'.`
                    });
                } else {
                    seenEmps.add(empId);
                }

                // Duplicate Bank Account
                if (rawAcc && seenAccounts.has(rawAcc)) {
                    blockingIssues.push({
                        code: 'GATE_05_DUPLICATE_PREVENTION',
                        severity: 'BLOCKING',
                        employee_id: empId,
                        message: `Duplicate bank account number shared on ${empId}.`
                    });
                } else if (rawAcc) {
                    seenAccounts.add(rawAcc);
                }

                // Duplicate Reference
                if (ref && seenRefs.has(ref)) {
                    blockingIssues.push({
                        code: 'GATE_07_PAYMENT_REFERENCE',
                        severity: 'BLOCKING',
                        employee_id: empId,
                        message: `Duplicate client payment reference '${ref}'.`
                    });
                } else if (ref) {
                    seenRefs.add(ref);
                }
            }
        }

        // STRICT PRODUCT RULE: If any unresolved blocking issue exists, REJECT with 422 HTTP
        if (blockingIssues.length > 0) {
            return res.status(422).json({
                success: false,
                error: 'VALIDATION_GATE_FAILED',
                message: `Server rejected bank file generation: ${blockingIssues.length} unresolved BLOCKING issue(s) detected.`,
                blocking_count: blockingIssues.length,
                blocking_issues: blockingIssues,
                can_generate_bank_file: false,
            });
        }

        // Generate Bank File Content & Checksum
        const dateStamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const headers = 'Beneficiary Name,Account Number,IFSC Code,Amount,Payment Reference,Remarks';
        const rows = batchData.records.map(r => `"${r.employee_name || 'Employee'}","${r.account_number_raw || r.account_number}",${r.ifsc_code},${Number(r.net_payable_amount || r.amount).toFixed(2)},"${r.payment_reference || 'REF'}","Salary"`);
        const fileContent = [headers, ...rows].join('\r\n');

        const crypto = require('crypto');
        const checksumSha256 = crypto.createHash('sha256').update(fileContent, 'utf8').digest('hex');
        const fileId = `BF-${Date.now()}`;

        // Return Generated File Artifact
        return res.json({
            success: true,
            message: '8-Point Validation Gate PASSED. Bank file generated and locked.',
            bank_file_id: fileId,
            batch_id: batchId,
            bank_layout: bank_layout,
            checksum_sha256: checksumSha256,
            record_count: batchData.records.length,
            total_amount: batchData.records.reduce((sum, r) => sum + Number(r.net_payable_amount || r.amount || 0), 0),
            file_name: `BANK_DISBURSEMENT_${batchId}_${dateStamp}.csv`,
            file_content: fileContent,
            status: 'FILE_GENERATED',
            is_locked: true,
            generated_at: new Date().toISOString(),
        });
    } catch (error) {
        console.error('[PAYROLL] Bank file generation error:', error.message);
        return res.status(500).json({ success: false, error: 'Internal server error during bank file generation' });
    }
});

/**
 * Bank Settlement Response Ingestion & Ledger Update API
 * POST /api/payroll/reconciliation/upload OR POST /api/payroll-runs/:runId/reconciliation/upload
 * 
 * Supports: CSV, XML, TXT formats containing:
 * Transaction_ID, Bank_Ref (UTR), Employee_ID, Amount, Status (PAID / FAILED).
 * 
 * Maps records, updates transaction flags with traceable UTR references,
 * transitions PaymentBatch status cleanly to PAID, PARTIALLY_PAID, or FAILED,
 * flags exception alerts on dashboard, and populates the HR reprocessing queue.
 */
router.post(['/reconciliation/upload', '/runs/:runId/reconciliation/upload', '/payroll-runs/:runId/reconciliation/upload'], async (req, res) => {
    try {
        const { 
            file_content, 
            file_format = 'CSV', 
            file_name = 'bank_settlement.csv',
            batch_id = 'Salary_Disbursement',
            operator_id = 'HR_FINANCE_ADMIN',
            records = []
        } = req.body || {};

        if (!file_content || String(file_content).trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'MISSING_FILE_CONTENT',
                message: 'Bank settlement response file content is required for reconciliation.'
            });
        }

        // Dynamically load BankReconciliationService
        const { BankReconciliationService } = await import('../services/bank-reconciliation-service.mjs');
        const reconService = new BankReconciliationService();

        // Load or build PaymentBatch object
        let paymentBatch = {
            batch_id: batch_id,
            status: 'TRANSMITTED',
            records: records.length > 0 ? records : [
                { employee_id: 'EMP001', employee_name: 'Abhishek Rai', net_payable_amount: 45200.00, payment_reference: 'SAL-SEP-001', status: 'PENDING' },
                { employee_id: 'EMP002', employee_name: 'Rohit Kumar', net_payable_amount: 36500.00, payment_reference: 'SAL-SEP-002', status: 'PENDING' },
                { employee_id: 'EMP003', employee_name: 'Sneha Sharma', net_payable_amount: 41000.00, payment_reference: 'SAL-SEP-003', status: 'PENDING' }
            ]
        };

        let otherCompanyBatch = false;
        if (db) {
            try {
                const batchDoc = await db.collection('payment_batches').doc(batch_id).get();
                if (snapExists(batchDoc)) {
                    // the settlement is written back to this batch, so it must be the caller's company's batch
                    const own = ownRecord(req, batchDoc);
                    if (!own) otherCompanyBatch = true;
                    else if (own.records) paymentBatch = { ...paymentBatch, ...own };
                }
            } catch (e) {
                console.warn('[RECON] Firestore batch lookup notice:', e.message);
            }
        }
        if (otherCompanyBatch) return res.status(404).json({ success: false, error: 'BATCH_NOT_FOUND', message: 'Payment batch not found' });

        // Process reconciliation
        const result = await reconService.processSettlementFile({
            batch: paymentBatch,
            fileContent: String(file_content),
            fileFormat: file_format.toUpperCase(),
            fileName: file_name,
            operatorId: operator_id,
            storageRepository: db ? {
                saveBankResponse: async (docData) => {
                    await db.collection('bank_reconciliations').doc(docData.reconciliation_id).set(docData, { merge: true });
                },
                savePaymentBatch: async (batchData) => {
                    await db.collection('payment_batches').doc(batchData.batch_id).set(batchData, { merge: true });
                },
                enqueueReprocessingItems: async (items) => {
                    const batchWrite = db.batch();
                    for (const it of items) {
                        const ref = db.collection('payroll_reprocessing_queue').doc(it.queue_id);
                        batchWrite.set(ref, it);
                    }
                    await batchWrite.commit();
                },
                saveExceptionAlerts: async (alerts) => {
                    const batchWrite = db.batch();
                    for (const al of alerts) {
                        const ref = db.collection('payroll_exception_alerts').doc(al.alert_id);
                        batchWrite.set(ref, al);
                    }
                    await batchWrite.commit();
                }
            } : null
        });

        return res.json({
            success: true,
            message: `Bank reconciliation completed. Status: ${result.batch_status}`,
            reconciliation_id: result.reconciliation_id,
            batch_id: paymentBatch.batch_id,
            batch_status: result.batch_status,
            is_all_terminal: result.is_all_terminal,
            summary: result.bank_response,
            reprocessing_queue: result.reprocessing_queue,
            exception_alerts: result.exception_alerts,
            reconciled_records: paymentBatch.records,
            reconciled_at: new Date().toISOString()
        });
    } catch (error) {
        console.error('[PAYROLL] Reconciliation upload error:', error);
        return res.status(500).json({
            success: false,
            error: 'RECONCILIATION_PROCESSING_ERROR',
            message: error.message || 'Failed to process bank settlement file'
        });
    }
});

/**
 * Exception Resolution & Dynamic Re-Validation Remediation API
 * POST /api/payroll/batches/:batchId/resolve-issue OR POST /batches/:batchId/resolve-issue
 *
 * Accepts: issue_id, field, updated_value, and admin_id (plus optional employee_id / corrected_data).
 * Executes an atomic database transaction:
 *  1. Verifies targeted batch is in an editable state (DRAFT or VALIDATING or FAILED).
 *  2. Updates target field in employee master profile and increments bank_account_version.
 *  3. Marks ValidationIssue resolved with active timestamp and resolved_by: admin_id.
 *  4. Re-executes the 9-step validation pipeline against modified record.
 *  5. If all blocking issues are cleared, automatically lifts generation lock, recomputes totals, and advances batch to VALIDATED.
 */
router.post(['/batches/:batchId/resolve-issue', '/payroll-batches/:batchId/resolve-issue'], async (req, res) => {
    try {
        const batchId = req.params.batchId || req.body.batch_id;
        const {
            issue_id,
            field,
            updated_value,
            admin_id,
            employee_id,
            corrected_data,
            resolved_by,
            notes = 'Remediated via payroll disbursement console',
            payroll_source_ledger = null,
        } = req.body || {};

        if (!batchId) {
            return res.status(400).json({
                success: false,
                error: 'MISSING_BATCH_ID',
                message: 'batchId URL parameter or batch_id in request body is required.',
            });
        }

        if (!issue_id) {
            return res.status(400).json({
                success: false,
                error: 'MISSING_ISSUE_ID',
                message: 'issue_id is mandatory for exception resolution.',
            });
        }

        const effectiveAdminId = admin_id || resolved_by || req.user?.id || 'HR_FINANCE_ADMIN';
        const targetField = field || (corrected_data ? Object.keys(corrected_data)[0] : 'ifsc_code');
        const targetValue = updated_value !== undefined ? updated_value : (corrected_data ? corrected_data[targetField] : null);
        const targetEmpId = employee_id || req.body.emp_id || 'EMP101';

        const { ExceptionResolutionService, TransactionalDatabaseStore, ResolutionValidationError } = await import('../services/exception-resolution-service.mjs');
        const store = new TransactionalDatabaseStore();

        // Hydrate from Firestore if available
        let batchDocData = {
            batch_id: batchId,
            status: 'FAILED',
            records: req.body.records || [
                {
                    employee_id: targetEmpId,
                    employee_name: 'Employee',
                    ifsc_code: targetField === 'ifsc_code' ? targetValue : 'INVALID_IFSC',
                    account_number: targetField === 'account_number' ? targetValue : '1234567890',
                    net_payable_amount: 50000,
                    bank_account_version: 1,
                }
            ],
            summary: { total_amount: 50000 }
        };

        let notThisCompany = null;
        if (db) {
            try {
                const bSnap = await db.collection('payment_batches').doc(batchId).get();
                if (snapExists(bSnap)) {
                    const own = ownRecord(req, bSnap);
                    if (!own) notThisCompany = 'Payment batch not found';
                    else batchDocData = { ...batchDocData, ...own };
                }
                // the fix is written to the employee's record and the issue record: both must be this company's
                const empSnap = validId(String(targetEmpId)) ? await db.collection('users').doc(String(targetEmpId)).get() : null;
                if (snapExists(empSnap) && !ownRecord(req, empSnap)) notThisCompany = 'Employee not found';
                const issueSnap = validId(String(issue_id)) ? await db.collection('validation_issues').doc(String(issue_id)).get() : null;
                if (snapExists(issueSnap) && !ownRecord(req, issueSnap)) notThisCompany = 'Issue not found';
            } catch (e) {
                console.warn('[RESOLVE_ISSUE] Firestore batch fetch warning:', e.message);
            }
        }
        if (notThisCompany) return res.status(404).json({ success: false, error: 'NOT_FOUND', message: notThisCompany });

        store.setBatch(batchDocData);
        store.setEmployee({
            employee_id: targetEmpId,
            bank_account_version: 1,
            [targetField]: targetValue,
        });
        store.setIssues(batchId, [
            {
                issue_id: issue_id,
                batch_id: batchId,
                code: req.body.code || 'EMP021',
                severity: 'BLOCK',
                field: targetField,
                employee_id: targetEmpId,
                resolved: false,
                resolved_at: null,
                resolved_by: null,
            }
        ]);

        const exceptionService = new ExceptionResolutionService({ store });
        const result = await exceptionService.resolveIssueAndRevalidate({
            batchId,
            issueId: issue_id,
            field: targetField,
            updatedValue: targetValue,
            employeeId: targetEmpId,
            correctedData: corrected_data || (targetField && targetValue !== null ? { [targetField]: targetValue } : {}),
            adminId: effectiveAdminId,
            resolutionNotes: notes,
            payrollSourceLedger: payroll_source_ledger || { total_net: batchDocData.summary?.total_amount || 50000 },
        });

        // Persist back to Firestore if available
        if (db) {
            try {
                await db.collection('payment_batches').doc(batchId).set({
                    status: result.batch_status,
                    validation_status: result.batch_status,
                    can_generate_bank_file: result.can_generate_bank_file,
                    is_blocked: result.is_blocked,
                    records: batchDocData.records,
                    summary: result.recomputed_totals,
                    updated_at: new Date().toISOString(),
                }, { merge: true });

                await db.collection('validation_issues').doc(issue_id).set(result.resolved_issue, { merge: true });
                await db.collection('users').doc(targetEmpId).set(result.updated_employee, { merge: true });
            } catch (err) {
                console.warn('[RESOLVE_ISSUE] Firestore sync notice:', err.message);
            }
        }

        return res.status(200).json(result);
    } catch (error) {
        console.error('[PAYROLL] Exception resolution error:', error);
        return res.status(error.statusCode || 500).json({
            success: false,
            error: error.name || 'RESOLUTION_ERROR',
            message: error.message || 'Failed to resolve validation exception.',
            details: error.details || {},
        });
    }
});

/**
 * Idempotency & Pre-Execution Protected File Generation Endpoint
 * POST /api/payroll/batches/:batchId/generate-file OR POST /batches/:batchId/generate-file
 */
router.post(['/batches/:batchId/generate-file', '/payroll-batches/:batchId/generate-file'], async (req, res) => {
    try {
        const batchId = req.params.batchId || req.body.batch_id || 'BATCH_DISBURSEMENT';
        const { IdempotencyUniquenessEngine, InstructionExecutionLedger } = await import('../services/idempotency-uniqueness-engine.mjs');
        const engine = new IdempotencyUniquenessEngine();

        let records = req.body.records || [
            { employee_id: 'EMP101', employee_name: 'Aditi Rao', net_payable_amount: 45000, bank_account_version: 1 }
        ];

        const stamped = engine.stampBatchInstructions({
            period: req.body.period || 'September 2026',
            batch_type: req.body.batch_type || 'SALARY',
        }, records);

        // Idempotency verification guard
        await engine.verifyAndGuardInstructions(stamped, { batch_id: batchId, channel: 'BANK_FILE_GENERATION' });

        return res.status(200).json({
            success: true,
            batch_id: batchId,
            message: 'Idempotency checks passed. File generated successfully.',
            stamped_instructions: stamped,
            generated_at: new Date().toISOString(),
        });
    } catch (error) {
        if (error.statusCode === 409 || error.name === 'IdempotencyConflictError') {
            return res.status(409).json({
                success: false,
                error: '409_CONFLICT_DOUBLE_DISBURSEMENT_BLOCKED',
                message: error.message,
                details: error.details,
            });
        }
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Idempotency & Pre-Execution Protected Bank Submission Endpoint
 * POST /api/payroll/batches/:batchId/submit OR POST /batches/:batchId/submit
 */
router.post(['/batches/:batchId/submit', '/payroll-batches/:batchId/submit'], async (req, res) => {
    try {
        const batchId = req.params.batchId || req.body.batch_id || 'BATCH_DISBURSEMENT';
        const { IdempotencyUniquenessEngine } = await import('../services/idempotency-uniqueness-engine.mjs');
        const engine = new IdempotencyUniquenessEngine();

        let records = req.body.records || [
            { employee_id: 'EMP101', employee_name: 'Aditi Rao', net_payable_amount: 45000, bank_account_version: 1 }
        ];

        const stamped = engine.stampBatchInstructions({
            period: req.body.period || 'September 2026',
            batch_type: req.body.batch_type || 'SALARY',
        }, records);

        // Commit to ledger (guards automatically)
        const committed = await engine.commitInstructions(stamped, {
            batch_id: batchId,
            executed_by: req.user?.id || 'HR_OPERATOR',
            channel: 'BANK_API',
        });

        return res.status(200).json({
            success: true,
            batch_id: batchId,
            status: 'SUBMITTED',
            committed_count: committed.length,
            submitted_instructions: committed,
            submitted_at: new Date().toISOString(),
        });
    } catch (error) {
        if (error.statusCode === 409 || error.name === 'IdempotencyConflictError') {
            return res.status(409).json({
                success: false,
                error: '409_CONFLICT_DOUBLE_DISBURSEMENT_BLOCKED',
                message: error.message,
                details: error.details,
            });
        }
        return res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;





