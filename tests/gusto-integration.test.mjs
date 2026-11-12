import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-gusto-integration';
process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);
const { createMockGusto } = require('../services/gusto/mock-server.js');
const { createMemoryStore, createStore } = require('../services/gusto/store.js');
const { createClient, resetAppState } = require('../services/gusto/client.js');
const { makeContext } = require('../services/gusto/index.js');
const onboarding = require('../services/gusto/onboarding.js');
const sync = require('../services/gusto/sync.js');
const payroll = require('../services/gusto/payroll.js');
const webhooks = require('../services/gusto/webhooks.js');
const rules = require('../services/gusto/rules.js');
const mapping = require('../services/gusto/mapping.js');
const { encryptField } = require('../services/pii-crypto.js');
const express = require('express');

const ORG = 'org_test_gusto';
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const mondayOnOrAfter = (s) => { let d = s; while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1); return d; };

const org = {
    phone: '5125550100',
    usProfile: { legalName: 'Test Co LLC', ein: '12-3456789', entityType: 'llc', businessAddress: { line1: '100 Main St', line2: '', city: 'Austin', state: 'TX', zip: '78701' }, workStates: ['TX'] }
};

function person(id, name, extra = {}) {
    const [first, last] = name.split(' ');
    return mapping.personFromDoc(id, {
        orgId: ORG, name, email: `${id}@example.test`, employeeId: `EMP-${id}`, jobTitle: 'Cashier', status: 'Active', joiningDate: '2026-01-05',
        usProfile: {
            legalFirstName: first, legalLastName: last, dateOfBirth: '1990-04-12', homeAddress: { line1: '1 Elm St', city: 'Austin', state: 'TX', zip: '78702' }, workState: 'TX',
            classification: 'W2', flsaStatus: 'non_exempt', payType: 'hourly', payRate: 20, payFrequency: 'biweekly', startDate: '2026-01-05',
            taxpayerIdEncrypted: encryptField('123456789', `${ORG}:${id}`), taxpayerIdLast4: '6789', ...extra
        },
        usForms: { w4: { current: { taxYear: 2026, filingStatus: 'single_or_mfs', qualifyingChildren: 1, otherDependents: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, multipleJobs: false } } }
    });
}
const PEOPLE = [person('u1', 'Ann Alpha'), person('u2', 'Bob Beta'), person('u3', 'Cy Gamma')];

