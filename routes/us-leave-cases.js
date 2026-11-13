const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { requirePermission, requireAnyPermission, can } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const C = require('../services/leave-cases-rules');
const { loadPeople, loadPerson, loadWeeks } = require('../services/us-people-loader');
const { parseIsoDate } = require('../services/us-forms');

router.use(verifyToken);

const VIEW_ALL = requirePermission('leave.view_all');
const DECIDE = requirePermission('leave.decide');
const NOTE = 'Leave rules differ by state and change over time. Confirm with counsel.';
const todayIn = (tz) => timeRules.localDate(new Date().toISOString(), tz);
const round2 = (n) => Math.round(n * 100) / 100;

async function getConfig(orgId) {
    const snap = await rawCollection('leave_case_settings').doc(orgId).get();
    const stored = exists(snap) ? snap.data() : {};
    return { settings: { ...C.DEFAULT_SETTINGS, ...(stored.settings || {}) }, types: stored.types && stored.types.length ? stored.types : C.DEFAULT_LEAVE_TYPES, stored: Boolean(exists(snap)) };
}

async function loadCases(orgId, userId) {
    const snap = await rawCollection('leave_cases').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => !userId || c.userId === userId);
}

async function loadCase(req, res) {
    const snap = await rawCollection('leave_cases').doc(req.params.id).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { res.status(404).json({ success: false, error: 'Case not found' }); return null; }
    return { id: snap.id, ref: snap.ref, data: snap.data() };
}

async function locationsOf(orgId) {
    try {
        const snap = await rawCollection('locations').where('orgId', '==', orgId).get();
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    } catch (_) { return []; }
}

async function computeEligibility(orgId, person, asOf, cfg) {
    const [weeks, people, locations] = await Promise.all([loadWeeks(orgId, person.id), loadPeople(orgId), locationsOf(orgId)]);
    const headcount = C.worksiteHeadcount(people, locations, person, cfg.worksiteRadiusMiles);
    return C.fmlaEligibility({ hireDate: person.hireDate, asOf, weeks, headcount, exempt: person.flsaStatus === 'exempt' }, cfg);
}

function balanceOf(cases, userId, reason, weeklyHours, refDate, cfg) {
    const usage = cases.filter((c) => c.userId === userId && c.typeKey === 'fmla' && !['denied', 'cancelled'].includes(c.status)).flatMap((c) => c.usage || []);
    return C.fmlaBalance({ usage, reason, weeklyHours, refDate }, cfg);
}

function view(c, { cases, cfg, today, hr }) {
    const base = hr ? c : C.publicCase(c);
    const out = { ...base, deadlines: base.deadlines || {}, deadlineList: C.deadlineList(c, today) };
    if (c.typeKey === 'fmla' && cases) out.balance = balanceOf(cases, c.userId, c.fmlaReason, c.weeklyHours, today, cfg);
    return out;
}

/* ------------------------------- types and settings ------------------------------- */

router.get('/leave-cases/types', requireUsOrg, async (req, res) => {
    const [{ types }, me] = await Promise.all([getConfig(req.orgId), loadPerson(req.orgId, req.user.id)]);
    const data = types.filter((t) => t.active !== false && C.typeAppliesToState(t, me && me.workState));
    res.json({ success: true, note: NOTE, data: data.map((t) => ({ key: t.key, label: t.label, labelEs: t.labelEs || t.label, paid: t.paid, maxDays: t.maxDays, statutory: t.statutory === true, confirmed: t.confirmed === true })) });
});

router.get('/leave-cases/config', VIEW_ALL, requireUsOrg, async (req, res) => {
    const cfg = await getConfig(req.orgId);
    res.json({ success: true, note: NOTE, settings: cfg.settings, types: cfg.types, customized: cfg.stored, methods: C.PERIOD_METHODS });
});

router.put('/leave-cases/config/settings', requirePermission('leave.policies'), requireUsOrg, async (req, res) => {
    const cfg = await getConfig(req.orgId);
    const { errors, value } = C.validateSettings({ ...cfg.settings, ...req.body });
    if (errors.length) return res.status(400).json({ success: false, errors });
    await rawCollection('leave_case_settings').doc(req.orgId).set({ orgId: req.orgId, settings: value, types: cfg.types, updatedAt: new Date().toISOString(), updatedBy: req.user.id }, { merge: true });
    audit(req.orgId, req, 'leave_case_settings_updated', req.orgId, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, settings: value });
});

