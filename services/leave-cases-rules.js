/**
 * Statutory leave cases (pure): FMLA eligibility, entitlement and balance, the case lifecycle with
 * due dates, and a data-driven table of other statutory leave types. The numbers in DEFAULT_SETTINGS
 * are the usual federal FMLA figures but every one is a setting the company can edit. The other
 * leave types are placeholders to be confirmed with counsel for each state.
 */
const { parseIsoDate, isoDate, addBusinessDays } = require('./us-forms');

const PERIOD_METHODS = ['calendar_year', 'rolling_backward', 'rolling_forward', 'fixed_year'];
const PATTERNS = ['continuous', 'intermittent', 'reduced'];
const FMLA_REASONS = ['own_health', 'family_care', 'bonding', 'military_exigency', 'military_caregiver'];
const STATUSES = ['requested', 'eligibility_noticed', 'certification_requested', 'certification_received', 'designated', 'on_leave', 'returned', 'closed', 'denied', 'cancelled'];
const OPEN_STATUSES = ['requested', 'eligibility_noticed', 'certification_requested', 'certification_received', 'designated', 'on_leave', 'returned'];

const DEFAULT_SETTINGS = {
    minMonthsService: 12, minHoursLast12Months: 1250, minWorksiteEmployees: 50, worksiteRadiusMiles: 75,
    presumeExemptMeetsHours: true,
    standardWeeks: 12, militaryCaregiverWeeks: 26,
    periodMethod: 'rolling_backward', fixedPeriodStart: '01-01', defaultWeeklyHours: 40,
    eligibilityNoticeBusinessDays: 5, designationNoticeBusinessDays: 5, certificationDueDays: 15, recertificationDueDays: 15
};

const DEFAULT_LEAVE_TYPES = [
    { key: 'fmla', label: 'Family and medical leave (FMLA)', labelEs: 'Licencia familiar y médica (FMLA)', paid: 'unpaid', maxDays: null, states: [], statutory: true, notes: 'Federal. Uses the eligibility and entitlement rules above.' },
    { key: 'jury_duty', label: 'Jury duty', labelEs: 'Servicio de jurado', paid: 'varies', maxDays: null, states: [], notes: 'Pay rules differ by state.' },
    { key: 'military', label: 'Military leave', labelEs: 'Licencia militar', paid: 'unpaid', maxDays: null, states: [], notes: 'Federal USERRA and state rules.' },
    { key: 'bereavement', label: 'Bereavement', labelEs: 'Duelo', paid: 'varies', maxDays: 3, states: [], notes: 'Placeholder days.' },
    { key: 'voting', label: 'Voting time off', labelEs: 'Tiempo para votar', paid: 'varies', maxDays: 1, states: [], notes: 'Placeholder.' },
    { key: 'parental', label: 'Parental / paid family leave', labelEs: 'Licencia parental / familiar pagada', paid: 'varies', maxDays: null, states: [], notes: 'State programs differ a lot.' },
    { key: 'domestic_violence', label: 'Domestic violence leave', labelEs: 'Licencia por violencia doméstica', paid: 'varies', maxDays: null, states: [], notes: 'Placeholder.' },
    { key: 'school_activities', label: 'School activities', labelEs: 'Actividades escolares', paid: 'unpaid', maxDays: null, states: [], notes: 'Placeholder.' }
].map((t) => ({ ...t, confirmed: false, active: true, note: 'Confirm with counsel' }));

const round2 = (n) => Math.round(n * 100) / 100;
const addDays = (iso, n) => { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };
const addMonths = (iso, n) => {
    const d = parseIsoDate(iso); const day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return isoDate(d);
};
const diffDays = (a, b) => Math.round((parseIsoDate(b) - parseIsoDate(a)) / 86400000);