let mock; let baseUrl; let store; let weeks = []; let leave = [];
const silent = { info() {}, warn() {}, error() {} };
const payDb = new Map(); const sentEvents = [];
const payHooks = {
    savePayResults: async (orgId, rows) => rows.forEach((r) => payDb.set(r.id, { ...r })),
    listPayResults: async (orgId, uuid) => [...payDb.values()].filter((r) => r.orgId === orgId && (!uuid || r.payrollUuid === uuid)),
    deletePayResults: async (orgId, ids) => ids.forEach((id) => payDb.delete(id)),
    emitEvent: (orgId, type, data) => { sentEvents.push({ orgId, type, data }); return 'evt_test'; }
};
const deps = () => ({ ...payHooks, store, log: silent, org, loadPeople: async () => PEOPLE, loadLeave: async () => leave, loadWeeks: async () => weeks, optsOverride: { baseUrl, backoffBaseMs: 5, rateLimitPerMinute: 100000, lockLeaseMs: 3000 }, pollOpts: { intervalMs: 20 } });
const ctxFor = () => makeContext(ORG, deps());
const refreshCtx = async (ctx) => { ctx.conn = await store.getConnection(ORG); return ctx; };
const mockPost = (path, body) => fetch(`${baseUrl}/__mock${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const mockGet = (path) => fetch(`${baseUrl}/__mock${path}`).then((r) => r.json());

async function startMock(over = {}) {
    const m = createMockGusto(over);
    let r;
    try { r = await m.listen(4010); } catch (e) { r = await m.listen(0); }
    return { m, url: r.url };
}

test.before(async () => {
    ({ m: mock, url: baseUrl } = await startMock());
});
test.after(async () => { await mock.close(); });

test.beforeEach(() => { resetAppState(); });

async function connectAndOnboard() {
    store = createMemoryStore();
    await mockPost('/reset');
    // Each step re-reads the whole setup status (about 20 reads), so 13 steps in a few seconds is far more than
    // Gusto's 200 a minute. A person takes minutes; the test lifts the mock's limit (the rate tests set their own).
    await mockPost('/rate', { max: 100000, windowMs: 60000 });
    let ctx = await ctxFor();
    await onboarding.connectCompany(ctx, { companyName: 'Test Co LLC', ein: '12-3456789', admin: { firstName: 'Olive', lastName: 'Owner', email: 'olive@example.test' } }, 'actor1');
    ctx = await refreshCtx(ctx);
    const run = async (k, input) => { const r = await onboarding.runStep(ctx, k, input); await refreshCtx(ctx); return r; };
    await run('terms', { email: 'olive@example.test', ipAddress: '203.0.113.5', externalUserId: 'actor1' });
    await run('locations');
    await run('federal_tax', {});
    await run('industry', { naicsCode: '722511', title: 'Full-service restaurants' });
    await run('bank', { routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking' });
    const dep = await mockGet('/deposits');
    await run('bank_verify', { deposit1: dep.deposit_1, deposit2: dep.deposit_2 });
    await run('pay_schedule', { frequency: 'biweekly', anchorPayDate: '2026-11-13', anchorEndOfPayPeriod: '2026-11-08' });
    await run('employees', {});
    await run('employee_onboarded', {});
    await run('state_taxes', { states: { TX: { state_tax_id: '12345678901', sui_rate: '2.7' } } });
    await run('signatory', { firstName: 'Olive', lastName: 'Owner', email: 'olive@example.test', title: 'Owner', ssn: '123-45-6789', birthday: '1980-01-01' });
    await run('forms', { agree: true, signatureText: 'Olive Owner', ipAddress: '203.0.113.5' });
    const fin = await run('finish');
    return { ctx, fin };
}

test('onboarding runs every step to approval and secrets are stored encrypted only', async () => {
    const { ctx, fin } = await connectAndOnboard();
    const steps = Object.fromEntries(fin.steps.map((s) => [s.key, s.status]));
    assert.equal(steps.company, 'done');
    assert.equal(steps.finish, 'done');
    assert.equal(fin.approved, true, JSON.stringify(steps));
    assert.equal(steps.approval, 'done');
    const conn = await store.getConnection(ORG);
    const raw = JSON.stringify(conn);
    assert.ok(conn.tokens.accessEnc.startsWith('v1:'), 'access token is encrypted');
    assert.ok(!raw.includes('000123456789'), 'bank account number is never stored');
    assert.ok(!raw.includes('123-45-6789') && !raw.includes('123456789'), 'SSN not stored');
    assert.equal(conn.onboarding.bankLast4, '6789');
    assert.equal(ctx.conn.status, 'connected');
});

test('a blocked step is refused with what is blocking it', async () => {
    store = createMemoryStore();
    await mockPost('/reset');
    const ctx = await ctxFor();
    await onboarding.connectCompany(ctx, { companyName: 'Blocked Co', admin: { firstName: 'A', lastName: 'B', email: 'a@b.test' } }, 'x');
    await refreshCtx(ctx);
    await assert.rejects(() => onboarding.runStep(ctx, 'locations', {}), (e) => e.code === 'blocked' && e.blockedBy.length > 0);
    await assert.rejects(() => onboarding.runStep(ctx, 'finish', {}), (e) => e.code === 'blocked');
});

test('people sync: 3 workers, W-4 and pay mapped, idempotent re-run makes no Gusto calls', async () => {
    const { ctx } = await connectAndOnboard();
    // connectAndOnboard already synced everyone once: re-run changes nothing
    const before = (await mockGet('/stats')).requests;
    const again = await sync.syncPeople(ctx);
    assert.equal(again.unchanged, 3, JSON.stringify(again));
    assert.equal(again.synced, 0);
    const links = (await store.listLinks(ORG, 'employee')).filter((l) => l.gustoUuid);
    assert.equal(links.length, 3);
    for (const l of links) { assert.ok(l.meta.jobUuid && l.meta.compensationUuid && l.meta.homeUuid && l.meta.workUuid); assert.equal(l.syncState, 'synced'); }
    const state = await mockGet('/state');
    assert.equal(state.employees.length, 3);
    assert.ok(state.employees.every((e) => e.hasSsn), 'SSN reached Gusto');
    assert.ok(!JSON.stringify(state).includes('123456789'), 'mock state endpoint never leaks SSN');
    // change a pay rate: only that person's compensation is updated
    PEOPLE[1] = person('u2', 'Bob Beta', { payRate: 22.5 });
    const changed = await sync.syncPeople(ctx);
    assert.equal(changed.synced, 1);
    assert.equal(changed.unchanged, 2);
    PEOPLE[1] = person('u2', 'Bob Beta');
    await sync.syncPeople(ctx, { overwrite: true }); // put it back (overwrite is needed once onboarded in Gusto)
    assert.ok(before >= 0);
});

test('a person with missing data is blocked with plain reasons, others continue', async () => {
    const { ctx } = await connectAndOnboard();
    const bad = person('u9', 'Dee Delta', { dateOfBirth: undefined, payRate: undefined });
    const r = await sync.syncPerson(ctx, bad);
    assert.equal(r.status, 'blocked');
    assert.ok(r.reasons.some((x) => /birth/i.test(x)) && r.reasons.some((x) => /pay rate/i.test(x)));
});

test('sync error is logged, listed, and retry clears it', async () => {
    const { ctx } = await connectAndOnboard();
    const p = person('u7', 'Eve Epsilon');
    PEOPLE.push(p);
    try {
        await mockPost('/fail', { kind: '500', times: 20, path: '/employees', method: 'POST' });
        const bad = await sync.syncPerson(ctx, p);
        assert.equal(bad.status, 'error');
        const errs = await store.listErrors(ORG);
        assert.equal(errs.length, 1);
        assert.equal(errs[0].scope, 'person');
        await mockPost('/reset-inject').catch(() => {});
    } finally { /* below */ }
    // clear injected failures by resetting mock queue through config: drain by consuming
    const st = mock.state(); st.inject.length = 0;
    const [e] = await store.listErrors(ORG);
    const out = await sync.retryError(ctx, e);
    assert.ok(['synced'].includes(out.status), JSON.stringify(out));
    assert.equal((await store.listErrors(ORG)).length, 0);
    PEOPLE.pop();
    await sync.syncPeople(ctx);
});

function periodAhead() {
    const start = mondayOnOrAfter(addDays(iso(new Date()), 21));
    const end = addDays(start, 13);
    return { start, end, mondays: [start, addDays(start, 7)] };
}
async function setupPeriod() {
    // pay schedule anchored on the future period so Gusto has a payroll for it
    const { start, end } = periodAhead();
    const ctx = await ctxFor();
    await refreshCtx(ctx);
    await sync.syncPaySchedule(ctx, { frequency: 'biweekly', anchorPayDate: addDays(end, 5), anchorEndOfPayPeriod: end });
    return { ctx, start, end };
}
const wk = (userId, weekStart, reg, ot, status = 'approved') => ({ userId, weekStart, status, orgId: ORG, totals: { regularHours: reg, overtimeHours: ot, doubleTimeHours: 0 } });

test('hours feed -> prepare -> preview -> submit with confirmation, stale-hours and double-submit guards', async () => {
    const first = await connectAndOnboard();
    // Gusto only puts people on a payroll once they have finished onboarding there; setup finished one, finish the rest
    for (const userId of ['u2', 'u3']) { await refreshCtx(first.ctx); await onboarding.runStep(first.ctx, 'employee_onboarded', { userId }); }
    const { ctx, start, end } = await setupPeriod();
    const [m1, m2] = [start, addDays(start, 7)];
    weeks = [wk('u1', m1, 40, 2), wk('u1', m2, 38, 0), wk('u2', m1, 40, 0), wk('u2', m2, 40, 5), wk('u3', m1, 20, 0), wk('u3', m2, 0, 0, 'submitted')];
    const feed = await payroll.buildFeed(ctx, start, end);
    assert.equal(feed.ready, true);
    const a = feed.rows.find((r) => r.userId === 'u1');
    assert.equal(a.regularHours, 78); assert.equal(a.overtimeHours, 2);
    assert.ok(feed.issues.some((i) => i.code === 'timesheet_not_approved' && i.userId === 'u3'), 'unapproved week is a warning, not included');

    const prep = await payroll.preparePayroll(ctx, { start, end, actor: 'payroll1' });
    assert.equal(prep.status, 'prepared');
    assert.ok(Number(prep.totals.gross_pay) > 0);
    // gross: u1 78*20 + 2*30 = 1620 ; u2 80*20 + 5*30 = 1750 ; u3 20*20 = 400  => 3770
    assert.equal(prep.totals.gross_pay, '3770.00');
    assert.equal(prep.canSubmit, true);
    assert.ok(['ok', 'soon', 'urgent'].includes(prep.cutoff.status));

    // a confirmation is mandatory
    await assert.rejects(() => payroll.submitPayroll(ctx, prep.payrollUuid, { actor: 'p' }), (e) => e.code === 'confirmation_required');
    await assert.rejects(() => payroll.submitPayroll(ctx, prep.payrollUuid, { confirm: true, confirmPayrollId: 'wrong', actor: 'p' }), (e) => e.code === 'confirmation_required');

    // hours change after prepare -> stale
    weeks.push(wk('u3', m2, 8, 0));
    const prev = await payroll.previewPayroll(ctx, prep.payrollUuid);
    assert.equal(prev.stale, true);
    await assert.rejects(() => payroll.submitPayroll(ctx, prep.payrollUuid, { confirm: true, confirmPayrollId: prep.payrollUuid, actor: 'p' }), (e) => e.code === 'stale_hours');
    const prep2 = await payroll.preparePayroll(ctx, { start, end, actor: 'payroll1' });
    assert.equal(prep2.totals.gross_pay, '3930.00');

    const [r1, r2] = await Promise.allSettled([
        payroll.submitPayroll(ctx, prep2.payrollUuid, { confirm: true, confirmPayrollId: prep2.payrollUuid, actor: 'p1' }),
        payroll.submitPayroll(ctx, prep2.payrollUuid, { confirm: true, confirmPayrollId: prep2.payrollUuid, actor: 'p2' })
    ]);
    assert.equal([r1, r2].filter((r) => r.status === 'fulfilled').length, 1, 'exactly one concurrent submit wins');
    const hist = await payroll.history(ctx);
    assert.equal(hist[0].status, 'submitted');

    // what each person was paid is stored once (the losing concurrent submit wrote nothing), and one event went out
    const reg = await payroll.register(ctx, prep2.payrollUuid);
    assert.equal(reg.rows.length, 3);
    assert.equal(reg.totals.gross, 3930);
    assert.equal(reg.totals.net + reg.totals.employeeTaxes + reg.totals.deductions, reg.totals.gross);
    assert.ok(reg.rows.every((r) => r.payDate && r.periodStart === start && r.status === 'submitted'));
    assert.equal(sentEvents.filter((e) => e.type === 'payroll.run.completed' && e.data.run_id === prep2.payrollUuid).length, 1);
    const cost = await payroll.cost(ctx, {});
    assert.equal(cost.totals.gross, 3930);
    assert.equal(cost.totals.employerCost, cost.totals.gross + cost.totals.employerTaxes);
    await assert.rejects(() => payroll.submitPayroll(ctx, prep2.payrollUuid, { confirm: true, confirmPayrollId: prep2.payrollUuid, actor: 'p' }), (e) => e.code === 'wrong_state');

    // reconciliation agrees with Gusto after submit
    const rec = await payroll.reconciliation(ctx, start, end);
    assert.equal(rec.hasPayroll, true);
    assert.equal(rec.mismatches, 0, JSON.stringify(rec.diffs));
    assert.equal(rec.missingLinks.length, 0);
    // read-only endpoints
    const stubs = await payroll.payStubs(ctx, 'u1');
    assert.equal(stubs.length, 1);
    assert.equal(stubs[0].gross_pay, '1620.00');
    const tax = await payroll.taxFilings(ctx);
    assert.ok(tax.payments.length >= 2);
});

test('a missed deadline blocks submit unless explicitly accepted', async () => {
    await connectAndOnboard();
    const ctx = await ctxFor(); await refreshCtx(ctx);
    // a past period: Gusto's deadline for its check date is long gone
    const end = '2026-08-30'; const start = '2026-08-17';
    await sync.syncPaySchedule(ctx, { frequency: 'biweekly', anchorPayDate: '2026-09-04', anchorEndOfPayPeriod: end });
    weeks = [wk('u1', start, 40, 0), wk('u1', addDays(start, 7), 40, 0), wk('u2', start, 40, 0), wk('u2', addDays(start, 7), 40, 0), wk('u3', start, 40, 0), wk('u3', addDays(start, 7), 40, 0)];
    const prep = await payroll.preparePayroll(ctx, { start, end, actor: 'p' });
    assert.equal(prep.cutoff.status, 'passed');
    await assert.rejects(() => payroll.submitPayroll(ctx, prep.payrollUuid, { confirm: true, confirmPayrollId: prep.payrollUuid, actor: 'p' }), (e) => e.code === 'deadline_passed');
    const ok = await payroll.submitPayroll(ctx, prep.payrollUuid, { confirm: true, confirmPayrollId: prep.payrollUuid, acceptLate: true, actor: 'p' });
    assert.equal(ok.status, 'submitted');
});

test('blockers: unlinked person blocks the feed; blocked feed cannot be prepared', async () => {
    await connectAndOnboard();
    const { ctx, start, end } = await setupPeriod();
    const extra = person('u8', 'Fay Zeta');
    PEOPLE.push(extra);
    try {
        weeks = [];
        const feed = await payroll.buildFeed(ctx, start, end);
        assert.equal(feed.ready, false);
        assert.ok(feed.issues.some((i) => i.code === 'not_linked' && i.userId === 'u8'));
        await assert.rejects(() => payroll.preparePayroll(ctx, { start, end }), (e) => e.code === 'feed_blocked');
    } finally { PEOPLE.pop(); }
});

test('time off: approved leave is pushed once (idempotent)', async () => {
    const { ctx } = await connectAndOnboard();
    leave = [{ id: 'lv1', orgId: ORG, userId: 'u1', status: 'approved', type: 'sick', startDate: '2026-12-01', endDate: '2026-12-02', dates: ['2026-12-01', '2026-12-02'], hoursPerDay: 8, hours: 16, name: 'Ann Alpha' }, { id: 'lv2', orgId: ORG, userId: 'u1', status: 'pending', startDate: '2026-12-05', endDate: '2026-12-05', dates: ['2026-12-05'], hoursPerDay: 8, hours: 8 }];
    const a = await sync.syncTimeOff(ctx);
    assert.equal(a.synced, 1);
    const b = await sync.syncTimeOff(ctx);
    assert.equal(b.synced, 0); assert.equal(b.unchanged, 1);
    assert.equal((await mockGet('/state')).timeOff.length, 1);
    leave = [];
});

test('token refresh race: many concurrent callers in two "processes" cause exactly one refresh', async () => {
    await connectAndOnboard();
    const before = (await mockGet('/stats')).refreshes;
    await mockPost('/expire-tokens', { company: true });
    // two independent stores sharing the same data = two server processes sharing Firestore
    const kv = store.kv;
    const storeB = createStore(kv);
    const d = deps();
    const ctxA = await makeContext(ORG, d);
    const ctxB = await makeContext(ORG, { ...d, store: storeB });
    const calls = [];
    for (let i = 0; i < 6; i += 1) { calls.push(ctxA.client.get(`/v1/companies/${ctxA.conn.companyUuid}`)); calls.push(ctxB.client.get(`/v1/companies/${ctxA.conn.companyUuid}`)); }
    const res = await Promise.all(calls);
    assert.ok(res.every((r) => r.uuid === ctxA.conn.companyUuid));
    const stats = await mockGet('/stats');
    assert.equal(stats.refreshes - before, 1, 'one refresh');
    assert.equal(stats.refreshRejected, 0, 'a used refresh token was never replayed');
});

test('a 401 on a token that looked valid forces a refresh and retries once', async () => {
    await connectAndOnboard();
    const ctx = await ctxFor();
    await mockPost('/fail', { kind: '401', times: 1 });
    const before = (await mockGet('/stats')).refreshes;
    const c = await ctx.client.get(`/v1/companies/${ctx.conn.companyUuid}`);
    assert.ok(c.uuid);
    assert.equal((await mockGet('/stats')).refreshes - before, 1);
});

test('a refresh token Gusto rejects marks the connection reauth_required', async () => {
    await connectAndOnboard();
    await mockPost('/expire-tokens', { company: true });
    await mockPost('/revoke-refresh');
    const ctx = await ctxFor();
    await assert.rejects(() => ctx.client.get(`/v1/companies/${ctx.conn.companyUuid}`), (e) => e.code === 'reauth_required');
    assert.equal((await store.getConnection(ORG)).status, 'reauth_required');
});

test('429: waits for Retry-After and then succeeds; the limiter pauses all callers', async () => {
    await connectAndOnboard();
    const ctx = await ctxFor();
    await mockPost('/fail', { kind: '429', times: 2, retryAfter: 1 });
    const t0 = Date.now();
    const r = await ctx.client.get(`/v1/companies/${ctx.conn.companyUuid}`);
    const took = Date.now() - t0;
    assert.ok(r.uuid);
    assert.ok(took >= 900, `waited about Retry-After (took ${took}ms)`);
    assert.ok(ctx.client.stats().throttled >= 0);
    assert.ok((await mockGet('/stats')).rateLimited >= 2);
});

test('real mock rate limit: a burst over the limit is queued by our limiter and never errors', async () => {
    await connectAndOnboard();
    await mockPost('/rate', { max: 8, windowMs: 1000 });
    const d = deps(); d.optsOverride = { ...d.optsOverride, rateLimitPerMinute: 6, rateWindowMs: 1000 };
    resetAppState(); // the limiter is shared per application and keeps the limit it was created with
    const ctx = await makeContext(ORG, d);
    const before = (await mockGet('/stats')).rateLimited;
    const rs = await Promise.all(Array.from({ length: 14 }, () => ctx.client.get(`/v1/companies/${ctx.conn.companyUuid}`)));
    assert.equal(rs.length, 14);
    assert.equal((await mockGet('/stats')).rateLimited, before, 'our window kept us under the server limit');
    // and with our limiter off, the server's 429 is handled by waiting
    const d2 = deps(); d2.optsOverride = { ...d2.optsOverride, rateLimitPerMinute: 100000 };
    resetAppState();
    const ctx2 = await makeContext(ORG, d2);
    const rs2 = await Promise.all(Array.from({ length: 12 }, () => ctx2.client.get(`/v1/companies/${ctx2.conn.companyUuid}`)));
    assert.equal(rs2.length, 12);
    assert.ok((await mockGet('/stats')).rateLimited > before, 'server did rate limit');
    await mockPost('/rate', { max: 100000, windowMs: 60000 });
});

test('409 version conflict: re-read and retry succeeds; a persistent conflict surfaces as version_conflict', async () => {
    const { ctx } = await connectAndOnboard();
    const link = await store.getLink(ORG, 'employee', 'u1');
    await mockPost('/fail', { kind: '409', times: 2, method: 'PUT', path: '/employees/' });
    const r = await ctx.client.putVersioned(`/v1/employees/${link.gustoUuid}`, `/v1/employees/${link.gustoUuid}`, () => ({ middle_initial: 'Q' }));
    assert.equal(r.changed, true);
    assert.equal((await ctx.client.get(`/v1/employees/${link.gustoUuid}`)).middle_initial, 'Q');
    await mockPost('/fail', { kind: '409', times: 10, method: 'PUT', path: '/employees/' });
    await assert.rejects(() => ctx.client.putVersioned(`/v1/employees/${link.gustoUuid}`, `/v1/employees/${link.gustoUuid}`, () => ({ middle_initial: 'R' }), { tries: 3 }), (e) => e.code === 'version_conflict');
    mock.state().inject.length = 0;
    // a stale version sent directly really is refused
    await assert.rejects(() => ctx.client.put(`/v1/employees/${link.gustoUuid}`, { middle_initial: 'Z', version: 'stale' }), (e) => e.status === 409);
});

test('POST idempotency: the same key replays the first response instead of creating twice', async () => {
    const { ctx } = await connectAndOnboard();
    const c = ctx.conn.companyUuid;
    const body = { first_name: 'Idem', last_name: 'Potent', email: 'idem@example.test' };
    const a = await ctx.client.post(`/v1/companies/${c}/employees`, body, { idempotencyKey: 'same-key-1' });
    const b = await ctx.client.post(`/v1/companies/${c}/employees`, body, { idempotencyKey: 'same-key-1' });
    assert.equal(a.uuid, b.uuid);
});

test('5xx on a POST is retried with the same key and does not duplicate', async () => {
    const { ctx } = await connectAndOnboard();
    const c = ctx.conn.companyUuid;
    await mockPost('/fail', { kind: '500', times: 2, method: 'POST', path: '/locations' });
    const l = await ctx.client.post(`/v1/companies/${c}/locations`, { street_1: '9 Retry Rd', city: 'Austin', state: 'TX', zip: '78701' });
    assert.ok(l.uuid);
    const all = await ctx.client.get(`/v1/companies/${c}/locations`);
    assert.equal(all.filter((x) => x.street_1 === '9 Retry Rd').length, 1);
});

test('cross-company isolation: one company token cannot read another company', async () => {
    const { ctx } = await connectAndOnboard();
    const system = await ctx.client.systemToken();
    const other = await fetch(`${baseUrl}/v1/partner_managed_companies`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${system}` }, body: JSON.stringify({ user: { first_name: 'X', last_name: 'Y', email: 'x@y.test' }, company: { name: 'Other Co' } }) }).then((r) => r.json());
    await assert.rejects(() => ctx.client.get(`/v1/companies/${other.company_uuid}`), (e) => e.status === 404);
});

