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
    validateEmployeeProfile, validateCompanyProfile, validateTaxpayerId, maskTaxpayerId, validateEin
} = require('../services/us-validation');

// Who may do what on these routes (services/permissions.js decides which roles hold each permission):
//   read the company profile (EIN, entity, industry, fiscal year)   org.settings or payroll.view
//   change the company profile                                       org.settings
//   list people (names, employee numbers, class, work state)         people.read or people.read_pay (the pay roles need the list to pick a
//                                                                    person on the pay and payroll pages; they do not get the SSN digits)
//   read a person's US profile                                       people.read (a person always sees their own)
//   change a person's US profile                                     people.write
//   see a full SSN or ITIN                                           pii.reveal
const COMPANY_READ = requireAnyPermission('org.settings', 'payroll.view');
const COMPANY_WRITE = requirePermission('org.settings');
const PEOPLE_LIST = requireAnyPermission('people.read', 'people.read_pay');
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
// What a company with a suspended or cancelled subscription may still change: its billing, privacy requests, and each
// person's own things (notices, sign-in set-up)
const BILLING_FREE = new RegExp('^/api/us/(billing|privacy|me)(/|\\?|$)');

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
        // A company whose subscription is suspended or cancelled can still read everything, clock in, send hours, pay its
        // bill and use its privacy rights, but cannot change anything else. Off unless BILLING_ENFORCE=on, so a server
        // that has not set up billing behaves as before. (The clock and timesheet routes are under /api/time and are
        // not held back: hours worked must always be recorded.)
        if (process.env.BILLING_ENFORCE === 'on' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !BILLING_FREE.test(req.originalUrl || '')) {
            const bill = await require('../services/billing-service').getBillingState(orgId);
            if (bill.readOnly) return res.status(402).json({ success: false, code: 'account_read_only', billingState: bill.state, error: 'This company account is read-only because of a billing problem. The owner can fix it in Billing.' });
        }
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
/**
 * What the company typed at sign-up, in the shape of this form, so the first save is a check instead of typing it
 * all again. Only offered while the profile has never been saved; nothing is stored until the owner saves.
 */
function fromSignup(org) {
    const o = org || {};
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const kinds = { llc: 'llc', 'c corporation': 'c_corp', 'c corp': 'c_corp', 's corporation': 's_corp', 's corp': 's_corp', partnership: 'partnership', 'sole proprietorship': 'sole_proprietorship', nonprofit: 'nonprofit' };
    const state = str(o.state).toUpperCase();
    const twoLetters = /^[A-Z]{2}$/.test(state) ? state : '';
    const zip = /^\d{5}(-\d{4})?$/.test(str(o.pinCode)) ? str(o.pinCode) : '';
    const month = Number(String(o.financialYearStart || '').slice(0, 2));
    return {
        legalName: str(o.legalName || o.Legal_Name),
        entityType: kinds[str(o.organizationType || o.Organization_Type).toLowerCase()] || '',
        businessAddress: { line1: str(o.registeredAddress), city: str(o.city), state: twoLetters, zip },
        workStates: twoLetters ? [twoLetters] : [],
        fiscalYearStartMonth: month >= 1 && month <= 12 ? month : 1
    };
}

router.get('/company/profile', COMPANY_READ, requireUsOrg, async (req, res) => {
    const profile = req.org.usProfile || null;
    // a profile that was only partly filled (from Gusto) still gets the sign-up answers for the gaps
    const complete = Boolean(profile && profile.ein && profile.legalName && profile.businessAddress && (profile.workStates || []).length);
    let gusto = { connected: false };
    try { const c = await require('../services/gusto/store').defaultStore().getConnection(req.orgId); gusto = { connected: Boolean(c && c.status === 'connected' && c.companyUuid) }; } catch (_) { /* the page only hides the "Fill from Gusto" button */ }
    res.json({ success: true, orgId: req.orgId, profile, suggested: complete ? null : fromSignup(req.org), gusto });
});

