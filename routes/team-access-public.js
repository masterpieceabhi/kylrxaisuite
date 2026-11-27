/**
 * Sign-in set-up for new people (mounted from routes/auth.js, so the paths start with /api/auth).
 *
 *   No sign-in needed (the link is the key; all rate limited per address):
 *     POST /team/setup/info      { token }             who the personal set-up link is for
 *     POST /team/setup/complete  { token, pin }        the person chooses their PIN; the link is used up and they are signed in
 *                                { token, password }   the older form, kept for callers that still send a password
 *     POST /team/join/info       { token }             which company the join link belongs to
 *     POST /team/join/request    { token, firstName, lastName, email, phone }   ask to join; HR must approve. No password is
 *                                asked for: once approved the person signs in with a code and chooses a PIN.
 *   Signed in:
 *     GET  /password-status      does this person still have a temporary password?
 *     POST /change-password      { currentPassword, newPassword }
 *
 * Tokens travel in the request body, never in the address, so they do not end up in access logs. The pages keep the
 * token after the # of their own address for the same reason. No email is sent anywhere: HR hands the link over.
 * Answers never say whether an email address already has an account.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const logger = require('../utils/logger');
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { resolveCountryCode } = require('../country-config');
const auditChain = require('../services/audit-chain');
const svc = require('../services/us-people-service');
const L = require('../services/access-link-rules');

const WINDOW_MS = 15 * 60 * 1000;
const limit = (max, message) => rateLimit({ windowMs: WINDOW_MS, max: require('../services/local-demo').relaxedLimit(process.env, max), standardHeaders: true, legacyHeaders: false, message: { success: false, error: message } });
const lookLimiter = limit(120, 'Too many tries. Wait 15 minutes and try again.');
const actLimiter = limit(30, 'Too many tries. Wait 15 minutes and try again.');
const passwordLimiter = limit(30, 'Too many tries. Wait 15 minutes and try again.');

const DEAD_LINK = 'This link does not work any more. Ask your employer for a new one.';
const noStore = (res) => res.set('Cache-Control', 'no-store');
const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);

/** Audit entry for something a person did without being signed in (or to their own account). Never throws. */
function auditFor(orgId, req, action, actorId, extra = {}) {
    if (!orgId) return;
    try {
        auditChain.writeAudit(orgId, { action, targetId: actorId || null, actorId: actorId || null, actorRole: 'self', at: new Date().toISOString(), ip: req.ip || null, ...extra })
            .catch((e) => logger.error(`Audit write failed: ${e.message}`));
    } catch (e) { logger.error(`Audit write failed: ${e.message}`); }
}

async function isUsOrg(orgId) {
    if (!orgId) return false;
    try {
        const snap = await rawCollection('organizations').doc(orgId).get();
        const o = exists(snap) ? snap.data() : {};
        return resolveCountryCode(o.country || o.Country) === 'US';
    } catch (_) { return false; }
}

// --------------------------------------------------------------------------------------------- personal set-up link

router.post('/team/setup/info', lookLimiter, async (req, res) => {
    noStore(res);
    const found = await svc.setupInfo(req.body && req.body.token);
    if (!found) return res.status(404).json({ success: false, error: DEAD_LINK });
    res.json({ success: true, ...found.info, passwordRules: L.PASSWORD_RULES_TEXT });
});

router.post('/team/setup/complete', actLimiter, async (req, res) => {
    noStore(res);
    const b = req.body || {};
    if (typeof b.pin === 'string' && b.pin) {
        const p = await svc.completeSetupWithPin(b.token, b.pin.slice(0, 12));
        if (!p.ok) return res.status(p.status).json({ success: false, error: p.status === 404 ? DEAD_LINK : p.error });
        auditFor(p.orgId, req, 'us_setup_link_used', p.uid);
        // the page takes deviceGrant to /api/auth/pin/remember, where the device cookie lives
        return res.json({ success: true, email: p.email, next: 'us-onboarding.html', token: p.signinToken, deviceGrant: p.deviceGrant });
    }
    const r = await svc.completeSetup(b.token, typeof b.password === 'string' ? b.password : '');
    if (!r.ok) return res.status(r.status).json({ success: false, error: r.status === 404 ? DEAD_LINK : r.error });
    auditFor(r.orgId, req, 'us_setup_link_used', r.uid);
    res.json({ success: true, email: r.email, next: 'us-onboarding.html' });
});

