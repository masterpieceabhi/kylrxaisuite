/**
 * Pure rules for paid time off (PTO) and paid sick leave. No I/O.
 *
 * Nothing about a particular state or city is hard-coded: a policy carries its own accrual
 * method and limits, and a US compliance reviewer must confirm them for each state. PRESETS are
 * starting points only.
 *
 * Accrual methods:
 *   hours_worked  earnHours for every perHours worked (for example 1 per 30)
 *   monthly       monthlyHours on the last day of each month once eligible
 *   front_load    grantHours at the start of each policy year (and on the hire date)
 */
const { parseIsoDate, isoDate, federalHolidays } = require('./us-forms');

const METHODS = ['hours_worked', 'monthly', 'front_load'];
const TYPES = ['pto', 'sick'];
const round2 = (n) => Math.round(n * 100) / 100;
const round4 = (n) => Math.round(n * 10000) / 10000;

const PRESETS = [
    {
        key: 'sick_1_per_30', name: 'Paid sick leave: 1 hour per 30 worked', type: 'sick',
        accrual: { method: 'hours_worked', earnHours: 1, perHours: 30 },
        annualAccrualCap: 40, annualUseCap: 40, maxBalance: 80, carryoverCap: 40, usageWaitingDays: 0, accrualStartsAfterDays: 0,
        minimumIncrementHours: 0.25, payoutAtTermination: false
    },
    {
        key: 'sick_front_load_40', name: 'Paid sick leave: 40 hours each year', type: 'sick',
        accrual: { method: 'front_load', grantHours: 40 },
        annualAccrualCap: null, annualUseCap: null, maxBalance: 40, carryoverCap: 0, usageWaitingDays: 0, accrualStartsAfterDays: 0,
        minimumIncrementHours: 0.25, payoutAtTermination: false
    },
    {
        key: 'pto_monthly_80', name: 'PTO: 80 hours a year, earned monthly', type: 'pto',
        accrual: { method: 'monthly', monthlyHours: 6.67 },
        annualAccrualCap: null, annualUseCap: null, maxBalance: 120, carryoverCap: 40, usageWaitingDays: 90, accrualStartsAfterDays: 0,
        minimumIncrementHours: 1, payoutAtTermination: false
    },
    {
        key: 'pto_hourly_1_per_26', name: 'PTO for hourly staff: 1 hour per 26 worked', type: 'pto',
        accrual: { method: 'hours_worked', earnHours: 1, perHours: 26 },
        annualAccrualCap: null, annualUseCap: null, maxBalance: 80, carryoverCap: 40, usageWaitingDays: 90, accrualStartsAfterDays: 0,
        minimumIncrementHours: 1, payoutAtTermination: false
    }
];

function validatePolicy(input) {
    const errors = [];
    const b = input || {};
    const value = {
        name: String(b.name || '').trim(),
        type: b.type,
        accrual: {},
        annualAccrualCap: null, annualUseCap: null, maxBalance: null, carryoverCap: null,
        usageWaitingDays: 0, accrualStartsAfterDays: 0,
        minimumIncrementHours: 0.25, allowNegative: b.allowNegative === true, payoutAtTermination: b.payoutAtTermination === true,
        skipHolidays: b.skipHolidays !== false,
        policyYearStart: { month: 1, day: 1 },
        appliesTo: { states: [], includeContractors: false },
        notes: String(b.notes || '').slice(0, 500)
    };
    if (!value.name) errors.push('name is required');
    if (!TYPES.includes(value.type)) errors.push(`type must be one of: ${TYPES.join(', ')}`);

    const a = b.accrual || {};
    if (!METHODS.includes(a.method)) errors.push(`accrual.method must be one of: ${METHODS.join(', ')}`);
    else {
        value.accrual.method = a.method;
        const pos = (field) => {
            const n = Number(a[field]);
            if (!(n > 0) || !Number.isFinite(n)) errors.push(`accrual.${field} must be a positive number`); else value.accrual[field] = n;
        };
        if (a.method === 'hours_worked') { pos('earnHours'); pos('perHours'); }
        if (a.method === 'monthly') pos('monthlyHours');
        if (a.method === 'front_load') pos('grantHours');
    }

    for (const f of ['annualAccrualCap', 'annualUseCap', 'maxBalance', 'carryoverCap']) {
        if (b[f] === null || b[f] === undefined || b[f] === '') continue;
        const n = Number(b[f]);
        if (!(n >= 0) || !Number.isFinite(n)) errors.push(`${f} must be 0 or more, or left empty for no limit`); else value[f] = n;
    }
    for (const f of ['usageWaitingDays', 'accrualStartsAfterDays']) {
        if (b[f] === undefined || b[f] === '') continue;
        const n = Number(b[f]);
        if (!Number.isInteger(n) || n < 0 || n > 730) errors.push(`${f} must be a whole number of days, 0 to 730`); else value[f] = n;
    }
    if (b.minimumIncrementHours !== undefined) {
        const n = Number(b.minimumIncrementHours);
        if (!(n > 0 && n <= 8)) errors.push('minimumIncrementHours must be between 0 and 8'); else value.minimumIncrementHours = n;
    }
    if (b.policyYearStart) {
        const m = Number(b.policyYearStart.month); const d = Number(b.policyYearStart.day);
        if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(d) || d < 1 || d > 28) errors.push('policyYearStart needs a month 1-12 and a day 1-28');
        else value.policyYearStart = { month: m, day: d };
    }
    if (b.appliesTo) {
        const states = Array.isArray(b.appliesTo.states) ? b.appliesTo.states.map((s) => String(s).trim().toUpperCase()).filter(Boolean) : [];
        value.appliesTo = { states: Array.from(new Set(states)), includeContractors: b.appliesTo.includeContractors === true };
    }
    return { errors, value };
}

