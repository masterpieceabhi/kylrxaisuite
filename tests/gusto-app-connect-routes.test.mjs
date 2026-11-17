// The two routes for connecting a customer's own Gusto account (GUSTO_INTEGRATION=app), run in this process:
// the real router and services, the mock provider on a random port, the gusto store in memory, and the same
// stand-ins for sign-in, the US-company guard, the audit log and Firestore as gusto-extras-routes.test.mjs.
// What this does NOT cover: real sign-in tokens, real Firestore, and the real Gusto demo environment.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-gusto-integration';
process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);

/* ------------------------------- stand-ins, installed before the router loads ------------------------------- */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const merge = (a, b) => { const o = { ...(a || {}) }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' ? merge(o[k], v) : v; return o; };
const db = new Map();
const colOf = (name) => { if (!db.has(name)) db.set(name, new Map()); return db.get(name); };
function fakeCollection(name) {
    const col = colOf(name);
    const doc = (id) => {
        const ref = {
            id,
            async get() { const d = col.get(id); return { id, exists: d !== undefined, data: () => clone(d), ref }; },
            async set(d, o) { col.set(id, o && o.merge ? merge(col.get(id), clone(d)) : clone(d)); },
            async create(d) { if (col.has(id)) throw Object.assign(new Error('6 ALREADY_EXISTS: already exists'), { code: 6 }); col.set(id, clone(d)); },
            async update(patch) { const cur = clone(col.get(id)) || {}; for (const [k, v] of Object.entries(patch)) { const parts = k.split('.'); let o = cur; while (parts.length > 1) { const p = parts.shift(); o[p] = o[p] && typeof o[p] === 'object' ? o[p] : {}; o = o[p]; } o[parts[0]] = clone(v); } col.set(id, cur); },
            async delete() { col.delete(id); }
        };
        return ref;
    };
    const query = (filters) => ({
        where: (f, op, v) => query([...filters, [f, v]]),
        limit: () => query(filters),
        async get() { const docs = [...col.entries()].filter(([, d]) => filters.every(([f, v]) => d[f] === v)).map(([id, d]) => ({ id, exists: true, data: () => clone(d), ref: doc(id) })); return { docs, empty: !docs.length }; }
    });
    return { doc: (id) => doc(id || `auto${Math.random().toString(16).slice(2)}`), where: (f, op, v) => query([[f, v]]), get: () => query([]).get(), async add(d) { const id = `auto${Math.random().toString(16).slice(2)}`; col.set(id, clone(d)); return { id }; } };
}
const audits = [];
const USERS = {};
const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] }; };
stub('../config/firebase.js', { admin: {}, db: { collection: fakeCollection }, messaging: {}, rawCollection: fakeCollection });
stub('../utils/logger.js', { info() {}, warn() {}, error() {}, debug() {} });
stub('../middleware/authMiddleware.js', { verifyToken: (req, res, next) => { const u = USERS[req.headers['x-test-user']]; if (!u) return res.status(401).json({ success: false, error: 'Sign in' }); req.user = u; return next(); } });
const usHr = () => {};
usHr.helpers = {
    requireUsOrg: (req, res, next) => { if (req.user.orgId === 'org_india') return res.status(409).json({ success: false, error: 'This organization is not a US company' }); req.orgId = req.user.orgId; req.org = {}; return next(); },
    audit: async (orgId, req, action, targetId, extra) => { audits.push({ orgId, by: req.user.id, action, targetId, extra }); },
    findEmployee: async (orgId, id) => { const d = colOf('users').get(id); return d && d.orgId === orgId ? { id, data: clone(d), ref: fakeCollection('users').doc(id) } : null; }
};
stub('../routes/us-hr.js', usHr);
const timeStub = () => {}; timeStub.helpers = { orgInfo: async () => ({ tz: 'America/Chicago', country: 'US', rules: {} }) };
stub('../routes/time.js', timeStub);

const express = require('express');
const { createMockGusto } = require('../services/gusto/mock-server.js');
const { createMemoryStore, setDefaultStore } = require('../services/gusto/store.js');
const { resetAppState } = require('../services/gusto/client.js');