/** Merge stored settings over defaults and validate the ones that matter */
function validateSettings(input) {
    const errors = []; const b = input || {};
    const value = { ...DEFAULT_SETTINGS };
    const num = (f, min, max, int) => {
        if (b[f] === undefined || b[f] === '') return;
        const n = Number(b[f]);
        if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) errors.push(`${f} must be ${int ? 'a whole number' : 'a number'} from ${min} to ${max}`);
        else value[f] = n;
    };
    num('minMonthsService', 0, 120, true); num('minHoursLast12Months', 0, 4000); num('minWorksiteEmployees', 0, 100000, true); num('worksiteRadiusMiles', 0, 5000);
    num('standardWeeks', 1, 52); num('militaryCaregiverWeeks', 1, 104); num('defaultWeeklyHours', 1, 80);
    num('eligibilityNoticeBusinessDays', 0, 60, true); num('designationNoticeBusinessDays', 0, 60, true);
    num('certificationDueDays', 1, 120, true); num('recertificationDueDays', 1, 120, true);
    if (b.periodMethod !== undefined) {
        if (!PERIOD_METHODS.includes(b.periodMethod)) errors.push(`periodMethod must be one of: ${PERIOD_METHODS.join(', ')}`); else value.periodMethod = b.periodMethod;
    }
    if (b.fixedPeriodStart !== undefined) {
        if (!parseIsoDate(`2024-${b.fixedPeriodStart}`) || !/^\d{2}-\d{2}$/.test(b.fixedPeriodStart)) errors.push('fixedPeriodStart must be MM-DD'); else value.fixedPeriodStart = b.fixedPeriodStart;
    }
    if (b.presumeExemptMeetsHours !== undefined) value.presumeExemptMeetsHours = b.presumeExemptMeetsHours === true || b.presumeExemptMeetsHours === 'true';
    return { errors, value };
}

function validateLeaveType(input) {
    const errors = []; const b = input || {}; const value = {};
    const key = String(b.key || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '');
    if (key.length < 2) errors.push('key is required (letters, numbers, underscore)'); else value.key = key;
    const label = String(b.label || '').trim();
    if (label.length < 2) errors.push('label is required'); else value.label = label;
    value.labelEs = String(b.labelEs || label).trim();
    if (!['paid', 'unpaid', 'varies'].includes(b.paid)) errors.push('paid must be paid, unpaid or varies'); else value.paid = b.paid;
    if (b.maxDays === null || b.maxDays === undefined || b.maxDays === '') value.maxDays = null;
    else { const n = Number(b.maxDays); if (!Number.isInteger(n) || n < 1 || n > 730) errors.push('maxDays must be a whole number from 1 to 730'); else value.maxDays = n; }
    const states = Array.isArray(b.states) ? b.states : String(b.states || '').split(/[,\s]+/).filter(Boolean);
    value.states = [...new Set(states.map((s) => String(s).trim().toUpperCase()))];
    if (value.states.some((s) => !/^[A-Z]{2}$/.test(s))) errors.push('states must be 2-letter codes');
    value.statutory = b.statutory === true;
    value.confirmed = b.confirmed === true || b.confirmed === 'true';
    value.active = b.active !== false && b.active !== 'false';
    value.notes = String(b.notes || '').trim().slice(0, 300);
    value.note = 'Confirm with counsel';
    return { errors, value };
}

const typeAppliesToState = (type, state) => !type.states || !type.states.length || type.states.includes(String(state || '').toUpperCase());

