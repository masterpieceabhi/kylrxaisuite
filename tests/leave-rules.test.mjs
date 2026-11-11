import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../services/leave-rules.js');

const mk = (over = {}) => L.validatePolicy({
    name: 'Test', type: 'sick', accrual: { method: 'hours_worked', earnHours: 1, perHours: 30 },
    annualAccrualCap: 40, annualUseCap: 40, maxBalance: 80, carryoverCap: 40, ...over
});
const policy = (over) => { const r = mk(over); assert.deepEqual(r.errors, []); return r.value; };

// 5 working days of 8 hours (Mon 2026-01-05 .. Fri 2026-01-09)
const week = (start = '2026-01-05') => {
    const out = {}; let d = start;
    for (let i = 0; i < 5; i++) { out[d] = 8; d = L.addDays(d, 1); }
    return out;
};

test('every preset is a valid policy', () => {
    for (const p of L.PRESETS) {
        const { key, ...rest } = p;
        const r = L.validatePolicy({ ...rest, appliesTo: { states: [] } });
        assert.deepEqual(r.errors, [], key);
    }
});

test('hours-worked accrual: 1 hour per 30 worked', () => {
    const b = L.simulate(policy(), { hireDate: '2026-01-05', asOf: '2026-01-09', workedByDay: week() });
    assert.equal(b.balance, 1.33); // 40 hours / 30
    assert.equal(b.accruedThisYear, 1.33);
});

test('annual accrual cap and balance cap stop accrual', () => {
    const worked = {}; let d = '2026-01-01';
    for (let i = 0; i < 300; i++) { worked[d] = 8; d = L.addDays(d, 1); } // lots of hours
    const capped = L.simulate(policy({ annualAccrualCap: 40 }), { hireDate: '2026-01-01', asOf: '2026-10-27', workedByDay: worked });
    assert.equal(capped.accruedThisYear, 40);
    const smallBal = L.simulate(policy({ annualAccrualCap: null, maxBalance: 10 }), { hireDate: '2026-01-01', asOf: '2026-10-27', workedByDay: worked });
    assert.equal(smallBal.balance, 10);
});

test('usage lowers the balance; scheduled future usage is reported separately', () => {
    const b = L.simulate(policy(), { hireDate: '2026-01-05', asOf: '2026-01-09', workedByDay: week(),
        usage: [{ date: '2026-01-08', hours: 1 }, { date: '2026-02-01', hours: 8 }] });
    assert.equal(b.balance, 0.33); assert.equal(b.usedThisYear, 1); assert.equal(b.scheduledHours, 8);
});

test('monthly accrual lands on the last day of each month', () => {
    const p = policy({ type: 'pto', accrual: { method: 'monthly', monthlyHours: 6.67 }, annualAccrualCap: null, maxBalance: 200, usageWaitingDays: 0 });
    assert.equal(L.simulate(p, { hireDate: '2026-01-10', asOf: '2026-01-30' }).balance, 0);
    assert.equal(L.simulate(p, { hireDate: '2026-01-10', asOf: '2026-01-31' }).balance, 6.67);
    assert.equal(L.simulate(p, { hireDate: '2026-01-10', asOf: '2026-03-31' }).balance, 20.01);
});

test('front-load grants on the hire date and again each new policy year', () => {
    const p = policy({ accrual: { method: 'front_load', grantHours: 40 }, annualAccrualCap: null, maxBalance: 40, carryoverCap: 0 });
    assert.equal(L.simulate(p, { hireDate: '2026-03-02', asOf: '2026-03-02' }).balance, 40);
    const y = L.simulate(p, { hireDate: '2026-03-02', asOf: '2027-01-01', usage: [{ date: '2026-06-01', hours: 10 }] });
    assert.equal(y.balance, 40); // 30 left was forfeited (carryover 0), then 40 granted
    assert.equal(y.forfeited, 30);
});

test('carryover cap forfeits the extra at the new policy year', () => {
    const p = policy({ accrual: { method: 'front_load', grantHours: 60 }, annualAccrualCap: null, maxBalance: 100, carryoverCap: 20 });
    const b = L.simulate(p, { hireDate: '2026-01-01', asOf: '2027-01-01' });
    assert.equal(b.forfeited, 40); // 60 -> carry 20, then grant 60 up to cap 100 (20 + 60 = 80)
    assert.equal(b.balance, 80);
    assert.equal(b.nextResetDate, '2028-01-01');
});

test('waiting period blocks use but not accrual; adjustments change the balance', () => {
    const p = policy({ usageWaitingDays: 90 });
    const early = L.simulate(p, { hireDate: '2026-01-05', asOf: '2026-01-09', workedByDay: week() });
    assert.equal(early.eligibleToUse, false); assert.equal(early.availableToUse, 0); assert.equal(early.usageEligibleOn, '2026-04-05'); assert.equal(early.balance, 1.33);
    const adj = L.simulate(policy(), { hireDate: '2026-01-05', asOf: '2026-01-09', workedByDay: week(), adjustments: [{ date: '2026-01-09', hours: 5 }] });
    assert.equal(adj.balance, 6.33);
});

