const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/authMiddleware');
const { can, requirePermission, requireAnyPermission } = require('../services/permissions');
const { resolveCountryCode } = require('../country-config');
const { encryptField, decryptField } = require('../services/pii-crypto');
const auditChain = require('../services/audit-chain');
const {
    validateEmployeeProfile, validateCompanyProfile, validateTaxpayerId, maskTaxpayerId
} = require('../services/us-validation');

// Who may do what on these routes (services/permissions.js decides which roles hold each permission):
//   read the company profile (EIN, entity, industry, fiscal year)   org.settings or payroll.view
//   change the company profile                                       org.settings
//   list people / read a person's US profile                         people.read (a person always sees their own)
//   change a person's US profile                                     people.write
//   see a full SSN or ITIN                                           pii.reveal
const COMPANY_READ = requireAnyPermission('org.settings', 'payroll.view');
const COMPANY_WRITE = requirePermission('org.settings');
const PEOPLE_READ = requirePermission('people.read');
const PEOPLE_WRITE = requirePermission('people.write');
const PII_REVEAL = requirePermission('pii.reveal');

/** A person's US profile: themselves, or anyone who holds people.read */
function canSeeProfile(user, emp) {
    if (!user || !emp) return false;
    const isSelf = Boolean(user.id) && [emp.id, emp.data && emp.data.uid, emp.data && emp.data.userId].filter(Boolean).includes(user.id);
    return isSelf || can(user, 'people.read');
}

router.use(verifyToken);

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);

function orgIdOf(req) {
    return req.user.orgId || req.tenantOrgId || null;
}

/** Loads the caller's organization and refuses anything that is not a US company. */
async function requireUsOrg(req, res, next) {
    const orgId = orgIdOf(req);
    if (!orgId) return res.status(404).json({ success: false, error: 'No organization for this user' });
    try {
        const snap = await rawCollection('organizations').doc(orgId).get();
        const data = exists(snap) ? snap.data() : {};
        if (resolveCountryCode(data.country || data.Country) !== 'US') {
            return res.status(409).json({ success: false, error: 'This organization is not a US company' });
        }
        req.orgId = orgId;
        req.org = data;
        next();
    } catch (error) {
        logger.error(`US org lookup failed: ${error.message}`);
        res.status(500).json({ success: false, error: 'Could not load organization' });
    }
}

/** Finds an employee by document id or employeeId and checks it belongs to the caller's company. */
// People created through the admin API are stored in `users` (document id = login uid); records
// from the onboarding roster are stored in `employees`.
const PEOPLE_COLLECTIONS = ['users', 'employees'];

async function findEmployee(orgId, id) {
    for (const name of PEOPLE_COLLECTIONS) {
        let ref = db.collection(name).doc(id);
        let snap = await ref.get();
        if (!exists(snap)) {
            const q = await db.collection(name).where('employeeId', '==', id).limit(1).get();
            if (q.empty) continue;
            snap = q.docs[0];
            ref = snap.ref;
        }
        const data = snap.data();
        if (data.orgId !== orgId) continue;
        return { ref, id: snap.id, data };
    }
    return null;
}

/**
 * The audit writer for every US route. Each entry joins the tamper-evident chain (services/audit-chain.js); if the chain
 * cannot be written the entry is still saved without one. This never throws and never fails the request.
 */
function audit(orgId, req, action, targetId, extra = {}) {
    try {
        return auditChain.writeAudit(orgId, {
            action,
            targetId: targetId === undefined ? null : targetId,
            actorId: req.user.id || req.user.uid || null,
            actorRole: req.user.role || null,
            at: new Date().toISOString(),
            ip: req.ip || null,
            ...extra
        }).catch((e) => logger.error(`Audit write failed: ${e.message}`));
    } catch (e) {
        logger.error(`Audit write failed: ${e.message}`);
        return Promise.resolve();
    }
}

/** Public view of a US profile: the taxpayer ID is never included, only the last 4 digits. */
function publicProfile(emp) {
    const p = emp.usProfile || {};
    const { taxpayerIdEncrypted, ...rest } = p;
    return {
        id: emp.id,
        employeeId: emp.data.employeeId || emp.id,
        name: emp.data.name || null,
        email: emp.data.email || null,
        profileComplete: Boolean(p.legalFirstName && p.taxpayerIdLast4),
        ...rest,
        taxpayerIdMasked: maskTaxpayerId(p.taxpayerIdLast4),
        hasTaxpayerId: Boolean(taxpayerIdEncrypted)
    };
}

/** Company profile (EIN, entity type, work states) */
router.get('/company/profile', COMPANY_READ, requireUsOrg, (req, res) => {
    res.json({ success: true, orgId: req.orgId, profile: req.org.usProfile || null });
});

