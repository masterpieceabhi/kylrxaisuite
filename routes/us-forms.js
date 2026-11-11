const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { encryptField } = require('../services/pii-crypto');
const forms = require('../services/us-forms');
const { validateDirectDeposit } = require('../services/us-validation');
const { requireUsOrg, findEmployee, audit, PEOPLE_COLLECTIONS } = require('./us-hr').helpers;

router.use(verifyToken);

const norm = (r) => String(r || '').toLowerCase().replace(/[\s_-]+/g, '');
const isStaff = (user) => ADMIN_HR_ROLES.some((r) => norm(r) === norm(user.role));
const isSelf = (user, emp) => [emp.id, emp.data.uid, emp.data.userId].filter(Boolean).includes(user.id);

function todayIn(tz) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Chicago' }).format(new Date());
    } catch (_) {
        return new Date().toISOString().slice(0, 10);
    }
}

const orgTimeZone = (org) => (org.usProfile && org.usProfile.timezone) || org.timezone || 'America/Chicago';
const firstDayOf = (emp) => {
    const raw = (emp.data.usProfile && emp.data.usProfile.startDate) || emp.data.joiningDate || '';
    const d = String(raw).slice(0, 10);
    return forms.parseIsoDate(d) ? d : null;
};
const orgOptions = (org) => ({ skipFederalHolidays: Boolean(org.usProfile && org.usProfile.i9SkipFederalHolidays) });

function legalNames(emp) {
    const p = emp.data.usProfile || {};
    const names = [];
    if (p.legalFirstName && p.legalLastName) {
        names.push(`${p.legalFirstName} ${p.legalLastName}`);
        if (p.legalMiddleName) names.push(`${p.legalFirstName} ${p.legalMiddleName} ${p.legalLastName}`);
    }
    if (emp.data.name) names.push(emp.data.name);
    return names;
}

/** Picks the stored legal name the typed signature matches, so the validator can compare exactly */
function expectedName(emp, signed) {
    const names = legalNames(emp);
    const s = String(signed || '').trim().toLowerCase();
    return names.find((n) => n.toLowerCase() === s) || names[0] || '';
}

function publicDoc(d) {
    if (!d) return null;
    const { numberEncrypted, ...rest } = d;
    return rest;
}

/** What the screens may see: no encrypted values, document numbers reduced to their last 4 */
function publicForms(emp, org) {
    const f = emp.data.usForms || {};
    const i9 = f.i9 || {};
    const s1 = i9.section1 ? { ...i9.section1 } : null;
    if (s1) delete s1.authorizationNumberEncrypted;
    const s2 = i9.section2 ? {
        ...i9.section2,
        listA: publicDoc(i9.section2.listA), listB: publicDoc(i9.section2.listB), listC: publicDoc(i9.section2.listC)
    } : null;
    const w4 = f.w4 && f.w4.current ? { ...f.w4.current } : null;
    const dd = f.directDeposit ? { bankName: f.directDeposit.bankName, accountType: f.directDeposit.accountType, accountLast4: f.directDeposit.accountLast4, routingNumber: f.directDeposit.routingNumber, updatedAt: f.directDeposit.updatedAt } : null;
    return {
        directDeposit: dd,
        employeeId: emp.data.employeeId || emp.id,
        name: emp.data.name || null,
        firstDay: firstDayOf(emp),
        w4,
        w4Revisions: f.w4 && f.w4.history ? f.w4.history.length : 0,
        i9: { section1: s1, section2: s2 },
        status: forms.onboardingStatus({
            firstDay: firstDayOf(emp), w4: f.w4, i9, todayIso: todayIn(orgTimeZone(org)), options: orgOptions(org)
        })
    };
}

function canAccess(req, emp) {
    return isStaff(req.user) || isSelf(req.user, emp);
}

const last4 = (s) => String(s || '').slice(-4);

router.get('/employees/:id/forms', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!canAccess(req, emp)) return res.status(403).json({ success: false, error: 'Not allowed' });
    res.json({ success: true, forms: publicForms(emp, req.org) });
});

router.put('/employees/:id/w4', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!canAccess(req, emp)) return res.status(403).json({ success: false, error: 'Not allowed' });

    const { errors, value } = forms.validateW4(req.body, expectedName(emp, req.body && req.body.signedName));
    if (errors.length) return res.status(400).json({ success: false, errors });

    const existing = (emp.data.usForms && emp.data.usForms.w4) || {};
    const history = existing.history || [];
    if (existing.current) history.push(existing.current);
    const current = { ...value, signedAt: new Date().toISOString(), signedById: req.user.id || null, signedIp: req.ip || null };
    await emp.ref.set({ usForms: { w4: { current, history } } }, { merge: true });
    audit(req.orgId, req, 'us_w4_submitted', emp.id, { taxYear: value.taxYear, revision: history.length + 1 });
    res.json({ success: true, forms: publicForms({ ...emp, data: { ...emp.data, usForms: { ...(emp.data.usForms || {}), w4: { current, history } } } }, req.org) });
});

