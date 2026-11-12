const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { requirePermission, requireAnyPermission, can } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const B = require('../services/benefits-rules');
const adapters = require('../services/benefits-carrier-adapter');
const store = require('../services/file-store');
const { encryptField, decryptField } = require('../services/pii-crypto');
const { loadPeople, loadPerson, loadWeeks } = require('../services/us-people-loader');
const { parseIsoDate } = require('../services/us-forms');

const MAX_PROOF = 5 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PROOF + 1, files: 1, fields: 12 } });

router.use(verifyToken);

const VIEW = requirePermission('benefits.view');
const MANAGE = requirePermission('benefits.manage');
const NOTE = 'Plan rules, windows, limits and notice days are settings your company controls. Confirm them with a US compliance advisor.';
const todayIn = (tz) => timeRules.localDate(new Date().toISOString(), tz);
const round2 = (n) => Math.round(n * 100) / 100;
const nowIso = () => new Date().toISOString();
const histEntry = (status, by, note) => ({ at: nowIso(), status, by, note: note || '' });

/* ---------------------------------- storage ---------------------------------- */

async function getSettings(orgId) {
    const snap = await rawCollection('benefit_settings').doc(orgId).get();
    const s = exists(snap) ? snap.data() : {};
    return {
        newHireWindowDays: s.newHireWindowDays ?? B.DEFAULT_SETTINGS.newHireWindowDays,
        openEnrollment: s.openEnrollment || B.DEFAULT_SETTINGS.openEnrollment,
        lifeEvents: s.lifeEvents && s.lifeEvents.length ? s.lifeEvents : B.DEFAULT_LIFE_EVENTS,
        limits: s.limits || B.DEFAULT_LIMITS,
        aca: { ...B.DEFAULT_SETTINGS.aca, ...(s.aca || {}) },
        cobra: { ...B.DEFAULT_COBRA, ...(s.cobra || {}) }
    };
}
const saveSettings = (orgId, req, patch) => rawCollection('benefit_settings').doc(orgId).set({ orgId, ...patch, updatedAt: nowIso(), updatedBy: req.user.id }, { merge: true });

