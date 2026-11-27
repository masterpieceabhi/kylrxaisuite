/**
 * Sign-in by scanning a personal, one-time QR. The rules are in services/qr-signin.js.
 *
 * For the person scanning (public, mounted at /api/auth; see server.js):
 *   POST /api/auth/pin/qr/open     { qr }                ->  { name, emailHint, company, expiresAt, hasPin }   nothing is used up
 *   POST /api/auth/pin/qr/confirm  { qr }                ->  { next: 'signed_in', token, hasPin, setupToken }  the QR never works again
 *   POST /api/auth/pin/qr/set      { setupToken, pin }   ->  { saved: true }
 * `token` is a Firebase custom token, exactly as after a PIN sign-in: the page hands it to Firebase.
 * These live under /api/auth/pin on purpose: the cookie that marks a known device (`onnhr_device`, set by the PIN
 * sign-in for that path) is then sent here too, so a QR sign-in and a PIN sign-in remember the same device.
 * `qr` is sent in the body, never in the address, so it does not end up in logs or browser history. The page should
 * carry it after the `#` of the link it puts in the QR (for example /login.html#qr=...), which browsers do not send.
 *
 * For whoever hands the QR out (signed in, mounted with the other /api/us people routes; `staff` below):
 *   POST   /api/us/people/:id/signin-qr   { hours? }  ->  { qr, path, expiresAt, person }   HR or the owner, for someone they may manage
 *   DELETE /api/us/people/:id/signin-qr               ->  { cancelled }
 *   POST   /api/us/me/signin-qr           { hours? }  ->  the same, for yourself: to open another device you hold
 * The secret is in that one answer only. The server keeps a hash and cannot show it again.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { admin, rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const qrSignin = require('../services/qr-signin');
const localDemo = require('../services/local-demo');
const notices = require('../services/notices');

const LINKS = 'signin_qr_links';
const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const inactive = (status) => /^(terminated|inactive|offboarded|suspended|locked)$/i.test(String(status || 'Active'));

/* ------------------------------- storage ------------------------------- */

const links = {
    async put(id, doc) { await rawCollection(LINKS).doc(id).set(doc); },
    async get(id) { const s = await rawCollection(LINKS).doc(id).get(); return exists(s) ? s.data() : null; },
    /** Used up exactly once: read and write in one transaction, so two confirms at the same moment cannot both win */
    async use(id, patch) {
        const ref = rawCollection(LINKS).doc(id);
        return admin.firestore().runTransaction(async (tx) => {
            const s = await tx.get(ref);
            if (!exists(s) || s.data().usedAt || s.data().cancelledAt) return false;
            tx.update(ref, patch);
            return true;
        });
    },
    /** One field, one range: no extra index needed. Each link carries expiresAt, so this finds used and cancelled ones too. */
    async removeExpiredBefore(iso, max) {
        const snap = await rawCollection(LINKS).where('expiresAt', '<', iso).limit(max).get();
        await Promise.all((snap.docs || []).map((d) => d.ref.delete()));
        return (snap.docs || []).length;
    },
    async cancelOpen(uid, patch) {
        const snap = await rawCollection(LINKS).where('uid', '==', uid).get();
        const open = (snap.docs || []).filter((d) => !d.data().usedAt && !d.data().cancelledAt);
        await Promise.all(open.map((d) => d.ref.update(patch)));
        return open.length;
    }
};

async function loadPerson(uid) {
    const s = await rawCollection('users').doc(String(uid)).get();
    if (!exists(s)) return null;
    const d = s.data();
    if (!d.orgId) return null;
    let companyName = null;
    try { const o = await rawCollection('organizations').doc(d.orgId).get(); if (exists(o)) { const x = o.data(); companyName = x.displayName || x.Display_Name || x.legalName || x.Legal_Name || null; } } catch (_) { /* the name is a nicety */ }
    return { uid: s.id, orgId: d.orgId, name: d.name || null, email: d.email || null, active: !inactive(d.status), pinHash: d.pinHash || null, signinDevices: Array.isArray(d.signinDevices) ? d.signinDevices : [], companyName };
}
const savePerson = (uid, patch) => rawCollection('users').doc(String(uid)).update(patch);

const service = qrSignin.create({ links, loadPerson, savePerson, mintToken: require('../services/sso').guardMint((uid) => admin.auth().createCustomToken(uid)), secret: process.env.JWT_SECRET });

/* ------------------------------- shared helpers ------------------------------- */

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const COOKIE = 'onnhr_device'; // the same cookie, path and lifetime as routes/pin-signin.js: one known device, two ways in
const deviceOf = (req) => { const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([a-f0-9]{64})(?:;|$)').exec(String(req.headers.cookie || '')); return m ? m[1] : ''; };
const remember = (res, token) => res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', path: '/api/auth/pin', maxAge: 365 * 86400000 });
function answer(res, e, what) {
    if (e && e.status) return res.status(e.status).json({ success: false, code: e.code, error: e.message });
    logger.error(`[QrSignin] ${what}: ${e && e.message}`);
    return res.status(500).json({ success: false, code: 'failed', error: 'Sign-in is not working right now. Try again in a minute.' });
}
/** Audit for a request that has no signed-in user yet: the person the QR belongs to is the actor */
function auditAs(orgId, uid, req, action, extra = {}) {
    try { return require('../services/audit-chain').writeAudit(orgId, { action, targetId: uid, actorId: uid, actorRole: null, at: new Date().toISOString(), ip: req.ip || null, ...extra }).catch((e) => logger.error(`Audit write failed: ${e.message}`)); } catch (e) { logger.error(`Audit write failed: ${e.message}`); return null; }
}

/* ------------------------------- for the person scanning (public) ------------------------------- */

const router = express.Router();
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: localDemo.relaxedLimit(process.env, 30), message: { success: false, code: 'slow_down', error: 'Too many tries. Wait a few minutes, then try again.' } });

