/**
 * Historical payroll import for US companies (pure, no I/O).
 *
 * A company that paid people somewhere else before brings that history in as a CSV: one line per person per
 * pay date. Every line is checked and each problem is reported against its row. A file with any problem is not
 * saved at all. The saved rows have the same shape as the pay results the payroll provider writes (see
 * services/gusto/pay-results.js) and are marked `source: 'import'` so nobody mistakes them for provider figures.
 *
 * Nothing here calculates pay or tax: the figures are stored as the company gives them.
 */
const { parseCsv } = require('./org-rules');
const { parseIsoDate } = require('./us-forms');

const SOURCE = 'import';
const MAX_ROWS = 2000;
const MAX_CHARS = 1000000;
const MAX_MONEY = 10000000;
const MAX_HOURS = 1000;
const EARLIEST = '1990-01-01';
const NOTE = 'Imported history is stored exactly as you give it. Nothing is recalculated, no tax is filed and nobody is paid. Check the totals against your old payroll reports before you confirm.';

/** The columns of the file, in template order. names: the headings accepted (lower case, spaces as underscores). */
const COLUMNS = [
    { key: 'employeeNumber', label: 'Employee number', required: true, names: ['employee_number', 'employee_no', 'employee_id', 'employeeid', 'emp_no', 'emp_id'] },
    { key: 'payDate', label: 'Pay date', required: true, names: ['pay_date', 'check_date', 'paydate'] },
    { key: 'periodStart', label: 'Period start', required: true, names: ['period_start', 'pay_period_start', 'start_date'] },
    { key: 'periodEnd', label: 'Period end', required: true, names: ['period_end', 'pay_period_end', 'end_date'] },
    { key: 'gross', label: 'Gross', required: true, names: ['gross', 'gross_pay'] },
    { key: 'net', label: 'Net', required: true, names: ['net', 'net_pay'] },
    { key: 'employeeTaxes', label: 'Employee taxes', required: true, names: ['employee_taxes', 'employee_tax', 'ee_taxes'] },
    { key: 'employerTaxes', label: 'Employer taxes', required: true, names: ['employer_taxes', 'employer_tax', 'er_taxes'] },
    { key: 'deductions', label: 'Deductions', required: true, names: ['deductions', 'deduction'] },
    { key: 'hours', label: 'Hours', required: true, names: ['hours', 'hours_worked'] },
    { key: 'checkNumber', label: 'Check number', required: false, names: ['check_number', 'check_no', 'check'] }
];
const MONEY_KEYS = ['gross', 'net', 'employeeTaxes', 'employerTaxes', 'deductions'];
const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.label]));

const cents = (v) => Math.round((Number(v) || 0) * 100);
const money = (c) => Math.round(c) / 100;

/** CSV cell: quoted when needed, and text that a spreadsheet would run as a formula is made plain text */
function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const toCsv = (lines) => `${lines.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
/** The file people download, fill in and bring back: the headings and two example lines */
const templateCsv = () => toCsv([COLUMNS.map((c) => c.label), ['E1001', '2025-01-17', '2025-01-01', '2025-01-15', '2400.00', '1830.50', '419.50', '183.60', '150.00', '80', '10452'], ['E1002', '2025-01-17', '2025-01-01', '2025-01-15', '1600.00', '1312.40', '287.60', '122.40', '0.00', '72.5', '']]);

/** A date as YYYY-MM-DD. Also takes the US form a spreadsheet often saves (1/17/2025). Null when it is not a real date. */
function parseDate(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    let iso = s;
    const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (us) iso = `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
    return parseIsoDate(iso) ? iso : null;
}