/** A request to open a case (employee or HR on someone's behalf) */
function validateRequest(input, types, { today, workState } = {}) {
    const errors = []; const warnings = []; const b = input || {}; const value = {};
    const type = (types || []).find((t) => t.key === b.typeKey && t.active !== false);
    if (!type) errors.push('typeKey is not an available leave type');
    else {
        value.typeKey = type.key;
        if (!typeAppliesToState(type, workState)) errors.push('This leave type is not set up for your work state. Ask HR.');
    }
    const isFmla = Boolean(type && type.key === 'fmla');
    if (!PATTERNS.includes(b.pattern || 'continuous')) errors.push(`pattern must be one of: ${PATTERNS.join(', ')}`); else value.pattern = b.pattern || 'continuous';
    if (!parseIsoDate(b.startDate)) errors.push('startDate must be a valid date (YYYY-MM-DD)'); else value.startDate = b.startDate;
    if (b.endDate) {
        if (!parseIsoDate(b.endDate)) errors.push('endDate must be a valid date (YYYY-MM-DD)');
        else if (value.startDate && b.endDate < value.startDate) errors.push('endDate cannot be before startDate');
        else value.endDate = b.endDate;
    } else if (value.pattern === 'continuous' && !isFmla) errors.push('endDate is required for continuous leave');
    else value.endDate = null;
    if (isFmla) {
        if (!FMLA_REASONS.includes(b.fmlaReason)) errors.push(`fmlaReason must be one of: ${FMLA_REASONS.join(', ')}`); else value.fmlaReason = b.fmlaReason;
    }
    value.reason = String(b.reason || '').trim().slice(0, 500);
    if (value.pattern !== 'continuous') {
        const h = Number(b.expectedHoursPerWeek);
        if (b.expectedHoursPerWeek !== undefined && b.expectedHoursPerWeek !== '') {
            if (!(h > 0 && h <= 80)) errors.push('expectedHoursPerWeek must be between 0 and 80'); else value.expectedHoursPerWeek = h;
        }
    }
    if (type && type.maxDays && value.startDate && value.endDate) {
        const days = diffDays(value.startDate, value.endDate) + 1;
        if (days > type.maxDays) warnings.push(`This request is ${days} days; the table lists a maximum of ${type.maxDays}. HR will review.`);
    }
    if (today && value.startDate && diffDays(today, value.startDate) < -365) errors.push('startDate is more than a year in the past');
    return { errors, warnings, value };
}

/* ------------------------------ FMLA eligibility ------------------------------ */

function monthsOfService(hireDate, asOf) {
    if (!parseIsoDate(hireDate) || !parseIsoDate(asOf)) return null;
    let m = 0;
    while (addMonths(hireDate, m + 1) <= asOf) m++;
    return m;
}

/** Hours from approved timesheet weeks whose Monday falls inside the 12 months before asOf */
function hoursLast12Months(weeks, asOf) {
    const from = addMonths(asOf, -12);
    let total = 0; let counted = 0;
    for (const w of weeks || []) {
        if (w.status && w.status !== 'approved') continue;
        if (!w.weekStart || w.weekStart <= from || w.weekStart > asOf) continue;
        const h = Number(w.totals && w.totals.workedHours);
        if (Number.isFinite(h)) { total += h; counted++; }
    }
    return { hours: round2(total), weeksCounted: counted };
}

function haversineMiles(a, b) {
    const R = 3958.8; const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat); const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Employees within the radius of the person's worksite. people: [{id, locationId, active}],
 * locations: [{id, lat, lng}]. Without locations (or without coordinates) the company headcount is used.
 */
function worksiteHeadcount(people, locations, person, radiusMiles) {
    const active = (people || []).filter((p) => p.active !== false);
    const locs = new Map((locations || []).map((l) => [l.id, l]));
    const mine = person && person.locationId ? locs.get(person.locationId) : null;
    if (!mine) return { count: active.length, basis: 'company' };
    const hasCoords = (l) => l && Number.isFinite(Number(l.lat)) && Number.isFinite(Number(l.lng));
    let count = 0;
    for (const p of active) {
        if (p.locationId === mine.id) { count++; continue; }
        const l = locs.get(p.locationId);
        if (hasCoords(mine) && hasCoords(l) && haversineMiles({ lat: +mine.lat, lng: +mine.lng }, { lat: +l.lat, lng: +l.lng }) <= radiusMiles) count++;
    }
    return { count, basis: hasCoords(mine) ? `worksite within ${radiusMiles} miles` : 'same worksite' };
}

