/**
 * Checks the settings a production server needs, before it is started (pure: pass in the environment).
 *
 * Run it on the server with:  npm run check:production
 * "problems" must be fixed before going live. "warnings" switch a feature off or weaken something; decide each one.
 * Values are never printed, only the names of the settings.
 */
const path = require('path');

const looksPlaceholder = (v) => /^(changeme|change-me|secret|password|test|example|your[-_ ]|xxx)/i.test(String(v || ''));

function decodedLength(b64) {
    try { return Buffer.from(String(b64), 'base64').length; } catch (_) { return 0; }
}

/**
 * env: process.env (or a plain object). opts.appDir: the app's folder. opts.canWrite(dir): true/false/null (unknown).
 * Returns { problems: [text], warnings: [text], ok: boolean }.
 */
function checkProductionEnv(env, opts = {}) {
    const e = env || {}; const problems = []; const warnings = [];
    const has = (k) => typeof e[k] === 'string' && e[k].trim() !== '';
    const appDir = opts.appDir ? path.resolve(opts.appDir) : null;

    if (e.NODE_ENV !== 'production') problems.push('NODE_ENV must be "production". Anything else returns sign-in codes in the response and allows local test shortcuts.');
    if (e.ALLOW_DEV_AUTH === 'true') problems.push('ALLOW_DEV_AUTH must not be "true" on a real server.');
    for (const k of ['JWT_SECRET', 'REFRESH_SECRET']) {
        if (!has(k)) problems.push(`${k} is missing.`);
        else if (e[k].length < 32) problems.push(`${k} is too short. Use at least 32 random characters.`);
        else if (looksPlaceholder(e[k])) problems.push(`${k} looks like a placeholder. Use a long random value.`);
    }
    if (has('JWT_SECRET') && e.JWT_SECRET === e.REFRESH_SECRET) problems.push('JWT_SECRET and REFRESH_SECRET must be different.');
    if (!has('PII_ENCRYPTION_KEY')) problems.push('PII_ENCRYPTION_KEY is missing. It protects SSNs and bank numbers; the server refuses to handle them without it.');
    else if (decodedLength(e.PII_ENCRYPTION_KEY) !== 32) problems.push('PII_ENCRYPTION_KEY must be 32 random bytes written as base64 (44 characters).');
    if (!has('AUDIT_CHAIN_KEY')) problems.push('AUDIT_CHAIN_KEY is missing. The audit-log integrity check cannot work without it.');
    else if (e.AUDIT_CHAIN_KEY.length < 32) problems.push('AUDIT_CHAIN_KEY is too short. Use at least 32 random characters.');
    else if ([e.JWT_SECRET, e.REFRESH_SECRET, e.PII_ENCRYPTION_KEY].includes(e.AUDIT_CHAIN_KEY)) problems.push('AUDIT_CHAIN_KEY must not be the same as another secret.');

    if (!has('FIREBASE_SERVICE_ACCOUNT') && !has('FIREBASE_SERVICE_ACCOUNT_PATH')) problems.push('No Firebase service account: set FIREBASE_SERVICE_ACCOUNT (the key as one line of JSON) or FIREBASE_SERVICE_ACCOUNT_PATH (a file outside the app folder).');
    if (has('FIREBASE_SERVICE_ACCOUNT')) { try { const j = JSON.parse(e.FIREBASE_SERVICE_ACCOUNT); if (!j.project_id || !j.private_key) problems.push('FIREBASE_SERVICE_ACCOUNT is not a service-account key (project_id or private_key is missing).'); } catch (_) { problems.push('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); } }
    if (has('FIREBASE_SERVICE_ACCOUNT_PATH') && appDir && path.resolve(e.FIREBASE_SERVICE_ACCOUNT_PATH).startsWith(appDir + path.sep)) warnings.push('FIREBASE_SERVICE_ACCOUNT_PATH points inside the app folder. Keep the key file outside it.');
    if (has('FIRESTORE_EMULATOR_HOST') || has('FIREBASE_AUTH_EMULATOR_HOST')) problems.push('FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are set. A real server must not point at the local emulators.');

    if (e.TENANT_READ_SCOPING === 'off') problems.push('TENANT_READ_SCOPING is "off". Leave it unset (on in production) so one company can never read another company\'s records.');

    if (!(has('SMTP_USER') && has('SMTP_PASS')) && !has('RESEND_API_KEY')) problems.push('No way to send email: set SMTP_USER and SMTP_PASS, or RESEND_API_KEY. Nobody can sign in with a password without it, because the sign-in code is sent by email.');

    if (!has('VAULT_DIR')) warnings.push('VAULT_DIR is not set. Employee documents are then stored in a "kylrxaisuite-vault" folder next to the app. Point it at a disk that is kept across restarts and backed up.');
    else {
        const v = path.resolve(e.VAULT_DIR);
        if (appDir && (v === appDir || v.startsWith(appDir + path.sep))) problems.push('VAULT_DIR is inside the app folder. Employee documents must be stored outside it.');
        const w = opts.canWrite ? opts.canWrite(v) : null;
        if (w === false) problems.push('VAULT_DIR cannot be written to by the server.');
    }
    if (!has('LOG_DIR')) warnings.push('LOG_DIR is not set. Error logs are written to a "logs" folder inside the app folder.');
    if (!has('MONITORING_TOKEN')) warnings.push('MONITORING_TOKEN is not set. The detailed health check and the metrics page cannot be read by a monitoring service.');
    if (!has('PLATFORM_OPERATOR_TOKEN')) warnings.push('PLATFORM_OPERATOR_TOKEN is not set. Operator-only endpoints stay closed, which is fine if you do not use them.');
    if (!has('SENTRY_DSN')) warnings.push('SENTRY_DSN is not set. Errors are only written to the log file; nobody is told.');

    if (e.GUSTO_MODE === 'mock') problems.push('GUSTO_MODE is "mock". The mock payroll provider is refused in production.');
    if ((has('GUSTO_CLIENT_ID') || has('GUSTO_CLIENT_SECRET')) && !(has('GUSTO_CLIENT_ID') && has('GUSTO_CLIENT_SECRET'))) problems.push('Set both GUSTO_CLIENT_ID and GUSTO_CLIENT_SECRET, or neither.');
    if (!has('GUSTO_CLIENT_ID')) warnings.push('Gusto is not set up (GUSTO_CLIENT_ID, GUSTO_CLIENT_SECRET, GUSTO_MODE). Payroll through Gusto stays switched off.');
    if (has('STRIPE_SECRET_KEY') && !has('STRIPE_WEBHOOK_SECRET')) problems.push('STRIPE_SECRET_KEY is set without STRIPE_WEBHOOK_SECRET. Payment notices from Stripe could not be verified.');
    if (has('STRIPE_SECRET_KEY') && /^sk_test_/.test(e.STRIPE_SECRET_KEY)) warnings.push('STRIPE_SECRET_KEY is a test key. No real payments will be taken.');
    const stripeOn = String(e.BILLING_PROVIDER || '').toLowerCase() === 'stripe';
    if (stripeOn && !has('STRIPE_SECRET_KEY')) problems.push('BILLING_PROVIDER is "stripe" but STRIPE_SECRET_KEY is missing.');
    if (!stripeOn && has('STRIPE_SECRET_KEY')) warnings.push('STRIPE_SECRET_KEY is set but BILLING_PROVIDER is not "stripe", so billing still runs in practice mode.');
    if (!stripeOn && !has('STRIPE_SECRET_KEY')) warnings.push('Stripe is not set up (BILLING_PROVIDER=stripe, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET). Billing runs in practice mode.');

    return { problems, warnings, ok: problems.length === 0 };
}

module.exports = { checkProductionEnv };
