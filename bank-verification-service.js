import { db } from "./firebase-config.js";
import { doc, setDoc, updateDoc, serverTimestamp, collection, addDoc, getDoc, query, where, getDocs } from "./firebase-config.js";

/**
 * Bank Verification Workflow Service
 */
export async function submitBankDetails(employeeId, details) {
    console.log(`[BANK] Submitting details for ${employeeId}...`);
    try {
        const verificationRef = doc(db, 'bank_verifications', employeeId);
        await setDoc(verificationRef, {
            ...details,
            employeeId,
            status: 'Under Review',
            submittedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        }, { merge: true });

        // Add to audit log
        await addDoc(collection(db, 'audit_logs'), {
            action: 'BANK_SUBMISSION',
            employeeId,
            performedBy: employeeId,
            timestamp: serverTimestamp(),
            details: 'Bank verification details submitted for review.'
        });

        // Notify Admin (Mock)
        await createNotification('admin', `New bank verification submitted by ${employeeId}`, 'high');
        
        return { success: true };
    } catch (err) {
        console.error('[BANK] Submission failed:', err);
        throw err;
    }
}

export async function processBankApproval(employeeId, action, adminId, reason = '') {
    console.log(`[BANK] Processing ${action} for ${employeeId} by ${adminId}...`);
    try {
        const verificationRef = doc(db, 'bank_verifications', employeeId);
        const status = action === 'approve' ? 'Approved' : 'Rejected';

        // Retrieve the bank verification data
        const verificationSnap = await getDoc(verificationRef);
        const vData = verificationSnap.exists() ? verificationSnap.data() : {};

        await updateDoc(verificationRef, {
            status,
            adminFeedback: reason,
            reviewedBy: adminId,
            reviewedAt: serverTimestamp()
        });

        // Audit Log
        await addDoc(collection(db, 'audit_logs'), {
            action: action === 'approve' ? 'BANK_APPROVAL' : 'BANK_REJECTION',
            employeeId,
            performedBy: adminId,
            timestamp: serverTimestamp(),
            details: action === 'approve' ? 'Bank details approved.' : `Bank details rejected. Reason: ${reason}`
        });

        if (action === 'approve') {
            await syncToPayroll(employeeId);

            // Process associated payroll document (if any exists in 'Generated' state)
            const payrollQuery = query(
                collection(db, 'payroll_documents'),
                where('employeeId', '==', employeeId),
                where('status', '==', 'Generated')
            );
            const payrollSnap = await getDocs(payrollQuery);
            for (const docObj of payrollSnap.docs) {
                await updateDoc(doc(db, 'payroll_documents', docObj.id), {
                    status: 'Paid',
                    paidVia: 'Admin (Direct)',
                    paidAt: serverTimestamp(),
                    bankTransferDetails: {
                        bankName: vData.bankName || '',
                        accountNum: vData.accountNum || '',
                        ifsc: vData.ifsc || ''
                    }
                });
            }

            const amount = vData.amount || 50000;
            const EMAIL_API_KEY = "6f8d75dc-500b-4eb1-b0db-6e6b4e7235db";
            const SENDER_EMAIL = "payroll@kylrxai.com";

            // 1. System Notification
            await createNotification(
                employeeId,
                `Your payout of ₹${amount} has been approved and processed.`,
                'normal',
                'Salary Disbursed'
            );

            // 2. Dashboard Chat Message
            const chatId = [employeeId, 'hr_support'].sort().join('_');
            await addDoc(collection(db, 'messages'), {
                chatId,
                senderId: 'hr_support',
                senderName: 'HR Support Hub',
                receiverId: employeeId,
                chatType: 'hr',
                text: vData.emailMessage || `Dear Employee,\n\nWe are pleased to inform you that your payout of ₹${amount} has been successfully processed to your bank account.\n\nBest regards,\nPayroll Operations`,
                timestamp: serverTimestamp(),
                read: false
            });

            // 3. Email Notification via Web3Forms
            try {
                const userSnap = await getDoc(doc(db, 'users', employeeId));
                if (userSnap.exists()) {
                    const uData = userSnap.data();
                    const employeeEmail = uData.email;
                    if (employeeEmail) {
                        const emailBody = `Dear ${uData.name || 'Employee'},\n\nWe are pleased to inform you that your bank transfer payout has been approved and processed successfully.\n\nPayout Details:\n- Amount: ₹${amount}\n- Status: Completed\n\nYour detailed payslip/invoice is now available in your Employee Documents Portal.\n\nBest regards,\nPayroll Operations Team`;
                        
                        console.log(`[EMAIL] Sending payment approval email to ${employeeEmail}...`);
                        await fetch("https://api.web3forms.com/submit", {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "Accept": "application/json"
                            },
                            body: JSON.stringify({
                                access_key: EMAIL_API_KEY,
                                name: "Onn HR Payroll Gate",
                                email: SENDER_EMAIL,
                                subject: "Onn HR - Payout Processed",
                                message: vData.emailMessage || emailBody
                            })
                        });
                    }
                }
            } catch (emailErr) {
                console.error("Error sending salary disbursement email:", emailErr);
            }
        } else {
            // If rejected, notify employee
            await createNotification(
                employeeId,
                `Your bank verification/payout request was rejected. Reason: ${reason}`,
                'normal',
                'Payout Rejected'
            );
        }

        return { success: true };
    } catch (err) {
        console.error('[BANK] Approval process failed:', err);
        throw err;
    }
}

async function syncToPayroll(employeeId) {
    const verificationSnap = await getDoc(doc(db, 'bank_verifications', employeeId));
    if (verificationSnap.exists()) {
        const details = verificationSnap.data();
        const payrollRef = doc(db, 'payroll_profiles', employeeId);
        await setDoc(payrollRef, {
            bankName: details.bankName,
            accountNumber: details.accountNum,
            routingCode: details.routingCode,
            bankVerificationStatus: 'Verified',
            lastUpdated: serverTimestamp()
        }, { merge: true });
        console.log(`[BANK] Successfully synced to payroll for ${employeeId}`);
    }
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