router.put('/leave-cases/config/types', requirePermission('leave.policies'), requireUsOrg, async (req, res) => {
    const list = req.body && req.body.types;
    if (!Array.isArray(list) || !list.length) return res.status(400).json({ success: false, errors: ['types must be a list with at least one row'] });
    const errors = []; const out = []; const seen = new Set();
    list.forEach((t, i) => {
        const r = C.validateLeaveType(t);
        if (r.errors.length) errors.push(...r.errors.map((e) => `row ${i + 1}: ${e}`));
        else if (seen.has(r.value.key)) errors.push(`row ${i + 1}: duplicate key ${r.value.key}`);
        else { seen.add(r.value.key); out.push(r.value); }
    });
    if (errors.length) return res.status(400).json({ success: false, errors });
    if (!seen.has('fmla')) return res.status(400).json({ success: false, errors: ['the fmla row cannot be removed (turn it off with active: false)'] });
    const cfg = await getConfig(req.orgId);
    await rawCollection('leave_case_settings').doc(req.orgId).set({ orgId: req.orgId, settings: cfg.settings, types: out, updatedAt: new Date().toISOString(), updatedBy: req.user.id }, { merge: true });
    audit(req.orgId, req, 'leave_case_types_updated', req.orgId, { rows: out.length });
    res.json({ success: true, types: out });
});

/* ------------------------------------ employee ------------------------------------ */

router.get('/leave-cases/mine', requireUsOrg, async (req, res) => {
    const [cfg, cases, info] = await Promise.all([getConfig(req.orgId), loadCases(req.orgId, req.user.id), orgInfo(req.orgId)]);
    const today = todayIn(info.tz);
    const mine = cases.sort((a, b) => String(b.requestedOn).localeCompare(String(a.requestedOn)));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, today, note: NOTE, data: mine.map((c) => view(c, { cases, cfg: cfg.settings, today, hr: false })) });
});

router.get('/leave-cases/eligibility/me', requireUsOrg, async (req, res) => {
    const [cfg, me, info] = await Promise.all([getConfig(req.orgId), loadPerson(req.orgId, req.user.id), orgInfo(req.orgId)]);
    if (!me) return res.status(404).json({ success: false, error: 'No employee record for this login' });
    res.json({ success: true, data: await computeEligibility(req.orgId, me, todayIn(info.tz), cfg.settings) });
});

async function createCase(req, res, person, requestedBy) {
    const [cfg, info] = await Promise.all([getConfig(req.orgId), orgInfo(req.orgId)]);
    const today = todayIn(info.tz);
    const { errors, warnings, value } = C.validateRequest(req.body, cfg.types, { today, workState: person.workState });
    if (errors.length) return res.status(400).json({ success: false, errors });
    const type = cfg.types.find((t) => t.key === value.typeKey);
    const doc = {
        orgId: req.orgId, userId: person.id, employeeId: person.employeeId, name: person.name, ...value, typeLabel: type.label, status: 'requested', requestedOn: today,
        requestedBy, weeklyHours: person.weeklyHours || cfg.settings.defaultWeeklyHours, deadlines: C.newCaseDeadlines(today, cfg.settings),
        usage: [], linkedRequestIds: [], jobProtected: false, hrNotes: '', history: [{ at: new Date().toISOString(), action: 'requested', by: requestedBy, to: 'requested' }], createdAt: new Date().toISOString()
    };
    if (type.key === 'fmla') doc.eligibility = await computeEligibility(req.orgId, person, today, cfg.settings);
    const ref = await rawCollection('leave_cases').add(doc);
    audit(req.orgId, req, 'leave_case_requested', ref.id, { userId: person.id, typeKey: value.typeKey, onBehalf: requestedBy !== person.id });
    res.status(201).json({ success: true, warnings, case: view({ id: ref.id, ...doc }, { cases: null, cfg: cfg.settings, today, hr: false }) });
}

router.post('/leave-cases/requests', requireUsOrg, async (req, res) => {
    const me = await loadPerson(req.orgId, req.user.id);
    if (!me) return res.status(404).json({ success: false, error: 'No employee record for this login' });
    return createCase(req, res, me, req.user.id);
});

router.post('/leave-cases/:id/cancel', requireUsOrg, async (req, res) => {
    const k = await loadCase(req, res); if (!k) return;
    if (k.data.userId !== req.user.id && !can(req.user, 'leave.decide')) return res.status(403).json({ success: false, error: 'You do not have permission to do this' });
    const info = await orgInfo(req.orgId); const cfg = await getConfig(req.orgId);
    const r = C.applyAction(k.data, 'cancel', { note: req.body && req.body.note }, cfg.settings, todayIn(info.tz));
    if (r.errors.length) return res.status(r.conflict ? 409 : 400).json({ success: false, errors: r.errors });
    const { historyEntry, ...patch } = r.patch;
    await k.ref.update({ ...patch, history: [...(k.data.history || []), { ...historyEntry, by: req.user.id }] });
    audit(req.orgId, req, 'leave_case_cancelled', k.id, { by: k.data.userId === req.user.id ? 'employee' : 'hr' });
    res.json({ success: true });
});