/** Bank account for direct deposit. The account number is stored encrypted and shown as the last 4 only. */
router.put('/employees/:id/direct-deposit', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!canAccess(req, emp)) return res.status(403).json({ success: false, error: 'Not allowed' });
    const { errors, value } = validateDirectDeposit(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const directDeposit = {
        bankName: value.bankName, routingNumber: value.routingNumber, accountType: value.accountType,
        accountNumberEncrypted: encryptField(value.accountNumber, `${req.orgId}:${emp.id}:bank`), accountLast4: value.accountLast4,
        updatedAt: new Date().toISOString(), updatedBy: req.user.id || null, authorizedAt: new Date().toISOString(), authorizedIp: req.ip || null
    };
    await emp.ref.set({ usForms: { directDeposit } }, { merge: true });
    audit(req.orgId, req, 'us_direct_deposit_updated', emp.id, { bank: value.bankName, last4: value.accountLast4 });
    res.json({ success: true, forms: publicForms({ ...emp, data: { ...emp.data, usForms: { ...(emp.data.usForms || {}), directDeposit } } }, req.org) });
});

router.put('/employees/:id/i9/section1', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!canAccess(req, emp)) return res.status(403).json({ success: false, error: 'Not allowed' });

    const { errors, value } = forms.validateI9Section1(req.body, expectedName(emp, req.body && req.body.signedName));
    if (errors.length) return res.status(400).json({ success: false, errors });

    const section1 = { ...value, signedAt: new Date().toISOString(), signedById: req.user.id || null, signedIp: req.ip || null };
    if (value.authorizationNumber) {
        section1.authorizationNumberEncrypted = encryptField(value.authorizationNumber, `${req.orgId}:${emp.id}:i9`);
        section1.authorizationNumberLast4 = last4(value.authorizationNumber);
        delete section1.authorizationNumber;
    }
    const prev = (emp.data.usForms && emp.data.usForms.i9) || {};
    // A changed Section 1 invalidates an earlier Section 2 sign-off
    const i9 = { ...prev, section1, section2: prev.section2 && !req.body.keepSection2 ? null : prev.section2 || null };
    await emp.ref.set({ usForms: { i9 } }, { merge: true });
    audit(req.orgId, req, 'us_i9_section1_submitted', emp.id, { citizenshipStatus: value.citizenshipStatus });
    res.json({ success: true, forms: publicForms({ ...emp, data: { ...emp.data, usForms: { ...(emp.data.usForms || {}), i9 } } }, req.org) });
});

router.put('/employees/:id/i9/section2', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (isSelf(req.user, emp)) return res.status(403).json({ success: false, error: 'You cannot complete Section 2 for your own I-9' });

    const prev = (emp.data.usForms && emp.data.usForms.i9) || {};
    if (!prev.section1) return res.status(409).json({ success: false, error: 'The employee must complete Section 1 first' });

    const { errors, value } = forms.validateI9Section2(req.body, firstDayOf(emp));
    if (errors.length) return res.status(400).json({ success: false, errors });

    const section2 = { ...value, signedAt: new Date().toISOString(), signedById: req.user.id || null, signedIp: req.ip || null };
    for (const key of ['listA', 'listB', 'listC']) {
        if (section2[key]) {
            section2[key] = {
                ...section2[key],
                numberEncrypted: encryptField(section2[key].number, `${req.orgId}:${emp.id}:i9`),
                numberLast4: last4(section2[key].number)
            };
            delete section2[key].number;
        }
    }
    const i9 = { ...prev, section2 };
    await emp.ref.set({ usForms: { i9 } }, { merge: true });
    audit(req.orgId, req, 'us_i9_section2_completed', emp.id, {
        late: value.examinedOn > forms.addBusinessDays(firstDayOf(emp), 3, orgOptions(req.org))
    });
    res.json({ success: true, forms: publicForms({ ...emp, data: { ...emp.data, usForms: { ...(emp.data.usForms || {}), i9 } } }, req.org) });
});

/** Company-wide view of who is missing or late on W-4 / I-9, plus reverification dates */
router.get('/compliance/onboarding', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const snaps = await Promise.all(PEOPLE_COLLECTIONS.map((n) => db.collection(n).get()));
    const today = todayIn(orgTimeZone(req.org));
    const rows = snaps.flatMap((s) => s.docs)
        .filter((d) => d.data().orgId === req.orgId && d.data().employeeId && !/^terminated$/i.test(String(d.data().status || '')))
        .map((d) => {
            const emp = { id: d.id, data: d.data() };
            const f = forms.onboardingStatus({
                firstDay: firstDayOf(emp), w4: (emp.data.usForms || {}).w4, i9: (emp.data.usForms || {}).i9,
                todayIso: today, options: orgOptions(req.org)
            });
            return { employeeId: emp.data.employeeId, name: emp.data.name || null, firstDay: firstDayOf(emp), ...f };
        });
    const summary = {
        total: rows.length,
        w4Missing: rows.filter((r) => r.w4 === 'missing').length,
        i9Incomplete: rows.filter((r) => r.i9State !== 'complete').length,
        overdue: rows.filter((r) => r.flags.some((x) => x.endsWith('_overdue'))).length,
        reverifySoon: rows.filter((r) => r.flags.includes('i9_reverification_soon')).length
    };
    res.json({ success: true, today, summary, data: rows });
});

module.exports = router;
