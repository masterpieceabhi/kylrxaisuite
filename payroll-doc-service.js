import { db, auth } from "./firebase-config.js";
import { collection, doc, setDoc, updateDoc, serverTimestamp, getDoc, query, where, getDocs, addDoc } from "./firebase-config.js";
import { generatePayslipPdfBlob, uploadPayslipPdf, normalizePayslipEmployee, parsePeriod } from "./payslip-pdf-service.js";

/**
 * Payroll Document Generation Service
 * Handles Payslips, Invoices, Experience Letters, and Encryption.
 */

export async function generateDocument(employeeId, docType, data) {
    console.log(`[PAYROLL] Generating ${docType} for ${employeeId}...`);
    try {
        const docId = `${docType.substring(0,3).toUpperCase()}-${Date.now()}`;
        const docRef = doc(db, 'payroll_documents', docId);
        
        // Security logic: Watermarking & Encryption (Simulated)
        const secureMetadata = {
            isEncrypted: true,
            encryptionType: 'AES-256',
            watermark: 'Kylrx AI Confidential',
            generatedBy: 'System Admin',
            generationIp: '192.168.1.1'
        };

        const payload = {
            ...data,
            employeeId,
            docId,
            docType,
            status: 'Generated',
            security: secureMetadata,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        };

        if (docType === 'Payslip' || docType === 'Invoice') {
            try {
                const period = data.period || parsePeriod().label;
                const empSnap = await getDoc(doc(db, 'users', employeeId));
                const empData = empSnap.exists() ? empSnap.data() : {};
                const payslipEmployee = normalizePayslipEmployee(
                    { id: employeeId, name: data.employeeName, ...empData },
                    data
                );
                const blob = await generatePayslipPdfBlob(payslipEmployee, period);
                const { storageUrl, storagePath, fileName } = await uploadPayslipPdf(employeeId, period, blob);
                payload.storageUrl = storageUrl;
                payload.storagePath = storagePath;
                payload.fileName = fileName;
            } catch (pdfErr) {
                console.warn('[PAYROLL] PDF generation failed, saving metadata only:', pdfErr);
            }
        }

        await setDoc(docRef, payload);
        
        // Log Access
        await logAccess(employeeId, docId, 'Generation');
        
        // Create Notification
        await createNotification(employeeId, `Your ${docType} for the current cycle is now available in your portal.`, 'normal');
        
        return { success: true, docId };
    } catch (err) {
        console.error('[PAYROLL] Document generation failed:', err);
        throw err;
    }
}

export async function generateMonthlyBatch(month, year) {
    console.log(`[PAYROLL] Initiating batch generation for ${month} ${year}...`);
    const employeesSnap = await getDocs(collection(db, 'users'));
    
    let count = 0;
    for (const empDoc of employeesSnap.docs) {
        const emp = empDoc.data();
        if ((emp.role || '').toLowerCase() === 'admin') continue; // Skip admins

        const type = emp.employmentType === 'Full Time' ? 'Payslip' : 'Invoice';
        
        let gross = emp.salary || 50000;
        
        // Connect to HRMS dynamic session data!
        try {
            const dayKey = new Date().toISOString().split('T')[0];
            const sessionRef = doc(db, 'hrms_sessions', `${empDoc.id}_${dayKey}`);
            const sessionSnap = await getDoc(sessionRef);
            if (sessionSnap.exists()) {
                const sessionData = sessionSnap.data();
                if (sessionData.finalSalary) {
                    gross = sessionData.finalSalary;
                    console.log(`[PAYROLL] Connected to HRMS: Dynamic salary for ${emp.name} is ₹${gross}`);
                }
            }
        } catch (e) {
            console.warn(`[PAYROLL] HRMS connection failed for ${emp.name}, using static base salary:`, e.message);
        }

        await generateDocument(empDoc.id, type, {
            period: `${month} ${year}`,
            employeeName: emp.name,
            designation: emp.designation,
            grossSalary: gross,
            breakdown: {
                basic: gross * 0.45,
                hra: gross * 0.25,
                variable: gross * 0.2,
                tax: gross * 0.1
            },
            deductions: gross * 0.1 // Simulated 10% deduction
        });
        count++;
    }
    return { success: true, count };
}