/** True when a policy applies to a person with this US profile */
function appliesTo(policy, profile) {
    const p = profile || {};
    if (p.classification === '1099' && !(policy.appliesTo && policy.appliesTo.includeContractors)) return false;
    const states = (policy.appliesTo && policy.appliesTo.states) || [];
    if (states.length === 0) return true;
    return Boolean(p.workState) && states.includes(p.workState);
}

function addDays(iso, n) {
    const d = parseIsoDate(iso);
    d.setUTCDate(d.getUTCDate() + n);
    return isoDate(d);
}

const lastDayOfMonth = (iso) => {
    const d = parseIsoDate(iso);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate() === d.getUTCDate();
};

/**
 * Day-by-day balance. ctx = {
 *   hireDate, asOf, workedByDay: { 'YYYY-MM-DD': hours }, usage: [{date, hours}], adjustments: [{date, hours}],
 *   pendingHours?: number
 * }
 */
function simulate(policy, ctx) {
    const hire = ctx.hireDate;
    const asOf = ctx.asOf;
    const out = {
        balance: 0, accruedThisYear: 0, usedThisYear: 0, forfeited: 0, scheduledHours: 0, pendingHours: ctx.pendingHours || 0,
        eligibleToUse: false, usageEligibleOn: null, nextResetDate: null, availableToUse: 0
    };
    if (!parseIsoDate(hire) || !parseIsoDate(asOf) || hire > asOf) {
        out.usageEligibleOn = parseIsoDate(hire) ? addDays(hire, policy.usageWaitingDays || 0) : null;
        return finish(policy, out, ctx);
    }
    const usageByDay = new Map();
    const adjByDay = new Map();
    for (const u of ctx.usage || []) {
        if (u.date <= asOf) usageByDay.set(u.date, (usageByDay.get(u.date) || 0) + Number(u.hours));
        else out.scheduledHours += Number(u.hours);
    }
    for (const a of ctx.adjustments || []) if (a.date <= asOf) adjByDay.set(a.date, (adjByDay.get(a.date) || 0) + Number(a.hours));

    const ps = policy.policyYearStart || { month: 1, day: 1 };
    const accrualFrom = addDays(hire, policy.accrualStartsAfterDays || 0);
    const method = policy.accrual.method;
    let balance = 0; let yearAccrued = 0; let yearUsed = 0; let forfeited = 0;

    const grant = (hours) => {
        let g = hours;
        if (policy.annualAccrualCap !== null && policy.annualAccrualCap !== undefined) g = Math.min(g, Math.max(0, policy.annualAccrualCap - yearAccrued));
        if (policy.maxBalance !== null && policy.maxBalance !== undefined) g = Math.min(g, Math.max(0, policy.maxBalance - balance));
        g = Math.max(0, g);
        balance += g; yearAccrued += g;
    };

    if (method === 'front_load') grant(policy.accrual.grantHours); // on the hire date

    for (let d = hire; d <= asOf; d = addDays(d, 1)) {
        const dt = parseIsoDate(d);
        const isYearStart = d !== hire && dt.getUTCMonth() + 1 === ps.month && dt.getUTCDate() === ps.day;
        if (isYearStart) {
            const carry = policy.carryoverCap === null || policy.carryoverCap === undefined ? balance : Math.min(balance, policy.carryoverCap);
            forfeited += balance - carry; balance = carry; yearAccrued = 0; yearUsed = 0;
            if (method === 'front_load') grant(policy.accrual.grantHours);
        }
        if (d >= accrualFrom) {
            if (method === 'hours_worked') {
                const worked = Number((ctx.workedByDay || {})[d] || 0);
                if (worked > 0) grant(worked * policy.accrual.earnHours / policy.accrual.perHours);
            } else if (method === 'monthly' && lastDayOfMonth(d)) {
                grant(policy.accrual.monthlyHours);
            }
        }
        if (adjByDay.has(d)) balance += adjByDay.get(d);
        if (usageByDay.has(d)) { balance -= usageByDay.get(d); yearUsed += usageByDay.get(d); }
    }

    out.balance = round4(balance); out.accruedThisYear = round4(yearAccrued); out.usedThisYear = round4(yearUsed); out.forfeited = round4(forfeited);
    const asOfD = parseIsoDate(asOf);
    let next = new Date(Date.UTC(asOfD.getUTCFullYear(), ps.month - 1, ps.day));
    if (isoDate(next) <= asOf) next = new Date(Date.UTC(asOfD.getUTCFullYear() + 1, ps.month - 1, ps.day));
    out.nextResetDate = isoDate(next);
    out.usageEligibleOn = addDays(hire, policy.usageWaitingDays || 0);
    return finish(policy, out, ctx);
}