router.post('/pin/qr/open', limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json({ success: true, ...(await service.open({ secret: text((req.body || {}).qr, 100) })) }); } catch (e) { answer(res, e, 'open'); }
});

router.post('/pin/qr/confirm', limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { deviceToken, uid, orgId, madeBy, forSelf, ...out } = await service.confirm({ secret: text((req.body || {}).qr, 100), deviceToken: deviceOf(req) });
        remember(res, deviceToken);
        auditAs(orgId, uid, req, 'signin_qr_used', { madeBy, forSelf });
        // The person is told every time, in their own notices: a QR made for them by someone else could be scanned by that someone.
        notices.notify(orgId, uid, 'signin_qr_used', 'A one-time QR was used to sign in as you',
            forSelf ? 'The one-time QR you made was used to sign in on another device. If that was not you, choose a new PIN and tell the owner.'
                : 'A one-time sign-in QR that was made for you has just been used. If that was not you, tell the owner straight away and choose a new PIN.');
        res.json({ success: true, ...out });
    } catch (e) { answer(res, e, 'confirm'); }
});

router.post('/pin/qr/set', limiter, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const { uid, orgId, ...out } = await service.setPin({ setupToken: text((req.body || {}).setupToken, 2000), pin: text((req.body || {}).pin, 12) });
        auditAs(orgId, uid, req, 'signin_pin_set', { after: 'qr' });
        res.json({ success: true, ...out });
    } catch (e) { answer(res, e, 'set pin'); }
});

/* ------------------------------- for whoever hands the QR out (signed in) ------------------------------- */

const staff = express.Router();
// Loaded when first used: routes/us-hr.js is still loading when this file is first required from it.
const hr = () => require('./us-hr').helpers;
const usOrg = (req, res, next) => hr().requireUsOrg(req, res, next);
const made = (out) => ({ qr: out.secret, path: `/login.html#qr=${out.secret}`, expiresAt: out.expiresAt, hours: out.hours, person: out.person, shownOnce: true });

staff.post('/me/signin-qr', usOrg, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        // for yourself only a short one: it is for the phone in your other hand, not for a drawer
        const hours = Math.min(Number((req.body || {}).hours) || 1, 1);
        const out = await service.createLink({ uid: req.user.id, actorId: req.user.id, hours });
        hr().audit(req.orgId, req, 'signin_qr_created', req.user.id, { forSelf: true, expiresAt: out.expiresAt });
        res.status(201).json({ success: true, ...made(out) });
    } catch (e) { answer(res, e, 'create for self'); }
});

async function target(req, res) {
    const L = require('../services/access-link-rules');
    if (!require('../services/permissions').can(req.user, 'people.write')) { res.status(403).json({ success: false, error: 'You do not have permission to do this' }); return null; }
    const emp = await hr().findEmployee(req.orgId, req.params.id);
    if (!emp) { res.status(404).json({ success: false, error: 'Employee not found' }); return null; }
    if (emp.ref.parent.id !== 'users' || !emp.data.email) { res.status(409).json({ success: false, error: 'This person has no sign-in yet. Add them with their email first.' }); return null; }
    // the same rule as giving someone a new password: never for someone with a higher role, never for yourself here
    const may = L.mayResetAccess(req.user, { ...emp.data, id: emp.id });
    if (!may.ok) { res.status(may.status).json({ success: false, error: emp.id === req.user.id ? 'Use "a QR for myself" to open another device of your own.' : may.error }); return null; }
    return emp;
}

staff.post('/people/:id/signin-qr', usOrg, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const emp = await target(req, res); if (!emp) return undefined;
        const out = await service.createLink({ uid: emp.id, actorId: req.user.id, hours: (req.body || {}).hours });
        hr().audit(req.orgId, req, 'signin_qr_created', emp.id, { targetRole: emp.data.role || null, expiresAt: out.expiresAt });
        notices.notify(req.orgId, emp.id, 'signin_qr_created', 'A sign-in QR was made for you',
            `${req.user.name || 'Someone who manages your account'} made a one-time QR that signs in as you. It works once and runs out in ${out.hours} hour${out.hours === 1 ? '' : 's'}. If you did not ask for it, tell the owner.`, { madeBy: req.user.id });
        return res.status(201).json({ success: true, ...made(out) });
    } catch (e) { return answer(res, e, 'create'); }
});

staff.delete('/people/:id/signin-qr', usOrg, async (req, res) => {
    try {
        const emp = await target(req, res); if (!emp) return undefined;
        const out = await service.cancel({ uid: emp.id, actorId: req.user.id });
        hr().audit(req.orgId, req, 'signin_qr_cancelled', emp.id, { cancelled: out.cancelled });
        return res.json({ success: true, ...out });
    } catch (e) { return answer(res, e, 'cancel'); }
});

module.exports = router;
module.exports.staff = staff;
module.exports.LINKS = LINKS;