const col = (name) => rawCollection(name);
async function loadAll(name, orgId) {
    const snap = await col(name).where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
const loadPlans = async (orgId) => (await loadAll('benefit_plans', orgId));
async function loadDoc(name, req, res, label) {
    const snap = await col(name).doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { res.status(404).json({ success: false, error: `${label} not found` }); return null; }
    return { id: snap.id, ref: snap.ref, data: snap.data() };
}

const pubPlan = (p) => ({ id: p.id, name: p.name, type: p.type, carrier: p.carrier || '', planYear: p.planYear, payPeriodsPerYear: p.payPeriodsPerYear, preTax: p.preTax, costs: p.costs || null, eligibility: p.eligibility, maxPercent: p.maxPercent, allowRoth: p.allowRoth, match: p.match || null, employerContributionAnnual: p.employerContributionAnnual, limitKey: p.limitKey, notes: p.notes || '', active: p.active !== false });

/** Dependents as stored are never returned with the SSN: only the last 4 digits */
const pubDependent = (d) => ({ id: d.id, firstName: d.firstName, lastName: d.lastName, relationship: d.relationship, dateOfBirth: d.dateOfBirth, student: d.student === true, ssnMasked: d.ssnLast4 ? `***-**-${d.ssnLast4}` : null });
const pubElection = (e) => ({ planId: e.planId, planName: e.planName, type: e.type, waived: e.waived === true, waiveReason: e.waiveReason || null, tier: e.tier || null, deferralPercent: e.deferralPercent ?? null, contributionType: e.contributionType || null, annualAmount: e.annualAmount ?? null, dependents: (e.dependents || []).map(pubDependent) });
const pubEnrollment = (e) => ({ id: e.id, userId: e.userId, name: e.name, windowType: e.windowType, eventId: e.eventId || null, effectiveDate: e.effectiveDate, endDate: e.endDate || null, status: e.status, elections: (e.elections || []).map(pubElection), statusHistory: e.statusHistory || [], createdAt: e.createdAt });

async function recentHours(orgId, userId, today) {
    const weeks = await loadWeeks(orgId, userId);
    const r = B.acaAverage(weeks, B.addDays(today, -84), today, 30);
    return r.weeksCounted >= 4 ? r.averageWeeklyHours : null;
}

/* ------------------------------------ config ------------------------------------ */

router.get('/benefits/config', VIEW, requireUsOrg, async (req, res) => {
    const s = await getSettings(req.orgId);
    res.json({ success: true, note: NOTE, data: s, tiers: B.TIERS, planTypes: B.PLAN_TYPES });
});

router.put('/benefits/config', MANAGE, requireUsOrg, async (req, res) => {
    const b = req.body || {}; const errors = []; const patch = {};
    if (b.newHireWindowDays !== undefined) {
        const n = Number(b.newHireWindowDays);
        if (!Number.isInteger(n) || n < 1 || n > 365) errors.push('newHireWindowDays must be a whole number from 1 to 365'); else patch.newHireWindowDays = n;
    }
    if (b.openEnrollment !== undefined) { const r = B.validateOpenEnrollment(b.openEnrollment); errors.push(...r.errors); patch.openEnrollment = r.value; }
    if (b.lifeEvents !== undefined) { const r = B.validateLifeEvents(b.lifeEvents); errors.push(...r.errors); if (!r.errors.length && !r.value.length) errors.push('keep at least one life event'); patch.lifeEvents = r.value; }
    if (b.limits !== undefined) { const r = B.validateLimits(b.limits); errors.push(...r.errors); patch.limits = r.value; }
    if (b.aca !== undefined) { const cur = await getSettings(req.orgId); const r = B.validateAcaSettings({ ...cur.aca, ...b.aca }); errors.push(...r.errors); patch.aca = r.value; }
    if (b.cobra !== undefined) { const cur = await getSettings(req.orgId); const r = B.validateCobraSettings({ ...cur.cobra, ...b.cobra }); errors.push(...r.errors); patch.cobra = r.value; }
    if (!Object.keys(patch).length && !errors.length) errors.push('nothing to update');
    if (errors.length) return res.status(400).json({ success: false, errors });
    await saveSettings(req.orgId, req, patch);
    audit(req.orgId, req, 'benefit_settings_updated', req.orgId, { fields: Object.keys(patch) });
    res.json({ success: true, data: await getSettings(req.orgId) });
});

/* ------------------------------------- plans ------------------------------------- */

router.get('/benefits/plans', requireUsOrg, async (req, res) => {
    const all = req.query.all === 'true' && can(req.user, 'benefits.view');
    const plans = (await loadPlans(req.orgId)).filter((p) => all || p.active !== false).sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    res.json({ success: true, note: NOTE, data: plans.map(pubPlan) });
});

router.post('/benefits/plans', MANAGE, requireUsOrg, async (req, res) => {
    const { errors, value } = B.validatePlan(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ref = await col('benefit_plans').add({ ...value, orgId: req.orgId, createdAt: nowIso(), createdBy: req.user.id });
    audit(req.orgId, req, 'benefit_plan_created', ref.id, { name: value.name, type: value.type, planYear: value.planYear });
    res.status(201).json({ success: true, plan: pubPlan({ id: ref.id, ...value }) });
});

router.put('/benefits/plans/:id', MANAGE, requireUsOrg, async (req, res) => {
    const p = await loadDoc('benefit_plans', req, res, 'Plan'); if (!p) return;
    const { errors, value } = B.validatePlan({ ...p.data, ...req.body });
    if (errors.length) return res.status(400).json({ success: false, errors });
    await p.ref.set({ ...value, updatedAt: nowIso(), updatedBy: req.user.id }, { merge: true });
    audit(req.orgId, req, 'benefit_plan_updated', p.id, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, plan: pubPlan({ id: p.id, ...p.data, ...value }) });
});

router.delete('/benefits/plans/:id', MANAGE, requireUsOrg, async (req, res) => {
    const p = await loadDoc('benefit_plans', req, res, 'Plan'); if (!p) return;
    await p.ref.update({ active: false, archivedAt: nowIso() });
    audit(req.orgId, req, 'benefit_plan_archived', p.id);
    res.json({ success: true });
});

/* ------------------------------------ employee ------------------------------------ */

async function activeEnrollment(orgId, userId) {
    const rows = (await loadAll('benefit_enrollments', orgId)).filter((e) => e.userId === userId);
    return { all: rows, current: rows.filter((e) => e.status === 'active' && !e.endDate).sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0] || null };
}

async function summaryFor(orgId, person, today) {
    const [settings, plans, enr, events, hours] = await Promise.all([getSettings(orgId), loadPlans(orgId), activeEnrollment(orgId, person.id), loadAll('benefit_events', orgId), recentHours(orgId, person.id, today)]);
    const p2 = { ...person, weeklyHours: person.weeklyHours || hours };
    const active = plans.filter((p) => p.active !== false);
    const eligibilityRows = active.map((p) => ({ planId: p.id, ...B.eligibility(p, p2, today) }));
    const earliest = eligibilityRows.map((e) => e.eligibleOn).filter(Boolean).sort()[0] || null;
    const mineEvents = events.filter((e) => e.userId === person.id).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const windows = B.openWindows(settings, p2, mineEvents.filter((e) => e.kind === 'life_event'), today, earliest);
    const gross = B.estimateGrossPerPeriod(person);
    const lines = [];
    if (enr.current) {
        for (const el of enr.current.elections || []) {
            const plan = plans.find((p) => p.id === el.planId); if (!plan || el.waived) continue;
            const l = B.deductionLine(plan, el, person, { grossPerPeriod: gross, limits: settings.limits });
            if (!l.error) lines.push(l);
        }
    }
    return { settings, plans: active, enr, eligibilityRows, windows, events: mineEvents, lines, gross };
}

