import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('../services/report-builder-rules.js');

const all = () => true;
const hrNoPay = (p) => p !== 'people.read_pay';
const execOnly = (p) => p === 'reports.view';
const people = [
    { employeeId: 'E1', name: 'Ana Ruiz', department: 'Front', workState: 'TX', startDate: '2024-03-01', payRate: 18.5, payType: 'hourly', status: 'Active' },
    { employeeId: 'E2', name: 'ben Cole', department: 'Kitchen', workState: 'TX', startDate: '2026-06-15', payRate: 22, payType: 'hourly', status: 'Active' },
    { employeeId: 'E3', name: 'Cy Diaz', department: 'Front', workState: 'WI', startDate: '2025-01-10', payRate: null, payType: null, status: 'Terminated', lastDay: '2026-09-30' },
    { employeeId: 'E4', name: 'Dee Fox', department: '', workState: 'WI', startDate: null, payRate: 30, payType: 'salary', status: 'Active' }
];
const def = (over = {}) => B.validateDefinition({ dataset: 'people', columns: ['employeeId', 'name'], ...over }, B.datasetsFor(all)).value;

test('data sets and pay columns depend on what the person may see', () => {
    assert.deepEqual(B.datasetsFor(all).map((d) => d.key), ['people', 'equipment', 'goals', 'policy_confirmations']);
    assert.deepEqual(B.datasetsFor(execOnly).map((d) => d.key), ['people']);
    assert.ok(B.datasetsFor(all)[0].fields.some((f) => f.key === 'payRate'));
    assert.ok(!B.datasetsFor(hrNoPay)[0].fields.some((f) => f.key === 'payRate' || f.key === 'payType'));
    assert.deepEqual(B.datasetsFor(() => false), []);
    for (const d of Object.values(B.DATASETS)) assert.ok(!d.fields.some((f) => /ssn|taxpayer/i.test(f.key + f.label)));
});

test('a report needs a known data set, columns the person may see, and sensible filters', () => {
    const allowed = B.datasetsFor(hrNoPay);
    assert.deepEqual(B.validateDefinition({ dataset: 'salaries' }, allowed).errors, ['Choose what the report is about']);
    assert.deepEqual(B.validateDefinition({ dataset: 'goals', columns: ['title'] }, B.datasetsFor(execOnly)).errors, ['You do not have permission to use this data']);
    assert.equal(B.validateDefinition({ dataset: 'people', columns: [] }, allowed).errors.length, 1);
    assert.match(B.validateDefinition({ dataset: 'people', columns: ['name', 'payRate'] }, allowed).errors[0], /not available to you: payRate/);
    assert.equal(B.validateDefinition({ dataset: 'people', columns: ['name'], sortBy: 'payRate', groupBy: 'payType' }, allowed).errors.length, 2);
    const bad = B.validateDefinition({ dataset: 'people', columns: ['name'], filters: [{ field: 'nope', op: 'is', value: 'x' }, { field: 'name', op: 'gt', value: '3' }, { field: 'startDate', op: 'on_or_after', value: 'last week' }, { field: 'name', op: 'contains', value: ' ' }] }, B.datasetsFor(all));
    assert.equal(bad.errors.length, 4);
    assert.equal(B.validateDefinition({ dataset: 'people', columns: ['name'], filters: [{ field: 'payRate', op: 'gt', value: 'lots' }] }, B.datasetsFor(all)).errors.length, 1);
    assert.equal(B.validateDefinition({ dataset: 'people', columns: ['name'], schedule: 'hourly' }, allowed).errors.length, 1);
    assert.equal(B.validateDefinition({ dataset: 'people', columns: ['name'], requireName: true }, allowed).errors.length, 1);
    const ok = B.validateDefinition({ name: ' Texas  <b>team</b> ', dataset: 'people', columns: ['name', 'name', 'workState'], filters: [{ field: 'workState', op: 'is', value: 'TX' }, { field: 'lastDay', op: 'empty', value: 'ignored' }, { field: 'payRate', op: 'gte', value: '20' }], sortBy: 'name', sortDir: 'desc', groupBy: 'department', schedule: 'weekly' }, B.datasetsFor(all));
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value, { name: 'Texas bteam/b', dataset: 'people', columns: ['name', 'workState'], filters: [{ field: 'workState', op: 'is', value: 'TX' }, { field: 'lastDay', op: 'empty' }, { field: 'payRate', op: 'gte', value: 20 }], sortBy: 'name', sortDir: 'desc', groupBy: 'department', schedule: 'weekly' });
});

test('filters work on text, numbers and dates', () => {
    const ids = (d) => B.runReport(d, people).rows.map((r) => r.employeeId);
    assert.deepEqual(ids(def({ filters: [{ field: 'workState', op: 'is', value: 'tx' }] })), ['E1', 'E2']);
    assert.deepEqual(ids(def({ filters: [{ field: 'name', op: 'contains', value: 'CO' }] })), ['E2']);
    assert.deepEqual(ids(def({ filters: [{ field: 'department', op: 'is_not', value: 'Front' }] })), ['E2', 'E4']);
    assert.deepEqual(ids(def({ filters: [{ field: 'department', op: 'empty' }] })), ['E4']);
    assert.deepEqual(ids(def({ filters: [{ field: 'payRate', op: 'gte', value: '22' }] })), ['E2', 'E4']);
    assert.deepEqual(ids(def({ filters: [{ field: 'payRate', op: 'lt', value: '20' }] })), ['E1']);
    assert.deepEqual(ids(def({ filters: [{ field: 'payRate', op: 'not_empty' }] })), ['E1', 'E2', 'E4']);
    assert.deepEqual(ids(def({ filters: [{ field: 'startDate', op: 'on_or_after', value: '2025-01-10' }] })), ['E2', 'E3']);
    assert.deepEqual(ids(def({ filters: [{ field: 'startDate', op: 'on_or_before', value: '2025-01-10' }, { field: 'status', op: 'is', value: 'Active' }] })), ['E1']);
});

