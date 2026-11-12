const express = require('express');
const router = express.Router();
const { sendEmail } = require('../utils/email');
const { runReminderJob } = require('../utils/reminder-scheduler');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { getCountryConfig } = require('../country-config');

router.use(verifyToken);

let admin, db;
try {
    ({ admin, db } = require('../config/firebase'));
} catch (e) {
    console.warn('[EMAIL] Firebase Admin not available:', e.message);
}

/**
 * Trigger manual scheduler check.
 * POST /api/email/run-reminder-check
 */
router.post('/run-reminder-check', async (req, res) => {
    try {
        const result = await runReminderJob();
        return res.json(result);
    } catch (error) {
        console.error('[EMAIL] Reminder check route error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * General endpoint to send emails.
 * POST /api/email/send
 */
router.post('/send', async (req, res) => {
    try {
        const { to, subject, html, text } = req.body;
        if (!to || !subject || (!html && !text)) {
            return res.status(400).json({ success: false, error: 'to, subject, and body (html or text) are required' });
        }

        const result = await sendEmail({ to, subject, html, text });
        return res.json({ success: true, message: 'Email sent successfully', result });
    } catch (error) {
        console.error('[EMAIL] Send route error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Salary-paid notice to one employee of the caller's company (used by the Payroll Document Center).
 * The message is composed here, in the company's currency; the browser only names the person.
 * POST /api/email/payroll-notice  { employeeId, amount, authority }
 */
router.post('/payroll-notice', authorize(ADMIN_HR_ROLES), async (req, res) => {
    try {
        const { employeeId, amount, authority } = req.body || {};
        if (!employeeId) return res.status(400).json({ success: false, error: 'employeeId is required' });
        const callerOrg = req.user && req.user.orgId;
        let userDoc = await db.collection('users').doc(String(employeeId)).get();
        if (!userDoc.exists) {
            const q = await db.collection('users').where('employeeId', '==', String(employeeId)).limit(1).get();
            if (!q.empty) userDoc = q.docs[0];
        }
        if (!userDoc.exists) return res.status(404).json({ success: false, error: 'Employee not found' });
        const person = userDoc.data();
        if (callerOrg && person.orgId && person.orgId !== callerOrg) {
            return res.status(404).json({ success: false, error: 'Employee not found' });
        }
        if (!person.email) return res.status(422).json({ success: false, error: 'Employee has no email address' });

        let country = 'IN';
        try {
            const org = callerOrg ? await db.collection('organizations').doc(callerOrg).get() : null;
            if (org && org.exists) country = org.data().country || 'IN';
        } catch (_) { /* keep default */ }
        const cfg = getCountryConfig(country);
        const num = Number(amount);
        const money = Number.isFinite(num) && num > 0
            ? new Intl.NumberFormat(cfg.locale, { style: 'currency', currency: cfg.currency }).format(num)
            : null;
        const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const via = esc(String(authority || 'payroll').slice(0, 40));
        const lines = [
            `Dear ${esc(person.name || 'Employee')},`,
            `Your salary payout has been disbursed via the ${via} gateway.`,
            money ? `Net amount: ${esc(money)}` : null,
            'Your payslip is available in your Documents portal.',
            'Payroll Operations Team'
        ].filter(Boolean);
        const result = await sendEmail({
            to: person.email,
            subject: 'Salary disbursed',
            html: lines.map((l) => `<p>${l}</p>`).join('')
        });
        return res.json({ success: true, result });
    } catch (error) {
        console.error('[EMAIL] Payroll notice error:', error.message);
        return res.status(500).json({ success: false, error: 'Could not send the payroll notice' });
    }
});

/**
 * Trigger bulk reminder emails for Hold Candidates.
 * POST /api/email/trigger-bulk-reminders
 */
router.post('/trigger-bulk-reminders', async (req, res) => {
    try {
        const { candidateIds, reminderMessage } = req.body;
        if (!candidateIds || !Array.isArray(candidateIds) || candidateIds.length === 0) {
            return res.status(400).json({ success: false, error: 'candidateIds array is required' });
        }

        console.log(`[EMAIL] Initiating bulk reminders for ${candidateIds.length} candidates...`);
        const results = [];
        
        for (const id of candidateIds) {
            try {
                // Fetch employee/candidate document
                const userDoc = await db.collection('users').doc(id).get();
                if (!userDoc.exists) {
                    results.push({ id, success: false, error: 'Candidate not found in system' });
                    continue;
                }

                const data = userDoc.data();
                const personalEmail = data.personalEmail || data.email;
                if (!personalEmail) {
                    results.push({ id, success: false, error: 'No email found for candidate' });
                    continue;
                }

                const candidateName = data.fullName || data.name || 'Candidate';
                const subject = 'ACTION REQUIRED: Pending Onboarding Document Submission';
                const html = `
                    <div style="font-family: 'Outfit', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
                        <h2 style="color: #6366f1; font-weight: 800;">Pending Document Reminder</h2>
                        <p>Dear <strong>${candidateName}</strong>,</p>
                        <p>We are writing to remind you that your onboarding documents are still pending verification in the HRFlow portal.</p>
                        <blockquote style="background-color: #f8fafc; border-left: 4px solid #6366f1; padding: 12px; margin: 16px 0; font-style: italic;">
                            ${reminderMessage || 'Please upload the pending mandatory documents as soon as possible to complete your onboarding process.'}
                        </blockquote>
                        <p>Ensure you upload the required identity and academic records to finalize your profile setup.</p>
                        <div style="margin: 24px 0; text-align: center;">
                            <a href="${req.protocol}://${req.get('host')}/onboarding-invite.html?token=${data.onboardingToken}&id=${id}" 
                               style="background-color: #6366f1; color: white; padding: 12px 24px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
                               Resume Onboarding Setup
                            </a>
                        </div>
                        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
                        <p style="font-size: 0.75rem; color: #94a3b8;">This is an automated reminder from the Kylrx AI HRMS Gateway. Please do not reply directly to this email.</p>
                    </div>
                `;

                await sendEmail({ to: personalEmail, subject, html });

                // Log audit history
                await db.collection('onboarding_reminders_audit').add({
                    employeeId: id,
                    employeeName: candidateName,
                    email: personalEmail,
                    triggeredBy: req.body.adminName || 'HR Admin',
                    timestamp: new Date().toISOString(),
                    message: reminderMessage || 'Bulk manual reminder sent.'
                });

                results.push({ id, success: true });
            } catch (err) {
                console.error(`[EMAIL] Failed to send reminder to candidate ${id}:`, err.message);
                results.push({ id, success: false, error: err.message });
            }
        }

        return res.json({ success: true, results });
    } catch (error) {
        console.error('[EMAIL] Bulk reminder route error:', error.message);
        return res.status(500).json({ success: false, error: error.message });
    }
});


/**
 * Send a test email to verify email config is working.
 * POST /api/email/test
 * Body: { to: "user@example.com" }
 */
router.post('/test', async (req, res) => {
    try {
        const { to } = req.body;
        if (!to) {
            return res.status(400).json({ success: false, error: 'Recipient email address (to) is required.' });
        }

        const senderName = process.env.EMAIL_SENDER_NAME || 'Kylrx AI HRMS';
        const fromEmail = process.env.SMTP_USER || process.env.EMAIL_FROM || 'noreply@kylrxai.com';

        const html = `
            <div style="font-family: 'Outfit', sans-serif; max-width: 580px; margin: 0 auto; padding: 32px; border: 1px solid #e2e8f0; border-radius: 20px; background: #ffffff;">
                <div style="text-align: center; margin-bottom: 28px;">
                    <div style="width: 60px; height: 60px; border-radius: 16px; background: linear-gradient(135deg, #3b82f6, #6366f1); display: inline-flex; align-items: center; justify-content: center; font-size: 28px;">✅</div>
                </div>
                <h2 style="text-align: center; color: #1e40af; font-size: 1.5rem; font-weight: 800; margin-bottom: 8px;">Email Config is Working!</h2>
                <p style="text-align: center; color: #64748b; margin-bottom: 28px;">This test email confirms that your organization's email configuration is set up correctly. All system emails (onboarding, payroll, leave approvals) will now be delivered from your domain.</p>
                <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 16px; margin-bottom: 24px;">
                    <div style="font-size: 0.85rem; color: #166534; font-weight: 600;">✉️ Sent from: <strong>${fromEmail}</strong></div>
                    <div style="font-size: 0.8rem; color: #15803d; margin-top: 4px;">Emails to your employees will appear with this sender address.</div>
                </div>
                <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;">
                <p style="font-size: 0.75rem; color: #94a3b8; text-align: center;">This is an automated test from the Kylrx AI HRMS Admin Settings panel. No action required.</p>
            </div>
        `;

        const result = await sendEmail({
            to,
            subject: `✅ Email Config Test — ${senderName}`,
            html
        });

        console.log(`[EMAIL] Test email sent to ${to}`);
        return res.json({ success: true, message: `Test email dispatched to ${to}`, result });
    } catch (error) {
        // Extract a clean, human-readable error message
        let errMsg = error.message || String(error);

        // Provide friendly SMTP error hints
        if (error.code === 'EAUTH' || errMsg.includes('535') || errMsg.includes('Username and Password')) {
            errMsg = 'SMTP Authentication failed. Check your email and App Password in Settings → Email Config.';
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
            errMsg = 'Could not connect to SMTP server. Check the SMTP Host and Port settings.';
        } else if (errMsg.includes('Resend')) {
            errMsg = 'Resend API error: ' + errMsg.replace('Resend error: ', '');
        }

        console.error('[EMAIL] Test email route error:', errMsg);
        return res.status(500).json({ success: false, error: errMsg });
    }
});

module.exports = router;
