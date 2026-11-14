// The schedule follows the company's workweek (which may start on any day), not a fixed Monday.
// Pure rules (services/schedule-rules.js) and the week routes (routes/us-schedule.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { startServer, seedCompanies } from './helpers/permission-harness.mjs';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const S = require('../services/schedule-rules.js');
const T = require('../services/time-rules.js');
const router = require('../routes/us-schedule.js');
const TZ = 'America/Chicago';

const SUNDAY = [{ startDay: 0, effectiveFrom: null }];
// Monday weeks until Wednesday 2026-11-18, then Wednesday weeks: the week of Mon 11-16 is cut to two days
const CHANGE = [{ startDay: 1, effectiveFrom: null }, { startDay: 3, effectiveFrom: '2026-11-18' }];
const mk = (over = {}) => {
    const w = S.shiftWindow(over.date || '2026-11-09', over.startTime || '08:00', over.endTime || '16:00', TZ, over.breakMinutes ?? 0);
    return { id: over.id || 's1', userId: 'u1', status: 'published', date: '2026-11-09', startTime: '08:00', endTime: '16:00', ...w, ...over };
};

/* ------------------------------------------- pure ------------------------------------------- */

test('without a workweek setting, and with the Monday default, everything is as before', () => {
    for (const ww of [undefined, null, T.DEFAULT_WORKWEEK, T.normalizeWorkweek(undefined)]) {
        for (const [d, monday] of [['2026-11-09', '2026-11-09'], ['2026-11-11', '2026-11-09'], ['2026-11-15', '2026-11-09'], ['2026-11-16', '2026-11-16'], ['2027-01-01', '2026-12-28']]) assert.equal(S.weekStartOf(d, ww), monday, `${d}`);
        assert.deepEqual(S.weekDates('2026-11-09', ww), ['2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15']);
    }
    const shifts = ['09', '10', '11', '12', '13', '15', '16'].map((d, i) => mk({ id: `x${i}`, date: `2026-11-${d}` }));
    assert.equal(S.weeklyHours('2026-11-09', shifts), 48); assert.equal(S.weeklyHours('2026-11-09', shifts, T.DEFAULT_WORKWEEK), 48);
    assert.equal(S.projectedWeekHours('2026-11-09', shifts, { '2026-11-09': 10 }, '2026-11-10'), 10 + 40);
    assert.equal(S.projectedWeekHours('2026-11-09', shifts, { '2026-11-09': 10 }, '2026-11-10', T.DEFAULT_WORKWEEK), 10 + 40);
});

