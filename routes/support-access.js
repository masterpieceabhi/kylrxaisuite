const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requirePermission } = require('../services/permissions');

/**
 * Vendor support access, with the customer's consent.
 *   - A customer owner (super_admin) grants support staff read-only access for 1-72 hours, with a reason.
 *   - A support person (email listed in PLATFORM_SUPPORT_EMAILS) trades a valid grant for a short-lived,
 *     read-only token for that company. GET requests only; every request is logged to the company's audit log.
 *   - The customer can revoke at any time; the token stops working at once because the grant is checked on every request.
 */
const MAX_HOURS = 72;
const exists = (s) => (typeof s.exists === 'function' ? s.exists() : s.exists);
const supportEmails = () => String(process.env.PLATFORM_SUPPORT_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
const orgIdOf = (req) => req.user.orgId || req.tenantOrgId || null;

router.use(verifyToken);

router.post('/grants', requirePermission('support.impersonate'), async (req, res) => {
    const orgId = orgIdOf(req);
    const hours = Number(req.body && req.body.hours);
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!orgId) return res.status(404).json({ success: false, error: 'No organization for this user' });
    if (!(hours >= 1 && hours <= MAX_HOURS)) return res.status(400).json({ success: false, error: `hours must be between 1 and ${MAX_HOURS}` });
    if (reason.length < 5) return res.status(400).json({ success: false, error: 'Say why support needs access (at least 5 characters)' });
    const grant = { orgId, grantedBy: req.user.id, grantedByEmail: req.user.email || null, reason: reason.slice(0, 300), mode: 'read_only', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + hours * 3600000).toISOString(), revokedAt: null };
    const ref = await rawCollection('support_grants').add(grant);
    rawCollection('organizations').doc(orgId).collection('audit_logs').add({ action: 'support_access_granted', targetId: ref.id, actorId: req.user.id, at: grant.createdAt, hours, reason: grant.reason }).catch(() => {});
    res.status(201).json({ success: true, grant: { id: ref.id, ...grant } });
});

router.get('/grants', requirePermission('support.impersonate'), async (req, res) => {
    const orgId = orgIdOf(req);
    const snap = await rawCollection('support_grants').where('orgId', '==', orgId).get();
    const now = new Date().toISOString();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).map((g) => ({ ...g, active: !g.revokedAt && g.expiresAt > now })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, data: rows.slice(0, 100) });
});

router.delete('/grants/:id', requirePermission('support.impersonate'), async (req, res) => {
    const ref = rawCollection('support_grants').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== orgIdOf(req)) return res.status(404).json({ success: false, error: 'Grant not found' });
    await ref.update({ revokedAt: new Date().toISOString(), revokedBy: req.user.id });
    rawCollection('organizations').doc(orgIdOf(req)).collection('audit_logs').add({ action: 'support_access_revoked', targetId: req.params.id, actorId: req.user.id, at: new Date().toISOString() }).catch(() => {});
    res.json({ success: true });
});

/** Support staff only: exchange an active grant for a read-only token */
router.post('/session', async (req, res) => {
    const email = String(req.user.email || '').toLowerCase();
    if (!email || !supportEmails().includes(email)) return res.status(403).json({ success: false, error: 'Not allowed' });
    const snap = await rawCollection('support_grants').doc(String((req.body && req.body.grantId) || '_')).get();
    if (!exists(snap)) return res.status(404).json({ success: false, error: 'Grant not found' });
    const g = snap.data();
    if (g.revokedAt || g.expiresAt <= new Date().toISOString()) return res.status(403).json({ success: false, error: 'This grant is no longer active' });
    const secondsLeft = Math.floor((new Date(g.expiresAt) - Date.now()) / 1000);
    const token = jwt.sign({ type: 'support_session', id: `support:${email}`, email, orgId: g.orgId, grantId: snap.id }, process.env.JWT_SECRET, { expiresIn: Math.min(3600, secondsLeft) });
    rawCollection('organizations').doc(g.orgId).collection('audit_logs').add({ action: 'support_session_started', targetId: snap.id, actorId: `support:${email}`, at: new Date().toISOString() }).catch(() => {});
    res.json({ success: true, token, orgId: g.orgId, readOnly: true, expiresInSeconds: Math.min(3600, secondsLeft) });
});

module.exports = router;
