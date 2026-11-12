/**
 * Custom report builder for US companies (pure, no I/O).
 *
 * A report is: one data set, the columns to show, optional filters, a sort and an optional "count by" column.
 * It can be saved and given a schedule; the server then keeps a dated copy each week or month.
 * Pay columns are only for people allowed to see pay. Taxpayer numbers are not in any data set.
 */
const { parseIsoDate } = require('./us-forms');

const F = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
const DATASETS = {
    people: { label: 'People', needs: ['reports.view'], fields: [
        F('employeeId', 'Employee number'), F('name', 'Name'), F('email', 'Email'), F('status', 'Status'), F('role', 'System role'), F('jobTitle', 'Job title'),
        F('department', 'Department'), F('location', 'Location'), F('manager', 'Manager'), F('workState', 'Work state'), F('classification', 'Worker type'),
        F('employmentType', 'Employment'), F('flsaStatus', 'Overtime status'), F('startDate', 'Start date', 'date'), F('lastDay', 'Last day', 'date'),
        F('payType', 'Pay type', 'text', { pay: true }), F('payRate', 'Pay rate', 'number', { pay: true })] },
    equipment: { label: 'Equipment', needs: ['people.read', 'people.write'], fields: [
        F('name', 'Item'), F('category', 'Kind'), F('tag', 'Tag'), F('serial', 'Serial number'), F('status', 'Status'), F('holder', 'With'), F('givenOn', 'Given on', 'date'),
        F('dueBack', 'Due back', 'date'), F('confirmed', 'Confirmed by holder'), F('condition', 'Condition'), F('cost', 'Cost', 'number'), F('purchaseDate', 'Bought on', 'date')] },
    goals: { label: 'Goals', needs: ['people.read', 'people.write'], fields: [
        F('employeeId', 'Employee number'), F('name', 'Person'), F('department', 'Department'), F('title', 'Goal'), F('status', 'Status'), F('progress', 'Progress %', 'number'),
        F('dueDate', 'Due date', 'date'), F('late', 'Late'), F('setBy', 'Set by'), F('createdOn', 'Created on', 'date')] },
    policy_confirmations: { label: 'Policy confirmations', needs: ['people.read', 'people.write'], fields: [
        F('employeeId', 'Employee number'), F('name', 'Person'), F('policy', 'Policy'), F('category', 'Kind'), F('version', 'Current version', 'number'),
        F('confirmed', 'Confirmed'), F('confirmedOn', 'Confirmed on', 'date'), F('versionRead', 'Version read', 'number')] }
};
const OPS = {
    text: [['contains', 'contains'], ['is', 'is exactly'], ['is_not', 'is not'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
    number: [['eq', 'equals'], ['gt', 'is more than'], ['lt', 'is less than'], ['gte', 'is at least'], ['lte', 'is at most'], ['empty', 'is empty'], ['not_empty', 'is not empty']],
    date: [['on_or_after', 'is on or after'], ['on_or_before', 'is on or before'], ['empty', 'is empty'], ['not_empty', 'is not empty']]
};
const NO_VALUE = new Set(['empty', 'not_empty']);
const SCHEDULES = ['none', 'weekly', 'monthly'];
const MAX_COLUMNS = 20; const MAX_FILTERS = 8; const MAX_ROWS = 5000; const SNAPSHOTS_KEPT = 12; const CSV_MAX_CHARS = 800000;

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const fieldsOf = (dataset) => (DATASETS[dataset] ? DATASETS[dataset].fields : []);
const fieldOf = (dataset, key) => fieldsOf(dataset).find((f) => f.key === key) || null;

/** The data sets a person may use. can: (permission) => boolean */
function datasetsFor(can) {
    const seePay = can('people.read_pay');
    return Object.entries(DATASETS).filter(([, d]) => d.needs.some((p) => can(p))).map(([key, d]) => ({ key, label: d.label, fields: d.fields.filter((f) => !f.pay || seePay).map((f) => ({ key: f.key, label: f.label, type: f.type })) }));
}

/** A report as someone builds it. allowed: output of datasetsFor for that person. */
function validateDefinition(input, allowed) {
    const errors = []; const b = input || {}; const value = {};
    const name = clean(b.name, 80);
    if (b.name !== undefined || b.requireName) { if (name.length < 3) errors.push('Give the report a name (at least 3 characters)'); else value.name = name; }
    const ds = (allowed || []).find((d) => d.key === b.dataset);
    if (!ds) { errors.push(DATASETS[b.dataset] ? 'You do not have permission to use this data' : 'Choose what the report is about'); return { errors, value: null }; }
    value.dataset = ds.key;
    const has = (k) => ds.fields.find((f) => f.key === k);
    const cols = [...new Set(Array.isArray(b.columns) ? b.columns.map(String) : [])];
    const badCols = cols.filter((c) => !has(c));
    if (badCols.length) errors.push(`These columns are not available to you: ${badCols.join(', ')}`);
    if (!cols.length) errors.push('Choose at least one column');
    if (cols.length > MAX_COLUMNS) errors.push(`Choose at most ${MAX_COLUMNS} columns`);
    value.columns = cols.filter(has);
    const filters = [];
    const given = Array.isArray(b.filters) ? b.filters : [];
    if (given.length > MAX_FILTERS) errors.push(`Use at most ${MAX_FILTERS} filters`);
    given.slice(0, MAX_FILTERS).forEach((raw, i) => {
        const f = raw || {}; const field = has(f.field);
        if (!field) { errors.push(`Filter ${i + 1}: choose a column`); return; }
        if (!OPS[field.type].some(([op]) => op === f.op)) { errors.push(`Filter ${i + 1}: "${f.op}" cannot be used on ${field.label}`); return; }
        if (NO_VALUE.has(f.op)) { filters.push({ field: field.key, op: f.op }); return; }
        const v = clean(f.value, 120);
        if (!v) { errors.push(`Filter ${i + 1}: type a value for ${field.label}`); return; }
        if (field.type === 'number' && !Number.isFinite(Number(v))) { errors.push(`Filter ${i + 1}: ${field.label} needs a number`); return; }
        if (field.type === 'date' && !parseIsoDate(v)) { errors.push(`Filter ${i + 1}: ${field.label} needs a real date (YYYY-MM-DD)`); return; }
        filters.push({ field: field.key, op: f.op, value: field.type === 'number' ? Number(v) : v });
    });
    value.filters = filters;
    if (b.sortBy) { if (!has(b.sortBy)) errors.push('Sort by a column that is available to you'); else value.sortBy = String(b.sortBy); } else value.sortBy = null;
    value.sortDir = b.sortDir === 'desc' ? 'desc' : 'asc';
    if (b.groupBy) { if (!has(b.groupBy)) errors.push('Count by a column that is available to you'); else value.groupBy = String(b.groupBy); } else value.groupBy = null;
    if (b.schedule === undefined || b.schedule === null || b.schedule === '') value.schedule = 'none';
    else if (!SCHEDULES.includes(b.schedule)) errors.push(`schedule must be one of: ${SCHEDULES.join(', ')}`); else value.schedule = b.schedule;
    return { errors, value: errors.length ? null : value };
}

const blank = (v) => v === null || v === undefined || v === '';
function matches(row, f, type) {
    const v = row[f.field];
    if (f.op === 'empty') return blank(v);
    if (f.op === 'not_empty') return !blank(v);
    if (blank(v)) return f.op === 'is_not';
    if (type === 'number') { const n = Number(v); return f.op === 'eq' ? n === f.value : f.op === 'gt' ? n > f.value : f.op === 'lt' ? n < f.value : f.op === 'gte' ? n >= f.value : n <= f.value; }
    if (type === 'date') { const d = String(v).slice(0, 10); return f.op === 'on_or_after' ? d >= f.value : d <= f.value; }
    const a = String(v).toLowerCase(); const want = String(f.value).toLowerCase();
    return f.op === 'contains' ? a.includes(want) : f.op === 'is' ? a === want : a !== want;
}

/** Remove pay columns, filters, sort and grouping from a saved report for someone who may not see pay */
function withoutPay(def) {
    const pay = new Set(fieldsOf(def.dataset).filter((f) => f.pay).map((f) => f.key));
    if (!pay.size) return { def, removed: [] };
    const removed = def.columns.filter((c) => pay.has(c));
    const usedElsewhere = (def.filters || []).some((f) => pay.has(f.field)) || pay.has(def.sortBy) || pay.has(def.groupBy);
    if (!removed.length && !usedElsewhere) return { def, removed: [] };
    return { removed: removed.length ? removed : ['pay'], blocked: usedElsewhere, def: { ...def, columns: def.columns.filter((c) => !pay.has(c)), filters: (def.filters || []).filter((f) => !pay.has(f.field)), sortBy: pay.has(def.sortBy) ? null : def.sortBy, groupBy: pay.has(def.groupBy) ? null : def.groupBy } };
}

/** Run a checked report over the data set's rows */
function runReport(def, rows) {
    const types = Object.fromEntries(fieldsOf(def.dataset).map((f) => [f.key, f.type]));
    const labels = Object.fromEntries(fieldsOf(def.dataset).map((f) => [f.key, f.label]));
    let out = rows.filter((r) => (def.filters || []).every((f) => matches(r, f, types[f.field])));
    if (def.sortBy) {
        const k = def.sortBy; const num = types[k] === 'number'; const dir = def.sortDir === 'desc' ? -1 : 1;
        out = [...out].sort((a, b) => {
            const x = a[k]; const y = b[k];
            if (blank(x) || blank(y)) return blank(x) && blank(y) ? 0 : blank(x) ? 1 : -1; // empty values last, whichever way it is sorted
            return (num ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'en', { sensitivity: 'base' })) * dir;
        });
    }
    const total = out.length;
    let groups = null;
    if (def.groupBy) {
        const counts = new Map();
        for (const r of out) { const key = blank(r[def.groupBy]) ? '(empty)' : String(r[def.groupBy]); counts.set(key, (counts.get(key) || 0) + 1); }
        groups = { field: def.groupBy, label: labels[def.groupBy], rows: [...counts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)) };
    }
    return { columns: def.columns.map((c) => ({ key: c, label: labels[c], type: types[c] })), rows: out.slice(0, MAX_ROWS).map((r) => Object.fromEntries(def.columns.map((c) => [c, blank(r[c]) ? null : r[c]]))), total, truncated: total > MAX_ROWS, groups };
}

