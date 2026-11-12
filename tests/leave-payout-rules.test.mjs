import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../services/leave-payout-rules.js');

const pto = (hours, paid = true) => ({ policyId: 'pto', policyName: 'PTO', type: 'pto', payoutAtTermination: paid, balanceHours: hours });
const sick = (hours, paid = false) => ({ policyId: 'sick', policyName: 'Sick', type: 'sick', payoutAtTermination: paid, balanceHours: hours });

test('hourly person: unused paid-out hours x hourly rate', () => {
    const r = R.computePayout({ balances: [pto(37.5), sick(12)], profile: { payType: 'hourly', payRate: 18.4 } });
    assert.deepEqual(r.errors, []);
    assert.equal(r.value.hourlyRate, 18.4);
    assert.equal(r.value.rateBasis, 'hourly rate');
    assert.equal(r.value.hours, 37.5);
    assert.equal(r.value.amount, 690); // 37.5 x 18.40
    const sickLine = r.value.lines.find((l) => l.policyId === 'sick');
    assert.deepEqual({ unused: sickLine.unusedHours, paidOut: sickLine.paidOut, hours: sickLine.hours, amount: sickLine.amount }, { unused: 12, paidOut: false, hours: 0, amount: 0 });
});

test('salaried person: annual salary / 2080 unless the company sets another divisor', () => {
    const profile = { payType: 'salary', payRate: 62400 };
    const d = R.computePayout({ balances: [pto(40)], profile });
    assert.equal(d.value.hourlyRate, 30); // 62400 / 2080
    assert.equal(d.value.amount, 1200);
    assert.match(d.value.rateBasis, /2080/);
    const c = R.computePayout({ balances: [pto(40)], profile, settings: { salaryHoursPerYear: 1950 } });
    assert.equal(c.value.hourlyRate, 32); // 62400 / 1950
    assert.equal(c.value.amount, 1280);
    assert.match(c.value.rateBasis, /1950/);
    // a broken stored divisor falls back to 2080 instead of dividing by zero
    assert.equal(R.computePayout({ balances: [pto(40)], profile, settings: { salaryHoursPerYear: 0 } }).value.hourlyRate, 30);
});

test('money is rounded to cents per policy line and the total is the sum of the lines', () => {
    const r = R.computePayout({ balances: [pto(13.33), sick(7.77, true)], profile: { payType: 'salary', payRate: 55000 } });
    assert.equal(r.value.hourlyRate, 26.4423); // 55000 / 2080, 4 decimals
    assert.equal(r.value.lines[0].amount, 352.48); // 13.33 x 26.4423 = 352.4759
    assert.equal(r.value.lines[1].amount, 205.46); // 7.77 x 26.4423 = 205.4567
    assert.equal(r.value.amount, 557.94);
    assert.equal(r.value.hours, 21.1);
});

test('nothing to pay: policy not paid out, zero or negative balance, no policies', () => {
    const p = { payType: 'hourly', payRate: 20 };
    assert.match(R.computePayout({ balances: [pto(40, false)], profile: p }).errors[0], /No leave policy .* is set to be paid out/);
    assert.match(R.computePayout({ balances: [pto(0)], profile: p }).errors[0], /no unused hours/);
    const neg = R.computePayout({ balances: [pto(-6)], profile: p });
    assert.match(neg.errors[0], /no unused hours/); assert.equal(neg.value.amount, 0); assert.equal(neg.value.lines[0].unusedHours, 0);
    assert.match(R.computePayout({ balances: [], profile: p }).errors[0], /No leave policy/);
    // a negative balance on one policy never reduces what another policy pays
    assert.equal(R.computePayout({ balances: [pto(10), sick(-4, true)], profile: p }).value.amount, 200);
});

test('a person with no usable pay rate cannot be paid out', () => {
    assert.match(R.computePayout({ balances: [pto(8)], profile: { payType: 'hourly' } }).errors[0], /no pay rate/);
    assert.match(R.computePayout({ balances: [pto(8)], profile: { payType: 'hourly', payRate: 0 } }).errors[0], /no pay rate/);
    assert.match(R.computePayout({ balances: [pto(8)], profile: { payRate: 20 } }).errors[0], /no pay type/);
    assert.match(R.computePayout({ balances: [pto(8)], profile: null }).errors[0], /no pay rate/);
    assert.equal(R.computePayout({ balances: [pto(8)], profile: {} }).value.amount, 0);
});