// ---------------------------------------------------------------------------------------------- company join link

router.post('/team/join/info', lookLimiter, async (req, res) => {
    noStore(res);
    const found = await svc.joinInfo(req.body && req.body.token);
    if (!found) return res.status(404).json({ success: false, error: DEAD_LINK });
    res.json({ success: true, ...found.info, passwordRules: L.PASSWORD_RULES_TEXT });
});

router.post('/team/join/request', actLimiter, async (req, res) => {
    noStore(res);
    const b = req.body || {};
    const linkInfo = await svc.joinInfo(b.token);
    if (!linkInfo) return res.status(404).json({ success: false, error: DEAD_LINK });
    const { errors, value } = L.validateJoinRequest(b);
    // A password is no longer asked for. One that is sent is still checked; without one the account gets a password
    // nobody knows, and the person signs in with a code and chooses a PIN once they are approved.
    const sentPassword = typeof b.password === 'string' && b.password !== '';
    const problem = sentPassword ? L.passwordProblem(b.password, { email: value.email }) : null;
    if (problem) errors.push(problem);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const r = await svc.submitJoinRequest(b.token, value, sentPassword ? b.password : svc.unknownPassword(), req.ip);
    if (!r.ok) return res.status(r.status).json({ success: false, error: r.status === 404 ? DEAD_LINK : r.error });
    const Mail = require('../services/team-invite-emails');
    if (r.created) {
        auditFor(r.orgId, req, 'us_join_request_received', r.requestId);
        // Not awaited: the answer must take the same time whether or not a request was stored
        if (r.approved) {
            auditFor(r.orgId, req, 'us_join_open_link_joined', r.person && r.person.uid, { requestId: r.requestId, employeeId: r.person && r.person.employeeId });
            Mail.sendApproved(r.orgId, { name: `${value.firstName} ${value.lastName}`, email: value.email, open: true }).catch(() => {});
        } else Mail.notifyJoinRequest(r.orgId, `${value.firstName} ${value.lastName}`).catch(() => {});
    }
    // The same answer whether or not a request was stored (an email that already has an account stores nothing): on an
    // open link with places left it is "ready" (they sign in with their email and a code), otherwise "waiting".
    // (Letting someone in takes a little longer than storing nothing; open links last a few hours at most.)
    const ready = r.created ? r.approved === true : linkInfo.info.open === true;
    res.status(202).json({ success: true, status: ready ? 'ready' : 'waiting_for_approval' });
});

// ---------------------------------------------------------------------------------------------- signed-in person

/** Does the signed-in person still have a temporary password? (One of the two paths verifyToken lets them reach.) */
router.get('/password-status', verifyToken, (req, res) => {
    noStore(res);
    res.json({ success: true, mustChangePassword: req.user.must_change_password === true, email: req.user.email || null, passwordRules: L.PASSWORD_RULES_TEXT });
});

/** The signed-in person chooses a new password. Their other sessions end; the page signs in again with the new one. */
router.post('/change-password', passwordLimiter, verifyToken, async (req, res) => {
    noStore(res);
    if (req.user.support) return res.status(403).json({ success: false, error: 'Support access is read-only' });
    const b = req.body || {};
    const r = await svc.changeOwnPassword(req.user.id, typeof b.currentPassword === 'string' ? b.currentPassword : '', typeof b.newPassword === 'string' ? b.newPassword : '');
    if (!r.ok) return res.status(r.status).json({ success: false, error: r.error });
    auditFor(r.orgId, req, 'password_changed', req.user.id, { wasTemporary: r.wasTemporary });
    res.json({ success: true, email: r.email, next: (await isUsOrg(r.orgId)) ? 'us-onboarding.html' : 'login.html' });
});

module.exports = router;
