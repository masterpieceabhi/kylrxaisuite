import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const I = require('../services/payroll-import-rules.js');

const HEAD = 'Employee number,Pay date,Period start,Period end,Gross,Net,Employee taxes,Employer taxes,Deductions,Hours,Check number';
const PEOPLE = [{ id: 'u1', employeeId: 'E1001', name: 'Ana Diaz', department: 'Kitchen' }, { id: 'u2', employeeId: 'e1002', name: 'Ben Cole', department: null }, { id: 'u3', employeeId: null, name: 'No Number' }];
const LINE1 = 'E1001,2025-01-17,2025-01-01,2025-01-15,2400.00,1830.50,419.50,183.60,150.00,80,10452';
const LINE2 = 'E1002,2025-01-17,2025-01-01,2025-01-15,1600.00,1312.40,287.60,122.40,0.00,72.5,';
const file = (...lines) => [HEAD, ...lines].join('\r\n');
const check = (text, over = {}) => I.checkFile(text, { people: PEOPLE, existing: [], today: '2026-11-12', ...over });
const byNumber = new Map([['E1001', PEOPLE[0]]]);
const raw = (over = {}) => ({ employeeNumber: 'E1001', payDate: '2025-01-17', periodStart: '2025-01-01', periodEnd: '2025-01-15', gross: '2400.00', net: '1830.50', employeeTaxes: '419.50', employerTaxes: '183.60', deductions: '150.00', hours: '80', checkNumber: '', ...over });
const rowErrors = (over) => I.validateRow(raw(over), { byNumber, today: '2026-11-12' }).errors;

test('dates and amounts are read strictly', () => {
    assert.equal(I.parseDate('2025-01-17'), '2025-01-17');
    assert.equal(I.parseDate('1/7/2025'), '2025-01-07');
    assert.equal(I.parseDate(' 12/31/2024 '), '2024-12-31');
    assert.equal(I.parseDate('2025-02-30'), null);
    assert.equal(I.parseDate('13/01/2025'), null);
    assert.equal(I.parseDate('Jan 17 2025'), null);
    assert.equal(I.parseDate(''), null);
    assert.equal(I.parseMoney('1234.5'), 1234.5);
    assert.equal(I.parseMoney('$1,234.56'), 1234.56);
    assert.equal(I.parseMoney('0'), 0);
    for (const bad of ['-5', '(5.00)', '1.234', '1,23.00', '12,34', '=1+1', '+5', '1e3', 'abc', '', ' ', '5 USD']) assert.equal(I.parseMoney(bad), null, bad);
});

test('a clean file passes and the totals add up to the cent', () => {
    const out = check(file(LINE1, LINE2));
    assert.equal(out.ok, true);
    assert.deepEqual(out.fileErrors, []);
    assert.equal(out.errorCount, 0);
    assert.deepEqual(out.rows.map((r) => r.row), [1, 2]);
    assert.deepEqual(out.totals, { rows: 2, people: 2, firstPayDate: '2025-01-17', lastPayDate: '2025-01-17', gross: 4000, net: 3142.9, employeeTaxes: 707.1, employerTaxes: 306, deductions: 150, hours: 152.5, employerCost: 4306 });
    // the employee number matches whatever its capital letters, and the person's own number is what is stored
    assert.equal(out.rows[1].value.userId, 'u2');
    assert.equal(out.rows[1].value.employeeId, 'e1002');
    assert.equal(out.rows[0].value.checkNumber, '10452');
    assert.equal(out.rows[1].value.checkNumber, null);
    assert.equal(out.rows[0].value.department, 'Kitchen');
});

test('headings may be in any order, with other names, a byte order mark and blank lines', () => {
    const text = '﻿check date,EMPLOYEE ID,gross pay,net pay,pay period start,pay period end,ee taxes,er taxes,deduction,hours worked\n\n1/17/2025,E1001,"$2,400.00","1,830.50",1/1/2025,1/15/2025,419.50,183.60,150,80\n\n';
    const out = check(text);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].value.payDate, '2025-01-17');
    assert.equal(out.rows[0].value.gross, 2400);
    assert.equal(out.rows[0].value.checkNumber, null);
});

