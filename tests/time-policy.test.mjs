import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../services/time-policy.js');
const T = require('../services/time-rules.js');

const day = (date, hours, longestBreak = 30) => ({ date, workedMinutes: Math.round(hours * 60), longestBreakMinutes: longestBreak });
const week = (hoursList, br = 30) => hoursList.map((h, i) => day(`2026-11-${String(9 + i).padStart(2, '0')}`, h, br));

test('weekly overtime only: hours over 40 are overtime, nothing else changes', () => {
    const r = P.computeWeek(week([9, 9, 9, 9, 9]), P.DEFAULT_RULES);
    assert.equal(r.totals.workedMinutes, 45 * 60);
    assert.equal(r.totals.regularMinutes, 40 * 60);
    assert.equal(r.totals.overtimeMinutes, 5 * 60);
    assert.equal(r.totals.doubleTimeMinutes, 0);
    assert.deepEqual(r.days.map((d) => d.overtimeMinutes / 60), [0, 0, 0, 0, 5]); // overtime lands on the day the 40th hour is passed
});

test('a part-time week has no overtime', () => {
    const r = P.computeWeek(week([4, 4, 5, 0, 6]), P.DEFAULT_RULES);
    assert.equal(r.totals.overtimeMinutes, 0); assert.equal(r.totals.regularMinutes, 19 * 60);
});

test('daily overtime and double time (when the company turns them on)', () => {
    const rules = P.validateTimeRules({ dailyOvertime: { enabled: true, thresholdHours: 8, doubleTimeThresholdHours: 12 } }).value;
    const r = P.computeWeek([day('2026-11-09', 14)], rules);
    assert.equal(r.days[0].regularMinutes, 8 * 60);
    assert.equal(r.days[0].overtimeMinutes, 4 * 60);
    assert.equal(r.days[0].doubleTimeMinutes, 2 * 60);
});

test('daily and weekly overtime together: hours already paid as daily overtime are not counted twice', () => {
    const rules = P.validateTimeRules({ dailyOvertime: { enabled: true, thresholdHours: 8 } }).value;
    // Mon-Fri 9h: 1h daily overtime each day = 5h OT, regular 8x5 = 40 (not over the weekly 40)
    let r = P.computeWeek(week([9, 9, 9, 9, 9]), rules);
    assert.equal(r.totals.overtimeMinutes, 5 * 60); assert.equal(r.totals.regularMinutes, 40 * 60);
    // six 8h days = 48h: daily OT none, weekly OT 8h
    r = P.computeWeek(week([8, 8, 8, 8, 8, 8]), rules);
    assert.equal(r.totals.regularMinutes, 40 * 60); assert.equal(r.totals.overtimeMinutes, 8 * 60);
    assert.equal(r.totals.workedMinutes, r.totals.regularMinutes + r.totals.overtimeMinutes + r.totals.doubleTimeMinutes);
});

test('exempt employees are paid straight time with no meal flags', () => {
    const rules = P.validateTimeRules({ meal: { enabled: true } }).value;
    const r = P.computeWeek(week([11, 11, 11, 11, 11], 0), rules, { exempt: true });
    assert.equal(r.totals.overtimeMinutes, 0); assert.equal(r.totals.regularMinutes, 55 * 60); assert.deepEqual(r.flags, []);
});

test('meal break check flags long days without a long enough break', () => {
    const rules = P.validateTimeRules({ meal: { enabled: true, requiredAfterHours: 5, minimumMinutes: 30 } }).value;
    const r = P.computeWeek([day('2026-11-09', 8, 0), day('2026-11-10', 8, 30), day('2026-11-11', 8, 15), day('2026-11-12', 4, 0)], rules);
    assert.deepEqual(r.days.map((d) => d.flags.length), [1, 0, 1, 0]);
    assert.deepEqual(r.flags, ['missed_meal_break']);
    assert.deepEqual(P.computeWeek([day('2026-11-09', 8, 0)], P.DEFAULT_RULES).flags, []); // off by default
});

test('rules validation', () => {
    assert.deepEqual(P.validateTimeRules({}).errors, []);
    assert.ok(P.validateTimeRules({ overtimeWeeklyHours: 0 }).errors.length > 0);
    assert.ok(P.validateTimeRules({ dailyOvertime: { enabled: true, thresholdHours: 8, doubleTimeThresholdHours: 6 } }).errors.length > 0);
    assert.ok(P.validateTimeRules({ meal: { minimumMinutes: 999 } }).errors.length > 0);
    assert.equal(P.toHours(95), 1.58);
});

