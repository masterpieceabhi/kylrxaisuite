import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const t = require('../services/time-rules.js');

const NY = 'America/New_York'; const CHI = 'America/Chicago'; const LA = 'America/Los_Angeles';
const SUN = [{ startDay: 0, effectiveFrom: null }];
const P = (type, at) => ({ type, at });
// worked minutes per day (a day that only holds the clock-out punch at midnight has none and is left out)
const dayMinutes = (sheet) => Object.fromEntries(sheet.days.filter((d) => d.workedMinutes > 0).map((d) => [d.date, d.workedMinutes]));
const weekMinutes = (sheet) => Object.fromEntries(sheet.weeks.map((w) => [w.weekStart, w.workedMinutes]));

test('a work location time zone wins over the company one; a bad or missing zone falls back', () => {
    assert.equal(t.pickTimeZone(LA, NY), LA);
    assert.equal(t.pickTimeZone(null, NY), NY);
    assert.equal(t.pickTimeZone('', NY), NY);
    assert.equal(t.pickTimeZone('Mars/Olympus_Mons', NY), NY);
    assert.equal(t.pickTimeZone(undefined, 'Nowhere/None'), 'UTC');
    assert.equal(t.pickTimeZone(42, NY), NY);
});

test('one instant near midnight is a different day for people in different states', () => {
    const at = '2026-11-10T05:30:00Z';
    assert.equal(t.localDate(at, NY), '2026-11-10');  // 00:30 Tuesday
    assert.equal(t.localDate(at, CHI), '2026-11-09'); // 23:30 Monday
    assert.equal(t.localDate(at, LA), '2026-11-09');  // 21:30 Monday
    // one second either side of midnight in Los Angeles
    assert.equal(t.localDate('2026-11-10T07:59:59Z', LA), '2026-11-09');
    assert.equal(t.localDate('2026-11-10T08:00:00Z', LA), '2026-11-10');
});

test('a late shift in California belongs to the days it was worked there, not to head-office days', () => {
    // 10 pm Monday to 2 am Tuesday in Los Angeles
    const shift = [P('in', '2026-11-10T06:00:00Z'), P('out', '2026-11-10T10:00:00Z')];
    assert.deepEqual(dayMinutes(t.timesheet(shift, LA, null, 40)), { '2026-11-09': 120, '2026-11-10': 120 });
    // in the head-office zone (New York) the same four hours would all land on Tuesday
    assert.deepEqual(dayMinutes(t.timesheet(shift, NY, null, 40)), { '2026-11-10': 240 });
    // the punch itself is counted on the person's own day
    assert.equal(t.timesheet(shift, LA, null, 40).days[0].punches, 1);
});

test('"today" and the open shift follow the person\'s zone', () => {
    const now = '2026-11-10T05:30:00Z'; // already Tuesday in New York, still Monday in Los Angeles
    const open = [P('in', '2026-11-10T02:00:00Z')];
    const la = t.timesheet(open, LA, now, 40);
    assert.deepEqual(la.days.map((d) => [d.date, d.open, d.workedMinutes]), [['2026-11-09', true, 210]]);
    const ny = t.timesheet(open, NY, now, 40);
    assert.deepEqual(ny.days.map((d) => [d.date, d.open, d.workedMinutes]), [['2026-11-09', false, 180], ['2026-11-10', true, 30]]);
});

