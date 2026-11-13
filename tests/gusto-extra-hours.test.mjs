import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../services/gusto/rules.js');

const people = [{ id: 'u1', name: 'Ana', payType: 'hourly', flsa: 'nonexempt', active: true }, { id: 'u2', name: 'Ben', payType: 'salary', flsa: 'exempt', active: true }];
const links = { u1: { gustoUuid: 'g1', meta: { jobUuid: 'j1' } }, u2: { gustoUuid: 'g2', meta: { jobUuid: 'j2' } } };
const wk = (userId, weekStart, totals) => ({ userId, weekStart, status: 'approved', totals: { regularHours: 0, overtimeHours: 0, doubleTimeHours: 0, ...totals } });
const feedFor = (weeks) => R.buildHoursFeed({ weeks, people, links, periodStart: '2026-11-09', periodEnd: '2026-11-22' });

test('paid holiday hours and missed-break premium hours are carried in the feed', () => {
    const feed = feedFor([wk('u1', '2026-11-09', { regularHours: 32, holidayHours: 8, premiumHours: 1 }), wk('u1', '2026-11-16', { regularHours: 40, overtimeHours: 2 }), wk('u2', '2026-11-09', { regularHours: 40, holidayHours: 8 })]);
    const ana = feed.rows.find((r) => r.userId === 'u1');
    assert.deepEqual([ana.regularHours, ana.overtimeHours, ana.holidayHours, ana.premiumHours], [72, 2, 8, 1]);
    assert.deepEqual([feed.totals.holidayHours, feed.totals.premiumHours], [8, 1]);
    // the salaried person is paid a salary: no hours and no holiday hours are sent
    assert.equal(feed.rows.find((r) => r.userId === 'u2'), undefined);
    const note = feed.issues.find((i) => i.code === 'extra_hours_as_regular');
    assert.equal(note.severity, 'warning');
    assert.match(note.message, /8 paid holiday hour\(s\) and 1 premium hour\(s\)/);
    assert.equal(feed.ready, true);
});

test('they go to Gusto inside regular hours, at the regular rate', () => {
    const feed = feedFor([wk('u1', '2026-11-09', { regularHours: 32, holidayHours: 8, premiumHours: 1.5 }), wk('u1', '2026-11-16', { regularHours: 40, overtimeHours: 2 })]);
    const comps = R.toGustoCompensations(feed.rows, [{ employee_uuid: 'g1', hourly_compensations: [{ job_uuid: 'j1' }] }]);
    const byName = Object.fromEntries(comps[0].hourly_compensations.map((h) => [h.name, h]));
    assert.equal(Number(byName['Regular Hours'].hours), 81.5);
    assert.equal(byName['Regular Hours'].compensation_multiplier, 1);
    assert.equal(Number(byName.Overtime.hours), 2);
});

test('a feed without holiday or premium hours is unchanged, and adding them changes the fingerprint', () => {
    const plain = feedFor([wk('u1', '2026-11-09', { regularHours: 40 }), wk('u1', '2026-11-16', { regularHours: 40 })]);
    assert.deepEqual([plain.totals.holidayHours, plain.totals.premiumHours], [0, 0]);
    assert.equal(plain.issues.some((i) => i.code === 'extra_hours_as_regular'), false);
    const comps = R.toGustoCompensations(plain.rows, [{ employee_uuid: 'g1', hourly_compensations: [{ job_uuid: 'j1' }] }]);
    assert.equal(Number(comps[0].hourly_compensations[0].hours), 80);
    // rows written before this change have no holiday fields: their fingerprint must not move
    const legacy = plain.rows.map(({ holidayHours, premiumHours, ...rest }) => rest);
    assert.equal(R.feedHash(legacy), R.feedHash(plain.rows));
    const withHoliday = feedFor([wk('u1', '2026-11-09', { regularHours: 40, holidayHours: 8 }), wk('u1', '2026-11-16', { regularHours: 40 })]);
    assert.notEqual(R.feedHash(withHoliday.rows), R.feedHash(plain.rows));
});
