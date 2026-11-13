/**
 * Job and compensation history rules (pure).
 * A record is a change effective on a date; fields left out carry forward from the earlier records.
 * Fields: jobTitle, departmentId, managerId, workLocationId, payType, payRate, payFrequency.
 */
const { parseIsoDate } = require('./us-forms');
const { PAY_TYPES, PAY_FREQUENCIES } = require('./us-validation');

const REASONS = ['hire', 'raise', 'promotion', 'transfer', 'correction'];
const STATE_FIELDS = ['jobTitle', 'departmentId', 'managerId', 'workLocationId', 'payType', 'payRate', 'payFrequency'];
const PAY_FIELDS = ['payType', 'payRate', 'payFrequency'];
const HOURS_PER_YEAR = 2080;

function validateRecord(input) {
    const errors = [];
    const b = input || {};
    const value = {};
    if (!parseIsoDate(b.effectiveDate)) errors.push('effectiveDate must be a valid date (YYYY-MM-DD)');
    else value.effectiveDate = String(b.effectiveDate);
    if (!REASONS.includes(b.reason)) errors.push(`reason must be one of: ${REASONS.join(', ')}`);
    else value.reason = b.reason;
    if (b.jobTitle !== undefined && b.jobTitle !== null && b.jobTitle !== '') {
        const t = String(b.jobTitle).trim();
        if (t.length > 120) errors.push('jobTitle is too long'); else value.jobTitle = t;
    }
    for (const f of ['departmentId', 'managerId', 'workLocationId']) {
        if (b[f] !== undefined) value[f] = b[f] ? String(b[f]) : null; // null clears
    }
    if (b.payType !== undefined && b.payType !== '') {
        if (!PAY_TYPES.includes(b.payType)) errors.push(`payType must be one of: ${PAY_TYPES.join(', ')}`); else value.payType = b.payType;
    }
    if (b.payFrequency !== undefined && b.payFrequency !== '') {
        if (!PAY_FREQUENCIES.includes(b.payFrequency)) errors.push(`payFrequency must be one of: ${PAY_FREQUENCIES.join(', ')}`); else value.payFrequency = b.payFrequency;
    }
    if (b.payRate !== undefined && b.payRate !== '' && b.payRate !== null) {
        const r = Number(b.payRate);
        if (!(r > 0) || !Number.isFinite(r) || r > 100000000) errors.push('payRate must be a positive number'); else value.payRate = Math.round(r * 100) / 100;
    }
    if (b.note) value.note = String(b.note).trim().slice(0, 500);
    if (b.reason === 'hire' && !value.payRate) errors.push('a hire record needs payRate');
    if (!STATE_FIELDS.some((f) => value[f] !== undefined)) errors.push('give at least one field to change');
    return { errors, value };
}

const annual = (rate, type) => (type === 'hourly' ? rate * HOURS_PER_YEAR : rate);

/** Percent change in annualized pay between two states (null when there is no pay on either side) */
function percentChange(before, after) {
    if (!before || !after || !(before.payRate > 0) || !(after.payRate > 0)) return null;
    const a = annual(before.payRate, before.payType || 'salary');
    const b = annual(after.payRate, after.payType || before.payType || 'salary');
    return Math.round(((b - a) / a) * 10000) / 100;
}

/** Oldest first; same-day records keep the order they were created in */
function sortTimeline(records) {
    return [...records].sort((x, y) => (x.effectiveDate === y.effectiveDate ? String(x.createdAt || '').localeCompare(String(y.createdAt || '')) : x.effectiveDate < y.effectiveDate ? -1 : 1));
}

const isApproved = (r) => (r.status || 'approved') === 'approved';

/** The state in force on a date: approved records up to that date folded oldest to newest. Null before the first record. */
function stateAsOf(records, dateIso) {
    let state = null;
    for (const r of sortTimeline(records)) {
        if (!isApproved(r) || r.effectiveDate > dateIso) continue;
        state = state || {};
        for (const f of STATE_FIELDS) if (r[f] !== undefined) state[f] = r[f];
        state.effectiveDate = r.effectiveDate;
    }
    return state;
}

/** Timeline with the state after each record and the pay change versus the one before */
function timeline(records, todayIso) {
    const out = []; let state = {};
    for (const r of sortTimeline(records)) {
        const before = { ...state };
        const counted = isApproved(r);
        if (counted) for (const f of STATE_FIELDS) if (r[f] !== undefined) state[f] = r[f];
        out.push({ ...r, status: r.status || 'approved', future: r.effectiveDate > todayIso, payChangePercent: counted ? percentChange(before, { ...state }) : null });
    }
    return out;
}

/** Does this change need a second approver? Only pay changes above the configured percent do. */
function needsApproval(before, afterPartial, thresholdPercent) {
    if (!(thresholdPercent >= 0)) return false;
    if (!PAY_FIELDS.some((f) => afterPartial[f] !== undefined)) return false;
    const after = { ...(before || {}), ...afterPartial };
    const pct = percentChange(before, after);
    if (pct === null) return !before || !(before.payRate > 0) ? false : true; // pay changed but cannot be compared: be careful
    return Math.abs(pct) > thresholdPercent;
}

/** Removes pay fields for viewers without people.read_pay */
function stripPay(record) {
    const r = { ...record };
    for (const f of [...PAY_FIELDS, 'payChangePercent']) delete r[f];
    return r;
}

/** usProfile fields kept in sync with the current state */
function profilePatch(state) {
    const p = {};
    if (!state) return p;
    for (const f of ['payRate', 'payType', 'payFrequency', 'jobTitle']) if (state[f] !== undefined) p[f] = state[f];
    if (state.departmentId !== undefined) p.departmentId = state.departmentId;
    if (state.managerId !== undefined) p.managerId = state.managerId;
    if (state.workLocationId !== undefined) p.workLocationId = state.workLocationId;
    return p;
}

module.exports = { REASONS, STATE_FIELDS, PAY_FIELDS, validateRecord, percentChange, sortTimeline, stateAsOf, timeline, needsApproval, stripPay, profilePatch };
