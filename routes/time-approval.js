const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/authMiddleware');
const { orgInfo, personInfo, punchesSince, weekIsLocked, audit } = require('./time').helpers;
const rules = require('../services/time-rules');
const policy = require('../services/time-policy');
const { parseIsoDate, isoDate } = require('../services/us-forms');
const perms = require('../services/permissions');
const notices = require('../services/notices');
const teamScope = require('../services/team-scope');
// Who may do what here (services/permissions.js decides which roles hold each permission):
//   decide hours and punch fixes       time.approve (everyone) or time.approve_team (a manager's direct reports only)
//   see the lists without deciding     time.view_all (auditors)
//   reopen a week                      time.approve
//   change the company's time rules    time.manage_rules
//   download approved hours            time.export
const APPROVER = perms.requireAnyPermission('time.approve', 'time.approve_team');
const APPROVAL_VIEWER = perms.requireAnyPermission('time.approve', 'time.approve_team', 'time.view_all');
const MAX_CORRECTION_AGE_DAYS = 60;

router.use(verifyToken);

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const hours = policy.toHours;

function requireOrg(req, res, next) {
    const orgId = req.user.orgId || req.tenantOrgId;
    if (!orgId) return res.status(404).json({ success: false, error: 'No organization for this user' });
    req.orgId = orgId;
    next();
}

