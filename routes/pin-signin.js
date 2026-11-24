/**
 * Sign-in with a PIN, and a code by email as the way back in. Mounted at /api/auth (see server.js).
 *   POST /api/auth/pin/start   { email, pin }        ->  { next: 'signed_in', token } | { next: 'choose', challenge }
 *   POST /api/auth/pin/send    { challenge, via, phone? }  ->  { next: 'code', challenge }   via is 'email' or 'phone'
 *   POST /api/auth/pin/code    { challenge, code }   ->  { next: 'signed_in', token, setupToken, hasPin, pinWasRight }
 * A device that has signed in with a code is remembered by the cookie `onnhr_device` (HttpOnly, so scripts on the page
 * cannot read it; sent only to these routes).
 *   POST /api/auth/pin/set     { setupToken, pin }           ->  { saved: true }
 * The rules are in services/pin-signin.js. `token` is a Firebase custom token: the page hands it to Firebase and from
 * then on everything works as after any other sign-in. These routes are public by nature, so they are rate limited.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { admin, rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const pinSignin = require('../services/pin-signin');
const localDemo = require('../services/local-demo');

const router = express.Router();
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: localDemo.relaxedLimit(process.env, 20),
    message: { success: false, code: 'slow_down', error: 'Too many tries. Wait a few minutes, then try again.' }
});

const refs = new Map(); // Firebase uid -> the person's document, for the length of one sign-in
async function findPerson(email) {
    const snap = await rawCollection('users').where('email', '==', email).get();
    const docs = (snap.docs || []).filter((d) => d.data().orgId);
    if (docs.length !== 1) return null; // nobody, or the same email in two companies: a code alone must not pick one
    let uid;
    try { uid = (await admin.auth().getUserByEmail(email)).uid; } catch (_) { return null; }
    const d = docs[0].data();
    if (refs.size > 2000) refs.clear();
    refs.set(uid, docs[0].ref);
    return {
        uid, email, phone: d.phone || (d.usProfile && (d.usProfile.mobilePhone || d.usProfile.phone)) || '', pinHash: d.pinHash || null, pinAttempts: d.pinAttempts || 0, pinLockedUntil: d.pinLockedUntil || null,
        signinDevices: Array.isArray(d.signinDevices) ? d.signinDevices : [],
        codeVia: (d.usProfile && d.usProfile.codeVia) || '', // how they want sign-in codes (My details)
        role: d.role || null, orgId: d.orgId || null,
        // the authenticator app, when the person has set one up (routes/authenticator.js); the secret is stored encrypted
        totp: require('../services/authenticator').forSignin(uid, d.totp),
        active: !/^(terminated|inactive|offboarded|suspended|locked)$/i.test(String(d.status || 'Active'))
    };
}
/**
 * The one active person whose mobile on record is this number (stored in several formats over time), or null when
 * nobody or more than one person has it: a number shared by two people must not pick one of them.
 */
async function findPersonByPhone(ten) {
    const [a, b, c] = [ten.slice(0, 3), ten.slice(3, 6), ten.slice(6)];
    const forms = [...new Set([ten, `1${ten}`, `+1${ten}`, `(${a}) ${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`, `${a} ${b} ${c}`, `+1 (${a}) ${b}-${c}`, `+1 ${a}-${b}-${c}`, `+1 ${a} ${b} ${c}`, `1-${a}-${b}-${c}`])];
    const snaps = await Promise.all(['phone', 'usProfile.phone', 'usProfile.mobilePhone'].map((f) => rawCollection('users').where(f, 'in', forms).get().catch(() => ({ docs: [] }))));
    const found = new Map();
    for (const s of snaps) for (const d of s.docs || []) { const x = d.data(); if (x.orgId && x.email && !/^(terminated|inactive|offboarded|suspended|locked)$/i.test(String(x.status || 'Active'))) found.set(d.id, x.email); }
    if (found.size !== 1) return null;
    return findPerson(String([...found.values()][0]).trim().toLowerCase());
}

/**
 * The company's rule for a code on a new device (organizations/{id}.signinRules.newDeviceCode):
 *   'privileged' (the default)  roles that can see SSNs, pay or company settings: owner, HR, payroll, accountant, auditor
 *   'everyone' | 'off'
 */
const PRIVILEGED = ['people.read_pay', 'payroll.view', 'people.write', 'security.manage', 'org.settings'];
async function needsSecondStep(person) {
    if (!person || !person.orgId) return false;
    let rule = 'privileged';
    try { const o = await rawCollection('organizations').doc(String(person.orgId)).get(); const d = (typeof o.exists === 'function' ? o.exists() : o.exists) ? o.data() : {}; rule = (d.signinRules && d.signinRules.newDeviceCode) || 'privileged'; } catch (_) { rule = 'privileged'; }
    if (rule === 'off') return false;
    if (rule === 'everyone') return true;
    const { can } = require('../services/permissions');
    return PRIVILEGED.some((perm) => { try { return can({ role: person.role }, perm); } catch (_) { return false; } });
}