router.get('/benefits/me', requireUsOrg, async (req, res) => {
    const [me, info] = await Promise.all([loadPerson(req.orgId, req.user.id), orgInfo(req.orgId)]);
    if (!me) return res.status(404).json({ success: false, error: 'No employee record for this login' });
    const today = todayIn(info.tz);
    const s = await summaryFor(req.orgId, me, today);
    const cobra = (await loadAll('cobra_records', req.orgId)).filter((c) => c.userId === me.id && c.status !== 'terminated');
    res.set('Cache-Control', 'no-store');
    res.json({
        success: true, today, note: NOTE, payFrequency: me.payFrequency, classification: me.classification,
        plans: s.plans.map(pubPlan), eligibility: s.eligibilityRows, windows: s.windows, lifeEventTypes: s.settings.lifeEvents,
        enrollment: s.enr.current ? pubEnrollment(s.enr.current) : null, history: s.enr.all.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate)).map(pubEnrollment),
        perPayPeriod: { frequency: me.payFrequency, lines: s.lines, employee: round2(s.lines.reduce((t, l) => t + l.employeeAmount, 0)), employer: round2(s.lines.reduce((t, l) => t + l.employerAmount, 0)) },
        lifeEvents: s.events.filter((e) => e.kind === 'life_event').map(pubEvent),
        cobra: cobra.map((c) => ({ id: c.id, eventType: c.eventType, status: c.status, deadlines: B.cobraDeadlines(c, s.settings.cobra) }))
    });
});

const pubEvent = (e) => ({ id: e.id, userId: e.userId, name: e.name || '', typeKey: e.typeKey, typeLabel: e.typeLabel, eventDate: e.eventDate, windowEnd: e.windowEnd, effectiveDate: e.effectiveDate, status: e.status, note: e.note || '', proof: e.proof ? { fileName: e.proof.fileName, size: e.proof.size } : null, proofRequired: e.proofRequired === true, decisionNote: e.decisionNote || '', statusHistory: e.statusHistory || [], createdAt: e.createdAt });

function sniffProof(buf) {
    if (buf.slice(0, 4).toString() === '%PDF') return 'application/pdf';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf.slice(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'image/png';
    return null;
}

router.post('/benefits/me/life-events', requireUsOrg, (req, res, next) => {
    upload.single('proof')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: 'The proof file is larger than 5 MB' });
        if (err) return res.status(400).json({ success: false, error: 'Could not read the upload' });
        next();
    });
}, async (req, res) => {
    const [me, info, settings] = await Promise.all([loadPerson(req.orgId, req.user.id), orgInfo(req.orgId), null]);
    if (!me) return res.status(404).json({ success: false, error: 'No employee record for this login' });
    const cfg = await getSettings(req.orgId);
    const { errors, value } = B.validateLifeEventRequest(req.body, cfg.lifeEvents, todayIn(info.tz));
    let mime = null;
    if (req.file) { mime = sniffProof(req.file.buffer); if (!mime) errors.push('The proof must be a PDF, JPG or PNG file'); }
    if (errors.length) return res.status(400).json({ success: false, errors });
    const type = cfg.lifeEvents.find((t) => t.key === value.typeKey);
    const ref = col('benefit_events').doc();
    let proof = null;
    if (req.file) { await store.saveFile(req.orgId, `ben_${ref.id}`, req.file.buffer); proof = { fileName: String(req.file.originalname || 'proof').replace(/[^\w.\- ]+/g, '_').slice(0, 80), mime, size: req.file.size }; }
    const doc = { orgId: req.orgId, kind: 'life_event', userId: me.id, name: me.name, employeeId: me.employeeId, ...value, typeLabel: type.label, status: 'pending', proof, statusHistory: [histEntry('pending', req.user.id, 'Submitted')], createdAt: nowIso() };
    await ref.set(doc);
    audit(req.orgId, req, 'benefit_life_event_submitted', ref.id, { typeKey: value.typeKey, eventDate: value.eventDate, proofAttached: Boolean(proof) });
    res.status(201).json({ success: true, event: pubEvent({ id: ref.id, ...doc }) });
});

/** Build the enrollment from submitted elections (shared by the employee and HR routes) */
async function buildEnrollment({ orgId, person, body, window, effectiveDate, today, settings, plans }) {
    const errors = []; const elections = [];
    const raw = Array.isArray(body.elections) ? body.elections : [];
    if (!raw.length) return { errors: ['elections must list at least one plan'] };
    const seen = new Set();
    for (const r of raw) {
        const plan = plans.find((p) => p.id === r.planId && p.active !== false);
        if (!plan) { errors.push(`plan ${r.planId} was not found`); continue; }
        if (seen.has(plan.id)) { errors.push(`${plan.name} is listed twice`); continue; }
        seen.add(plan.id);
        const v = B.validateElection(r, plan, { today, limits: settings.limits });
        if (v.errors.length) { errors.push(...v.errors.map((e) => `${plan.name}: ${e}`)); continue; }
        if (!v.value.waived) {
            const hours = person.weeklyHours || await recentHours(orgId, person.id, today);
            const el = B.eligibility(plan, { ...person, weeklyHours: hours }, effectiveDate);
            if (!el.eligible) { errors.push(`${plan.name}: ${el.reasons.join('; ')}`); continue; }
        }
        // Encrypt dependent SSNs; the plain value never leaves this function
        if (v.value.dependents) {
            v.value.dependents = v.value.dependents.map((d) => {
                const { ssnPlain, ...rest } = d;
                const id = crypto.randomBytes(6).toString('hex');
                return { ...rest, id, ...(ssnPlain ? { ssnEncrypted: encryptField(ssnPlain, `${orgId}:${person.id}:dep:${id}`), ssnLast4: ssnPlain.slice(-4) } : {}) };
            });
        }
        elections.push(v.value);
    }
    return { errors, elections };
}

