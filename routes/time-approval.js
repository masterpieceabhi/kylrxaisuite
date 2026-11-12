const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { orgInfo, punchesSince, weekIsLocked } = require('./time').helpers;
const rules = require('../services/time-rules');
const policy = require('../services/time-policy');
const { parseIsoDate, isoDate } = require('../services/us-forms');
const perms = require('../services/permissions');
const teamScope = require('../services/team-scope');
const APPROVER = perms.requireAnyPermission('time.approve', 'time.approve_team');

const MANAGER_ROLES = [...ADMIN_HR_ROLES, 'Manager', 'manager'];
const RULE_ROLES = ['Super Admin', 'super_admin', 'hr_admin', 'Admin'];
const MAX_CORRECTION_AGE_DAYS = 60;

router.use(verifyToken);

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const norm = (r) => String(r || '').toLowerCase().replace(/[\s_-]+/g, '');
const hasRole = (user, list) => list.some((r) => norm(r) === norm(user.role));
const hours = policy.toHours;

function requireOrg(req, res, next) {
    const orgId = req.user.orgId || req.tenantOrgId;
    if (!orgId) return res.status(404).json({ success: false, error: 'No organization for this user' });
    req.orgId = orgId;
    next();
}

const addDays = (iso, n) => { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };
const isMonday = (iso) => Boolean(parseIsoDate(iso)) && rules.weekStart(iso) === iso;
const weekDocRef = (userId, weekStart) => rawCollection('timesheet_weeks').doc(`${userId}_${weekStart}`);
const localTimeOf = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

async function userDoc(orgId, userId) {
    const snap = await rawCollection('users').doc(userId).get();
    if (!exists(snap) || snap.data().orgId !== orgId) return null;
    return { id: snap.id, ref: snap.ref, data: snap.data() };
}

/** Everything about one person's workweek: pay-hour split, flags, each day's punches */
async function weekView(orgId, user, weekStart, info) {
    const weekEnd = addDays(weekStart, 6);
    const sinceIso = new Date(new Date(`${weekStart}T00:00:00Z`).getTime() - 86400000).toISOString();
    const nowIso = new Date().toISOString();
    const punches = (await punchesSince(orgId, user.id, sinceIso)).filter((p) => p.localDate <= addDays(weekEnd, 1));
    const sheet = rules.timesheet(punches, info.tz, nowIso, null);
    const dayRows = sheet.days.filter((d) => d.date >= weekStart && d.date <= weekEnd);
    const exempt = Boolean(user.data.usProfile && user.data.usProfile.flsaStatus === 'exempt');
    const pay = policy.computeWeek(dayRows, info.rules, { exempt });
    const days = pay.days.map((d) => ({
        date: d.date, workedHours: hours(d.workedMinutes), regularHours: hours(d.regularMinutes), overtimeHours: hours(d.overtimeMinutes),
        doubleTimeHours: hours(d.doubleTimeMinutes), flags: d.flags,
        breakMinutes: (dayRows.find((x) => x.date === d.date) || {}).breakMinutes || 0,
        punches: punches.filter((p) => p.localDate === d.date).map((p) => ({ id: p.id, type: p.type, time: localTimeOf(p.at, info.tz), source: p.source }))
    }));
    const open = rules.stateOf(punches) !== 'out' && punches.some((p) => p.localDate >= weekStart && p.localDate <= weekEnd);
    return {
        weekStart, weekEnd, exempt, openShift: open,
        forgottenClockOut: rules.isForgottenClockOut(punches, nowIso),
        days, flags: pay.flags,
        totals: { workedHours: hours(pay.totals.workedMinutes), regularHours: hours(pay.totals.regularMinutes), overtimeHours: hours(pay.totals.overtimeMinutes), doubleTimeHours: hours(pay.totals.doubleTimeMinutes) }
    };
}

const statusView = (doc) => (doc ? {
    status: doc.status, submittedAt: doc.submittedAt || null, decidedAt: doc.decidedAt || null, decidedBy: doc.decidedBy || null, decisionNote: doc.decisionNote || null
} : { status: 'open' });

async function targetUser(req, res) {
    const userId = req.query.userId && req.query.userId !== req.user.id ? String(req.query.userId) : req.user.id;
    const u = await userDoc(req.orgId, userId);
    if (!u) { res.status(404).json({ success: false, error: 'Person not found' }); return null; }
    if (userId !== req.user.id && !perms.can(req.user, 'time.view_all') && !perms.canManage(req.user, { ...u.data, id: u.id }, 'time')) {
        res.status(403).json({ success: false, error: 'Not allowed' }); return null;
    }
    return u;
}