/** Just the EIN (and the legal name when there is none yet): what a page asks for in place when a feature needs it */
router.put('/company/ein', COMPANY_WRITE, requireUsOrg, async (req, res) => {
    const ein = validateEin((req.body || {}).ein);
    if (!ein.valid) return res.status(400).json({ success: false, errors: [ein.error] });
    const had = req.org.usProfile || {};
    const legalName = String((req.body || {}).legalName || '').trim().slice(0, 200);
    const updatedAt = new Date().toISOString();
    const patch = { ein: ein.formatted, updatedAt, ...(legalName && !had.legalName ? { legalName } : {}) };
    if (had.fromGusto) patch.fromGusto = { ...had.fromGusto, einMismatch: false, fields: (had.fromGusto.fields || []).filter((f) => f !== 'ein') };
    await rawCollection('organizations').doc(req.orgId).set({ usProfile: patch }, { merge: true });
    audit(req.orgId, req, 'us_company_ein_saved', req.orgId, { changed: Boolean(had.ein) && had.ein !== ein.formatted });
    res.json({ success: true, ein: ein.formatted });
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
router.get('/employees', PEOPLE_LIST, requireUsOrg, async (req, res) => {
    const seesId = can(req.user, 'people.read'); // the last digits of the SSN are an HR record, not a pay record
    const snaps = await Promise.all(PEOPLE_COLLECTIONS.map((name) => db.collection(name).get()));
    const rows = snaps.flatMap((s) => s.docs)
        .filter((d) => d.data().orgId === req.orgId && d.data().employeeId)
        .sort((a, b) => String(a.data().employeeId).localeCompare(String(b.data().employeeId), undefined, { numeric: true }))
        .map((d) => {
            const row = publicProfile({ id: d.id, data: d.data(), usProfile: d.data().usProfile });
            return {
                id: row.id, employeeId: row.employeeId, name: row.name, email: row.email,
                classification: row.classification || null, workState: row.workState || null,
                taxpayerIdMasked: seesId ? row.taxpayerIdMasked : null, profileComplete: row.profileComplete,
                // 'active', 'leaving' (a last day is set and has not come yet) or 'former' (they have left)
                employment: /^(terminated|inactive|offboarded)$/i.test(String(d.data().status || '')) ? 'former' : (d.data().terminationStatus === 'scheduled' ? 'leaving' : 'active'),
                lastDay: (d.data().usProfile && d.data().usProfile.termination && d.data().usProfile.termination.lastDay) || null
            };
        });
    // sorted by employee number; up to 500 at a time, with nextCursor when the company has more
    res.json({ success: true, count: rows.length, ...require('../utils/paging').pageFields(rows, req.query, 500) });
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
    // Optional: the person's department and work location, so a new hire can be placed in the same save. Each must be
    // one of this company's own. Not sent: whatever is stored stays (the org page's assignment route still works too).
    const place = {};
    const lists = require('../services/people-data-store');
    const dep = req.body.departmentId;
    const loc = req.body.workLocationId !== undefined ? req.body.workLocationId : req.body.locationId;
    if (dep !== undefined && dep !== null && dep !== '') {
        if (!(await lists.listByOrg('departments', req.orgId)).some((d) => d.id === String(dep))) errors.push('departmentId is not a department of this company'); else place.departmentId = String(dep);
    }
    if (loc !== undefined && loc !== null && loc !== '') {
        const l = (await lists.listByOrg('locations', req.orgId)).find((x) => x.id === String(loc));
        if (!l) errors.push('workLocationId is not a location of this company'); else if (l.active === false) errors.push('That location is inactive'); else place.workLocationId = l.id;
    }
    if (errors.length) return res.status(400).json({ success: false, errors });

    const usProfile = {
        ...value,
        ...place,
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
module.exports.fromSignup = fromSignup; // for tests