function fmlaEligibility({ hireDate, asOf, weeks, headcount, exempt }, cfg = DEFAULT_SETTINGS) {
    const months = monthsOfService(hireDate, asOf);
    const hrs = hoursLast12Months(weeks, asOf);
    const presumed = Boolean(exempt && cfg.presumeExemptMeetsHours);
    const checks = [
        { key: 'service', label: 'Months of service', value: months, required: cfg.minMonthsService, ok: months !== null && months >= cfg.minMonthsService },
        { key: 'hours', label: 'Hours worked in the last 12 months', value: hrs.hours, required: cfg.minHoursLast12Months, ok: presumed || hrs.hours >= cfg.minHoursLast12Months, presumed },
        { key: 'worksite', label: 'Employees at the worksite', value: headcount ? headcount.count : null, required: cfg.minWorksiteEmployees, ok: Boolean(headcount) && headcount.count >= cfg.minWorksiteEmployees, basis: headcount ? headcount.basis : null }
    ];
    return { eligible: checks.every((c) => c.ok), asOf, checks, weeksCounted: hrs.weeksCounted };
}

/* ------------------------- entitlement, period, balance ------------------------- */

const entitlementWeeks = (reason, cfg = DEFAULT_SETTINGS) => (reason === 'military_caregiver' ? cfg.militaryCaregiverWeeks : cfg.standardWeeks);
const entitlementHours = (reason, weeklyHours, cfg = DEFAULT_SETTINGS) => round2(entitlementWeeks(reason, cfg) * (weeklyHours || cfg.defaultWeeklyHours));

/** The 12-month window in force on refDate. usageDates is only needed for rolling_forward. */
function leavePeriod(method, refDate, { fixedStart = '01-01', usageDates = [] } = {}) {
    if (method === 'calendar_year') { const y = refDate.slice(0, 4); return { start: `${y}-01-01`, end: `${y}-12-31` }; }
    if (method === 'fixed_year') {
        const y = Number(refDate.slice(0, 4));
        let start = `${y}-${fixedStart}`;
        if (start > refDate) start = `${y - 1}-${fixedStart}`;
        return { start, end: addDays(addMonths(start, 12), -1) };
    }
    if (method === 'rolling_forward') {
        const dates = [...new Set(usageDates)].sort();
        let start = dates.find((d) => d <= refDate) || refDate;
        for (let guard = 0; guard < 50; guard++) {
            const end = addDays(addMonths(start, 12), -1);
            if (refDate <= end) return { start, end };
            const next = dates.find((d) => d > end);
            if (!next || next > refDate) return { start: refDate, end: addDays(addMonths(refDate, 12), -1) };
            start = next;
        }
        return { start, end: addDays(addMonths(start, 12), -1) };
    }
    return { start: addDays(addMonths(refDate, -12), 1), end: refDate }; // rolling_backward
}

function validateUsage(input, today) {
    const errors = []; const b = input || {};
    if (!parseIsoDate(b.date)) errors.push('date must be a valid date (YYYY-MM-DD)');
    const h = Number(b.hours);
    if (!(h > 0 && h <= 24)) errors.push('hours must be greater than 0 and at most 24');
    const kind = b.kind || 'continuous';
    if (!PATTERNS.includes(kind)) errors.push('kind must be continuous, intermittent or reduced');
    return { errors, value: { date: b.date, hours: round2(h), kind, source: b.source || 'manual', requestId: b.requestId || null, note: String(b.note || '').slice(0, 200) } };
}

/** One usage entry per weekday between two dates, skipping weekends */
function continuousUsage(startDate, endDate, hoursPerDay, kind = 'continuous') {
    const out = [];
    for (let d = startDate; d <= endDate; d = addDays(d, 1)) {
        const dow = parseIsoDate(d).getUTCDay();
        if (dow !== 0 && dow !== 6) out.push({ date: d, hours: hoursPerDay, kind, source: 'manual', requestId: null });
    }
    return out;
}