/** Checks a password with Firebase Authentication (the local emulator when one is set). False when it cannot be checked. */
async function checkPassword(email, password) {
    if (process.env.PASSWORD_SIGNIN === 'off' || !email || !password) return false;
    const emu = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    let key = null;
    try { key = JSON.parse(process.env.FIREBASE_WEB_CONFIG || '{}').apiKey || null; } catch (_) { key = null; }
    key = key || process.env.FIREBASE_API_KEY || (emu ? 'local-emulator' : null);
    if (!key) return false;
    const base = emu ? `http://${emu}/identitytoolkit.googleapis.com/v1` : 'https://identitytoolkit.googleapis.com/v1';
    try {
        const res = await fetch(`${base}/accounts:signInWithPassword?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: false }) });
        return res.ok;
    } catch (_) { return false; }
}

async function savePerson(uid, patch) {
    const ref = refs.get(uid);
    if (!ref) throw new Error('person not loaded');
    await ref.update(patch);
}

/**
 * Emails the code through the app's one email sender (utils/email.js: SMTP_USER and SMTP_PASS, or RESEND_API_KEY).
 * Resolves false when no email is set up, or when the mail server refused it.
 */
async function sendCode(email, code, link) {
    if (!((process.env.SMTP_USER && process.env.SMTP_PASS) || process.env.RESEND_API_KEY)) {
        logger.warn('[PinSignin] email is not set up (SMTP_USER and SMTP_PASS, or RESEND_API_KEY), so the sign-in code was not emailed');
        return false;
    }
    try {
        await require('../utils/email').sendEmail({
            to: email, subject: `${code} is your Onn HR sign-in code`,
            text: `Your Onn HR sign-in code is ${code}.\n\n${link ? `Or sign in with one tap: ${link}\n\n` : ''}It works for 10 minutes. If you did not try to sign in, you can ignore this email; nobody can sign in without the code.\n\nOnn HR by Prompt AI USA`
        });
        return true;
    } catch (e) { logger.warn(`[PinSignin] the sign-in code could not be emailed: ${String((e && e.message) || e).slice(0, 200)}`); return false; }
}

/**
 * Texts the code through Twilio when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are set (BizCRM's names
 * TWILIO_SID and TWILIO_TOKEN are accepted too, so its lines can be pasted as they are). Resolves false
 * when they are not. Only ever called with a number that is already on the person's record.
 */
async function sendText(phone, code, link) {
    const e = process.env;
    const sid = e.TWILIO_ACCOUNT_SID || e.TWILIO_SID; const token = e.TWILIO_AUTH_TOKEN || e.TWILIO_TOKEN; const from = e.TWILIO_FROM;
    if (!sid || !token || !from) { logger.warn('[PinSignin] no text message provider is set up (TWILIO_*), so the sign-in code was not texted'); return false; }
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: phone, From: from, Body: `${code} is your Onn HR sign-in code. It works for 10 minutes.${link ? ` Or tap to sign in: ${link}` : ''} If you did not ask for it, ignore this message. Reply STOP to opt out.${otpLine(code)}` })
    });
    if (!res.ok) { logger.warn(`[PinSignin] Twilio refused the text: ${await twilioWhy(res)}`); return false; }
    return true;
}

/** "@host #code" as the last line of a text lets Android Chrome fill the code in on that site only (WebOTP). */
function otpLine(code) {
    try { const host = new URL(process.env.APP_URL || '').host; return host ? `\n\n@${host} #${code}` : ''; } catch (_) { return ''; }
}

/** Twilio's own error code and message, for the server log (never the page). */
async function twilioWhy(res) {
    const j = await res.json().catch(() => ({}));
    return `HTTP ${res.status}${j.code ? `, error ${j.code}` : ''}${j.message ? `: ${String(j.message).slice(0, 200)}` : ''}`;
}

/** Which ways of getting a code this server offers besides email (no person is named, so nothing is revealed). */
function channels(e = process.env) {
    const twilio = Boolean((e.TWILIO_ACCOUNT_SID || e.TWILIO_SID) && (e.TWILIO_AUTH_TOKEN || e.TWILIO_TOKEN));
    return { text: twilio && Boolean(e.TWILIO_FROM), whatsapp: twilio && Boolean(e.TWILIO_WHATSAPP_FROM) };
}

/**
 * Sends the code by WhatsApp through Twilio, from TWILIO_WHATSAPP_FROM (a WhatsApp sender on the Twilio account; for
 * testing, Twilio's WhatsApp sandbox number). With TWILIO_WHATSAPP_CONTENT_SID (an approved authentication template whose
 * variable {{1}} is the code) the template is used, which WhatsApp requires outside a 24-hour conversation; without it
 * a plain message is sent, which works in the sandbox after the person has joined it.
 */
async function sendWhatsApp(phone, code, link) {
    const e = process.env;
    const sid = e.TWILIO_ACCOUNT_SID || e.TWILIO_SID; const token = e.TWILIO_AUTH_TOKEN || e.TWILIO_TOKEN;
    const from = String(e.TWILIO_WHATSAPP_FROM || '').replace(/^whatsapp:/i, '');
    if (!sid || !token || !from) { logger.warn('[PinSignin] WhatsApp is not set up (TWILIO_WHATSAPP_FROM), so the sign-in code was not sent'); return false; }
    const body = new URLSearchParams({ To: `whatsapp:${phone}`, From: `whatsapp:${from}` });
    if (e.TWILIO_WHATSAPP_CONTENT_SID) { body.set('ContentSid', e.TWILIO_WHATSAPP_CONTENT_SID); body.set('ContentVariables', JSON.stringify({ 1: code })); }
    else body.set('Body', `${code} is your Onn HR sign-in code. It works for 10 minutes.${link ? ` Or tap to sign in: ${link}` : ''} If you did not ask for it, ignore this message.`);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });
    if (!res.ok) { logger.warn(`[PinSignin] Twilio refused the WhatsApp message: ${await twilioWhy(res)}`); return false; }
    return true;
}

