/**
 * Setting up an authenticator app for your own sign-in. Mounted with the other "me" routes (routes/us-roles.js),
 * so everything here is for the signed-in person and their own record. The rules are in services/authenticator.js.
 *
 *   GET    /api/us/me/authenticator            { enabled, since, lastUsedAt }
 *   POST   /api/us/me/authenticator/start      { secret, otpauthUrl, minutes }   shown once; draw otpauthUrl as a QR
 *   POST   /api/us/me/authenticator/confirm    { code }  ->  { enabled: true }   the code the app shows now
 *   DELETE /api/us/me/authenticator            { code }  ->  { enabled: false }
 *   DELETE /api/us/people/:id/authenticator              ->  { enabled: false }  HR or the owner, when a phone is lost
 *
 * Signing in with the app: POST /api/auth/pin/send { challenge, via: "app" }, then /pin/code with the app's code.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const authenticator = require('../services/authenticator');
const notices = require('../services/notices');

const router = express.Router();
const hr = () => require('./us-hr').helpers; // loaded when first used: us-hr is still loading when this file is required
const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);

// wrong codes are also counted on the person's record; this keeps one signed-in session from hammering the routes
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyGenerator: (req) => `totp:${(req.user && req.user.id) || rateLimit.ipKeyGenerator(req.ip || '')}`, message: { success: false, code: 'slow_down', error: 'Too many tries. Wait a few minutes.' } });

async function me(req, res) {
    const snap = await rawCollection('users').doc(String(req.user.id)).get();
    if (!exists(snap) || !snap.data().orgId || snap.data().orgId !== req.user.orgId) { res.status(404).json({ success: false, error: 'Your record was not found' }); return null; }
    return { uid: snap.id, orgId: snap.data().orgId, email: snap.data().email || req.user.email || null, totp: snap.data().totp };
}
const audit = (req, orgId, action, targetId, extra = {}) => { try { hr().audit(orgId, req, action, targetId, extra); } catch (_) { /* never fail the request over the log */ } };
function answer(res, e) {
    if (e && e.status) return res.status(e.status).json({ success: false, code: e.code, error: e.message });
    logger.error(`[Authenticator] ${e && e.message}`);
    return res.status(500).json({ success: false, code: 'failed', error: 'That did not work. Try again in a minute.' });
}

router.get('/me/authenticator', async (req, res) => {
    try { const p = await me(req, res); if (!p) return undefined; res.set('Cache-Control', 'no-store'); return res.json({ success: true, ...authenticator.service().statusOf(p) }); } catch (e) { return answer(res, e); }
});

router.post('/me/authenticator/start', limiter, async (req, res) => {
    try {
        const p = await me(req, res); if (!p) return undefined;
        const out = await authenticator.service().begin(p);
        audit(req, p.orgId, 'authenticator_setup_started', p.uid);
        res.set('Cache-Control', 'no-store');
        return res.status(201).json({ success: true, ...out });
    } catch (e) { return answer(res, e); }
});

router.post('/me/authenticator/confirm', limiter, async (req, res) => {
    try {
        const p = await me(req, res); if (!p) return undefined;
        const out = await authenticator.service().confirm(p, String((req.body && req.body.code) || '').slice(0, 12));
        audit(req, p.orgId, 'authenticator_enabled', p.uid);
        notices.notify(p.orgId, p.uid, 'authenticator_enabled', 'Authenticator app set up', 'An authenticator app can now be used to sign in as you. If you did not set this up, tell the owner straight away.');
        return res.json({ success: true, ...out });
    } catch (e) { return answer(res, e); }
});

router.delete('/me/authenticator', limiter, async (req, res) => {
    try {
        const p = await me(req, res); if (!p) return undefined;
        const was = authenticator.service().statusOf(p).enabled;
        const out = await authenticator.service().remove(p, String((req.body && req.body.code) || '').slice(0, 12));
        if (was) { audit(req, p.orgId, 'authenticator_removed', p.uid, { by: 'self' }); notices.notify(p.orgId, p.uid, 'authenticator_removed', 'Authenticator app removed', 'The authenticator app was removed from your sign-in.'); }
        return res.json({ success: true, ...out });
    } catch (e) { return answer(res, e); }
});

// A lost phone: someone who may reset this person's sign-in switches the app off. Never for someone with a higher
// role, never for yourself here (your own goes through the route above, with a code).
router.delete('/people/:id/authenticator', async (req, res) => {
    try {
        if (!require('../services/permissions').can(req.user, 'people.write')) return res.status(403).json({ success: false, error: 'You do not have permission to do this' });
        const emp = await hr().findEmployee(req.user.orgId, req.params.id);
        if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
        const may = require('../services/access-link-rules').mayResetAccess(req.user, { ...emp.data, id: emp.id });
        if (!may.ok) return res.status(may.status).json({ success: false, error: may.error });
        const out = await authenticator.service().removeFor({ uid: emp.id, totp: emp.data.totp });
        if (out.wasEnabled) {
            audit(req, req.user.orgId, 'authenticator_removed', emp.id, { by: 'staff', targetRole: emp.data.role || null });
            notices.notify(req.user.orgId, emp.id, 'authenticator_removed', 'Authenticator app removed', `${req.user.name || 'Someone who manages your account'} removed the authenticator app from your sign-in. You can set one up again.`);
        }
        return res.json({ success: true, enabled: false });
    } catch (e) { return answer(res, e); }
});

module.exports = router;
