import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const t = require('../services/time-rules.js');

const P = (type, at) => ({ type, at });

test('state machine: out -> in -> break -> in -> out', () => {
    assert.equal(t.stateOf([]), 'out');
    assert.equal(t.stateOf([P('in', '2026-11-09T14:00:00Z')]), 'in');
    assert.equal(t.stateOf([P('in', 'a'), P('break_start', 'b')]), 'break');
    assert.equal(t.stateOf([P('in', 'a'), P('break_start', 'b'), P('break_end', 'c')]), 'in');
    assert.equal(t.stateOf([P('in', 'a'), P('out', 'b')]), 'out');
});

test('punch checks give a clear reason', () => {
    assert.equal(t.checkPunch('out', 'in'), null);
    assert.equal(t.checkPunch('in', 'in'), 'already_in');
    assert.equal(t.checkPunch('out', 'out'), 'not_in');
    assert.equal(t.checkPunch('out', 'break_start'), 'not_in');
    assert.equal(t.checkPunch('in', 'break_end'), 'not_on_break');
    assert.equal(t.checkPunch('break', 'break_start'), 'already_on_break');
    assert.equal(t.checkPunch('break', 'out'), null);
    assert.equal(t.checkPunch('in', 'dance'), 'unknown_action');
});

test('worked minutes exclude unpaid breaks; open shift counts to now', () => {
    const day = [P('in', '2026-11-09T14:00:00Z'), P('break_start', '2026-11-09T18:00:00Z'), P('break_end', '2026-11-09T18:30:00Z'), P('out', '2026-11-09T22:30:00Z')];
    const r = t.totals(day, '2026-11-09T23:00:00Z');
    // 14:00-18:00 (4h) + 18:30-22:30 (4h); the 30 minute break is not counted
    assert.equal(r.workedMinutes, 8 * 60);
    assert.equal(r.breakMinutes, 30);
    assert.equal(r.open, false);
    const open = t.totals([P('in', '2026-11-09T14:00:00Z')], '2026-11-09T16:30:00Z');
    assert.equal(open.workedMinutes, 150); assert.equal(open.open, true);
    const out = t.totals([P('in', '2026-11-09T14:00:00Z'), P('break_start', '2026-11-09T16:00:00Z'), P('out', '2026-11-09T16:20:00Z')], null);
    assert.equal(out.workedMinutes, 120); assert.equal(out.breakMinutes, 20);
});

test('a shift open for more than 16 hours is flagged as a forgotten clock-out', () => {
    assert.equal(t.isForgottenClockOut([P('in', '2026-11-09T06:00:00Z')], '2026-11-09T20:00:00Z'), false);
    assert.equal(t.isForgottenClockOut([P('in', '2026-11-09T06:00:00Z')], '2026-11-10T00:30:00Z'), true);
    assert.equal(t.isForgottenClockOut([P('in', 'x'), P('out', 'y')], '2026-11-12T00:00:00Z'), false);
});

test('days use the company time zone; weeks start Monday; overtime applies over the weekly threshold', () => {
    // 23:30 Chicago (UTC-6 in November) on Mon Nov 9 is already Tue Nov 10 in UTC
    assert.equal(t.localDate('2026-11-10T05:30:00Z', 'America/Chicago'), '2026-11-09');
    assert.equal(t.weekStart('2026-11-09'), '2026-11-09');
    assert.equal(t.weekStart('2026-11-15'), '2026-11-09');
    assert.equal(t.weekStart('2026-11-16'), '2026-11-16');
    const punches = [];
    for (const day of ['09', '10', '11', '12', '13']) { // five 9-hour days = 45 hours
        punches.push(P('in', `2026-11-${day}T14:00:00Z`), P('out', `2026-11-${day}T23:00:00Z`));
    }
    const sheet = t.timesheet(punches, 'America/Chicago', '2026-11-14T00:00:00Z', 40);
    assert.equal(sheet.days.length, 5);
    assert.equal(sheet.weeks.length, 1);
    assert.equal(sheet.weeks[0].workedMinutes, 45 * 60);
    assert.equal(sheet.weeks[0].overtimeMinutes, 5 * 60);
    assert.equal(t.timesheet(punches, 'America/Chicago', null, null).weeks[0].overtimeMinutes, undefined);
});

test('an overnight shift is split at local midnight', () => {
    // Mon 10pm to Tue 6am Chicago time = 04:00Z Tue to 12:00Z Tue
    const night = [P('in', '2026-11-10T04:00:00Z'), P('out', '2026-11-10T12:00:00Z')];
    const sheet = t.timesheet(night, 'America/Chicago', '2026-11-10T13:00:00Z', 40);
    assert.deepEqual(sheet.days.map((d) => [d.date, d.workedMinutes]), [['2026-11-09', 120], ['2026-11-10', 360]]);
    assert.equal(sheet.weeks[0].workedMinutes, 480);
    // still open at 1am Tuesday: Monday has its 2h, Tuesday 1h so far
    const live = t.timesheet([P('in', '2026-11-10T04:00:00Z')], 'America/Chicago', '2026-11-10T07:00:00Z', 40);
    assert.deepEqual(live.days.map((d) => [d.date, d.workedMinutes, d.open]), [['2026-11-09', 120, false], ['2026-11-10', 60, true]]);
});

test('keypad input becomes an employee ID', () => {
    assert.equal(t.employeeIdFromKeypad('1'), 'EMP0001');
    assert.equal(t.employeeIdFromKeypad('0042'), 'EMP0042');
    assert.equal(t.employeeIdFromKeypad('EMP0007'), 'EMP0007');
    assert.equal(t.employeeIdFromKeypad(''), null);
    assert.equal(t.employeeIdFromKeypad('1234567890'), null);
});

test('PIN is 4 to 6 digits', () => {
    assert.equal(t.validPin('1234'), true);
    assert.equal(t.validPin('123456'), true);
    assert.equal(t.validPin('123'), false);
    assert.equal(t.validPin('12a4'), false);
});