/* -------------------------------- company rules -------------------------------- */

router.get('/rules', requireOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    res.json({ success: true, country: info.country, timeZone: info.tz, rules: info.rules, note: 'Daily overtime, double time and meal-break rules depend on your state. Confirm each setting with a US compliance advisor.' });
});

router.put('/rules', perms.requirePermission('time.manage_rules'), requireOrg, async (req, res) => {
    const { errors, value } = policy.validateTimeRules(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    await rawCollection('organizations').doc(req.orgId).set({ usProfile: { timeRules: value } }, { merge: true });
    rawCollection('organizations').doc(req.orgId).collection('audit_logs').add({ action: 'time_rules_updated', targetId: req.orgId, actorId: req.user.id, at: new Date().toISOString(), rules: value }).catch(() => {});
    res.json({ success: true, rules: value });
});

/* -------------------------------- weekly timesheets -------------------------------- */

router.get('/weeks/:weekStart', requireOrg, async (req, res) => {
    if (!isMonday(req.params.weekStart)) return res.status(400).json({ success: false, error: 'weekStart must be a Monday (YYYY-MM-DD)' });
    const user = await targetUser(req, res); if (!user) return;
    const info = await orgInfo(req.orgId);
    const doc = await weekDocRef(user.id, req.params.weekStart).get();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, userId: user.id, name: user.data.name || null, timeZone: info.tz, today: rules.localDate(new Date().toISOString(), info.tz),
        ...statusView(exists(doc) ? doc.data() : null), ...(await weekView(req.orgId, user, req.params.weekStart, info)) });
});

router.post('/weeks/:weekStart/submit', requireOrg, async (req, res) => {
    const weekStart = req.params.weekStart;
    if (!isMonday(weekStart)) return res.status(400).json({ success: false, error: 'weekStart must be a Monday (YYYY-MM-DD)' });
    const info = await orgInfo(req.orgId);
    const today = rules.localDate(new Date().toISOString(), info.tz);
    if (weekStart > rules.weekStart(today)) return res.status(400).json({ success: false, error: 'That week has not started yet' });
    const user = await userDoc(req.orgId, req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'No employee record for this login' });
    const ref = weekDocRef(user.id, weekStart);
    const existing = await ref.get();
    const cur = exists(existing) ? existing.data() : null;
    if (cur && ['submitted', 'approved'].includes(cur.status)) return res.status(409).json({ success: false, error: `This week is already ${cur.status}` });
    const view = await weekView(req.orgId, user, weekStart, info);
    if (view.openShift) return res.status(409).json({ success: false, error: 'Clock out before you send your hours' });
    await ref.set({
        orgId: req.orgId, userId: user.id, employeeId: user.data.employeeId || null, name: user.data.name || null, weekStart,
        status: 'submitted', submittedAt: new Date().toISOString(), submittedBy: req.user.id, totals: view.totals, flags: view.flags, decisionNote: null, decidedAt: null, decidedBy: null
    });
    res.json({ success: true, status: 'submitted', totals: view.totals });
});

router.get('/approvals', APPROVER, requireOrg, async (req, res) => {
    const status = ['submitted', 'approved', 'rejected', 'open'].includes(req.query.status) ? req.query.status : 'submitted';
    const snap = await rawCollection('timesheet_weeks').where('orgId', '==', req.orgId).get();
    const rows = (await teamScope.filterRows(req.user, req.orgId, snap.docs.map((d) => ({ id: d.id, ...d.data() })), 'time')).filter((w) => w.status === status)
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || String(a.name).localeCompare(String(b.name)));
    res.json({ success: true, status, count: rows.length, data: rows.slice(0, 300) });
});