const addDays = (iso, n) => { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };
/** The message for a date that is not the first day of one of the company's workweeks */
function notAWeekStart(res, iso, info) {
    const real = parseIsoDate(iso) ? rules.weekRange(iso, info.workweek) : null;
    return res.status(400).json({
        success: false, error: real ? `weekStart must be the first day of a workweek (YYYY-MM-DD). That week starts on ${rules.WEEKDAYS[real.startDay]} ${real.start}.` : 'weekStart must be a date (YYYY-MM-DD)',
        ...(real ? { expectedWeekStart: real.start } : {})
    });
}
/** A stored week's last day (weeks saved before the workweek setting existed are 7 days) */
const weekEndOf = (w) => w.weekEnd || addDays(w.weekStart, 6);
const weekDocRef = (userId, weekStart) => rawCollection('timesheet_weeks').doc(`${userId}_${weekStart}`);
const localTimeOf = (iso, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

async function userDoc(orgId, userId) {
    const snap = await rawCollection('users').doc(userId).get();
    if (!exists(snap) || snap.data().orgId !== orgId) return null;
    return { id: snap.id, ref: snap.ref, data: snap.data() };
}

/** Company holidays that fall in a week, for this person's work location (United States companies only). Never fails the timesheet. */
async function holidaysInWeek(orgId, user, weekStart, weekEnd, info) {
    if (info.country !== 'US') return [];
    try {
        const cal = require('../services/company-holidays'); const H = require('../services/holiday-rules');
        const locationId = (user.data.usProfile && user.data.usProfile.workLocationId) || undefined;
        const out = [];
        for (const year of new Set([weekStart.slice(0, 4), weekEnd.slice(0, 4)])) {
            const calendar = await cal.calendarFor(orgId, Number(year));
            for (let d = weekStart; d <= weekEnd; d = addDays(d, 1)) {
                if (d.slice(0, 4) !== year) continue;
                const h = H.holidayOn(calendar, d, locationId);
                if (h) out.push({ date: d, name: h.name, paid: h.paid !== false });
            }
        }
        return out;
    } catch (_) { return []; }
}

/**
 * Everything about one person's workweek: pay-hour split, flags, each day's punches.
 * `info` is the person's own (personInfo): days are cut in the time zone of their work location, and the week runs
 * from the company's workweek start day (the one week cut short by a workweek change is shorter than 7 days).
 */
async function weekView(orgId, user, weekStart, info, attest = null) {
    const range = rules.weekRange(weekStart, info.workweek);
    const weekEnd = range.end;
    const sinceIso = new Date(new Date(`${weekStart}T00:00:00Z`).getTime() - 86400000).toISOString();
    const nowIso = new Date().toISOString();
    // each punch's day is worked out from its time in this person's zone (the day saved on older punches used the company zone)
    const punches = (await punchesSince(orgId, user.id, sinceIso)).map((p) => ({ ...p, localDate: rules.localDate(p.at, info.tz) })).filter((p) => p.localDate <= addDays(weekEnd, 1));
    const sheet = rules.timesheet(punches, info.tz, nowIso, null, info.workweek);
    const dayRows = sheet.days.filter((d) => d.date >= weekStart && d.date <= weekEnd);
    const exempt = Boolean(user.data.usProfile && user.data.usProfile.flsaStatus === 'exempt');
    // Paid company holidays add hours where the company turned holiday pay on; a reported missed rest break is flagged (see services/time-policy.js)
    const holidays = await holidaysInWeek(orgId, user, weekStart, weekEnd, info);
    const pay = policy.computeWeek(dayRows, info.rules, {
        exempt, paidHolidays: holidays.filter((h) => h.paid).map((h) => h.date),
        holidayEligible: policy.holidayPayApplies(info.rules, { exempt, employmentType: user.data.usProfile && user.data.usProfile.employmentType }),
        missedRestDays: (attest && attest.missedDays) || []
    });
    const days = pay.days.map((d) => ({
        date: d.date, workedHours: hours(d.workedMinutes), regularHours: hours(d.regularMinutes), overtimeHours: hours(d.overtimeMinutes),
        ...rules.shiftSpan(d.date, d.workedMinutes, punches.filter((p) => p.localDate === d.date), info.tz),
        doubleTimeHours: hours(d.doubleTimeMinutes), flags: d.flags, restBreaksDue: d.restBreaksDue, premiumHours: hours(d.premiumMinutes),
        breakMinutes: (dayRows.find((x) => x.date === d.date) || {}).breakMinutes || 0,
        punches: punches.filter((p) => p.localDate === d.date).map((p) => ({ id: p.id, type: p.type, time: localTimeOf(p.at, info.tz), source: p.source }))
    }));
    const open = rules.stateOf(punches) !== 'out' && punches.some((p) => p.localDate >= weekStart && p.localDate <= weekEnd);
    const rest = info.rules.restBreak || policy.DEFAULT_RULES.restBreak;
    days.forEach((d) => { const h = holidays.find((x) => x.date === d.date); if (h) d.holiday = { name: h.name, paid: h.paid }; });
    return {
        weekStart, weekEnd, weekDays: range.days, shortWeek: range.days < 7, exempt, openShift: open, holidays,
        holidayPay: pay.holidayPay.map((h) => ({ date: h.date, hours: hours(h.minutes) })),
        restBreak: { asked: Boolean(rest.enabled) && days.some((d) => d.restBreaksDue > 0), everyHours: rest.everyHours, minutes: rest.minutes }, restAttest: attest || null,
        forgottenClockOut: rules.isForgottenClockOut(punches, nowIso),
        days, flags: pay.flags,
        totals: { workedHours: hours(pay.totals.workedMinutes), regularHours: hours(pay.totals.regularMinutes), overtimeHours: hours(pay.totals.overtimeMinutes), doubleTimeHours: hours(pay.totals.doubleTimeMinutes), holidayHours: hours(pay.totals.holidayMinutes), premiumHours: hours(pay.totals.premiumMinutes) }
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

/** The workweek setting as the pages show it: the start day in use today, and a change that has not started yet */
function workweekView(workweek, today) {
    const list = rules.normalizeWorkweek(workweek);
    const started = list.filter((e) => !e.effectiveFrom || e.effectiveFrom <= today);
    const waiting = list.filter((e) => e.effectiveFrom && e.effectiveFrom > today);
    const active = started[started.length - 1];
    const range = rules.weekRange(today, list);
    return {
        startDay: active.startDay, startDayName: rules.WEEKDAYS[active.startDay], since: active.effectiveFrom,
        pending: waiting.length ? { startDay: waiting[waiting.length - 1].startDay, startDayName: rules.WEEKDAYS[waiting[waiting.length - 1].startDay], effectiveFrom: waiting[waiting.length - 1].effectiveFrom } : null,
        currentWeek: { start: range.start, end: range.end }, history: list, weekdays: rules.WEEKDAYS,
        earliestChange: rules.WEEKDAYS.map((_, day) => policy.earliestWorkweekChange(today, day))
    };
}
const WORKWEEK_NOTE = 'The workweek is a fixed, recurring period of 168 hours (seven days in a row). Overtime is worked out one workweek at a time. A change starts on a future date you choose; weeks before that keep the start day they had, and the week running at the changeover is cut short. Confirm with a US compliance advisor before you change it, and how overtime should be paid for the changeover week.';

router.get('/rules', requireOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const today = rules.localDate(new Date().toISOString(), info.tz);
    res.json({ success: true, country: info.country, timeZone: info.tz, today, rules: info.rules, workweek: workweekView(info.workweek, today), workweekNote: WORKWEEK_NOTE,
        note: 'Daily overtime, double time, meal and rest breaks, premium pay for missed breaks and holiday pay depend on your state and on your own company policy. Confirm each setting with a US compliance advisor.' });
});

router.put('/rules', perms.requirePermission('time.manage_rules'), requireOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const today = rules.localDate(new Date().toISOString(), info.tz);
    const { errors, value, workweekChanged, workweekPending } = policy.validateTimeRules(req.body, info.rules, today);
    if (errors.length) return res.status(400).json({ success: false, errors });
    if (workweekChanged && workweekPending) {
        // Safe rule: a workweek change may not cut into a week whose hours were already sent or approved
        const snap = await rawCollection('timesheet_weeks').where('orgId', '==', req.orgId).get();
        const hit = snap.docs.map((d) => d.data()).filter((w) => ['submitted', 'approved'].includes(w.status) && w.weekStart < workweekPending.effectiveFrom && weekEndOf(w) >= workweekPending.effectiveFrom)
            .sort((a, b) => weekEndOf(b).localeCompare(weekEndOf(a)))[0];
        if (hit) {
            const day = workweekPending.startDay; let next = addDays(weekEndOf(hit), 1);
            while (rules.weekdayOf(next) !== day) next = addDays(next, 1);
            return res.status(409).json({ success: false, error: `Hours for the week of ${hit.weekStart} are already sent or approved, and this change would cut that week short. Choose ${next} or a later ${rules.WEEKDAYS[day]}.`, earliest: next });
        }
    }
    await rawCollection('organizations').doc(req.orgId).set({ usProfile: { timeRules: value } }, { merge: true });
    audit(req.orgId, req, 'time_rules_updated', req.orgId, { rules: value, workweekChanged: Boolean(workweekChanged) });
    res.json({ success: true, rules: value, workweek: workweekView(value.workweek, today) });
});

/* -------------------------------- weekly timesheets -------------------------------- */

/** One person's week. :weekStart is the first day of a workweek, or the word "current" for the week running now. */
router.get('/weeks/:weekStart', requireOrg, async (req, res) => {
    const user = await targetUser(req, res); if (!user) return;
    const info = await personInfo(req.orgId, user.id, user.data);
    const today = rules.localDate(new Date().toISOString(), info.tz);
    const thisWeek = rules.weekRange(today, info.workweek);
    const weekStart = req.params.weekStart === 'current' ? thisWeek.start : req.params.weekStart;
    if (!rules.isWeekStart(weekStart, info.workweek)) return notAWeekStart(res, weekStart, info);
    const range = rules.weekRange(weekStart, info.workweek);
    const doc = await weekDocRef(user.id, weekStart).get();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, userId: user.id, name: user.data.name || null, timeZone: info.tz, today,
        currentWeekStart: thisWeek.start, prevWeekStart: rules.weekStartFor(addDays(range.start, -1), info.workweek), nextWeekStart: rules.weekStartFor(addDays(range.end, 1), info.workweek),
        workweekStartDay: range.startDay,
        ...statusView(exists(doc) ? doc.data() : null), ...(await weekView(req.orgId, user, weekStart, info, exists(doc) ? doc.data().restAttest || null : null)) });
});

