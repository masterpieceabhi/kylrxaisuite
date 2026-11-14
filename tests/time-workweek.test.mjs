import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const t = require('../services/time-rules.js');
const P = require('../services/time-policy.js');

const MON = [{ startDay: 1, effectiveFrom: null }];
const SUN = [{ startDay: 0, effectiveFrom: null }];
// Monday weeks until Sunday Nov 15 2026, Sunday weeks from then on
const CHANGE = [{ startDay: 1, effectiveFrom: null }, { startDay: 0, effectiveFrom: '2026-11-15' }];
const punch = (type, at) => ({ type, at });

test('weekStart: Monday when nothing is said, any weekday when asked', () => {
    assert.equal(t.weekStart('2026-11-12'), '2026-11-09'); // Thursday -> Monday
    assert.equal(t.weekStart('2026-11-12', 1), '2026-11-09');
    assert.equal(t.weekStart('2026-11-12', 0), '2026-11-08'); // -> Sunday
    assert.equal(t.weekStart('2026-11-12', 4), '2026-11-12'); // Thursday week starts today
    assert.equal(t.weekStart('2026-11-12', 5), '2026-11-06'); // -> last Friday
    assert.equal(t.weekStart('2026-11-12', 6), '2026-11-07'); // -> Saturday
    assert.equal(t.weekStart('2026-01-01', 0), '2025-12-28'); // across a year end
    assert.equal(t.weekStart('2026-11-12', 9), '2026-11-09'); // nonsense falls back to Monday
    for (let day = 0; day <= 6; day++) assert.equal(t.weekdayOf(t.weekStart('2026-03-08', day)), day);
});

test('the stored workweek list is cleaned; anything unreadable is Monday', () => {
    assert.deepEqual(t.normalizeWorkweek(undefined), MON);
    assert.deepEqual(t.normalizeWorkweek('sunday'), MON);
    assert.deepEqual(t.normalizeWorkweek([{ startDay: 9, effectiveFrom: null }]), MON);
    assert.deepEqual(t.normalizeWorkweek([{ startDay: 0 }]), SUN);
    // out of order and with no "from the beginning" entry: sorted, and the oldest becomes the beginning
    assert.deepEqual(t.normalizeWorkweek([{ startDay: 0, effectiveFrom: '2026-11-15' }, { startDay: 3, effectiveFrom: '2026-01-07' }]),
        [{ startDay: 3, effectiveFrom: null }, { startDay: 0, effectiveFrom: '2026-11-15' }]);
    assert.notEqual(t.normalizeWorkweek(undefined), t.DEFAULT_WORKWEEK); // a copy, never the shared default
});

test('a Sunday-to-Saturday company gets Sunday-to-Saturday weeks', () => {
    assert.deepEqual(t.weekRange('2026-11-12', SUN), { start: '2026-11-08', end: '2026-11-14', startDay: 0, days: 7 });
    assert.deepEqual(t.weekRange('2026-11-08', SUN), { start: '2026-11-08', end: '2026-11-14', startDay: 0, days: 7 });
    assert.deepEqual(t.weekRange('2026-11-14', SUN), { start: '2026-11-08', end: '2026-11-14', startDay: 0, days: 7 });
    assert.equal(t.weekStartFor('2026-11-15', SUN), '2026-11-15');
    assert.equal(t.isWeekStart('2026-11-08', SUN), true);
    assert.equal(t.isWeekStart('2026-11-09', SUN), false);
    assert.equal(t.isWeekStart('2026-11-09', MON), true);
    assert.equal(t.isWeekStart('2026-11-09', undefined), true);
    assert.equal(t.isWeekStart('not-a-date', MON), false);
    assert.equal(t.isWeekStart('2026-13-45', MON), false);
});

test('a workweek change: earlier weeks keep their start, the changeover week is cut short, no day is lost or counted twice', () => {
    assert.deepEqual(t.weekRange('2026-11-04', CHANGE), { start: '2026-11-02', end: '2026-11-08', startDay: 1, days: 7 }); // long before: unchanged
    assert.deepEqual(t.weekRange('2026-11-12', CHANGE), { start: '2026-11-09', end: '2026-11-14', startDay: 1, days: 6 }); // the short week
    assert.deepEqual(t.weekRange('2026-11-14', CHANGE), { start: '2026-11-09', end: '2026-11-14', startDay: 1, days: 6 });
    assert.deepEqual(t.weekRange('2026-11-15', CHANGE), { start: '2026-11-15', end: '2026-11-21', startDay: 0, days: 7 });
    assert.deepEqual(t.weekRange('2026-11-22', CHANGE), { start: '2026-11-22', end: '2026-11-28', startDay: 0, days: 7 });
    assert.equal(t.isWeekStart('2026-11-09', CHANGE), true);  // a week sent before the change is still a week
    assert.equal(t.isWeekStart('2026-11-16', CHANGE), false); // Mondays stop being week starts after it
    // every day from October to December belongs to exactly one week, and weeks follow each other with no gap
    let day = '2026-10-01'; const seen = new Map();
    while (day <= '2026-12-31') {
        const r = t.weekRange(day, CHANGE);
        assert.ok(r.start <= day && day <= r.end && r.days >= 1 && r.days <= 7, day);
        if (!seen.has(r.start)) seen.set(r.start, r.end); else assert.equal(seen.get(r.start), r.end);
        day = t.addDaysIso(day, 1);
    }
    const starts = [...seen.keys()].sort();
    for (let i = 1; i < starts.length; i++) assert.equal(starts[i], t.addDaysIso(seen.get(starts[i - 1]), 1));
    // a change to a weekday two days on gives a two-day week, then full weeks
    const toWed = [{ startDay: 1, effectiveFrom: null }, { startDay: 3, effectiveFrom: '2026-11-25' }];
    assert.deepEqual(t.weekRange('2026-11-23', toWed), { start: '2026-11-23', end: '2026-11-24', startDay: 1, days: 2 });
    assert.deepEqual(t.weekRange('2026-11-26', toWed), { start: '2026-11-25', end: '2026-12-01', startDay: 3, days: 7 });
});

