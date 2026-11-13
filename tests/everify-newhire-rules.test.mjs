import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const V = require('../services/everify-rules.js');
const N = require('../services/new-hire-rules.js');

test('E-Verify case due date is 3 business days after the hire date (editable)', () => {
    assert.equal(V.caseDueDate('2026-03-02'), '2026-03-05'); // Mon -> Thu
    assert.equal(V.caseDueDate('2026-03-05'), '2026-03-10'); // Thu -> Tue
    assert.equal(V.caseDueDate('2026-03-02', { createCaseBusinessDays: 5 }), '2026-03-09');
    assert.ok(V.validateSettings({ used: true, createCaseBusinessDays: 0 }).errors.length);
    assert.equal(V.validateSettings({ used: true }).value.tncDecisionBusinessDays, 8);
});

test('case validation', () => {
    assert.deepEqual(V.validateCase({ caseNumber: '2026060123ABC' }, '2026-03-02').errors, []);
    assert.ok(V.validateCase({ caseNumber: '12' }, '2026-03-02').errors.length);
    assert.ok(V.validateCase({ caseNumber: '123456', createdDate: '2026-04-01' }, '2026-03-02').errors.length);
});

test('status machine and TNC dates', () => {
    const c = { status: 'initial', history: [] };
    assert.ok(V.transition(c, 'referred', {}, null, '2026-03-02', 'n').error);
    const t = V.transition(c, 'tentative_nonconfirmation', {}, null, '2026-03-02', 'n');
    assert.equal(t.patch.tnc.decisionDue, '2026-03-12'); // 8 business days
    const tc = { ...c, ...t.patch };
    assert.ok(V.transition(tc, 'referred', { employeeDecision: 'no' }, null, '2026-03-03', 'n').error);
    const r = V.transition(tc, 'referred', { employeeDecision: 'contest' }, { tncReferralBusinessDays: 10 }, '2026-03-03', 'n');
    assert.equal(r.patch.tnc.referralDue, '2026-03-17');
    assert.ok(V.transition({ ...tc, status: 'closed' }, 'initial', {}, null, 'x', 'n').error);
    assert.equal(V.transition({ status: 'initial', history: [] }, 'employment_authorized', {}, null, '2026-03-02', 'n').patch.status, 'employment_authorized');
});

test('flags and missing cases', () => {
    assert.deepEqual(V.caseFlags({ status: 'tentative_nonconfirmation', tnc: { decisionDue: '2026-03-12' } }, '2026-03-13'), ['tnc_decision_overdue']);
    assert.ok(V.caseFlags({ status: 'final_nonconfirmation' }, '2026-03-13').includes('action_needed_final_nonconfirmation'));
    const m = V.missingCases([{ userId: 'a', name: 'A', hireDate: '2026-03-02' }, { userId: 'b', name: 'B', hireDate: '2026-03-02' }, { userId: 'c', name: 'C', hireDate: '2026-03-04' }], new Set(['b']), null, '2026-03-06');
    assert.deepEqual(m.map((x) => [x.userId, x.overdue]), [['a', true], ['c', false]]);
});

test('seed agencies are marked verify and cover the states', () => {
    const s = N.seedAgencies();
    assert.ok(s.length >= 50); assert.ok(s.every((a) => a.dueDays === 20 && a.verified === false && /Verify/i.test(a.portalNote)));
    assert.equal(N.seedAgencies(['TX']).length, 1);
});

test('agency validation', () => {
    assert.deepEqual(N.validateAgency({ state: 'tx', agencyName: 'TX OAG', dueDays: 20, portalUrl: 'https://example.gov' }).errors, []);
    assert.ok(N.validateAgency({ state: 'ZZ', agencyName: '', dueDays: 45, portalUrl: 'javascript:x' }).errors.length >= 4);
});

const person = (id, over = {}) => ({ id, data: { name: `P ${id}`, employeeId: id, status: 'Active', usProfile: { startDate: '2026-03-02', workState: 'TX', taxpayerIdLast4: '6789', taxpayerIdEncrypted: 'x' }, ...over } });

test('pending list: due dates, overdue, submitted and terminated excluded, state fallback', () => {
    const org = { usProfile: { workStates: ['CA'] } };
    const agencies = { TX: { dueDays: 7, agencyName: 'TX' } };
    const rows = N.pendingList([
        person('a'), person('b', { status: 'Terminated' }), person('c'), person('d', { usProfile: { startDate: '2026-02-20' } }), person('e', { usProfile: {}, joiningDate: '2025-01-01' })
    ], agencies, new Set(['c']), org, '2026-03-12', '2026-01-01');
    assert.deepEqual(rows.map((r) => r.userId), ['a', 'd']);
    const a = rows.find((r) => r.userId === 'a');
    assert.equal(a.dueDate, '2026-03-09'); assert.equal(a.overdue, true); assert.equal(a.ssnLast4, '6789'); assert.ok(!('taxpayerIdEncrypted' in a));
    const d = rows.find((r) => r.userId === 'd');
    assert.equal(d.state, 'CA'); assert.equal(d.dueDate, '2026-03-12'); assert.equal(d.agencyConfigured, false);
});

test('CSV: federal data elements, full SSN formatted, formulas neutralized', () => {
    const csv = N.buildCsv([{ user: { name: '=cmd Smith', usProfile: { startDate: '2026-03-02', workState: 'TX', legalFirstName: '=cmd', legalLastName: 'Smith', homeAddress: { line1: '1 Main', city: 'Austin', state: 'TX', zip: '78701' } } }, ssn: '123456789' }], { name: 'Demo Inc', usProfile: { ein: '12-3456789', businessAddress: { line1: '9 Biz', city: 'Dallas', state: 'TX', zip: '75001' } } });
    const [head, row] = csv.trim().split('\r\n');
    assert.ok(head.includes('Employee SSN')); assert.ok(head.includes('Employer FEIN'));
    assert.ok(row.includes('"123-45-6789"')); assert.ok(row.includes('"\'=cmd"')); assert.ok(row.includes('"12-3456789"')); assert.ok(row.includes('"2026-03-02"'));
    assert.equal(N.csvCell('a"b'), '"a""b"');
});

test('submission validation', () => {
    assert.deepEqual(N.validateSubmission({ userIds: ['a'], state: 'tx', confirmationNumber: 'ABC-123', submittedOn: '2026-03-02' }, '2026-03-03').errors, []);
    assert.equal(N.validateSubmission({ userIds: [], state: 'ZZ', confirmationNumber: 'x', submittedOn: '2026-04-01' }, '2026-03-03').errors.length, 4);
});