test('holiday pay, rest breaks and break premiums are off by default and checked when set', () => {
    const r = P.computeWeek(week([8, 8, 8]), P.DEFAULT_RULES, { paidHolidays: ['2026-11-11'], holidayEligible: true, missedRestDays: ['2026-11-09'] });
    assert.deepEqual([r.totals.holidayMinutes, r.totals.premiumMinutes, r.holidayPay.length, r.flags.length], [0, 0, 0, 0]);
    assert.deepEqual(r.days.map((d) => d.restBreaksDue), [0, 0, 0]);
    assert.ok(P.validateTimeRules({ holidayPay: { enabled: true, hours: 30 } }).errors.length > 0);
    assert.ok(P.validateTimeRules({ holidayPay: { enabled: true, who: 'managers' } }).errors.length > 0);
    assert.ok(P.validateTimeRules({ restBreak: { enabled: true, minutes: 90 } }).errors.length > 0);
    assert.ok(P.validateTimeRules({ breakPremium: { enabled: true, hours: 9 }, meal: { enabled: true } }).errors.length > 0);
    assert.match(P.validateTimeRules({ breakPremium: { enabled: true } }).errors[0], /Turn on the meal-break check or rest breaks/);
    const ok = P.validateTimeRules({ holidayPay: { enabled: true, hours: 6, who: 'full_time' }, restBreak: { enabled: true, everyHours: 3.5, minutes: 15 }, breakPremium: { enabled: true, hours: 1 } });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual([ok.value.holidayPay, ok.value.restBreak, ok.value.breakPremium], [{ enabled: true, hours: 6, who: 'full_time' }, { enabled: true, everyHours: 3.5, minutes: 15 }, { enabled: true, hours: 1 }]);
});

test('paid holidays add hours on top, never count toward overtime, and skip exempt staff', () => {
    const rules = P.validateTimeRules({ holidayPay: { enabled: true, hours: 8 } }).value;
    // 40 hours worked Mon-Fri with a paid holiday on Wednesday: 40 regular, 0 overtime, 8 holiday
    let r = P.computeWeek(week([8, 8, 8, 8, 8]), rules, { paidHolidays: ['2026-11-11'], holidayEligible: true });
    assert.deepEqual([r.totals.regularMinutes / 60, r.totals.overtimeMinutes, r.totals.holidayMinutes / 60], [40, 0, 8]);
    assert.deepEqual(r.holidayPay, [{ date: '2026-11-11', minutes: 480 }]);
    // a holiday on a day with no punches still pays; two holidays pay twice; a repeated date pays once
    r = P.computeWeek(week([8, 8]), rules, { paidHolidays: ['2026-11-13', '2026-11-12', '2026-11-13'], holidayEligible: true });
    assert.equal(r.totals.holidayMinutes / 60, 16);
    assert.equal(r.totals.workedMinutes / 60, 16);
    assert.equal(P.computeWeek(week([8]), rules, { paidHolidays: ['2026-11-11'], holidayEligible: false }).totals.holidayMinutes, 0);
    assert.equal(P.computeWeek(week([8]), rules, { paidHolidays: ['2026-11-11'], holidayEligible: true, exempt: true }).totals.holidayMinutes, 0);
    assert.equal(P.computeWeek(week([8]), rules, { holidayEligible: true }).totals.holidayMinutes, 0);
});

test('who gets holiday pay follows the company setting', () => {
    const everyone = P.validateTimeRules({ holidayPay: { enabled: true } }).value;
    const fullTime = P.validateTimeRules({ holidayPay: { enabled: true, who: 'full_time' } }).value;
    assert.equal(P.holidayPayApplies(P.DEFAULT_RULES, {}), false);
    assert.equal(P.holidayPayApplies(everyone, { employmentType: 'part_time' }), true);
    assert.equal(P.holidayPayApplies(everyone, { exempt: true }), false);
    assert.equal(P.holidayPayApplies(fullTime, { employmentType: 'full_time' }), true);
    assert.equal(P.holidayPayApplies(fullTime, { employmentType: 'Full-Time' }), true);
    assert.equal(P.holidayPayApplies(fullTime, { employmentType: 'part_time' }), false);
    assert.equal(P.holidayPayApplies(fullTime, {}), false);
});