/** An amount of dollars as a number with at most two decimals. Takes 1234.5, 1,234.50 and $1,234.50. Null when it is anything else, including a negative. */
function parseMoney(v) {
    const s = String(v === undefined || v === null ? '' : v).trim();
    if (!/^\$?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) return null;
    const n = Number(s.replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
}

/** Reads the text into rows keyed by our column keys. Returns file-level errors when the file cannot be used at all. */
function readFile(text) {
    const raw = String(text === undefined || text === null ? '' : text);
    if (!raw.trim()) return { errors: ['The file is empty. Paste the lines or choose a CSV file.'], rows: [] };
    if (raw.length > MAX_CHARS) return { errors: [`The file is too big (${raw.length.toLocaleString('en-US')} characters; the most is ${MAX_CHARS.toLocaleString('en-US')}). Split it into smaller files.`], rows: [] };
    const parsed = parseCsv(raw);
    const firstLine = parseCsv(`${raw.replace(/^﻿/, '').split(/\r?\n/).find((l) => l.trim() !== '') || ''}\nx`);
    const heads = new Set(Object.keys(firstLine[0] || parsed[0] || {}));
    const pick = {}; const errors = [];
    for (const c of COLUMNS) {
        const found = c.names.filter((n) => heads.has(n));
        if (found.length > 1) errors.push(`The file has more than one "${c.label}" column (${found.join(', ')}). Keep one.`);
        else if (found.length) pick[c.key] = found[0];
        else if (c.required) errors.push(`The file has no "${c.label}" column`);
    }
    if (errors.length) return { errors: [...errors, `The first line must be the headings: ${COLUMNS.map((c) => c.label).join(', ')}`], rows: [] };
    if (!parsed.length) return { errors: ['The file has headings but no lines under them'], rows: [] };
    if (parsed.length > MAX_ROWS) return { errors: [`The file has ${parsed.length} lines; the most in one import is ${MAX_ROWS}. Split it into smaller files.`], rows: [] };
    return { errors: [], rows: parsed.map((r) => Object.fromEntries(COLUMNS.map((c) => [c.key, pick[c.key] ? String(r[pick[c.key]] ?? '').trim() : '']))) };
}

/**
 * Checks one row. Returns { errors, warnings, value }.
 *   byNumber: Map of employee number (upper case) -> { id, employeeId, name, department }
 *   today:    the company's date; a pay date after it is refused
 */
function validateRow(raw, { byNumber, today } = {}) {
    const errors = []; const warnings = []; const value = {};
    const num = String(raw.employeeNumber || '').trim();
    let person = null;
    if (!num) errors.push('Employee number is missing');
    else if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,39}$/.test(num)) errors.push('Employee number may only have letters, numbers, spaces, dots, dashes and slashes (up to 40)');
    else { person = byNumber && byNumber.get(num.toUpperCase()); if (!person) errors.push(`No person in your company has employee number ${num}`); }
    if (person) { value.userId = person.id; value.employeeId = person.employeeId; value.name = person.name || null; value.department = person.department || null; }

    for (const k of ['payDate', 'periodStart', 'periodEnd']) {
        if (!raw[k]) { errors.push(`${LABEL[k]} is missing`); continue; }
        const d = parseDate(raw[k]);
        if (!d) errors.push(`${LABEL[k]} is not a real date. Write it as 2025-01-17 or 1/17/2025.`);
        else if (d < EARLIEST) errors.push(`${LABEL[k]} is before ${EARLIEST.slice(0, 4)}`);
        else value[k] = d;
    }
    if (value.periodStart && value.periodEnd && value.periodStart > value.periodEnd) errors.push('Period start is after period end');
    if (value.payDate && value.periodStart && value.payDate < value.periodStart) errors.push('Pay date is before the pay period starts');
    if (value.payDate && today && value.payDate > today) errors.push('Pay date is in the future. Only pay that was already paid can be imported.');

    for (const k of MONEY_KEYS) {
        if (raw[k] === '' || raw[k] === undefined) { if (k === 'gross' || k === 'net') errors.push(`${LABEL[k]} is missing`); else value[k] = 0; continue; }
        const n = parseMoney(raw[k]);
        if (n === null) errors.push(`${LABEL[k]} must be an amount like 1234.56, not negative`);
        else if (n > MAX_MONEY) errors.push(`${LABEL[k]} is too large`);
        else value[k] = n;
    }
    if (raw.hours === '' || raw.hours === undefined) value.hours = 0;
    else if (!/^\d+(\.\d{1,2})?$/.test(raw.hours) || Number(raw.hours) > MAX_HOURS) errors.push(`Hours must be a number from 0 to ${MAX_HOURS} with at most two decimals`);
    else value.hours = Number(raw.hours);

    const chk = String(raw.checkNumber || '').trim();
    if (chk && !/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,29}$/.test(chk)) errors.push('Check number may only have letters, numbers, spaces, dots, dashes and slashes (up to 30)');
    else value.checkNumber = chk || null;

    if (!errors.length) {
        if (value.gross === 0 && value.net === 0) errors.push('Gross and net are both zero, so there is nothing to import on this line');
        else if (cents(value.net) > cents(value.gross)) warnings.push('Net is more than gross. Check this line.');
        else if (cents(value.gross) - cents(value.employeeTaxes) - cents(value.deductions) !== cents(value.net)) warnings.push('Gross minus employee taxes minus deductions does not equal net. That can be right (for example a repayment), but check this line.');
    }
    return { errors, warnings, value: errors.length ? null : value };
}

const payKey = (userId, payDate) => `${userId}|${payDate}`;

/** Sums of the rows that can be saved, in cents so nothing drifts */
function totalsOf(rows) {
    const t = { gross: 0, net: 0, employeeTaxes: 0, employerTaxes: 0, deductions: 0, hours: 0 };
    const people = new Set(); let first = null; let last = null;
    for (const r of rows) {
        Object.keys(t).forEach((k) => { t[k] += cents(r[k]); });
        people.add(r.userId);
        if (r.payDate && (!first || r.payDate < first)) first = r.payDate;
        if (r.payDate && (!last || r.payDate > last)) last = r.payDate;
    }
    return { rows: rows.length, people: people.size, firstPayDate: first, lastPayDate: last, ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, money(v)])), employerCost: money(t.gross + t.employerTaxes) };
}