test('company setting: salary hours per year', () => {
    assert.deepEqual(R.validateSettings({ salaryHoursPerYear: 1950 }), { errors: [], value: { salaryHoursPerYear: 1950 } });
    assert.equal(R.validateSettings({ salaryHoursPerYear: '' }).value.salaryHoursPerYear, 2080); // empty puts the default back
    for (const bad of [0, 999, 3001, -2080, 'lots', Infinity]) assert.ok(R.validateSettings({ salaryHoursPerYear: bad }).errors.length, String(bad));
    assert.ok(R.validateSettings({}).errors.length);
    assert.equal(R.normalizeSettings(undefined).salaryHoursPerYear, 2080);
    assert.equal(R.normalizeSettings({ salaryHoursPerYear: 2000 }).salaryHoursPerYear, 2000);
    assert.match(R.ADVISOR_NOTE, /confirm with a US compliance advisor/i);
});

test('request input', () => {
    assert.deepEqual(R.validateRequest({ userId: ' u1 ' }).value, { userId: 'u1', reason: 'termination', note: '' });
    assert.equal(R.validateRequest({ userId: 'u1', reason: 'cash_out', note: 'x'.repeat(400) }).value.note.length, 300);
    assert.ok(R.validateRequest({}).errors.some((e) => /userId/.test(e)));
    assert.ok(R.validateRequest({ userId: 'u1', reason: 'bonus' }).errors.some((e) => /reason/.test(e)));
});

test('status moves: pending -> approved -> paid, with reject and cancel on the way', () => {
    assert.deepEqual(R.transition('pending', 'approve'), { to: 'approved' });
    assert.deepEqual(R.transition('approved', 'paid'), { to: 'paid' });
    assert.deepEqual(R.transition('pending', 'reject'), { to: 'rejected' });
    assert.deepEqual(R.transition('pending', 'cancel'), { to: 'cancelled' });
    assert.deepEqual(R.transition('approved', 'cancel'), { to: 'cancelled' });
    // not allowed
    assert.match(R.transition('pending', 'paid').error, /already pending; it cannot be marked paid/); // must be approved first
    assert.match(R.transition('approved', 'approve').error, /already approved/);
    assert.match(R.transition('approved', 'reject').error, /cannot be rejected/);
    for (const done of ['paid', 'rejected', 'cancelled']) for (const a of ['approve', 'reject', 'paid', 'cancel']) assert.ok(R.transition(done, a).error, `${done} ${a}`);
    assert.match(R.transition('pending', 'delete').error, /unknown action/);
});

test('approval is refused when the numbers moved since the request', () => {
    const profile = { payType: 'hourly', payRate: 20 };
    const stored = R.computePayout({ balances: [pto(16), sick(4)], profile }).value;
    assert.equal(R.sameNumbers(stored, R.computePayout({ balances: [pto(16), sick(9)], profile }).value), true); // unpaid policy moved: irrelevant
    assert.equal(R.sameNumbers(stored, R.computePayout({ balances: [pto(8), sick(4)], profile }).value), false); // they took a day off
    assert.equal(R.sameNumbers(stored, R.computePayout({ balances: [pto(16)], profile: { payType: 'hourly', payRate: 21 } }).value), false); // raise
    assert.equal(R.sameNumbers(stored, null), false);
});

test('marking paid takes the paid hours off each policy', () => {
    const v = R.computePayout({ balances: [pto(16), sick(4), { ...sick(3, true), policyId: 'float' }], profile: { payType: 'hourly', payRate: 20 } }).value;
    assert.deepEqual(R.adjustmentsFor(v), [{ policyId: 'pto', hours: -16 }, { policyId: 'float', hours: -3 }]);
});

test('the list payroll reads and its CSV', () => {
    const v = R.computePayout({ balances: [pto(16), sick(4)], profile: { payType: 'hourly', payRate: 20 } }).value;
    const row = R.payrollRow({ id: 'p1', userId: 'u1', employeeId: 'E-7', name: 'Lopez, "Mari"', reason: 'termination', status: 'approved', approvedAt: '2026-11-12T10:00:00.000Z', requestedBy: 'hr1', ...v });
    assert.equal(row.amount, 320); assert.equal(row.earningType, 'pto_payout'); assert.equal(row.lines.length, 1); assert.equal('requestedBy' in row, false);
    const csv = R.toCsv([row, { ...row, id: 'p2', name: '=HYPERLINK("x")', amount: 5 }]);
    const lines = csv.trim().split('\r\n');
    assert.equal(lines[0], 'Payout ID,Employee ID,Name,Reason,Hours,Hourly rate,Amount,Approved at,Earning type');
    assert.equal(lines[1], 'p1,E-7,"Lopez, ""Mari""",termination,16,20,320.00,2026-11-12T10:00:00.000Z,pto_payout');
    assert.ok(lines[2].includes(`"'=HYPERLINK(""x"")"`)); // a formula in a name is made harmless
    assert.equal(R.toCsv([]).trim(), lines[0]);
});