const ORG = 'org_test_app_routes';
let server; let base; let mock; let mockUrl; let store;
const saved = {};
const ENV = ['GUSTO_INTEGRATION', 'GUSTO_MODE', 'GUSTO_MOCK_URL', 'GUSTO_REDIRECT_URI', 'GUSTO_AUTHORIZE_URL', 'GUSTO_BASE_URL', 'GUSTO_CLIENT_ID', 'GUSTO_CLIENT_SECRET'];
Object.assign(USERS, {
    owner: { id: 'owner1', role: 'super_admin', orgId: ORG, email: 'owner@example.test' },
    acct: { id: 'acct1', role: 'accountant', orgId: ORG },
    ann: { id: 'u1', role: 'employee', orgId: ORG },
    india: { id: 'in1', role: 'super_admin', orgId: 'org_india' }
});
const call = async (user, method, path, body) => {
    const res = await fetch(`${base}/api/us/gusto${path}`, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : await res.text() };
};
const mockPost = (path, body) => fetch(`${mockUrl}/__mock${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
/** The owner's browser: Gusto's approval page, then the address Gusto sends it back to. Returns where our server finally sends the browser. */
async function approveAndReturn(url) {
    const atGusto = await fetch(url, { redirect: 'manual' });
    assert.equal(atGusto.status, 302);
    const back = atGusto.headers.get('location');
    assert.ok(back.startsWith(`${base}/api/us/gusto/oauth/callback?`), 'Gusto sends the browser to our registered address');
    const ours = await fetch(back, { redirect: 'manual' }); // note: no sign-in header, exactly like the real redirect
    return { status: ours.status, to: ours.headers.get('location'), cache: ours.headers.get('cache-control') };
}

test.before(async () => {
    for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    mock = createMockGusto(); mockUrl = (await mock.listen(0)).url;
    const app = express(); app.use(express.json());
    app.use('/api/us/gusto', require('../routes/us-gusto.js'));
    app.use((err, req, res, next) => { res.status(500).json({ success: false, error: `unhandled: ${err.message}` }); }); // eslint-disable-line no-unused-vars
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    process.env.GUSTO_INTEGRATION = 'app';
    process.env.GUSTO_MODE = 'mock';
    process.env.GUSTO_MOCK_URL = mockUrl;
    process.env.GUSTO_REDIRECT_URI = `${base}/api/us/gusto/oauth/callback`;
});
test.after(async () => {
    await new Promise((r) => server.close(r)); await mock.close();
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
test.beforeEach(async () => { store = createMemoryStore(); setDefaultStore(store); resetAppState(); audits.length = 0; await mockPost('/reset'); });

test('only a signed-in person who may connect payroll can start; the return address itself needs no sign-in', async () => {
    assert.equal((await call(null, 'POST', '/oauth/start')).status, 401);
    assert.equal((await call('ann', 'POST', '/oauth/start')).status, 403, 'employee');
    assert.equal((await call('acct', 'POST', '/oauth/start')).status, 403, 'read-only role');
    assert.equal((await call('india', 'POST', '/oauth/start')).status, 409, 'not a US company');
    const ok = await call('owner', 'POST', '/oauth/start');
    assert.equal(ok.status, 200);
    assert.ok(ok.body.url.startsWith(`${mockUrl}/oauth/authorize?`));
    assert.ok(!JSON.stringify(ok.body).includes('mock-client-secret'));
    assert.deepEqual(audits.map((a) => a.action), ['gusto_connect_started']);
    // the return address is public, but without a state we issued it only ever says "failed"
    const bare = await call(null, 'GET', '/oauth/callback');
    assert.equal(bare.status, 303);
    assert.equal(bare.headers.get('location'), '/admin-us-payroll.html?gusto=failed&why=bad_state');
});

test('the whole round trip through the routes connects the company', async () => {
    const company = await mockPost('/app-company', { name: 'Harbor Motel LLC' });
    const start = await call('owner', 'POST', '/oauth/start');
    const end = await approveAndReturn(start.body.url);
    assert.equal(end.status, 303);
    assert.equal(end.to, '/admin-us-payroll.html?gusto=connected');
    assert.equal(end.cache, 'no-store');

    const status = await call('owner', 'GET', '/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.integration, 'app');
    assert.equal(status.body.connection.connected, true);
    assert.equal(status.body.connection.companyUuid, company.uuid);
    assert.equal(status.body.connection.companyName, 'Harbor Motel LLC');
    assert.ok(!JSON.stringify(status.body).match(/accessEnc|refreshEnc|stateHash/), 'no token material in the status');

    // the same return link opened a second time does nothing
    const again = await call('owner', 'POST', '/oauth/start');
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'already_connected');
});

test('nothing Gusto or a visitor sends is echoed back by the return address', async () => {
    const nasty = encodeURIComponent('"><script>alert(1)</script>');
    for (const qs of [`?state=${nasty}&code=${nasty}`, `?error=${nasty}&state=abc.def`, '?state=YWJj.x&code=y', `?state[]=a&code[]=b`]) {
        const r = await call(null, 'GET', `/oauth/callback${qs}`);
        assert.equal(r.status, 303, qs);
        assert.match(r.headers.get('location'), /^\/admin-us-payroll\.html\?gusto=failed&why=[a-z_]+$/, qs);
        assert.ok(!String(r.body).includes('script'), qs);
    }
});

test('declining at Gusto comes back as "declined" and connects nothing', async () => {
    await mockPost('/app-company');
    await mockPost('/deny-next-authorize');
    const start = await call('owner', 'POST', '/oauth/start');
    const end = await approveAndReturn(start.body.url);
    assert.equal(end.to, '/admin-us-payroll.html?gusto=failed&why=declined');
    assert.equal((await call('owner', 'GET', '/status')).body.connection.connected, false);
});

test('actions that only Embedded Payroll may do are refused before they reach Gusto', async () => {
    await mockPost('/app-company');
    await approveAndReturn((await call('owner', 'POST', '/oauth/start')).body.url);
    const before = (await fetch(`${mockUrl}/__mock/stats`).then((r) => r.json())).requests;
    for (const [method, path] of [['POST', '/connect'], ['GET', '/setup'], ['POST', '/setup/terms'], ['POST', '/payroll/prepare'], ['POST', '/payroll/x/submit'], ['POST', '/off-cycle'], ['POST', '/contractor-payments'], ['GET', '/tax-forms'], ['GET', '/my/pay-stubs'], ['POST', '/sync/time-off'], ['POST', '/garnishments'], ['POST', '/benefit-deductions/send']]) {
        const r = await call('owner', method, path, method === 'GET' ? undefined : {});
        assert.equal(r.status, 409, `${method} ${path}`);
        assert.equal(r.body.code, 'app_integration', `${method} ${path}`);
    }
    assert.equal((await fetch(`${mockUrl}/__mock/stats`).then((r) => r.json())).requests, before, 'none of them called the provider');
    // still refused to people who may not use payroll at all, with the usual answer
    assert.equal((await call(null, 'POST', '/payroll/prepare', {})).status, 401);
});

test('disconnecting forgets the tokens, and the company can connect again', async () => {
    await mockPost('/app-company');
    await approveAndReturn((await call('owner', 'POST', '/oauth/start')).body.url);
    assert.equal((await call('owner', 'POST', '/disconnect', {})).status, 400, 'needs confirm');
    assert.equal((await call('ann', 'POST', '/disconnect', { confirm: true })).status, 403);
    assert.equal((await call('owner', 'POST', '/disconnect', { confirm: true })).status, 200);
    assert.equal(await store.getCompanyTokens(ORG), null);
    assert.equal((await call('owner', 'GET', '/status')).body.connection.connected, false);
    const end = await approveAndReturn((await call('owner', 'POST', '/oauth/start')).body.url);
    assert.equal(end.to, '/admin-us-payroll.html?gusto=connected');
});

test('a server set up for Embedded Payroll keeps working as before and refuses the new start route', async () => {
    process.env.GUSTO_INTEGRATION = 'embedded';
    try {
        const r = await call('owner', 'POST', '/oauth/start');
        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'not_app_integration');
        assert.equal((await call('owner', 'GET', '/setup')).status, 200, 'embedded routes are not blocked');
        assert.equal((await call('owner', 'GET', '/status')).body.integration, 'embedded');
    } finally { process.env.GUSTO_INTEGRATION = 'app'; }
});

/* ------------------------------- matching people and sending hours, through the routes ------------------------------- */

const userDoc = (name, email, extra = {}) => {
    const [first, last] = name.split(' ');
    return { orgId: ORG, name, email, status: 'Active', usProfile: { legalFirstName: first, legalLastName: last, dateOfBirth: '1990-04-12', classification: 'W2', payType: 'hourly', flsaStatus: 'non_exempt', ...extra } };
};
const approvedWeek = (userId, weekStart, days) => ({ orgId: ORG, userId, weekStart, weekEnd: '2026-11-15', status: 'approved', timeZone: 'America/Chicago', days });
const workDay = (date, regular, overtime = 0) => ({ date, workedHours: regular + overtime, regularHours: regular, overtimeHours: overtime, doubleTimeHours: 0, premiumHours: 0, startAt: `${date}T15:00:00.000Z`, endAt: `${date}T23:30:00.000Z` });

test('matching and sending hours through the routes: who may do what, and the whole path', async () => {
    Object.assign(USERS, { pay: { id: 'pay1', role: 'payroll_admin', orgId: ORG } });
    colOf('users').clear(); colOf('timesheet_weeks').clear();
    colOf('users').set('u1', userDoc('Ann Alpha', 'ann@example.test'));
    colOf('users').set('u2', userDoc('Bob Beta', 'bob@example.test'));
    await mockPost('/app-company', { name: 'Harbor Motel LLC' });
    await approveAndReturn((await call('owner', 'POST', '/oauth/start')).body.url);
    const ann = await mockPost('/app-employee', { first_name: 'Ann', last_name: 'Alpha', email: 'ann@example.test', date_of_birth: '1990-04-12' });
    colOf('timesheet_weeks').set('u1_2026-11-09', approvedWeek('u1', '2026-11-09', [workDay('2026-11-09', 8), workDay('2026-11-10', 8, 1.5)]));
    colOf('timesheet_weeks').set('u2_2026-11-09', approvedWeek('u2', '2026-11-09', [workDay('2026-11-09', 6)]));

    // who may look, and who may act
    for (const path of ['/match', '/time-sheets/preview?start=2026-11-09&end=2026-11-15', '/time-sheets?start=2026-11-09&end=2026-11-15']) {
        assert.equal((await call(null, 'GET', path)).status, 401, path);
        assert.equal((await call('ann', 'GET', path)).status, 403, `employee ${path}`);
        assert.equal((await call('acct', 'GET', path)).status, 200, `read-only role may look ${path}`);
    }
    for (const [method, path] of [['POST', '/match/confirm'], ['POST', '/time-sheets/send'], ['DELETE', '/match/u1']]) {
        assert.equal((await call('acct', method, path, method === 'DELETE' ? undefined : {})).status, 403, `read-only role ${method} ${path}`);
        assert.equal((await call('ann', method, path, method === 'DELETE' ? undefined : {})).status, 403, `employee ${method} ${path}`);
    }

    const m = await call('pay', 'GET', '/match');
    assert.deepEqual(m.body.rows.map((r) => [r.userId, r.state]), [['u1', 'suggested'], ['u2', 'unmatched']]);
    assert.equal((await call('pay', 'POST', '/match/confirm', { pairs: [] })).status, 400);
    const saved = await call('pay', 'POST', '/match/confirm', { pairs: [{ userId: 'u1', gustoUuid: ann.uuid }] });
    assert.equal(saved.status, 200); assert.equal(saved.body.saved, 1);

    assert.equal((await call('pay', 'GET', '/time-sheets/preview?start=nonsense&end=2026-11-15')).status, 400);
    const p = await call('pay', 'GET', '/time-sheets/preview?start=2026-11-09&end=2026-11-15');
    assert.equal(p.status, 200);
    assert.deepEqual(p.body.counts, { send: 2, update: 0, none: 0, remove: 0 });
    assert.deepEqual(p.body.issues.map((i) => i.code), ['not_matched'], 'Bob is approved but not matched yet');

    const sent = await call('pay', 'POST', '/time-sheets/send', { start: '2026-11-09', end: '2026-11-15' });
    assert.equal(sent.status, 200);
    assert.deepEqual([sent.body.created, sent.body.failed], [2, 0]);
    const at = await fetch(`${mockUrl}/__mock/time-sheets`).then((r) => r.json());
    assert.equal(at.length, 2);
    assert.ok(at.every((t) => t.entity_uuid === ann.uuid && t.job_uuid === ann.job_uuid));
    const list = await call('acct', 'GET', '/time-sheets?start=2026-11-09&end=2026-11-15');
    assert.deepEqual(list.body.data.map((r) => [r.key, r.status]), [['u1_2026-11-09', 'sent'], ['u1_2026-11-10', 'sent']]);
    assert.equal(list.body.lastSend.by, 'pay1');
    assert.deepEqual(audits.map((a) => a.action).filter((a) => a !== 'gusto_connect_started'), ['gusto_people_matched', 'gusto_hours_sent']);

    assert.equal((await call('pay', 'DELETE', '/match/u1')).status, 200);
    assert.equal((await call('pay', 'DELETE', '/match/u1')).status, 404);
});

test('checking matches, sending by itself, hours onto a payroll and reading pay back, through the routes', async () => {
    Object.assign(USERS, { pay: { id: 'pay1', role: 'payroll_admin', orgId: ORG } });
    colOf('users').clear(); colOf('timesheet_weeks').clear(); colOf('pay_results').clear();
    colOf('users').set('u1', userDoc('Ann Alpha', 'ann@example.test'));
    await mockPost('/app-company', { name: 'Harbor Motel LLC' });
    await approveAndReturn((await call('owner', 'POST', '/oauth/start')).body.url);
    const ann = await mockPost('/app-employee', { first_name: 'Ann', last_name: 'Alpha', email: 'ann@example.test', date_of_birth: '1990-04-12' });
    const day = new Date().toISOString().slice(0, 10);
    const sched = await mockPost('/app-pay-schedule', { frequency: 'Every week', anchor_end_of_pay_period: '2026-11-15', anchor_pay_date: '2026-11-20' });
    await call('pay', 'POST', '/match/confirm', { pairs: [{ userId: 'u1', gustoUuid: ann.uuid }] });

    // who may look, and who may act
    for (const path of ['/time-sheets/settings', '/pay-periods', '/payroll-syncs', '/pay-results']) {
        assert.equal((await call(null, 'GET', path)).status, 401, path);
        assert.equal((await call('ann', 'GET', path)).status, 403, `employee ${path}`);
        assert.equal((await call('acct', 'GET', path)).status, 200, `read-only role may look ${path}`);
    }
    for (const [method, path] of [['POST', '/match/refresh'], ['PUT', '/time-sheets/settings'], ['POST', '/payroll-syncs'], ['POST', '/pay-results/pull']]) {
        assert.equal((await call('acct', method, path, {})).status, 403, `read-only role ${method} ${path}`);
        assert.equal((await call('ann', method, path, {})).status, 403, `employee ${method} ${path}`);
    }

    // matches are checked again against Gusto
    const moved = await mockPost('/app-employee-change', { uuid: ann.uuid, new_job: true });
    const checked = await call('pay', 'POST', '/match/refresh', {});
    assert.equal(checked.status, 200);
    assert.deepEqual([checked.body.checked, checked.body.jobChanged.map((x) => x.userId)], [1, ['u1']]);
    assert.equal((await store.getLink(ORG, 'employee', 'u1')).jobUuid, moved.job_uuid);

    // sending by itself: off, then on
    assert.equal((await call('pay', 'GET', '/time-sheets/settings')).body.autoSend, false);
    assert.equal((await call('pay', 'PUT', '/time-sheets/settings', { autoSend: 'on' })).status, 400);
    assert.deepEqual((await call('pay', 'PUT', '/time-sheets/settings', { autoSend: true })).body, { success: true, autoSend: true });
    const set = await call('acct', 'GET', '/time-sheets/settings');
    assert.equal(set.body.autoSend, true); assert.equal(set.body.lastMatchCheck.checked, 1);

    // hours onto a payroll: the open period that holds the approved week
    const periods = await call('pay', 'GET', '/pay-periods');
    assert.equal(periods.status, 200);
    const open = periods.body.data.filter((p) => p.payScheduleUuid === sched.uuid);
    assert.ok(open.length > 5);
    const p = open.find((x) => x.start <= day && x.end >= day) || open[0];
    colOf('timesheet_weeks').set(`u1_${p.start}`, { ...approvedWeek('u1', p.start, [workDay(p.start, 8)]), weekEnd: p.end });
    const body = { payScheduleUuid: p.payScheduleUuid, start: p.start, end: p.end };
    const early = await call('pay', 'POST', '/payroll-syncs', body);
    assert.equal(early.status, 409); assert.equal(early.body.code, 'hours_not_sent');
    assert.equal((await call('pay', 'POST', '/time-sheets/send', { start: p.start, end: p.end })).body.created, 1);
    const started = await call('pay', 'POST', '/payroll-syncs', body);
    assert.equal(started.status, 202); assert.equal(started.body.sync.status, 'pending'); assert.equal(started.body.sync.startedBy, 'pay1');
    assert.equal((await call('pay', 'POST', '/payroll-syncs', body)).body.code, 'sync_in_progress');
    assert.equal((await call('acct', 'GET', '/payroll-syncs')).body.data[0].status, 'pending');
    assert.equal((await call('acct', 'GET', '/payroll-syncs?refresh=true')).body.data[0].status, 'success');
    assert.equal((await call('acct', 'GET', `/payroll-syncs/${started.body.sync.id}`)).body.sync.status, 'success');
    assert.equal((await call('acct', 'GET', '/payroll-syncs/unknown')).status, 404);

    // what was paid: read from Gusto and kept as pay results
    await mockPost('/app-payroll-processed', { start_date: '2026-11-02', end_date: '2026-11-08', check_date: '2026-11-13', people: [{ employee_uuid: ann.uuid, gross: 800, net: 640, tax: 160, employer_tax: 61.2, hours: 40 }] });
    assert.equal((await call('pay', 'POST', '/pay-results/pull', { start: 'soon' })).status, 400);
    const pulled = await call('pay', 'POST', '/pay-results/pull', { start: '2026-10-01', end: '2026-11-30' });
    assert.equal(pulled.status, 200);
    assert.deepEqual([pulled.body.payrolls, pulled.body.rows, pulled.body.unmatched, pulled.body.failed], [1, 1, 0, 0]);
    assert.equal(colOf('pay_results').size, 1);
    const seen = await call('acct', 'GET', '/pay-results');
    assert.deepEqual(seen.body.payrolls.map((x) => [x.payDate, x.gross, x.net, x.people]), [['2026-11-13', 800, 640, 1]]);
    assert.equal(seen.body.lastPull.by, 'pay1');
    assert.equal((await call('acct', 'GET', '/pay-results?from=never')).status, 400);

    for (const a of ['gusto_matches_checked', 'gusto_auto_send_set', 'gusto_hours_put_on_payroll', 'gusto_pay_results_read']) assert.ok(audits.some((x) => x.action === a), `audit ${a}`);

    // disconnecting tells Gusto and says so
    const off = await call('owner', 'POST', '/disconnect', { confirm: true });
    assert.equal(off.status, 200); assert.equal(off.body.revokedAtGusto, true);
    assert.equal((await call('acct', 'GET', '/time-sheets/settings')).body.autoSend, false);
    assert.equal((await call('pay', 'GET', '/pay-periods')).body.code, 'not_connected');
});

test('the hours routes are refused on a server set up for Embedded Payroll', async () => {
    process.env.GUSTO_INTEGRATION = 'embedded';
    try {
        for (const [method, path] of [['GET', '/match'], ['GET', '/time-sheets/preview?start=2026-11-09&end=2026-11-15'], ['POST', '/time-sheets/send']]) {
            const r = await call('owner', method, path, method === 'GET' ? undefined : { start: '2026-11-09', end: '2026-11-15' });
            assert.equal(r.status, 409, `${method} ${path}`);
            assert.equal(r.body.code, 'not_app_integration', `${method} ${path}`);
        }
    } finally { process.env.GUSTO_INTEGRATION = 'app'; }
});