/** CSV text. Cells that a spreadsheet would run as a formula are made plain text. */
function toCsv(columns, rows, maxChars = Infinity) {
    const cell = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [columns.map((c) => cell(c.label)).join(',')]; let size = lines[0].length; let written = 0;
    for (const r of rows) { const line = columns.map((c) => cell(r[c.key])).join(','); if (size + line.length + 2 > maxChars) break; lines.push(line); size += line.length + 2; written += 1; }
    return { csv: `${lines.join('\r\n')}\r\n`, rows: written, cut: written < rows.length };
}

/** Is a scheduled copy due? lastDay: the day of the newest copy (YYYY-MM-DD) or null */
function isDue(schedule, lastDay, todayIso) {
    if (schedule !== 'weekly' && schedule !== 'monthly') return false;
    if (!lastDay) return true;
    if (schedule === 'monthly') return todayIso.slice(0, 7) > lastDay.slice(0, 7);
    return Math.round((parseIsoDate(todayIso) - parseIsoDate(lastDay)) / 86400000) >= 7;
}

module.exports = { DATASETS, OPS, SCHEDULES, MAX_COLUMNS, MAX_FILTERS, MAX_ROWS, SNAPSHOTS_KEPT, CSV_MAX_CHARS, datasetsFor, validateDefinition, withoutPay, runReport, toCsv, isDue, fieldOf, clean };