router.post('/weeks/:weekStart/submit', requireOrg, async (req, res) => {
    const weekStart = req.params.weekStart;
    const user = await userDoc(req.orgId, req.user.id);
    if (!user) return res.status(404).json({ success: false, error: 'No employee record for this login' });
    const info = await personInfo(req.orgId, user.id, user.data);
    if (!rules.isWeekStart(weekStart, info.workweek)) return notAWeekStart(res, weekStart, info);
    const today = rules.localDate(new Date().toISOString(), info.tz);
    if (weekStart > rules.weekStartFor(today, info.workweek)) return res.status(400).json({ success: false, error: 'That week has not started yet' });
    const ref = weekDocRef(user.id, weekStart);
    const existing = await ref.get();
    const cur = exists(existing) ? existing.data() : null;
    if (cur && ['submitted', 'approved'].includes(cur.status)) return res.status(409).json({ success: false, error: `This week is already ${cur.status}` });
    let view = await weekView(req.orgId, user, weekStart, info);
    if (view.openShift) return res.status(409).json({ success: false, error: 'Clock out before you send your hours' });
    // Rest breaks are not punched, so where the company asks, the person says whether they could take them
    let restAttest = null;
    if (view.restBreak.asked) {
        const b = req.body || {};
        if (b.restBreaks !== 'taken' && b.restBreaks !== 'missed') return res.status(400).json({ success: false, code: 'rest_breaks_needed', error: 'Say whether you were able to take your rest breaks this week' });
        const due = new Set(view.days.filter((d) => d.restBreaksDue > 0).map((d) => d.date));
        const missedDays = b.restBreaks === 'missed' ? [...new Set((Array.isArray(b.missedDays) ? b.missedDays : []).map(String))].filter((d) => due.has(d)).sort() : [];
        if (b.restBreaks === 'missed' && !missedDays.length) return res.status(400).json({ success: false, code: 'rest_breaks_needed', error: 'Choose the days you could not take a rest break' });
        restAttest = { taken: b.restBreaks === 'taken', missedDays, at: new Date().toISOString() };
        if (missedDays.length) view = await weekView(req.orgId, user, weekStart, info, restAttest);
    }
    await ref.set({
        orgId: req.orgId, userId: user.id, employeeId: user.data.employeeId || null, name: user.data.name || null, weekStart, weekEnd: view.weekEnd, timeZone: info.tz,
        status: 'submitted', submittedAt: new Date().toISOString(), submittedBy: req.user.id, totals: view.totals, flags: view.flags, holidayPay: view.holidayPay, restAttest, decisionNote: null, decidedAt: null, decidedBy: null
    });
    audit(req.orgId, req, 'timesheet_submitted', user.id, { weekStart, weekEnd: view.weekEnd });
    require('../services/events').emit(req.orgId, 'timesheet.submitted', { person_id: user.id, week_start: weekStart, worked_hours: (view.totals && view.totals.workedHours) ?? null });
    res.json({ success: true, status: 'submitted', totals: view.totals });
});