/**
 * Balance as of a date. usage covers all FMLA cases of the person. Hours in the period count
 * against the entitlement of the case's reason (weeks x weekly hours).
 */
function fmlaBalance({ usage, reason, weeklyHours, refDate }, cfg = DEFAULT_SETTINGS) {
    const period = leavePeriod(cfg.periodMethod, refDate, { fixedStart: cfg.fixedPeriodStart, usageDates: (usage || []).map((u) => u.date) });
    const used = (usage || []).filter((u) => u.date >= period.start && u.date <= period.end && u.date <= refDate);
    const scheduled = (usage || []).filter((u) => u.date > refDate && u.date <= period.end);
    const total = entitlementHours(reason, weeklyHours, cfg);
    const sum = (arr, k) => round2(arr.reduce((s, u) => s + Number(u[k] || 0), 0));
    const usedHours = sum(used, 'hours');
    return {
        method: cfg.periodMethod, periodStart: period.start, periodEnd: period.end, entitlementWeeks: entitlementWeeks(reason, cfg), weeklyHours: weeklyHours || cfg.defaultWeeklyHours,
        entitlementHours: total, usedHours, scheduledHours: sum(scheduled, 'hours'), remainingHours: round2(Math.max(0, total - usedHours)),
        remainingWeeks: round2(Math.max(0, total - usedHours) / (weeklyHours || cfg.defaultWeeklyHours)),
        byKind: { continuous: sum(used.filter((u) => u.kind === 'continuous'), 'hours'), intermittent: sum(used.filter((u) => u.kind === 'intermittent'), 'hours'), reduced: sum(used.filter((u) => u.kind === 'reduced'), 'hours') },
        exhausted: usedHours >= total
    };
}

/* ------------------------------- lifecycle ------------------------------- */

const ACTIONS = {
    eligibility_notice: { from: ['requested'], to: 'eligibility_noticed' },
    request_certification: { from: ['requested', 'eligibility_noticed', 'certification_requested'], to: 'certification_requested' },
    receive_certification: { from: ['certification_requested'], to: 'certification_received' },
    designate: { from: ['requested', 'eligibility_noticed', 'certification_requested', 'certification_received'], to: 'designated' },
    deny: { from: ['requested', 'eligibility_noticed', 'certification_requested', 'certification_received'], to: 'denied', reason: true },
    start_leave: { from: ['designated'], to: 'on_leave' },
    request_recertification: { from: ['designated', 'on_leave'], to: null },
    receive_recertification: { from: ['designated', 'on_leave'], to: null },
    return_to_work: { from: ['designated', 'on_leave'], to: 'returned' },
    close: { from: ['designated', 'on_leave', 'returned', 'denied'], to: 'closed' },
    cancel: { from: ['requested', 'eligibility_noticed', 'certification_requested', 'certification_received', 'designated', 'on_leave'], to: 'cancelled' }
};

/** Initial deadlines for a brand-new case */
function newCaseDeadlines(requestedOn, cfg = DEFAULT_SETTINGS) {
    return { eligibilityNoticeDue: addBusinessDays(requestedOn, cfg.eligibilityNoticeBusinessDays) || requestedOn, eligibilityNoticeSent: null, designationNoticeDue: null, designationNoticeSent: null, certificationDue: null, certificationReceived: null, recertificationDue: null, recertificationReceived: null };
}

/**
 * Applies one lifecycle action. Returns { errors, patch } where patch holds the new status and
 * dates. isFmla controls job protection; `eligible` is the stored eligibility result.
 */
