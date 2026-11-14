import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../services/comp-due-rules.js');

const rec = (over = {}) => ({ id: 'r1', orgId: 'o1', userId: 'u1', status: 'approved', applied: false, effectiveDate: '2026-11-10', createdAt: 't1', ...over });

test('a change is due on its effective date and after, never before', () => {
    assert.equal(D.isDue(rec(), '2026-11-09'), false);
    assert.equal(D.isDue(rec(), '2026-11-10'), true);
    assert.equal(D.isDue(rec(), '2026-12-01'), true);
});

test('only approved changes that were not applied yet are due', () => {
    assert.equal(D.isDue(rec({ status: 'pending_approval' }), '2026-12-01'), false);
    assert.equal(D.isDue(rec({ status: 'rejected' }), '2026-12-01'), false);
    assert.equal(D.isDue(rec({ status: 'cancelled' }), '2026-12-01'), false);
    assert.equal(D.isDue(rec({ applied: true }), '2026-12-01'), false);
    assert.equal(D.isDue(rec({ status: undefined }), '2026-12-01'), true, 'older records without a status count as approved');
});

test('a bad date on either side is never due', () => {
    assert.equal(D.isDue(rec({ effectiveDate: '' }), '2026-12-01'), false);
    assert.equal(D.isDue(rec({ effectiveDate: '11/10/2026' }), '2026-12-01'), false);
    assert.equal(D.isDue(rec(), ''), false);
    assert.equal(D.isDue(rec(), undefined), false);
    assert.equal(D.isDue(null, '2026-12-01'), false);
});

test('due records come oldest first, same day in the order they were entered', () => {
    const list = [rec({ id: 'c', effectiveDate: '2026-11-10', createdAt: 't2' }), rec({ id: 'a', effectiveDate: '2026-11-01' }), rec({ id: 'b', effectiveDate: '2026-11-10', createdAt: 't1' }), rec({ id: 'x', effectiveDate: '2027-01-01' })];
    assert.deepEqual(D.dueRecords(list, '2026-11-12').map((r) => r.id), ['a', 'b', 'c']);
    assert.deepEqual(D.dueRecords(null, '2026-11-12'), []);
});

test('due people groups the due records by person', () => {
    const list = [rec({ id: 'a' }), rec({ id: 'b', userId: 'u2' }), rec({ id: 'c', effectiveDate: '2026-11-11' }), rec({ id: 'd', userId: 'u3', effectiveDate: '2027-01-01' }), rec({ id: 'e', userId: '' })];
    assert.deepEqual(D.duePeople(list, '2026-11-12'), [{ userId: 'u1', recordIds: ['a', 'c'] }, { userId: 'u2', recordIds: ['b'] }]);
});

test('each company is judged by its own day', () => {
    const list = [rec({ id: 'a', orgId: 'west', effectiveDate: '2026-11-12' }), rec({ id: 'b', orgId: 'east', effectiveDate: '2026-11-12' })];
    // late evening on the 11th in the west, already the 12th in the east
    const work = D.workByCompany(list, { west: '2026-11-11', east: '2026-11-12' });
    assert.deepEqual(work, [{ orgId: 'east', today: '2026-11-12', people: [{ userId: 'u1', recordIds: ['b'] }] }]);
});

test('a company whose day is unknown is skipped, and records without a company are ignored', () => {
    const list = [rec({ orgId: 'o1' }), rec({ orgId: 'o2' }), rec({ orgId: undefined }), null];
    assert.deepEqual(D.workByCompany(list, { o1: '2026-11-12' }).map((w) => w.orgId), ['o1']);
    assert.deepEqual(D.workByCompany(list, {}), []);
    assert.deepEqual(D.workByCompany(null, null), []);
});

test('running it again after applying finds nothing (safe to repeat)', () => {
    const list = [rec({ id: 'a' }), rec({ id: 'b', userId: 'u2' })];
    const first = D.workByCompany(list, { o1: '2026-11-12' });
    assert.equal(first[0].people.length, 2);
    const ids = new Set(first[0].people.flatMap((p) => p.recordIds));
    const after = list.map((r) => (ids.has(r.id) ? { ...r, applied: true } : r));
    assert.deepEqual(D.workByCompany(after, { o1: '2026-11-12' }), []);
});

test('companies waiting lists every company with an approved change not yet applied', () => {
    const list = [rec({ orgId: 'a', effectiveDate: '2030-01-01' }), rec({ orgId: 'b', applied: true }), rec({ orgId: 'c', status: 'pending_approval' }), rec({ orgId: 'a' }), rec({ orgId: 'd' })];
    assert.deepEqual(D.companiesWaiting(list).sort(), ['a', 'd']);
});
