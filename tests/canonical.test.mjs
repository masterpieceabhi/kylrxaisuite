import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../services/canonical.js');

const user = {
    id: 'u1', uid: 'u1', orgId: 'o1', employeeId: 'EMP0001', name: 'Ada Lovelace', email: 'ada@example.com', phone: '555-0100',
    role: 'employee', status: 'Active', jobTitle: 'Engineer', departmentName: 'Engineering', joiningDate: '2025-02-03',
    password: '$2b$hash', createdAt: '2025-02-01T10:00:00.000Z',
    usProfile: {
        legalFirstName: 'Ada', legalLastName: 'Lovelace', workState: 'TX', classification: 'W2', employmentType: 'full_time', flsaStatus: 'exempt',
        payType: 'salary', payRate: 120000, payFrequency: 'biweekly', managerId: 'm1', startDate: '2025-02-03',
        taxpayerIdEncrypted: 'v1:abc', taxpayerIdLast4: '1234', dateOfBirth: '1990-01-01', homeAddress: { line1: '1 Main' },
        bank: { routing: '1', account: '2' }, medicalNotes: 'x', eeoRace: 'x', updatedAt: '2025-03-01T00:00:00.000Z'
    }
};

test('person has no sensitive fields, with or without pay scope', () => {
    for (const includePay of [false, true]) {
        const p = C.toPerson(user, { includePay });
        assert.deepEqual(C.findForbiddenKeys(p), []);
        const text = JSON.stringify(p);
        assert.ok(!/1234|\$2b\$|v1:abc|1990-01-01|1 Main/.test(text));
    }
});

test('pay fields only with pay scope', () => {
    assert.equal(C.toPerson(user).compensation, undefined);
    assert.equal(C.toPerson(user, { includePay: true }).compensation.pay_rate, 120000);
    assert.equal(C.toJob(user).compensation, undefined);
    assert.equal(C.toJob(user, { includePay: true }).compensation.pay_type, 'salary');
});

test('person mapping', () => {
    const p = C.toPerson(user);
    assert.equal(p.id, 'u1');
    assert.equal(p.status, 'active');
    assert.equal(p.hire_date, '2025-02-03');
    assert.equal(p.job.org_unit_id, 'ou_engineering');
    assert.equal(p.job.location_id, 'loc_tx');
    assert.equal(p.job.manager_id, 'm1');
    assert.equal(p.updated_at, '2025-03-01T00:00:00.000Z');
    assert.equal(C.toPerson({ ...user, status: 'Terminated' }).status, 'terminated');
});

test('stripForbidden removes sensitive keys deeply', () => {
    const out = C.stripForbidden({ a: 1, ssn: 'x', nested: { bankAccount: 1, ok: 2 }, list: [{ taxpayerId: 1, v: 3 }] });
    assert.deepEqual(out, { a: 1, nested: { ok: 2 }, list: [{ v: 3 }] });
});

test('org units and locations derive from people and docs', () => {
    const units = C.buildOrgUnits([{ departmentName: 'Sales', departmentCode: 'SAL' }], [user, { ...user, id: 'u2' }, { ...user, id: 'u3', status: 'Terminated' }]);
    assert.deepEqual(units.map((u) => [u.id, u.headcount]), [['ou_engineering', 2], ['ou_sales', 0]]);
    const locs = C.buildLocations([], [user], { usProfile: { businessAddress: { line1: '9 Elm', city: 'Austin', state: 'TX', zip: '73301' }, timezone: 'America/Chicago' } });
    assert.equal(locs.find((l) => l.id === 'loc_hq').address.city, 'Austin');
    assert.equal(locs.find((l) => l.id === 'loc_tx').headcount, 1);
});

test('daily hours from punches subtract breaks and ignore open shifts', () => {
    const at = (t) => `2026-11-09T${t}:00.000Z`;
    const punches = [
        { type: 'in', at: at('09:00'), localDate: '2026-11-09' }, { type: 'break_start', at: at('12:00'), localDate: '2026-11-09' },
        { type: 'break_end', at: at('12:30'), localDate: '2026-11-09' }, { type: 'out', at: at('17:30'), localDate: '2026-11-09' },
        { type: 'in', at: '2026-11-10T09:00:00.000Z', localDate: '2026-11-10' }
    ];
    const days = C.dailyFromPunches(punches);
    assert.equal(days.length, 1);
    assert.equal(days[0].workedHours, 8);
    assert.equal(days[0].breakMinutes, 30);
    const e = C.toDailyTimeEntry('u1', 'EMP0001', days[0]);
    assert.equal(e.id, 'u1_2026-11-09');
});

test('weekly time entry and leave request hide free text', () => {
    const w = C.toWeeklyTimeEntry({ id: 'u1_2026-11-02', userId: 'u1', weekStart: '2026-11-02', status: 'approved', totals: { workedHours: 42, regularHours: 40, overtimeHours: 2, doubleTimeHours: 0 }, decidedAt: '2026-11-10T00:00:00Z' }, { employeeId: 'EMP0001' });
    assert.equal(w.end_date, '2026-11-08');
    assert.equal(w.hours.overtime, 2);
    const l = C.toLeaveRequest({ id: 'l1', userId: 'u1', reason: 'chemo appointment', hours: 8, status: 'approved', startDate: '2026-11-12', endDate: '2026-11-12', createdAt: '2026-11-01T00:00:00Z' });
    assert.ok(!JSON.stringify(l).includes('chemo'));
});

test('documents: metadata only and confidential/medical hidden', () => {
    assert.equal(C.isDocumentVisible({ category: 'medical_confidential' }), false);
    assert.equal(C.isDocumentVisible({ category: 'offer_letter', confidential: true }), false);
    assert.equal(C.isDocumentVisible({ category: 'offer_letter' }), true);
    const m = C.toDocumentMeta({ id: 'd1', category: 'offer_letter', fileName: 'a.pdf', mime: 'application/pdf', size: 10, sha256: 'abc', uploadedAt: '2026-01-01T00:00:00Z', buffer: 'BYTES', url: 'http://x' });
    assert.ok(!('buffer' in m) && !('url' in m) && !JSON.stringify(m).includes('BYTES'));
});

test('inbound patch validation', () => {
    const ok = C.personPatchFromCanonical({ first_name: 'A', job: { title: 'PM', manager_id: 'm2' }, status: 'terminated', termination_date: '2026-01-02' });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.patch.jobTitle, 'PM');
    assert.equal(ok.patch.status, 'terminated');
    const bad = C.personPatchFromCanonical({ work_email: 'nope', status: 'fired', hire_date: '2026-13-40' });
    assert.equal(bad.errors.length, 3);
});

test('pay result mapping (placeholder)', () => {
    const r = C.toPayResult({ id: 'p1', userId: 'u1', periodStart: '2026-11-01', periodEnd: '2026-11-15', payDate: '2026-11-20', gross: 1000, net: 800, createdAt: '2026-11-16T00:00:00Z' });
    assert.equal(r.pay_period.start, '2026-11-01');
    assert.equal(r.gross, 1000);
});
