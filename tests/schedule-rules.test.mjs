import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../services/schedule-rules.js');
const TZ = 'America/Chicago';

const mk = (over = {}) => {
    const w = S.shiftWindow(over.date || '2026-11-09', over.startTime || '08:00', over.endTime || '16:00', TZ, over.breakMinutes ?? 30);
    return { id: over.id || 's1', userId: 'u1', status: 'published', date: '2026-11-09', startTime: '08:00', endTime: '16:00', ...w, ...over };
};

test('shift window: overnight, break deducted, DST-safe instants', () => {
    const w = S.shiftWindow('2026-11-09', '22:00', '06:00', TZ, 30);
    assert.equal(w.hours, 7.5);
    assert.equal(w.startAt, '2026-11-10T04:00:00.000Z');
    assert.equal(S.shiftWindow('bad', '08:00', '16:00', TZ), null);
});

test('validation of templates, shifts, settings, jobs, rules', () => {
    assert.ok(S.validateTemplate({ name: '', startTime: '25:00', endTime: '16:00' }).errors.length >= 2);
    assert.deepEqual(S.validateTemplate({ name: 'Day', startTime: '8:00', endTime: '16:00' }).errors, []);
    assert.ok(S.validateShiftInput({ date: '2026-11-09', startTime: 'x', endTime: '16:00' }, TZ).errors.length);
    assert.ok(S.validateSettings({ minRestHours: 99 }).errors.length);
    assert.ok(S.validateJob({ code: 'a b', name: 'x' }).errors.length);
    assert.equal(S.validateJob({ code: 'job-1', name: 'Lobby' }).value.code, 'JOB-1');
    assert.ok(S.validatePredictiveRule({ name: 'x', noticeDays: 200 }).errors.length);
});

test('conflicts: overlap and approved leave block; short rest and long weeks only warn by default', () => {
    const existing = mk({ id: 'a' });
    const overlap = mk({ id: 'b', startTime: '12:00', endTime: '20:00' });
    const c1 = S.conflictsFor({ shift: overlap, others: [existing], leaves: [], tz: TZ });
    assert.ok(c1.some((c) => c.code === 'overlap' && c.severity === 'block'));
    const leave = S.conflictsFor({ shift: mk({ id: 'n' }), others: [], leaves: [{ dates: ['2026-11-09'], status: 'approved' }], tz: TZ });
    assert.ok(leave.some((c) => c.code === 'on_leave' && c.severity === 'block'));
    assert.ok(S.conflictsFor({ shift: mk({ id: 'n' }), others: [], leaves: [{ dates: ['2026-11-09'], status: 'pending' }], tz: TZ }).every((c) => c.severity === 'warn'));
    const close = mk({ id: 'c', date: '2026-11-09', startTime: '20:00', endTime: '23:00' });
    const rest = S.conflictsFor({ shift: close, others: [existing], leaves: [], tz: TZ });
    assert.ok(rest.some((c) => c.code === 'short_rest' && c.severity === 'warn'));
    const enforced = S.conflictsFor({ shift: close, others: [existing], leaves: [], settings: { enforceRest: true }, tz: TZ });
    assert.ok(enforced.some((c) => c.code === 'short_rest' && c.severity === 'block'));
});

test('weekly hours: overtime risk above 40, over max above setting; projected uses actual worked for past days', () => {
    const shifts = ['09', '10', '11', '12', '13'].map((d, i) => mk({ id: `x${i}`, date: `2026-11-${d}`, startTime: '08:00', endTime: '17:30', breakMinutes: 30 }));
    assert.equal(S.weeklyHours('2026-11-09', shifts), 45);
    const cand = mk({ id: 'z', date: '2026-11-14', startTime: '08:00', endTime: '12:00', breakMinutes: 0 });
    assert.ok(S.conflictsFor({ shift: cand, others: shifts, leaves: [], tz: TZ }).some((c) => c.code === 'overtime_risk'));
    assert.ok(S.conflictsFor({ shift: cand, others: shifts, leaves: [], settings: { maxWeeklyHours: 46 }, tz: TZ }).some((c) => c.code === 'over_weekly_hours'));
    assert.equal(S.projectedWeekHours('2026-11-09', shifts, { '2026-11-09': 10, '2026-11-10': 10 }, '2026-11-11'), 10 + 10 + 27);
});

