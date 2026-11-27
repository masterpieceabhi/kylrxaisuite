/**
 * Training records for US companies (pure, no I/O).
 *
 * HR defines a training: its name, who must take it (everyone, or people at chosen locations, in chosen departments,
 * with chosen system roles or job titles), whether it repeats (every N months) or is taken once, and an optional link.
 * A completion is one person finishing one training on a date. HR records it, or the person says "I completed this"
 * and HR confirms it. Only confirmed completions count.
 *
 * This module does not know which trainings any law requires. The company decides that with its own advisor.
 */
const { parseIsoDate } = require('./us-forms');

const AUDIENCE_TYPES = ['everyone', 'location', 'department', 'role', 'job_title'];
const COMPLETION_STATUSES = ['confirmed', 'reported', 'rejected', 'removed'];
const STATUSES = ['overdue', 'due', 'done'];
const REPEAT_MAX_MONTHS = 120;
const DUE_DAYS_DEFAULT = 30;
const DUE_DAYS_MAX = 365;
const SOON_DAYS = 30;
const NOTE = 'This system does not decide which trainings the law requires, how often, or for whom. Those rules differ by state, city and industry. Confirm your list with a US compliance advisor.';

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const isoOf = (d) => d.toISOString().slice(0, 10);
const norm = (v) => String(v === undefined || v === null ? '' : v).trim().toLowerCase();

function addDays(iso, n) { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); }
/** Adds whole months; a day that does not exist in the target month becomes that month's last day (Jan 31 + 1 month = Feb 28) */
function addMonths(iso, n) {
    const d = parseIsoDate(iso);
    const day = d.getUTCDate();
    const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(day, last));
    return isoOf(t);
}
const daysBetween = (a, b) => Math.round((parseIsoDate(b) - parseIsoDate(a)) / 86400000);

/** Only http and https links are kept */
function cleanLink(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!s) return { value: null };
    if (s.length > 500) return { error: 'The link is too long (the most is 500 characters)' };
    let u;
    try { u = new URL(s); } catch (_) { return { error: 'The link must be a full web address starting with https://' }; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { error: 'The link must start with https:// or http://' };
    return { value: u.toString() };
}

/** A training as HR enters it (partial: only the fields that were sent) */
function validateTraining(input, { partial = false } = {}) {
    const errors = []; const b = input || {}; const value = {};
    if (!partial || b.name !== undefined) { const n = clean(b.name, 120); if (n.length < 3) errors.push('Give the training a name (at least 3 characters)'); else value.name = n; }
    if (b.description !== undefined) value.description = clean(b.description, 500);
    if (!partial || b.audience !== undefined) {
        const a = b.audience || {};
        const type = a.type || 'everyone';
        if (!AUDIENCE_TYPES.includes(type)) errors.push(`Who must take it must be one of: ${AUDIENCE_TYPES.join(', ')}`);
        else if (type === 'everyone') value.audience = { type, values: [] };
        else {
            const values = [...new Set((Array.isArray(a.values) ? a.values : []).map((v) => clean(v, 120)).filter(Boolean))].slice(0, 50);
            if (!values.length) errors.push('Choose at least one location, department, role or job title, or pick "everyone"');
            else value.audience = { type, values };
        }
    }
    if (!partial || b.repeatMonths !== undefined) {
        if (b.repeatMonths === undefined || b.repeatMonths === null || b.repeatMonths === '' || b.repeatMonths === 0 || b.repeatMonths === '0') value.repeatMonths = null;
        else { const n = Number(b.repeatMonths); if (!Number.isInteger(n) || n < 1 || n > REPEAT_MAX_MONTHS) errors.push(`How often it repeats must be a whole number of months from 1 to ${REPEAT_MAX_MONTHS}, or empty for once`); else value.repeatMonths = n; }
    }
    if (!partial || b.dueWithinDays !== undefined) {
        if (b.dueWithinDays === undefined || b.dueWithinDays === null || b.dueWithinDays === '') value.dueWithinDays = DUE_DAYS_DEFAULT;
        else { const n = Number(b.dueWithinDays); if (!Number.isInteger(n) || n < 0 || n > DUE_DAYS_MAX) errors.push(`Days to finish must be a whole number from 0 to ${DUE_DAYS_MAX}`); else value.dueWithinDays = n; }
    }
    if (!partial || b.link !== undefined) { const l = cleanLink(b.link); if (l.error) errors.push(l.error); else value.link = l.value; }
    if (b.active !== undefined) value.active = Boolean(b.active);
    if (partial && !errors.length && !Object.keys(value).length) errors.push('Nothing to change');
    return { errors, value: errors.length ? null : value };
}

