/**
 * Paying out unused time off (pure). No I/O.
 *
 * Whether unused time must be paid when someone leaves depends on state law and on the company's own written policy.
 * Nothing about a state is hard-coded here: each leave policy carries its own "paid out" switch (payoutAtTermination)
 * and the company chooses the salary divisor. Confirm with a US compliance advisor.
 *
 * amount = unused hours of the policies that are paid out x the person's hourly rate
 *   hourly person:   pay rate
 *   salaried person: annual salary / hours per year (2080 unless the company sets another number)
 *
 * A payout request moves: pending -> approved -> paid. It can be rejected while pending, or cancelled before it is paid.
 */

const DEFAULT_SALARY_HOURS_PER_YEAR = 2080;
const REASONS = ['termination', 'cash_out'];
const STATUSES = ['pending', 'approved', 'paid', 'rejected', 'cancelled'];
const OPEN_STATUSES = ['pending', 'approved'];
const ADVISOR_NOTE = 'Whether unused time off must be paid out depends on state law and your written policy. Confirm with a US compliance advisor.';

const cents = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round(Number(n) * 10000) / 10000;

function validateSettings(input) {
    const errors = [];
    const b = input || {};
    const value = {};
    if (b.salaryHoursPerYear !== undefined) {
        const n = b.salaryHoursPerYear === null || b.salaryHoursPerYear === '' ? DEFAULT_SALARY_HOURS_PER_YEAR : Number(b.salaryHoursPerYear);
        if (!Number.isFinite(n) || n < 1000 || n > 3000) errors.push('salaryHoursPerYear must be a number from 1000 to 3000 (2080 is 40 hours a week)');
        else value.salaryHoursPerYear = Math.round(n * 100) / 100;
    }
    if (!errors.length && !Object.keys(value).length) errors.push('send salaryHoursPerYear');
    return { errors, value };
}

const normalizeSettings = (s) => {
    const n = Number(s && s.salaryHoursPerYear);
    return { salaryHoursPerYear: Number.isFinite(n) && n >= 1000 && n <= 3000 ? n : DEFAULT_SALARY_HOURS_PER_YEAR };
};

/** The hourly rate used for a payout: { rate, basis } or { error } */
function hourlyRate(profile, settings) {
    const p = profile || {};
    const rate = Number(p.payRate);
    if (!(rate > 0) || !Number.isFinite(rate)) return { error: 'This person has no pay rate on file' };
    if (p.payType === 'hourly') return { rate: round4(rate), basis: 'hourly rate' };
    if (p.payType === 'salary') {
        const divisor = normalizeSettings(settings).salaryHoursPerYear;
        return { rate: round4(rate / divisor), basis: `annual salary / ${divisor} hours`, divisor };
    }
    return { error: 'This person has no pay type (hourly or salary) on file' };
}

/**
 * balances: [{ policyId, policyName, type, payoutAtTermination, balanceHours }] (one per leave policy that applies to the person)
 * Returns { errors, value: { lines, hours, hourlyRate, rateBasis, amount } }.
 * A policy that is not paid out, or has nothing left (or a negative balance), gives a line with 0 hours paid.
 */
function computePayout({ balances, profile, settings } = {}) {
    const errors = [];
    const r = hourlyRate(profile, settings);
    if (r.error) errors.push(r.error);
    const rate = r.rate || 0;
    const lines = (balances || []).map((b) => {
        const unused = Math.max(0, Number(b.balanceHours) || 0);
        const paidOut = Boolean(b.payoutAtTermination);
        const hours = paidOut ? Math.round(unused * 100) / 100 : 0;
        return { policyId: b.policyId, policyName: b.policyName || null, type: b.type || null, unusedHours: Math.round(unused * 100) / 100, paidOut, hours, amount: cents(hours * rate) };
    });
    const hours = Math.round(lines.reduce((s, l) => s + l.hours, 0) * 100) / 100;
    const amount = cents(lines.reduce((s, l) => s + l.amount, 0));
    if (!errors.length && !(hours > 0)) errors.push((balances || []).some((b) => b.payoutAtTermination) ? 'There are no unused hours to pay out' : 'No leave policy of this person is set to be paid out');
    return { errors, value: { lines, hours, hourlyRate: rate, rateBasis: r.basis || null, amount } };
}

function validateRequest(input) {
    const errors = [];
    const b = input || {};
    const userId = String(b.userId || '').trim();
    if (!userId) errors.push('userId is required');
    const reason = b.reason === undefined || b.reason === '' ? 'termination' : String(b.reason);
    if (!REASONS.includes(reason)) errors.push(`reason must be one of: ${REASONS.join(', ')}`);
    const note = String(b.note || '').trim().slice(0, 300);
    return { errors, value: { userId, reason, note } };
}

const ACTIONS = {
    approve: { from: ['pending'], to: 'approved', word: 'approved' },
    reject: { from: ['pending'], to: 'rejected', word: 'rejected' },
    paid: { from: ['approved'], to: 'paid', word: 'marked paid' },
    cancel: { from: ['pending', 'approved'], to: 'cancelled', word: 'cancelled' }
};

/** { to } when the action is allowed from this status, otherwise { error } */
function transition(status, action) {
    const a = ACTIONS[action];
    if (!a) return { error: `unknown action: ${action}` };
    if (!a.from.includes(status)) return { error: `This payout is already ${status}; it cannot be ${a.word}` };
    return { to: a.to };
}

/** Did the numbers change between the request and now? (compares hours per policy and the rate) */
function sameNumbers(stored, fresh) {
    if (!stored || !fresh) return false;
    if (Math.abs(Number(stored.hourlyRate) - Number(fresh.hourlyRate)) > 0.00005) return false;
    if (Math.abs(Number(stored.amount) - Number(fresh.amount)) > 0.005) return false;
    const key = (lines) => (lines || []).filter((l) => l.hours > 0).map((l) => `${l.policyId}:${l.hours}`).sort().join('|');
    return key(stored.lines) === key(fresh.lines);
}

/** Negative balance adjustments to record when a payout is paid, so the same hours cannot be paid twice */
function adjustmentsFor(payout) {
    return (payout.lines || []).filter((l) => l.hours > 0).map((l) => ({ policyId: l.policyId, hours: -l.hours }));
}

/** The row the payroll side reads */
function payrollRow(p) {
    return {
        id: p.id, userId: p.userId, employeeId: p.employeeId || null, name: p.name || null, reason: p.reason, hours: p.hours,
        hourlyRate: p.hourlyRate, amount: p.amount, approvedAt: p.approvedAt || null, earningType: 'pto_payout',
        lines: (p.lines || []).filter((l) => l.hours > 0).map((l) => ({ policyId: l.policyId, policyName: l.policyName, hours: l.hours, amount: l.amount }))
    };
}

const csvCell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; // spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(rows) {
    const head = ['Payout ID', 'Employee ID', 'Name', 'Reason', 'Hours', 'Hourly rate', 'Amount', 'Approved at', 'Earning type'];
    const lines = (rows || []).map((r) => [r.id, r.employeeId, r.name, r.reason, r.hours, r.hourlyRate, Number(r.amount).toFixed(2), r.approvedAt, r.earningType || 'pto_payout'].map(csvCell).join(','));
    return `${[head.join(','), ...lines].join('\r\n')}\r\n`;
}

module.exports = {
    DEFAULT_SALARY_HOURS_PER_YEAR, REASONS, STATUSES, OPEN_STATUSES, ADVISOR_NOTE,
    validateSettings, normalizeSettings, hourlyRate, computePayout, validateRequest, transition, sameNumbers, adjustmentsFor, payrollRow, toCsv, csvCell
};