test('a Sunday company: the week of a date, its days, and the hours counted in it', () => {
    assert.equal(S.weekStartOf('2026-11-14', SUNDAY), '2026-11-08');
    assert.equal(S.weekStartOf('2026-11-15', SUNDAY), '2026-11-15', 'Sunday opens the next week');
    assert.equal(S.weekStartOf('2026-11-09', SUNDAY), '2026-11-08');
    assert.deepEqual(S.weekDates('2026-11-08', SUNDAY), ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14']);
    // Sun 8 .. Sat 14 is one week; Sun 15 belongs to the next one
    const shifts = ['08', '09', '10', '11', '12', '15'].map((d, i) => mk({ id: `x${i}`, date: `2026-11-${d}` }));
    assert.equal(S.weeklyHours('2026-11-08', shifts, SUNDAY), 40);
    assert.equal(S.weeklyHours('2026-11-15', shifts, SUNDAY), 8);
    assert.equal(S.projectedWeekHours('2026-11-08', shifts, { '2026-11-08': 9, '2026-11-09': 9 }, '2026-11-10', SUNDAY), 9 + 9 + 24);
});

test('the overtime warning counts the company\'s week, not Monday to Sunday', () => {
    // 40 hours Mon 9 .. Fri 13, and a new 8-hour shift on Sunday 15
    const others = ['09', '10', '11', '12', '13'].map((d, i) => mk({ id: `x${i}`, date: `2026-11-${d}` }));
    const sunday = mk({ id: 'new', date: '2026-11-15' });
    const codes = (ww) => S.conflictsFor({ shift: sunday, others, leaves: [], tz: TZ, workweek: ww }).map((c) => c.code);
    assert.ok(codes(undefined).includes('overtime_risk'), 'Monday weeks: Sunday is the 6th day of the same week (48 hours)');
    assert.ok(codes(T.DEFAULT_WORKWEEK).includes('overtime_risk'));
    assert.ok(!codes(SUNDAY).includes('overtime_risk'), 'Sunday weeks: that Sunday starts a new week (8 hours)');
    // and the other way round: Sunday 8 plus Mon..Fri is 48 hours only for a Sunday company
    const early = mk({ id: 'new', date: '2026-11-08' });
    const codes2 = (ww) => S.conflictsFor({ shift: early, others, leaves: [], tz: TZ, workweek: ww }).map((c) => c.code);
    assert.ok(codes2(SUNDAY).includes('overtime_risk')); assert.ok(!codes2(undefined).includes('overtime_risk'));
});

test('the one week cut short by a change of start day has fewer days', () => {
    assert.equal(S.weekStartOf('2026-11-17', CHANGE), '2026-11-16');
    assert.deepEqual(S.weekDates('2026-11-16', CHANGE), ['2026-11-16', '2026-11-17'], 'Monday and Tuesday only');
    assert.equal(S.weekStartOf('2026-11-18', CHANGE), '2026-11-18');
    assert.equal(S.weekDates('2026-11-18', CHANGE).length, 7);
    assert.equal(S.weekDates('2026-11-09', CHANGE).length, 7, 'weeks before the change keep their shape');
    const shifts = ['16', '17', '18', '19'].map((d, i) => mk({ id: `x${i}`, date: `2026-11-${d}` }));
    assert.equal(S.weeklyHours('2026-11-16', shifts, CHANGE), 16);
    assert.equal(S.weeklyHours('2026-11-18', shifts, CHANGE), 16);
});

/* ------------------------------------------- live ------------------------------------------- */

let srv;
test.before(async () => { srv = await startServer(router); });
test.after(async () => { await srv.stop(); });
const setWorkweek = (orgId, workweek) => db.collection('organizations').doc(orgId).set({ usProfile: { timeRules: { workweek } } }, { merge: true });
const shiftBody = (userId, date) => ({ userId, date, startTime: '09:00', endTime: '17:00', breakMinutes: 0 });

test('live: a Monday company is asked for Mondays, exactly as before', async () => {
    await seedCompanies(db, mem);
    const { call } = srv;
    const bad = await call('GET', '/schedule/week?weekStart=2026-11-10', 'hr_adminA');
    assert.equal(bad.status, 400); assert.equal(bad.body.error, 'weekStart must be a Monday (YYYY-MM-DD)');
    assert.equal((await call('GET', '/schedule/week?weekStart=nonsense', 'hr_adminA')).body.error, 'weekStart must be a Monday (YYYY-MM-DD)');
    assert.equal((await call('POST', '/schedule/publish', 'hr_adminA', { weekStart: '2026-11-08' })).body.error, 'weekStart must be a Monday (YYYY-MM-DD)');
    assert.equal((await call('POST', '/schedule/copy', 'hr_adminA', { fromWeek: '2026-11-08', toWeek: '2026-11-16' })).body.error, 'fromWeek and toWeek must be different Mondays');
    assert.equal((await call('POST', '/schedule/copy', 'hr_adminA', { fromWeek: '2026-11-09', toWeek: '2026-11-09' })).status, 400);

    const made = await call('POST', '/schedule/shifts', 'hr_adminA', shiftBody('workerA', '2026-11-15'));
    assert.equal(made.status, 201, made.text); assert.equal(made.body.shift.weekStart, '2026-11-09', 'Sunday belongs to the week of Monday the 9th');
    const week = await call('GET', '/schedule/week?weekStart=2026-11-09', 'hr_adminA');
    assert.equal(week.status, 200, week.text);
    assert.deepEqual([week.body.weekStart, week.body.weekEnd, week.body.weekDays, week.body.workweekStartDay, week.body.prevWeekStart, week.body.nextWeekStart], ['2026-11-09', '2026-11-15', 7, 1, '2026-11-02', '2026-11-16']);
    assert.equal(week.body.shifts.length, 1);
    assert.equal((await call('GET', '/schedule/week?weekStart=2026-11-16', 'hr_adminA')).body.shifts.length, 0);
    const now = await call('GET', '/schedule/week?weekStart=current', 'hr_adminA');
    assert.equal(now.status, 200); assert.equal(T.weekdayOf(now.body.weekStart), 1); assert.ok(now.body.weekStart <= now.body.today && now.body.today <= now.body.weekEnd);
});

test('live: a Sunday company plans, copies and publishes Sunday-to-Saturday weeks', async () => {
    await seedCompanies(db, mem);
    await setWorkweek('orgA', SUNDAY);
    const { call } = srv;
    const bad = await call('GET', '/schedule/week?weekStart=2026-11-09', 'hr_adminA');
    assert.equal(bad.status, 400); assert.equal(bad.body.error, 'weekStart must be a Sunday (YYYY-MM-DD)');
    assert.equal((await call('POST', '/schedule/publish', 'hr_adminA', { weekStart: '2026-11-09' })).body.error, 'weekStart must be a Sunday (YYYY-MM-DD)');
    assert.equal((await call('POST', '/schedule/copy', 'hr_adminA', { fromWeek: '2026-11-09', toWeek: '2026-11-16' })).body.error, 'fromWeek and toWeek must be different Sundays');

    const sun = await call('POST', '/schedule/shifts', 'hr_adminA', shiftBody('workerA', '2026-11-08'));
    const sat = await call('POST', '/schedule/shifts', 'hr_adminA', shiftBody('workerA', '2026-11-14'));
    const next = await call('POST', '/schedule/shifts', 'hr_adminA', shiftBody('workerA', '2026-11-15'));
    assert.deepEqual([sun.body.shift.weekStart, sat.body.shift.weekStart, next.body.shift.weekStart], ['2026-11-08', '2026-11-08', '2026-11-15']);
    // a shift saved earlier with a Monday week on it still shows in the week its date falls in
    await db.collection('schedule_shifts').add({ ...sat.body.shift, id: undefined, userId: 'employeeA', weekStart: '2026-11-09', date: '2026-11-13' });

    const week = await call('GET', '/schedule/week?weekStart=2026-11-08', 'hr_adminA');
    assert.equal(week.status, 200, week.text);
    assert.deepEqual([week.body.weekEnd, week.body.weekDays, week.body.workweekStartDay, week.body.prevWeekStart, week.body.nextWeekStart], ['2026-11-14', 7, 0, '2026-11-01', '2026-11-15']);
    assert.deepEqual(week.body.shifts.map((s) => s.date).sort(), ['2026-11-08', '2026-11-13', '2026-11-14']);
    assert.equal(week.body.staff.find((p) => p.userId === 'workerA').scheduledHours, 16);
    assert.equal((await call('GET', '/schedule/week?weekStart=2026-11-15', 'hr_adminA')).body.shifts.length, 1);
    const now = await call('GET', '/schedule/week?weekStart=current', 'hr_adminA');
    assert.equal(T.weekdayOf(now.body.weekStart), 0, '"current" is the Sunday week running now');

    const pub = await call('POST', '/schedule/publish', 'hr_adminA', { weekStart: '2026-11-08' });
    assert.equal(pub.status, 200, pub.text); assert.equal(pub.body.published, 3);
    const copy = await call('POST', '/schedule/copy', 'hr_adminA', { fromWeek: '2026-11-08', toWeek: '2026-11-22' });
    assert.equal(copy.status, 201, copy.text); assert.equal(copy.body.created, 3);
    assert.deepEqual((await call('GET', '/schedule/week?weekStart=2026-11-22', 'hr_adminA')).body.shifts.map((s) => s.date).sort(), ['2026-11-22', '2026-11-27', '2026-11-28']);
    // the other company is still on Mondays
    assert.equal((await call('GET', '/schedule/week?weekStart=2026-11-09', 'hrB')).status, 200);
});

test('live: at a change of start day the short week is its own week, and a copy does not spill into the next one', async () => {
    await seedCompanies(db, mem);
    await setWorkweek('orgA', CHANGE);
    const { call } = srv;
    for (const d of ['2026-11-09', '2026-11-12']) assert.equal((await call('POST', '/schedule/shifts', 'hr_adminA', shiftBody('workerA', d))).status, 201);
    const short = await call('GET', '/schedule/week?weekStart=2026-11-16', 'hr_adminA');
    assert.deepEqual([short.body.weekEnd, short.body.weekDays, short.body.prevWeekStart, short.body.nextWeekStart], ['2026-11-17', 2, '2026-11-09', '2026-11-18']);
    assert.equal((await call('GET', '/schedule/week?weekStart=2026-11-18', 'hr_adminA')).body.workweekStartDay, 3);
    assert.equal((await call('GET', '/schedule/week?weekStart=2026-11-23', 'hr_adminA')).body.error, 'weekStart must be a Wednesday (YYYY-MM-DD)');
    const copy = await call('POST', '/schedule/copy', 'hr_adminA', { fromWeek: '2026-11-09', toWeek: '2026-11-16' });
    assert.equal(copy.status, 201, copy.text);
    assert.equal(copy.body.created, 1, 'Monday is copied'); assert.equal(copy.body.skipped.length, 1, 'Thursday is past the end of the short week');
    assert.deepEqual((await call('GET', '/schedule/week?weekStart=2026-11-18', 'hr_adminA')).body.shifts, []);
});

/* ------------------------------------------- page ------------------------------------------- */

test('the schedule page asks the server for the week instead of working out a Monday', () => {
    const html = fs.readFileSync(new URL('../admin-us-schedule.html', import.meta.url), 'utf8');
    assert.equal(/mondayOf|getDay\(\) \+ 6/.test(html), false, 'no Monday arithmetic left');
    assert.ok(html.includes("let weekStart = 'current'"));
    for (const field of ['week.weekStart', 'week.weekDays', 'week.prevWeekStart', 'week.nextWeekStart']) assert.ok(html.includes(field), field);
});