/** Writes a new enrollment, ending the previous one; elections for plans not resubmitted carry over */
async function saveEnrollment({ orgId, req, person, elections, windowType, eventId, effectiveDate, note }) {
    const enr = await activeEnrollment(orgId, person.id);
    const submitted = new Set(elections.map((e) => e.planId));
    const carried = enr.current ? (enr.current.elections || []).filter((e) => !submitted.has(e.planId)) : [];
    const ref = col('benefit_enrollments').doc();
    const doc = {
        orgId, userId: person.id, name: person.name, employeeId: person.employeeId, windowType, eventId: eventId || null, effectiveDate, endDate: null, status: 'active',
        elections: [...carried, ...elections], statusHistory: [...(enr.current ? [] : []), histEntry('active', req.user.id, note || `Enrolled (${windowType})`)], createdAt: nowIso(), createdBy: req.user.id
    };
    if (enr.current) {
        const end = B.addDays(effectiveDate > enr.current.effectiveDate ? effectiveDate : enr.current.effectiveDate, -1);
        await col('benefit_enrollments').doc(enr.current.id).update({ status: 'terminated', endDate: end, statusHistory: [...(enr.current.statusHistory || []), histEntry('terminated', req.user.id, `Replaced by a new election effective ${effectiveDate}`)] });
        doc.statusHistory = [...(enr.current.statusHistory || []), histEntry('active', req.user.id, note || `Updated (${windowType})`)];
        doc.previousEnrollmentId = enr.current.id;
    }
    await ref.set(doc);
    return { id: ref.id, ...doc };
}

router.post('/benefits/me/enroll', requireUsOrg, async (req, res) => {
    const [me, info] = await Promise.all([loadPerson(req.orgId, req.user.id), orgInfo(req.orgId)]);
    if (!me) return res.status(404).json({ success: false, error: 'No employee record for this login' });
    const today = todayIn(info.tz);
    const s = await summaryFor(req.orgId, me, today);
    const b = req.body || {};
    const window = s.windows.find((w) => w.type === b.windowType && (w.type !== 'life_event' || w.eventId === b.eventId));
    if (!window) return res.status(409).json({ success: false, error: 'No enrollment window of that kind is open for you today. Ask HR.', openWindows: s.windows.map((w) => w.type) });
    const built = await buildEnrollment({ orgId: req.orgId, person: me, body: b, window, effectiveDate: window.effectiveDate, today, settings: s.settings, plans: s.plans });
    if (built.errors.length) return res.status(400).json({ success: false, errors: built.errors });
    const enrollment = await saveEnrollment({ orgId: req.orgId, req, person: me, elections: built.elections, windowType: window.type, eventId: window.eventId, effectiveDate: window.effectiveDate });
    audit(req.orgId, req, 'benefit_enrolled', enrollment.id, { windowType: window.type, plans: built.elections.map((e) => e.planName), waived: built.elections.filter((e) => e.waived).length });
    res.status(201).json({ success: true, enrollment: pubEnrollment(enrollment) });
});

/* ------------------------------------- HR side ------------------------------------- */

router.get('/benefits/people', VIEW, requireUsOrg, async (req, res) => {
    const people = (await loadPeople(req.orgId)).filter((p) => p.active);
    res.json({ success: true, data: people.map((p) => ({ id: p.id, employeeId: p.employeeId, name: p.name, classification: p.classification, employmentType: p.employmentType, hireDate: p.hireDate, payFrequency: p.payFrequency })) });
});