test('overtime is worked out on the company workweek, not on Monday weeks', () => {
    // Wed Nov 4 to Tue Nov 10, seven 8-hour days in Chicago: 56 hours
    const punches = [];
    for (const d of ['04', '05', '06', '07', '08', '09', '10']) punches.push(punch('in', `2026-11-${d}T14:00:00Z`), punch('out', `2026-11-${d}T22:00:00Z`));
    const monday = t.timesheet(punches, 'America/Chicago', null, 40);
    // Monday weeks: Wed-Sun is 40 hours (no overtime), Mon-Tue is 16
    assert.deepEqual(monday.weeks.map((w) => [w.weekStart, w.weekEnd, w.workedMinutes / 60, w.overtimeMinutes / 60]), [['2026-11-02', '2026-11-08', 40, 0], ['2026-11-09', '2026-11-15', 16, 0]]);
    assert.deepEqual(t.timesheet(punches, 'America/Chicago', null, 40, MON).weeks, monday.weeks);
    // Sunday weeks: Wed-Sat is 32, Sun-Tue is 24
    const sunday = t.timesheet(punches, 'America/Chicago', null, 40, SUN);
    assert.deepEqual(sunday.weeks.map((w) => [w.weekStart, w.weekEnd, w.workedMinutes / 60]), [['2026-11-01', '2026-11-07', 32], ['2026-11-08', '2026-11-14', 24]]);
    // Wednesday weeks: all seven days are one workweek, so 16 hours are overtime
    const wednesday = t.timesheet(punches, 'America/Chicago', null, 40, [{ startDay: 3, effectiveFrom: null }]);
    assert.deepEqual(wednesday.weeks.map((w) => [w.weekStart, w.workedMinutes / 60, w.regularMinutes / 60, w.overtimeMinutes / 60]), [['2026-11-04', 56, 40, 16]]);
    // the pay split for that one week (time-policy) agrees
    const week = P.computeWeek(wednesday.days, { ...P.DEFAULT_RULES });
    assert.deepEqual([week.totals.regularMinutes / 60, week.totals.overtimeMinutes / 60], [40, 16]);
});

test('changing the workweek: only from a future date that falls on the new start day', () => {
    const today = '2026-11-12'; // a Thursday
    const keep = P.planWorkweek(MON, {}, today);
    assert.deepEqual([keep.errors, keep.value, keep.changed, keep.pending], [[], MON, false, null]);
    assert.deepEqual(P.planWorkweek(undefined, { workweekStartDay: 1 }, today).value, MON); // choosing what is already in use changes nothing
    assert.equal(P.planWorkweek(MON, { workweekStartDay: 1 }, today).changed, false);

    const ok = P.planWorkweek(MON, { workweekStartDay: 0, workweekEffectiveFrom: '2026-11-15' }, today);
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value, CHANGE);
    assert.equal(ok.changed, true);
    assert.deepEqual(ok.pending, { startDay: 0, effectiveFrom: '2026-11-15' });

    assert.match(P.planWorkweek(MON, { workweekStartDay: 0 }, today).errors[0], /date the new workweek starts/);
    assert.match(P.planWorkweek(MON, { workweekStartDay: 0, workweekEffectiveFrom: '2026-11-08' }, today).errors[0], /future date/); // in the past
    assert.match(P.planWorkweek(MON, { workweekStartDay: 0, workweekEffectiveFrom: today }, today).errors[0], /future date/);       // today is too late
    assert.match(P.planWorkweek(MON, { workweekStartDay: 0, workweekEffectiveFrom: '2026-11-16' }, today).errors[0], /must be a Sunday/); // a Monday
    assert.match(P.planWorkweek(MON, { workweekStartDay: 0, workweekEffectiveFrom: '2026-02-30' }, today).errors[0], /date the new workweek starts/);
    assert.match(P.planWorkweek(MON, { workweekStartDay: 7, workweekEffectiveFrom: '2026-11-15' }, today).errors[0], /day of the week/);
    assert.match(P.planWorkweek(MON, { workweekStartDay: 'Sunday' }, today).errors[0], /day of the week/);
    // a refused change leaves the stored list alone
    assert.deepEqual(P.planWorkweek(MON, { workweekStartDay: 0, workweekEffectiveFrom: '2026-11-08' }, today).value, MON);
    assert.equal(P.earliestWorkweekChange(today, 0), '2026-11-15');
    assert.equal(P.earliestWorkweekChange(today, 4), '2026-11-19'); // not today, the Thursday after
    assert.equal(P.earliestWorkweekChange(today, 5), '2026-11-13');
});