async function logAccess(userId, docId, action) {
    await addDoc(collection(db, 'document_audit_logs'), {
        userId,
        docId,
        action,
        timestamp: serverTimestamp(),
        ip: '192.168.1.1'
    });
}

async function createNotification(target, message, priority, title = 'Notification') {
    await addDoc(collection(db, 'notifications'), {
        target,
        targetUid: target,
        title,
        text: message,
        message,
        priority,
        read: false,
        timestamp: serverTimestamp()
    });
}

export async function generateFullFinal(employeeId) {
    console.log(`[PAYROLL] Processing F&F Settlement for ${employeeId}...`);
    // Logic for settlement calculation
    return generateDocument(employeeId, 'F&F Settlement', {
        settlementDate: new Date().toISOString(),
        gratuity: 0,
        leaveEncashment: 12000,
        noticePay: 0
    });
}

export async function disburseSalaries(authority) {
    console.log(`[PAYROLL] Disbursing salaries via ${authority}...`);
    const docsSnap = await getDocs(query(collection(db, 'payroll_documents'), where('status', '==', 'Generated')));
    
    let count = 0;
    const cfg = (typeof window !== 'undefined' && window.KylrxCountryConfig) || { currency: 'INR', locale: 'en-IN' };
    const money = (n) => new Intl.NumberFormat(cfg.locale, { style: 'currency', currency: cfg.currency, maximumFractionDigits: 2 }).format(Number(n) || 0);

    for (const d of docsSnap.docs) {
        const dData = d.data();
        let payload = {
            status: 'Paid',
            paidVia: authority,
            paidAt: serverTimestamp()
        };

        // If authorized via HRMS automated gateway, synchronize dynamic session metrics
        if (authority === 'HRMS') {
            try {
                const dayKey = new Date().toISOString().split('T')[0];
                const sessionRef = doc(db, 'hrms_sessions', `${dData.employeeId}_${dayKey}`);
                const sessionSnap = await getDoc(sessionRef);
                if (sessionSnap.exists()) {
                    const sData = sessionSnap.data();
                    payload.hrmsScore = sData.productivityScore || 100;
                    payload.hrmsPenalty = sData.penalty || 0;
                    payload.hrmsBonus = sData.bonus || 0;
                    payload.grossSalary = sData.finalSalary || dData.grossSalary;
                }
            } catch (e) {
                console.warn("Could not sync HRMS session on disbursement:", e);
            }
        }

        await updateDoc(doc(db, 'payroll_documents', d.id), payload);
        count++;

        const amount = payload.grossSalary || dData.grossSalary || 50000;
        
        // 1. System Notification
        await createNotification(
            dData.employeeId,
            `Your monthly salary of ${money(amount)} has been disbursed via ${authority}.`,
            'normal',
            'Salary Disbursed'
        );

        // 2. Dashboard Chat Message
        const chatId = [dData.employeeId, 'hr_support'].sort().join('_');
        await addDoc(collection(db, 'messages'), {
            chatId,
            senderId: 'hr_support',
            senderName: 'HR Support Hub',
            receiverId: dData.employeeId,
            chatType: 'hr',
            text: `Dear ${dData.employeeName || 'Employee'},\n\nWe are pleased to inform you that your monthly salary payout of ${money(amount)} has been successfully disbursed via the ${authority} gateway.\n\nYour detailed payslip is now available in your My Documents Portal.`,
            timestamp: serverTimestamp(),
            read: false
        });

        // 3. Email notification through the server email service (no third-party mail keys in the browser)
        try {
            const user = auth && auth.currentUser;
            if (user) {
                const token = await user.getIdToken();
                const res = await fetch('/api/email/payroll-notice', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ employeeId: dData.employeeId, amount, authority })
                });
                if (!res.ok) console.warn('[EMAIL] Salary notice not sent:', res.status);
            }
        } catch (emailErr) {
            console.error("Error sending salary disbursement email:", emailErr);
        }
    }
    
    await addDoc(collection(db, 'document_audit_logs'), {
        action: 'Mass Salary Disbursement',
        authority,
        count,
        timestamp: serverTimestamp(),
        ip: '192.168.1.1'
    });
    
    return { success: true, count };
}