router.get('/approvals', APPROVAL_VIEWER, requireOrg, async (req, res) => {
    const status = ['submitted', 'approved', 'rejected', 'open'].includes(req.query.status) ? req.query.status : 'submitted';
    const snap = await rawCollection('timesheet_weeks').where('orgId', '==', req.orgId).get();
    const rows = (await teamScope.filterRows(req.user, req.orgId, snap.docs.map((d) => ({ id: d.id, ...d.data() })), 'time')).filter((w) => w.status === status)
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || String(a.name).localeCompare(String(b.name)));
    res.json({ success: true, status, count: rows.length, canDecide: perms.can(req.user, 'time.approve') || perms.can(req.user, 'time.approve_team'), canReopen: perms.can(req.user, 'time.approve'),
        ...require('../utils/paging').pageFields(rows, req.query, 300, (w) => ({ ...w, weekEnd: weekEndOf(w) })) });
});

/**
 * After a week is approved, rejected or reopened: if the company connects its own Gusto account and has switched
 * automatic sending on, its hours go to Gusto now (or are taken back). Not awaited, so the answer to the approver
 * never waits for Gusto; the service never throws and writes any failure to the Gusto error list.
 */
function hoursToPayrollProvider(orgId, weekStart, actor) {
    try { Promise.resolve(require('../services/gusto/time-sheets').afterWeekChange(orgId, weekStart, { actor })).catch(() => {}); } catch (_) { /* never fail the decision */ }
}

