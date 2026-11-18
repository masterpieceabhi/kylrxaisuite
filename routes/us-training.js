/**
 * Training records (US), mounted at /api/us.
 *
 * Who may define trainings, record and confirm completions: HR and the owner (compliance.manage).
 * Who may see every training, everyone's records and the report: HR, the owner and the auditor (compliance.view).
 * Everyone signed in to the company sees the trainings on their own list and may say "I completed this";
 * that only counts once HR confirms it.
 *
 * The system does not know which trainings any law requires. The company keeps its own list.
 */
const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { can, canonicalRole, requirePermission, ROLE_LABELS } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const T = require('../services/training-rules');
const peopleStore = require('../services/people-data-store');

router.use(verifyToken);

const MANAGE = [requirePermission('compliance.manage'), requireUsOrg];
const VIEW = [requirePermission('compliance.view'), requireUsOrg];
const nowIso = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const todayFor = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const col = (n) => rawCollection(n);
const me = (req) => String(req.user.id || req.user.uid);
const mayManage = (req) => can(req.user, 'compliance.manage');
const maySeeAll = (req) => can(req.user, 'compliance.view');
const completionId = (trainingId, userId, day) => `${trainingId}_${userId}_${day}`;

const byOrg = (name, orgId) => peopleStore.listByOrg(name, orgId);

