import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const W = require('../services/wage-rules.js');

const rule = (o) => { const r = W.validateRule(o); assert.deepEqual(r.errors, [], JSON.stringify(o)); return { ...r.value, verified: true }; };
const rules = [
    ...W.SEED_RULES,
    rule({ jurisdiction: 'state', state: 'WA', effectiveDate: '2025-01-01', hourlyMinimum: 16.5 }),
    rule({ jurisdiction: 'state', state: 'WA', effectiveDate: '2026-01-01', hourlyMinimum: 17.5 }),
    rule({ jurisdiction: 'city', state: 'WA', name: 'Seattle', effectiveDate: '2026-01-01', hourlyMinimum: 21.3 })
];

test('seed has only the federal rule', () => {
    assert.equal(W.SEED_RULES.length, 1);
    assert.equal(W.SEED_RULES[0].hourlyMinimum, 7.25); assert.equal(W.SEED_RULES[0].tippedCashWage, 2.13);
});
test('validation catches bad input', () => {
    assert.ok(W.validateRule({}).errors.length >= 2);
    assert.ok(W.validateRule({ jurisdiction: 'city', state: 'WA', effectiveDate: '2026-01-01', hourlyMinimum: 5 }).errors.some((e) => /name/.test(e)));
    assert.ok(W.validateRule({ jurisdiction: 'state', state: 'WA', effectiveDate: '2026-13-01', hourlyMinimum: 5 }).errors.length);
    assert.ok(W.validateRule({ jurisdiction: 'state', state: 'WA', effectiveDate: '2026-01-01', hourlyMinimum: 5, tippedCashWage: 6 }).errors.length);
});
test('highest applicable rule on the date wins, newest per jurisdiction', () => {
    assert.equal(W.effectiveMinimum(rules, { state: 'TX' }, '2026-06-01').hourlyMinimum, 7.25);
    assert.equal(W.effectiveMinimum(rules, { state: 'WA' }, '2025-06-01').hourlyMinimum, 16.5);
    assert.equal(W.effectiveMinimum(rules, { state: 'WA' }, '2026-06-01').hourlyMinimum, 17.5);
    assert.equal(W.effectiveMinimum(rules, { state: 'WA', city: 'seattle' }, '2026-06-01').hourlyMinimum, 21.3);
    assert.equal(W.effectiveMinimum(rules, { state: 'WA', city: 'seattle' }, '2025-06-01').hourlyMinimum, 16.5);
    assert.equal(W.effectiveMinimum(rules, { state: 'WA' }, '2009-08-01').hourlyMinimum, 7.25);
    assert.equal(W.effectiveMinimum(rules, { state: 'WA' }, '2001-01-01').hourlyMinimum, null);
});
test('a state with no tipped wage means no tip credit there', () => {
    assert.equal(W.effectiveMinimum(rules, { state: 'WA' }, '2026-06-01').tippedCashWage, 17.5);
    assert.equal(W.effectiveMinimum(rules, { state: 'TX' }, '2026-06-01').tippedCashWage, 2.13);
});
test('violations are reported; tipped workers at the tipped wage are not', () => {
    const people = [
        { id: 'a', name: 'A', payType: 'hourly', payRate: 7, workState: 'TX' },
        { id: 'b', name: 'B', payType: 'hourly', payRate: 17, workState: 'WA' },
        { id: 'c', name: 'C', payType: 'hourly', payRate: 22, workState: 'WA', workCity: 'Seattle' },
        { id: 'd', name: 'D', payType: 'salary', payRate: 1, workState: 'TX' },
        { id: 'e', name: 'E', payType: 'hourly', payRate: 2.13, workState: 'TX', tipped: true }
    ];
    const r = W.checkEmployees(rules, people, '2026-06-01');
    assert.deepEqual(r.violations.map((v) => v.id).sort(), ['a', 'b']);
    assert.equal(r.checked, 4);
    assert.equal(r.violations.find((v) => v.id === 'a').shortfall, 0.25);
});
test('checkRate hook and history', () => {
    assert.equal(W.checkRate(rules, { state: 'TX' }, '2026-01-01', 7.24).ok, false);
    assert.equal(W.checkRate(rules, { state: 'TX' }, '2026-01-01', 2.13, { tipped: true }).ok, true);
    assert.equal(W.history(rules, { jurisdiction: 'state', state: 'WA' })[0].effectiveDate, '2026-01-01');
});
