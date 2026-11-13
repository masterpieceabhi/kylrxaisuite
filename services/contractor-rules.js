/**
 * Independent contractor rules (pure): W-9 data, 1099 payment ledger, annual totals, 1099-NEC threshold flag, CSV.
 * The reporting threshold and the backup withholding rate are company settings, not hard-coded law:
 * confirm both with a US tax advisor.
 */
const { parseIsoDate } = require('./us-forms');
const { validateAddress, validateEin, validateSsn, validateItin } = require('./us-validation');

const TAX_CLASSES = ['individual', 'c_corp', 's_corp', 'partnership', 'trust_estate', 'llc_c', 'llc_s', 'llc_p', 'other'];
const TIN_TYPES = ['SSN', 'ITIN', 'EIN'];
const METHODS = ['ach', 'check', 'wire', 'cash', 'card', 'other'];
const CATEGORIES = ['nonemployee_compensation', 'rent', 'royalties', 'other_income', 'reimbursement'];
const DEFAULT_SETTINGS = { necThreshold: 600, backupWithholdingRate: 24 };
// Corporations are commonly (not always) exempt from 1099-NEC; shown as a hint only
const USUALLY_EXEMPT = ['c_corp', 's_corp', 'llc_c', 'llc_s'];

const digits = (v) => String(v || '').replace(/\D/g, '');
const clean = (v) => String(v || '').replace(/\s+/g, ' ').trim();

function validateTin(input, type) {
    const d = digits(input);
    if (type === 'EIN') { const r = validateEin(d); return r.valid ? { digits: d, last4: d.slice(-4) } : { error: r.error }; }
    const r = type === 'ITIN' ? validateItin(d) : validateSsn(d);
    return r.valid ? { digits: d, last4: d.slice(-4) } : { error: r.error || 'taxpayer ID is not valid' };
}