/** Everyone in the company with the facts a training rule looks at. Left people are marked inactive. */
async function loadPeople(orgId, today) {
    const [users, roster, departments, locations] = await Promise.all([byOrg('users', orgId), byOrg('employees', orgId), byOrg('departments', orgId), byOrg('locations', orgId)]);
    const seen = new Set(users.map((u) => u.employeeId).filter(Boolean));
    const dep = new Map(departments.map((d) => [d.id, d.name])); const loc = new Map(locations.map((l) => [l.id, l.name]));
    return [...users, ...roster.filter((r) => !r.employeeId || !seen.has(r.employeeId))].filter((p) => p.employeeId || p.usProfile).map((p) => {
        const up = p.usProfile || {};
        const lastDay = up.termination && up.termination.lastDay ? String(up.termination.lastDay).slice(0, 10) : null;
        return {
            id: p.id, employeeId: p.employeeId || null, name: p.name || [up.legalFirstName, up.legalLastName].filter(Boolean).join(' ') || p.email || p.id,
            role: canonicalRole(p.role), jobTitle: up.jobTitle || p.jobTitle || null,
            departmentId: up.departmentId || null, department: dep.get(up.departmentId) || p.departmentName || p.department || null,
            workLocationId: up.workLocationId || null, workLocation: loc.get(up.workLocationId) || null,
            startDate: String(up.startDate || p.joiningDate || '').slice(0, 10) || null,
            active: peopleStore.isActivePerson(p) && !(lastDay && lastDay < today)
        };
    });
}
const loadTrainings = async (orgId) => (await byOrg('trainings', orgId)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
const loadCompletions = (orgId) => byOrg('training_completions', orgId);

async function ownedTraining(req, res) {
    const t = await peopleStore.getOwned('trainings', req.orgId, req.params.id);
    if (!t) { fail(res, 404, 'Training not found'); return null; }
    return t;
}
const pubTraining = (t) => ({ id: t.id, name: t.name, description: t.description || '', audience: t.audience || { type: 'everyone', values: [] }, repeatMonths: t.repeatMonths || null, dueWithinDays: t.dueWithinDays === undefined ? T.DUE_DAYS_DEFAULT : t.dueWithinDays, link: t.link || null, active: t.active !== false, createdAt: t.createdAt || null, updatedAt: t.updatedAt || null });
const pubCompletion = (c, names = {}, trainings = {}) => ({ id: c.id, trainingId: c.trainingId, training: trainings[c.trainingId] || c.trainingName || '', userId: c.userId, name: names[c.userId] || c.name || '', completedOn: c.completedOn, note: c.note || '', status: c.status, enteredBy: c.enteredBy || 'hr', reportedAt: c.reportedAt || null, decidedAt: c.decidedAt || null, decisionNote: c.decisionNote || '' });

/** Checks that group choices are this company's own departments and locations, and known roles */
async function audienceErrors(orgId, audience) {
    if (!audience || audience.type === 'everyone' || audience.type === 'job_title') return [];
    if (audience.type === 'role') { const bad = audience.values.filter((v) => !ROLE_LABELS[v]); return bad.length ? [`Unknown role: ${bad.join(', ')}`] : []; }
    const rows = await byOrg(audience.type === 'department' ? 'departments' : 'locations', orgId);
    const ids = new Set(rows.map((r) => r.id));
    const bad = audience.values.filter((v) => !ids.has(v));
    return bad.length ? [`${audience.type === 'department' ? 'Department' : 'Location'} not found in this company: ${bad.join(', ')}`] : [];
}

/* ------------------------------ options ------------------------------ */

router.get('/training/options', requireUsOrg, async (req, res) => {
    const out = { success: true, note: T.NOTE, canManage: mayManage(req), canSeeAll: maySeeAll(req), dueDaysDefault: T.DUE_DAYS_DEFAULT, soonDays: T.SOON_DAYS };
    if (!maySeeAll(req)) return res.json(out);
    const t = await todayFor(req.orgId);
    const [departments, locations, people] = await Promise.all([byOrg('departments', req.orgId), byOrg('locations', req.orgId), loadPeople(req.orgId, t)]);
    const active = people.filter((p) => p.active);
    return res.json({
        ...out, today: t, audienceTypes: T.AUDIENCE_TYPES,
        departments: departments.filter((d) => d.active !== false).map((d) => ({ id: d.id, name: d.name })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        locations: locations.filter((l) => l.active !== false).map((l) => ({ id: l.id, name: l.name })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        roles: Object.entries(ROLE_LABELS).map(([id, name]) => ({ id, name })),
        jobTitles: [...new Set(active.map((p) => p.jobTitle).filter(Boolean))].sort(),
        people: active.map((p) => ({ id: p.id, name: p.name, employeeId: p.employeeId })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
    });
});

/* ------------------------------ the person's own list ------------------------------ */

async function mineFor(req) {
    const t = await todayFor(req.orgId);
    const [people, trainings, completions] = await Promise.all([loadPeople(req.orgId, t), loadTrainings(req.orgId), loadCompletions(req.orgId)]);
    const person = people.find((p) => p.id === me(req)) || null;
    return { today: t, person, trainings, completions: completions.filter((c) => c.userId === me(req)) };
}

router.get('/training/mine', requireUsOrg, async (req, res) => {
    const { today, person, trainings, completions } = await mineFor(req);
    res.set('Cache-Control', 'no-store');
    if (!person) return res.json({ success: true, today, note: T.NOTE, data: [] });
    const data = trainings.filter((t) => T.appliesTo(t, person)).map((t) => {
        const own = completions.filter((c) => c.trainingId === t.id);
        const s = T.personStatus(t, person, own, today);
        const rejected = own.filter((c) => c.status === 'rejected').sort((a, b) => String(b.decidedAt || '').localeCompare(String(a.decidedAt || '')))[0];
        return { id: t.id, name: t.name, description: t.description || '', link: t.link || null, repeatMonths: t.repeatMonths || null, ...s, canReport: !T.reportError(t, person, own, today),
            lastAnswer: rejected && !s.waitingForHr && s.status !== 'done' ? { status: 'rejected', note: rejected.decisionNote || '', completedOn: rejected.completedOn } : null };
    }).sort((a, b) => T.STATUSES.indexOf(a.status) - T.STATUSES.indexOf(b.status) || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) || String(a.name).localeCompare(String(b.name)));
    return res.json({ success: true, today, waiting: data.filter((d) => d.status !== 'done' && !d.waitingForHr).length, data });
});

/** "I completed this": recorded as reported, counted only after HR confirms */
router.post('/training/mine/:id/complete', requireUsOrg, async (req, res) => {
    const training = await ownedTraining(req, res); if (!training) return undefined;
    const { today, person, completions } = await mineFor(req);
    if (!person) return fail(res, 404, 'No employee record for this login');
    const { errors, value } = T.validateCompletion(req.body, today, { byEmployee: true });
    if (errors.length) return invalid(res, errors);
    const refuse = T.reportError(training, person, completions.filter((c) => c.trainingId === training.id), today);
    if (refuse) return fail(res, /not on your list/.test(refuse) ? 403 : 409, refuse);
    const ref = col('training_completions').doc(completionId(training.id, person.id, value.completedOn));
    const doc = { orgId: req.orgId, trainingId: training.id, trainingName: training.name, userId: person.id, name: person.name, completedOn: value.completedOn, note: value.note, status: 'reported', enteredBy: 'employee', reportedAt: nowIso(), reportedBy: me(req), decidedAt: null, decidedBy: null, decisionNote: '' };
    const conflict = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (exists(snap)) {
            const old = snap.data();
            if (old.orgId !== req.orgId) return 'Record conflict';
            if (old.status === 'reported') return 'You already told HR you completed this. HR has not confirmed it yet.';
            if (old.status === 'confirmed') return 'This training is already recorded as done for that day';
        }
        tx.set(ref, doc);
        return null;
    });
    if (conflict) return fail(res, 409, conflict);
    audit(req.orgId, req, 'training_completion_reported', person.id, { trainingId: training.id, completionId: ref.id, completedOn: value.completedOn });
    return res.status(201).json({ success: true, completion: pubCompletion({ id: ref.id, ...doc }) });
});

/* ------------------------------ report ------------------------------ */

async function buildReport(orgId) {
    const today = await todayFor(orgId);
    const [people, trainings, completions] = await Promise.all([loadPeople(orgId, today), loadTrainings(orgId), loadCompletions(orgId)]);
    return { today, people, trainings, completions, rows: T.reportRows(trainings, people, completions, today) };
}

router.get('/training/report', ...VIEW, async (req, res) => {
    const r = await buildReport(req.orgId);
    let rows = r.rows;
    const summary = T.summarize(rows);
    if (req.query.trainingId) rows = rows.filter((x) => x.trainingId === req.query.trainingId);
    if (req.query.status) { if (!T.STATUSES.includes(req.query.status)) return fail(res, 400, `status must be one of: ${T.STATUSES.join(', ')}`); rows = rows.filter((x) => x.status === req.query.status); }
    if (req.query.format === 'csv') {
        audit(req.orgId, req, 'training_report_exported', null, { rows: rows.length });
        res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', `attachment; filename="training-${r.today}.csv"`); res.set('Cache-Control', 'no-store');
        return res.send(T.toCsv(rows));
    }
    return res.json({ success: true, note: T.NOTE, today: r.today, summary, count: rows.length, data: rows.slice(0, 2000) });
});

/* ------------------------------ completions (HR) ------------------------------ */

router.get('/training/completions', ...VIEW, async (req, res) => {
    const t = await todayFor(req.orgId);
    const [all, people, trainings] = await Promise.all([loadCompletions(req.orgId), loadPeople(req.orgId, t), loadTrainings(req.orgId)]);
    const names = Object.fromEntries(people.map((p) => [p.id, p.name])); const tn = Object.fromEntries(trainings.map((x) => [x.id, x.name]));
    let rows = all.filter((c) => c.status !== 'removed');
    for (const k of ['status', 'userId', 'trainingId']) if (req.query[k]) rows = rows.filter((c) => c[k] === req.query[k]);
    rows.sort((a, b) => String(b.reportedAt || b.completedOn).localeCompare(String(a.reportedAt || a.completedOn)));
    res.json({ success: true, count: rows.length, waiting: all.filter((c) => c.status === 'reported').length, data: rows.slice(0, 500).map((c) => pubCompletion(c, names, tn)) });
});

/** HR records that a person finished a training (counts at once). If the person had reported that day, this confirms it. */
router.post('/training/:id/completions', ...MANAGE, async (req, res) => {
    const training = await ownedTraining(req, res); if (!training) return undefined;
    const today = await todayFor(req.orgId);
    const { errors, value } = T.validateCompletion(req.body, today);
    if (errors.length) return invalid(res, errors);
    const person = (await loadPeople(req.orgId, today)).find((p) => p.id === value.userId || p.employeeId === value.userId);
    if (!person) return fail(res, 404, 'Employee not found');
    const ref = col('training_completions').doc(completionId(training.id, person.id, value.completedOn));
    const stamp = nowIso();
    const doc = { orgId: req.orgId, trainingId: training.id, trainingName: training.name, userId: person.id, name: person.name, completedOn: value.completedOn, note: value.note, status: 'confirmed', enteredBy: 'hr', reportedAt: stamp, reportedBy: me(req), decidedAt: stamp, decidedBy: me(req), decisionNote: '' };
    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (exists(snap)) {
            const old = snap.data();
            if (old.orgId !== req.orgId) return { conflict: 'Record conflict' };
            if (old.status === 'confirmed') return { conflict: 'This completion is already recorded for that day' };
            if (old.status === 'reported') { const merged = { ...old, status: 'confirmed', note: value.note || old.note || '', decidedAt: stamp, decidedBy: me(req) }; tx.set(ref, merged); return { doc: merged, confirmedReport: true }; }
        }
        tx.set(ref, doc);
        return { doc };
    });
    if (result.conflict) return fail(res, 409, result.conflict);
    audit(req.orgId, req, 'training_completion_recorded', person.id, { trainingId: training.id, completionId: ref.id, completedOn: value.completedOn, confirmedReport: Boolean(result.confirmedReport) });
    return res.status(201).json({ success: true, completion: pubCompletion({ id: ref.id, ...result.doc }) });
});