router.put('/weeks/:userId/:weekStart/decision', APPROVER, requireOrg, async (req, res) => {
    const { userId, weekStart } = req.params;
    if (!parseIsoDate(weekStart)) return res.status(400).json({ success: false, error: 'weekStart must be a date (YYYY-MM-DD)' });
    const own = await require('../services/own-request').guard(req, res, userId, 'time.approve', 'approve your own hours'); if (!own) return undefined;
    const decision = String((req.body && req.body.decision) || '');
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ success: false, error: 'decision must be approve or reject' });
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
    if (decision === 'reject' && note.length < 3) return res.status(400).json({ success: false, error: 'Say what needs fixing (at least 3 characters)' });
    const user = await userDoc(req.orgId, userId);
    if (!user) return res.status(404).json({ success: false, error: 'Person not found' });
    if (!perms.canManage(req.user, { ...user.data, id: user.id }, 'time')) return res.status(403).json({ success: false, error: 'You can only approve hours for people who report to you' });
    const ref = weekDocRef(userId, weekStart);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().status !== 'submitted') return res.status(409).json({ success: false, error: 'This week is not waiting for a decision' });
    const patch = { status: decision === 'approve' ? 'approved' : 'rejected', decidedAt: new Date().toISOString(), decidedBy: req.user.id, decisionNote: note || null };
    if (decision === 'approve') {
        const info = await personInfo(req.orgId, user.id, user.data);
        const view = await weekView(req.orgId, user, weekStart, info, snap.data().restAttest || null);
        if (view.openShift) return res.status(409).json({ success: false, error: 'This person is still clocked in' });
        patch.totals = view.totals; patch.flags = view.flags; patch.exempt = view.exempt; patch.rulesUsed = info.rules; patch.holidayPay = view.holidayPay;
        patch.weekEnd = view.weekEnd; patch.timeZone = info.tz;
        // each day as it was approved, so the same hours can later be sent on shift by shift (payroll providers that want time sheets)
        patch.days = view.days.map((d) => ({ date: d.date, workedHours: d.workedHours, regularHours: d.regularHours, overtimeHours: d.overtimeHours, doubleTimeHours: d.doubleTimeHours, premiumHours: d.premiumHours, startAt: d.startAt, endAt: d.endAt }));
    }
    await ref.update(patch);
    audit(req.orgId, req, decision === 'approve' ? 'timesheet_approved' : 'timesheet_rejected', userId, { weekStart, ...own });
    require('../services/events').emit(req.orgId, decision === 'approve' ? 'timesheet.approved' : 'timesheet.rejected', decision === 'approve'
        ? { person_id: userId, week_start: weekStart, worked_hours: (patch.totals && patch.totals.workedHours) ?? null, overtime_hours: (patch.totals && patch.totals.overtimeHours) ?? null }
        : { person_id: userId, week_start: weekStart });
    hoursToPayrollProvider(req.orgId, weekStart, req.user.id);
    notices.notify(req.orgId, userId, decision === 'approve' ? 'timesheet_approved' : 'timesheet_rejected', decision === 'approve' ? 'Hours approved' : 'Hours sent back',
        decision === 'approve' ? `Your hours for the week of ${weekStart} were approved.` : `Your hours for the week of ${weekStart} were sent back: ${note}. Fix them and send the week again.`, { weekStart });
    res.json({ success: true, status: patch.status });
});