/* -------------------------------------- HR -------------------------------------- */

router.get('/leave-cases/people', VIEW_ALL, requireUsOrg, async (req, res) => {
    const people = (await loadPeople(req.orgId)).filter((p) => p.active);
    res.json({ success: true, data: people.map((p) => ({ id: p.id, employeeId: p.employeeId, name: p.name, workState: p.workState })) });
});

router.get('/leave-cases', VIEW_ALL, requireUsOrg, async (req, res) => {
    const [cfg, cases, info] = await Promise.all([getConfig(req.orgId), loadCases(req.orgId), orgInfo(req.orgId)]);
    const today = todayIn(info.tz);
    let rows = cases;
    if (req.query.status === 'open') rows = rows.filter((c) => C.OPEN_STATUSES.includes(c.status));
    else if (req.query.status) rows = rows.filter((c) => c.status === req.query.status);
    if (req.query.typeKey) rows = rows.filter((c) => c.typeKey === req.query.typeKey);
    if (req.query.userId) rows = rows.filter((c) => c.userId === req.query.userId);
    rows.sort((a, b) => String(b.requestedOn).localeCompare(String(a.requestedOn)));
    const data = rows.slice(0, 300).map((c) => { const v = view(c, { cases, cfg: cfg.settings, today, hr: true }); return { ...v, usage: undefined, usageCount: (c.usage || []).length, history: undefined }; });
    res.json({ success: true, today, count: rows.length, data, overdue: data.filter((c) => c.deadlineList.some((d) => d.overdue)).length });
});

router.post('/leave-cases', DECIDE, requireUsOrg, async (req, res) => {
    const person = await loadPerson(req.orgId, String((req.body && req.body.userId) || ''));
    if (!person) return res.status(404).json({ success: false, error: 'Employee not found' });
    return createCase(req, res, person, req.user.id);
});

router.get('/leave-cases/:id', VIEW_ALL, requireUsOrg, async (req, res) => {
    const k = await loadCase(req, res); if (!k) return;
    const [cfg, cases, info] = await Promise.all([getConfig(req.orgId), loadCases(req.orgId, k.data.userId), orgInfo(req.orgId)]);
    audit(req.orgId, req, 'leave_case_viewed', k.id, { userId: k.data.userId });
    res.json({ success: true, case: view({ id: k.id, ...k.data }, { cases, cfg: cfg.settings, today: todayIn(info.tz), hr: true }) });
});

router.post('/leave-cases/:id/action', DECIDE, requireUsOrg, async (req, res) => {
    const k = await loadCase(req, res); if (!k) return;
    const [cfg, info] = await Promise.all([getConfig(req.orgId), orgInfo(req.orgId)]);
    const b = req.body || {};
    const r = C.applyAction(k.data, String(b.action || ''), b, cfg.settings, todayIn(info.tz));
    if (r.errors.length) return res.status(r.conflict ? 409 : 400).json({ success: false, errors: r.errors });
    const { historyEntry, ...patch } = r.patch;
    await k.ref.update({ ...patch, history: [...(k.data.history || []), { ...historyEntry, by: req.user.id }], updatedAt: new Date().toISOString() });
    audit(req.orgId, req, `leave_case_${b.action}`, k.id, { userId: k.data.userId, from: k.data.status, to: patch.status || k.data.status });
    const cases = await loadCases(req.orgId, k.data.userId);
    res.json({ success: true, case: view({ id: k.id, ...k.data, ...patch, history: undefined }, { cases, cfg: cfg.settings, today: todayIn(info.tz), hr: true }) });
});

router.post('/leave-cases/:id/recalculate-eligibility', DECIDE, requireUsOrg, async (req, res) => {
    const k = await loadCase(req, res); if (!k) return;
    if (k.data.typeKey !== 'fmla') return res.status(409).json({ success: false, error: 'Eligibility applies to FMLA cases only' });
    const [cfg, info, person] = await Promise.all([getConfig(req.orgId), orgInfo(req.orgId), loadPerson(req.orgId, k.data.userId)]);
    const eligibility = await computeEligibility(req.orgId, person, todayIn(info.tz), cfg.settings);
    await k.ref.update({ eligibility });
    audit(req.orgId, req, 'leave_case_eligibility_recalculated', k.id, { eligible: eligibility.eligible });
    res.json({ success: true, eligibility });
});

router.put('/leave-cases/:id/notes', DECIDE, requireUsOrg, async (req, res) => {
    const k = await loadCase(req, res); if (!k) return;
    await k.ref.update({ hrNotes: String((req.body && req.body.hrNotes) || '').slice(0, 2000) });
    audit(req.orgId, req, 'leave_case_notes_updated', k.id);
    res.json({ success: true });
});