router.get('/benefits/summary', VIEW, requireUsOrg, async (req, res) => {
    const [plans, enrollments, people] = await Promise.all([loadPlans(req.orgId), loadAll('benefit_enrollments', req.orgId), loadPeople(req.orgId)]);
    const info = await orgInfo(req.orgId); const today = todayIn(info.tz);
    const settings = await getSettings(req.orgId);
    const byId = Object.fromEntries(people.map((p) => [p.id, p]));
    const rows = plans.filter((p) => p.active !== false).map((p) => ({ planId: p.id, name: p.name, type: p.type, enrolled: 0, waived: 0, employeePerPeriodTotal: 0, employerPerPeriodTotal: 0 }));
    const idx = Object.fromEntries(rows.map((r) => [r.planId, r]));
    for (const e of enrollments.filter((x) => B.activeOn(x, today))) {
        const person = byId[e.userId]; if (!person) continue;
        const gross = B.estimateGrossPerPeriod(person);
        for (const el of e.elections || []) {
            const row = idx[el.planId]; if (!row) continue;
            if (el.waived) { row.waived++; continue; }
            row.enrolled++;
            const l = B.deductionLine(plans.find((p) => p.id === el.planId), el, person, { grossPerPeriod: gross, limits: settings.limits });
            if (!l.error) { row.employeePerPeriodTotal = round2(row.employeePerPeriodTotal + l.employeeAmount); row.employerPerPeriodTotal = round2(row.employerPerPeriodTotal + l.employerAmount); }
        }
    }
    res.json({ success: true, note: 'Per-period totals mix pay frequencies; use the payroll feed for exact amounts.', today, data: rows, pendingEvents: (await loadAll('benefit_events', req.orgId)).filter((e) => e.kind === 'life_event' && e.status === 'pending').length });
});

router.get('/benefits/enrollments', VIEW, requireUsOrg, async (req, res) => {
    let rows = await loadAll('benefit_enrollments', req.orgId);
    if (req.query.userId) rows = rows.filter((e) => e.userId === req.query.userId);
    if (req.query.status) rows = rows.filter((e) => e.status === req.query.status);
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, count: rows.length, data: rows.slice(0, 300).map(pubEnrollment) });
});

router.get('/benefits/enrollments/:id', VIEW, requireUsOrg, async (req, res) => {
    const e = await loadDoc('benefit_enrollments', req, res, 'Enrollment'); if (!e) return;
    audit(req.orgId, req, 'benefit_enrollment_viewed', e.id, { userId: e.data.userId });
    res.json({ success: true, enrollment: pubEnrollment({ id: e.id, ...e.data }) });
});

/** HR enrolls someone directly (outside a window), with a recorded reason */
router.post('/benefits/enrollments', MANAGE, requireUsOrg, async (req, res) => {
    const b = req.body || {};
    const [person, info] = await Promise.all([loadPerson(req.orgId, String(b.userId || '')), orgInfo(req.orgId)]);
    if (!person) return res.status(404).json({ success: false, error: 'Employee not found' });
    const today = todayIn(info.tz);
    const reason = String(b.reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ success: false, errors: ['A reason of at least 5 characters is required'] });
    if (!parseIsoDate(b.effectiveDate)) return res.status(400).json({ success: false, errors: ['effectiveDate must be a valid date (YYYY-MM-DD)'] });
    const settings = await getSettings(req.orgId); const plans = (await loadPlans(req.orgId)).filter((p) => p.active !== false);
    const built = await buildEnrollment({ orgId: req.orgId, person, body: b, window: null, effectiveDate: b.effectiveDate, today, settings, plans });
    if (built.errors.length) return res.status(400).json({ success: false, errors: built.errors });
    const enrollment = await saveEnrollment({ orgId: req.orgId, req, person, elections: built.elections, windowType: 'hr_entered', effectiveDate: b.effectiveDate, note: `HR entered: ${reason}` });
    audit(req.orgId, req, 'benefit_enrolled_by_hr', enrollment.id, { userId: person.id, reason, plans: built.elections.map((e) => e.planName) });
    res.status(201).json({ success: true, enrollment: pubEnrollment(enrollment) });
});

router.post('/benefits/enrollments/:id/terminate', MANAGE, requireUsOrg, async (req, res) => {
    const e = await loadDoc('benefit_enrollments', req, res, 'Enrollment'); if (!e) return;
    const b = req.body || {};
    if (e.data.status !== 'active') return res.status(409).json({ success: false, error: `Enrollment is already ${e.data.status}` });
    if (!parseIsoDate(b.endDate) || b.endDate < e.data.effectiveDate) return res.status(400).json({ success: false, errors: ['endDate must be a valid date on or after the effective date'] });
    const reason = String(b.reason || '').trim();
    if (reason.length < 3) return res.status(400).json({ success: false, errors: ['A reason is required'] });
    await e.ref.update({ status: 'terminated', endDate: b.endDate, statusHistory: [...(e.data.statusHistory || []), histEntry('terminated', req.user.id, reason)] });
    audit(req.orgId, req, 'benefit_enrollment_terminated', e.id, { endDate: b.endDate, reason });
    res.json({ success: true });
});

/** Show a dependent's full SSN once, with a recorded reason. Same rule as the employee taxpayer ID. */
router.post('/benefits/enrollments/:id/dependents/:depId/ssn/reveal', requirePermission('pii.reveal'), requireUsOrg, async (req, res) => {
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 5) return res.status(400).json({ success: false, error: 'A reason of at least 5 characters is required' });
    const e = await loadDoc('benefit_enrollments', req, res, 'Enrollment'); if (!e) return;
    const dep = (e.data.elections || []).flatMap((el) => el.dependents || []).find((d) => d.id === req.params.depId);
    if (!dep || !dep.ssnEncrypted) return res.status(404).json({ success: false, error: 'No SSN on file for that dependent' });
    let plain;
    try { plain = decryptField(dep.ssnEncrypted, `${req.orgId}:${e.data.userId}:dep:${dep.id}`); } catch (_) { return res.status(500).json({ success: false, error: 'Could not decrypt the stored value' }); }
    await audit(req.orgId, req, 'benefit_dependent_ssn_revealed', e.id, { depId: dep.id, reason });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ssn: `${plain.slice(0, 3)}-${plain.slice(3, 5)}-${plain.slice(5)}` });
});