test('sorting ignores letter case, sorts numbers as numbers and keeps empty values last', () => {
    const ids = (d) => B.runReport(d, people).rows.map((r) => r.employeeId);
    assert.deepEqual(ids(def({ sortBy: 'name' })), ['E1', 'E2', 'E3', 'E4']);
    assert.deepEqual(ids(def({ sortBy: 'name', sortDir: 'desc' })), ['E4', 'E3', 'E2', 'E1']);
    assert.deepEqual(ids(def({ sortBy: 'payRate', sortDir: 'desc' })), ['E4', 'E2', 'E1', 'E3']);
    assert.deepEqual(ids(def({ sortBy: 'payRate' })), ['E1', 'E2', 'E4', 'E3']);
    assert.deepEqual(ids(def({ sortBy: 'startDate' })), ['E1', 'E3', 'E2', 'E4']);
});

test('only the chosen columns come back, with counts when asked', () => {
    const r = B.runReport(def({ columns: ['name', 'workState'], groupBy: 'department' }), people);
    assert.deepEqual(r.columns.map((c) => c.label), ['Name', 'Work state']);
    assert.deepEqual(Object.keys(r.rows[0]), ['name', 'workState']);
    assert.equal(r.total, 4);
    assert.deepEqual(r.groups, { field: 'department', label: 'Department', rows: [{ key: 'Front', count: 2 }, { key: '(empty)', count: 1 }, { key: 'Kitchen', count: 1 }] });
    assert.equal(B.runReport(def(), people).groups, null);
    const big = B.runReport(def(), Array.from({ length: B.MAX_ROWS + 5 }, (_, i) => ({ employeeId: `E${i}`, name: 'x' })));
    assert.deepEqual([big.rows.length, big.total, big.truncated], [B.MAX_ROWS, B.MAX_ROWS + 5, true]);
});

test('a saved report with pay loses its pay parts for someone who may not see pay', () => {
    const saved = def({ columns: ['name', 'payRate'], filters: [{ field: 'payRate', op: 'gt', value: '20' }, { field: 'workState', op: 'is', value: 'TX' }], sortBy: 'payRate', groupBy: 'payType' });
    const cut = B.withoutPay(saved);
    assert.deepEqual(cut.removed, ['payRate']);
    assert.equal(cut.blocked, true);
    assert.deepEqual(cut.def.columns, ['name']);
    assert.deepEqual(cut.def.filters, [{ field: 'workState', op: 'is', value: 'TX' }]);
    assert.deepEqual([cut.def.sortBy, cut.def.groupBy], [null, null]);
    const plain = def();
    assert.deepEqual(B.withoutPay(plain), { def: plain, removed: [] });
    assert.deepEqual(B.withoutPay({ dataset: 'equipment', columns: ['cost'], filters: [] }).removed, []);
});

test('CSV quotes what needs it, defuses formulas and stops at the size limit', () => {
    const cols = [{ key: 'a', label: 'Name' }, { key: 'b', label: 'Note, with comma' }, { key: 'c', label: 'Amount' }];
    const out = B.toCsv(cols, [{ a: '=HYPERLINK("x")', b: 'Said "hi"', c: -12.5 }, { a: '@cmd', b: 'two\nlines', c: null }, { a: '-not a number', b: '', c: 0 }]);
    assert.equal(out.csv, 'Name,"Note, with comma",Amount\r\n"\'=HYPERLINK(""x"")","Said ""hi""",-12.5\r\n\'@cmd,"two\nlines",\r\n\'-not a number,,0\r\n');
    assert.deepEqual([out.rows, out.cut], [3, false]);
    const small = B.toCsv([{ key: 'a', label: 'A' }], Array.from({ length: 50 }, () => ({ a: 'xxxxxxxxxx' })), 100);
    assert.equal(small.cut, true);
    assert.ok(small.rows < 50 && small.csv.length <= 100);
});

test('a scheduled copy is due weekly after 7 days and monthly when the month changes', () => {
    assert.equal(B.isDue('none', null, '2026-11-12'), false);
    assert.equal(B.isDue('weekly', null, '2026-11-12'), true);
    assert.equal(B.isDue('weekly', '2026-11-06', '2026-11-12'), false);
    assert.equal(B.isDue('weekly', '2026-11-05', '2026-11-12'), true);
    assert.equal(B.isDue('monthly', '2026-11-01', '2026-11-30'), false);
    assert.equal(B.isDue('monthly', '2026-11-30', '2026-12-01'), true);
    assert.equal(B.isDue('monthly', '2026-12-15', '2027-01-02'), true);
});