async function decide(req, res, status) {
    const note = T.clean(req.body && req.body.note, 300);
    if (status === 'rejected' && note.length < 3) return invalid(res, ['Tell the person why (at least 3 characters)']);
    const ref = col('training_completions').doc(String(req.params.id));
    const before = await ref.get();
    if (exists(before) && before.data().orgId === req.orgId && !(await require('../services/own-request').guard(req, res, before.data().userId, 'compliance.manage', status === 'confirmed' ? 'confirm your own training' : 'reject your own training'))) return undefined;
    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!exists(snap) || snap.data().orgId !== req.orgId) return { code: 404, error: 'Record not found' };
        const c = snap.data();
        if (c.status !== 'reported') return { code: 409, error: `This record is already ${c.status}` };
        const patch = { status, decidedAt: nowIso(), decidedBy: me(req), decisionNote: note };
        tx.update(ref, patch);
        return { doc: { id: snap.id, ...c, ...patch } };
    });
    if (result.error) return fail(res, result.code, result.error);
    audit(req.orgId, req, status === 'confirmed' ? 'training_completion_confirmed' : 'training_completion_rejected', result.doc.userId, { trainingId: result.doc.trainingId, completionId: result.doc.id });
    return res.json({ success: true, completion: pubCompletion(result.doc) });
}
router.post('/training/completions/:id/confirm', ...MANAGE, (req, res) => decide(req, res, 'confirmed'));
router.post('/training/completions/:id/reject', ...MANAGE, (req, res) => decide(req, res, 'rejected'));

