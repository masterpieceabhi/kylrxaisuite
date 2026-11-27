/**
 * Tip tracking rules (pure). Cash tips are declared by the employee each day; card tips come from
 * entries made by a manager or payroll. The $20 monthly reporting threshold is a setting (default
 * is the well-known IRS figure). Tip credit checks use the dated wage rules. Confirm with an advisor.
 */
const { parseIsoDate } = require('./us-forms');

const DEFAULT_SETTINGS = { monthlyReportingThreshold: 20, defaultShareMethod: 'hours' };
const SHARE_METHODS = ['hours', 'percentage'];
const round2 = (n) => Math.round(n * 100) / 100;
const cents = (n) => Math.round(Number(n) * 100);

function validateEntry(input, todayIso) {
    const errors = [];
    const b = input || {};
    const value = {};
    if (!parseIsoDate(b.date)) errors.push('date must be a valid date (YYYY-MM-DD)');
    else if (todayIso && b.date > todayIso) errors.push('date cannot be in the future');
    else value.date = b.date;
    const money = (f, required) => {
        if ((b[f] === undefined || b[f] === '' || b[f] === null) && !required) return 0;
        const n = Number(b[f]);
        if (!Number.isFinite(n) || n < 0 || n > 10000) { errors.push(`${f} must be an amount between 0 and 10000`); return 0; }
        return round2(n);
    };
    value.cashTips = money('cashTips');
    value.cardTips = money('cardTips');
    if (value.cashTips === 0 && value.cardTips === 0 && !errors.length) errors.push('enter cash tips or card tips greater than zero');
    value.note = String(b.note || '').trim().slice(0, 200);
    return { errors, value };
}

/** Sum entries (one per record) within a month 'YYYY-MM' */
function monthlyTotal(entries, month, threshold = DEFAULT_SETTINGS.monthlyReportingThreshold) {
    const mine = (entries || []).filter((e) => String(e.date).startsWith(month));
    const cash = round2(mine.reduce((s, e) => s + Number(e.cashTips || 0), 0));
    const card = round2(mine.reduce((s, e) => s + Number(e.cardTips || 0), 0));
    const total = round2(cash + card);
    return { month, cashTips: cash, cardTips: card, total, days: mine.length, reportToEmployer: cash + card >= threshold, threshold };
}

/** Wage-rule check for a pay period: cash wage plus tip credit must reach the full minimum */
function tipCreditCheck({ cashWage, tips, hours, minimum, tippedCashWage }) {
    const errors = [];
    if (!(hours > 0)) errors.push('hours must be greater than zero');
    if (!(cashWage >= 0)) errors.push('cashWage is required');
    if (minimum === null || minimum === undefined) errors.push('no applicable minimum wage rule');
    if (errors.length) return { errors };
    const tipsPerHour = tips / hours;
    const maxCredit = Math.max(0, minimum - cashWage);
    const credit = Math.min(tipsPerHour, maxCredit);
    const effective = cashWage + tipsPerHour;
    const cashOk = tippedCashWage === null || tippedCashWage === undefined ? cashWage >= minimum : cashWage >= tippedCashWage;
    const reachedMinimum = effective >= minimum;
    const makeUpPerHour = Math.max(0, minimum - effective);
    return {
        errors: [], cashWage: round2(cashWage), tipsPerHour: round2(tipsPerHour), tipCreditPerHour: round2(credit),
        effectiveHourly: round2(effective), minimum, tippedCashWage: tippedCashWage ?? null,
        cashWageOk: cashOk, reachedMinimum, ok: cashOk && reachedMinimum,
        makeUpPerHour: round2(makeUpPerHour), makeUpAmount: round2(makeUpPerHour * hours)
    };
}

