// A person's copy of their data (the newer records) and paging of lists.
// What this does NOT cover: the routes that use them, and the export file itself (built by services/privacy-service.js
// generateExport, which needs the database).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-export-and-paging';
process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);

test('the privacy export holds the newer records, cut to what is about the person', () => {
    const svc = require('../services/privacy-service.js');
    const out = svc.moreForExport({
        weeks: [{ id: 'w1', orgId: 'o', userId: 'u1', weekStart: '2026-11-02', weekEnd: '2026-11-08', status: 'approved', decidedBy: 'mgr1', decisionNote: null, totals: { workedHours: 40 }, days: [{ date: '2026-11-02', regularHours: 8 }] }, { id: 'w2', weekStart: '2026-11-09', status: 'open' }],
        corrections: [{ id: 'c1', kind: 'add', type: 'out', localDate: '2026-11-03', reason: 'Forgot to clock out', status: 'approved', decidedBy: 'mgr1', createdAt: '2026-11-04T10:00:00Z' }],
        shifts: [{ id: 's1', date: '2026-11-10', startTime: '09:00', endTime: '17:00', status: 'published', createdBy: 'mgr1' }, { id: 's2', date: '2026-11-11', status: 'draft' }],
        adjustments: [{ id: 'a1', date: '2026-10-01', hours: 8, reason: 'Carried over', createdBy: 'hr1' }],
        payResults: [{ id: 'p1', orgId: 'o', userId: 'u1', payrollUuid: 'pay-1', payDate: '2026-11-13', periodStart: '2026-11-02', periodEnd: '2026-11-08', gross: 800, net: 640, employeeTaxes: 160, employerTaxes: 61.2, hours: 40, status: 'paid', source: 'gusto' }],
        compHistory: [{ id: 'h1', effectiveDate: '2026-06-01', payType: 'hourly', payRate: 20, reason: 'Raise', status: 'approved', createdBy: 'hr1', approvedBy: 'owner1' }],
        notices: [{ id: 'n1', orgId: 'o', userId: 'u1', type: 'leave_approved', title: 'Time off approved', message: 'Your time off was approved.', createdAt: '2026-11-01T00:00:00Z', read: true, madeBy: 'hr1' }]
    });
    assert.deepEqual(out.timesheetWeeks.map((w) => w.weekStart), ['2026-11-09', '2026-11-02'], 'newest first');
    assert.deepEqual(out.timesheetWeeks[1].totals, { workedHours: 40 });
    assert.equal(out.shifts.length, 1, 'a shift that was never published is not the person’s yet');
    assert.deepEqual(out.payResults[0], { payDate: '2026-11-13', periodStart: '2026-11-02', periodEnd: '2026-11-08', status: 'paid', gross: 800, net: 640, employeeTaxes: 160, hours: 40, source: 'gusto' });
    assert.deepEqual(out.payHistory[0], { effectiveDate: '2026-06-01', payType: 'hourly', payRate: 20, reason: 'Raise', status: 'approved' });
    const all = JSON.stringify(out);
    for (const hidden of ['mgr1', 'hr1', 'owner1', 'pay-1', 'employerTaxes', '"orgId"', '"userId"', '"id"']) assert.equal(all.includes(hidden), false, `${hidden} should not be in the export`);
    // nothing gathered: empty lists, not an error
    assert.deepEqual(Object.values(svc.moreForExport(undefined)).map((l) => l.length), [0, 0, 0, 0, 0, 0, 0]);
});

test('paging: a list answers as before without a limit, says when there is more, and steps through with the cursor', () => {
    const { pageFields } = require('../utils/paging.js');
    const rows = Array.from({ length: 23 }, (_, i) => ({ n: i + 1 }));
    const all = pageFields(rows, {}, 300);
    assert.deepEqual([all.data.length, all.limit, all.nextCursor], [23, 300, null], 'no limit: everything up to the old cap');
    const capped = pageFields(rows, {}, 10);
    assert.equal(capped.data.length, 10); assert.ok(capped.nextCursor, 'the old cap no longer drops the rest silently');
    const seen = []; let cursor; let pages = 0;
    do { const p = pageFields(rows, { limit: '10', cursor }, 300, (r) => r.n); seen.push(...p.data); cursor = p.nextCursor; pages += 1; } while (cursor && pages < 10);
    assert.deepEqual([pages, seen.length, seen[0], seen[22]], [3, 23, 1, 23]);
    assert.equal(pageFields(rows, { limit: '5000' }, 300).limit, 300, 'never more than the cap');
    assert.equal(pageFields(rows, { limit: '0' }, 300).data.length, 1);
    assert.equal(pageFields(rows, { limit: 'lots' }, 300).data.length, 23);
    for (const bad of ['%%%', 'x'.repeat(200), Buffer.from('o:-5').toString('base64url'), Buffer.from('drop table').toString('base64url'), ['a']]) assert.equal(pageFields(rows, { limit: '5', cursor: bad }, 300).data[0].n, 1, 'a cursor that is not ours starts from the top');
    assert.deepEqual(pageFields(rows, { limit: '5', cursor: Buffer.from('o:999999').toString('base64url') }, 300).data, []);
    assert.deepEqual(pageFields(null, {}, 10), { data: [], limit: 10, nextCursor: null });
});
