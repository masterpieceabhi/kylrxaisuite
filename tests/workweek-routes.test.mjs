// Tips and the timesheet report follow the company's workweek instead of assuming Monday
// (routes/us-tips.js, routes/us-reports.js, routes/api-v1.js).
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
const T = require('../services/time-rules.js');
const tips = require('../routes/us-tips.js');
const reports = require('../routes/us-reports.js');

const SUNDAY = [{ startDay: 0, effectiveFrom: null }];
const CHANGE = [{ startDay: 1, effectiveFrom: null }, { startDay: 3, effectiveFrom: '2026-11-18' }];
const setWorkweek = (orgId, workweek) => db.collection('organizations').doc(orgId).set({ usProfile: { timeRules: { workweek } } }, { merge: true });
const today = () => T.localDate(new Date().toISOString(), 'America/Chicago');

let srv;
test.before(async () => { srv = await startServer(tips, reports); });
test.after(async () => { await srv.stop(); });

test('tip credit check: a Monday company is asked for a Monday and gets Monday to Sunday, as before', async () => {
    await seedCompanies(db, mem);
    const { call } = srv;
    const bad = await call('GET', '/tips/credit-check?weekStart=2026-11-10', 'hr_adminA');
    assert.equal(bad.status, 400); assert.equal(bad.body.error, 'weekStart must be a Monday (YYYY-MM-DD)');
    for (const v of ['nonsense', '2026-02-30', '2026-11-08']) assert.equal((await call('GET', `/tips/credit-check?weekStart=${v}`, 'hr_adminA')).body.error, 'weekStart must be a Monday (YYYY-MM-DD)', v);
    const ok = await call('GET', '/tips/credit-check?weekStart=2026-11-09', 'hr_adminA');
    assert.equal(ok.status, 200, ok.text); assert.deepEqual([ok.body.weekStart, ok.body.weekEnd], ['2026-11-09', '2026-11-15']);
    const now = await call('GET', '/tips/credit-check', 'hr_adminA');
    assert.equal(now.body.weekStart, T.weekStart(today())); assert.equal(now.body.weekEnd, T.addDaysIso(now.body.weekStart, 6));
    const rep = await call('GET', '/tips/report', 'hr_adminA');
    assert.equal(rep.status, 200, rep.text); assert.deepEqual([rep.body.from, rep.body.to], [now.body.weekStart, now.body.weekEnd]);
});

test('tip credit check: a Sunday company uses Sunday to Saturday; the changeover week is short', async () => {
    await seedCompanies(db, mem);
    await setWorkweek('orgA', SUNDAY);
    const { call } = srv;
    assert.equal((await call('GET', '/tips/credit-check?weekStart=2026-11-09', 'hr_adminA')).body.error, 'weekStart must be a Sunday (YYYY-MM-DD)');
    const ok = await call('GET', '/tips/credit-check?weekStart=2026-11-08', 'hr_adminA');
    assert.equal(ok.status, 200, ok.text); assert.deepEqual([ok.body.weekStart, ok.body.weekEnd], ['2026-11-08', '2026-11-14']);
    const now = await call('GET', '/tips/credit-check', 'hr_adminA');
    assert.equal(T.weekdayOf(now.body.weekStart), 0); assert.equal(now.body.weekStart, T.weekStartFor(today(), SUNDAY));
    const rep = await call('GET', '/tips/report', 'hr_adminA');
    assert.deepEqual([rep.body.from, rep.body.to], [now.body.weekStart, T.addDaysIso(now.body.weekStart, 6)]);
    assert.equal((await call('GET', '/tips/credit-check?weekStart=2026-11-09', 'hrB')).status, 200, 'the other company is still on Mondays');

    await setWorkweek('orgA', CHANGE);
    const short = await call('GET', '/tips/credit-check?weekStart=2026-11-16', 'hr_adminA');
    assert.deepEqual([short.body.weekStart, short.body.weekEnd], ['2026-11-16', '2026-11-17']);
    assert.equal((await call('GET', '/tips/credit-check?weekStart=2026-11-23', 'hr_adminA')).body.error, 'weekStart must be a Wednesday (YYYY-MM-DD)');
    assert.equal((await call('GET', '/tips/credit-check?weekStart=2026-11-18', 'hr_adminA')).body.weekEnd, '2026-11-24');
});

