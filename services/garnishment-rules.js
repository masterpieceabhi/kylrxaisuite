/**
 * Garnishments (court-ordered or agency-ordered deductions from pay): pure rules, no I/O.
 *
 * There are NO built-in legal limits here. How much may be taken differs by order type, state and the person's
 * pay, and it changes. The amount, the percent and every limit are typed in by the company from the order itself,
 * and every screen shows NOTE. Confirm with a US compliance advisor.
 *
 * The case number is sensitive: it is returned separately by validateGarnishment() so the caller can encrypt it,
 * and publicGarnishment() only includes it when the caller says the reader may see it.
 */
const { parseIsoDate } = require('./us-forms');

const NOTE = 'The amount and every limit come from the order itself and are entered by your company. Nothing here applies a legal limit. Confirm with a US compliance advisor.';

// `gusto` is the provider's garnishment_type. VERIFY against Gusto: these names.
const TYPES = {
    child_support: { label: 'Child support', gusto: 'child_support' },
    tax_levy: { label: 'Tax levy', gusto: { federal: 'federal_tax_lien', state: 'state_tax_lien' } },
    creditor: { label: 'Creditor', gusto: 'creditor_garnishment' },
    other: { label: 'Other', gusto: 'other_garnishment' }
};
const AMOUNT_TYPES = ['amount', 'percent'];
const LEVY_AUTHORITIES = ['federal', 'state'];
// VERIFY against Gusto: child_support.payment_period values.
const PAYMENT_PERIODS = ['Every week', 'Every other week', 'Twice per month', 'Monthly'];

const clean = (v) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
const has = (v) => v !== undefined && v !== null && v !== '';
const exact = (n, places) => { const f = 10 ** places; return Math.abs(n * f - Math.round(n * f)) < 1e-6; };
function moneyField(v, label, errors, { required = false, max = 1000000 } = {}) {
    if (!has(v)) { if (required) errors.push(`${label} is required`); return null; }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > max || !exact(n, 2)) { errors.push(`${label} must be above 0, with cents at most`); return null; }
    return Math.round(n * 100) / 100;
}

/**
 * input: { userId, type, levyAuthority?, caseNumber, amountType, value, limits?: { perPayPeriodMax, annualMax, totalAmount },
 *          startDate, endDate?, payeeNotes?, issuingState?, paymentPeriod?, remittanceNumber?, fipsCode? }
 * Returns { errors, value, caseNumber }: `value` never contains the case number, only its last 4 characters.
 */
