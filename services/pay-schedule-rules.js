/**
 * Pay schedule rules (pure). All dates are ISO strings (YYYY-MM-DD), calendar math in UTC.
 *
 * A schedule: { name, frequency: weekly|biweekly|semimonthly|monthly, anchorPayDate, payDayLag, paydays,
 *               holidayAdjustment: previous_business_day|next_business_day|none }
 *  - weekly/biweekly: nominal pay dates repeat every 7/14 days from anchorPayDate.
 *  - semimonthly: `paydays` = two days of the month (1-31; 31 means the last day, clamped to short months). Default [15, 31].
 *  - monthly: `paydays` = one day of the month (default 31 = last day).
 *  - payDayLag: calendar days between the end of a pay period and the nominal pay date.
 *    So period end = nominal pay date - lag; a period runs from the day after the previous end to its end.
 *  - The actual pay date moves off weekends (and the `holidays` set passed in) per holidayAdjustment.
 */
const { parseIsoDate, isoDate } = require('./us-forms');

const FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
const ADJUSTMENTS = ['previous_business_day', 'next_business_day', 'none'];

const toDate = (iso) => parseIsoDate(iso);
const addDays = (iso, n) => { const d = toDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };
const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
const daysInMonth = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const clampDay = (y, m0, day) => Math.min(day, daysInMonth(y, m0));
const dateOf = (y, m0, day) => isoDate(new Date(Date.UTC(y, m0, clampDay(y, m0, day))));

function validateSchedule(input) {
    const errors = [];
    const b = input || {};
    const name = String(b.name || '').trim();
    if (!name) errors.push('name is required');
    const frequency = b.frequency;
    if (!FREQUENCIES.includes(frequency)) errors.push(`frequency must be one of: ${FREQUENCIES.join(', ')}`);
    const value = { name, frequency };
    const weekly = frequency === 'weekly' || frequency === 'biweekly';
    if (b.anchorPayDate) {
        if (!toDate(b.anchorPayDate)) errors.push('anchorPayDate must be a valid date (YYYY-MM-DD)');
        else value.anchorPayDate = String(b.anchorPayDate);
    } else if (weekly) errors.push('anchorPayDate is required for weekly and biweekly schedules');
    const lag = b.payDayLag === undefined || b.payDayLag === '' ? 5 : Number(b.payDayLag);
    if (!Number.isInteger(lag) || lag < 0 || lag > 31) errors.push('payDayLag must be a whole number from 0 to 31');
    else value.payDayLag = lag;
    const day = (v) => (String(v).toLowerCase() === 'last' ? 31 : Number(v));
    if (frequency === 'semimonthly') {
        const raw = Array.isArray(b.paydays) && b.paydays.length ? b.paydays : [15, 31];
        const p = raw.map(day);
        if (p.length !== 2 || p.some((x) => !Number.isInteger(x) || x < 1 || x > 31)) errors.push('paydays must be two days of the month (1-31 or "last")');
        else if (p[0] === p[1]) errors.push('the two paydays must be different days');
        else value.paydays = p.sort((x, y) => x - y);
    } else if (frequency === 'monthly') {
        const raw = Array.isArray(b.paydays) && b.paydays.length ? b.paydays[0] : (b.payday !== undefined ? b.payday : 31);
        const p = day(raw);
        if (!Number.isInteger(p) || p < 1 || p > 31) errors.push('payday must be a day of the month (1-31 or "last")');
        else value.paydays = [p];
    }
    const adj = b.holidayAdjustment || 'previous_business_day';
    if (!ADJUSTMENTS.includes(adj)) errors.push(`holidayAdjustment must be one of: ${ADJUSTMENTS.join(', ')}`);
    else value.holidayAdjustment = adj;
    value.active = b.active === undefined ? true : Boolean(b.active);
    return { errors, value };
}

