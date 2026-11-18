const nodemailer = require('nodemailer');
const { Resend } = require('resend');

/**
 * Helper to generate clean plain text from HTML
 */
function htmlToPlainText(html = '') {
    return html
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Enhanced Email Dispatcher
 * Optimized for Gmail inbox delivery (anti-spam scoring headers, dual-payload HTML/Text, Reply-To)
 */
const sendEmail = async ({ to, subject, text, html }) => {
    const recipients = Array.isArray(to) ? to.join(', ') : to;
    const plainText = text || htmlToPlainText(html);

    // 1. Gmail SMTP (Nodemailer)
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
        console.log(`[Email] Dispatching via Gmail SMTP (Nodemailer) to ${recipients}: ${subject}`);
        // SMTP_HOST names any mail server (Microsoft 365: smtp.office365.com, port 587). Without it, Gmail as before.
        const auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_HOST ? process.env.SMTP_PASS : process.env.SMTP_PASS.replace(/\s+/g, '') }; // a Gmail app password is shown with spaces
        const transporter = nodemailer.createTransport(process.env.SMTP_HOST
            ? { host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: String(process.env.SMTP_PORT) === '465', auth }
            : { service: 'gmail', auth });

        const senderName = process.env.EMAIL_SENDER_NAME || 'Onn HR';
        const mailOptions = {
            from: `"${senderName}" <${process.env.EMAIL_FROM || process.env.SMTP_USER}>`,
            replyTo: process.env.EMAIL_FROM || process.env.SMTP_USER,
            to: recipients,
            subject,
            text: plainText,
            html: html || `<p>${plainText}</p>`,
            headers: {
                'X-Priority': '1',
                'X-MSMail-Priority': 'High',
                'Importance': 'high',
                'X-Mailer': 'Onn HR'
            }
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`[Email] ✅ Sent successfully via SMTP! Message ID: ${info.messageId}`);
        return { id: info.messageId, provider: 'smtp', accepted: info.accepted };
    }

    // 2. Resend API Fallback
    if (process.env.RESEND_API_KEY) {
        console.log(`[Email] Dispatching via Resend API to ${recipients}: ${subject}`);
        const resend = new Resend(process.env.RESEND_API_KEY);
        const { data, error } = await resend.emails.send({
            from: process.env.EMAIL_FROM ? `${process.env.EMAIL_SENDER_NAME || 'Onn HR'} <${process.env.EMAIL_FROM}>` : 'Onn HR <onboarding@resend.dev>', // resend.dev only reaches the account owner: set EMAIL_FROM to a verified domain
            to: Array.isArray(to) ? to : [to],
            subject,
            text: plainText,
            html: html || `<p>${plainText}</p>`
        });

        if (error) {
            console.error(`[Email] ❌ Resend error:`, error);
            throw new Error(error.message);
        }

        console.log(`[Email] ✅ Sent successfully via Resend! Message ID: ${data.id}`);
        return { ...data, provider: 'resend' };
    }

    throw new Error('No email transport configured. Please set SMTP_USER & SMTP_PASS or RESEND_API_KEY in .env');
};

module.exports = { sendEmail };