/* ---------------------------------- life events (HR) ---------------------------------- */

router.get('/benefits/events', VIEW, requireUsOrg, async (req, res) => {
    let rows = (await loadAll('benefit_events', req.orgId)).filter((e) => e.kind === 'life_event');
    if (req.query.status) rows = rows.filter((e) => e.status === req.query.status);
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, count: rows.length, data: rows.slice(0, 200).map(pubEvent) });
});

router.get('/benefits/events/:id/proof', requireUsOrg, async (req, res) => {
    const e = await loadDoc('benefit_events', req, res, 'Event'); if (!e) return;
    if (e.data.userId !== req.user.id && !can(req.user, 'benefits.manage')) return res.status(403).json({ success: false, error: 'You do not have permission to do this' });
    if (!e.data.proof) return res.status(404).json({ success: false, error: 'No proof was attached' });
    audit(req.orgId, req, 'benefit_proof_viewed', e.id, { userId: e.data.userId });
    res.set('Content-Type', e.data.proof.mime); res.set('Content-Disposition', `attachment; filename="${e.data.proof.fileName}"`); res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff');
    res.send(await store.readFile(req.orgId, `ben_${e.id}`));
});

router.post('/benefits/events/:id/decision', MANAGE, requireUsOrg, async (req, res) => {
    const e = await loadDoc('benefit_events', req, res, 'Event'); if (!e) return;
    const b = req.body || {};
    if (e.data.status !== 'pending') return res.status(409).json({ success: false, error: `This event is already ${e.data.status}` });
    if (!['approve', 'reject'].includes(b.decision)) return res.status(400).json({ success: false, errors: ['decision must be approve or reject'] });
    const note = String(b.note || '').trim().slice(0, 300);
    if (b.decision === 'reject' && note.length < 3) return res.status(400).json({ success: false, errors: ['Say why (at least 3 characters)'] });
    if (b.decision === 'approve' && e.data.proofRequired && !e.data.proof && !(b.override === true && note.length >= 5)) {
        return res.status(409).json({ success: false, error: 'Proof is required for this event. Ask the employee to attach it, or approve with override and a reason.' });
    }
    const status = b.decision === 'approve' ? 'approved' : 'rejected';
    await e.ref.update({ status, decidedBy: req.user.id, decidedAt: nowIso(), decisionNote: note, statusHistory: [...(e.data.statusHistory || []), histEntry(status, req.user.id, note || (b.override ? 'Approved with override' : ''))] });
    audit(req.orgId, req, `benefit_life_event_${status}`, e.id, { userId: e.data.userId, typeKey: e.data.typeKey, override: b.override === true });
    res.json({ success: true, status });
});

/* --------------------------------- payroll feed + carrier --------------------------------- */

async function buildFeed(orgId, periodEnd) {
    const [plans, enrollments, people, settings] = await Promise.all([loadPlans(orgId), loadAll('benefit_enrollments', orgId), loadPeople(orgId), getSettings(orgId)]);
    return B.payrollFeed(enrollments, plans, Object.fromEntries(people.map((p) => [p.id, p])), { periodEnd, limits: settings.limits });
}

router.get('/benefits/payroll-feed', requireAnyPermission('benefits.manage', 'payroll.view'), requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const periodEnd = req.query.periodEnd || todayIn(info.tz);
    if (!parseIsoDate(periodEnd)) return res.status(400).json({ success: false, error: 'periodEnd must be YYYY-MM-DD' });
    const feed = await buildFeed(req.orgId, periodEnd);
    audit(req.orgId, req, 'benefit_payroll_feed_exported', null, { periodEnd, rows: feed.rows.length, format: req.query.format || 'json' });
    if (req.query.format === 'csv') {
        res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', `attachment; filename="benefit_deductions_${periodEnd}.csv"`); res.set('Cache-Control', 'no-store');
        return res.send(B.toCsv(B.FEED_HEADER, feed.rows));
    }
    res.json({ success: true, note: 'Amounts are per pay period in each person\'s own pay frequency. 401(k) uses estimated gross pay: payroll should apply the percent to actual pay.', ...feed });
});

