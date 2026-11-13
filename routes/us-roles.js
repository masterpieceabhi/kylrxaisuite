const express = require('express');
const router = express.Router();
const { admin, rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { requireUsOrg, audit } = require('./us-hr').helpers;
const { requirePermission, canonicalRole, permissionsFor, ROLE_LABELS, PERMISSIONS } = require('../services/permissions');
const store = require('../services/people-data-store');


const ROLES = Object.keys(ROLE_LABELS);
const DESCRIPTIONS = {
    super_admin: 'Owner: everything, including billing, integrations and security settings',
    hr_admin: 'People, hiring, leave, compliance and reports (no billing or integrations)',
    payroll_admin: 'Time approval, hours export, payroll provider and payroll reports (no HR records or SSNs)',
    manager: 'Own direct reports only: time, leave and team data',
    employee: 'Own information only',
    accountant: 'Read-only finance: payroll, labor cost, hours export and reports',
    auditor: 'Read-only everything except confidential files and full taxpayer IDs',
    executive: 'Read-only company reports'
};

/** Any signed-in user: their own role and effective permissions (the front end uses this to show or hide controls) */
router.get('/me/permissions', (req, res) => {
    const role = canonicalRole(req.user.role);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, userId: req.user.id, orgId: req.user.orgId || null, role, roleLabel: ROLE_LABELS[role], permissions: permissionsFor(role) });
});

/** The role catalog with what each role can do (owner only) */
router.get('/roles', requirePermission('security.manage'), requireUsOrg, async (req, res) => {
    const users = await store.listByOrg('users', req.orgId);
    const counts = {};
    users.filter(store.isActivePerson).forEach((u) => { const r = canonicalRole(u.role); counts[r] = (counts[r] || 0) + 1; });
    res.json({
        success: true,
        allPermissions: Object.keys(PERMISSIONS),
        roles: ROLES.map((r) => ({ role: r, label: ROLE_LABELS[r], description: DESCRIPTIONS[r], permissions: permissionsFor(r), userCount: counts[r] || 0 }))
    });
});

/** Everyone who can sign in, with their role */
router.get('/roles/users', requirePermission('security.manage'), requireUsOrg, async (req, res) => {
    const users = await store.listByOrg('users', req.orgId);
    res.json({
        success: true,
        data: users.filter((u) => u.employeeId || u.email).map((u) => ({
            id: u.id, employeeId: u.employeeId || null, name: u.name || u.email || u.id, email: u.email || null, status: u.status || 'active',
            role: canonicalRole(u.role), roleLabel: ROLE_LABELS[canonicalRole(u.role)]
        })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    });
});

/** What a role would be able to do (preview before assigning) */
router.get('/roles/:role/permissions', requirePermission('security.manage'), (req, res) => {
    if (!ROLES.includes(req.params.role)) return res.status(404).json({ success: false, error: 'Unknown role' });
    res.json({ success: true, role: req.params.role, permissions: permissionsFor(req.params.role) });
});

router.put('/roles/users/:id', requirePermission('security.manage'), requireUsOrg, async (req, res) => {
    const newRole = String((req.body && req.body.role) || '');
    if (!ROLES.includes(newRole)) return res.status(400).json({ success: false, errors: [`role must be one of: ${ROLES.join(', ')}`] });
    const target = await store.getOwned('users', req.orgId, req.params.id);
    if (!target) return res.status(404).json({ success: false, error: 'No sign-in account with that id in this company' });
    if (target.id === req.user.id) return res.status(403).json({ success: false, error: 'You cannot change your own role. Ask another super admin.' });
    const oldRole = canonicalRole(target.role);
    if (oldRole === newRole) return res.json({ success: true, unchanged: true, userId: target.id, role: newRole });

    if (oldRole === 'super_admin') {
        const users = await store.listByOrg('users', req.orgId);
        const others = users.filter((u) => u.id !== target.id && store.isActivePerson(u) && canonicalRole(u.role) === 'super_admin');
        if (!others.length) return res.status(409).json({ success: false, error: 'This is the last super admin. Make someone else a super admin first.' });
    }
    if (!store.isActivePerson(target) && newRole === 'super_admin') return res.status(409).json({ success: false, error: 'An inactive account cannot become a super admin' });

    // Sign-in claims first (they win over the profile at sign-in), then the profile; undo the claims if the profile write fails
    let previousClaims = null; let claimsDone = false;
    try {
        const user = await admin.auth().getUser(target.id);
        previousClaims = user.customClaims || {};
        const claims = { ...previousClaims, role: newRole, orgId: req.orgId };
        if (newRole === 'super_admin') claims.super_admin = true; else delete claims.super_admin; // a demoted owner must not keep the owner claim
        await admin.auth().setCustomUserClaims(target.id, claims);
        claimsDone = true;
    } catch (e) {
        if (e && e.code === 'auth/user-not-found') return res.status(409).json({ success: false, error: 'This person has no sign-in account yet' });
        logger.error(`Role claims update failed for ${target.id}: ${e.message}`);
        return res.status(502).json({ success: false, error: 'Could not update the sign-in account. Nothing was changed.' });
    }
    try {
        await rawCollection('users').doc(target.id).set({ role: newRole, roleUpdatedAt: new Date().toISOString(), roleUpdatedBy: req.user.id || null }, { merge: true });
    } catch (e) {
        if (claimsDone) await admin.auth().setCustomUserClaims(target.id, previousClaims).catch(() => {});
        logger.error(`Role profile update failed for ${target.id}: ${e.message}`);
        return res.status(500).json({ success: false, error: 'Could not save the role. Nothing was changed.' });
    }
    // Existing refresh tokens stop working, so the old role does not linger
    await admin.auth().revokeRefreshTokens(target.id).catch((e) => logger.warn(`revokeRefreshTokens failed: ${e.message}`));
    await audit(req.orgId, req, 'role_changed', target.id, { from: oldRole, to: newRole });
    res.json({ success: true, userId: target.id, role: newRole, previousRole: oldRole, permissions: permissionsFor(newRole), note: 'The change reaches an open session within about 15 minutes, or at the next sign-in.' });
});

module.exports = router;