test('availability: weekly windows and date exceptions', () => {
    const s = mk({ date: '2026-11-09' });
    assert.equal(S.availabilityIssue({ weekly: [{ dow: 1, available: false }] }, s, TZ), 'unavailable');
    assert.equal(S.availabilityIssue({ weekly: [{ dow: 1, available: true, start: '09:00', end: '17:00' }] }, s, TZ), 'outside_hours');
    assert.equal(S.availabilityIssue({ weekly: [{ dow: 1, available: true, start: '07:00', end: '17:00' }] }, s, TZ), null);
    assert.equal(S.availabilityIssue({ weekly: [{ dow: 1, available: false }], exceptions: [{ date: '2026-11-09', available: true }] }, s, TZ), null);
    assert.equal(S.availabilityIssue(null, s, TZ), null);
});

test('predictive scheduling: seeded empty means no premium; a rule flags changes inside the notice window', () => {
    const shift = mk({ startAt: '2026-11-10T14:00:00.000Z' });
    assert.equal(S.premiumOwed({ shift, change: 'time_changed', nowIso: '2026-11-09T14:00:00Z', rules: [], state: 'OR' }), null);
    const rules = [{ id: 'r1', name: 'Test rule', noticeDays: 14, premiumPay: true, premiumHours: 1, jurisdictions: ['OR'], enabled: true }];
    const p = S.premiumOwed({ shift, change: 'time_changed', nowIso: '2026-11-09T14:00:00Z', rules, state: 'OR' });
    assert.equal(p.premiumHours, 1); assert.equal(p.ruleId, 'r1');
    assert.equal(S.premiumOwed({ shift, change: 'cancelled', nowIso: '2026-11-09T14:00:00Z', rules, state: 'TX' }), null);
    assert.equal(S.premiumOwed({ shift: mk({ startAt: '2026-12-30T14:00:00.000Z' }), change: 'x', nowIso: '2026-11-09T14:00:00Z', rules, state: 'OR' }), null);
});

test('copy last week moves every shift by 7 days and keeps people and roles', () => {
    const out = S.copyWeek([mk({ id: 'a', role: 'Housekeeper' }), mk({ id: 'b', status: 'cancelled' })], '2026-11-09', '2026-11-16', TZ);
    assert.equal(out.length, 1); assert.equal(out[0].date, '2026-11-16'); assert.equal(out[0].role, 'Housekeeper'); assert.equal(out[0].userId, 'u1');
});

test('qualification by role, job title or skill', () => {
    assert.equal(S.isQualified({ role: null }, {}), true);
    assert.equal(S.isQualified({ role: 'Housekeeper' }, { jobTitle: 'housekeeper' }), true);
    assert.equal(S.isQualified({ role: 'Driver' }, { jobTitle: 'Housekeeper', skills: ['Driver'] }), true);
    assert.equal(S.isQualified({ role: 'Driver' }, { jobTitle: 'Housekeeper' }), false);
});

test('schedule vs actual: on time, late, early leave, no-show', () => {
    const shifts = [mk({ id: 'a', userId: 'a' }), mk({ id: 'b', userId: 'b' }), mk({ id: 'c', userId: 'c' }), mk({ id: 'd', userId: 'd' })];
    const t = (h, m) => `2026-11-09T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`;
    const p = {
        a: [{ type: 'in', at: t(14, 1) }, { type: 'out', at: t(22, 0) }],
        b: [{ type: 'in', at: t(14, 40) }, { type: 'out', at: t(22, 0) }],
        c: [{ type: 'in', at: t(14, 0) }, { type: 'out', at: t(20, 0) }]
    };
    const r = S.compareScheduleToActual(shifts, p, TZ, '2026-11-10T12:00:00Z');
    const st = Object.fromEntries(r.rows.map((x) => [x.userId, x.status]));
    assert.deepEqual(st, { a: 'on_time', b: 'late', c: 'early_leave', d: 'no_show' });
    assert.equal(r.summary.noShow, 1); assert.equal(r.rows.find((x) => x.userId === 'b').lateMinutes, 40);
});

test('job allocation: end-of-day split cannot exceed worked minutes; report totals by job', () => {
    assert.ok(S.validateAllocations([{ jobId: 'j1', minutes: 300 }, { jobId: 'j2', minutes: 200 }], 480).errors.length);
    assert.deepEqual(S.validateAllocations([{ jobId: 'j1', minutes: 300 }, { jobId: 'j2', minutes: 180 }], 480).errors, []);
    assert.ok(S.validateAllocations([{ jobId: 'j1', minutes: 0 }], 480).errors.length);
    const rep = S.jobReport([{ jobId: 'j1', userId: 'a', minutes: 90 }, { jobId: 'j1', userId: 'b', minutes: 30 }], [{ id: 'j1', code: 'LOBBY', name: 'Lobby', billable: true }]);
    assert.equal(rep[0].hours, 2); assert.equal(rep[0].workers, 2); assert.equal(rep[0].billable, true);
});