router.post('/benefits/carrier/send', MANAGE, requireUsOrg, async (req, res) => {
    const name = (req.body && req.body.adapter) || 'stub';
    if (!['stub', 'mock'].includes(name)) return res.status(400).json({ success: false, errors: ['adapter must be stub or mock'] });
    const info = await orgInfo(req.orgId);
    const periodEnd = (req.body && req.body.periodEnd) || todayIn(info.tz);
    if (!parseIsoDate(periodEnd)) return res.status(400).json({ success: false, errors: ['periodEnd must be YYYY-MM-DD'] });
    const adapter = adapters.getAdapter(name);
    const result = await adapter.sendEnrollmentFeed(await buildFeed(req.orgId, periodEnd));
    audit(req.orgId, req, 'benefit_carrier_feed_sent', null, { adapter: name, periodEnd, success: result.success });
    res.status(result.success ? 200 : 501).json({ ...result, adapter: adapter.describe() });
});

/* ------------------------------------------ ACA ------------------------------------------ */

router.get('/benefits/aca/summary', VIEW, requireUsOrg, async (req, res) => {
    const settings = await getSettings(req.orgId);
    const a = settings.aca;
    if (!a.measurementStart || !a.measurementEnd) return res.status(409).json({ success: false, error: 'Set the ACA measurement period first (Settings).' });
    const [people, weeks, offers] = await Promise.all([loadPeople(req.orgId), loadWeeks(req.orgId), loadAll('aca_offers', req.orgId)]);
    const byUser = {}; weeks.forEach((w) => { (byUser[w.userId] = byUser[w.userId] || []).push(w); });
    const data = people.filter((p) => p.active && p.classification !== '1099').map((p) => {
        const m = B.acaAverage(byUser[p.id] || [], a.measurementStart, a.measurementEnd, a.fullTimeHoursPerWeek);
        const mine = offers.filter((o) => o.userId === p.id);
        return { userId: p.id, employeeId: p.employeeId, name: p.name, averageWeeklyHours: m.averageWeeklyHours, weeksCounted: m.weeksCounted, fullTime: m.fullTime, offerRecords: mine.length, offered: mine.some((o) => o.offered) };
    }).sort((x, y) => x.name.localeCompare(y.name));
    res.json({ success: true, note: NOTE, measurement: { start: a.measurementStart, end: a.measurementEnd, threshold: a.fullTimeHoursPerWeek }, data, fullTimeNotOffered: data.filter((d) => d.fullTime && !d.offered).length });
});

router.get('/benefits/aca/offers', VIEW, requireUsOrg, async (req, res) => {
    let rows = await loadAll('aca_offers', req.orgId);
    if (req.query.userId) rows = rows.filter((o) => o.userId === req.query.userId);
    res.json({ success: true, data: rows.sort((a, b) => b.fromDate.localeCompare(a.fromDate)) });
});

router.post('/benefits/aca/offers', MANAGE, requireUsOrg, async (req, res) => {
    const person = await loadPerson(req.orgId, String((req.body && req.body.userId) || ''));
    if (!person) return res.status(404).json({ success: false, error: 'Employee not found' });
    const { errors, value } = B.validateOffer(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ref = await col('aca_offers').add({ ...value, orgId: req.orgId, userId: person.id, name: person.name, createdAt: nowIso(), createdBy: req.user.id });
    audit(req.orgId, req, 'aca_offer_recorded', ref.id, { userId: person.id, fromDate: value.fromDate, offered: value.offered });
    res.status(201).json({ success: true, offer: { id: ref.id, ...value, userId: person.id } });
});

router.delete('/benefits/aca/offers/:id', MANAGE, requireUsOrg, async (req, res) => {
    const o = await loadDoc('aca_offers', req, res, 'Offer'); if (!o) return;
    await o.ref.delete();
    audit(req.orgId, req, 'aca_offer_deleted', o.id, { userId: o.data.userId });
    res.json({ success: true });
});

router.get('/benefits/aca/1095c', VIEW, requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const year = Number(req.query.year || todayIn(info.tz).slice(0, 4));
    if (!Number.isInteger(year) || year < 2014 || year > 2100) return res.status(400).json({ success: false, error: 'year must be a 4-digit year' });
    const settings = await getSettings(req.orgId); const a = settings.aca;
    if (a.method === 'lookback' && (!a.measurementStart || !a.measurementEnd)) return res.status(409).json({ success: false, error: 'Set the ACA measurement period first (Settings).' });
    const [people, weeks, offers, enrollments] = await Promise.all([loadPeople(req.orgId), loadWeeks(req.orgId), loadAll('aca_offers', req.orgId), loadAll('benefit_enrollments', req.orgId)]);
    const rows = [];
    for (const p of people.filter((x) => x.active && x.classification === 'W2')) {
        const w = weeks.filter((x) => x.userId === p.id);
        const measurement = a.measurementStart && a.measurementEnd ? B.acaAverage(w, a.measurementStart, a.measurementEnd, a.fullTimeHoursPerWeek) : null;
        rows.push(...B.acaMonthlyRows({ person: p, year, aca: a, weeks: w, measurement, offers: offers.filter((o) => o.userId === p.id), enrolledMonths: B.enrolledMonthsOf(enrollments.filter((e) => e.userId === p.id), year) }));
    }
    audit(req.orgId, req, 'aca_1095c_exported', null, { year, rows: rows.length, format: req.query.format || 'json' });
    if (req.query.format === 'csv') {
        res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', `attachment; filename="aca_1095c_${year}.csv"`); res.set('Cache-Control', 'no-store');
        return res.send(B.toCsv(B.ACA_HEADER, rows));
    }
    res.json({ success: true, note: 'Offer codes are entered by HR on each offer record. This export is data for your tax advisor or filing service, not a filed form.', year, count: rows.length, data: rows });
});

