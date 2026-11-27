import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../services/us-reports.js');

const person = (id, over = {}) => R.normalizePerson(id, {
    employeeId: `EMP${id}`, name: `Person ${id}`, departmentName: 'Ops', status: 'Active',
    usProfile: { startDate: '2025-01-15', classification: 'W2', employmentType: 'full_time', workState: 'TX', flsaStatus: 'non_exempt', payType: 'hourly', payRate: 20, taxpayerIdLast4: '1234', ...(over.profile || {}) },
    ...(over.doc || {})
});
const left = (id, lastDay, type, start = '2025-01-15') => person(id, { profile: { startDate: start, termination: { lastDay, type, rehireEligible: true } } });

test('people become employment periods, a rehire has two', () => {
    const p = R.normalizePerson('x', { employeeId: 'E1', usProfile: { startDate: '2026-06-01', termination: null }, employmentHistory: [{ startDate: '2024-01-01', endDate: '2025-03-31', type: 'resignation' }] });
    assert.equal(p.periods.length, 2);
    assert.equal(R.isActiveOn(p, '2024-06-01'), true);
    assert.equal(R.isActiveOn(p, '2025-09-01'), false); // gap between jobs
    assert.equal(R.isActiveOn(p, '2026-06-01'), true);
    assert.equal(R.normalizePerson('y', { usProfile: {} }).startDate, null);
});

test('a person counts through their last day and not after', () => {
    const p = left('1', '2026-03-10', 'resignation');
    assert.equal(R.isActiveOn(p, '2026-03-10'), true);
    assert.equal(R.isActiveOn(p, '2026-03-11'), false);
    assert.equal(R.isActiveOn(p, '2024-12-31'), false); // before the start date
});

test('headcount report: totals, breakdowns, tenure buckets and a month-end trend', () => {
    const people = [person('1'), person('2', { profile: { startDate: '2026-10-01', workState: 'CA', classification: '1099' } }), left('3', '2026-06-30', 'layoff')];
    const h = R.headcountReport(people, '2026-11-10', 6);
    assert.equal(h.total, 2);
    assert.deepEqual(h.byWorkerType.map((x) => x.key).sort(), ['1099', 'W2']);
    assert.equal(h.byState.length, 2);
    assert.equal(h.trend.length, 6);
    assert.equal(h.trend[h.trend.length - 1].date, '2026-11-10'); // current month ends today
    assert.equal(h.trend.find((t) => t.month === '2026-06').headcount, 2); // person 1 plus person 3, who left on Jun 30 (still counted that day); person 2 starts in October
    assert.equal(h.trend.find((t) => t.month === '2026-07').headcount, 1);
    assert.deepEqual(h.tenure.map((t) => t.key), ['Under 90 days', '1 to 3 years']);
});

test('turnover: rate, annualized rate, voluntary vs involuntary, short tenure', () => {
    const people = [person('1'), person('2'), person('3'), left('4', '2026-02-10', 'resignation'), left('5', '2026-03-15', 'termination_for_cause', '2026-01-20'), left('6', '2026-04-01', 'end_of_contract')];
    const t = R.turnoverReport(people, '2026-01-01', '2026-06-30');
    assert.equal(t.separations, 3);
    // On Jan 1: persons 1, 2, 3, 4 and 6 (person 5 starts Jan 20); on Jun 30: persons 1, 2, 3
    assert.equal(t.startHeadcount, 5); assert.equal(t.endHeadcount, 3); assert.equal(t.averageHeadcount, 4);
    assert.equal(t.ratePercent, 75);
    assert.ok(t.annualizedPercent > 150 && t.annualizedPercent < 153); // 75 * 365/181
    assert.deepEqual(Object.fromEntries(t.byCategory.map((c) => [c.key, c.count])), { Voluntary: 1, Involuntary: 1, Other: 1 });
    assert.equal(t.under90Days, 1);
    assert.equal(t.list[0].lastDay, '2026-04-01');
    assert.equal(R.separationCategory('retirement'), 'Voluntary');
    assert.equal(R.turnoverReport([], '2026-01-01', '2026-06-30').ratePercent, 0);
});