function validateContractor(input) {
    const errors = []; const b = input || {};
    const name = clean(b.name);
    if (!name) errors.push('name is required');
    if (name.length > 120) errors.push('name is too long');
    const email = String(b.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email is not valid');
    return { errors, value: { name, businessName: clean(b.businessName).slice(0, 120), email, active: b.active === undefined ? true : Boolean(b.active), backupWithholding: Boolean(b.backupWithholding), notes: clean(b.notes).slice(0, 500) } };
}

/**
 * W-9: returns { errors, value, tin } where value has no taxpayer ID (callers encrypt `tin.digits` themselves).
 * The certification signature is the typed name; it must match the legal name.
 */
function validateW9(input) {
    const errors = []; const b = input || {};
    const legalName = clean(b.legalName);
    if (!legalName) errors.push('legalName is required');
    if (!TAX_CLASSES.includes(b.taxClassification)) errors.push(`taxClassification must be one of: ${TAX_CLASSES.join(', ')}`);
    if (b.taxClassification === 'other' && !clean(b.taxClassificationOther)) errors.push('describe the tax classification when you choose other');
    const tinType = String(b.tinType || '').toUpperCase();
    if (!TIN_TYPES.includes(tinType)) errors.push(`tinType must be one of: ${TIN_TYPES.join(', ')}`);
    const a = validateAddress(b.address);
    errors.push(...a.errors);
    let tin = null;
    if (TIN_TYPES.includes(tinType)) {
        const t = validateTin(b.tin, tinType);
        if (t.error) errors.push(t.error); else tin = t;
    }
    if (!b.certified) errors.push('certification is required: the contractor confirms the information is correct under penalties of perjury');
    const signed = clean(b.signature);
    if (!signed) errors.push('typed signature is required');
    else if (legalName && signed.toLowerCase() !== legalName.toLowerCase()) errors.push('the typed signature must match the legal name');
    return {
        errors, tin,
        value: {
            legalName, businessName: clean(b.businessName).slice(0, 120), taxClassification: b.taxClassification,
            taxClassificationOther: clean(b.taxClassificationOther).slice(0, 80), tinType, tinLast4: tin ? tin.last4 : null,
            address: a.value, exemptPayeeCode: clean(b.exemptPayeeCode).slice(0, 10), signature: signed,
            likelyExemptFrom1099: USUALLY_EXEMPT.includes(b.taxClassification)
        }
    };
}

function validatePayment(input, todayIso) {
    const errors = []; const b = input || {};
    const value = {};
    if (!parseIsoDate(b.date)) errors.push('date must be a valid date (YYYY-MM-DD)');
    else if (todayIso && b.date > todayIso) errors.push('date cannot be in the future');
    else value.date = String(b.date);
    const amount = Number(b.amount);
    if (!(amount > 0) || !Number.isFinite(amount) || Math.round(amount * 100) / 100 !== amount) errors.push('amount must be a positive amount with cents at most');
    else value.amount = amount;
    if (!METHODS.includes(b.method)) errors.push(`method must be one of: ${METHODS.join(', ')}`); else value.method = b.method;
    const category = b.category || 'nonemployee_compensation';
    if (!CATEGORIES.includes(category)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}`); else value.category = category;
    value.description = clean(b.description).slice(0, 300);
    return { errors, value };
}

function validateSettings(input) {
    const errors = []; const b = input || {};
    const value = {};
    if (b.necThreshold !== undefined) {
        const t = Number(b.necThreshold);
        if (!(t >= 0) || !Number.isFinite(t)) errors.push('necThreshold must be zero or more'); else value.necThreshold = t;
    }
    if (b.backupWithholdingRate !== undefined) {
        const r = Number(b.backupWithholdingRate);
        if (!(r >= 0 && r <= 50)) errors.push('backupWithholdingRate must be between 0 and 50'); else value.backupWithholdingRate = r;
    }
    return { errors, value };
}

const inYear = (p, year) => String(p.date || '').slice(0, 4) === String(year);
// Card and third-party network payments are reported by the processor on 1099-K, not on 1099-NEC; reimbursements are not income
const countsForNec = (p) => p.category === 'nonemployee_compensation' && p.method !== 'card';

/** Per-contractor totals for a year. contractors: [{id, name, backupWithholding, w9Status, tinLast4}] */
function annualTotals(contractors, payments, year, settings = DEFAULT_SETTINGS) {
    const threshold = settings.necThreshold === undefined ? DEFAULT_SETTINGS.necThreshold : settings.necThreshold;
    return contractors.map((c) => {
        const mine = payments.filter((p) => p.contractorId === c.id && inYear(p, year));
        const cents = (list) => list.reduce((s, p) => s + Math.round(p.amount * 100), 0);
        const total = cents(mine); const nec = cents(mine.filter(countsForNec));
        const missingTin = c.w9Status !== 'received';
        return {
            contractorId: c.id, name: c.name, year, paymentCount: mine.length, totalPaid: total / 100, necTotal: nec / 100,
            over1099Threshold: nec > 0 && nec >= Math.round(threshold * 100), threshold,
            backupWithholding: Boolean(c.backupWithholding), w9Status: c.w9Status || 'missing', tinLast4: c.tinLast4 || null,
            // a reportable contractor with no W-9 on file is flagged so backup withholding can be considered
            backupWithholdingSuggested: missingTin && nec > 0 && !c.backupWithholding
        };
    });
}

/** CSV cell with quotes and formula-injection protection */
function cell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** rows: [{ ...totals, legalName, tin?, address }] -> CSV text. `tin` full only when the caller supplied it. */
function summaryCsv(rows, { fullTin = false } = {}) {
    const head = ['Contractor', 'Legal name', 'Tax classification', fullTin ? 'TIN' : 'TIN (last 4)', 'Address', 'Payments', 'Total paid', '1099-NEC total', 'Over threshold', 'Backup withholding', 'W-9'];
    const lines = [head.map(cell).join(',')];
    for (const r of rows) {
        const a = r.address || {};
        const addr = [a.line1, a.line2, a.city, a.state, a.zip].filter(Boolean).join(' ');
        lines.push([r.name, r.legalName || '', r.taxClassification || '', fullTin ? (r.tin || '') : (r.tinLast4 ? `***${r.tinLast4}` : ''), addr, r.paymentCount, r.totalPaid.toFixed(2), r.necTotal.toFixed(2),
            r.over1099Threshold ? 'yes' : 'no', r.backupWithholding ? 'yes' : 'no', r.w9Status].map(cell).join(','));
    }
    return `${lines.join('\r\n')}\r\n`;
}

module.exports = { TAX_CLASSES, TIN_TYPES, METHODS, CATEGORIES, DEFAULT_SETTINGS, validateContractor, validateW9, validatePayment, validateSettings, annualTotals, summaryCsv, countsForNec };