router.put('/weeks/:userId/:weekStart/decision', APPROVER, requireOrg, async (req, res) => {
    const { userId, weekStart } = req.params;
    if (!isMonday(weekStart)) return res.status(400).json({ success: false, error: 'weekStart must be a Monday (YYYY-MM-DD)' });
    if (userId === req.user.id) return res.status(403).json({ success: false, error: 'You cannot approve your own hours' });
    const decision = String((req.body && req.body.decision) || '');
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ success: false, error: 'decision must be approve or reject' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
    if (decision === 'reject' && note.length < 3) return res.status(400).json({ success: false, error: 'Say what needs fixing (at least 3 characters)' });
    const user = await userDoc(req.orgId, userId);
    if (!user) return res.status(404).json({ success: false, error: 'Person not found' });
    if (!perms.canManage(req.user, { ...user.data, id: user.id }, 'time')) return res.status(403).json({ success: false, error: 'You can only approve hours for people who report to you' });
    const ref = weekDocRef(userId, weekStart);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().status !== 'submitted') return res.status(409).json({ success: false, error: 'This week is not waiting for a decision' });
    const patch = { status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: new Date().toISOString(), decidedBy: req.user.id, decisionNote: note || null };
    if (decision === 'approve') {
        const info = await orgInfo(req.orgId);
        const view = await weekView(req.orgId, user, weekStart, info);
        if (view.openShift) return res.status(409).json({ success: false, error: 'This person is still clocked in' });
        patch.totals = view.totals; patch.flags = view.flags; patch.exempt = view.exempt; patch.rulesUsed = info.rules;
    }
    await ref.update(patch);
    rawCollection('organizations').doc(req.orgId).collection('audit_logs').add({ action: decision === 'approve' ? 'timesheet_approved' : 'timesheet_rejected', targetId: userId, actorId: req.user.id, at: new Date().toISOString(), weekStart }).catch(() => {});
    res.json({ success: true, status: patch.status });
});

router.post('/weeks/:userId/:weekStart/reopen', perms.requirePermission('time.approve'), requireOrg, async (req, res) => {
    const { userId, weekStart } = req.params;
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!isMonday(weekStart) || reason.length < 5) return res.status(400).json({ success: false, error: 'A Monday weekStart and a reason of at least 5 characters are required' });
    const ref = weekDocRef(userId, weekStart);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Week not found' });
    await ref.update({ status: 'open', reopenedAt: new Date().toISOString(), reopenedBy: req.user.id, reopenReason: reason.slice(0, 300) });
    rawCollection('organizations').doc(req.orgId).collection('audit_logs').add({ action: 'timesheet_reopened', targetId: userId, actorId: req.user.id, at: new Date().toISOString(), weekStart, reason: reason.slice(0, 200) }).catch(() => {});
    res.json({ success: true });
});

/* -------------------------------- punch corrections -------------------------------- */

/** Checks that adding or voiding a punch keeps the person's punch sequence valid */
async function sequenceOk(orgId, userId, sinceIso, mutate) {
    const base = await punchesSince(orgId, userId, sinceIso);
    const before = rules.validateSequence(base);
    const after = rules.validateSequence(mutate(base).sort((a, b) => a.at.localeCompare(b.at)));
    return !(after && !before);
}