test('hourly cost: hourly rate, salary spread over 2080 hours, missing rate', () => {
    assert.equal(R.hourlyRate(person('1')), 20);
    assert.equal(R.hourlyRate(person('2', { profile: { payType: 'salary', payRate: 62400 } })), 30);
    assert.equal(R.hourlyRate(person('3', { profile: { payRate: null } })), null);
});

test('labor report: regular, overtime and double time costed; salaried exempt staff costed weekly; no rate flagged', () => {
    const people = new Map([['a', person('a')], ['b', person('b', { profile: { payType: 'salary', payRate: 52000, flsaStatus: 'exempt' } })], ['c', person('c', { profile: { payRate: null } })]]);
    const weeks = [
        { userId: 'a', weekStart: '2026-11-02', totals: { regularHours: 40, overtimeHours: 5, doubleTimeHours: 2, workedHours: 47 }, exempt: false },
        { userId: 'b', weekStart: '2026-11-02', totals: { regularHours: 50, overtimeHours: 0, doubleTimeHours: 0, workedHours: 50 }, exempt: true },
        { userId: 'c', weekStart: '2026-11-02', totals: { regularHours: 10, overtimeHours: 0, doubleTimeHours: 0, workedHours: 10 }, exempt: false }
    ];
    const r = R.laborReport(weeks, people);
    const a = r.byPerson.find((x) => x.userId === 'a');
    assert.equal(a.estimatedCost, 40 * 20 + 5 * 20 * 1.5 + 2 * 20 * 2); // 800 + 150 + 80 = 1030
    assert.equal(a.overtimeCost, 230);
    assert.equal(r.byPerson.find((x) => x.userId === 'b').estimatedCost, 1000); // 52000 / 52
    assert.equal(r.rowsWithoutRate, 1);
    assert.equal(r.totals.workedHours, 107); assert.equal(r.totals.overtimeHours, 7);
    assert.equal(r.totals.overtimeSharePercent, 6.5);
    assert.equal(r.byPerson[0].userId, 'a'); // most overtime first
    assert.equal(r.byWeek.length, 1);
    assert.equal(R.laborReport(weeks, people, { overtimeMultiplier: 2 }).byPerson.find((x) => x.userId === 'a').estimatedCost, 40 * 20 + 5 * 40 + 2 * 40);
});

test('leave liability values balances at each hourly rate and reports payout-required amounts', () => {
    const people = new Map([['a', person('a')], ['b', person('b', { profile: { payRate: null } })]]);
    const rows = [{ userId: 'a', policy: 'PTO', type: 'pto', balanceHours: 10, payoutRequired: true }, { userId: 'a', policy: 'Sick', type: 'sick', balanceHours: 20, payoutRequired: false }, { userId: 'b', policy: 'PTO', type: 'pto', balanceHours: 8, payoutRequired: true }];
    const r = R.leaveLiabilityReport(rows, people);
    assert.equal(r.totals.hours, 38); assert.equal(r.totals.estimatedValue, 600); assert.equal(r.totals.payoutRequiredValue, 200);
    assert.equal(r.byPolicy.find((p) => p.policy === 'PTO').withoutRate, 1);
    assert.equal(r.detail[0].estimatedValue, 400);
});

test('compliance report lists missing paperwork, expiring I-9s and purgeable old I-9s', () => {
    const asOf = '2026-11-10';
    const bare = R.normalizePerson('1', { employeeId: 'E1', name: 'Bare', usProfile: { startDate: '2026-10-01' } });
    const full = R.normalizePerson('2', { employeeId: 'E2', name: 'Full', usForms: { w4: { current: {} }, i9: { section1: { workAuthorizationExpires: '2026-12-15' }, section2: {} }, directDeposit: {} },
        usProfile: { startDate: '2025-02-01', classification: 'W2', workState: 'TX', payRate: 20, taxpayerIdLast4: '1111' } });
    const gone = R.normalizePerson('3', { employeeId: 'E3', name: 'Gone', usForms: { i9: { section1: {}, section2: {} } }, usProfile: { startDate: '2020-01-01', termination: { lastDay: '2021-02-01', type: 'resignation' } } });
    const r = R.complianceReport([bare, full, gone], asOf);
    const by = Object.fromEntries(r.list.map((x) => [x.employeeId, x.issues]));
    assert.ok(by.E1.includes('no_taxpayer_id') && by.E1.includes('w4_missing') && by.E1.includes('i9_section1_missing') && by.E1.includes('no_direct_deposit'));
    assert.deepEqual(by.E2, ['i9_reverification_due']);
    assert.deepEqual(by.E3, ['i9_purge_ok']);
    assert.equal(r.peopleChecked, 2); assert.equal(r.peopleWithIssues, 3);
    assert.ok(r.counts[0].count >= 1 && r.counts[0].label);
});

