/**
 * ============================================================================
 * KYLRX.AI ENTERPRISE HRMS - CONSOLIDATED UNIFIED INGESTION SERVICE
 * ============================================================================
 * 
 * Principal Enterprise Service managing atomic Firestore batch dispatching across
 * Job & Roster Details, Employee Financial Compliance, and Organization Statutory
 * Registrations matching PRD Sections 1, 3, 4, 11, & 13.
 * 
 * Capabilities:
 * 1. Pipeline 1: Employee Job & Roster Updates
 *    - Atomic multi-collection sync: salary_structures, employees, users, attendance_rosters.
 *    - Deep historical versioning under organizations/{orgId}/employee_job_history/{employeeId}/records.
 * 
 * 2. Pipeline 2: Employee Financial & Statutory IDs
 *    - Multi-subcollection routing: employee_bank_details, employee_pf_details, employee_esic_details, employee_nps_details.
 *    - Decentro Penny Drop automated verification trigger for pending bank accounts.
 * 
 * 3. Pipeline 3: Organization Compliance Registrations
 *    - Master compliance profile storage in organizations/{orgId}/compliance_master/statutory_profile.
 *    - Automatic propagation of corporate statutory codes as defaults into individual employee drawers.
 * 
 * @version 2.0.0
 * @author Principal Full-Stack & Enterprise Systems Architect
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.KylrxUnifiedIngestionService = factory();
        root.unifiedIngestionService = root.KylrxUnifiedIngestionService;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * Helper to obtain active Firestore instance from browser window or Node context
     */
    function getFirestoreDb() {
        if (typeof window !== 'undefined') {
            if (window.db) return window.db;
            if (window.firebase && window.firebase.firestore) return window.firebase.firestore();
        }
        return null;
    }

    /**
     * Generates a unique timestamped ID
     */
    function generateId(prefix = 'REC') {
        const timestamp = Date.now().toString(36);
        const random = Math.random().toString(36).substring(2, 8);
        return `${prefix}_${timestamp}_${random}`.toUpperCase();
    }

    // Placeholder company IDs that ship in the sample templates; they mean "the signed-in company"
    const PLACEHOLDER_ORG_IDS = ['ORG_KYLRX_CORP', 'ORG_KYLRX_01', 'ORG_KYLRX', 'ORG_SAMPLE', 'YOUR_ORG_ID'];

    /**
     * Company a row is written to. The signed-in company (options.orgId) always wins; a blank or
     * template-placeholder Organization_ID means "this company"; a row naming a different real company
     * is rejected. Without a signed-in company (dry run / tests) the row's own ID is used.
     */
    function resolveTenant(rowOrgId, sessionOrgId) {
        const rowOrg = String(rowOrgId == null ? '' : rowOrgId).trim();
        if (!sessionOrgId) return { orgId: rowOrg || '' };
        if (!rowOrg || PLACEHOLDER_ORG_IDS.indexOf(rowOrg.toUpperCase()) !== -1 || rowOrg === sessionOrgId) {
            return { orgId: sessionOrgId };
        }
        return { error: `Organization_ID '${rowOrg}' belongs to a different company than the one you are signed in to.` };
    }

    /**
     * Where a person's login/profile document lives: the existing user of this company with that
     * employee ID, otherwise a new roster-only profile (no login yet) that an invite can later claim.
     */
    async function resolveUserPath(firestore, orgId, empId) {
        try {
            if (firestore && typeof firestore.collection === 'function') {
                const snap = await firestore.collection('users').where('orgId', '==', orgId).where('employeeId', '==', empId).limit(1).get();
                const docs = snap && snap.docs ? snap.docs : [];
                if (docs.length) return { path: `users/${docs[0].id}`, existing: true };
            }
        } catch (_) { /* fall through to a roster-only profile */ }
        const safe = `${orgId}_${empId}`.replace(/[^A-Za-z0-9_-]/g, '_');
        return { path: `users/roster_${safe}`, existing: false };
    }

    /**
     * Standard monthly salary breakdown from annual CTC
     */
    function computeStandardSalaryComponents(annualCtc, currency) {
        const monthlyGross = Math.round((annualCtc || 0) / 12);
        const basic = Math.round(monthlyGross * 0.50);
        const hra = Math.round(basic * 0.40);
        const specialAllowance = Math.max(0, monthlyGross - (basic + hra));

        return {
            annualCtc: Number(annualCtc) || 0,
            monthlyGross,
            basic,
            hra,
            specialAllowance,
            currency: currency || 'INR',
            frequency: 'Monthly'
        };
    }

    /**
     * =========================================================================
     * PIPELINE 1: EMPLOYEE JOB & ROSTER UPDATES INGESTION
     * =========================================================================
     */
    async function ingestJobRosterBatch(records, options = {}) {
        const orgId = options.orgId || '';
        const actorId = options.actorId || options.adminId || 'SUPER_ADMIN';
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
        const isDryRun = Boolean(options.dryRun);

        const total = records.length;
        const errors = [];
        const successRecords = [];
        const historySnapshots = [];
        const currency = options.currency || 'INR';

        if (!isDryRun && !orgId) {
            return { success: false, template: 'JOB_ROSTER_UPDATES', totalCount: total, successCount: 0, failureCount: total, records: [], historySnapshots: [],
                errors: [{ error: 'No signed-in company. Sign in again before importing.' }] };
        }

        for (let i = 0; i < records.length; i++) {
            const row = records[i];
            const empId = row.Employee_ID;
            const tenant = resolveTenant(row.Organization_ID, orgId);
            const rowTenant = tenant.orgId;

            if (!empId) {
                errors.push({
                    rowIndex: row.rowIndex || i + 1,
                    employeeId: empId,
                    error: 'Missing mandatory Employee_ID.'
                });
                continue;
            }
            if (tenant.error) {
                errors.push({ rowIndex: row.rowIndex || i + 1, employeeId: empId, error: tenant.error });
                continue;
            }

            try {
                const salaryBreakdown = computeStandardSalaryComponents(row.Annual_CTC, currency);
                const recordId = generateId('JOB_HIST');
                const nowIso = new Date().toISOString();

                // 1. Payload for salary structures
                const salaryPayload = {
                    employeeId: empId,
                    orgId: rowTenant,
                    effectiveFrom: row.Effective_Date || nowIso.split('T')[0],
                    annualCtc: Number(row.Annual_CTC) || 0,
                    monthlyGross: salaryBreakdown.monthlyGross,
                    basic: salaryBreakdown.basic,
                    hra: salaryBreakdown.hra,
                    specialAllowance: salaryBreakdown.specialAllowance,
                    payFrequency: 'Monthly',
                    salaryStructureCode: 'STRUC_STANDARD_50_40',
                    reasonForUpdate: row.Reason_For_Update || 'Routine Update',
                    active: row.Active !== false,
                    updatedBy: actorId,
                    updatedAt: nowIso
                };

                // 2. Payload for employee master profile
                const employeePayload = {
                    employeeId: empId,
                    orgId: rowTenant,
                    departmentCode: row.Department_Code,
                    department: row.Department_Code,
                    designationTitle: row.Designation_Title,
                    designation: row.Designation_Title,
                    annualCtc: Number(row.Annual_CTC) || 0,
                    active: row.Active !== false,
                    status: row.Active !== false ? 'Active' : 'Inactive',
                    lastJobUpdateDate: row.Effective_Date || nowIso.split('T')[0],
                    updatedBy: actorId,
                    updatedAt: nowIso
                };

                // 3. Payload for attendance roster
                const rosterPayload = {
                    employeeId: empId,
                    orgId: rowTenant,
                    shiftRosterCode: row.Shift_Roster_Code || 'SHIFT_GEN_9_6',
                    shiftCode: row.Shift_Roster_Code || 'SHIFT_GEN_9_6',
                    weekOffPattern: row.Week_Off_Pattern || 'SAT_SUN_FIXED',
                    customWeekOffDays: row.Custom_Week_Off_Days || '',
                    effectiveDate: row.Effective_Date || nowIso.split('T')[0],
                    active: row.Active !== false,
                    updatedBy: actorId,
                    updatedAt: nowIso
                };

                // 4. Historical Versioning Record
                const historyRecord = {
                    recordId,
                    employeeId: empId,
                    orgId: rowTenant,
                    effectiveDate: row.Effective_Date || nowIso.split('T')[0],
                    reasonForUpdate: row.Reason_For_Update || 'Annual Increment / Roster Realignment',
                    departmentCode: row.Department_Code,
                    designationTitle: row.Designation_Title,
                    annualCtc: Number(row.Annual_CTC) || 0,
                    salaryBreakdown,
                    shiftRosterCode: row.Shift_Roster_Code || 'SHIFT_GEN_9_6',
                    weekOffPattern: row.Week_Off_Pattern || 'SAT_SUN_FIXED',
                    customWeekOffDays: row.Custom_Week_Off_Days || '',
                    active: row.Active !== false,
                    recordedBy: actorId,
                    recordedAt: nowIso
                };

                historySnapshots.push(historyRecord);

                // Commit to Firestore if not in dry-run mode
                if (!isDryRun) {
                    const firestore = options.db || getFirestoreDb();
                    const modules = (typeof window !== 'undefined') ? (window.firestoreModules || window.firebaseFirestore) : null;
                    const canBatch = firestore && (typeof firestore.batch === 'function' || (modules && modules.writeBatch));
                    if (!canBatch) throw new Error('No database connection available to save this row.');
                    {
                        // The person: the company's existing user with this employee ID, or a new roster-only profile
                        const userTarget = await resolveUserPath(firestore, rowTenant, empId);
                        const userPayload = {
                            orgId: rowTenant,
                            employeeId: empId,
                            department: row.Department_Code,
                            departmentCode: row.Department_Code,
                            designation: row.Designation_Title,
                            status: row.Active !== false ? 'Active' : 'Inactive',
                            updatedAt: nowIso
                        };
                        if (row.Employee_Name) userPayload.name = row.Employee_Name;
                        if (row.Official_Email) userPayload.email = String(row.Official_Email).toLowerCase();
                        if (!userTarget.existing) {
                            if (!userPayload.name) userPayload.name = empId;
                            Object.assign(userPayload, { role: 'employee', hasLogin: false, invite_status: 'not_invited', createdAt: nowIso, source: 'job_roster_import' });
                        }
                        if (typeof firestore.batch === 'function') {
                            // Firestore v8 / Admin SDK
                            const batch = firestore.batch();
                            const salaryRef = firestore.doc(`organizations/${rowTenant}/salary_structures/${empId}`);
                            const employeeRef = firestore.doc(`organizations/${rowTenant}/employees/${empId}`);
                            const userRef = firestore.doc(userTarget.path);
                            const rosterRef = firestore.doc(`organizations/${rowTenant}/attendance_rosters/${empId}`);
                            const historyRef = firestore.doc(`organizations/${rowTenant}/employee_job_history/${empId}/records/${recordId}`);

                            batch.set(salaryRef, salaryPayload, { merge: true });
                            batch.set(employeeRef, employeePayload, { merge: true });
                            batch.set(userRef, userPayload, { merge: true });
                            batch.set(rosterRef, rosterPayload, { merge: true });
                            batch.set(historyRef, historyRecord);

                            await batch.commit();
                        } else {
                            // Modular Firebase SDK
                            const { doc, writeBatch } = modules;
                            const batch = writeBatch(firestore);
                            const salaryRef = doc(firestore, `organizations/${rowTenant}/salary_structures/${empId}`);
                            const employeeRef = doc(firestore, `organizations/${rowTenant}/employees/${empId}`);
                            const userRef = doc(firestore, userTarget.path);
                            const rosterRef = doc(firestore, `organizations/${rowTenant}/attendance_rosters/${empId}`);
                            const historyRef = doc(firestore, `organizations/${rowTenant}/employee_job_history/${empId}/records/${recordId}`);

                            batch.set(salaryRef, salaryPayload, { merge: true });
                            batch.set(employeeRef, employeePayload, { merge: true });
                            batch.set(userRef, userPayload, { merge: true });
                            batch.set(rosterRef, rosterPayload, { merge: true });
                            batch.set(historyRef, historyRecord);

                            await batch.commit();
                        }
                    }
                }

                successRecords.push({
                    employeeId: empId,
                    salaryPayload,
                    employeePayload,
                    rosterPayload,
                    historyRecord
                });

                onProgress(i + 1, total, row);
            } catch (err) {
                errors.push({
                    rowIndex: row.rowIndex || i + 1,
                    employeeId: empId,
                    error: err.message || 'Failed to dispatch job & roster write batch.'
                });
            }
        }

        return {
            success: errors.length === 0,
            template: 'JOB_ROSTER_UPDATES',
            totalCount: total,
            successCount: successRecords.length,
            failureCount: errors.length,
            records: successRecords,
            historySnapshots,
            errors
        };
    }

    /**
     * =========================================================================
     * PIPELINE 2: EMPLOYEE FINANCIAL & STATUTORY IDS INGESTION
     * =========================================================================
     */
    async function ingestEmployeeFinanceBatch(records, options = {}) {
        const orgId = options.orgId || '';
        const actorId = options.actorId || options.adminId || 'SUPER_ADMIN';
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
        const isDryRun = Boolean(options.dryRun);

        const total = records.length;
        const errors = [];
        const successRecords = [];
        const pennyDropTriggers = [];

        for (let i = 0; i < records.length; i++) {
            const row = records[i];
            const empId = row.Employee_ID;
            const tenant = resolveTenant(row.Organization_ID, orgId);
            const rowTenant = tenant.orgId;

            if (!empId) {
                errors.push({
                    rowIndex: row.rowIndex || i + 1,
                    employeeId: empId,
                    error: 'Missing mandatory Employee_ID.'
                });
                continue;
            }
            if (tenant.error) {
                errors.push({ rowIndex: row.rowIndex || i + 1, employeeId: empId, error: tenant.error });
                continue;
            }

            try {
                const nowIso = new Date().toISOString();

                // 1. Bank Profile Payload
                const bankPayload = {
                    employeeId: empId,
                    orgId: rowTenant,
                    bankAccountNumber: row.Bank_Account_Number,
                    accountNumber: row.Bank_Account_Number,
                    bankIfscCode: row.Bank_IFSC_Code,
                    ifsc: row.Bank_IFSC_Code,
                    bankName: row.Bank_Name,
                    accountHolderName: row.Account_Holder_Name,
                    primaryDisbursementMethod: row.Primary_Disbursement_Method || 'BANK_TRANSFER',
                    verificationStatus: row.Verification_Status || 'PENDING_VERIFICATION',
                    status: row.Verification_Status === 'VERIFIED' ? 'Approved' : 'Under Review',
                    isPrimary: true,
                    updatedBy: actorId,
                    updatedAt: nowIso
                };

                // 2. EPFO Profile Payload
                const pfPayload = {
                    employeeId: empId,
                    orgId: rowTenant,
                    uan: row.UAN || '',
                    pfEnrolled: Boolean(row.UAN && String(row.UAN).trim().length === 12),
                    status: row.UAN ? 'ACTIVE' : 'NOT_ENROLLED',
                    updatedBy: actorId,
                    updatedAt: nowIso
                };

                // 3. ESIC Profile Payload
                const esicPayload = {
                    employeeId: empId,
                    orgId: rowTenant,
                    esicIpNumber: row.ESIC_IP_Number || '',
                    insurancePersonNumber: row.ESIC_IP_Number || '',
                    esicEnrolled: Boolean(row.ESIC_IP_Number && String(row.ESIC_IP_Number).trim().length >= 10),
                    status: row.ESIC_IP_Number ? 'ACTIVE' : 'NOT_ENROLLED',
                    updatedBy: actorId,
                    updatedAt: nowIso
                };

                // 4. NPS Profile Payload
                const npsPayload = {
                    employeeId: empId,
                    orgId: rowTenant,
                    pran: row.PRAN || '',
                    npsEnrolled: Boolean(row.PRAN && String(row.PRAN).trim().length === 12),
                    status: row.PRAN ? 'ACTIVE' : 'NOT_ENROLLED',
                    updatedBy: actorId,
                    updatedAt: nowIso
                };

                // 5. PAN and Core Employee update
                const employeeUpdatePayload = {
                    employeeId: empId,
                    orgId: rowTenant,
                    panNumber: row.PAN_Number,
                    pan: row.PAN_Number,
                    updatedBy: actorId,
                    updatedAt: nowIso
                };

                // 6. Automated Decentro Penny Drop Trigger
                let pennyDropTriggered = false;
                let pennyDropDetails = null;

                if (row.Verification_Status === 'PENDING_VERIFICATION' || row.Requires_Penny_Drop) {
                    pennyDropTriggered = true;
                    pennyDropDetails = {
                        transactionRefId: `DEC_PD_${Date.now()}_${empId}`,
                        employeeId: empId,
                        orgId: rowTenant,
                        bankAccountNumber: row.Bank_Account_Number,
                        ifsc: row.Bank_IFSC_Code,
                        accountHolderName: row.Account_Holder_Name,
                        pennyDropStatus: 'PENNY_DROP_INITIATED',
                        provider: 'DECENTRO',
                        initiatedAt: nowIso
                    };
                    pennyDropTriggers.push(pennyDropDetails);
                    bankPayload.pennyDropRef = pennyDropDetails.transactionRefId;
                    bankPayload.pennyDropStatus = 'PENNY_DROP_INITIATED';
                }

                // Commit to Firestore if not dry run
                if (!isDryRun) {
                    const firestore = options.db || getFirestoreDb();
                    const modules = (typeof window !== 'undefined') ? (window.firestoreModules || window.firebaseFirestore) : null;
                    const canBatch = firestore && (typeof firestore.batch === 'function' || (modules && modules.writeBatch));
                    if (!canBatch) throw new Error('No database connection available to save this row.');
                    {
                        const financeUser = await resolveUserPath(firestore, rowTenant, empId);
                        const financeUserPayload = { orgId: rowTenant, employeeId: empId, pan: row.PAN_Number, updatedAt: nowIso };
                        if (typeof firestore.batch === 'function') {
                            const batch = firestore.batch();
                            const bankRef = firestore.doc(`organizations/${rowTenant}/employee_bank_details/${empId}`);
                            const bankVerificationRef = firestore.doc(`bank_verifications/${empId}`);
                            const pfRef = firestore.doc(`organizations/${rowTenant}/employee_pf_details/${empId}`);
                            const esicRef = firestore.doc(`organizations/${rowTenant}/employee_esic_details/${empId}`);
                            const npsRef = firestore.doc(`organizations/${rowTenant}/employee_nps_details/${empId}`);
                            const empRef = firestore.doc(`organizations/${rowTenant}/employees/${empId}`);
                            const userRef = firestore.doc(financeUser.path);

                            batch.set(bankRef, bankPayload, { merge: true });
                            batch.set(bankVerificationRef, bankPayload, { merge: true });
                            batch.set(pfRef, pfPayload, { merge: true });
                            batch.set(esicRef, esicPayload, { merge: true });
                            batch.set(npsRef, npsPayload, { merge: true });
                            batch.set(empRef, employeeUpdatePayload, { merge: true });
                            batch.set(userRef, financeUserPayload, { merge: true });

                            if (pennyDropTriggered && pennyDropDetails) {
                                const pdRef = firestore.doc(`organizations/${rowTenant}/penny_drop_transactions/${pennyDropDetails.transactionRefId}`);
                                batch.set(pdRef, pennyDropDetails);
                            }

                            await batch.commit();
                        } else {
                            const { doc, writeBatch } = modules;
                            const batch = writeBatch(firestore);
                            const bankRef = doc(firestore, `organizations/${rowTenant}/employee_bank_details/${empId}`);
                            const bankVerificationRef = doc(firestore, `bank_verifications/${empId}`);
                            const pfRef = doc(firestore, `organizations/${rowTenant}/employee_pf_details/${empId}`);
                            const esicRef = doc(firestore, `organizations/${rowTenant}/employee_esic_details/${empId}`);
                            const npsRef = doc(firestore, `organizations/${rowTenant}/employee_nps_details/${empId}`);
                            const empRef = doc(firestore, `organizations/${rowTenant}/employees/${empId}`);
                            const userRef = doc(firestore, financeUser.path);

                            batch.set(bankRef, bankPayload, { merge: true });
                            batch.set(bankVerificationRef, bankPayload, { merge: true });
                            batch.set(pfRef, pfPayload, { merge: true });
                            batch.set(esicRef, esicPayload, { merge: true });
                            batch.set(npsRef, npsPayload, { merge: true });
                            batch.set(empRef, employeeUpdatePayload, { merge: true });
                            batch.set(userRef, financeUserPayload, { merge: true });

                            if (pennyDropTriggered && pennyDropDetails) {
                                const pdRef = doc(firestore, `organizations/${rowTenant}/penny_drop_transactions/${pennyDropDetails.transactionRefId}`);
                                batch.set(pdRef, pennyDropDetails);
                            }

                            await batch.commit();
                        }
                    }
                }

                successRecords.push({
                    employeeId: empId,
                    bankPayload,
                    pfPayload,
                    esicPayload,
                    npsPayload,
                    pennyDropTriggered,
                    pennyDropDetails
                });

                onProgress(i + 1, total, row);
            } catch (err) {
                errors.push({
                    rowIndex: row.rowIndex || i + 1,
                    employeeId: empId,
                    error: err.message || 'Failed to dispatch financial compliance write batch.'
                });
            }
        }

        return {
            success: errors.length === 0,
            template: 'EMPLOYEE_FINANCE_COMPLIANCE',
            totalCount: total,
            successCount: successRecords.length,
            failureCount: errors.length,
            pennyDropTriggerCount: pennyDropTriggers.length,
            records: successRecords,
            pennyDropTriggers,
            errors
        };
    }

    /**
     * =========================================================================
     * PIPELINE 3: ORGANIZATION COMPLIANCE REGISTRATIONS INGESTION
     * =========================================================================
     */
    async function ingestOrgComplianceBatch(records, options = {}) {
        const actorId = options.actorId || options.adminId || 'SUPER_ADMIN';
        const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
        const isDryRun = Boolean(options.dryRun);

        const total = records.length;
        const errors = [];
        const successRecords = [];

        for (let i = 0; i < records.length; i++) {
            const row = records[i];
            const tenantId = resolveTenant(row.Organization_ID, options.orgId).orgId || 'ORG_KYLRX_CORP';

            try {
                const nowIso = new Date().toISOString();

                // 1. Primary Statutory Profile Master Payload
                const statutoryMasterPayload = {
                    orgId: tenantId,
                    legalEntityName: row.Legal_Entity_Name,
                    epfoEstablishmentCode: row.EPFO_Establishment_Code,
                    esicEmployerCode: row.ESIC_Employer_Code,
                    statePtRegistrations: row.State_PT_Registrations || '',
                    statePtMap: row.State_PT_Map || {},
                    stateLwfRegistrations: row.State_LWF_Registrations || '',
                    stateLwfMap: row.State_LWF_Map || {},
                    npsChoId: row.NPS_Corporate_Head_Office_ID || '',
                    npsPopSpRegNo: row.NPS_POP_SP_Registration_No || '',
                    authorizedSignatoryPan: row.Authorized_Signatory_PAN,
                    effectiveFrom: row.Effective_From || '2026-01-01',
                    active: row.Active !== false,
                    configured: true,
                    updatedBy: actorId,
                    updatedAt: nowIso
                };

                // 2. Default propagation map for employee drawers
                const statutoryDefaultsPayload = {
                    orgId: tenantId,
                    defaultPfEstablishmentCode: row.EPFO_Establishment_Code,
                    defaultEsicEmployerCode: row.ESIC_Employer_Code,
                    defaultStatePtMap: row.State_PT_Map || {},
                    defaultStateLwfMap: row.State_LWF_Map || {},
                    defaultNpsChoId: row.NPS_Corporate_Head_Office_ID || '',
                    defaultNpsPopSpRegNo: row.NPS_POP_SP_Registration_No || '',
                    autoPropagated: true,
                    propagatedAt: nowIso
                };

                if (!isDryRun) {
                    const firestore = options.db || getFirestoreDb();
                    if (firestore) {
                        if (typeof firestore.batch === 'function') {
                            const batch = firestore.batch();
                            const masterRef = firestore.doc(`organizations/${tenantId}/compliance_master/statutory_profile`);
                            const defaultsRef = firestore.doc(`organizations/${tenantId}/compliance_defaults/statutory_config`);
                            const orgRef = firestore.doc(`organizations/${tenantId}`);

                            batch.set(masterRef, statutoryMasterPayload, { merge: true });
                            batch.set(defaultsRef, statutoryDefaultsPayload, { merge: true });
                            batch.set(orgRef, {
                                legalName: row.Legal_Entity_Name,
                                statutoryConfigured: true,
                                epfoEstablishmentCode: row.EPFO_Establishment_Code,
                                esicEmployerCode: row.ESIC_Employer_Code,
                                updatedAt: nowIso
                            }, { merge: true });

                            await batch.commit();
                        } else if (typeof window !== 'undefined' && window.firestoreModules) {
                            const { doc, writeBatch } = window.firestoreModules;
                            const batch = writeBatch(firestore);
                            const masterRef = doc(firestore, `organizations/${tenantId}/compliance_master/statutory_profile`);
                            const defaultsRef = doc(firestore, `organizations/${tenantId}/compliance_defaults/statutory_config`);
                            const orgRef = doc(firestore, `organizations/${tenantId}`);

                            batch.set(masterRef, statutoryMasterPayload, { merge: true });
                            batch.set(defaultsRef, statutoryDefaultsPayload, { merge: true });
                            batch.set(orgRef, {
                                legalName: row.Legal_Entity_Name,
                                statutoryConfigured: true,
                                epfoEstablishmentCode: row.EPFO_Establishment_Code,
                                esicEmployerCode: row.ESIC_Employer_Code,
                                updatedAt: nowIso
                            }, { merge: true });

                            await batch.commit();
                        }
                    }
                }

                successRecords.push({
                    orgId: tenantId,
                    statutoryMasterPayload,
                    statutoryDefaultsPayload
                });

                onProgress(i + 1, total, row);
            } catch (err) {
                errors.push({
                    rowIndex: row.rowIndex || i + 1,
                    orgId: tenantId,
                    error: err.message || 'Failed to dispatch organization compliance write batch.'
                });
            }
        }

        return {
            success: errors.length === 0,
            template: 'ORG_COMPLIANCE_REGISTRATIONS',
            totalCount: total,
            successCount: successRecords.length,
            failureCount: errors.length,
            records: successRecords,
            errors
        };
    }

    /**
     * Unified Dispatcher routing by template type
     */
    async function dispatchUnifiedIngestion(templateType, records, options = {}) {
        switch (templateType) {
            case 'JOB_ROSTER':
            case 'JOB_ROSTER_UPDATES':
                return await ingestJobRosterBatch(records, options);
            case 'EMPLOYEE_FINANCE':
            case 'EMPLOYEE_FINANCE_COMPLIANCE':
                return await ingestEmployeeFinanceBatch(records, options);
            case 'ORG_COMPLIANCE':
            case 'ORG_COMPLIANCE_REGISTRATIONS':
                return await ingestOrgComplianceBatch(records, options);
            default:
                throw new Error(`Unknown unified ingestion template type: "${templateType}".`);
        }
    }

    return {
        resolveTenant,
        ingestJobRosterBatch,
        ingestEmployeeFinanceBatch,
        ingestOrgComplianceBatch,
        dispatchUnifiedIngestion,
        computeStandardSalaryComponents,
        generateId
    };
}));