test('the week boundary is midnight in the person\'s zone', () => {
    // Sunday 10 pm to Monday 2 am in Los Angeles: half in each Monday-based week
    const shift = [P('in', '2026-11-16T06:00:00Z'), P('out', '2026-11-16T10:00:00Z')];
    assert.deepEqual(weekMinutes(t.timesheet(shift, LA, null, 40)), { '2026-11-09': 120, '2026-11-16': 120 });
    assert.deepEqual(weekMinutes(t.timesheet(shift, NY, null, 40)), { '2026-11-16': 240 }); // what head-office time would have said
    // Sunday-to-Saturday company: Saturday 10 pm to Sunday 2 am in Los Angeles
    const sat = [P('in', '2026-11-15T06:00:00Z'), P('out', '2026-11-15T10:00:00Z')];
    assert.deepEqual(weekMinutes(t.timesheet(sat, LA, null, 40, SUN)), { '2026-11-08': 120, '2026-11-15': 120 });
    assert.deepEqual(weekMinutes(t.timesheet(sat, NY, null, 40, SUN)), { '2026-11-15': 240 });
    // and 40 hours Mon-Fri plus that Sunday-night shift: the two Monday hours are not overtime of the week before
    const week = [];
    for (const d of ['09', '10', '11', '12', '13']) week.push(P('in', `2026-11-${d}T16:00:00Z`), P('out', `2026-11-${d}T23:36:00Z`)); // 7.6 h x 5 = 38 h
    const all = t.timesheet([...week, ...shift], LA, null, 40);
    assert.deepEqual(all.weeks.map((w) => [w.weekStart, w.workedMinutes, w.overtimeMinutes]), [['2026-11-09', 38 * 60 + 120, 0], ['2026-11-16', 120, 0]]);
    const headOffice = t.timesheet([...week, ...shift], NY, null, 40);
    assert.equal(headOffice.weeks[0].workedMinutes, 38 * 60); // the wrong split loses the Sunday hours from the week they were worked in
});

test('clocks go back (Sunday Nov 1 2026): the night is an hour longer and every minute is counted once', () => {
    // 10 pm Saturday (CDT) to 6 am Sunday (CST) in Chicago is 9 real hours
    const shift = [P('in', '2026-11-01T03:00:00Z'), P('out', '2026-11-01T12:00:00Z')];
    const sheet = t.timesheet(shift, CHI, null, 40);
    assert.deepEqual(dayMinutes(sheet), { '2026-10-31': 120, '2026-11-01': 420 });
    assert.equal(t.totals(shift).workedMinutes, 540);
    // midnight that night is 05:00 UTC; the next midnight is 06:00 UTC (the day is 25 hours long)
    assert.equal(t.localDate('2026-11-01T04:59:59Z', CHI), '2026-10-31');
    assert.equal(t.localDate('2026-11-01T05:00:00Z', CHI), '2026-11-01');
    assert.equal(t.localDate('2026-11-02T05:59:59Z', CHI), '2026-11-01');
    assert.equal(t.localDate('2026-11-02T06:00:00Z', CHI), '2026-11-02');
    // someone clocked in for that whole Sunday is paid 25 hours on it
    const allDay = [P('in', '2026-11-01T05:00:00Z'), P('out', '2026-11-02T06:00:00Z')];
    assert.deepEqual(dayMinutes(t.timesheet(allDay, CHI, null, 40)), { '2026-11-01': 25 * 60 });
    // Monday-based week: that Sunday is the last day of the week of Oct 26
    assert.deepEqual(weekMinutes(t.timesheet(shift, CHI, null, 40)), { '2026-10-26': 540 });
    // Sunday-based week: the boundary is that same midnight
    assert.deepEqual(weekMinutes(t.timesheet(shift, CHI, null, 40, SUN)), { '2026-10-25': 120, '2026-11-01': 420 });
});