test('rest breaks: how many are due per day, and a reported miss is flagged', () => {
    const rules = P.validateTimeRules({ restBreak: { enabled: true, everyHours: 4, minutes: 10 } }).value;
    const r = P.computeWeek([day('2026-11-09', 8), day('2026-11-10', 3.5), day('2026-11-11', 12)], rules, { missedRestDays: ['2026-11-09', '2026-11-10'] });
    assert.deepEqual(r.days.map((d) => d.restBreaksDue), [2, 0, 3]);
    // Tuesday was too short for a rest break, so reporting a miss there changes nothing
    assert.deepEqual(r.days.map((d) => d.flags), [['missed_rest_break'], [], []]);
    assert.equal(r.totals.premiumMinutes, 0); // premium is its own setting
    assert.deepEqual(P.computeWeek([day('2026-11-09', 8)], rules, { missedRestDays: ['2026-11-09'], exempt: true }).flags, []);
});

test('premium hours: one for a missed meal break and one for a missed rest break on a day', () => {
    const rules = P.validateTimeRules({ meal: { enabled: true }, restBreak: { enabled: true }, breakPremium: { enabled: true, hours: 1 } }).value;
    const r = P.computeWeek([day('2026-11-09', 8, 0), day('2026-11-10', 8, 30), day('2026-11-11', 8, 0)], rules, { missedRestDays: ['2026-11-09', '2026-11-10'] });
    assert.deepEqual(r.days.map((d) => d.premiumMinutes / 60), [2, 1, 1]);
    assert.equal(r.totals.premiumMinutes / 60, 4);
    assert.equal(r.totals.regularMinutes / 60, 24); // premium hours are not hours worked
    assert.deepEqual(r.flags, ['missed_meal_break', 'missed_rest_break']);
    const half = P.validateTimeRules({ meal: { enabled: true }, breakPremium: { enabled: true, hours: 0.5 } }).value;
    assert.equal(P.computeWeek([day('2026-11-09', 8, 0)], half).totals.premiumMinutes, 30);
    assert.equal(P.computeWeek([day('2026-11-09', 8, 0)], half, { exempt: true }).totals.premiumMinutes, 0);
});

test('wall-clock times convert to UTC across daylight saving changes', () => {
    assert.equal(T.zonedToUtcIso('2026-11-09', '08:30', 'America/Chicago'), '2026-11-09T14:30:00.000Z'); // CST, UTC-6
    assert.equal(T.zonedToUtcIso('2026-07-09', '08:30', 'America/Chicago'), '2026-07-09T13:30:00.000Z'); // CDT, UTC-5
    assert.equal(T.zonedToUtcIso('2026-11-01', '08:00', 'America/Chicago'), '2026-11-01T14:00:00.000Z'); // after the fall-back
    assert.equal(T.zonedToUtcIso('2026-11-09', '25:00', 'America/Chicago'), null);
    assert.equal(T.zonedToUtcIso('nope', '08:00', 'America/Chicago'), null);
});

test('punch sequences are checked step by step', () => {
    const p = (type) => ({ type });
    assert.equal(T.validateSequence([p('in'), p('break_start'), p('break_end'), p('out')]), null);
    assert.deepEqual(T.validateSequence([p('in'), p('in')]), { index: 1, code: 'already_in' });
    assert.deepEqual(T.validateSequence([p('out')]), { index: 0, code: 'not_in' });
    assert.equal(T.validateSequence([]), null);
});

test('timesheet days now carry the longest single break', () => {
    const punches = [{ type: 'in', at: '2026-11-09T14:00:00Z' }, { type: 'break_start', at: '2026-11-09T17:00:00Z' }, { type: 'break_end', at: '2026-11-09T17:20:00Z' },
        { type: 'break_start', at: '2026-11-09T19:00:00Z' }, { type: 'break_end', at: '2026-11-09T19:45:00Z' }, { type: 'out', at: '2026-11-09T23:00:00Z' }];
    const s = T.timesheet(punches, 'America/Chicago', '2026-11-10T00:00:00Z', 40);
    assert.equal(s.days[0].breakMinutes, 65); assert.equal(s.days[0].longestBreakMinutes, 45);
});