router.post('/corrections', requireOrg, async (req, res) => {
    const b = req.body || {};
    const info = await orgInfo(req.orgId);
    const today = rules.localDate(new Date().toISOString(), info.tz);
    const reason = String(b.reason || '').trim();
    if (reason.length < 5) return res.status(400).json({ success: false, error: 'Please say what happened (at least 5 characters)' });
    if (!['add', 'remove', 'change'].includes(b.kind)) return res.status(400).json({ success: false, error: 'kind must be add, remove or change' });
    const oldest = addDays(today, -MAX_CORRECTION_AGE_DAYS);
    const doc = { orgId: req.orgId, userId: req.user.id, employeeId: req.user.employeeId || null, name: req.user.name || null, kind: b.kind, reason: reason.slice(0, 300), status: 'pending', createdAt: new Date().toISOString() };
    const sinceIso = new Date(Date.now() - (MAX_CORRECTION_AGE_DAYS + 3) * 86400000).toISOString();

    if (b.kind === 'add') {
        if (!rules.PUNCH_TYPES.includes(b.type)) return res.status(400).json({ success: false, error: 'type must be in, out, break_start or break_end' });
        const at = rules.zonedToUtcIso(b.localDate, b.localTime, info.tz);
        if (!at || new Date(at) > new Date()) return res.status(400).json({ success: false, error: 'Pick a real date and time that has already passed' });
        if (b.localDate < oldest) return res.status(400).json({ success: false, error: `Corrections can go back ${MAX_CORRECTION_AGE_DAYS} days` });
        if (await weekIsLocked(req.user.id, b.localDate)) return res.status(409).json({ success: false, error: 'That week is approved. Ask HR to reopen it.' });
        if (!(await sequenceOk(req.orgId, req.user.id, sinceIso, (p) => [...p, { type: b.type, at }]))) {
            return res.status(400).json({ success: false, error: 'That would break the order of your punches (in, break, out). Check the time or ask your manager.' });
        }
        Object.assign(doc, { type: b.type, localDate: b.localDate, localTime: b.localTime, at });
    } else if (b.kind === 'change') {
        const snap = await rawCollection('time_punches').doc(String(b.punchId || '_')).get();
        if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().userId !== req.user.id || snap.data().voided) return res.status(404).json({ success: false, error: 'Punch not found' });
        const p = snap.data();
        const newDate = b.localDate || p.localDate;
        const at = rules.zonedToUtcIso(newDate, b.localTime, info.tz);
        if (!at || new Date(at) > new Date()) return res.status(400).json({ success: false, error: 'Pick a real date and time that has already passed' });
        if (p.localDate < oldest || newDate < oldest) return res.status(400).json({ success: false, error: `Corrections can go back ${MAX_CORRECTION_AGE_DAYS} days` });
        if ((await weekIsLocked(req.user.id, p.localDate)) || (await weekIsLocked(req.user.id, newDate))) return res.status(409).json({ success: false, error: 'That week is approved. Ask HR to reopen it.' });
        if (!(await sequenceOk(req.orgId, req.user.id, sinceIso, (list) => list.map((x) => (x.id === snap.id ? { ...x, at } : x))))) {
            return res.status(400).json({ success: false, error: 'That time would break the order of your punches (in, break, out). Check the time.' });
        }
        Object.assign(doc, { punchId: snap.id, type: p.type, localDate: newDate, localTime: b.localTime, at, originalAt: p.at, originalLocalDate: p.localDate, originalLocalTime: localTimeOf(p.at, info.tz) });
    } else {
        const snap = await rawCollection('time_punches').doc(String(b.punchId || '_')).get();
        if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().userId !== req.user.id || snap.data().voided) return res.status(404).json({ success: false, error: 'Punch not found' });
        const p = snap.data();
        if (p.localDate < oldest) return res.status(400).json({ success: false, error: `Corrections can go back ${MAX_CORRECTION_AGE_DAYS} days` });
        if (await weekIsLocked(req.user.id, p.localDate)) return res.status(409).json({ success: false, error: 'That week is approved. Ask HR to reopen it.' });
        if (!(await sequenceOk(req.orgId, req.user.id, sinceIso, (list) => list.filter((x) => x.id !== snap.id)))) {
            return res.status(400).json({ success: false, error: 'Removing that punch would break the order of your punches. Ask for a different fix.' });
        }
        Object.assign(doc, { punchId: snap.id, type: p.type, localDate: p.localDate, localTime: localTimeOf(p.at, info.tz), at: p.at });
    }
    const ref = await rawCollection('punch_corrections').add(doc);
    res.status(201).json({ success: true, correction: { id: ref.id, ...doc } });
});

router.get('/corrections', requireOrg, async (req, res) => {
    const scope = String(req.query.scope || 'mine');
    let q = rawCollection('punch_corrections').where('orgId', '==', req.orgId);
    if (scope === 'mine') q = q.where('userId', '==', req.user.id);
    else if (!perms.can(req.user, 'time.approve') && !perms.can(req.user, 'time.approve_team') && !perms.can(req.user, 'time.view_all')) return res.status(403).json({ success: false, error: 'Not allowed' });
    const snap = await q.get();
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (scope !== 'mine') rows = await teamScope.filterRows(req.user, req.orgId, rows, 'time');
    if (scope === 'pending') rows = rows.filter((r) => r.status === 'pending');
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, count: rows.length, data: rows.slice(0, 200) });
});