function validateGarnishment(input) {
    const errors = []; const b = input || {};
    const value = { userId: clean(b.userId) };
    if (!value.userId) errors.push('userId is required');
    if (!TYPES[b.type]) errors.push(`type must be one of: ${Object.keys(TYPES).join(', ')}`); else value.type = b.type;
    value.levyAuthority = null;
    if (b.type === 'tax_levy') { if (!LEVY_AUTHORITIES.includes(b.levyAuthority)) errors.push('levyAuthority must be federal or state for a tax levy'); else value.levyAuthority = b.levyAuthority; }

    const caseNumber = clean(b.caseNumber);
    if (!caseNumber) errors.push('caseNumber is required (the case, order or levy number on the order)');
    else if (caseNumber.length > 60 || !/^[A-Za-z0-9 ._/#-]+$/.test(caseNumber)) errors.push('caseNumber may have letters, digits, spaces and . _ / # - only (60 characters at most)');
    value.caseLast4 = caseNumber ? caseNumber.slice(-4) : null;

    if (!AMOUNT_TYPES.includes(b.amountType)) errors.push('amountType must be amount or percent');
    else {
        value.amountType = b.amountType;
        const n = Number(b.value);
        if (b.amountType === 'amount') value.value = moneyField(b.value, 'value (the amount per pay period)', errors, { required: true });
        else if (!has(b.value) || !Number.isFinite(n) || n <= 0 || n > 100 || !exact(n, 2)) errors.push('value (the percent of pay) must be above 0 and at most 100, two decimals at most');
        else value.value = n;
    }
    const l = b.limits || {};
    value.limits = {
        perPayPeriodMax: moneyField(l.perPayPeriodMax, 'limits.perPayPeriodMax', errors),
        annualMax: moneyField(l.annualMax, 'limits.annualMax', errors, { max: 100000000 }),
        totalAmount: moneyField(l.totalAmount, 'limits.totalAmount', errors, { max: 100000000 })
    };
    if (value.amountType === 'amount' && value.value && value.limits.perPayPeriodMax && value.limits.perPayPeriodMax < value.value) errors.push('limits.perPayPeriodMax is lower than the amount per pay period');

    if (!parseIsoDate(b.startDate)) errors.push('startDate must be a date (YYYY-MM-DD)'); else value.startDate = String(b.startDate);
    value.endDate = null;
    if (has(b.endDate)) {
        if (!parseIsoDate(b.endDate)) errors.push('endDate must be a date (YYYY-MM-DD)');
        else if (value.startDate && String(b.endDate) < value.startDate) errors.push('endDate cannot be before startDate');
        else value.endDate = String(b.endDate);
    }
    value.payeeNotes = clean(b.payeeNotes).slice(0, 500);

    // child support orders carry a few more details the provider needs to send the money to the right agency
    value.issuingState = null; value.paymentPeriod = null; value.remittanceNumber = null; value.fipsCode = null;
    if (b.type === 'child_support') {
        const st = clean(b.issuingState).toUpperCase();
        if (!/^[A-Z]{2}$/.test(st)) errors.push('issuingState (two letters) is required for child support'); else value.issuingState = st;
        if (has(b.paymentPeriod)) { if (!PAYMENT_PERIODS.includes(b.paymentPeriod)) errors.push(`paymentPeriod must be one of: ${PAYMENT_PERIODS.join(', ')}`); else value.paymentPeriod = b.paymentPeriod; }
        const rem = clean(b.remittanceNumber); if (rem.length > 40) errors.push('remittanceNumber is too long'); else value.remittanceNumber = rem || null;
        const fips = clean(b.fipsCode); if (fips && !/^\d{5}(\d{2})?$/.test(fips)) errors.push('fipsCode must be 5 or 7 digits'); else value.fipsCode = fips || null;
    }
    return { errors, value, caseNumber: errors.length ? null : caseNumber };
}

/** scheduled (not started), active, or ended, on a given day */
function statusOn(g, today) {
    if (g.endedAt) return 'ended';
    if (g.endDate && g.endDate < today) return 'ended';
    if (g.startDate > today) return 'scheduled';
    return 'active';
}

/** What a person needs to do about this record today, in plain words ([] when nothing) */
function attention(g, today) {
    const out = [];
    const st = statusOn(g, today);
    const p = g.provider || {};
    if (st === 'active' && p.state !== 'sent') out.push(p.state === 'error' ? `It could not be sent to the payroll provider: ${p.error || 'unknown problem'}` : p.state === 'blocked' ? (p.reason || 'It cannot be sent to the payroll provider yet.') : 'It has started but has not been sent to the payroll provider.');
    if (st === 'ended' && p.state === 'sent' && p.active !== false) out.push('Its end date has passed but it is still switched on at the payroll provider. End it.');
    if (st === 'scheduled') out.push(`It starts on ${g.startDate}. Send it to the payroll provider on or after that day.`);
    return out;
}

/** May the end be recorded? Returns { errors, endDate } */
function validateEnd(g, input, today) {
    const errors = []; const b = input || {};
    const endDate = has(b.endDate) ? String(b.endDate) : today;
    if (g.endedAt) errors.push('This garnishment has already ended');
    if (!parseIsoDate(endDate)) errors.push('endDate must be a date (YYYY-MM-DD)');
    else if (endDate < g.startDate) errors.push('endDate cannot be before the start date');
    return { errors, endDate, reason: clean(b.reason).slice(0, 300) };
}

const str = (n) => (n === null || n === undefined ? null : Number(n).toFixed(2));

/**
 * Body for the provider's garnishment. The case number is sent only for child support (the provider has a field for
 * it there); for the other types it stays in our records.
 * VERIFY against Gusto: active, amount, description, court_ordered, garnishment_type, times, recurring,
 * deduct_as_percentage, pay_period_maximum, annual_maximum, total_amount and child_support { state, payment_period,
 * case_number, remittance_number, fips_code }.
 */
function toGustoGarnishment(g, caseNumber, { active = true } = {}) {
    const t = TYPES[g.type];
    const body = {
        active, amount: g.amountType === 'percent' ? String(g.value) : str(g.value), description: t.label, court_ordered: true,
        garnishment_type: typeof t.gusto === 'string' ? t.gusto : t.gusto[g.levyAuthority], times: null, recurring: true, deduct_as_percentage: g.amountType === 'percent',
        pay_period_maximum: str(g.limits && g.limits.perPayPeriodMax), annual_maximum: str(g.limits && g.limits.annualMax), total_amount: str(g.limits && g.limits.totalAmount)
    };
    if (g.type === 'child_support') body.child_support = { state: g.issuingState, payment_period: g.paymentPeriod || null, case_number: caseNumber, remittance_number: g.remittanceNumber || null, fips_code: g.fipsCode || null };
    return body;
}

/** What a browser may see. The case number only when `showCase` is true (the caller checked the permission). */
function publicGarnishment(g, { today, showCase = false, caseNumber = null } = {}) {
    const p = g.provider || {};
    return {
        id: g.id, userId: g.userId, name: g.name || null, type: g.type, typeLabel: (TYPES[g.type] || {}).label || g.type, levyAuthority: g.levyAuthority || null,
        caseNumber: showCase ? caseNumber : null, caseNumberHidden: !showCase,
        amountType: g.amountType, value: g.value, limits: g.limits || {}, startDate: g.startDate, endDate: g.endDate || null, payeeNotes: g.payeeNotes || '',
        issuingState: g.issuingState || null, paymentPeriod: g.paymentPeriod || null, remittanceNumber: showCase ? (g.remittanceNumber || null) : null, fipsCode: g.fipsCode || null,
        status: statusOn(g, today), endedAt: g.endedAt || null, endReason: g.endReason || null,
        provider: { state: p.state || 'not_sent', active: p.state === 'sent' ? p.active !== false : false, sentAt: p.sentAt || null, problem: p.error || p.reason || null },
        attention: attention(g, today), createdAt: g.createdAt || null, createdBy: g.createdBy || null
    };
}

module.exports = { NOTE, TYPES, AMOUNT_TYPES, LEVY_AUTHORITIES, PAYMENT_PERIODS, validateGarnishment, statusOn, attention, validateEnd, toGustoGarnishment, publicGarnishment };
