/**
 * Billing rules (pure, no I/O). Money is always whole cents.
 *
 * Plan = base fee + per-active-employee price per month, with a monthly minimum, a trial length and
 * an annual-prepay discount. The plan catalog is DATA (editable by the platform operator), never code.
 * Prices, taxes and dunning timing below are defaults, not advice: confirm tax handling with an advisor.
 */

const DAY = 86400000;

const DEFAULT_PLANS = [
    { id: 'starter', name: 'Starter', baseFeeCents: 4900, perEmployeeCents: 800, minimumCents: 4900, trialDays: 14, annualDiscountPct: 15, active: true },
    { id: 'growth', name: 'Growth', baseFeeCents: 9900, perEmployeeCents: 1200, minimumCents: 9900, trialDays: 14, annualDiscountPct: 15, active: true },
    { id: 'scale', name: 'Scale', baseFeeCents: 24900, perEmployeeCents: 1800, minimumCents: 24900, trialDays: 30, annualDiscountPct: 20, active: true }
];

/** Dunning: days after the first failed payment on which a retry runs, and when the account goes read-only */
const DEFAULT_DUNNING = { retryAfterDays: [1, 3, 5, 7], graceDays: 14, reminderEmailDays: [0, 3, 7, 12] };

const STATES = ['trial', 'active', 'past_due', 'suspended', 'cancelled'];
const INTERVALS = ['monthly', 'annual'];

const isInt = (n) => Number.isInteger(n);

function validatePlan(input) {
    const errors = [];
    const b = input || {};
    const id = String(b.id || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,32}$/.test(id)) errors.push('id must be 2-32 letters, numbers, - or _');
    const name = String(b.name || '').trim();
    if (!name) errors.push('name is required');
    const money = (k) => {
        const v = Number(b[k]);
        if (!isInt(v) || v < 0 || v > 100000000) { errors.push(`${k} must be a whole number of cents, 0 or more`); return 0; }
        return v;
    };
    const baseFeeCents = money('baseFeeCents');
    const perEmployeeCents = money('perEmployeeCents');
    const minimumCents = b.minimumCents === undefined ? 0 : money('minimumCents');
    const trialDays = b.trialDays === undefined ? 14 : Number(b.trialDays);
    if (!isInt(trialDays) || trialDays < 0 || trialDays > 120) errors.push('trialDays must be a whole number from 0 to 120');
    const annualDiscountPct = b.annualDiscountPct === undefined ? 0 : Number(b.annualDiscountPct);
    if (!(annualDiscountPct >= 0 && annualDiscountPct <= 60)) errors.push('annualDiscountPct must be between 0 and 60');
    return { errors, value: errors.length ? null : { id, name: name.slice(0, 60), baseFeeCents, perEmployeeCents, minimumCents, trialDays, annualDiscountPct, active: b.active !== false } };
}

/** Who counts as billable headcount on the billing-day snapshot */
function countBillable(people, opts = {}) {
    let employees = 0; let contractors = 0;
    for (const p of people || []) {
        if (!p || !p.employeeId) continue;
        if (/^terminated$/i.test(String(p.status || ''))) continue;
        const contractor = (p.usProfile && p.usProfile.classification === '1099') || /^(contractor|1099)$/i.test(String(p.employeeType || p.workerType || ''));
        if (contractor) contractors += 1; else employees += 1;
    }
    const billable = employees + (opts.includeContractors ? contractors : 0);
    return { employees, contractors, billable, includeContractors: Boolean(opts.includeContractors) };
}

/** One month at a given headcount. Annual: 12 months with the annual discount, charged up front. */
function priceCycle(plan, headcount, interval = 'monthly') {
    const usage = Math.max(0, Math.floor(headcount || 0)) * plan.perEmployeeCents;
    const monthly = Math.max(plan.baseFeeCents + usage, plan.minimumCents || 0);
    if (interval === 'annual') {
        const gross = monthly * 12;
        const discount = Math.round(gross * (plan.annualDiscountPct || 0) / 100);
        return { baseCents: plan.baseFeeCents * 12, usageCents: usage * 12, minimumTopUpCents: Math.max(0, (monthly - plan.baseFeeCents - usage)) * 12, discountCents: discount, totalCents: gross - discount };
    }
    return { baseCents: plan.baseFeeCents, usageCents: usage, minimumTopUpCents: Math.max(0, monthly - plan.baseFeeCents - usage), discountCents: 0, totalCents: monthly };
}

