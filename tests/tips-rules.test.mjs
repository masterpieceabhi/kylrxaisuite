import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('../services/tips-rules.js');

test('entry validation', () => {
    assert.ok(T.validateEntry({ date: '2026-03-01', cashTips: 0 }, '2026-03-02').errors.length);
    assert.ok(T.validateEntry({ date: '2026-03-05', cashTips: 5 }, '2026-03-02').errors.length);
    assert.ok(T.validateEntry({ date: '2026-03-01', cashTips: -1 }, '2026-03-02').errors.length);
    assert.equal(T.validateEntry({ date: '2026-03-01', cashTips: '12.345' }, '2026-03-02').value.cashTips, 12.35);
});
test('monthly total and threshold flag', () => {
    const e = [{ date: '2026-03-01', cashTips: 10, cardTips: 0 }, { date: '2026-03-02', cashTips: 9.99, cardTips: 0 }, { date: '2026-04-01', cashTips: 50 }];
    const m = T.monthlyTotal(e, '2026-03');
    assert.equal(m.total, 19.99); assert.equal(m.reportToEmployer, false);
    assert.equal(T.monthlyTotal(e, '2026-03', 19.99).reportToEmployer, true);
    assert.equal(T.monthlyTotal(e, '2026-04').reportToEmployer, true);
});
test('tip credit check', () => {
    const ok = T.tipCreditCheck({ cashWage: 2.13, tips: 300, hours: 30, minimum: 7.25, tippedCashWage: 2.13 });
    assert.equal(ok.ok, true); assert.equal(ok.effectiveHourly, 12.13);
    const low = T.tipCreditCheck({ cashWage: 2.13, tips: 30, hours: 30, minimum: 7.25, tippedCashWage: 2.13 });
    assert.equal(low.ok, false); assert.equal(low.makeUpPerHour, 4.12); assert.equal(low.makeUpAmount, 123.6);
    const badCash = T.tipCreditCheck({ cashWage: 1.5, tips: 600, hours: 30, minimum: 7.25, tippedCashWage: 2.13 });
    assert.equal(badCash.cashWageOk, false); assert.equal(badCash.ok, false);
    assert.ok(T.tipCreditCheck({ cashWage: 2, tips: 1, hours: 0, minimum: 7 }).errors.length);
});
test('pool by hours adds up to the cent and excludes managers', () => {
    const p = T.validatePool({ name: 'FOH', shareMethod: 'hours', participants: [{ userId: 'a' }, { userId: 'b' }, { userId: 'c' }, { userId: 'm', manager: true }] });
    assert.deepEqual(p.errors, []);
    const d = T.distribute(p.value, 100, { a: 10, b: 10, c: 10, m: 40 });
    assert.equal(d.shares.find((s) => s.userId === 'm').amount, 0);
    assert.equal(d.shares.reduce((s, x) => s + Math.round(x.amount * 100), 0), 10000);
    assert.deepEqual(d.shares.filter((s) => !s.excluded).map((s) => s.amount).sort(), [33.33, 33.33, 33.34]);
});
test('pool by percentage must total 100', () => {
    assert.ok(T.validatePool({ name: 'Bar', shareMethod: 'percentage', participants: [{ userId: 'a', percent: 60 }, { userId: 'b', percent: 30 }] }).errors.length);
    const p = T.validatePool({ name: 'Bar', shareMethod: 'percentage', participants: [{ userId: 'a', percent: 70 }, { userId: 'b', percent: 30 }] });
    assert.deepEqual(T.distribute(p.value, 55.55).shares.map((s) => s.amount), [38.89, 16.66]);
    assert.ok(T.distribute(T.validatePool({ name: 'x1', shareMethod: 'hours', participants: [{ userId: 'a' }] }).value, 10, {}).errors.length);
});
test('report rows and csv', () => {
    const rows = T.tipReportRows([{ userId: 'a', date: '2026-03-01', cashTips: 15, cardTips: 10 }, { userId: 'a', date: '2026-03-09', cashTips: 1 }], { a: { name: 'Ann, Jr', employeeId: 'E1' } }, '2026-03-01', '2026-03-07');
    assert.equal(rows.length, 1); assert.equal(rows[0].totalTips, 25); assert.equal(rows[0].reportable, 'yes');
    assert.match(T.toCsv(T.TIP_REPORT_HEADER, rows), /"Ann, Jr"/);
});