function applyAction(kase, action, params = {}, cfg = DEFAULT_SETTINGS, todayIso) {
    const def = ACTIONS[action];
    if (!def) return { errors: [`action must be one of: ${Object.keys(ACTIONS).join(', ')}`] };
    if (!def.from.includes(kase.status)) return { errors: [`Cannot ${action.replace(/_/g, ' ')} when the case is ${kase.status.replace(/_/g, ' ')}`], conflict: true };
    const date = params.date || todayIso;
    if (!parseIsoDate(date)) return { errors: ['date must be a valid date (YYYY-MM-DD)'] };
    const note = String(params.note || '').trim().slice(0, 500);
    if (def.reason && note.length < 5) return { errors: ['A reason of at least 5 characters is required'] };
    const dl = { ...(kase.deadlines || {}) };
    const patch = { };
    if (def.to) patch.status = def.to;
    switch (action) {
        case 'eligibility_notice': dl.eligibilityNoticeSent = date; dl.designationNoticeDue = addBusinessDays(date, cfg.designationNoticeBusinessDays) || date; break;
        case 'request_certification': dl.certificationDue = addDays(date, cfg.certificationDueDays); dl.certificationRequested = date; break;
        case 'receive_certification': dl.certificationReceived = date; break;
        case 'designate': {
            const fmla = kase.typeKey === 'fmla';
            const eligible = kase.eligibility ? kase.eligibility.eligible : false;
            if (fmla && !eligible && params.override !== true) return { errors: ['This person is not FMLA eligible. Deny the case, or designate with override and a reason.'], conflict: true };
            if (fmla && !eligible && note.length < 5) return { errors: ['An override needs a reason of at least 5 characters'] };
            dl.designationNoticeSent = date;
            patch.jobProtected = fmla && (eligible || params.override === true);
            patch.designatedOn = date;
            break;
        }
        case 'deny': patch.jobProtected = false; patch.deniedOn = date; patch.denialReason = note; break;
        case 'start_leave': patch.leaveStartedOn = date; break;
        case 'request_recertification': dl.recertificationDue = addDays(date, cfg.recertificationDueDays); dl.recertificationReceived = null; break;
        case 'receive_recertification': dl.recertificationReceived = date; break;
        case 'return_to_work': patch.returnedOn = date; break;
        case 'close': patch.closedOn = date; patch.jobProtected = false; break;
        case 'cancel': patch.cancelledOn = date; patch.jobProtected = false; break;
        default: break;
    }
    patch.deadlines = dl;
    patch.historyEntry = { at: todayIso || date, action, from: kase.status, to: def.to || kase.status, date, note };
    return { errors: [], patch };
}

/** Open deadlines with an overdue flag */
function deadlineList(kase, todayIso) {
    const d = kase.deadlines || {};
    const open = OPEN_STATUSES.includes(kase.status);
    const rows = [
        { key: 'eligibilityNotice', label: 'Eligibility notice', due: d.eligibilityNoticeDue, done: d.eligibilityNoticeSent },
        { key: 'designationNotice', label: 'Designation notice', due: d.designationNoticeDue, done: d.designationNoticeSent },
        { key: 'certification', label: 'Certification', due: d.certificationDue, done: d.certificationReceived },
        { key: 'recertification', label: 'Recertification', due: d.recertificationDue, done: d.recertificationReceived }
    ];
    return rows.filter((r) => r.due).map((r) => ({ ...r, overdue: open && !r.done && todayIso > r.due, daysLeft: diffDays(todayIso, r.due) }));
}

/** What the employee sees: no HR-only notes */
function publicCase(c) {
    const { hrNotes, ...rest } = c;
    return rest;
}

module.exports = {
    PERIOD_METHODS, PATTERNS, FMLA_REASONS, STATUSES, OPEN_STATUSES, ACTIONS, DEFAULT_SETTINGS, DEFAULT_LEAVE_TYPES,
    validateSettings, validateLeaveType, typeAppliesToState, validateRequest, monthsOfService, hoursLast12Months, worksiteHeadcount, haversineMiles,
    fmlaEligibility, entitlementWeeks, entitlementHours, leavePeriod, validateUsage, continuousUsage, fmlaBalance,
    newCaseDeadlines, applyAction, deadlineList, publicCase, addDays, addMonths
};