/** Hours taken: one day (date + hours) or a continuous block (startDate, endDate, hoursPerDay) */
router.post('/leave-cases/:id/usage', DECIDE, requireUsOrg, async (req, res) => {
    const k = await loadCase(req, res); if (!k) return;
    if (['denied', 'cancelled', 'closed', 'requested'].includes(k.data.status)) return res.status(409).json({ success: false, error: `Hours cannot be recorded while the case is ${k.data.status}` });
    const b = req.body || {}; const entries = []; const errors = [];
    if (b.startDate) {
        if (!parseIsoDate(b.startDate) || !parseIsoDate(b.endDate) || b.endDate < b.startDate) errors.push('startDate and endDate must be valid dates, endDate on or after startDate');
        else if (C.addDays(b.startDate, 400) < b.endDate) errors.push('That range is too long');
        else {
            const hpd = Number(b.hoursPerDay) > 0 ? Number(b.hoursPerDay) : round2((k.data.weeklyHours || 40) / 5);
            C.continuousUsage(b.startDate, b.endDate, hpd, 'continuous').forEach((u) => { const v = C.validateUsage(u); if (v.errors.length) errors.push(...v.errors); else entries.push(v.value); });
        }
    } else { const v = C.validateUsage({ ...b, source: 'manual' }); if (v.errors.length) errors.push(...v.errors); else entries.push(v.value); }
    if (errors.length) return res.status(400).json({ success: false, errors });
    const existing = new Set((k.data.usage || []).map((u) => `${u.date}|${u.source}|${u.requestId || ''}`));
    const fresh = entries.filter((u) => !existing.has(`${u.date}|${u.source}|${u.requestId || ''}`)).map((u, i) => ({ ...u, id: `u${Date.now().toString(36)}${i}`, by: req.user.id }));
    if (!fresh.length) return res.status(409).json({ success: false, error: 'Those days are already recorded' });
    const usage = [...(k.data.usage || []), ...fresh];
    await k.ref.update({ usage });
    audit(req.orgId, req, 'leave_case_usage_added', k.id, { entries: fresh.length, hours: round2(fresh.reduce((s, u) => s + u.hours, 0)) });
    const [cfg, info, cases] = await Promise.all([getConfig(req.orgId), orgInfo(req.orgId), loadCases(req.orgId, k.data.userId)]);
    res.status(201).json({ success: true, added: fresh.length, balance: k.data.typeKey === 'fmla' ? balanceOf(cases.map((c) => (c.id === k.id ? { ...c, usage } : c)), k.data.userId, k.data.fmlaReason, k.data.weeklyHours, todayIn(info.tz), cfg.settings) : null });
});

router.delete('/leave-cases/:id/usage/:entryId', DECIDE, requireUsOrg, async (req, res) => {
    const k = await loadCase(req, res); if (!k) return;
    const usage = k.data.usage || [];
    if (!usage.some((u) => u.id === req.params.entryId)) return res.status(404).json({ success: false, error: 'Entry not found' });
    await k.ref.update({ usage: usage.filter((u) => u.id !== req.params.entryId) });
    audit(req.orgId, req, 'leave_case_usage_removed', k.id, { entryId: req.params.entryId });
    res.json({ success: true });
});

/** Count an approved leave request (from the leave module) against this case */
router.post('/leave-cases/:id/link-request', DECIDE, requireUsOrg, async (req, res) => {
    const k = await loadCase(req, res); if (!k) return;
    const rsnap = await rawCollection('leave_requests').doc(String((req.body && req.body.requestId) || '_')).get();
    if (!exists(rsnap) || rsnap.data().orgId !== req.orgId || rsnap.data().userId !== k.data.userId) return res.status(404).json({ success: false, error: 'Leave request not found for this person' });
    const lr = rsnap.data();
    if (lr.status !== 'approved') return res.status(409).json({ success: false, error: 'Only approved leave requests can be linked' });
    if ((k.data.linkedRequestIds || []).includes(rsnap.id)) return res.status(409).json({ success: false, error: 'That request is already linked' });
    const fresh = (lr.dates || []).map((date, i) => ({ date, hours: Number(lr.hoursPerDay) || 8, kind: k.data.pattern || 'continuous', source: 'leave_request', requestId: rsnap.id, id: `l${Date.now().toString(36)}${i}`, by: req.user.id }));
    await k.ref.update({ usage: [...(k.data.usage || []), ...fresh], linkedRequestIds: [...(k.data.linkedRequestIds || []), rsnap.id] });
    audit(req.orgId, req, 'leave_case_request_linked', k.id, { requestId: rsnap.id, days: fresh.length });
    res.status(201).json({ success: true, added: fresh.length, hours: round2(fresh.reduce((s, u) => s + u.hours, 0)) });
});

router.helpers = { getConfig, loadCases, computeEligibility };
module.exports = router;