/** A completion as entered. byEmployee: the person is reporting it themselves (no person id needed). */
function validateCompletion(input, today, { byEmployee = false } = {}) {
    const errors = []; const b = input || {}; const value = {};
    if (!byEmployee) { const u = clean(b.userId, 128); if (!u) errors.push('Choose the person'); else value.userId = u; }
    const on = b.completedOn === undefined || b.completedOn === null || b.completedOn === '' ? today : String(b.completedOn);
    if (!parseIsoDate(on)) errors.push('The date completed must be a real date (YYYY-MM-DD)');
    else if (today && on > today) errors.push('The date completed cannot be in the future');
    else value.completedOn = on;
    value.note = clean(b.note, 300);
    return { errors, value: errors.length ? null : value };
}

/**
 * Must this person take this training? person: { id, role, jobTitle, departmentId, department, workLocationId, active }
 * Department and location match on the id or on the name; role and job title ignore upper and lower case.
 */
function appliesTo(training, person) {
    if (!training || training.active === false || !person || person.active === false) return false;
    const a = training.audience || { type: 'everyone', values: [] };
    if (a.type === 'everyone') return true;
    const want = new Set((a.values || []).map(norm));
    const has = (...xs) => xs.some((x) => x !== undefined && x !== null && x !== '' && want.has(norm(x)));
    if (a.type === 'location') return has(person.workLocationId, person.workLocation);
    if (a.type === 'department') return has(person.departmentId, person.department);
    if (a.type === 'role') return has(person.role);
    if (a.type === 'job_title') return has(person.jobTitle);
    return false;
}

/** The date a person must first finish it by: the later of their first day and the day the training was added, plus the days allowed */
function firstDueDate(training, person) {
    const added = String(training.startsOn || training.createdAt || '').slice(0, 10);
    const start = String(person.startDate || '').slice(0, 10);
    const dates = [added, start].filter((d) => parseIsoDate(d));
    if (!dates.length) return null;
    const from = dates.sort()[dates.length - 1];
    return addDays(from, training.dueWithinDays === undefined || training.dueWithinDays === null ? DUE_DAYS_DEFAULT : training.dueWithinDays);
}

/**
 * Where one person stands on one training today.
 * completions: this person's completions of this training (any status). Only confirmed ones count;
 * a "reported" one shows as waiting for HR.
 * Returns { status: 'done' | 'due' | 'overdue', lastCompletedOn, dueDate, nextDueDate, waitingForHr, daysLate }.
 *   overdue  the due date has passed
 *   due      not done yet, or a repeat falls due within 30 days
 *   done     finished, and nothing falls due within 30 days
 */
function personStatus(training, person, completions, today, { soonDays = SOON_DAYS } = {}) {
    const mine = (completions || []).filter((c) => c && parseIsoDate(c.completedOn));
    const confirmed = mine.filter((c) => c.status === 'confirmed').map((c) => c.completedOn).sort();
    const reported = mine.filter((c) => c.status === 'reported').sort((a, b) => String(a.completedOn).localeCompare(String(b.completedOn)));
    const last = confirmed.length ? confirmed[confirmed.length - 1] : null;
    const waiting = reported.length ? reported[reported.length - 1] : null;
    const out = { status: 'due', lastCompletedOn: last, dueDate: null, nextDueDate: null, waitingForHr: Boolean(waiting && (!last || waiting.completedOn > last)), reportedOn: waiting ? waiting.completedOn : null, daysLate: 0 };
    if (!last) {
        out.dueDate = firstDueDate(training, person);
        if (out.dueDate && today > out.dueDate) { out.status = 'overdue'; out.daysLate = daysBetween(out.dueDate, today); }
        return out;
    }
    if (!training.repeatMonths) { out.status = 'done'; return out; }
    out.nextDueDate = addMonths(last, training.repeatMonths); out.dueDate = out.nextDueDate;
    if (today > out.nextDueDate) { out.status = 'overdue'; out.daysLate = daysBetween(out.nextDueDate, today); }
    else if (daysBetween(today, out.nextDueDate) <= soonDays) out.status = 'due';
    else out.status = 'done';
    return out;
}

