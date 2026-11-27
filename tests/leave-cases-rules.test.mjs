import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const L = require('../services/leave-cases-rules.js');
const cfg = L.DEFAULT_SETTINGS;

const weeks = (n, hours, from = '2025-06-02') => Array.from({ length: n }, (_, i) => ({ status: 'approved', weekStart: L.addDays(from, i * 7), totals: { workedHours: hours } }));

test('months of service counts whole months', () => {
    assert.equal(L.monthsOfService('2025-01-31', '2026-01-30'), 11);
    assert.equal(L.monthsOfService('2025-01-31', '2026-02-28'), 13);
    assert.equal(L.monthsOfService('2025-03-10', '2026-03-10'), 12);
});
test('hours in the last 12 months use approved weeks only', () => {
    const w = [...weeks(40, 32), { status: 'submitted', weekStart: '2026-03-02', totals: { workedHours: 99 } }, { status: 'approved', weekStart: '2024-01-01', totals: { workedHours: 40 } }];
    const r = L.hoursLast12Months(w, '2026-04-01');
    assert.equal(r.hours, 1280); assert.equal(r.weeksCounted, 40);
});
test('eligibility needs all three tests; exempt hours presumed', () => {
    const ok = L.fmlaEligibility({ hireDate: '2024-01-15', asOf: '2026-04-01', weeks: weeks(40, 32), headcount: { count: 60, basis: 'company' } }, cfg);
    assert.equal(ok.eligible, true);
    const few = L.fmlaEligibility({ hireDate: '2024-01-15', asOf: '2026-04-01', weeks: weeks(30, 30), headcount: { count: 60 } }, cfg);
    assert.equal(few.eligible, false); assert.equal(few.checks[1].ok, false);
    const exempt = L.fmlaEligibility({ hireDate: '2024-01-15', asOf: '2026-04-01', weeks: [], headcount: { count: 60 }, exempt: true }, cfg);
    assert.equal(exempt.eligible, true);
    assert.equal(L.fmlaEligibility({ hireDate: '2025-12-01', asOf: '2026-04-01', weeks: weeks(40, 40), headcount: { count: 60 } }, cfg).checks[0].ok, false);
    assert.equal(L.fmlaEligibility({ hireDate: '2024-01-15', asOf: '2026-04-01', weeks: weeks(40, 40), headcount: { count: 49 } }, cfg).eligible, false);
});
test('worksite headcount: company fallback, same site and radius', () => {
    const people = [{ id: 1, locationId: 'a' }, { id: 2, locationId: 'a' }, { id: 3, locationId: 'b' }, { id: 4, locationId: 'c' }, { id: 5, active: false, locationId: 'a' }];
    assert.deepEqual(L.worksiteHeadcount(people, [], { locationId: 'a' }, 75), { count: 4, basis: 'company' });
    const locs = [{ id: 'a', lat: 30.27, lng: -97.74 }, { id: 'b', lat: 30.5, lng: -97.7 }, { id: 'c', lat: 40.7, lng: -74 }];
    const r = L.worksiteHeadcount(people, locs, { locationId: 'a' }, 75);
    assert.equal(r.count, 3);
    assert.equal(L.worksiteHeadcount(people, locs, { locationId: 'a' }, 1).count, 2);
});
test('entitlement: 12 weeks, 26 for military caregiver', () => {
    assert.equal(L.entitlementHours('own_health', 40, cfg), 480);
    assert.equal(L.entitlementHours('military_caregiver', 40, cfg), 1040);
    assert.equal(L.entitlementHours('own_health', 30, cfg), 360);
});
test('leave periods for each method', () => {
    assert.deepEqual(L.leavePeriod('calendar_year', '2026-07-04'), { start: '2026-01-01', end: '2026-12-31' });
    assert.deepEqual(L.leavePeriod('fixed_year', '2026-03-04', { fixedStart: '07-01' }), { start: '2025-07-01', end: '2026-06-30' });
    assert.deepEqual(L.leavePeriod('fixed_year', '2026-08-04', { fixedStart: '07-01' }), { start: '2026-07-01', end: '2027-06-30' });
    assert.deepEqual(L.leavePeriod('rolling_backward', '2026-07-04'), { start: '2025-07-05', end: '2026-07-04' });
    assert.deepEqual(L.leavePeriod('rolling_forward', '2026-07-04', { usageDates: ['2026-02-02', '2026-03-01'] }), { start: '2026-02-02', end: '2027-02-01' });
    assert.deepEqual(L.leavePeriod('rolling_forward', '2027-03-04', { usageDates: ['2026-02-02', '2027-02-10'] }), { start: '2027-02-10', end: '2028-02-09' });
});
test('balance counts continuous, intermittent and reduced hours inside the period', () => {
    const usage = [...L.continuousUsage('2026-02-02', '2026-02-13', 8), { date: '2026-03-02', hours: 3, kind: 'intermittent' }, { date: '2026-03-03', hours: 2, kind: 'reduced' }, { date: '2024-01-02', hours: 100, kind: 'continuous' }];
    const b = L.fmlaBalance({ usage, reason: 'own_health', weeklyHours: 40, refDate: '2026-03-10' }, cfg);
    assert.equal(b.usedHours, 85); assert.equal(b.remainingHours, 395); assert.equal(b.byKind.intermittent, 3);
    assert.equal(L.fmlaBalance({ usage, reason: 'own_health', weeklyHours: 40, refDate: '2026-03-10' }, { ...cfg, periodMethod: 'calendar_year' }).usedHours, 85);
    assert.equal(L.fmlaBalance({ usage: [{ date: '2026-02-02', hours: 480, kind: 'continuous' }], reason: 'own_health', weeklyHours: 40, refDate: '2026-03-10' }, cfg).exhausted, true);
});
test('usage validation', () => {
    assert.ok(L.validateUsage({ date: '2026-02-30', hours: 3 }).errors.length);
    assert.ok(L.validateUsage({ date: '2026-02-02', hours: 25 }).errors.length);
    assert.deepEqual(L.validateUsage({ date: '2026-02-02', hours: 3, kind: 'intermittent' }).errors, []);
});
test('request validation and the data-driven type table', () => {
    const types = [...L.DEFAULT_LEAVE_TYPES, { key: 'ca_only', label: 'CA', paid: 'paid', states: ['CA'], active: true }];
    assert.ok(L.validateRequest({ typeKey: 'nope', startDate: '2026-03-01' }, types).errors.length);
    assert.ok(L.validateRequest({ typeKey: 'fmla', startDate: '2026-03-01', endDate: '2026-03-10' }, types).errors.some((e) => /fmlaReason/.test(e)));
    assert.ok(L.validateRequest({ typeKey: 'ca_only', startDate: '2026-03-01', endDate: '2026-03-02' }, types, { workState: 'TX' }).errors.length);
    assert.deepEqual(L.validateRequest({ typeKey: 'ca_only', startDate: '2026-03-01', endDate: '2026-03-02' }, types, { workState: 'CA' }).errors, []);
    const r = L.validateRequest({ typeKey: 'bereavement', startDate: '2026-03-01', endDate: '2026-03-10' }, types);
    assert.deepEqual(r.errors, []); assert.equal(r.warnings.length, 1);
    assert.ok(L.validateRequest({ typeKey: 'jury_duty', startDate: '2026-03-01' }, types).errors.length);
    assert.ok(L.DEFAULT_LEAVE_TYPES.every((t) => t.confirmed === false && /counsel/i.test(t.note)));
});
test('settings validation', () => {
    assert.ok(L.validateSettings({ periodMethod: 'bogus', minMonthsService: -1, fixedPeriodStart: '13-01' }).errors.length >= 3);
    assert.equal(L.validateSettings({ standardWeeks: 8 }).value.standardWeeks, 8);
});
test('lifecycle with deadlines, eligibility gate, job protection', () => {
    const d0 = L.newCaseDeadlines('2026-03-02', cfg);
    assert.equal(d0.eligibilityNoticeDue, '2026-03-09');
    let c = { status: 'requested', typeKey: 'fmla', deadlines: d0, eligibility: { eligible: true } };
    const step = (a, p) => { const r = L.applyAction(c, a, p, cfg, '2026-03-03'); assert.deepEqual(r.errors, [], a); c = { ...c, ...r.patch, status: r.patch.status || c.status }; return r; };
    step('eligibility_notice', { date: '2026-03-03' });
    assert.equal(c.deadlines.designationNoticeDue, '2026-03-10');
    step('request_certification', { date: '2026-03-03' });
    assert.equal(c.deadlines.certificationDue, '2026-03-18');
    step('receive_certification', { date: '2026-03-10' });
    step('designate', { date: '2026-03-11' });
    assert.equal(c.jobProtected, true);
    step('request_recertification', { date: '2026-04-01' });
    assert.equal(c.deadlines.recertificationDue, '2026-04-16'); assert.equal(c.status, 'designated');
    step('start_leave'); step('return_to_work', { date: '2026-05-01' }); step('close');
    assert.equal(c.jobProtected, false);
    assert.equal(L.applyAction(c, 'start_leave', {}, cfg, '2026-03-03').conflict, true);
});
test('ineligible FMLA cannot be designated without override and reason; deny needs reason', () => {
    const c = { status: 'eligibility_noticed', typeKey: 'fmla', deadlines: {}, eligibility: { eligible: false } };
    assert.equal(L.applyAction(c, 'designate', {}, cfg, '2026-03-03').conflict, true);
    assert.ok(L.applyAction(c, 'designate', { override: true }, cfg, '2026-03-03').errors.length);
    assert.equal(L.applyAction(c, 'designate', { override: true, note: 'HR policy exception' }, cfg, '2026-03-03').patch.jobProtected, true);
    assert.ok(L.applyAction(c, 'deny', {}, cfg, '2026-03-03').errors.length);
    assert.equal(L.applyAction({ ...c, typeKey: 'jury_duty' }, 'designate', {}, cfg, '2026-03-03').patch.jobProtected, false);
});
test('deadline list flags overdue open items', () => {
    const c = { status: 'requested', deadlines: { eligibilityNoticeDue: '2026-03-09', certificationDue: '2026-03-18', certificationReceived: '2026-03-10' } };
    const l = L.deadlineList(c, '2026-03-12');
    assert.equal(l.find((x) => x.key === 'eligibilityNotice').overdue, true);
    assert.equal(l.find((x) => x.key === 'certification').overdue, false);
    assert.equal(L.publicCase({ id: 1, hrNotes: 'x' }).hrNotes, undefined);
});