/* ----------------------------------------- COBRA ----------------------------------------- */

const pubCobra = (c, cfg, today) => ({ id: c.id, userId: c.userId, name: c.name, eventType: c.eventType, eventDate: c.eventDate, lossOfCoverageDate: c.lossOfCoverageDate, status: c.status, employerNoticeSentOn: c.employerNoticeSentOn || null, electionNoticeSentOn: c.electionNoticeSentOn || null, electedOn: c.electedOn || null, waivedOn: c.waivedOn || null, firstPaymentOn: c.firstPaymentOn || null, deadlines: B.cobraDeadlines(c, cfg), alerts: B.cobraAlerts(c, cfg, today), history: c.history || [], createdAt: c.createdAt });

/** Used by this router and by offboarding: opens a record if the person had health coverage */
async function createCobraRecord({ orgId, req, userId, input, cfg }) {
    const person = await loadPerson(orgId, userId);
    if (!person) return { status: 404, error: 'Employee not found' };
    const v = B.validateCobraEvent(input, cfg);
    if (v.errors.length) return { status: 400, errors: v.errors };
    const enrollments = (await loadAll('benefit_enrollments', orgId)).filter((e) => e.userId === userId);
    const covered = enrollments.some((e) => B.activeOn(e, v.value.lossOfCoverageDate) && (e.elections || []).some((el) => !el.waived && B.HEALTH_TYPES.includes(el.type)));
    if (!covered) return { status: 409, error: 'This person has no active medical, dental or vision coverage on that date, so COBRA does not apply.' };
    const dup = (await loadAll('cobra_records', orgId)).find((c) => c.userId === userId && c.eventType === v.value.eventType && c.eventDate === v.value.eventDate && c.status !== 'terminated');
    if (dup) return { status: 409, error: 'A COBRA record for this event already exists' };
    const doc = { ...v.value, orgId, userId, name: person.name, employeeId: person.employeeId, status: 'pending_notice', history: [{ at: nowIso(), action: 'created', to: 'pending_notice', by: req ? req.user.id : 'system' }], createdAt: nowIso() };
    const ref = await col('cobra_records').add(doc);
    return { status: 201, record: { id: ref.id, ...doc } };
}

router.get('/benefits/cobra', VIEW, requireUsOrg, async (req, res) => {
    const [cfg, rows, info] = await Promise.all([getSettings(req.orgId), loadAll('cobra_records', req.orgId), orgInfo(req.orgId)]);
    const today = todayIn(info.tz);
    const data = rows.sort((a, b) => b.eventDate.localeCompare(a.eventDate)).map((c) => pubCobra(c, cfg.cobra, today));
    res.json({ success: true, note: cfg.cobra.note, events: cfg.cobra.events, data, alerts: data.filter((d) => d.alerts.length).length });
});

router.post('/benefits/cobra', MANAGE, requireUsOrg, async (req, res) => {
    const cfg = await getSettings(req.orgId);
    const r = await createCobraRecord({ orgId: req.orgId, req, userId: String((req.body && req.body.userId) || ''), input: req.body, cfg: cfg.cobra });
    if (r.status !== 201) return res.status(r.status).json(r.errors ? { success: false, errors: r.errors } : { success: false, error: r.error });
    audit(req.orgId, req, 'cobra_record_created', r.record.id, { userId: r.record.userId, eventType: r.record.eventType });
    const info = await orgInfo(req.orgId);
    res.status(201).json({ success: true, record: pubCobra(r.record, cfg.cobra, todayIn(info.tz)) });
});

router.post('/benefits/cobra/:id/action', MANAGE, requireUsOrg, async (req, res) => {
    const c = await loadDoc('cobra_records', req, res, 'COBRA record'); if (!c) return;
    const [cfg, info] = await Promise.all([getSettings(req.orgId), orgInfo(req.orgId)]);
    const today = todayIn(info.tz);
    const b = req.body || {};
    const r = B.applyCobraAction(c.data, String(b.action || ''), b, cfg.cobra, today);
    if (r.errors.length) return res.status(r.conflict ? 409 : 400).json({ success: false, errors: r.errors });
    const { historyEntry, ...patch } = r.patch;
    await c.ref.update({ ...patch, history: [...(c.data.history || []), { ...historyEntry, by: req.user.id }] });
    audit(req.orgId, req, `cobra_${b.action}`, c.id, { userId: c.data.userId, to: patch.status });
    res.json({ success: true, record: pubCobra({ id: c.id, ...c.data, ...patch }, cfg.cobra, today) });
});

router.helpers = { createCobraRecord, getSettings, buildFeed };
module.exports = router;