function validatePool(input) {
    const errors = [];
    const b = input || {};
    const value = {};
    const name = String(b.name || '').trim();
    if (name.length < 2) errors.push('name is required'); else value.name = name;
    if (!SHARE_METHODS.includes(b.shareMethod)) errors.push(`shareMethod must be one of: ${SHARE_METHODS.join(', ')}`);
    else value.shareMethod = b.shareMethod;
    value.excludeManagers = b.excludeManagers !== false;
    const parts = Array.isArray(b.participants) ? b.participants : [];
    if (!parts.length) errors.push('add at least one participant');
    value.participants = [];
    const seen = new Set();
    parts.forEach((p, i) => {
        const id = String((p && p.userId) || '').trim();
        if (!id) { errors.push(`participant ${i + 1}: userId is required`); return; }
        if (seen.has(id)) { errors.push(`participant ${i + 1}: duplicate person`); return; }
        seen.add(id);
        const row = { userId: id, name: String(p.name || '').slice(0, 80), manager: p.manager === true };
        if (b.shareMethod === 'percentage') {
            const pct = Number(p.percent);
            if (!(pct >= 0 && pct <= 100)) errors.push(`participant ${i + 1}: percent must be 0 to 100`); else row.percent = pct;
        }
        value.participants.push(row);
    });
    if (b.shareMethod === 'percentage' && !errors.length) {
        const total = value.participants.filter((p) => !(value.excludeManagers && p.manager)).reduce((s, p) => s + p.percent, 0);
        if (Math.abs(total - 100) > 0.01) errors.push(`percentages of included participants must add up to 100 (now ${round2(total)})`);
    }
    return { errors, value };
}

/**
 * Distribute a pool in whole cents (largest remainder, so the parts always add up).
 * hoursByUser: { userId: hours } used for the hours method.
 */
function distribute(pool, amount, hoursByUser = {}) {
    const total = cents(amount);
    if (!(total > 0)) return { errors: ['amount must be greater than zero'], shares: [] };
    const included = pool.participants.filter((p) => !(pool.excludeManagers && p.manager));
    const excluded = pool.participants.filter((p) => pool.excludeManagers && p.manager).map((p) => ({ userId: p.userId, name: p.name, amount: 0, excluded: true }));
    let weights;
    if (pool.shareMethod === 'hours') weights = included.map((p) => Math.max(0, Number(hoursByUser[p.userId] || 0)));
    else weights = included.map((p) => Number(p.percent || 0));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return { errors: [pool.shareMethod === 'hours' ? 'no hours recorded for the participants' : 'no included participants'], shares: [] };
    const raw = weights.map((w) => (total * w) / sum);
    const floors = raw.map(Math.floor);
    let left = total - floors.reduce((a, b) => a + b, 0);
    const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; left > 0; k++, left--) floors[order[k % order.length].i] += 1;
    const shares = included.map((p, i) => ({ userId: p.userId, name: p.name, hours: pool.shareMethod === 'hours' ? weights[i] : undefined, percent: pool.shareMethod === 'percentage' ? p.percent : undefined, amount: floors[i] / 100 }));
    return { errors: [], total: total / 100, shares: [...shares, ...excluded] };
}

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (header, rows) => [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n';

/** Payroll tip report per person for a date range: rows = tip_records */
function tipReportRows(records, people, from, to, threshold = DEFAULT_SETTINGS.monthlyReportingThreshold) {
    const by = new Map();
    for (const r of records) {
        if (r.date < from || r.date > to) continue;
        const cur = by.get(r.userId) || { userId: r.userId, cashTips: 0, cardTips: 0, days: 0 };
        cur.cashTips += Number(r.cashTips || 0); cur.cardTips += Number(r.cardTips || 0); cur.days += 1;
        by.set(r.userId, cur);
    }
    return [...by.values()].map((r) => {
        const p = people[r.userId] || {};
        const total = round2(r.cashTips + r.cardTips);
        return { employeeId: p.employeeId || '', name: p.name || '', userId: r.userId, from, to, days: r.days, cashTips: round2(r.cashTips), cardTips: round2(r.cardTips), totalTips: total, reportable: total >= threshold ? 'yes' : 'no' };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
const TIP_REPORT_HEADER = ['employeeId', 'name', 'userId', 'from', 'to', 'days', 'cashTips', 'cardTips', 'totalTips', 'reportable'];

module.exports = { DEFAULT_SETTINGS, SHARE_METHODS, validateEntry, monthlyTotal, tipCreditCheck, validatePool, distribute, tipReportRows, TIP_REPORT_HEADER, toCsv, csvCell };