function finish(policy, out, ctx) {
    out.eligibleToUse = Boolean(out.usageEligibleOn) && out.usageEligibleOn <= ctx.asOf;
    let avail = out.balance - out.pendingHours;
    if (policy.annualUseCap !== null && policy.annualUseCap !== undefined) avail = Math.min(avail, policy.annualUseCap - out.usedThisYear - out.pendingHours);
    out.availableBalance = Math.max(0, round4(avail)); // ignores the waiting period
    out.availableToUse = out.eligibleToUse ? out.availableBalance : 0;
    for (const k of ['balance', 'accruedThisYear', 'usedThisYear', 'forfeited', 'scheduledHours', 'pendingHours', 'availableToUse', 'availableBalance']) out[k] = round2(out[k]);
    return out;
}

/** Dates a request covers, skipping weekends (unless asked) and federal holidays (policy setting) */
function requestDates(startDate, endDate, options = {}) {
    const s = parseIsoDate(startDate); const e = parseIsoDate(endDate);
    if (!s || !e || e < s) return null;
    const dates = [];
    for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
        if (dates.length > 366) return null;
        const dow = d.getUTCDay();
        if (!options.includeWeekends && (dow === 0 || dow === 6)) continue;
        if (options.skipHolidays && federalHolidays(d.getUTCFullYear()).has(isoDate(d))) continue;
        dates.push(isoDate(d));
    }
    return dates;
}

/**
 * Checks a time-off request. balance is the simulate() result for the request's policy.
 * Returns { errors, value } with value.dates and value.hours when valid.
 */
function validateRequest(policy, input, balance, todayIso, overlapDates = []) {
    const errors = [];
    const b = input || {};
    const dates = requestDates(b.startDate, b.endDate, { includeWeekends: b.includeWeekends === true, skipHolidays: policy.skipHolidays !== false });
    if (!dates) return { errors: ['startDate and endDate must be real dates (YYYY-MM-DD), end not before start, at most a year'], value: null };
    if (dates.length === 0) return { errors: ['those dates have no working days (weekends and holidays are skipped)'], value: null };

    const perDay = b.hoursPerDay === undefined || b.hoursPerDay === '' ? 8 : Number(b.hoursPerDay);
    const inc = policy.minimumIncrementHours || 0.25;
    if (!(perDay > 0 && perDay <= 24)) errors.push('hoursPerDay must be between 0 and 24');
    else if (Math.abs(perDay / inc - Math.round(perDay / inc)) > 1e-9) errors.push(`hours must be in steps of ${inc}`);

    const earliest = policy.type === 'sick' ? addDays(todayIso, -30) : todayIso;
    if (dates[0] < earliest) errors.push(policy.type === 'sick' ? 'sick leave can be requested up to 30 days back' : 'PTO must start today or later');

    const total = round2(dates.length * (perDay > 0 ? perDay : 0));
    if (!balance.eligibleToUse && dates[0] < (balance.usageEligibleOn || '9999')) errors.push(`this leave can be used starting ${balance.usageEligibleOn}`);
    if (errors.length === 0 && !policy.allowNegative && total > balance.availableBalance + 1e-9) {
        errors.push(`not enough balance: ${balance.availableBalance} hours available, ${total} requested`);
    }
    const clash = dates.filter((d) => overlapDates.includes(d));
    if (clash.length) errors.push(`you already have time off on ${clash[0]}${clash.length > 1 ? ` and ${clash.length - 1} more day(s)` : ''}`);
    return { errors, value: errors.length ? null : { dates, hoursPerDay: perDay, hours: total } };
}

module.exports = { METHODS, TYPES, PRESETS, validatePolicy, appliesTo, simulate, requestDates, validateRequest, addDays };