/**
 * Checks a whole file. Nothing is saved here.
 *   people:   [{ id, employeeId, name, department }] everyone of the company, people who have left included
 *   existing: pay results the company already has: [{ userId, payDate, source }]
 *   today:    the company's date
 * Returns { ok, fileErrors, rows: [{ row, raw, errors, warnings, value }], errorCount, errorRows, warningCount, totals }.
 * `row` counts the lines under the headings, starting at 1 (blank lines are not counted).
 */
function checkFile(text, { people = [], existing = [], today = null } = {}) {
    const file = readFile(text);
    if (file.errors.length) return { ok: false, fileErrors: file.errors, rows: [], errorCount: file.errors.length, errorRows: 0, warningCount: 0, totals: totalsOf([]) };
    const byNumber = new Map();
    const twice = new Set();
    for (const p of people) { if (!p.employeeId) continue; const k = String(p.employeeId).trim().toUpperCase(); if (byNumber.has(k)) twice.add(k); else byNumber.set(k, p); }
    const have = new Map(existing.filter((e) => e.userId && e.payDate).map((e) => [payKey(e.userId, e.payDate), e.source === SOURCE ? SOURCE : 'payroll']));
    const seen = new Map();
    const rows = file.rows.map((raw, i) => {
        const row = i + 1;
        const out = validateRow(raw, { byNumber, today });
        if (raw.employeeNumber && twice.has(raw.employeeNumber.trim().toUpperCase())) { out.errors.push(`More than one person in your company has employee number ${raw.employeeNumber}. Fix that first.`); out.value = null; }
        if (out.value) {
            const k = payKey(out.value.userId, out.value.payDate);
            if (seen.has(k)) out.errors.push(`Same person and pay date as row ${seen.get(k)}. Each person can have one line for a pay date.`);
            else if (have.get(k) === SOURCE) out.errors.push(`Pay for this person on ${out.value.payDate} was already imported`);
            else if (have.has(k)) out.errors.push(`This person already has pay on ${out.value.payDate} from your payroll provider, so importing it would count it twice`);
            if (!seen.has(k)) seen.set(k, row);
            if (out.errors.length) out.value = null;
        }
        return { row, raw, errors: out.errors, warnings: out.warnings, value: out.value };
    });
    const good = rows.filter((r) => r.value).map((r) => r.value);
    const errorRows = rows.filter((r) => r.errors.length).length;
    return { ok: errorRows === 0 && rows.length > 0, fileErrors: [], rows, errorCount: rows.reduce((s, r) => s + r.errors.length, 0), errorRows, warningCount: rows.reduce((s, r) => s + r.warnings.length, 0), totals: totalsOf(good) };
}

/** The stored id of an imported row: one per person per pay date in a company, which is what stops the same pay being saved twice */
const resultId = (orgId, userId, payDate) => `${orgId}_import_${userId}_${payDate}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 300);
/** Imported rows hang off a made-up payroll id so they can never match a provider payroll */
const payrollIdOf = (batchId) => `import_${batchId}`;

/** The pay result documents of a checked file, in the shape the register, cost report, journal and API already read */
function toPayResults(checked, { orgId, batchId, nowIso }) {
    if (!checked.ok) throw new Error('This file has errors and cannot be saved');
    return checked.rows.map((r) => {
        const v = r.value;
        return { id: resultId(orgId, v.userId, v.payDate), orgId, source: SOURCE, importBatchId: batchId, importRow: r.row, payrollUuid: payrollIdOf(batchId), userId: v.userId, employeeId: v.employeeId || null, name: v.name || null, department: v.department || null,
            periodStart: v.periodStart, periodEnd: v.periodEnd, payDate: v.payDate, status: 'paid', currency: 'USD',
            gross: v.gross, net: v.net, employeeTaxes: v.employeeTaxes, employerTaxes: v.employerTaxes, deductions: v.deductions, hours: v.hours, checkNumber: v.checkNumber || null,
            allocated: false, createdAt: nowIso, updatedAt: nowIso };
    });
}

/** The preview as a CSV of problems, to fix the file from */
const errorsCsv = (checked) => toCsv([['Row', 'Employee number', 'Pay date', 'Problem'], ...checked.fileErrors.map((e) => ['', '', '', e]), ...checked.rows.flatMap((r) => r.errors.map((e) => [r.row, r.raw.employeeNumber, r.raw.payDate, e]))]);

/** May this batch be undone? Null when allowed, or the reason it is not. */
const undoError = (batch) => (batch.status === 'undone' ? 'This import was already undone' : null);

module.exports = { SOURCE, MAX_ROWS, MAX_CHARS, MAX_MONEY, MAX_HOURS, EARLIEST, NOTE, COLUMNS, MONEY_KEYS, csvCell, toCsv, templateCsv, parseDate, parseMoney, readFile, validateRow, totalsOf, checkFile, resultId, payrollIdOf, toPayResults, errorsCsv, undoError };