test('a tip pool split by hours takes approved weeks from the company\'s week that holds the first day', async () => {
    await seedCompanies(db, mem);
    const { call } = srv;
    const pool = await db.collection('tip_pools').add({ orgId: 'orgA', name: 'Floor', shareMethod: 'hours', active: true, participants: [{ userId: 'workerA', name: 'Ada' }, { userId: 'employeeA', name: 'Eve' }] });
    // approved weeks that start on Sunday 2026-11-08; the pool period starts on Tuesday the 10th
    for (const [id, h] of [['workerA', 30], ['employeeA', 10]]) await db.collection('timesheet_weeks').doc(`${id}_2026-11-08`).set({ orgId: 'orgA', userId: id, weekStart: '2026-11-08', weekEnd: '2026-11-14', status: 'approved', totals: { workedHours: h } });
    const body = { amount: 100, from: '2026-11-10', to: '2026-11-14' };
    const monday = await call('POST', `/tips/pools/${pool.id}/distribute`, 'hr_adminA', body);
    await setWorkweek('orgA', SUNDAY);
    const sunday = await call('POST', `/tips/pools/${pool.id}/distribute`, 'hr_adminA', body);
    // under Monday weeks the range starts at Monday the 9th, so the week that starts on Sunday the 8th is not in it
    assert.equal(monday.status, 400, monday.text); assert.deepEqual(monday.body.errors, ['no hours recorded for the participants']);
    // the Sunday company finds the hours of its own week
    assert.equal(sunday.status, 201, sunday.text);
    const share = Object.fromEntries(sunday.body.distribution.shares.map((s) => [s.userId, s.amount]));
    assert.deepEqual([share.workerA, share.employeeA], [75, 25], 'split 30 : 10 by the hours of the week of Sunday the 8th');
});

test('timesheet report: the oldest week shown is the company\'s week that holds the first day of the range', async () => {
    await seedCompanies(db, mem);
    await setWorkweek('orgA', SUNDAY);
    const { call } = srv;
    const since = T.addDaysIso(today(), -7);
    const boundary = T.weekStartFor(since, SUNDAY);
    const add = (weekStart, userId) => db.collection('timesheet_weeks').doc(`${userId}_${weekStart}`).set({ orgId: 'orgA', userId, weekStart, weekEnd: T.addDaysIso(weekStart, 6), status: 'approved', totals: { workedHours: 40 } });
    await add(boundary, 'workerA'); await add(T.addDaysIso(boundary, -7), 'workerA'); await add(T.addDaysIso(boundary, 7), 'workerA');
    const r = await call('GET', '/reports/time?weeks=1', 'hr_adminA');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.weeks, 2, 'the week that holds the first day and the one after it; not the week before');
    // a Monday company with the same range, as before
    await add(T.weekStart(since), 'workerB'); await add(T.addDaysIso(T.weekStart(since), -7), 'workerB');
    await db.collection('timesheet_weeks').doc(`workerB_${T.weekStart(since)}`).set({ orgId: 'orgB' }, { merge: true });
    await db.collection('timesheet_weeks').doc(`workerB_${T.addDaysIso(T.weekStart(since), -7)}`).set({ orgId: 'orgB' }, { merge: true });
    assert.equal((await call('GET', '/reports/time?weeks=1', 'hrB')).body.weeks, 1);
});

test('no fixed-Monday week arithmetic is left in these routes', () => {
    for (const file of ['us-tips.js', 'us-reports.js', 'api-v1.js', 'us-schedule.js']) {
        const src = fs.readFileSync(new URL(`../routes/${file}`, import.meta.url), 'utf8');
        assert.equal(/timeRules\.weekStart\(/.test(src), false, `${file} still calls timeRules.weekStart( (Monday only)`);
        assert.equal(/must be a Monday|different Mondays/.test(src), false, `${file} still says Monday`);
        assert.ok(/workweek/.test(src), `${file} reads the company's workweek`);
    }
});

test('API daily time entries: a day counts when the company\'s week it falls in is approved', () => {
    // the rule the route applies (routes/api-v1.js timeList): approved week starts, looked up by time-rules.weekStartFor
    const approved = new Set(['2026-11-08']); // a Sunday company's approved week, Sun 8 .. Sat 14
    const counted = (date, workweek) => approved.has(T.weekStartFor(date, workweek));
    assert.deepEqual(['2026-11-08', '2026-11-11', '2026-11-14', '2026-11-15'].map((d) => counted(d, SUNDAY)), [true, true, true, false]);
    assert.deepEqual(['2026-11-08', '2026-11-11', '2026-11-14'].map((d) => counted(d, undefined)), [false, false, false], 'Monday arithmetic never finds a Sunday week');
    const mondays = new Set(['2026-11-09']);
    for (const d of ['2026-11-09', '2026-11-12', '2026-11-15']) assert.equal(mondays.has(T.weekStartFor(d, T.DEFAULT_WORKWEEK)), mondays.has(T.weekStart(d)), `Monday company unchanged for ${d}`);
});