router.post('/weeks/:userId/:weekStart/reopen', perms.requirePermission('time.approve'), requireOrg, async (req, res) => {
    const { userId, weekStart } = req.params;
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!parseIsoDate(weekStart)) return res.status(400).json({ success: false, error: 'weekStart must be a date (YYYY-MM-DD)' });
    if (reason.length < 5) return res.status(400).json({ success: false, error: 'Say why the week is being reopened (at least 5 characters)' });
    const ref = weekDocRef(userId, weekStart);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Week not found' });
    const was = snap.data().status;
    if (!['approved', 'submitted'].includes(was)) return res.status(409).json({ success: false, error: 'This week is already open' });
    const own = await require('../services/own-request').guard(req, res, userId, 'time.approve', 'reopen your own week'); if (!own) return undefined;
    await ref.update({ status: 'open', reopenedAt: new Date().toISOString(), reopenedBy: req.user.id, reopenReason: reason.slice(0, 300), reopenedFrom: was });
    audit(req.orgId, req, 'timesheet_reopened', userId, { weekStart, reason: reason.slice(0, 200), was, ...own });
    if (was === 'approved') hoursToPayrollProvider(req.orgId, weekStart, req.user.id);
    if (userId !== req.user.id) notices.notify(req.orgId, userId, 'timesheet_reopened', 'Your week was reopened', `Your hours for the week of ${weekStart} were reopened: ${reason.slice(0, 200)}. Check them and send the week again.`, { weekStart });
    res.json({ success: true, status: 'open', was });
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
    const info = await personInfo(req.orgId, req.user.id, req.user);
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
        if (await weekIsLocked(req.user.id, b.localDate, info.workweek)) return res.status(409).json({ success: false, error: 'That week is approved. Ask HR to reopen it.' });
        if (!(await sequenceOk(req.orgId, req.user.id, sinceIso, (p) => [...p, { type: b.type, at }]))) {
            return res.status(400).json({ success: false, error: 'That would break the order of your punches (in, break, out). Check the time or ask your manager.' });
        }
        Object.assign(doc, { type: b.type, localDate: b.localDate, localTime: b.localTime, at });
    } else if (b.kind === 'change') {
        const snap = await rawCollection('time_punches').doc(String(b.punchId || '_')).get();
        if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().userId !== req.user.id || snap.data().voided) return res.status(404).json({ success: false, error: 'Punch not found' });
        const p = { ...snap.data(), localDate: rules.localDate(snap.data().at, info.tz) };
        const newDate = b.localDate || p.localDate;
        const at = rules.zonedToUtcIso(newDate, b.localTime, info.tz);
        if (!at || new Date(at) > new Date()) return res.status(400).json({ success: false, error: 'Pick a real date and time that has already passed' });
        if (p.localDate < oldest || newDate < oldest) return res.status(400).json({ success: false, error: `Corrections can go back ${MAX_CORRECTION_AGE_DAYS} days` });
        if ((await weekIsLocked(req.user.id, p.localDate, info.workweek)) || (await weekIsLocked(req.user.id, newDate, info.workweek))) return res.status(409).json({ success: false, error: 'That week is approved. Ask HR to reopen it.' });
        if (!(await sequenceOk(req.orgId, req.user.id, sinceIso, (list) => list.map((x) => (x.id === snap.id ? { ...x, at } : x))))) {
            return res.status(400).json({ success: false, error: 'That time would break the order of your punches (in, break, out). Check the time.' });
        }
        Object.assign(doc, { punchId: snap.id, type: p.type, localDate: newDate, localTime: b.localTime, at, originalAt: p.at, originalLocalDate: p.localDate, originalLocalTime: localTimeOf(p.at, info.tz) });
    } else {
        const snap = await rawCollection('time_punches').doc(String(b.punchId || '_')).get();
        if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().userId !== req.user.id || snap.data().voided) return res.status(404).json({ success: false, error: 'Punch not found' });
        const p = { ...snap.data(), localDate: rules.localDate(snap.data().at, info.tz) };
        if (p.localDate < oldest) return res.status(400).json({ success: false, error: `Corrections can go back ${MAX_CORRECTION_AGE_DAYS} days` });
        if (await weekIsLocked(req.user.id, p.localDate, info.workweek)) return res.status(409).json({ success: false, error: 'That week is approved. Ask HR to reopen it.' });
        if (!(await sequenceOk(req.orgId, req.user.id, sinceIso, (list) => list.filter((x) => x.id !== snap.id)))) {
            return res.status(400).json({ success: false, error: 'Removing that punch would break the order of your punches. Ask for a different fix.' });
        }
        Object.assign(doc, { punchId: snap.id, type: p.type, localDate: p.localDate, localTime: localTimeOf(p.at, info.tz), at: p.at });
    }
    const ref = await rawCollection('punch_corrections').add(doc);
    audit(req.orgId, req, 'punch_correction_requested', req.user.id, { kind: doc.kind, localDate: doc.localDate, correctionId: ref.id });
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
    res.json({ success: true, count: rows.length, ...require('../utils/paging').pageFields(rows, req.query, 200) });
});