test('time report: backlog, stale approvals, flags and corrections', () => {
    const weeks = [
        { userId: 'a', status: 'submitted', submittedAt: '2026-11-03T10:00:00Z', weekStart: '2026-10-26', flags: ['missed_meal_break'] },
        { userId: 'b', status: 'approved', submittedAt: '2026-11-03T10:00:00Z', decidedAt: '2026-11-03T16:00:00Z', weekStart: '2026-10-26', flags: [] },
        { userId: 'c', status: 'submitted', submittedAt: '2026-11-09T10:00:00Z', weekStart: '2026-11-02', flags: [] }
    ];
    const t = R.timeReport(weeks, [{ status: 'pending', kind: 'change' }, { status: 'approved', kind: 'add' }, { status: 'approved', kind: 'change' }], '2026-11-10');
    assert.equal(t.waitingMoreThan3Days.length, 1); assert.equal(t.waitingMoreThan3Days[0].waitingDays, 7);
    assert.equal(t.averageHoursToApprove, 6);
    assert.deepEqual(t.flags, [{ key: 'missed_meal_break', count: 1 }]);
    assert.equal(t.corrections.find((c) => c.key === 'approved').count, 2);
});

test('CSV quoting', () => {
    const csv = R.toCsv([{ key: 'a', label: 'Name' }, { key: 'b', label: 'Note' }], [{ a: 'Lopez, Maria', b: 'said "hi"' }, { a: 'Ann', b: null }]);
    assert.equal(csv, 'Name,Note\n"Lopez, Maria","said ""hi"""\nAnn,\n');
});

test('I-9 audit: on time, late, missing, expiring and former employees', () => {
    // 2025-01-15 is a Wednesday: Section 1 is due that day, Section 2 by Tue 2025-01-21 (Monday the 20th is a federal holiday)
    const i9 = (s1, s2, extra1 = {}, extra2 = {}) => ({ doc: { usForms: { i9: { ...(s1 ? { section1: { signedAt: `${s1}T15:00:00.000Z`, ...extra1 } } : {}), ...(s2 ? { section2: { examinedOn: s2, ...extra2 } } : {}) } } } });
    const people = [
        person(1, i9('2025-01-15', '2025-01-17')),
        person(2, i9('2025-01-16', '2025-02-10')),
        person(3, i9(null, null)),
        person(4, i9('2025-01-15', '2025-01-16', { workAuthorizationExpires: '2026-12-15' })),
        person(5, { profile: { startDate: '2021-03-01', termination: { lastDay: '2022-06-30', type: 'resignation', rehireEligible: true } }, ...i9('2021-03-01', '2021-03-02') }),
        person(6, { profile: { classification: '1099' } })
    ];
    const r = R.i9AuditReport(people, '2026-11-11');
    const by = Object.fromEntries(r.list.map((x) => [x.id, x]));
    assert.equal(r.total, 5, 'the contractor is left out');
    assert.deepEqual(by[1].findings, []);
    assert.deepEqual(by[2].findings, ['Section 1 completed late', 'Section 2 completed late']);
    assert.deepEqual(by[3].findings, ['Section 1 missing and overdue', 'Section 2 missing and overdue']);
    assert.equal(by[3].needsAction, true);
    assert.deepEqual(by[4].findings, ['Work authorization expires within 90 days']);
    assert.equal(by[4].reverifyOn, '2026-12-15');
    assert.equal(by[5].status, 'former');
    assert.equal(by[5].keepUntil, '2024-03-01', 'three years after hire is later than one year after leaving');
    assert.deepEqual(by[5].findings, ['Retention period has passed: the form may be disposed of']);
    assert.equal(r.list[0].id, 3, 'people who need action come first');
    assert.equal(r.current, 4); assert.equal(r.former, 1); assert.equal(r.complete, 3); assert.equal(r.needsAction, 1); assert.equal(r.late, 1); assert.equal(r.canDispose, 1);
});
