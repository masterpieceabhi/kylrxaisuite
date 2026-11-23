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
        // the authenticator app, when the person has set one up (routes/authenticator.js); the secret is stored encrypted
        totp: require('../services/authenticator').forSignin(uid, d.totp),
        active: !/^(terminated|inactive|offboarded|suspended|locked)$/i.test(String(d.status || 'Active'))
    };
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
async function sendCode(email, code) {
    if (!((process.env.SMTP_USER && process.env.SMTP_PASS) || process.env.RESEND_API_KEY)) {
        logger.warn('[PinSignin] email is not set up (SMTP_USER and SMTP_PASS, or RESEND_API_KEY), so the sign-in code was not emailed');
        return false;
    }
    try {
        await require('../utils/email').sendEmail({
            to: email, subject: `${code} is your Onn HR sign-in code`,
            text: `Your Onn HR sign-in code is ${code}.\n\nIt works for 10 minutes. If you did not try to sign in, you can ignore this email; nobody can sign in without the code.\n\nOnn HR by Prompt AI USA`
        });
        return true;
    } catch (e) { logger.warn(`[PinSignin] the sign-in code could not be emailed: ${String((e && e.message) || e).slice(0, 200)}`); return false; }
}

/**
 * Texts the code through Twilio when TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM are set. Resolves false
 * when they are not. Only ever called with a number that is already on the person's record.
 */
async function sendText(phone, code) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
    if (!sid || !token || !from) { logger.warn('[PinSignin] no text message provider is set up (TWILIO_*), so the sign-in code was not texted'); return false; }
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: phone, From: from, Body: `${code} is your Onn HR sign-in code. It works for 10 minutes. If you did not ask for it, ignore this message.` })
    });
    if (!res.ok) { logger.warn(`[PinSignin] the text message provider answered ${res.status}`); return false; }
    return true;
}

const service = pinSignin.create({
    totp: require('../services/totp'),
    findPerson, savePerson, sendCode, sendText,
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

router.post('/pin/start', limiter, run((b, req) => service.start({ email: text(b.email, 254), pin: text(b.pin, 12), deviceToken: deviceOf(req) })));
router.post('/pin/send', limiter, run((b) => service.requestCode({ challenge: text(b.challenge, 2000), via: text(b.via, 10), phone: text(b.phone, 30) })));
router.post('/pin/code', limiter, run((b, req) => service.verifyCode({ challenge: text(b.challenge, 2000), code: text(b.code, 12), deviceToken: deviceOf(req) })));
router.post('/pin/remember', limiter, run((b, req) => service.rememberDevice({ grant: text(b.grant, 2000), deviceToken: deviceOf(req) })));
router.post('/pin/set', limiter, run((b) => service.setPin({ setupToken: text(b.setupToken, 2000), pin: text(b.pin, 12) })));

module.exports = router;