router.put('/corrections/:id/decision', APPROVER, requireOrg, async (req, res) => {
    const decision = String((req.body && req.body.decision) || '');
    if (!['approve', 'deny'].includes(decision)) return res.status(400).json({ success: false, error: 'decision must be approve or deny' });
    const ref = rawCollection('punch_corrections').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Request not found' });
    const c = snap.data();
    const own = await require('../services/own-request').guard(req, res, c.userId, 'time.approve', 'decide your own punch fix'); if (!own) return undefined;
    const owner = await userDoc(req.orgId, c.userId);
    if (!owner || !perms.canManage(req.user, { ...owner.data, id: owner.id }, 'time')) return res.status(403).json({ success: false, error: 'You can only decide fixes for people who report to you' });
    if (c.status !== 'pending') return res.status(409).json({ success: false, error: `This request is already ${c.status}` });
    const patch = { status: decision === 'approve' ? 'approved' : 'denied', decidedBy: req.user.id, decidedAt: new Date().toISOString(), decisionNote: String((req.body && req.body.note) || '').slice(0, 300) };

    if (decision === 'approve') {
        const info = await personInfo(req.orgId, owner.id, owner.data);
        if (await weekIsLocked(c.userId, c.localDate, info.workweek)) return res.status(409).json({ success: false, error: 'That week is approved. Reopen it first.' });
        const sinceIso = new Date(Date.now() - (MAX_CORRECTION_AGE_DAYS + 3) * 86400000).toISOString();
        if (c.kind === 'add') {
            if (!(await sequenceOk(req.orgId, c.userId, sinceIso, (p) => [...p, { type: c.type, at: c.at }]))) return res.status(409).json({ success: false, error: 'The punches changed since this was requested and it would now break the order. Deny it and ask for a new request.' });
            await rawCollection('time_punches').add({
                orgId: req.orgId, userId: c.userId, employeeId: c.employeeId || null, type: c.type, at: c.at, localDate: rules.localDate(c.at, info.tz), tz: info.tz,
                source: 'correction', deviceId: null, location: null, note: c.reason, addedBy: req.user.id, correctionId: req.params.id
            });
        } else if (c.kind === 'change') {
            if (c.originalLocalDate && await weekIsLocked(c.userId, c.originalLocalDate, info.workweek)) return res.status(409).json({ success: false, error: 'The original week is approved. Reopen it first.' });
            if (!(await sequenceOk(req.orgId, c.userId, sinceIso, (p) => p.map((x) => (x.id === c.punchId ? { ...x, at: c.at } : x))))) return res.status(409).json({ success: false, error: 'The punches changed since this was requested and the new time would now break the order. Deny it and ask for a new request.' });
            await rawCollection('time_punches').doc(c.punchId).update({ at: c.at, localDate: rules.localDate(c.at, info.tz), editedBy: req.user.id, editedAt: new Date().toISOString(), originalAt: c.originalAt, correctionId: req.params.id });
        } else {
            const pRef = rawCollection('time_punches').doc(c.punchId);
            if (!(await sequenceOk(req.orgId, c.userId, sinceIso, (p) => p.filter((x) => x.id !== c.punchId)))) return res.status(409).json({ success: false, error: 'Removing that punch would now break the order. Deny it and ask for a new request.' });
            await pRef.update({ voided: true, voidedBy: req.user.id, voidedAt: new Date().toISOString(), voidReason: c.reason, correctionId: req.params.id });
        }
    }
    await ref.update(patch);
    audit(req.orgId, req, decision === 'approve' ? 'punch_correction_approved' : 'punch_correction_denied', c.userId, { kind: c.kind, localDate: c.localDate, correctionId: req.params.id, ...own });
    notices.notify(req.orgId, c.userId, decision === 'approve' ? 'correction_approved' : 'correction_denied', decision === 'approve' ? 'Punch fix approved' : 'Punch fix not approved',
        `Your fix for ${c.localDate} was ${decision === 'approve' ? 'approved' : 'not approved'}.${patch.decisionNote ? ` Note: ${patch.decisionNote}` : ''}`, { correctionId: req.params.id, date: c.localDate });
    res.json({ success: true, status: patch.status });
});

