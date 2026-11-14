// The hours sent to the payroll provider follow the company's workweek: a week is "inside the pay period" by its own
// first and last day (a saved week carries its last day; the week cut short by a workweek change is shorter than 7 days).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../services/gusto/rules.js');
const T = require('../services/time-rules.js');

const people = [{ id: 'u1', name: 'Ana', payType: 'hourly', flsa: 'nonexempt', active: true }];
const links = { u1: { gustoUuid: 'g1', meta: { jobUuid: 'j1' } } };
const wk = (weekStart, regularHours, extra = {}) => ({ userId: 'u1', weekStart, status: 'approved', totals: { regularHours, overtimeHours: 0, doubleTimeHours: 0 }, ...extra });
const feed = (weeks, periodStart, periodEnd, workweek) => R.buildHoursFeed({ weeks, people, links, periodStart, periodEnd, workweek });
const hoursOf = (f) => (f.rows.find((r) => r.userId === 'u1') || {}).regularHours;
const codes = (f) => f.issues.map((i) => i.code);

const SUNDAY = [{ startDay: 0, effectiveFrom: null }];
// Monday weeks, then Wednesday weeks from 2026-11-18: the week of Mon 11-16 is only Mon and Tue
const CHANGE = [{ startDay: 1, effectiveFrom: null }, { startDay: 3, effectiveFrom: '2026-11-18' }];

test('weekPlacement: 7 days by default, the stored last day when the week has one', () => {
    assert.equal(R.weekPlacement('2026-11-09', '2026-11-09', '2026-11-15'), 'inside');
    assert.equal(R.weekPlacement('2026-11-09', '2026-11-09', '2026-11-14'), 'partial');
    assert.equal(R.weekPlacement('2026-11-09', '2026-11-16', '2026-11-22'), 'outside');
    assert.equal(R.weekPlacement('2026-11-09', '2026-11-15', '2026-11-22'), 'partial');
    // a two-day week (Mon 16, Tue 17) inside a period that ends on Tuesday
    assert.equal(R.weekPlacement('2026-11-16', '2026-11-09', '2026-11-17'), 'partial', 'assumed 7 days: it would stick out');
    assert.equal(R.weekPlacement('2026-11-16', '2026-11-09', '2026-11-17', '2026-11-17'), 'inside', 'its stored last day is used');
    assert.equal(R.weekPlacement('2026-11-16', '2026-11-18', '2026-11-24', '2026-11-17'), 'outside', 'and it ends before the next period starts');
    assert.equal(R.weekPlacement('2026-11-16', '2026-11-18', '2026-11-24'), 'partial');
    // a stored value that is not a usable date is ignored
    for (const bad of [null, undefined, '', 'soon', '2026-11-01']) assert.equal(R.weekPlacement('2026-11-09', '2026-11-09', '2026-11-15', bad), 'inside', String(bad));
});

test('a Monday company gets the same feed with no setting, with the default setting, and with stored 7-day week ends', () => {
    const weeks = [wk('2026-11-09', 40), wk('2026-11-16', 38)];
    const plain = feed(weeks, '2026-11-09', '2026-11-22');
    assert.equal(hoursOf(plain), 78); assert.equal(plain.ready, true); assert.ok(!codes(plain).includes('partial_week'));
    assert.deepEqual(feed(weeks, '2026-11-09', '2026-11-22', T.DEFAULT_WORKWEEK), plain);
    assert.deepEqual(feed(weeks, '2026-11-09', '2026-11-22', T.normalizeWorkweek(null)), plain);
    const withEnds = [wk('2026-11-09', 40, { weekEnd: '2026-11-15' }), wk('2026-11-16', 38, { weekEnd: '2026-11-22' })];
    assert.deepEqual(feed(withEnds, '2026-11-09', '2026-11-22').rows, plain.rows);
    // a period that cuts a Monday week: the same warning text as before
    const cut = feed(weeks, '2026-11-11', '2026-11-22');
    const warn = cut.issues.find((i) => i.code === 'partial_week');
    assert.match(warn.message, /^The week starting 2026-11-09 is only partly inside this pay period\./);
    assert.match(warn.message, /Align the pay period to Monday to Sunday weeks, or add those hours by hand in Gusto\.$/);
    assert.equal(hoursOf(cut), 38);
});

test('a Sunday company: Sunday-to-Saturday weeks fill a Sunday-to-Saturday pay period', () => {
    const weeks = [wk('2026-11-08', 40, { weekEnd: '2026-11-14' }), wk('2026-11-15', 36, { weekEnd: '2026-11-21' })];
    const f = feed(weeks, '2026-11-08', '2026-11-21', SUNDAY);
    assert.equal(hoursOf(f), 76); assert.equal(f.ready, true);
    assert.deepEqual(codes(f).filter((c) => ['partial_week', 'no_hours', 'missing_weeks'].includes(c)), []);
    // with Monday weeks assumed, the same period looks cut at both ends and the Sunday weeks are never found
    const assumed = feed(weeks, '2026-11-08', '2026-11-21');
    assert.ok(codes(assumed).includes('partial_week')); assert.notEqual(hoursOf(assumed), 76);
    // a Monday-to-Sunday period for a Sunday company is the one that is cut, and the text does not say "Monday to Sunday"
    const cut = feed(weeks, '2026-11-09', '2026-11-22', SUNDAY);
    assert.match(cut.issues.find((i) => i.code === 'partial_week').message, /Align the pay period to your workweeks/);
    assert.equal(hoursOf(cut), 36, 'only the week of Sunday the 15th lies inside');
});

test('the changeover week (shorter than 7 days) is counted in the period it lies in', () => {
    const weeks = [wk('2026-11-09', 40, { weekEnd: '2026-11-15' }), wk('2026-11-16', 16, { weekEnd: '2026-11-17' }), wk('2026-11-18', 40, { weekEnd: '2026-11-24' })];
    // a period ending on the last day of the short week
    const before = feed(weeks, '2026-11-09', '2026-11-17', CHANGE);
    assert.equal(hoursOf(before), 56, '40 + the 16 hours of the two-day week'); assert.ok(!codes(before).includes('partial_week'));
    // the next period starts with the first Wednesday week
    const after = feed(weeks, '2026-11-18', '2026-11-24', CHANGE);
    assert.equal(hoursOf(after), 40); assert.ok(!codes(after).includes('partial_week'));
    // every hour is sent exactly once across the two periods
    assert.equal(hoursOf(before) + hoursOf(after), 96);
    // the stored last day is enough even when the setting is not passed
    const stored = feed(weeks, '2026-11-09', '2026-11-17');
    assert.equal(hoursOf(stored), 56); assert.ok(!codes(stored).includes('partial_week'));
    // a missing short week is reported by its own first day
    const missing = feed([weeks[0], weeks[2]], '2026-11-09', '2026-11-17', CHANGE);
    assert.match(missing.issues.find((i) => i.code === 'missing_weeks').message, /2026-11-16/);
});