router.put('/corrections/:id/decision', APPROVER, requireOrg, async (req, res) => {
    const decision = String((req.body && req.body.decision) || '');
    if (!['approve', 'deny'].includes(decision)) return res.status(400).json({ success: false, error: 'decision must be approve or deny' });
    const ref = rawCollection('punch_corrections').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Request not found' });
    const c = snap.data();
    if (c.userId === req.user.id) return res.status(403).json({ success: false, error: 'You cannot decide your own correction' });
    const owner = await userDoc(req.orgId, c.userId);
    if (!owner || !perms.canManage(req.user, { ...owner.data, id: owner.id }, 'time')) return res.status(403).json({ success: false, error: 'You can only decide fixes for people who report to you' });
    if (c.status !== 'pending') return res.status(409).json({ success: false, error: `This request is already ${c.status}` });
    const patch = { status: decision === 'approve' ? 'approved' : 'denied', decidedBy: req.user.id, decidedAt: new Date().toISOString(), decisionNote: String((req.body && req.body.note) || '').slice(0, 300) };

    if (decision === 'approve') {
        const info = await orgInfo(req.orgId);
        if (await weekIsLocked(c.userId, c.localDate)) return res.status(409).json({ success: false, error: 'That week is approved. Reopen it first.' });
        const sinceIso = new Date(Date.now() - (MAX_CORRECTION_AGE_DAYS + 3) * 86400000).toISOString();
        if (c.kind === 'add') {
            if (!(await sequenceOk(req.orgId, c.userId, sinceIso, (p) => [...p, { type: c.type, at: c.at }]))) return res.status(409).json({ success: false, error: 'The punches changed since this was requested and it would now break the order. Deny it and ask for a new request.' });
            await rawCollection('time_punches').add({
                orgId: req.orgId, userId: c.userId, employeeId: c.employeeId || null, type: c.type, at: c.at, localDate: rules.localDate(c.at, info.tz), tz: info.tz,
                source: 'correction', deviceId: null, location: null, note: c.reason, addedBy: req.user.id, correctionId: req.params.id
            });
        } else if (c.kind === 'change') {
            if (c.originalLocalDate && await weekIsLocked(c.userId, c.originalLocalDate)) return res.status(409).json({ success: false, error: 'The original week is approved. Reopen it first.' });
            if (!(await sequenceOk(req.orgId, c.userId, sinceIso, (p) => p.map((x) => (x.id === c.punchId ? { ...x, at: c.at } : x))))) return res.status(409).json({ success: false, error: 'The punches changed since this was requested and the new time would now break the order. Deny it and ask for a new request.' });
            await rawCollection('time_punches').doc(c.punchId).update({ at: c.at, localDate: rules.localDate(c.at, info.tz), editedBy: req.user.id, editedAt: new Date().toISOString(), originalAt: c.originalAt, correctionId: req.params.id });
        } else {
            const pRef = rawCollection('time_punches').doc(c.punchId);
            if (!(await sequenceOk(req.orgId, c.userId, sinceIso, (p) => p.filter((x) => x.id !== c.punchId)))) return res.status(409).json({ success: false, error: 'Removing that punch would now break the order. Deny it and ask for a new request.' });
            await pRef.update({ voided: true, voidedBy: req.user.id, voidedAt: new Date().toISOString(), voidReason: c.reason, correctionId: req.params.id });
        }
    }
    await ref.update(patch);
    rawCollection('organizations').doc(req.orgId).collection('audit_logs').add({ action: decision === 'approve' ? 'punch_correction_approved' : 'punch_correction_denied', targetId: c.userId, actorId: req.user.id, at: new Date().toISOString(), kind: c.kind, localDate: c.localDate }).catch(() => {});
    res.json({ success: true, status: patch.status });
});

router.post('/corrections/:id/cancel', requireOrg, async (req, res) => {
    const ref = rawCollection('punch_corrections').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().userId !== req.user.id) return res.status(404).json({ success: false, error: 'Request not found' });
    if (snap.data().status !== 'pending') return res.status(409).json({ success: false, error: `This request is already ${snap.data().status}` });
    await ref.update({ status: 'cancelled', cancelledAt: new Date().toISOString() });
    res.json({ success: true });
});

/* -------------------------------- payroll hours export -------------------------------- */

router.get('/export/hours', perms.requirePermission('time.export'), requireOrg, async (req, res) => {
    const from = parseIsoDate(req.query.from) ? req.query.from : '0000-01-01';
    const to = parseIsoDate(req.query.to) ? req.query.to : '9999-12-31';
    const snap = await rawCollection('timesheet_weeks').where('orgId', '==', req.orgId).get();
    const rows = snap.docs.map((d) => d.data()).filter((w) => w.status === 'approved' && w.weekStart >= from && w.weekStart <= to)
        .sort((a, b) => a.weekStart.localeCompare(b.weekStart) || String(a.employeeId).localeCompare(String(b.employeeId)))
        .map((w) => ({
            employee_id: w.employeeId || '', name: w.name || '', week_start: w.weekStart, week_end: addDays(w.weekStart, 6), flsa_status: w.exempt ? 'exempt' : 'non_exempt',
            regular_hours: w.totals.regularHours, overtime_hours: w.totals.overtimeHours, double_time_hours: w.totals.doubleTimeHours, total_hours: w.totals.workedHours
        }));
    if (req.query.format === 'csv') {
        const cols = ['employee_id', 'name', 'week_start', 'week_end', 'flsa_status', 'regular_hours', 'overtime_hours', 'double_time_hours', 'total_hours'];
        const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="approved-hours.csv"');
        return res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
    }
    res.json({ success: true, count: rows.length, data: rows });
});

module.exports = router;