router.post('/corrections/:id/cancel', requireOrg, async (req, res) => {
    const ref = rawCollection('punch_corrections').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().userId !== req.user.id) return res.status(404).json({ success: false, error: 'Request not found' });
    if (snap.data().status !== 'pending') return res.status(409).json({ success: false, error: `This request is already ${snap.data().status}` });
    await ref.update({ status: 'cancelled', cancelledAt: new Date().toISOString() });
    audit(req.orgId, req, 'punch_correction_cancelled', req.user.id, { correctionId: req.params.id });
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
            employee_id: w.employeeId || '', name: w.name || '', week_start: w.weekStart, week_end: weekEndOf(w), flsa_status: w.exempt ? 'exempt' : 'non_exempt',
            regular_hours: w.totals.regularHours, overtime_hours: w.totals.overtimeHours, double_time_hours: w.totals.doubleTimeHours, total_hours: w.totals.workedHours,
            holiday_hours: w.totals.holidayHours || 0, break_premium_hours: w.totals.premiumHours || 0
        }));
    if (req.query.format === 'csv') {
        const cols = ['employee_id', 'name', 'week_start', 'week_end', 'flsa_status', 'regular_hours', 'overtime_hours', 'double_time_hours', 'total_hours', 'holiday_hours', 'break_premium_hours'];
        const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', 'attachment; filename="approved-hours.csv"');
        audit(req.orgId, req, 'approved_hours_exported', req.orgId, { from, to, rows: rows.length, format: 'csv' });
        return res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');
    }
    audit(req.orgId, req, 'approved_hours_exported', req.orgId, { from, to, rows: rows.length, format: 'json' });
    res.json({ success: true, count: rows.length, data: rows });
});

module.exports = router;
