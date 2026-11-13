/**
 * Scheduling rules (pure, no I/O): shift templates, weekly schedules, conflict checks, availability,
 * overtime warnings, predictive-scheduling premium flags, schedule vs actual, job time allocation.
 * Predictive-scheduling law differs by state/city and changes: the rules table is DATA, seeded empty.
 */
const { zonedToUtcIso, localDate } = require('./time-rules');

const DEFAULT_SETTINGS = {
    minRestHours: 8, maxDailyHours: 12, maxWeeklyHours: 60, overtimeWeeklyHours: 40,
    enforceRest: false, enforceMax: false, claimNeedsApproval: true, swapNeedsManager: true
};
const PREDICTIVE_NOTE = 'Predictive scheduling rules differ by state and city and change often. No rules are seeded. Add only what your compliance advisor confirms.';

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const pad = (t) => { const m = HHMM.exec(String(t)); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekDates = (weekStart) => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();

function validateSettings(body) {
    const errors = []; const b = body || {}; const v = { ...DEFAULT_SETTINGS };
    const num = (k, lo, hi) => { if (b[k] === undefined) return; const n = Number(b[k]); if (!(n >= lo && n <= hi)) errors.push(`${k} must be between ${lo} and ${hi}`); else v[k] = n; };
    num('minRestHours', 0, 24); num('maxDailyHours', 1, 24); num('maxWeeklyHours', 1, 168); num('overtimeWeeklyHours', 1, 168);
    ['enforceRest', 'enforceMax', 'claimNeedsApproval', 'swapNeedsManager'].forEach((k) => { if (b[k] !== undefined) v[k] = Boolean(b[k]); });
    return { errors, value: v };
}

function validateTemplate(body) {
    const errors = []; const b = body || {};
    const name = String(b.name || '').trim();
    if (!name) errors.push('name is required');
    const startTime = pad(b.startTime); const endTime = pad(b.endTime);
    if (!startTime) errors.push('startTime must be HH:MM');
    if (!endTime) errors.push('endTime must be HH:MM');
    const breakMinutes = b.breakMinutes === undefined ? 0 : Number(b.breakMinutes);
    if (!(breakMinutes >= 0 && breakMinutes <= 240)) errors.push('breakMinutes must be 0 to 240');
    return { errors, value: { name: name.slice(0, 80), startTime, endTime, breakMinutes, role: b.role ? String(b.role).slice(0, 60) : null, color: b.color ? String(b.color).slice(0, 16) : null, locationId: b.locationId || null, departmentId: b.departmentId || null } };
}

/** Wall-clock times on a local date to UTC instants; an end at or before the start means the next day */
function shiftWindow(date, startTime, endTime, tz, breakMinutes = 0) {
    if (!ISO_DATE.test(String(date))) return null;
    const s = pad(startTime); const e = pad(endTime);
    if (!s || !e) return null;
    const startAt = zonedToUtcIso(date, s, tz);
    let endAt = zonedToUtcIso(date, e, tz);
    if (!startAt || !endAt) return null;
    if (new Date(endAt) <= new Date(startAt)) endAt = zonedToUtcIso(addDays(date, 1), e, tz);
    const hours = Math.max(0, (new Date(endAt) - new Date(startAt)) / 3600000 - (Number(breakMinutes) || 0) / 60);
    return { startAt, endAt, hours: Math.round(hours * 100) / 100 };
}

function validateShiftInput(body, tz) {
    const errors = []; const b = body || {};
    if (!ISO_DATE.test(String(b.date || ''))) errors.push('date must be YYYY-MM-DD');
    const bm = b.breakMinutes === undefined ? 0 : Number(b.breakMinutes);
    if (!(bm >= 0 && bm <= 240)) errors.push('breakMinutes must be 0 to 240');
    const win = errors.length ? null : shiftWindow(b.date, b.startTime, b.endTime, tz, bm);
    if (!errors.length && !win) errors.push('startTime and endTime must be HH:MM');
    if (win && win.hours > 24) errors.push('A shift cannot be longer than 24 hours');
    return { errors, value: win ? { date: b.date, startTime: pad(b.startTime), endTime: pad(b.endTime), breakMinutes: bm, ...win } : null };
}

const overlaps = (a, b) => new Date(a.startAt) < new Date(b.endAt) && new Date(b.startAt) < new Date(a.endAt);

function availabilityIssue(avail, shift, tz) {
    if (!avail) return null;
    const ex = (avail.exceptions || []).find((x) => x.date === shift.date);
    const entries = ex ? [ex] : (avail.weekly || []).filter((w) => Number(w.dow) === dow(shift.date));
    if (!entries.length) return null;
    const free = entries.filter((e) => e.available !== false);
    if (!free.length) return 'unavailable';
    const hhmm = (iso) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    const s = hhmm(shift.startAt); const e = hhmm(shift.endAt);
    const fits = free.some((w) => (!w.start || !w.end) || (w.start <= s && w.end >= e));
    return fits ? null : 'outside_hours';
}

/**
 * Conflicts for putting `shift` (must have userId) on a person.
 * others: the person's other shifts; leaves: leave_requests docs; avail: availability doc.
 */
function conflictsFor({ shift, others, leaves, settings, avail, tz }) {
    const st = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const out = [];
    const mine = (others || []).filter((o) => o.id !== shift.id && o.status !== 'cancelled' && o.userId === shift.userId);
    for (const o of mine) if (overlaps(shift, o)) out.push({ code: 'overlap', severity: 'block', message: `Overlaps another shift on ${o.date} (${o.startTime}-${o.endTime})`, shiftId: o.id });
    for (const l of leaves || []) {
        if ((l.dates || []).includes(shift.date) && ['approved', 'pending'].includes(l.status)) {
            out.push({ code: 'on_leave', severity: l.status === 'approved' ? 'block' : 'warn', message: l.status === 'approved' ? 'Approved time off on this day' : 'Time off requested for this day (not yet decided)' });
        }
    }
    const restMs = st.minRestHours * 3600000;
    for (const o of mine) {
        if (overlaps(shift, o)) continue;
        const gap = new Date(shift.startAt) >= new Date(o.endAt) ? new Date(shift.startAt) - new Date(o.endAt) : new Date(o.startAt) - new Date(shift.endAt);
        if (gap < restMs) out.push({ code: 'short_rest', severity: st.enforceRest ? 'block' : 'warn', message: `Less than ${st.minRestHours} hours of rest between shifts`, shiftId: o.id });
    }
    const sameDay = mine.filter((o) => o.date === shift.date).reduce((s, o) => s + (o.hours || 0), 0) + (shift.hours || 0);
    if (sameDay > st.maxDailyHours) out.push({ code: 'over_daily_hours', severity: st.enforceMax ? 'block' : 'warn', message: `More than ${st.maxDailyHours} scheduled hours on this day (${Math.round(sameDay * 10) / 10})` });
    const wk = weeklyHours(weekStartOf(shift.date), [...mine, shift]);
    if (wk > st.maxWeeklyHours) out.push({ code: 'over_weekly_hours', severity: st.enforceMax ? 'block' : 'warn', message: `More than ${st.maxWeeklyHours} hours this week (${wk})` });
    else if (wk > st.overtimeWeeklyHours) out.push({ code: 'overtime_risk', severity: 'warn', message: `Over ${st.overtimeWeeklyHours} hours this week (${wk}): overtime likely` });
    const av = availabilityIssue(avail, shift, tz);
    if (av) out.push({ code: 'outside_availability', severity: 'warn', message: av === 'unavailable' ? 'Worker marked this day as unavailable' : 'Outside the worker\'s available hours' });
    return out;
}

function weekStartOf(dateIso) {
    const d = new Date(`${dateIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}

/** Scheduled hours of a person in a week */
function weeklyHours(weekStart, shifts) {
    const days = new Set(weekDates(weekStart));
    const h = (shifts || []).filter((s) => days.has(s.date) && s.status !== 'cancelled').reduce((sum, s) => sum + (s.hours || 0), 0);
    return Math.round(h * 100) / 100;
}

/**
 * Hours for the overtime warning: what was actually worked on days before today plus what is
 * scheduled from today on. workedByDate: { 'YYYY-MM-DD': hours }
 */
function projectedWeekHours(weekStart, shifts, workedByDate, today) {
    let total = 0;
    for (const d of weekDates(weekStart)) {
        if (d < today) total += Number((workedByDate || {})[d] || 0);
        else total += (shifts || []).filter((s) => s.date === d && s.status !== 'cancelled').reduce((s, x) => s + (x.hours || 0), 0);
    }
    return Math.round(total * 100) / 100;
}

/* ------------------------------ predictive scheduling ------------------------------ */

function validatePredictiveRule(body) {
    const errors = []; const b = body || {};
    const name = String(b.name || '').trim();
    if (!name) errors.push('name is required');
    const noticeDays = Number(b.noticeDays);
    if (!(noticeDays >= 0 && noticeDays <= 60)) errors.push('noticeDays must be 0 to 60');
    const premiumHours = b.premiumHours === undefined ? 1 : Number(b.premiumHours);
    if (!(premiumHours >= 0 && premiumHours <= 8)) errors.push('premiumHours must be 0 to 8');
    const jur = (Array.isArray(b.jurisdictions) ? b.jurisdictions : []).map((j) => String(j).trim().toUpperCase()).filter(Boolean);
    return { errors, value: { name: name.slice(0, 120), noticeDays, premiumPay: b.premiumPay !== false, premiumHours, jurisdictions: jur, enabled: b.enabled !== false, verify: true, note: 'Confirm with counsel before relying on this rule.' } };
}

/** A published shift changed inside the notice window: does a rule say premium pay is owed? */
function premiumOwed({ shift, change, nowIso, rules, state }) {
    if (!shift || !shift.startAt) return null;
    const hoursUntil = (new Date(shift.startAt) - new Date(nowIso)) / 3600000;
    const applicable = (rules || []).filter((r) => r.enabled !== false && r.premiumPay !== false
        && (!(r.jurisdictions || []).length || (state && r.jurisdictions.includes(String(state).toUpperCase())))
        && hoursUntil < r.noticeDays * 24).sort((a, b) => b.noticeDays - a.noticeDays);
    if (!applicable.length) return null;
    const r = applicable[0];
    return { ruleId: r.id || null, rule: r.name, noticeDays: r.noticeDays, premiumHours: r.premiumHours || 0, change, hoursNotice: Math.round(Math.max(0, hoursUntil) * 10) / 10 };
}

/* ------------------------------ weekly copy ------------------------------ */

/** New draft shifts for another week from the shifts of a source week */
function copyWeek(shifts, fromWeek, toWeek, tz) {
    const delta = Math.round((new Date(`${toWeek}T00:00:00Z`) - new Date(`${fromWeek}T00:00:00Z`)) / 86400000);
    const out = [];
    for (const s of shifts) {
        if (s.status === 'cancelled') continue;
        const date = addDays(s.date, delta);
        const w = shiftWindow(date, s.startTime, s.endTime, tz, s.breakMinutes);
        if (!w) continue;
        out.push({ date, startTime: s.startTime, endTime: s.endTime, breakMinutes: s.breakMinutes || 0, ...w, userId: s.userId || null, locationId: s.locationId || null, departmentId: s.departmentId || null, role: s.role || null, jobId: s.jobId || null, templateId: s.templateId || null, notes: s.notes || null });
    }
    return out;
}

/** Can this person take a shift that asks for a role? No role means anyone */
function isQualified(shift, person) {
    if (!shift.role) return true;
    const want = String(shift.role).trim().toLowerCase();
    const p = person || {};
    const skills = [p.jobTitle, ...(Array.isArray(p.skills) ? p.skills : []), ...(Array.isArray(p.usProfile && p.usProfile.skills) ? p.usProfile.skills : []), p.usProfile && p.usProfile.jobTitle].filter(Boolean).map((x) => String(x).trim().toLowerCase());
    return skills.includes(want);
}

/* ------------------------------ schedule vs actual ------------------------------ */

/** punchesByUser: { userId: [punch...] } oldest first */
function compareScheduleToActual(shifts, punchesByUser, tz, nowIso, graceMinutes = 5) {
    const g = graceMinutes * 60000; const now = new Date(nowIso).getTime();
    const rows = [];
    for (const s of shifts) {
        if (!s.userId || s.status === 'cancelled') continue;
        const start = new Date(s.startAt).getTime(); const end = new Date(s.endAt).getTime();
        const ps = (punchesByUser[s.userId] || []);
        const firstIn = ps.find((p) => p.type === 'in' && new Date(p.at).getTime() >= start - 3 * 3600000 && new Date(p.at).getTime() <= end);
        const lastOut = firstIn ? [...ps].reverse().find((p) => p.type === 'out' && new Date(p.at).getTime() > new Date(firstIn.at).getTime() && new Date(p.at).getTime() <= end + 3 * 3600000) : null;
        let status = 'on_time'; let lateMinutes = 0; let earlyMinutes = 0;
        if (!firstIn) status = now > end ? 'no_show' : now > start + g ? 'late_pending' : 'upcoming';
        else {
            lateMinutes = Math.max(0, Math.round((new Date(firstIn.at).getTime() - start) / 60000));
            if (lateMinutes * 60000 > g) status = 'late'; else lateMinutes = 0;
            if (lastOut && end - new Date(lastOut.at).getTime() > g) { earlyMinutes = Math.round((end - new Date(lastOut.at).getTime()) / 60000); status = status === 'late' ? 'late_and_early_leave' : 'early_leave'; }
        }
        let workedMinutes = 0;
        if (firstIn) workedMinutes = Math.max(0, Math.round(((lastOut ? new Date(lastOut.at).getTime() : Math.min(now, end)) - new Date(firstIn.at).getTime()) / 60000));
        rows.push({ shiftId: s.id, userId: s.userId, date: s.date, startTime: s.startTime, endTime: s.endTime, scheduledMinutes: Math.round((s.hours || 0) * 60), workedMinutes, status, lateMinutes, earlyMinutes, punchedIn: firstIn ? firstIn.at : null, punchedOut: lastOut ? lastOut.at : null });
    }
    const count = (k) => rows.filter((r) => r.status === k).length;
    return { rows, summary: { shifts: rows.length, onTime: count('on_time'), late: count('late') + count('late_and_early_leave'), earlyLeave: count('early_leave') + count('late_and_early_leave'), noShow: count('no_show'), scheduledMinutes: rows.reduce((s, r) => s + r.scheduledMinutes, 0), workedMinutes: rows.reduce((s, r) => s + r.workedMinutes, 0) } };
}

/* ------------------------------ jobs and allocation ------------------------------ */

function validateJob(body) {
    const errors = []; const b = body || {};
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(code)) errors.push('code must be 1-20 letters, numbers, dot, dash or underscore');
    const name = String(b.name || '').trim();
    if (!name) errors.push('name is required');
    return { errors, value: { code, name: name.slice(0, 100), billable: Boolean(b.billable), costCenter: b.costCenter ? String(b.costCenter).slice(0, 40) : null, active: b.active !== false } };
}

/** End-of-day split: minutes per job must be whole, positive and not exceed the day's worked minutes */
function validateAllocations(items, workedMinutes, existingMinutes = 0) {
    const errors = [];
    if (!Array.isArray(items) || !items.length) return { errors: ['allocations must list at least one job'], value: [] };
    const value = [];
    for (const it of items) {
        const minutes = Number(it.minutes);
        if (!it.jobId) errors.push('Each allocation needs a jobId');
        else if (!Number.isInteger(minutes) || minutes <= 0) errors.push('minutes must be a positive whole number');
        else value.push({ jobId: String(it.jobId), minutes, note: it.note ? String(it.note).slice(0, 200) : null });
    }
    const total = value.reduce((s, x) => s + x.minutes, 0) + existingMinutes;
    if (!errors.length && total > workedMinutes + 1) errors.push(`Allocated ${total} minutes but only ${workedMinutes} were worked that day`);
    return { errors, value };
}

/** Report: minutes per job */
function jobReport(allocations, jobs) {
    const by = new Map(jobs.map((j) => [j.id, j]));
    const agg = new Map();
    for (const a of allocations) {
        const j = by.get(a.jobId) || { id: a.jobId, code: '?', name: 'Unknown job' };
        const row = agg.get(a.jobId) || { jobId: a.jobId, code: j.code, name: j.name, billable: Boolean(j.billable), costCenter: j.costCenter || null, minutes: 0, workers: new Set() };
        row.minutes += a.minutes; row.workers.add(a.userId); agg.set(a.jobId, row);
    }
    return Array.from(agg.values()).map((r) => ({ ...r, hours: Math.round((r.minutes / 60) * 100) / 100, workers: r.workers.size })).sort((a, b) => b.minutes - a.minutes);
}

module.exports = {
    DEFAULT_SETTINGS, PREDICTIVE_NOTE, addDays, weekDates, weekStartOf, validateSettings, validateTemplate, shiftWindow, validateShiftInput,
    overlaps, availabilityIssue, conflictsFor, weeklyHours, projectedWeekHours, validatePredictiveRule, premiumOwed, copyWeek, isQualified,
    compareScheduleToActual, validateJob, validateAllocations, jobReport, localDate
};