test('annual use cap and pending requests limit what can be used', () => {
    const p = policy({ annualUseCap: 5, annualAccrualCap: null, accrual: { method: 'front_load', grantHours: 40 }, maxBalance: 40 });
    const b = L.simulate(p, { hireDate: '2026-01-01', asOf: '2026-02-01', usage: [{ date: '2026-01-15', hours: 3 }], pendingHours: 1 });
    assert.equal(b.balance, 37); assert.equal(b.availableToUse, 1); // cap 5 - used 3 - pending 1
});

test('policy applies by state and excludes contractors by default', () => {
    const p = policy({ appliesTo: { states: ['ca', 'wa'] } });
    assert.equal(L.appliesTo(p, { workState: 'CA', classification: 'W2' }), true);
    assert.equal(L.appliesTo(p, { workState: 'TX', classification: 'W2' }), false);
    assert.equal(L.appliesTo(p, { workState: 'CA', classification: '1099' }), false);
    assert.equal(L.appliesTo(policy(), { workState: 'TX', classification: 'W2' }), true);
});

test('request dates skip weekends and, by policy, federal holidays', () => {
    assert.deepEqual(L.requestDates('2026-11-23', '2026-11-27'), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27']);
    assert.deepEqual(L.requestDates('2026-11-23', '2026-11-27', { skipHolidays: true }), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27']);
    assert.deepEqual(L.requestDates('2026-11-21', '2026-11-22'), []);
    assert.equal(L.requestDates('2026-11-27', '2026-11-23'), null);
});

test('request validation: balance, increments, dates, waiting period, overlaps', () => {
    const p = policy({ minimumIncrementHours: 0.5, annualUseCap: null });
    const bal = { eligibleToUse: true, usageEligibleOn: '2026-01-01', availableBalance: 12, availableToUse: 12 };
    const ok = L.validateRequest(p, { startDate: '2026-11-10', endDate: '2026-11-10', hoursPerDay: 4 }, bal, '2026-11-09');
    assert.deepEqual(ok.errors, []); assert.equal(ok.value.hours, 4);
    // Thu and Fri = 16 hours (Nov 11 is a federal holiday, so it is not used here)
    assert.ok(L.validateRequest(p, { startDate: '2026-11-12', endDate: '2026-11-13', hoursPerDay: 8 }, bal, '2026-11-09').errors.some((e) => /not enough balance/.test(e)));
    assert.ok(L.validateRequest(p, { startDate: '2026-11-10', endDate: '2026-11-10', hoursPerDay: 4.25 }, bal, '2026-11-09').errors.some((e) => /steps of/.test(e)));
    assert.ok(L.validateRequest(p, { startDate: '2026-11-10', endDate: '2026-11-10' }, bal, '2026-11-09', ['2026-11-10']).errors.some((e) => /already have time off/.test(e)));
    assert.ok(L.validateRequest(p, { startDate: 'nope', endDate: 'x' }, bal, '2026-11-09').errors.length > 0);
    const waiting = { ...bal, eligibleToUse: false, usageEligibleOn: '2026-12-01' };
    assert.ok(L.validateRequest(p, { startDate: '2026-11-10', endDate: '2026-11-10', hoursPerDay: 4 }, waiting, '2026-11-09').errors.some((e) => /starting 2026-12-01/.test(e)));
    assert.deepEqual(L.validateRequest(p, { startDate: '2026-12-02', endDate: '2026-12-02', hoursPerDay: 4 }, waiting, '2026-11-09').errors, []);
});

test('sick leave can be requested up to 30 days back; PTO cannot start in the past', () => {
    const bal = { eligibleToUse: true, usageEligibleOn: '2026-01-01', availableBalance: 40, availableToUse: 40 };
    assert.deepEqual(L.validateRequest(policy(), { startDate: '2026-11-03', endDate: '2026-11-03' }, bal, '2026-11-09').errors, []);
    assert.ok(L.validateRequest(policy(), { startDate: '2026-09-01', endDate: '2026-09-01' }, bal, '2026-11-09').errors.some((e) => /30 days/.test(e)));
    const pto = policy({ type: 'pto' });
    assert.ok(L.validateRequest(pto, { startDate: '2026-11-03', endDate: '2026-11-03' }, bal, '2026-11-09').errors.some((e) => /today or later/.test(e)));
});

test('policy validation rejects bad input', () => {
    assert.ok(L.validatePolicy({}).errors.length >= 3);
    assert.ok(L.validatePolicy({ name: 'x', type: 'pto', accrual: { method: 'hours_worked', earnHours: 1 } }).errors.some((e) => /perHours/.test(e)));
    assert.ok(L.validatePolicy({ name: 'x', type: 'sick', accrual: { method: 'monthly', monthlyHours: 5 }, maxBalance: -1 }).errors.some((e) => /maxBalance/.test(e)));
});
