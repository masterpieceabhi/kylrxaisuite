// A customer's own Gusto account (GUSTO_INTEGRATION=app): putting hours on a payroll, reading what was paid, and
// cancelling the tokens on disconnect. services/gusto/app-payroll.js and app-connect.js against the mock provider
// on a random port, with the gusto store in memory and people, approved weeks and pay results handed in.
// What this does NOT cover: the HTTP routes (see gusto-app-connect-routes.test.mjs), the page, real Firestore,
// Gusto's "PayrollSync" webhook, and the real Gusto demo environment.
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
const appPayroll = require('../services/gusto/app-payroll.js');
const timeRules = require('../services/time-rules.js');

const ORG = 'org_test_app_payroll';
const RETURN_TO = 'http://localhost:3000/api/us/gusto/oauth/callback';
const TZ = 'America/Chicago';
const TODAY = '2026-11-17';
const silent = { info() {}, warn() {}, error() {} };
let mock; let baseUrl; let store; let company; let schedule;
let people = []; let weeks = []; let results = new Map();

const deps = (extra = {}) => ({
    store, log: silent, loadPeople: async () => people, loadWeeks: async () => weeks, today: () => TODAY,
    savePayResults: async (orgId, rows) => { rows.forEach((r) => results.set(r.id, r)); },
    listPayResults: async (orgId, payrollUuid) => [...results.values()].filter((r) => r.orgId === orgId && (!payrollUuid || r.payrollUuid === payrollUuid)),
    deletePayResults: async (orgId, ids) => { ids.forEach((id) => results.delete(id)); },
    optsOverride: { baseUrl, integration: 'app', redirectUri: RETURN_TO, authorizeUrl: `${baseUrl}/oauth/authorize`, backoffBaseMs: 5, rateLimitPerMinute: 100000, lockLeaseMs: 3000, maxRetries: 1, ...extra }
});
const ctx = (extra) => makeContext(ORG, deps(extra));
const mockPost = (path, body) => fetch(`${baseUrl}/__mock${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const mockGet = (path) => fetch(`${baseUrl}/__mock${path}`).then((r) => r.json());

const person = (id, first, last) => ({ id, orgId: ORG, employeeId: `E-${id}`, name: `${first} ${last}`, first, last, department: 'Front desk', email: `${first.toLowerCase()}@example.test`, dob: '1990-04-12', classification: 'W2', payType: 'hourly', flsa: 'non_exempt', active: true });
const dayOf = (date, regular) => { const startAt = timeRules.zonedToUtcIso(date, '09:00', TZ); return { date, workedHours: regular, regularHours: regular, overtimeHours: 0, doubleTimeHours: 0, premiumHours: 0, startAt, endAt: new Date(Date.parse(startAt) + (regular + 0.5) * 3600000).toISOString() }; };
const week = (userId, weekStart, days, extra = {}) => ({ id: `${userId}_${weekStart}`, orgId: ORG, userId, weekStart, weekEnd: timeRules.addDaysIso(weekStart, 6), status: 'approved', timeZone: TZ, days, ...extra });

async function connect() {
    company = await mockPost('/app-company', { name: 'Harbor Motel LLC' });
    const { url } = await appConnect.startAuthorization(await ctx(), { actor: 'owner1' });
    const r = await fetch(url, { redirect: 'manual' });
    const back = new URL(r.headers.get('location'));
    await appConnect.completeAuthorization({ state: back.searchParams.get('state'), code: back.searchParams.get('code') }, deps());
}
/** Ann and Bob exist in Gusto and are matched here; the company pays weekly, Monday to Sunday, on the Friday after */
async function setUp() {
    people = [person('u1', 'Ann', 'Alpha'), person('u2', 'Bob', 'Beta')];
    const ann = await mockPost('/app-employee', { first_name: 'Ann', last_name: 'Alpha', email: 'ann@example.test', date_of_birth: '1990-04-12' });
    const bob = await mockPost('/app-employee', { first_name: 'Bob', last_name: 'Beta', email: 'bob@example.test', date_of_birth: '1990-04-12' });
    await sheets.confirmMatches(await ctx(), [{ userId: 'u1', gustoUuid: ann.uuid }, { userId: 'u2', gustoUuid: bob.uuid }], 'owner1');
    schedule = await mockPost('/app-pay-schedule', { frequency: 'Every week', anchor_end_of_pay_period: '2026-11-15', anchor_pay_date: '2026-11-20' });
    return { ann, bob };
}
const PERIOD = () => ({ payScheduleUuid: schedule.uuid, start: '2026-11-09', end: '2026-11-15' });

test.before(async () => { mock = createMockGusto(); baseUrl = (await mock.listen(0)).url; });
test.after(async () => { await mock.close(); });
test.beforeEach(async () => { store = createMemoryStore(); resetAppState(); people = []; weeks = []; results = new Map(); await mockPost('/reset'); await connect(); });

/* ------------------------------- open pay periods ------------------------------- */

test('open pay periods come from the payrolls Gusto has not processed, 45 days either side of today', async () => {
    await setUp();
    const list = await appPayroll.openPayPeriods(await ctx());
    assert.ok(list.length >= 10 && list.length <= 14, `about thirteen weekly periods, got ${list.length}`);
    assert.ok(list.every((p) => p.payScheduleUuid === schedule.uuid && p.payrollUuid));
    const p = list.find((x) => x.start === '2026-11-09');
    assert.deepEqual([p.end, p.checkDate, p.ended], ['2026-11-15', '2026-11-20', true]);
    assert.equal(list.find((x) => x.start === '2026-11-16').ended, false);
    assert.deepEqual(list.map((x) => x.start), [...list.map((x) => x.start)].sort(), 'oldest first');
    await assert.rejects(async () => appPayroll.openPayPeriods(await ctx({ integration: 'embedded' })), (e) => e.code === 'not_app_integration');
});

/* ------------------------------- hours onto a payroll ------------------------------- */

test('hours are put on a payroll only for an open pay period whose approved hours have all been sent', async () => {
    await setUp();
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8), dayOf('2026-11-10', 8)]), week('u2', '2026-11-09', [dayOf('2026-11-11', 6)])];

    await assert.rejects(async () => appPayroll.startPayrollSync(await ctx(), {}), (e) => e.code === 'validation');
    await assert.rejects(async () => appPayroll.startPayrollSync(await ctx(), { ...PERIOD(), end: '2026-11-14' }), (e) => e.code === 'no_open_pay_period');
    await assert.rejects(async () => appPayroll.startPayrollSync(await ctx(), { ...PERIOD(), payScheduleUuid: 'someone-elses' }), (e) => e.code === 'no_open_pay_period');
    await assert.rejects(async () => appPayroll.startPayrollSync(await ctx(), PERIOD()), (e) => e.code === 'hours_not_sent' && e.counts.send === 3 && /3 days of hours/.test(e.message));
    assert.deepEqual(await mockGet('/payroll-syncs'), [], 'nothing reached Gusto');

    await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    const out = await appPayroll.startPayrollSync(await ctx(), PERIOD(), { actor: 'pay1' });
    assert.deepEqual([out.sync.status, out.sync.periodStart, out.sync.periodEnd, out.sync.startedBy, out.checkDate], ['pending', '2026-11-09', '2026-11-15', 'pay1', '2026-11-20']);
    const atGusto = await mockGet('/payroll-syncs');
    assert.deepEqual([atGusto.length, atGusto[0].kind, atGusto[0].pay_schedule_uuid, atGusto[0].pay_period_start_date, atGusto[0].pay_period_end_date], [1, 'regular', schedule.uuid, '2026-11-09', '2026-11-15']);

    // asking twice while Gusto is still working is refused here, not sent
    await assert.rejects(async () => appPayroll.startPayrollSync(await ctx(), PERIOD()), (e) => e.code === 'sync_in_progress');
    assert.equal((await mockGet('/payroll-syncs')).length, 1);

    // the list without a refresh shows what we knew; with one, Gusto's answer
    assert.equal((await appPayroll.listPayrollSyncs(await ctx()))[0].status, 'pending');
    const done = await appPayroll.listPayrollSyncs(await ctx(), { refresh: true });
    assert.equal(done[0].status, 'success'); assert.ok(done[0].completedAt);
    assert.ok((await mockGet('/time-sheets')).every((t) => t.synced_to_payroll_at), 'Gusto put the time sheets on the payroll');

    // a day changed afterwards is not changed in Gusto: it needs an off-cycle payroll there
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 7), dayOf('2026-11-10', 8)]), week('u2', '2026-11-09', [dayOf('2026-11-11', 6)])];
    const late = await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    assert.deepEqual([late.updated, late.locked, late.unchanged], [0, 1, 2]);
});

test('people whose hours are not in Gusto are named when hours are put on a payroll', async () => {
    await setUp();
    people.push(person('u3', 'Cy', 'Gamma')); // approved but not matched
    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8)]), week('u3', '2026-11-09', [dayOf('2026-11-09', 5)]), week('u2', '2026-11-09', [dayOf('2026-11-10', 4)], { status: 'submitted' })];
    await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    const out = await appPayroll.startPayrollSync(await ctx(), PERIOD());
    assert.deepEqual(out.notIncluded.map((i) => [i.code, i.userId]).sort(), [['not_matched', 'u3'], ['timesheet_not_approved', 'u2']]);
});

test('what Gusto says about a request is kept: a failure with its reasons, and a refusal when there are no hours', async () => {
    await setUp();
    // no hours at all in the period: Gusto refuses, nothing is remembered
    await assert.rejects(async () => appPayroll.startPayrollSync(await ctx(), PERIOD()), (e) => e.name === 'GustoError' && e.status === 422 && /no hours to sync/i.test(e.message));
    assert.deepEqual(await appPayroll.listPayrollSyncs(await ctx()), []);

    weeks = [week('u1', '2026-11-09', [dayOf('2026-11-09', 8)])];
    await sheets.send(await ctx(), '2026-11-09', '2026-11-15');
    const { sync } = await appPayroll.startPayrollSync(await ctx(), PERIOD());
    await mockPost('/payroll-sync-result', { status: 'failure', errors: [{ error_key: 'base', category: 'invalid_operation', message: 'The payroll for this pay period is locked.' }], warnings: ['One employee has no compensation.'] });
    const read = await appPayroll.refreshPayrollSync(await ctx(), sync.id);
    assert.deepEqual([read.status, read.errors, read.warnings], ['failure', ['The payroll for this pay period is locked.'], ['One employee has no compensation.']]);
    assert.ok((await mockGet('/time-sheets')).every((t) => !t.synced_to_payroll_at));
    await assert.rejects(async () => appPayroll.refreshPayrollSync(await ctx(), 'not-ours'), (e) => e.code === 'not_found');

    // after a failure the same period can be asked for again
    const again = await appPayroll.startPayrollSync(await ctx(), PERIOD());
    assert.equal(again.sync.status, 'pending');
    assert.equal((await appPayroll.listPayrollSyncs(await ctx())).length, 2);
});

/* ------------------------------- what was paid ------------------------------- */

test('processed payrolls are read back as pay results, with Gusto\'s own per-person taxes, and reading again changes nothing', async () => {
    const { ann, bob } = await setUp();
    const stranger = await mockPost('/app-employee', { first_name: 'Dee', last_name: 'Delta', email: 'dee@example.test' }); // in Gusto, not matched here
    const paid = await mockPost('/app-payroll-processed', { start_date: '2026-11-02', end_date: '2026-11-08', check_date: '2026-11-13', people: [
        { employee_uuid: ann.uuid, gross: 800, net: 640, tax: 160, employer_tax: 61.2, hours: 40 },
        { employee_uuid: bob.uuid, gross: 300.5, net: 250.25, tax: 50.25, employer_tax: 22.99, hours: 20 },
        { employee_uuid: stranger.uuid, gross: 100, net: 90, tax: 10, employer_tax: 7.65, hours: 5 }] });
    const coming = await mockPost('/app-payroll-processed', { start_date: '2026-11-09', end_date: '2026-11-15', check_date: '2026-11-20', off_cycle: true, people: [{ employee_uuid: ann.uuid, gross: 50, net: 40, tax: 10, employer_tax: 3.83, hours: 0 }] });

    const out = await appPayroll.pullPayResults(await ctx(), {}, { actor: 'pay1' });
    assert.deepEqual([out.from, out.to, out.payrolls, out.rows, out.unmatched, out.failed], ['2026-08-19', TODAY, 2, 3, 1, 0]);
    const annRow = [...results.values()].find((r) => r.userId === 'u1' && r.payrollUuid === paid.payroll_uuid);
    assert.deepEqual([annRow.gross, annRow.net, annRow.employeeTaxes, annRow.employerTaxes, annRow.hours, annRow.allocated, annRow.status, annRow.payDate, annRow.periodStart, annRow.employeeId, annRow.department, annRow.source],
        [800, 640, 160, 61.2, 40, false, 'paid', '2026-11-13', '2026-11-02', 'E-u1', 'Front desk', 'gusto']);
    assert.equal([...results.values()].find((r) => r.payrollUuid === coming.payroll_uuid).status, 'submitted', 'the pay date has not come yet');

    await appPayroll.pullPayResults(await ctx());
    assert.equal(results.size, 3, 'no doubles');
    const list = await appPayroll.listPayResults(await ctx());
    assert.deepEqual(list.payrolls.map((p) => [p.payDate, p.people, p.gross, p.net, p.estimated]), [['2026-11-20', 1, 50, 40, false], ['2026-11-13', 2, 1100.5, 890.25, false]]);
    assert.deepEqual([list.totals.gross, list.totals.employerCost, list.lastPull.payrolls], [1150.5, 1238.52, 2]);
    assert.equal((await appPayroll.listPayResults(await ctx(), { from: '2026-11-14' })).payrolls.length, 1);

    await assert.rejects(async () => appPayroll.pullPayResults(await ctx(), { start: '2025-01-01', end: '2026-11-17' }), (e) => e.code === 'validation');
    await assert.rejects(async () => appPayroll.pullPayResults(await ctx(), { start: 'soon' }), (e) => e.code === 'validation');
});

test('one payroll that cannot be read does not stop the others, and is written to the error list', async () => {
    const { ann } = await setUp();
    await mockPost('/app-payroll-processed', { start_date: '2026-10-26', end_date: '2026-11-01', check_date: '2026-11-06', people: [{ employee_uuid: ann.uuid, gross: 700, net: 560, tax: 140, employer_tax: 53.55, hours: 35 }] });
    const second = await mockPost('/app-payroll-processed', { start_date: '2026-11-02', end_date: '2026-11-08', check_date: '2026-11-13', people: [{ employee_uuid: ann.uuid, gross: 800, net: 640, tax: 160, employer_tax: 61.2, hours: 40 }] });
    await mockPost('/fail', { kind: '500', path: `/payrolls/${second.payroll_uuid}`, method: 'GET', times: 5 });
    const out = await appPayroll.pullPayResults(await ctx());
    assert.deepEqual([out.payrolls, out.rows, out.failed, out.problems[0].payrollUuid], [1, 1, 1, second.payroll_uuid]);
    assert.equal((await store.listErrors(ORG)).filter((e) => e.scope === 'pay_results').length, 1);
    await mockPost('/reset');
});

/* ------------------------------- disconnecting ------------------------------- */

test('disconnecting asks Gusto to cancel the tokens, forgets them here, and switches sending by itself off', async () => {
    await setUp();
    await sheets.setAutoSend(await ctx(), true, 'owner1');
    const before = await store.getCompanyTokens(ORG);
    const c = await ctx();
    assert.deepEqual(await appConnect.disconnect(c), { revokedAtGusto: true });
    assert.equal(c.conn.status, 'disconnected');
    assert.equal(await store.getCompanyTokens(ORG), null);
    assert.equal((await store.getConnection(ORG)).autoSendHours, false);
    // the token we held no longer works at Gusto, and cannot be renewed
    const r = await fetch(`${baseUrl}/v1/token_info`, { headers: { authorization: `Bearer ${before.accessToken}` } });
    assert.equal(r.status, 401);
    const renew = await fetch(`${baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: 'mock-client-id', client_secret: 'mock-client-secret', grant_type: 'refresh_token', refresh_token: before.refreshToken, redirect_uri: RETURN_TO }) });
    assert.equal(renew.status, 400);
});

test('disconnecting still works here when Gusto cannot be reached', async () => {
    await setUp();
    const c = await makeContext(ORG, { ...deps(), fetchImpl: async () => { throw new Error('network down'); } });
    assert.deepEqual(await appConnect.disconnect(c), { revokedAtGusto: false });
    assert.equal(await store.getCompanyTokens(ORG), null);
    assert.equal((await store.getConnection(ORG)).status, 'disconnected');
});
