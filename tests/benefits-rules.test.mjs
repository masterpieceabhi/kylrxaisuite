import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = require('../services/benefits-rules.js');

const plan = (o) => { const r = B.validatePlan(o); assert.deepEqual(r.errors, [], JSON.stringify(o)); return { id: 'p_' + o.name, ...r.value }; };
const medical = plan({ name: 'PPO', type: 'medical', planYear: 2026, costs: { employee_only: { employee: 100, employer: 300 }, employee_spouse: { employee: 250, employer: 400 }, employee_children: { employee: 200, employer: 380 }, family: { employee: 350, employer: 500 } }, eligibility: { waitingDays: 30, minWeeklyHours: 30 } });
const k401 = plan({ name: '401k', type: '401k', planYear: 2026, match: { tiers: [{ upToPercent: 3, rate: 100 }, { upToPercent: 5, rate: 50 }] }, allowRoth: true });
const hsa = plan({ name: 'HSA', type: 'hsa', planYear: 2026, employerContributionAnnual: 520 });

test('plan validation', () => {
    assert.ok(B.validatePlan({}).errors.length >= 3);
    assert.ok(B.validatePlan({ name: 'x1', type: 'medical', planYear: 2026 }).errors.some((e) => /tier/.test(e)));
    assert.ok(B.validatePlan({ name: 'M', type: '401k', planYear: 2026, match: { tiers: [{ upToPercent: 5, rate: 50 }, { upToPercent: 3, rate: 100 }] } }).errors.length);
    assert.equal(medical.preTax, true); assert.equal(plan({ name: 'Life', type: 'life', planYear: 2026, costs: { employee_only: { employee: 5 } } }).preTax, false);
});
test('eligibility: waiting period, W2 only, hours, employment type', () => {
    const p = { classification: 'W2', employmentType: 'full_time', hireDate: '2026-03-02', weeklyHours: 40 };
    assert.deepEqual(B.eligibility(medical, p, '2026-04-01').eligible, true);
    assert.equal(B.eligibility(medical, p, '2026-03-15').eligible, false);
    assert.equal(B.eligibility(medical, p, '2026-03-15').eligibleOn, '2026-04-01');
    assert.equal(B.eligibility(medical, { ...p, classification: '1099' }, '2026-06-01').eligible, false);
    assert.equal(B.eligibility(medical, { ...p, weeklyHours: 20 }, '2026-06-01').eligible, false);
    assert.equal(B.eligibility(medical, { ...p, weeklyHours: null }, '2026-06-01').hoursVerified, false);
    const fom = plan({ name: 'Dental', type: 'dental', planYear: 2026, costs: { employee_only: { employee: 10 } }, eligibility: { waitingDays: 30, firstOfMonthAfterWaiting: true, employmentTypes: ['full_time'] } });
    assert.equal(B.eligibility(fom, { ...p, hireDate: '2026-03-05' }, '2026-06-01').eligibleOn, '2026-05-01');
    assert.equal(B.eligibility(fom, { ...p, employmentType: 'part_time' }, '2026-06-01').eligible, false);
});
test('windows: open enrollment, new hire, life event (30 days)', () => {
    const settings = { ...B.DEFAULT_SETTINGS, openEnrollment: { planYear: '2027', start: '2026-11-01', end: '2026-11-15', effectiveDate: '2027-01-01' } };
    assert.equal(B.openWindows(settings, { hireDate: '2020-01-01' }, [], '2026-11-10', '2020-01-01')[0].type, 'open_enrollment');
    assert.equal(B.openWindows(settings, { hireDate: '2020-01-01' }, [], '2026-11-20', '2020-01-01').length, 0);
    const nh = B.openWindows(settings, { hireDate: '2026-11-02' }, [], '2026-11-10', '2026-12-01').filter((x) => x.type === 'new_hire');
    assert.equal(nh[0].type, 'new_hire'); assert.equal(nh[0].end, '2026-12-31'); assert.equal(nh[0].effectiveDate, '2026-12-01');
    const ev = B.lifeEventDates(B.DEFAULT_LIFE_EVENTS[0], '2026-05-10');
    assert.equal(ev.windowEnd, '2026-06-09');
    const w = B.openWindows(settings, { hireDate: '2020-01-01' }, [{ id: 'e1', status: 'approved', typeKey: 'marriage', eventDate: '2026-05-10', windowEnd: ev.windowEnd, effectiveDate: ev.effectiveDate }], '2026-06-09', '2020-01-01');
    assert.equal(w[0].type, 'life_event');
    assert.equal(B.openWindows(settings, { hireDate: '2020-01-01' }, [{ id: 'e1', status: 'pending', eventDate: '2026-05-10', windowEnd: ev.windowEnd }], '2026-05-20', '2020-01-01').length, 0);
    assert.equal(B.lifeEventDates({ windowDays: 30, effective: 'first_of_next_month' }, '2026-05-10').effectiveDate, '2026-06-01');
});
test('life event request validation', () => {
    assert.ok(B.validateLifeEventRequest({ typeKey: 'x', eventDate: '2026-05-10' }, B.DEFAULT_LIFE_EVENTS, '2026-05-12').errors.length);
    assert.ok(B.validateLifeEventRequest({ typeKey: 'marriage', eventDate: '2026-01-10' }, B.DEFAULT_LIFE_EVENTS, '2026-05-12').errors.some((e) => /ended/.test(e)));
    assert.deepEqual(B.validateLifeEventRequest({ typeKey: 'marriage', eventDate: '2026-05-01' }, B.DEFAULT_LIFE_EVENTS, '2026-05-12').errors, []);
});
test('election rules: tier needs matching dependents; ssn handled; waiver needs reason', () => {
    const spouse = { firstName: 'A', lastName: 'B', relationship: 'spouse', dateOfBirth: '1990-01-01', ssn: '123-45-6789' };
    const kid = { firstName: 'C', lastName: 'B', relationship: 'child', dateOfBirth: '2018-01-01' };
    assert.ok(B.validateElection({ tier: 'family', dependents: [spouse] }, medical, { today: '2026-05-01' }).errors.length);
    const ok = B.validateElection({ tier: 'family', dependents: [spouse, kid] }, medical, { today: '2026-05-01' });
    assert.deepEqual(ok.errors, []); assert.equal(ok.value.dependents[0].ssnPlain, '123456789');
    assert.ok(B.validateElection({ tier: 'employee_only', dependents: [kid] }, medical, { today: '2026-05-01' }).errors.length);
    assert.ok(B.validateElection({ tier: 'employee_spouse', dependents: [{ ...spouse, ssn: '12' }] }, medical, { today: '2026-05-01' }).errors.length);
    assert.ok(B.validateElection({ waived: true }, medical).errors.length);
    assert.equal(B.validateElection({ waived: true, waiveReason: 'On spouse plan' }, medical).value.waived, true);
    assert.ok(B.validateElection({ deferralPercent: 80 }, k401).errors.length);
    assert.ok(B.validateElection({ deferralPercent: 6, contributionType: 'roth' }, { ...k401, allowRoth: false }).errors.length);
    const limits = [{ key: 'hsa_self_only', year: '2026', amount: 1000 }];
    assert.ok(B.validateElection({ annualAmount: 1500 }, hsa, { limits }).errors.length);
    assert.deepEqual(B.validateElection({ annualAmount: 900 }, hsa, { limits }).errors, []);
});
test('401k match formula', () => {
    const t = k401.match.tiers;
    assert.equal(B.matchPercent(t, 2), 2); assert.equal(B.matchPercent(t, 3), 3); assert.equal(B.matchPercent(t, 5), 4); assert.equal(B.matchPercent(t, 10), 4); assert.equal(B.matchPercent([], 5), 0);
});
test('deductions per pay period convert frequency, handle caps and tax treatment', () => {
    const person = { payFrequency: 'biweekly', payType: 'salary', payRate: 78000 };
    assert.equal(B.estimateGrossPerPeriod(person), 3000);
    assert.equal(B.estimateGrossPerPeriod({ payFrequency: 'weekly', payType: 'hourly', payRate: 20 }), 800);
    const m = B.deductionLine(medical, { tier: 'family' }, person, {});
    assert.equal(m.employeeAmount, 350); assert.equal(m.employerAmount, 500); assert.equal(m.taxTreatment, 'pre_tax');
    const monthly = B.deductionLine(medical, { tier: 'family' }, { ...person, payFrequency: 'monthly' }, {});
    assert.equal(monthly.employeeAmount, 758.33);
    const k = B.deductionLine(k401, { deferralPercent: 5, contributionType: 'pre_tax' }, person, { grossPerPeriod: 3000 });
    assert.equal(k.employeeAmount, 150); assert.equal(k.employerAmount, 120);
    const roth = B.deductionLine(k401, { deferralPercent: 5, contributionType: 'roth' }, person, { grossPerPeriod: 3000 });
    assert.equal(roth.taxTreatment, 'roth');
    const capped = B.deductionLine(k401, { deferralPercent: 50 }, person, { grossPerPeriod: 3000, limits: [{ key: '401k_employee_deferral', year: '2026', amount: 26000 }] });
    assert.equal(capped.employeeAmount, 1000); assert.equal(capped.capped, true);
    assert.equal(B.deductionLine(k401, { deferralPercent: 50 }, person, { grossPerPeriod: 3000, limits: B.DEFAULT_LIMITS }).employeeAmount, 1500);
    const h = B.deductionLine(hsa, { annualAmount: 2600 }, person, {});
    assert.equal(h.employeeAmount, 100); assert.equal(h.employerAmount, 20);
    const life = plan({ name: 'Life', type: 'life', planYear: 2026, costs: { employee_only: { employee: 4, employer: 0 } } });
    assert.equal(B.deductionLine(life, { tier: 'employee_only' }, person, {}).taxTreatment, 'post_tax');
});
test('payroll feed uses enrollments active on the period end and writes csv', () => {
    const people = { u1: { employeeId: 'E1', name: 'Ann, Lee', payFrequency: 'biweekly', payType: 'salary', payRate: 78000 } };
    const enr = [{ userId: 'u1', status: 'active', effectiveDate: '2026-05-01', elections: [{ planId: medical.id, type: 'medical', tier: 'employee_only' }, { planId: k401.id, type: '401k', deferralPercent: 4 }, { planId: hsa.id, waived: true }] },
        { userId: 'u1', status: 'terminated', effectiveDate: '2026-01-01', endDate: '2026-04-30', elections: [{ planId: medical.id, tier: 'family' }] }];
    const f = B.payrollFeed(enr, [medical, k401, hsa], people, { periodEnd: '2026-06-12', limits: [] });
    assert.equal(f.rows.length, 2); assert.equal(f.totals.employeeDeduction, 220); assert.equal(f.totals.employerCost, 300 + 105);
    assert.equal(B.payrollFeed(enr, [medical, k401, hsa], people, { periodEnd: '2026-04-15', limits: [] }).rows.length, 0 + 1);
    assert.match(B.toCsv(B.FEED_HEADER, f.rows), /"Ann, Lee"/);
});
test('ACA average hours and full-time status', () => {
    const weeks = Array.from({ length: 10 }, (_, i) => ({ status: 'approved', weekStart: B.addDays('2026-01-05', i * 7), totals: { workedHours: i < 5 ? 32 : 28 } }));
    weeks.push({ status: 'submitted', weekStart: '2026-03-16', totals: { workedHours: 80 } });
    const r = B.acaAverage(weeks, '2026-01-01', '2026-03-31', 30);
    assert.equal(r.averageWeeklyHours, 30); assert.equal(r.fullTime, true); assert.equal(r.weeksCounted, 10);
    assert.equal(B.acaAverage(weeks, '2026-01-01', '2026-02-01', 30).fullTime, true);
    assert.equal(B.acaAverage(weeks, '2026-02-09', '2026-03-31', 30).fullTime, false);
    assert.equal(B.acaAverage([], '2026-01-01', '2026-03-31').fullTime, false);
});
test('1095-C style rows per month', () => {
    const weeks = [{ status: 'approved', weekStart: '2026-02-02', totals: { workedHours: 35 } }];
    const offer = B.validateOffer({ fromDate: '2026-03-01', offerCode: '1a', employeeShareMonthly: 120, safeHarborCode: '2f' });
    assert.deepEqual(offer.errors, []);
    const rows = B.acaMonthlyRows({ person: { employeeId: 'E1', name: 'Ann' }, year: 2026, aca: B.DEFAULT_SETTINGS.aca, weeks, measurement: { fullTime: true }, offers: [offer.value], enrolledMonths: [4, 5] });
    assert.equal(rows.length, 12); assert.equal(rows[1].offered, 'N'); assert.equal(rows[2].offered, 'Y'); assert.equal(rows[2].line14, '1A'); assert.equal(rows[3].enrolled, 'Y'); assert.equal(rows[1].hoursInMonth, 35);
    const monthly = B.acaMonthlyRows({ person: {}, year: 2026, aca: { ...B.DEFAULT_SETTINGS.aca, method: 'monthly' }, weeks: [{ status: 'approved', weekStart: '2026-02-02', totals: { workedHours: 140 } }], measurement: null, offers: [] });
    assert.equal(monthly[1].fullTime, 'Y'); assert.equal(monthly[0].fullTime, 'N');
    assert.ok(B.validateOffer({ fromDate: 'x' }).errors.length);
    assert.deepEqual(B.enrolledMonthsOf([{ status: 'terminated', effectiveDate: '2026-02-10', endDate: '2026-04-05', elections: [{ type: 'medical' }] }], 2026), [2, 3, 4]);
});
test('COBRA deadlines and lifecycle', () => {
    const cfg = B.DEFAULT_COBRA;
    const v = B.validateCobraEvent({ eventType: 'termination', eventDate: '2026-06-30' }, cfg);
    assert.deepEqual(v.errors, []);
    let rec = { ...v.value, status: 'pending_notice' };
    const d = B.cobraDeadlines(rec, cfg);
    assert.equal(d.employerNoticeDue, '2026-07-30'); assert.equal(d.electionNoticeDue, '2026-08-13'); assert.equal(d.electionDeadline, '2026-10-12'); assert.equal(d.maxCoverageEnd, '2027-12-29');
    assert.deepEqual(B.cobraAlerts(rec, cfg, '2026-08-01'), ['Notice to the administrator is overdue']);
    const step = (a, p) => { const r = B.applyCobraAction(rec, a, p, cfg, '2026-08-01'); assert.deepEqual(r.errors, [], a); rec = { ...rec, ...r.patch }; };
    step('notice_to_administrator', { date: '2026-07-20' });
    assert.equal(B.cobraDeadlines(rec, cfg).electionNoticeDue, '2026-08-03');
    step('send_election_notice', { date: '2026-08-02' });
    assert.equal(B.cobraDeadlines(rec, cfg).electionDeadline, '2026-10-01');
    assert.equal(B.applyCobraAction(rec, 'record_election', { date: '2026-10-05' }, cfg, '2026-10-05').conflict, true);
    step('record_election', { date: '2026-09-01' });
    assert.equal(B.cobraDeadlines(rec, cfg).firstPaymentDue, '2026-10-16');
    assert.deepEqual(B.cobraAlerts(rec, cfg, '2026-10-20'), ['First payment is overdue']);
    step('record_payment', { date: '2026-10-10' });
    assert.equal(B.applyCobraAction(rec, 'waive', {}, cfg, '2026-10-11').conflict, true);
    assert.ok(B.validateCobraEvent({ eventType: 'nope', eventDate: '2026-06-30' }, cfg).errors.length);
    assert.ok(B.validateCobraSettings({ electionDays: -1 }).errors.length);
});
test('limits table has no real amounts and applies only when entered', () => {
    assert.ok(B.DEFAULT_LIMITS.every((l) => l.amount === null && l.placeholder));
    assert.equal(B.limitFor(B.DEFAULT_LIMITS, '401k_employee_deferral', '2026'), null);
    assert.equal(B.limitFor([{ key: 'a', year: '2026', amount: 5 }, { key: 'a', year: null, amount: 9 }], 'a', '2027'), 9);
    assert.ok(B.validateLimits([{ key: 'a', year: '26', amount: 1 }]).errors.length);
    assert.ok(B.validateLifeEvents([{ key: 'x1', windowDays: 0 }]).errors.length);
});