const iso = (d) => d.toISOString().slice(0, 10);
const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s)); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Same calendar day next month/year, clamped to the month's length (31st -> 28th/30th) */
function addMonths(d, n) {
    const y = d.getUTCFullYear(); const m = d.getUTCMonth() + n;
    const yy = y + Math.floor(m / 12); const mm = ((m % 12) + 12) % 12;
    return new Date(Date.UTC(yy, mm, Math.min(d.getUTCDate(), daysInMonth(yy, mm))));
}

/** The billing period [start, end) of the given interval that contains `onDate`, anchored on `anchorIso` */
function periodFor(anchorIso, interval, onDateIso) {
    const anchor = parse(anchorIso); const on = parse(onDateIso);
    const step = interval === 'annual' ? 12 : 1;
    let k = Math.max(0, Math.floor(((on.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + (on.getUTCMonth() - anchor.getUTCMonth())) / step));
    let start = addMonths(anchor, k * step);
    while (start > on && k > 0) { k -= 1; start = addMonths(anchor, k * step); }
    while (addMonths(anchor, (k + 1) * step) <= on) { k += 1; start = addMonths(anchor, k * step); }
    return { start: iso(start), end: iso(addMonths(anchor, (k + 1) * step)) };
}

/**
 * Plan change in the middle of a period: credit the unused part of what was paid, charge the rest of
 * the period on the new plan. Returns two signed amounts and their net (positive = customer owes).
 */
function prorate(oldTotalCents, newTotalCents, periodStartIso, periodEndIso, changeIso) {
    const s = parse(periodStartIso); const e = parse(periodEndIso); const c = parse(changeIso);
    const total = Math.round((e - s) / DAY);
    const left = Math.min(total, Math.max(0, Math.round((e - c) / DAY)));
    if (total <= 0) return { daysTotal: 0, daysLeft: 0, creditCents: 0, chargeCents: 0, netCents: 0 };
    const creditCents = Math.round(oldTotalCents * left / total);
    const chargeCents = Math.round(newTotalCents * left / total);
    return { daysTotal: total, daysLeft: left, creditCents, chargeCents, netCents: chargeCents - creditCents };
}

/**
 * Builds invoice lines and totals. `credits` are account credits applied (never below zero total).
 * Tax is a PLACEHOLDER: pass taxRatePct (default 0) once a tax service/advisor says what applies.
 */
function buildInvoice({ plan, interval = 'monthly', headcount, period, adjustments = [], creditAvailableCents = 0, taxRatePct = 0, trial = false }) {
    const lines = [];
    const price = priceCycle(plan, headcount, interval);
    const unit = interval === 'annual' ? 'year' : 'month';
    if (trial) {
        lines.push({ key: 'trial', description: `${plan.name} plan trial (${period.start} to ${period.end})`, quantity: 1, unitCents: 0, amountCents: 0 });
    } else {
        lines.push({ key: 'base', description: `${plan.name} plan base fee per ${unit}`, quantity: interval === 'annual' ? 12 : 1, unitCents: plan.baseFeeCents, amountCents: price.baseCents });
        if (headcount > 0) lines.push({ key: 'usage', description: `Active employees (${headcount} on ${period.snapshotDate || period.start}) at ${(plan.perEmployeeCents / 100).toFixed(2)} per employee per month`, quantity: headcount * (interval === 'annual' ? 12 : 1), unitCents: plan.perEmployeeCents, amountCents: price.usageCents });
        if (price.minimumTopUpCents > 0) lines.push({ key: 'minimum', description: `Minimum charge top-up (minimum ${(plan.minimumCents / 100).toFixed(2)} per month)`, quantity: 1, unitCents: price.minimumTopUpCents, amountCents: price.minimumTopUpCents });
        if (price.discountCents > 0) lines.push({ key: 'discount', description: `Annual prepay discount (${plan.annualDiscountPct}%)`, quantity: 1, unitCents: -price.discountCents, amountCents: -price.discountCents });
    }
    for (const a of adjustments) lines.push({ key: a.key || 'adjustment', description: String(a.description).slice(0, 160), quantity: 1, unitCents: a.amountCents, amountCents: a.amountCents });
    const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
    const taxableCents = Math.max(0, subtotalCents);
    const taxCents = Math.round(taxableCents * (taxRatePct || 0) / 100);
    const gross = Math.max(0, subtotalCents) + taxCents;
    const creditAppliedCents = Math.min(Math.max(0, creditAvailableCents), gross);
    return {
        lines, subtotalCents, taxCents, taxRatePct: taxRatePct || 0, taxNote: 'Tax is a placeholder. Confirm sales tax handling with a US tax advisor.',
        creditAppliedCents, totalCents: gross - creditAppliedCents,
        negativeCreditCents: subtotalCents < 0 ? -subtotalCents : 0
    };
}

const isReadOnly = (state) => state === 'suspended' || state === 'cancelled';

/** Where a trial ends (ISO date) */
const trialEnd = (startIso, trialDays) => iso(addDays(parse(startIso), trialDays));

/**
 * Account state after something happened. Pure state machine:
 *  trial_ended(hasPaymentMethod)  trial -> active (paid next) or past_due when no payment method
 *  payment_succeeded               any except cancelled -> active, clears dunning
 *  payment_failed                  trial/active -> past_due, starts the grace clock; stays put otherwise
 *  grace_expired                   past_due -> suspended
 *  cancel                          any -> cancelled
 *  reactivate                      cancelled/suspended -> active after payment (use payment_succeeded)
 */
function nextState(account, event, nowIso, dunning = DEFAULT_DUNNING) {
    const a = { ...account };
    const now = String(nowIso).slice(0, 10);
    switch (event.type) {
        case 'trial_ended':
            if (a.state === 'trial') { a.state = event.hasPaymentMethod ? 'active' : 'past_due'; if (a.state === 'past_due') { a.firstFailedAt = a.firstFailedAt || now; a.graceEndsAt = iso(addDays(parse(now), dunning.graceDays)); } }
            break;
        case 'payment_succeeded':
            if (a.state !== 'cancelled') { a.state = 'active'; a.firstFailedAt = null; a.graceEndsAt = null; a.dunningAttempts = 0; }
            break;
        case 'payment_failed':
            if (a.state === 'trial' || a.state === 'active') { a.state = 'past_due'; a.firstFailedAt = now; a.graceEndsAt = iso(addDays(parse(now), dunning.graceDays)); }
            a.dunningAttempts = (a.dunningAttempts || 0) + 1;
            break;
        case 'grace_expired':
            if (a.state === 'past_due') a.state = 'suspended';
            break;
        case 'cancel':
            a.state = 'cancelled';
            break;
        default: break;
    }
    return a;
}

/** What dunning should do today for an account: retry a charge, send a reminder, or suspend */
function dunningAction(account, todayIso, dunning = DEFAULT_DUNNING) {
    if (account.state !== 'past_due' || !account.firstFailedAt) return { action: 'none' };
    const since = Math.round((parse(todayIso) - parse(account.firstFailedAt)) / DAY);
    if (account.graceEndsAt && todayIso >= account.graceEndsAt) return { action: 'suspend', daysSinceFailure: since };
    const retry = dunning.retryAfterDays.includes(since);
    const remind = dunning.reminderEmailDays.includes(since);
    return { action: retry ? 'retry' : (remind ? 'remind' : 'none'), remind, daysSinceFailure: since, daysToSuspension: account.graceEndsAt ? Math.round((parse(account.graceEndsAt) - parse(todayIso)) / DAY) : null };
}

/** Is the account due a new invoice today? (period end reached) */
function invoiceDue(account, todayIso) {
    if (['cancelled', 'suspended'].includes(account.state)) return false;
    if (account.state === 'trial') return Boolean(account.trialEndsAt) && todayIso >= account.trialEndsAt;
    return Boolean(account.currentPeriodEnd) && todayIso >= account.currentPeriodEnd;
}

function money(cents, cur = 'USD') {
    const sign = cents < 0 ? '-' : '';
    return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${cur === 'USD' ? '' : ' ' + cur}`;
}

module.exports = { DEFAULT_PLANS, DEFAULT_DUNNING, STATES, INTERVALS, validatePlan, countBillable, priceCycle, periodFor, addMonths, prorate, buildInvoice, isReadOnly, trialEnd, nextState, dunningAction, invoiceDue, money, iso, parse, addDays };