router.put('/company/profile', COMPANY_WRITE, requireUsOrg, async (req, res) => {
    const { errors, value } = validateCompanyProfile(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    // Two people editing at once: the page sends back the updatedAt it loaded; a newer save wins and the second is told to reload.
    const expected = req.body && req.body.expectedUpdatedAt;
    const currentStamp = (req.org.usProfile && req.org.usProfile.updatedAt) || null;
    if (expected && currentStamp && expected !== currentStamp) {
        return res.status(409).json({ success: false, error: 'Someone else changed the company profile. Reload the page and try again.' });
    }
    const updatedAt = new Date().toISOString();
    await rawCollection('organizations').doc(req.orgId).set({
        usProfile: { ...value, updatedAt }
    }, { merge: true });
    audit(req.orgId, req, 'us_company_profile_updated', req.orgId, { fields: Object.keys(value) });
    res.json({ success: true, profile: { ...(req.org.usProfile || {}), ...value, updatedAt } });
});

/** List employees with their US profile status (never returns taxpayer IDs) */
router.get('/employees', PEOPLE_READ, requireUsOrg, async (req, res) => {
    const snaps = await Promise.all(PEOPLE_COLLECTIONS.map((name) => db.collection(name).get()));
    const rows = snaps.flatMap((s) => s.docs)
        .filter((d) => d.data().orgId === req.orgId && d.data().employeeId)
        .slice(0, 500)
        .map((d) => {
            const row = publicProfile({ id: d.id, data: d.data(), usProfile: d.data().usProfile });
            return {
                id: row.id, employeeId: row.employeeId, name: row.name, email: row.email,
                classification: row.classification || null, workState: row.workState || null,
                taxpayerIdMasked: row.taxpayerIdMasked, profileComplete: row.profileComplete
            };
        });
    res.json({ success: true, count: rows.length, data: rows });
});

router.get('/employees/:id/profile', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!canSeeProfile(req.user, emp)) return res.status(403).json({ success: false, error: 'You do not have permission to do this' });
    res.json({ success: true, profile: publicProfile({ id: emp.id, data: emp.data, usProfile: emp.data.usProfile }) });
});

router.put('/employees/:id/profile', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });

    const { errors, value } = validateEmployeeProfile(req.body);
    const existing = emp.data.usProfile || {};
    let encrypted = existing.taxpayerIdEncrypted || null;
    let last4 = existing.taxpayerIdLast4 || null;

    if (req.body.taxpayerId) {
        const check = validateTaxpayerId(req.body.taxpayerId, value.taxpayerIdType || req.body.taxpayerIdType);
        if (!check.valid) errors.push(check.error);
        else {
            encrypted = encryptField(check.digits, `${req.orgId}:${emp.id}`);
            last4 = check.last4;
        }
    } else if (!encrypted) {
        errors.push('taxpayerId (SSN or ITIN) is required');
    }
    if (errors.length) return res.status(400).json({ success: false, errors });

    const usProfile = {
        ...value,
        taxpayerIdEncrypted: encrypted,
        taxpayerIdLast4: last4,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.id || null
    };
    await emp.ref.set({ usProfile }, { merge: true });
    audit(req.orgId, req, 'us_employee_profile_updated', emp.id, {
        fields: Object.keys(value), taxpayerIdChanged: Boolean(req.body.taxpayerId)
    });
    res.json({ success: true, profile: publicProfile({ id: emp.id, data: emp.data, usProfile }) });
});

/** Shows the full SSN/ITIN once, with a stated reason; every reveal is written to the audit log. */
router.post('/employees/:id/taxpayer-id/reveal', PII_REVEAL, requireUsOrg, async (req, res) => {
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 5) return res.status(400).json({ success: false, error: 'A reason of at least 5 characters is required' });
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const stored = emp.data.usProfile && emp.data.usProfile.taxpayerIdEncrypted;
    if (!stored) return res.status(404).json({ success: false, error: 'No taxpayer ID on file' });
    let plain;
    try {
        plain = decryptField(stored, `${req.orgId}:${emp.id}`);
    } catch (e) {
        logger.error(`Taxpayer ID decrypt failed for ${emp.id}: ${e.message}`);
        return res.status(500).json({ success: false, error: 'Could not decrypt the stored value' });
    }
    await audit(req.orgId, req, 'us_taxpayer_id_revealed', emp.id, { reason });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, taxpayerId: `${plain.slice(0, 3)}-${plain.slice(3, 5)}-${plain.slice(5)}` });
});

// Shared with the other US routers (forms, time)
router.helpers = { requireUsOrg, findEmployee, audit, exists, orgIdOf, PEOPLE_COLLECTIONS, canSeeProfile };

module.exports = router;