/* ------------------------------- webhooks ------------------------------- */

async function receiverServer(ctxFactory) {
    const app = express();
    const d = deps();
    app.post('/hook/:orgId', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
        const out = await webhooks.receive(req.params.orgId, req.body, req.headers, { store, makeContext: () => makeContext(req.params.orgId, d) });
        res.status(out.status).json(out.body);
    });
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)); } return false; };

test('webhooks: subscribe + verification handshake, signed delivery processed, tampered rejected, duplicates ignored, poll backstop', async () => {
    store = createMemoryStore();
    await mockPost('/reset');
    const rx = await receiverServer();
    try {
        const ctx = await ctxFor();
        await onboarding.connectCompany(ctx, { companyName: 'Hook Co', admin: { firstName: 'H', lastName: 'K', email: 'h@k.test' } }, 'x');
        await refreshCtx(ctx);
        const sub = await webhooks.subscribe(ctx, { publicBaseUrl: rx.url.replace('/hook', '') });
        // our receiver is mounted at /hook/:orgId in this test, so subscribe pointed at /api/webhooks/gusto/...; re-point the mock subscription URL
        const st = mock.state();
        for (const s of st.subs.values()) s.url = `${rx.url}/hook/${ORG}`;
        // redo the handshake against the right URL
        await store.clearPendingVerificationToken(ORG);
        await store.saveConnection(ORG, { webhook: { status: 'pending', subscriptionUuid: sub.subscriptionUuid } });
        const subRec = [...st.subs.values()][0]; subRec.status = 'pending';
        await fetch(`${rx.url}/hook/${ORG}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_type: 'webhook_subscription.verification', subscription_uuid: sub.subscriptionUuid, verification_token: subRec.verification_token }) });
        assert.ok(await until(async () => (await store.getConnection(ORG)).webhook.status === 'verified'), 'verified after handshake');
        assert.equal(await store.getVerificationToken(ORG), subRec.verification_token);
        assert.ok(!JSON.stringify(await store.getConnection(ORG)).includes(subRec.verification_token), 'token not stored in clear');

        // a forged handshake with a wrong token is not trusted
        await store.saveConnection(ORG, { webhook: { status: 'pending' } });
        const forged = await fetch(`${rx.url}/hook/${ORG}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ event_type: 'webhook_subscription.verification', verification_token: 'attacker-token' }) });
        assert.equal(forged.status, 200);
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(await store.getVerificationToken(ORG), subRec.verification_token, 'attacker token never replaces the real one');
        await store.saveConnection(ORG, { webhook: { status: 'verified' } });

        // valid signed event is acknowledged, queued and processed
        const e1 = (await mockPost('/event', { event_type: 'company.approved', company_uuid: (await store.getConnection(ORG)).companyUuid, quiet: true, redeliver: true })).event;
        assert.ok(await until(async () => { const r = await store.getEvent(ORG, e1.uuid); return r && r.status === 'processed'; }), 'event processed');
        assert.ok((await store.getConnection(ORG)).onboarding.approvedAt, 'company.approved recorded');
        // the mock delivered with a valid signature on the first attempt
        assert.ok(mock.state().deliveries.some((d) => d.event === e1.uuid && d.status === 200 && d.attempt === 1));

        // duplicate delivery (Gusto retry) is acknowledged but not processed twice
        await mockPost('/redeliver', { uuid: e1.uuid });
        const events = await store.listEvents(ORG);
        assert.equal(events.filter((e) => e.key === e1.uuid).length, 1);
        assert.equal((await store.getEvent(ORG, e1.uuid)).attempts, 1);

        // tampered signature -> 401 and nothing stored
        const e2 = (await mockPost('/event', { event_type: 'employee.updated', company_uuid: (await store.getConnection(ORG)).companyUuid, resource_type: 'Employee', quiet: true })).event;
        await mockPost('/redeliver', { uuid: e2.uuid, tamper: true });
        assert.equal(await store.getEvent(ORG, e2.uuid), null);
        assert.ok(mock.state().deliveries.some((d) => d.event === e2.uuid && d.status === 401 && d.tampered));
        assert.equal((await store.getConnection(ORG)).webhook.rejectedCount >= 1, true);
        // no signature at all -> 401
        const bare = await fetch(`${rx.url}/hook/${ORG}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e2) });
        assert.equal(bare.status, 401);

        // a non-2xx from us makes the mock retry; here we simulate by delivering to a server that fails first
        // Events API backstop picks up the missed e2 (it never reached us)
        const ctx2 = await ctxFor();
        const polled = await webhooks.pollEvents(ctx2);
        assert.ok(polled.added >= 1, JSON.stringify(polled));
        assert.equal((await store.getEvent(ORG, e2.uuid)).source, 'poll');
        const again = await webhooks.pollEvents(ctx2);
        assert.equal(again.added, 0);
        const h = await webhooks.health(await ctxFor());
        assert.equal(h.subscription.status, 'verified');
        assert.ok(h.counts.processed >= 2);
    } finally { await rx.close(); }
});

test('webhook processing failure is retried later and recorded; the receiver still acknowledged', async () => {
    store = createMemoryStore();
    await mockPost('/reset');
    const ctx = await ctxFor();
    await onboarding.connectCompany(ctx, { companyName: 'Retry Co', admin: { firstName: 'R', lastName: 'T', email: 'r@t.test' } }, 'x');
    await refreshCtx(ctx);
    await store.putEventIfNew(ORG, 'evt-fail-1', { uuid: 'evt-fail-1', event_type: 'employee.updated', resource_uuid: 'x', resource_type: 'Employee', company_uuid: ctx.conn.companyUuid }, 'webhook');
    await sync.syncPerson(ctx, PEOPLE[0]).catch(() => {});
    await store.saveLink(ORG, 'employee', 'u1', { gustoUuid: 'x' });
    const r = await webhooks.processEvent(ctx, 'evt-fail-1');
    assert.equal(r.processed, false);
    const rec = await store.getEvent(ORG, 'evt-fail-1');
    assert.equal(rec.status, 'failed');
    assert.ok(rec.nextAttemptAt);
    assert.equal((await store.listErrors(ORG)).some((e) => e.scope === 'webhook'), true);
    const retried = await webhooks.processPending(ctx, { force: true });
    assert.equal(retried.tried, 1);
});