test('a change that has not started yet can be moved, replaced or cancelled; one that has started is history', () => {
    const today = '2026-11-12';
    // saving the page again with the same pending choice changes nothing
    assert.equal(P.planWorkweek(CHANGE, { workweekStartDay: 0, workweekEffectiveFrom: '2026-11-15' }, today).changed, false);
    assert.equal(P.planWorkweek(CHANGE, { workweekStartDay: 0 }, today).changed, false);
    assert.deepEqual(P.planWorkweek(CHANGE, {}, today).pending, { startDay: 0, effectiveFrom: '2026-11-15' });
    // moved to a later Sunday: the old pending entry is replaced, not stacked
    assert.deepEqual(P.planWorkweek(CHANGE, { workweekStartDay: 0, workweekEffectiveFrom: '2026-11-22' }, today).value, [{ startDay: 1, effectiveFrom: null }, { startDay: 0, effectiveFrom: '2026-11-22' }]);
    // replaced by another day
    assert.deepEqual(P.planWorkweek(CHANGE, { workweekStartDay: 6, workweekEffectiveFrom: '2026-11-14' }, today).value, [{ startDay: 1, effectiveFrom: null }, { startDay: 6, effectiveFrom: '2026-11-14' }]);
    // choosing the day in use today cancels it
    const cancel = P.planWorkweek(CHANGE, { workweekStartDay: 1 }, today);
    assert.deepEqual([cancel.value, cancel.changed, cancel.pending], [MON, true, null]);
    // once the change has started it stays in the list, so older weeks still resolve to Monday
    const later = P.planWorkweek(CHANGE, { workweekStartDay: 1, workweekEffectiveFrom: '2026-12-07' }, '2026-11-20');
    assert.deepEqual(later.value, [...CHANGE, { startDay: 1, effectiveFrom: '2026-12-07' }]);
    assert.equal(t.weekStartFor('2026-11-04', later.value), '2026-11-02');
    assert.equal(t.weekStartFor('2026-11-18', later.value), '2026-11-15');
    assert.deepEqual(t.weekRange('2026-12-06', later.value), { start: '2026-12-06', end: '2026-12-06', startDay: 0, days: 1 });
    assert.equal(t.weekStartFor('2026-12-09', later.value), '2026-12-07');
});

test('saving the other time rules never touches the workweek, and validateTimeRules carries it', () => {
    const stored = { ...P.DEFAULT_RULES, workweek: CHANGE };
    const r = P.validateTimeRules({ overtimeWeeklyHours: 44 }, stored, '2026-11-20');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.value.workweek, CHANGE);
    assert.equal(r.value.overtimeWeeklyHours, 44);
    assert.equal(r.workweekChanged, false);
    // the old one-argument call still works and gives Monday
    assert.deepEqual(P.validateTimeRules({}).value.workweek, MON);
    assert.deepEqual(P.DEFAULT_RULES.workweek, MON);
    const bad = P.validateTimeRules({ workweekStartDay: 0, workweekEffectiveFrom: '2026-11-21' }, stored, '2026-11-12');
    assert.ok(bad.errors.length === 1 && /Sunday/.test(bad.errors[0]));
    const good = P.validateTimeRules({ workweekStartDay: 2, workweekEffectiveFrom: '2026-12-01', overtimeWeeklyHours: 40 }, { ...P.DEFAULT_RULES }, '2026-11-12');
    assert.deepEqual([good.errors, good.workweekChanged, good.workweekPending], [[], true, { startDay: 2, effectiveFrom: '2026-12-01' }]);
});

test('the history is capped and always keeps a "from the beginning" entry', () => {
    let list = MON; let today = '2026-01-01';
    for (let i = 0; i < 20; i++) {
        const day = i % 2 === 0 ? 0 : 1;
        const from = P.earliestWorkweekChange(today, day);
        const r = P.planWorkweek(list, { workweekStartDay: day, workweekEffectiveFrom: from }, today);
        assert.deepEqual(r.errors, []);
        list = r.value; today = t.addDaysIso(from, 1);
    }
    assert.ok(list.length <= 12);
    assert.equal(list[0].effectiveFrom, null);
    assert.deepEqual(t.normalizeWorkweek(list), list);
});