/** Nominal (unadjusted) pay dates within [fromIso, toIso], sorted */
function nominalPayDates(s, fromIso, toIso) {
    const out = [];
    if (s.frequency === 'weekly' || s.frequency === 'biweekly') {
        const step = s.frequency === 'weekly' ? 7 : 14;
        const offset = daysBetween(s.anchorPayDate, fromIso);
        let k = Math.ceil(offset / step);
        for (let d = addDays(s.anchorPayDate, k * step); d <= toIso; d = addDays(d, step)) out.push(d);
        return out;
    }
    const start = toDate(fromIso); const end = toDate(toIso);
    const days = s.paydays || (s.frequency === 'monthly' ? [31] : [15, 31]);
    let y = start.getUTCFullYear(); let m = start.getUTCMonth();
    while (y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth())) {
        for (const day of days) { const d = dateOf(y, m, day); if (d >= fromIso && d <= toIso) out.push(d); }
        m += 1; if (m > 11) { m = 0; y += 1; }
    }
    return out.sort();
}

const isWeekend = (iso) => { const w = toDate(iso).getUTCDay(); return w === 0 || w === 6; };

/** Moves a pay date off weekends/holidays. `holidays` is a Set (or array) of ISO dates. */
function adjustPayDate(iso, mode = 'previous_business_day', holidays = new Set()) {
    if (mode === 'none') return iso;
    const hs = holidays instanceof Set ? holidays : new Set(holidays);
    const step = mode === 'next_business_day' ? 1 : -1;
    let d = iso;
    for (let i = 0; i < 15 && (isWeekend(d) || hs.has(d)); i += 1) d = addDays(d, step);
    return d;
}

const lagOf = (s) => (Number.isInteger(s.payDayLag) ? s.payDayLag : 5);

/** Pay periods whose end falls in [fromIso, toIso], each {start,end,nominalPayDate,payDate}. `start` needs the previous end, so we look one period back. */
function periodsEndingBetween(s, fromIso, toIso, holidays) {
    const lag = lagOf(s);
    const pad = s.frequency === 'monthly' ? 70 : s.frequency === 'semimonthly' ? 40 : 30;
    const nominal = nominalPayDates(s, addDays(fromIso, lag - pad), addDays(toIso, lag + pad));
    const ends = nominal.map((n) => ({ nominal: n, end: addDays(n, -lag) }));
    const out = [];
    for (let i = 1; i < ends.length; i += 1) {
        const e = ends[i];
        if (e.end < fromIso || e.end > toIso) continue;
        out.push({
            start: addDays(ends[i - 1].end, 1), end: e.end, nominalPayDate: e.nominal,
            payDate: adjustPayDate(e.nominal, s.holidayAdjustment, holidays)
        });
    }
    return out;
}

/** The pay period that contains a date */
function periodContaining(s, dateIso, holidays) {
    if (!toDate(dateIso)) return null;
    const list = periodsEndingBetween(s, addDays(dateIso, -1), addDays(dateIso, 70), holidays);
    return list.find((p) => p.start <= dateIso && dateIso <= p.end) || null;
}

/** The next n pay dates on or after fromIso, each with its period */
function nextPayDates(s, fromIso, n = 6, holidays) {
    const out = [];
    let cursor = addDays(fromIso, -45);
    const span = s.frequency === 'weekly' ? 7 * (n + 8) : s.frequency === 'biweekly' ? 14 * (n + 5) : 32 * (n + 4);
    const list = periodsEndingBetween(s, cursor, addDays(fromIso, span), holidays)
        .filter((p) => p.payDate >= fromIso).sort((a, b) => (a.payDate < b.payDate ? -1 : 1));
    for (const p of list) { if (out.length >= n) break; out.push(p); }
    return out;
}

/** Pay date for the period that ends on `periodEndIso` (null if that is not a period end of this schedule) */
function payDateForPeriod(s, periodEndIso, holidays) {
    const p = periodsEndingBetween(s, periodEndIso, periodEndIso, holidays)[0];
    return p ? p.payDate : null;
}

module.exports = {
    FREQUENCIES, ADJUSTMENTS, validateSchedule, nominalPayDates, adjustPayDate, periodContaining, nextPayDates,
    payDateForPeriod, periodsEndingBetween, addDays, daysBetween
};