/** Takes back a completion entered by mistake. The record is kept, marked removed, and no longer counts. */
router.post('/training/completions/:id/remove', ...MANAGE, async (req, res) => {
    const note = T.clean(req.body && req.body.note, 300);
    if (note.length < 3) return invalid(res, ['Say why this record is being removed (at least 3 characters)']);
    const c = await peopleStore.getOwned('training_completions', req.orgId, req.params.id);
    if (!c) return fail(res, 404, 'Record not found');
    if (c.status === 'removed') return fail(res, 409, 'This record is already removed');
    await c.ref.update({ status: 'removed', removedAt: nowIso(), removedBy: me(req), decisionNote: note });
    audit(req.orgId, req, 'training_completion_removed', c.userId, { trainingId: c.trainingId, completionId: c.id, was: c.status });
    return res.json({ success: true });
});

/* ------------------------------ trainings (HR) ------------------------------ */

router.get('/training', ...VIEW, async (req, res) => {
    const r = await buildReport(req.orgId);
    const counts = new Map();
    for (const row of r.rows) { const c = counts.get(row.trainingId) || { people: 0, overdue: 0, due: 0, done: 0 }; c.people += 1; c[row.status] += 1; counts.set(row.trainingId, c); }
    res.json({ success: true, note: T.NOTE, today: r.today, canManage: mayManage(req), waiting: r.completions.filter((c) => c.status === 'reported').length,
        data: r.trainings.map((t) => ({ ...pubTraining(t), counts: counts.get(t.id) || { people: 0, overdue: 0, due: 0, done: 0 } })) });
});

router.post('/training', ...MANAGE, async (req, res) => {
    const { errors, value } = T.validateTraining(req.body);
    if (!errors.length) errors.push(...await audienceErrors(req.orgId, value.audience));
    if (errors.length) return invalid(res, errors);
    const doc = { ...value, description: value.description || '', orgId: req.orgId, active: true, createdAt: nowIso(), createdBy: me(req) };
    const ref = await col('trainings').add(doc);
    audit(req.orgId, req, 'training_created', ref.id, { name: value.name, audience: value.audience.type, repeatMonths: value.repeatMonths });
    return res.status(201).json({ success: true, training: pubTraining({ id: ref.id, ...doc }) });
});

router.put('/training/:id', ...MANAGE, async (req, res) => {
    const t = await ownedTraining(req, res); if (!t) return undefined;
    const { errors, value } = T.validateTraining(req.body, { partial: true });
    if (!errors.length && value.audience) errors.push(...await audienceErrors(req.orgId, value.audience));
    if (errors.length) return invalid(res, errors);
    const patch = { ...value, updatedAt: nowIso(), updatedBy: me(req) };
    await t.ref.update(patch);
    audit(req.orgId, req, 'training_updated', t.id, { fields: Object.keys(value) });
    const { ref, ...old } = t;
    return res.json({ success: true, training: pubTraining({ ...old, ...patch }) });
});

/** Only a training nobody has a record for can be deleted. Otherwise switch it off, so the records are kept. */
router.delete('/training/:id', ...MANAGE, async (req, res) => {
    const t = await ownedTraining(req, res); if (!t) return undefined;
    const has = (await loadCompletions(req.orgId)).some((c) => c.trainingId === t.id);
    if (has) return fail(res, 409, 'People have records for this training, so it cannot be deleted. Switch it off instead; the records are kept.');
    await t.ref.delete();
    audit(req.orgId, req, 'training_deleted', t.id, { name: t.name });
    return res.json({ success: true });
});

/** For the compliance report: who has overdue or due trainings. Map of userId -> { overdue: [names], due: [names] } */
async function statusByPerson(orgId) {
    return T.byPerson((await buildReport(orgId)).rows);
}

router.helpers = { statusByPerson, buildReport, loadPeople };
module.exports = router;