test('a file that cannot be used at all says why', () => {
    assert.match(check('').fileErrors[0], /empty/);
    assert.match(check('   \n ').fileErrors[0], /empty/);
    const noCols = check('Employee number,Pay date,Gross\nE1001,2025-01-17,100');
    assert.equal(noCols.ok, false);
    assert.equal(noCols.fileErrors.length, 8);
    assert.match(noCols.fileErrors[0], /no "Period start" column/);
    assert.match(noCols.fileErrors[7], /first line must be the headings/);
    assert.match(check(HEAD).fileErrors[0], /no lines under them/);
    assert.match(check(`${HEAD},gross pay\n${LINE1},5`).fileErrors[0], /more than one "Gross" column/);
    assert.match(check(file(...Array.from({ length: I.MAX_ROWS + 1 }, () => LINE1))).fileErrors[0], /Split it/);
    assert.match(check(`${HEAD}\n${'x'.repeat(I.MAX_CHARS)}`).fileErrors[0], /too big/);
    assert.equal(check(LINE1).ok, false);
});

test('every problem is reported against its row', () => {
    assert.match(rowErrors({ employeeNumber: '' })[0], /Employee number is missing/);
    assert.match(rowErrors({ employeeNumber: 'E9999' })[0], /No person in your company has employee number E9999/);
    assert.match(rowErrors({ employeeNumber: '=cmd|calc' })[0], /may only have letters/);
    assert.match(rowErrors({ payDate: '' })[0], /Pay date is missing/);
    assert.match(rowErrors({ payDate: '2025-02-30' })[0], /not a real date/);
    assert.match(rowErrors({ periodStart: '1989-12-31', periodEnd: '1989-12-31', payDate: '1990-01-05' })[0], /before 1990/);
    assert.match(rowErrors({ periodStart: '2025-01-16' })[0], /Period start is after period end/);
    assert.match(rowErrors({ payDate: '2024-12-31' })[0], /before the pay period starts/);
    assert.match(rowErrors({ payDate: '2026-11-13', periodStart: '2026-11-01', periodEnd: '2026-11-12' })[0], /in the future/);
    assert.equal(rowErrors({ payDate: '2026-11-12', periodStart: '2026-11-01', periodEnd: '2026-11-12' }).length, 0);
    assert.match(rowErrors({ gross: '' })[0], /Gross is missing/);
    assert.match(rowErrors({ net: '' })[0], /Net is missing/);
    assert.match(rowErrors({ gross: '-100' })[0], /Gross must be an amount/);
    assert.match(rowErrors({ employerTaxes: 'n/a' })[0], /Employer taxes must be an amount/);
    assert.match(rowErrors({ gross: '10000000.01', net: '1' })[0], /too large/);
    assert.match(rowErrors({ hours: '-1' })[0], /Hours must be a number/);
    assert.match(rowErrors({ hours: '1001' })[0], /Hours must be a number/);
    assert.match(rowErrors({ checkNumber: '@SUM(1)' })[0], /Check number may only have/);
    assert.match(rowErrors({ gross: '0', net: '0', employeeTaxes: '0', deductions: '0' })[0], /nothing to import/);
    // several problems on one line are all listed
    assert.equal(rowErrors({ employeeNumber: '', payDate: 'soon', gross: 'lots', hours: 'many' }).length, 4);
    assert.equal(I.validateRow(raw({ gross: 'x' }), { byNumber }).value, null);
});

test('taxes, deductions and hours may be left empty, and odd sums are warnings, not errors', () => {
    const empty = I.validateRow(raw({ gross: '1000', net: '1000', employeeTaxes: '', employerTaxes: '', deductions: '', hours: '' }), { byNumber, today: '2026-11-12' });
    assert.deepEqual(empty.errors, []);
    assert.deepEqual(empty.warnings, []);
    assert.deepEqual([empty.value.employeeTaxes, empty.value.employerTaxes, empty.value.deductions, empty.value.hours], [0, 0, 0, 0]);
    const off = I.validateRow(raw({ net: '1800.00' }), { byNumber });
    assert.deepEqual(off.errors, []);
    assert.match(off.warnings[0], /does not equal net/);
    assert.match(I.validateRow(raw({ net: '2500.00' }), { byNumber }).warnings[0], /Net is more than gross/);
    // 0.1 + 0.2 style sums do not raise a false warning
    assert.deepEqual(I.validateRow(raw({ gross: '0.30', net: '0.00', employeeTaxes: '0.10', deductions: '0.20' }), { byNumber }).warnings, []);
    const out = check(file(LINE1.replace('1830.50', '1800.00')));
    assert.equal(out.ok, true);
    assert.equal(out.warningCount, 1);
});