test('clocks go forward (Sunday Mar 8 2026): the night is an hour shorter', () => {
    // 10 pm Saturday (CST) to 7 am Sunday (CDT) in Chicago is 8 real hours, though the clock shows 9
    const shift = [P('in', '2026-03-08T04:00:00Z'), P('out', '2026-03-08T12:00:00Z')];
    assert.deepEqual(dayMinutes(t.timesheet(shift, CHI, null, 40)), { '2026-03-07': 120, '2026-03-08': 360 });
    assert.equal(t.localDate('2026-03-08T05:59:59Z', CHI), '2026-03-07');
    assert.equal(t.localDate('2026-03-08T06:00:00Z', CHI), '2026-03-08');
    assert.equal(t.localDate('2026-03-09T04:59:59Z', CHI), '2026-03-08'); // a 23-hour day
    assert.equal(t.localDate('2026-03-09T05:00:00Z', CHI), '2026-03-09');
    const allDay = [P('in', '2026-03-08T06:00:00Z'), P('out', '2026-03-09T05:00:00Z')];
    assert.deepEqual(dayMinutes(t.timesheet(allDay, CHI, null, 40)), { '2026-03-08': 23 * 60 });
    // Arizona does not change its clocks: nothing special there
    assert.deepEqual(dayMinutes(t.timesheet([P('in', '2026-03-08T05:00:00Z'), P('out', '2026-03-08T13:00:00Z')], 'America/Phoenix', null, 40)), { '2026-03-07': 120, '2026-03-08': 360 });
});

test('several days in a row are split exactly at each local midnight', () => {
    // clocked in Friday 6 pm Chicago, out Monday 6 am: 61 hours over four days, across the clocks going back
    const long = [P('in', '2026-10-30T23:00:00Z'), P('out', '2026-11-02T12:00:00Z')];
    assert.deepEqual(dayMinutes(t.timesheet(long, CHI, null, null)), { '2026-10-30': 360, '2026-10-31': 1440, '2026-11-01': 1500, '2026-11-02': 360 });
    // a zone the computer does not know still gives an answer (UTC days)
    assert.deepEqual(dayMinutes(t.timesheet([P('in', '2026-11-09T23:00:00Z'), P('out', '2026-11-10T01:00:00Z')], 'Mars/Olympus_Mons', null, null)), { '2026-11-09': 60, '2026-11-10': 60 });
});

test('a forgotten clock-out is judged on real hours, in any zone and across a clock change', () => {
    // in at 8 pm Saturday Oct 31 (CDT). 16 real hours later is 11 am Sunday on the wall clock, not noon.
    const open = [P('in', '2026-11-01T01:00:00Z')];
    assert.equal(t.isForgottenClockOut(open, '2026-11-01T16:59:00Z'), false);
    assert.equal(t.isForgottenClockOut(open, '2026-11-01T17:01:00Z'), true);
    // the same rule for a person in another state: it does not depend on whose midnight has passed
    assert.equal(t.isForgottenClockOut([P('in', '2026-11-10T06:00:00Z')], '2026-11-10T21:59:00Z'), false);
    assert.equal(t.isForgottenClockOut([P('in', '2026-11-10T06:00:00Z')], '2026-11-10T22:01:00Z'), true);
    assert.equal(t.isForgottenClockOut([P('in', '2026-11-10T06:00:00Z'), P('break_start', '2026-11-10T08:00:00Z')], '2026-11-11T00:00:00Z'), true);
});

test('a time typed on a correction is read in the person\'s zone', () => {
    assert.equal(t.zonedToUtcIso('2026-11-09', '08:30', LA), '2026-11-09T16:30:00.000Z');
    assert.equal(t.zonedToUtcIso('2026-11-09', '08:30', NY), '2026-11-09T13:30:00.000Z');
    assert.equal(t.zonedToUtcIso('2026-11-09', '23:45', LA), '2026-11-10T07:45:00.000Z');
    assert.equal(t.localDate(t.zonedToUtcIso('2026-11-09', '23:45', LA), LA), '2026-11-09');
    assert.equal(t.localDate(t.zonedToUtcIso('2026-11-09', '23:45', LA), NY), '2026-11-10'); // why the saved day must use the person's zone
    // the day the clocks go back, 1:30 am happens twice; either reading is on Nov 1
    assert.equal(t.localDate(t.zonedToUtcIso('2026-11-01', '01:30', CHI), CHI), '2026-11-01');
    assert.equal(t.zonedToUtcIso('2026-11-01', '00:00', CHI), '2026-11-01T05:00:00.000Z');
    assert.equal(t.zonedToUtcIso('2026-11-02', '00:00', CHI), '2026-11-02T06:00:00.000Z');
});
