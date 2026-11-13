const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requirePermission } = require('../services/permissions');
const sso = require('../services/sso');

const discoverLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { success: false, error: 'Too many requests' } });

/** Public: does this email sign in with company single sign-on? Only the provider id and whether it is required are returned. */
router.get('/discover', discoverLimiter, async (req, res) => {
    const found = await sso.discover(req.query.email);
    if (!found) return res.json({ success: true, sso: false });
    res.json({ success: true, sso: true, providerId: found.providerId, enforce: found.enforce });
});

router.use(verifyToken);

const orgIdOf = (req) => req.user.orgId || req.tenantOrgId || null;
const exists = (s) => (typeof s.exists === 'function' ? s.exists() : s.exists);

router.get('/settings', requirePermission('security.manage'), async (req, res) => {
    const orgId = orgIdOf(req);
    if (!orgId) return res.status(404).json({ success: false, error: 'No organization for this user' });
    const snap = await rawCollection('organizations').doc(orgId).get();
    res.json({ success: true, settings: (exists(snap) && snap.data().ssoSettings) || { enabled: false, enforce: false, allowedDomains: [], breakGlassEmails: [] },
        note: 'Create the OIDC or SAML provider in Firebase Authentication (Identity Platform) first, then enter its provider id here.' });
});

router.put('/settings', requirePermission('security.manage'), async (req, res) => {
    const orgId = orgIdOf(req);
    if (!orgId) return res.status(404).json({ success: false, error: 'No organization for this user' });
    const { errors, value } = sso.validateSettings(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    // A domain can only belong to one company
    for (const domain of value.allowedDomains) {
        const other = await rawCollection('organizations').where('ssoSettings.allowedDomains', 'array-contains', domain).limit(3).get();
        if (other.docs.some((d) => d.id !== orgId)) return res.status(409).json({ success: false, error: `${domain} is already used by another company` });
    }
    // The person turning enforcement on must be able to keep signing in
    const me = String(req.user.email || '').toLowerCase();
    if (value.enforce && me && !value.breakGlassEmails.includes(me)) value.breakGlassEmails.push(me);
    await rawCollection('organizations').doc(orgId).set({ ssoSettings: { ...value, updatedAt: new Date().toISOString(), updatedBy: req.user.id } }, { merge: true });
    rawCollection('organizations').doc(orgId).collection('audit_logs').add({ action: 'sso_settings_updated', targetId: orgId, actorId: req.user.id, at: new Date().toISOString(), enabled: value.enabled, enforce: value.enforce }).catch(() => {});
    res.json({ success: true, settings: value });
});

module.exports = router;