const RANK = { overdue: 0, due: 1, done: 2 };

/**
 * One row per person per training they must take.
 * trainings: [{ id, name, ... }], people: [{ id, name, employeeId, ... }], completions: [{ trainingId, userId, completedOn, status }]
 */
function reportRows(trainings, people, completions, today, opts = {}) {
    const by = new Map();
    for (const c of completions || []) { const k = `${c.trainingId}|${c.userId}`; if (!by.has(k)) by.set(k, []); by.get(k).push(c); }
    const rows = [];
    for (const t of trainings || []) {
        if (t.active === false) continue;
        for (const p of people || []) {
            if (!appliesTo(t, p)) continue;
            const s = personStatus(t, p, by.get(`${t.id}|${p.id}`) || [], today, opts);
            rows.push({ trainingId: t.id, training: t.name, userId: p.id, employeeId: p.employeeId || null, name: p.name || null, department: p.department || null, repeats: t.repeatMonths ? `every ${t.repeatMonths} month${t.repeatMonths === 1 ? '' : 's'}` : 'once', ...s });
        }
    }
    return rows.sort((a, b) => RANK[a.status] - RANK[b.status] || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')) || String(a.name).localeCompare(String(b.name)));
}

/** Counts for the top of the report */
function summarize(rows) {
    const s = { total: rows.length, overdue: 0, due: 0, done: 0, waitingForHr: 0 };
    for (const r of rows) { s[r.status] += 1; if (r.waitingForHr) s.waitingForHr += 1; }
    return s;
}

/** For the compliance report: per person, the names of trainings that are overdue and that are due. Map of userId -> { overdue: [], due: [] } */
function byPerson(rows) {
    const m = new Map();
    for (const r of rows) {
        if (r.status === 'done') continue;
        if (!m.has(r.userId)) m.set(r.userId, { overdue: [], due: [] });
        m.get(r.userId)[r.status].push(r.training);
    }
    return m;
}

/** May a person report this themselves? Null when allowed, or the reason it is not. */
function reportError(training, person, completions, today) {
    if (!appliesTo(training, person)) return 'This training is not on your list';
    const s = personStatus(training, person, completions, today);
    if (s.waitingForHr) return 'You already told HR you completed this. HR has not confirmed it yet.';
    if (s.status === 'done') return 'This training is already recorded as done';
    return null;
}

const CSV_COLUMNS = [['employeeId', 'Employee ID'], ['name', 'Name'], ['department', 'Department'], ['training', 'Training'], ['repeats', 'Repeats'], ['statusText', 'Status'], ['lastCompletedOn', 'Last completed'], ['dueDate', 'Due'], ['daysLate', 'Days late'], ['waiting', 'Waiting for HR to confirm']];
const STATUS_TEXT = { overdue: 'Overdue', due: 'Due', done: 'Done' };
const csvCell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(rows) {
    const lines = [CSV_COLUMNS.map(([, label]) => label).join(',')];
    for (const r of rows) { const x = { ...r, statusText: STATUS_TEXT[r.status] || r.status, daysLate: r.daysLate || '', waiting: r.waitingForHr ? 'yes' : '' }; lines.push(CSV_COLUMNS.map(([k]) => csvCell(x[k])).join(',')); }
    return `${lines.join('\r\n')}\r\n`;
}

module.exports = {
    AUDIENCE_TYPES, COMPLETION_STATUSES, STATUSES, REPEAT_MAX_MONTHS, DUE_DAYS_DEFAULT, DUE_DAYS_MAX, SOON_DAYS, NOTE, STATUS_TEXT,
    validateTraining, validateCompletion, appliesTo, firstDueDate, personStatus, reportRows, summarize, byPerson, reportError, toCsv, addMonths, addDays, cleanLink, clean
};
