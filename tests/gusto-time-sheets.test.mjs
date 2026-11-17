// Hours to a customer's own Gusto account (GUSTO_INTEGRATION=app): services/gusto/time-sheets.js against the mock
// provider on a random port, with the gusto store in memory and people and approved weeks handed in.
// What this does NOT cover: the HTTP routes (see gusto-app-connect-routes.test.mjs), the page, real Firestore
// (the approved weeks come from a stand-in), and the real Gusto demo environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-gusto-integration';
process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);
const { createMockGusto } = require('../services/gusto/mock-server.js');
const { createMemoryStore } = require('../services/gusto/store.js');
const { resetAppState } = require('../services/gusto/client.js');
const { makeContext } = require('../services/gusto/index.js');
const appConnect = require('../services/gusto/app-connect.js');
const sheets = require('../services/gusto/time-sheets.js');
const timeRules = require('../services/time-rules.js');

const ORG = 'org_test_time_sheets';
const RETURN_TO = 'http://localhost:3000/api/us/gusto/oauth/callback';
const TZ = 'America/Chicago';
const silent = { info() {}, warn() {}, error() {} };
let mock; let baseUrl; let store; let company;
let people = []; let weeks = [];

const deps = (extra = {}) => ({
    store, log: silent, loadPeople: async () => people, loadWeeks: async () => weeks,
    optsOverride: { baseUrl, integration: 'app', redirectUri: RETURN_TO, authorizeUrl: `${baseUrl}/oauth/authorize`, backoffBaseMs: 5, rateLimitPerMinute: 100000, lockLeaseMs: 3000, maxRetries: 1, ...extra }
});
const ctx = (extra) => makeContext(ORG, deps(extra));
const mockPost = (path, body) => fetch(`${baseUrl}/__mock${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const mockGet = (path) => fetch(`${baseUrl}/__mock${path}`).then((r) => r.json());
const provider = () => mockGet('/time-sheets');

const person = (id, first, last, extra = {}) => ({ id, orgId: ORG, name: `${first} ${last}`, first, last, email: `${first.toLowerCase()}@example.test`, dob: '1990-04-12', classification: 'W2', payType: 'hourly', flsa: 'non_exempt', active: true, ...extra });
/** One approved day: work from 9:00 Chicago for the given hours */
const dayOf = (date, regular, overtime = 0, double = 0, extra = {}) => {
    const startAt = timeRules.zonedToUtcIso(date, '09:00', TZ);
    const worked = regular + overtime + double;
    return { date, workedHours: worked, regularHours: regular, overtimeHours: overtime, doubleTimeHours: double, premiumHours: 0, startAt, endAt: new Date(Date.parse(startAt) + (worked + 0.5) * 3600000).toISOString(), ...extra };
};
const week = (userId, weekStart, days, extra = {}) => ({ id: `${userId}_${weekStart}`, orgId: ORG, userId, weekStart, weekEnd: timeRules.addDaysIso(weekStart, 6), status: 'approved', timeZone: TZ, days, ...extra });

async function connect() {
    company = await mockPost('/app-company', { name: 'Harbor Motel LLC' });
    const { url } = await appConnect.startAuthorization(await ctx(), { actor: 'owner1' });
    const r = await fetch(url, { redirect: 'manual' });
    const back = new URL(r.headers.get('location'));
    await appConnect.completeAuthorization({ state: back.searchParams.get('state'), code: back.searchParams.get('code') }, deps());
}
/** Ann and Bob exist in Gusto and are matched here */
async function matchedPair() {
    people = [person('u1', 'Ann', 'Alpha'), person('u2', 'Bob', 'Beta')];
    const ann = await mockPost('/app-employee', { first_name: 'Ann', last_name: 'Alpha', email: 'ann@example.test', date_of_birth: '1990-04-12' });
    const bob = await mockPost('/app-employee', { first_name: 'Bob', last_name: 'Beta', email: 'bob@example.test', date_of_birth: '1990-04-12' });
    const out = await sheets.confirmMatches(await ctx(), [{ userId: 'u1', gustoUuid: ann.uuid }, { userId: 'u2', gustoUuid: bob.uuid }], 'owner1');
    assert.equal(out.saved, 2);
    return { ann, bob };
}

test.before(async () => { mock = createMockGusto(); baseUrl = (await mock.listen(0)).url; });
test.after(async () => { await mock.close(); });
test.beforeEach(async () => { store = createMemoryStore(); resetAppState(); people = []; weeks = []; await mockPost('/reset'); await connect(); });

/* ------------------------------- the start and end of a day's work ------------------------------- */

test('a day is a shift from the first clock-in to the last clock-out; work across midnight is cut at local midnight', () => {
    const at = (d, t) => timeRules.zonedToUtcIso(d, t, TZ);
    const P = (type, d, t) => ({ type, at: at(d, t) });
    // an ordinary day with a lunch break
    assert.deepEqual(timeRules.shiftSpan('2026-11-10', 450, [P('in', '2026-11-10', '09:00'), P('break_start', '2026-11-10', '12:00'), P('break_end', '2026-11-10', '12:30'), P('out', '2026-11-10', '17:00')], TZ),
        { startAt: at('2026-11-10', '09:00'), endAt: at('2026-11-10', '17:00') });
    // a night shift, first day: clocked in at 22:00 and still working at midnight
    assert.deepEqual(timeRules.shiftSpan('2026-11-10', 120, [P('in', '2026-11-10', '22:00')], TZ), { startAt: at('2026-11-10', '22:00'), endAt: at('2026-11-11', '00:00') });
    // second day: began at midnight, clocked out at 06:00
    assert.deepEqual(timeRules.shiftSpan('2026-11-11', 360, [P('out', '2026-11-11', '06:00')], TZ), { startAt: at('2026-11-11', '00:00'), endAt: at('2026-11-11', '06:00') });
    // a break that runs past midnight ends the day's work when the break began
    assert.equal(timeRules.shiftSpan('2026-11-10', 100, [P('in', '2026-11-10', '22:00'), P('break_start', '2026-11-10', '23:40')], TZ).endAt, at('2026-11-10', '23:40'));
    // no work, no shift
    assert.deepEqual(timeRules.shiftSpan('2026-11-10', 0, [], TZ), { startAt: null, endAt: null });
    // local midnight is the real one where clocks differ from UTC
    assert.equal(at('2026-11-11', '00:00'), '2026-11-11T06:00:00.000Z');
});

/* ------------------------------- matching people ------------------------------- */

test('matching suggests only when two facts agree with exactly one person in Gusto', async () => {
    people = [person('u1', 'Ann', 'Alpha'), person('u2', 'Bob', 'Beta', { email: 'bob.at.home@example.test' }), person('u3', 'Cy', 'Gamma', { email: 'cy@example.test', dob: '1991-01-01' }),
        person('u4', 'Dee', 'Delta', { dob: '1985-05-05' }), person('u5', 'Eve', 'Epsilon', { dob: '1999-09-09' }), person('u6', 'Kim', 'Contractor', { classification: '1099' }), person('u7', 'Gone', 'Person', { active: false })];
    const ann = await mockPost('/app-employee', { first_name: 'Ann', last_name: 'Alpha', email: 'ann@example.test', date_of_birth: '1990-04-12' });      // email + birth date + name
    const bob = await mockPost('/app-employee', { first_name: 'Bob', last_name: 'Beta', email: 'robert@work.test', date_of_birth: '1990-04-12' });       // birth date + name
    await mockPost('/app-employee', { first_name: 'Cy', last_name: 'Gamma', email: 'cy1@other.test', date_of_birth: '1991-01-01' });                         // two people who
    await mockPost('/app-employee', { first_name: 'Cy', last_name: 'Gamma', email: 'cy2@other.test', date_of_birth: '1991-01-01' });                         // look the same
    await mockPost('/app-employee', { first_name: 'Dee', last_name: 'Delta', email: 'dd@other.test', date_of_birth: '1970-01-01' });                         // name only
    await mockPost('/app-employee', { first_name: 'Zed', last_name: 'Zeta', email: 'zed@other.test', date_of_birth: '1980-02-02' });                         // only in Gusto

    const m = await sheets.getMatches(await ctx());
    const row = (id) => m.rows.find((r) => r.userId === id);
    assert.deepEqual(m.rows.map((r) => r.userId), ['u1', 'u2', 'u3', 'u4', 'u5'], 'contractors and people who left are not offered');
    assert.equal(row('u1').state, 'suggested'); assert.equal(row('u1').gustoUuid, ann.uuid); assert.deepEqual(row('u1').matchedBy, ['email', 'date of birth', 'name']);
    assert.equal(row('u2').state, 'suggested'); assert.equal(row('u2').gustoUuid, bob.uuid); assert.deepEqual(row('u2').matchedBy, ['date of birth', 'name']);
    assert.equal(row('u3').state, 'unmatched', 'two people in Gusto look the same: a person must choose');
    assert.equal(row('u3').candidates.length, 2);
    assert.equal(row('u4').state, 'unmatched', 'one fact is not enough to suggest');
    assert.deepEqual(row('u4').candidates.map((c) => c.agreesOn), [['name']]);
    assert.equal(row('u5').state, 'unmatched'); assert.deepEqual(row('u5').candidates, []);
    assert.ok(m.unmatchedInGusto.some((u) => u.name === 'Zed Zeta'));
    assert.deepEqual(m.totals, { people: 5, matched: 0, suggested: 2, unmatched: 3, inGusto: 6 });
    assert.deepEqual(await store.listLinks(ORG, 'employee'), [], 'a suggestion saves nothing until someone confirms it');
});

test('confirming saves the Gusto employee and job; a second claim, a stranger and someone who left are refused', async () => {
    people = [person('u1', 'Ann', 'Alpha'), person('u2', 'Bob', 'Beta'), person('u3', 'Cy', 'Gamma')];
    const ann = await mockPost('/app-employee', { first_name: 'Ann', last_name: 'Alpha', email: 'ann@example.test', date_of_birth: '1990-04-12' });
    const left = await mockPost('/app-employee', { first_name: 'Cy', last_name: 'Gamma', email: 'cy@example.test', date_of_birth: '1990-04-12', terminated: true });
    const out = await sheets.confirmMatches(await ctx(), [
        { userId: 'u1', gustoUuid: ann.uuid }, { userId: 'u2', gustoUuid: ann.uuid }, { userId: 'u3', gustoUuid: left.uuid },
        { userId: 'nobody', gustoUuid: ann.uuid }, { userId: 'u2', gustoUuid: 'not-in-this-account' }
    ], 'owner1');
    assert.equal(out.saved, 1);
    assert.equal(out.refused.length, 4);
    const link = await store.getLink(ORG, 'employee', 'u1');
    assert.equal(link.gustoUuid, ann.uuid); assert.equal(link.jobUuid, ann.job_uuid); assert.equal(link.matchedByUser, 'owner1');
    assert.equal(await store.getLink(ORG, 'employee', 'u2'), null);

    const m = await sheets.getMatches(await ctx());
    assert.equal(m.rows.find((r) => r.userId === 'u1').state, 'matched');
    assert.equal(m.rows.find((r) => r.userId === 'u2').state, 'unmatched', 'Ann in Gusto is taken, so she is not offered to Bob');
    await sheets.removeMatch(await ctx(), 'u1');
    assert.equal(await store.getLink(ORG, 'employee', 'u1'), null);
    await assert.rejects(async () => sheets.removeMatch(await ctx(), 'u1'), (e) => e.code === 'not_found');
});

/* ------------------------------- which shifts would be sent ------------------------------- */

test('only approved, matched, hourly days inside the period become shifts, and each reason for leaving one out is said', async () => {
    await matchedPair();
    people.push(person('u3', 'Cy', 'Gamma'), person('u4', 'Sal', 'Salary', { payType: 'salary', flsa: 'exempt' }), person('u5', 'Old', 'Week'), person('u6', 'Kim', 'Contractor', { classification: '1099' }));
    const old = await mockPost('/app-employee', { first_name: 'Old', last_name: 'Week', email: 'old@example.test', date_of_birth: '1990-04-12' });
    const sal = await mockPost('/app-employee', { first_name: 'Sal', last_name: 'Salary', email: 'sal@example.test', date_of_birth: '1990-04-12' });
    await sheets.confirmMatches(await ctx(), [{ userId: 'u5', gustoUuid: old.uuid }, { userId: 'u4', gustoUuid: sal.uuid }]);
    weeks = [
        week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 8, 2), dayOf('2026-11-11', 8, 2, 1), dayOf('2026-11-12', 0), dayOf('2026-11-16', 8)], { holidayPay: [{ date: '2026-11-11', hours: 8 }] }),
        week('u2', '2026-11-09', [dayOf('2026-11-09', 6)], { status: 'submitted' }),
        week('u3', '2026-11-09', [dayOf('2026-11-09', 8)]),                                  // approved, but not matched
        week('u4', '2026-11-09', [dayOf('2026-11-09', 8)]),                                  // salaried
        { ...week('u5', '2026-11-09', []), days: undefined },                                // approved before day detail was kept
        week('u6', '2026-11-09', [dayOf('2026-11-09', 8)]),                                  // contractor
        week('u1', '2026-11-02', [dayOf('2026-11-08', 5, 0, 0, { premiumHours: 1 }), dayOf('2026-11-07', 4)])   // only Nov 8 is in the period... and it is not
    ];
    const b = await sheets.buildShifts(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual(b.shifts.map((s) => s.key), ['u1_2026-11-09', 'u1_2026-11-10', 'u1_2026-11-11'], 'the empty day, next week and last week are left out');
    assert.deepEqual(b.shifts[2].entries, [{ classification: 'Regular', hours: 8 }, { classification: 'Overtime', hours: 2 }, { classification: 'Double overtime', hours: 1 }]);
    assert.deepEqual(b.totals, { shifts: 3, people: 1, regularHours: 24, overtimeHours: 4, doubleTimeHours: 1 });
    const codes = b.issues.map((i) => `${i.code}:${i.userId || ''}`).sort();
    assert.deepEqual(codes, ['holiday_pay_not_sent:', 'no_day_detail:u5', 'not_matched:u3', 'salaried_not_sent:u4', 'timesheet_not_approved:u2']);
    assert.equal(b.blocked, true);
    const payload = sheets.payloadOf(b.shifts[1]);
    assert.deepEqual(Object.keys(payload).sort(), ['entity_type', 'entity_uuid', 'entries', 'job_uuid', 'metadata', 'shift_ended_at', 'shift_started_at', 'time_zone']);
    assert.equal(payload.time_zone, TZ);
    assert.equal(payload.shift_started_at, '2026-11-10T15:00:00.000Z', '9:00 in Chicago, as UTC');
    assert.deepEqual(payload.entries, [{ hours_worked: 8, pay_classification: 'Regular' }, { hours_worked: 2, pay_classification: 'Overtime' }]);
    await assert.rejects(async () => sheets.buildShifts(await ctx(), '2026-11-15', '2026-11-09'), (e) => e.code === 'validation');
    await assert.rejects(async () => sheets.buildShifts(await ctx(), '2026-01-01', '2026-06-01'), (e) => e.code === 'validation');
});

test('a matched person with no job in Gusto is held back with a reason', async () => {
    people = [person('u1', 'Ann', 'Alpha')];
    const ann = await mockPost('/app-employee', { first_name: 'Ann', last_name: 'Alpha', email: 'ann@example.test', date_of_birth: '1990-04-12', job: false });
    await sheets.confirmMatches(await ctx(), [{ userId: 'u1', gustoUuid: ann.uuid }]);
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8)])];
    const b = await sheets.buildShifts(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual(b.shifts, []);
    assert.deepEqual(b.issues.map((i) => i.code), ['no_job']);
    assert.equal((await sheets.getMatches(await ctx())).rows[0].hasJob, false);
});

/* ------------------------------- sending ------------------------------- */

test('sending creates one time sheet per day, exactly as approved, and sending again changes nothing', async () => {
    const { ann, bob } = await matchedPair();
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 8, 2.5)]), week('u2', '2026-11-09', [dayOf('2026-11-11', 6.25)])];
    const first = await sheets.send(await ctx(), '2026-11-09', '2026-11-15', { actor: 'pay1' });
    assert.deepEqual([first.created, first.updated, first.unchanged, first.removed, first.failed, first.locked], [3, 0, 0, 0, 0, 0]);
    const at = await provider();
    assert.equal(at.length, 3);
    const tue = at.find((t) => t.entity_uuid === ann.uuid && t.shift_started_at === '2026-11-10T15:00:00.000Z');
    assert.equal(tue.entity_type, 'Employee'); assert.equal(tue.job_uuid, ann.job_uuid); assert.equal(tue.time_zone, TZ); assert.equal(tue.company_uuid, company.uuid);
    assert.deepEqual(tue.entries.map((e) => [e.hours_worked, e.pay_classification]), [['8.000', 'Regular'], ['2.500', 'Overtime']]);
    assert.deepEqual(tue.metadata, { source: 'onn_hr', ref: 'u1_2026-11-10' });
    assert.equal(at.find((t) => t.entity_uuid === bob.uuid).entries[0].hours_worked, '6.250');

    const before = (await mockGet('/stats')).requests;
    const again = await sheets.send(await ctx(), '2026-11-09', '2026-11-15', { actor: 'pay1' });
    assert.deepEqual([again.created, again.updated, again.unchanged, again.removed], [0, 0, 3, 0]);
    assert.equal((await mockGet('/stats')).requests, before + 1, 'the second time the provider is asked once, for its list of people, and no time sheet is sent');
    assert.equal((await provider()).length, 3);

    const list = await sheets.listSent(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual(list.map((r) => [r.key, r.status, r.hours]), [['u1_2026-11-09', 'sent', 8], ['u1_2026-11-10', 'sent', 10.5], ['u2_2026-11-11', 'sent', 6.25]]);
    assert.equal((await store.getConnection(ORG)).lastHoursSend.by, 'pay1');
});

test('a day changed after sending is updated in place; a day no longer approved is removed', async () => {
    await matchedPair();
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 8)])];
    await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    const uuids = new Map((await provider()).map((t) => [t.metadata.ref, t.uuid]));

    // the week was reopened, Tuesday corrected to 7 hours, Monday's punches removed, and it was approved again
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-10', 7)])];
    const p = await sheets.preview(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual(p.counts, { send: 0, update: 1, none: 0, remove: 1 });
    assert.deepEqual(p.toRemove.map((r) => r.key), ['u1_2026-11-09']);

    const out = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([out.created, out.updated, out.unchanged, out.removed, out.failed], [0, 1, 0, 1, 0]);
    const at = await provider();
    assert.equal(at.length, 1);
    assert.equal(at[0].uuid, uuids.get('u1_2026-11-10'), 'the same time sheet, not a second one');
    assert.equal(at[0].entries[0].hours_worked, '7.000');
    assert.deepEqual((await sheets.listSent(await ctx(), '2026-11-09', '2026-11-15')).map((r) => [r.key, r.status]), [['u1_2026-11-09', 'removed'], ['u1_2026-11-10', 'sent']]);

    // approved again later: Monday goes back as a new time sheet
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 7)])];
    const back = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([back.created, back.unchanged], [1, 1]);
});

test('a time sheet Gusto already put on a payroll is never changed or removed', async () => {
    await matchedPair();
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 8)])];
    await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    for (const t of await provider()) await mockPost('/time-sheet-on-payroll', { uuid: t.uuid });

    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-10', 5)])]; // one day changed, one day gone
    const out = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([out.created, out.updated, out.removed, out.failed, out.locked], [0, 0, 0, 0, 2]);
    assert.ok(out.problems.every((x) => x.code === 'already_on_payroll' && /off-cycle/.test(x.message)));
    const at = await provider();
    assert.equal(at.length, 2);
    assert.deepEqual(at.map((t) => t.entries[0].hours_worked).sort(), ['8.000', '8.000'], 'untouched at the provider');
});

test('one shift the provider rejects does not stop the others, is recorded, and clears once it goes through', async () => {
    await matchedPair();
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8)]), week('u2', '2026-11-09', [dayOf('2026-11-09', 6)])];
    await mockPost('/fail', { kind: '409', path: 'time_tracking/time_sheets', method: 'POST', times: 1 }); // the first day sent is turned away
    const out = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([out.created, out.failed], [1, 1]);
    assert.equal(out.problems[0].key, 'u1_2026-11-09');
    assert.match(out.problems[0].message, /conflict/i);
    const errs = await store.listErrors(ORG);
    assert.equal(errs.length, 1); assert.equal(errs[0].scope, 'time_sheet'); assert.equal(errs[0].ref, 'u1_2026-11-09');
    assert.equal((await provider()).length, 1);

    const again = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([again.created, again.unchanged, again.failed], [1, 1, 0]);
    assert.deepEqual(await store.listErrors(ORG), []);
});

test('a provider outage is retried, and what could not be sent goes through later without doubles', async () => {
    await matchedPair();
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 8)])];
    // each create is tried twice here (maxRetries 1): four failures cover both shifts
    await mockPost('/fail', { kind: '500', times: 4, path: 'time_tracking', method: 'POST' });
    const down = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([down.created, down.failed], [0, 2]);
    assert.equal((await provider()).length, 0);
    assert.equal((await store.listErrors(ORG)).length, 2);
    const up = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([up.created, up.failed], [2, 0]);
    assert.equal((await provider()).length, 2);
    assert.deepEqual(await store.listErrors(ORG), []);
    // one failure then success inside a single send: the retry makes it, and there is still only one time sheet
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 8), dayOf('2026-11-11', 4)])];
    await mockPost('/fail', { kind: '500', times: 1, path: 'time_tracking', method: 'POST' });
    const mixed = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([mixed.created, mixed.unchanged, mixed.failed], [1, 2, 0]);
    assert.equal((await provider()).length, 3);
});

/* ------------------------------- matches kept up to date ------------------------------- */

test('a job changed in Gusto is picked up before hours are sent, so a stale job id does not turn the day away', async () => {
    const { bob } = await matchedPair();
    const moved = await mockPost('/app-employee-change', { uuid: bob.uuid, new_job: true });
    assert.notEqual(moved.job_uuid, bob.job_uuid);
    weeks = [week('u2', '2026-11-09', [dayOf('2026-11-09', 6)])];
    const out = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([out.created, out.failed], [1, 0]);
    assert.deepEqual(out.matchCheck, { checked: 2, jobChanged: 1, left: 0, missing: 0 });
    assert.equal((await provider())[0].job_uuid, moved.job_uuid);
    assert.equal((await store.getLink(ORG, 'employee', 'u2')).jobUuid, moved.job_uuid);
});

test('someone dismissed in Gusto still has their hours sent with a warning; someone gone from Gusto is held back until matched again', async () => {
    const { ann, bob } = await matchedPair();
    await mockPost('/app-employee-change', { uuid: ann.uuid, terminated: true });
    await mockPost('/app-employee-change', { uuid: bob.uuid, remove: true });
    const r = await sheets.refreshMatches(await ctx());
    assert.deepEqual([r.checked, r.changed, r.left.map((x) => x.userId), r.missing.map((x) => x.userId)], [2, 2, ['u1'], ['u2']]);
    assert.equal((await store.getLink(ORG, 'employee', 'u2')).jobUuid, bob.job_uuid, 'the last job seen is kept for a person who is missing');
    const again = await sheets.refreshMatches(await ctx());
    assert.deepEqual([again.changed, again.left.length, again.missing.length], [0, 0, 0], 'nothing new the second time');
    assert.equal((await store.getConnection(ORG)).lastMatchRefresh.checked, 2);

    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8)]), week('u2', '2026-11-09', [dayOf('2026-11-09', 6)])];
    const out = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([out.created, out.failed], [1, 0]);
    assert.deepEqual(out.issues.map((i) => [i.code, i.severity, i.userId]), [['left_gusto', 'warning', 'u1'], ['gone_from_gusto', 'blocker', 'u2']]);
    assert.equal((await provider()).length, 1);

    // back in Gusto: the same match works again without anyone touching it
    await mockPost('/app-employee-change', { uuid: ann.uuid, terminated: false });
    assert.deepEqual((await sheets.refreshMatches(await ctx())).back.map((x) => x.userId), ['u1']);
});

test('if Gusto cannot give its list of people, the days are still tried with the matches as they are', async () => {
    await matchedPair();
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8)])];
    await mockPost('/fail', { kind: '500', path: '/employees', method: 'GET', times: 5 });
    const out = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([out.created, out.failed, out.matchCheck], [1, 0, null]);
    await mockPost('/reset');
});

/* ------------------------------- sending by itself ------------------------------- */

test('sending by itself is off until the company switches it on, then an approved week goes and a reopened week is taken back', async () => {
    await matchedPair();
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 7)])];
    assert.deepEqual(await sheets.afterWeekChange(ORG, '2026-11-09', { actor: 'mgr1', deps: deps() }), { skipped: 'switched_off' });
    assert.equal((await provider()).length, 0);
    await assert.rejects(async () => sheets.setAutoSend(await ctx(), 'yes', 'owner1'), (e) => e.code === 'validation');
    assert.deepEqual(await sheets.setAutoSend(await ctx(), true, 'owner1'), { autoSend: true });

    const out = await sheets.afterWeekChange(ORG, '2026-11-09', { actor: 'mgr1', deps: deps() });
    assert.deepEqual([out.created, out.failed], [2, 0]);
    assert.equal((await provider()).length, 2);
    const last = (await store.getConnection(ORG)).lastHoursSend;
    assert.deepEqual([last.auto, last.by, last.periodStart, last.periodEnd], [true, 'mgr1', '2026-11-09', '2026-11-15']);

    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 7)], { status: 'open' })]; // reopened
    const back = await sheets.afterWeekChange(ORG, '2026-11-09', { actor: 'mgr1', deps: deps() });
    assert.equal(back.removed, 2);
    assert.equal((await provider()).length, 0);

    assert.deepEqual(await sheets.afterWeekChange(ORG, '2026-11-09', { deps: deps({ integration: 'embedded' }) }), { skipped: 'not_app_integration' });
    await store.saveConnection(ORG, { status: 'disconnected' });
    assert.deepEqual(await sheets.afterWeekChange(ORG, '2026-11-09', { deps: deps() }), { skipped: 'not_connected' });
});

test('sending by itself never throws: a failure is written to the error list and clears when the week goes through', async () => {
    await matchedPair();
    await sheets.setAutoSend(await ctx(), true, 'owner1');
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8)])];
    await mockPost('/revoke-refresh'); await mockPost('/expire-tokens', { company: true }); // the connection has gone bad
    const out = await sheets.afterWeekChange(ORG, '2026-11-09', { actor: 'mgr1', deps: deps() });
    assert.equal(out.failed, true);
    const errs = (await store.listErrors(ORG)).filter((e) => e.scope === 'auto_send');
    assert.equal(errs.length, 1); assert.equal(errs[0].ref, '2026-11-09'); assert.match(errs[0].message, /were not sent to Gusto by themselves/);

    // the owner connects again, to the same company, so the matches are kept
    const { url } = await appConnect.startAuthorization(await ctx(), { actor: 'owner1' });
    const back = new URL((await fetch(url, { redirect: 'manual' })).headers.get('location'));
    await appConnect.completeAuthorization({ state: back.searchParams.get('state'), code: back.searchParams.get('code') }, deps());
    await sheets.setAutoSend(await ctx(), true, 'owner1');
    const ok = await sheets.afterWeekChange(ORG, '2026-11-09', { actor: 'mgr1', deps: deps() });
    assert.equal(ok.created, 1);
    assert.deepEqual((await store.listErrors(ORG)).filter((e) => e.scope === 'auto_send'), []);
});

test('two sends for one company at the same moment do not create the same day twice', async () => {
    await matchedPair();
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 8)]), week('u2', '2026-11-09', [dayOf('2026-11-09', 6)])];
    const [a, b] = await Promise.all([sheets.send(await ctx(), '2026-11-09', '2026-11-15'), sheets.send(await ctx(), '2026-11-09', '2026-11-15')]);
    assert.deepEqual([a.created + b.created, a.unchanged + b.unchanged], [3, 3]);
    assert.equal((await provider()).length, 3);
});

test('a company that is not connected, or a server set up for Embedded Payroll, sends nothing', async () => {
    await matchedPair();
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8)])];
    await assert.rejects(async () => sheets.send(await ctx({ integration: 'embedded' }), '2026-11-09', '2026-11-15'), (e) => e.code === 'not_app_integration');
    await assert.rejects(async () => sheets.getMatches(await ctx({ integration: 'embedded' })), (e) => e.code === 'not_app_integration');
    await store.clearCompanyTokens(ORG);
    await store.saveConnection(ORG, { status: 'disconnected' });
    await assert.rejects(async () => sheets.send(await ctx(), '2026-11-09', '2026-11-15'), (e) => e.code === 'not_connected');
    assert.equal((await provider()).length, 0);
});
