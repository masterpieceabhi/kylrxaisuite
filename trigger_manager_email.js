require('dotenv').config();
const { sendEmail } = require('./utils/email');

async function sendManagerCredentials() {
    console.log("Initiating email to Manager John Doe at nb6233712@gmail.com...");

    const managerData = {
        name: "John Doe",
        email: "nb6233712@gmail.com",
        role: "Cybersecurity Manager",
        departmentCode: "UNIT-CYB-863",
        phone: "+918310425800",
        tempPassword: process.env.TEST_TEMP_PASSWORD || "set-TEST_TEMP_PASSWORD-before-running",
        status: "Completed"
    };

    const emailPayload = {
        to: 'nb6233712@gmail.com',
        subject: 'Welcome to HRFlow - Manager Account & Credentials (John Doe)',
        html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff; color: #1e293b;">
                <div style="background: linear-gradient(135deg, #1e40af, #3b82f6); padding: 20px; border-radius: 12px; text-align: center; color: #ffffff; margin-bottom: 24px;">
                    <h1 style="margin: 0; font-size: 24px; font-weight: 700;">Kylrx HRFlow Enterprise</h1>
                    <p style="margin: 6px 0 0 0; opacity: 0.9; font-size: 14px;">Manager Provisioning & Access Notice</p>
                </div>

                <p style="font-size: 16px; line-height: 1.5;">Dear <strong>${managerData.name}</strong>,</p>
                
                <p style="font-size: 15px; line-height: 1.5; color: #334155;">
                    Your account has been officially provisioned as <strong>${managerData.role}</strong> in the Kylrx Enterprise Management Portal.
                </p>

                <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin: 20px 0;">
                    <h3 style="margin-top: 0; color: #0f172a; font-size: 15px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #e2e8f0; padding-bottom: 8px;">Account & Credentials Summary</h3>
                    <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                        <tr>
                            <td style="padding: 6px 0; color: #64748b; width: 40%;"><strong>Application URL:</strong></td>
                            <td style="padding: 6px 0;"><a href="https://app.kylrxai.com/login.html" style="color: #2563eb; font-weight: 600;">https://app.kylrxai.com/login.html</a></td>
                        </tr>
                        <tr>
                            <td style="padding: 6px 0; color: #64748b;"><strong>Manager Name:</strong></td>
                            <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">${managerData.name}</td>
                        </tr>
                        <tr>
                            <td style="padding: 6px 0; color: #64748b;"><strong>Official Email:</strong></td>
                            <td style="padding: 6px 0; color: #0f172a; font-weight: 600;">${managerData.email}</td>
                        </tr>
                        <tr>
                            <td style="padding: 6px 0; color: #64748b;"><strong>Designation / Role:</strong></td>
                            <td style="padding: 6px 0; color: #1d4ed8; font-weight: 600;">${managerData.role}</td>
                        </tr>
                        <tr>
                            <td style="padding: 6px 0; color: #64748b;"><strong>Department Code:</strong></td>
                            <td style="padding: 6px 0; color: #0f172a; font-family: monospace; font-size: 13px;">${managerData.departmentCode}</td>
                        </tr>
                        <tr>
                            <td style="padding: 6px 0; color: #64748b;"><strong>Temporary Password:</strong></td>
                            <td style="padding: 6px 0;">
                                <code style="background-color: #e2e8f0; color: #0f172a; padding: 4px 8px; border-radius: 6px; font-weight: bold; font-family: Consolas, monospace;">${managerData.tempPassword}</code>
                            </td>
                        </tr>
                    </table>
                </div>

                <div style="background-color: #eff6ff; border-left: 4px solid #3b82f6; padding: 12px 16px; margin-bottom: 24px; border-radius: 4px;">
                    <p style="margin: 0; font-size: 13px; color: #1e40af;">
                        🔒 <strong>Security Note:</strong> You will be prompted to reset your password upon first sign-in. Please do not share these credentials.
                    </p>
                </div>

                <div style="text-align: center; margin: 28px 0;">
                    <a href="https://app.kylrxai.com/login.html" 
                       style="background-color: #2563eb; color: #ffffff; padding: 14px 32px; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; display: inline-block;">
                        Access Login Portal
                    </a>
                </div>

                <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
                <p style="font-size: 12px; color: #94a3b8; text-align: center; margin: 0;">
                    Automated notification generated by Kylrx AI HRMS Enterprise Suite • <a href="https://app.kylrxai.com/login.html" style="color: #64748b;">https://app.kylrxai.com/login.html</a>
                </p>
            </div>
        `
    };

    try {
        const result = await sendEmail(emailPayload);
        console.log("✅ SUCCESS: Email dispatched to Manager via Gmail SMTP!");
        console.log("Response Data:", JSON.stringify(result, null, 2));
    } catch (e) {
        console.error("❌ Exception during send:", e);
        process.exit(1);
    }
}

sendManagerCredentials();