const service = pinSignin.create({
    totp: require('../services/totp'),
    findPerson, findPersonByPhone, checkPassword, savePerson, sendCode, sendText, sendWhatsApp,
    autoSend: true, ways: () => channels(),
    secondStep: (person) => needsSecondStep(person),
    // the one-tap link: the id is in the part after "#", which browsers never send to a server, and the page asks for a
    // tap before using it, so a mail scanner that opens links cannot use it up
    linkUrl: (id) => `${String(process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '')}/login.html#k=${id}`,
    // why a code was not sent, for whoever looks at the server log (the page always gives the same answer)
    note: (reason, d) => logger.warn(`[PinSignin] code not sent by ${d.via}: ${reason}${d.uid ? ` (user ${d.uid})` : ''}`),
    otp: require('../services/otp-verification-service'),
    // a company that requires single sign-on gets no PIN or code sign-in (break-glass accounts excepted)
    mintToken: require('../services/sso').guardMint((uid) => admin.auth().createCustomToken(uid)),
    secret: process.env.JWT_SECRET,
    showCode: process.env.NODE_ENV !== 'production'
});

const run = (fn) => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { deviceToken, ...out } = await fn(req.body || {}, req);
        if (deviceToken) remember(res, deviceToken);
        res.json({ success: true, ...out });
    }
    catch (e) {
        if (e && e.status) return res.status(e.status).json({ success: false, code: e.code, error: e.message });
        logger.error(`[PinSignin] ${e && e.message}`);
        res.status(500).json({ success: false, code: 'failed', error: 'Sign-in is not working right now. Try again in a minute.' });
    }
};
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const COOKIE = 'onnhr_device';
const deviceOf = (req) => { const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})(?:;|$)').exec(String(req.headers.cookie || '')); return m ? m[1] : ''; };
const remember = (res, token) => res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/api/auth/pin', maxAge: 365 * 86400000 });

router.get('/pin/channels', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ success: true, ...channels() }); });
router.post('/pin/start', limiter, run((b, req) => service.start({ login: text(b.login || b.email, 254), pin: text(b.pin, 200), deviceToken: deviceOf(req), prefer: text(b.prefer, 10) })));
router.post('/pin/link', limiter, run((b, req) => service.verifyLink({ link: text(b.link, 64), deviceToken: deviceOf(req) })));
router.post('/pin/send', limiter, run((b) => service.requestCode({ challenge: text(b.challenge, 2000), via: text(b.via, 10), phone: text(b.phone, 30) })));
router.post('/pin/code', limiter, run((b, req) => service.verifyCode({ challenge: text(b.challenge, 2000), code: text(b.code, 12), deviceToken: deviceOf(req) })));
router.post('/pin/remember', limiter, run((b, req) => service.rememberDevice({ grant: text(b.grant, 2000), deviceToken: deviceOf(req) })));
router.post('/pin/set', limiter, run((b) => service.setPin({ setupToken: text(b.setupToken, 2000), pin: text(b.pin, 12) })));

module.exports = router;