test('the same person and pay date is refused: twice in the file, already imported, or already paid by the provider', () => {
    const twice = check(file(LINE1, LINE2, LINE1.replace('10452', '10460')));
    assert.equal(twice.ok, false);
    assert.equal(twice.errorRows, 1);
    assert.deepEqual(twice.rows[0].errors, []);
    assert.match(twice.rows[2].errors[0], /Same person and pay date as row 1/);
    // only the lines that could be saved are in the totals
    assert.equal(twice.totals.rows, 2);
    assert.equal(twice.totals.gross, 4000);
    const had = check(file(LINE1, LINE2), { existing: [{ userId: 'u1', payDate: '2025-01-17', source: 'import' }, { userId: 'u2', payDate: '2025-01-17', source: 'gusto' }, { userId: 'u1', payDate: '2025-01-31', source: 'import' }] });
    assert.match(had.rows[0].errors[0], /already imported/);
    assert.match(had.rows[1].errors[0], /from your payroll provider/);
    // a different pay date for the same person is fine
    assert.equal(check(file(LINE1, LINE1.replace('2025-01-17', '2025-01-31'))).ok, true);
    // the same date written two ways is still the same date
    assert.equal(check(file(LINE1, LINE1.replace('2025-01-17', '1/17/2025'))).ok, false);
});

test('an employee number shared by two people is refused, and a person without a number is never matched', () => {
    const out = check(file(LINE1), { people: [...PEOPLE, { id: 'u9', employeeId: 'e1001', name: 'Twin' }] });
    assert.equal(out.ok, false);
    assert.match(out.rows[0].errors[0], /More than one person/);
    assert.equal(out.rows[0].value, null);
    assert.match(check(file(LINE1.replace('E1001', 'null'))).rows[0].errors[0], /No person in your company/);
});

test('saved rows have the shape the pay result readers already use and are marked as imported', () => {
    const rows = I.toPayResults(check(file(LINE1, LINE2)), { orgId: 'org_a', batchId: 'b1', nowIso: '2026-11-12T10:00:00.000Z' });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { id: 'org_a_import_u1_2025-01-17', orgId: 'org_a', source: 'import', importBatchId: 'b1', importRow: 1, payrollUuid: 'import_b1', userId: 'u1', employeeId: 'E1001', name: 'Ana Diaz', department: 'Kitchen',
        periodStart: '2025-01-01', periodEnd: '2025-01-15', payDate: '2025-01-17', status: 'paid', currency: 'USD', gross: 2400, net: 1830.5, employeeTaxes: 419.5, employerTaxes: 183.6, deductions: 150, hours: 80, checkNumber: '10452',
        allocated: false, createdAt: '2026-11-12T10:00:00.000Z', updatedAt: '2026-11-12T10:00:00.000Z' });
    // the provider's own reader gives the same totals for these rows
    const provider = require('../services/gusto/pay-results.js');
    const t = provider.totalsOf(rows);
    assert.equal(t.gross, 4000); assert.equal(t.net, 3142.9); assert.equal(t.employerCost, 4306);
    assert.notEqual(rows[0].source, 'gusto');
    assert.throws(() => I.toPayResults(check(file(LINE1, LINE1)), { orgId: 'org_a', batchId: 'b1', nowIso: 'x' }), /has errors/);
    assert.notEqual(I.resultId('org_a', 'u1', '2025-01-17'), I.resultId('org_b', 'u1', '2025-01-17'));
    assert.equal(I.undoError({ status: 'saved' }), null);
    assert.match(I.undoError({ status: 'undone' }), /already undone/);
});

test('the template passes its own check and the CSV files cannot run as formulas', () => {
    const t = I.templateCsv();
    assert.ok(t.startsWith(`${HEAD}\r\n`));
    const out = I.checkFile(t, { people: [{ id: 'a', employeeId: 'E1001' }, { id: 'b', employeeId: 'E1002' }], today: '2026-11-12' });
    assert.equal(out.ok, true, JSON.stringify(out.rows.map((r) => r.errors)));
    assert.equal(out.warningCount, 0);
    assert.equal(I.csvCell('=1+1'), '"\'=1+1"');
    assert.equal(I.csvCell('-cmd'), '"\'-cmd"');
    assert.equal(I.csvCell(12.5), '12.5');
    const bad = check(file(LINE1.replace('E1001', '=SUM(A1:A9)')));
    assert.equal(bad.ok, false);
    const csv = I.errorsCsv(bad);
    assert.ok(csv.startsWith('Row,Employee number,Pay date,Problem\r\n'));
    assert.ok(csv.includes('1,"\'=SUM(A1:A9)",2025-01-17,'));
    assert.match(I.errorsCsv(check('')), /empty/);
});
