// Connecting a customer's own Gusto account (GUSTO_INTEGRATION=app): services/gusto/app-connect.js against the
// mock provider on a random port, with the gusto store in memory.
// What this does NOT cover: the two HTTP routes (sign-in, permissions, redirects), and the real Gusto demo
// environment, where a person has to sign in and approve.
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
const config = require('../services/gusto/config.js');
const appConnect = require('../services/gusto/app-connect.js');

const ORG = 'org_test_app_connect';
const RETURN_TO = 'http://localhost:3000/api/us/gusto/oauth/callback';
const silent = { info() {}, warn() {}, error() {} };
let mock; let baseUrl; let store;

const deps = (extra = {}) => ({
    store, log: silent,
    optsOverride: { baseUrl, integration: 'app', redirectUri: RETURN_TO, authorizeUrl: `${baseUrl}/oauth/authorize`, backoffBaseMs: 5, rateLimitPerMinute: 100000, lockLeaseMs: 3000, ...extra }
});
const ctx = (extra) => makeContext(ORG, deps(extra));
const mockPost = (path, body) => fetch(`${baseUrl}/__mock${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
/** Plays the owner's browser: opens the provider's approval address and returns what the provider sends back. */
async function approve(url) {
    const r = await fetch(url, { redirect: 'manual' });
    assert.equal(r.status, 302, 'the provider sends the browser back');
    const back = new URL(r.headers.get('location'));
    assert.equal(`${back.origin}${back.pathname}`, RETURN_TO);
    return { state: back.searchParams.get('state'), code: back.searchParams.get('code'), error: back.searchParams.get('error') };
}

test.before(async () => { mock = createMockGusto(); const r = await mock.listen(0); baseUrl = r.url; });
test.after(async () => { await mock.close(); });
test.beforeEach(async () => { store = createMemoryStore(); resetAppState(); await mockPost('/reset'); });

test('the address sent to the browser carries exactly what Gusto documents, and no secret', async () => {
    const out = await appConnect.startAuthorization(await ctx(), { actor: 'user_owner' });
    const u = new URL(out.url);
    assert.equal(`${u.origin}${u.pathname}`, `${baseUrl}/oauth/authorize`);
    assert.deepEqual([...u.searchParams.keys()].sort(), ['client_id', 'redirect_uri', 'response_type', 'state']);
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('redirect_uri'), RETURN_TO);
    assert.ok(!out.url.includes('mock-client-secret'));
    const saved = (await store.getConnection(ORG)).oauth;
    assert.equal(saved.actor, 'user_owner');
    assert.ok(!JSON.stringify(saved).includes(u.searchParams.get('state').split('.')[1]), 'only a hash of the state is stored');
});

test('a full connection: approve, swap the code, learn the company, save it', async () => {
    const company = await mockPost('/app-company', { name: 'Harbor Motel LLC' });
    const { url } = await appConnect.startAuthorization(await ctx(), { actor: 'user_owner' });
    const back = await approve(url);
    const out = await appConnect.completeAuthorization(back, deps());
    assert.equal(out.orgId, ORG);
    assert.equal(out.companyUuid, company.uuid);
    assert.equal(out.companyName, 'Harbor Motel LLC');

    const conn = await store.getConnection(ORG);
    assert.equal(conn.status, 'connected');
    assert.equal(conn.integration, 'app');
    assert.equal(conn.companyUuid, company.uuid);
    assert.equal(conn.connectedBy, 'user_owner');
    assert.equal(conn.oauth, null, 'the one-time state is gone');
    assert.ok(conn.tokens.accessEnc && conn.tokens.refreshEnc, 'tokens are stored');
    assert.ok(!JSON.stringify(conn).includes(back.code), 'the code is not kept');
    const t = await store.getCompanyTokens(ORG);
    assert.ok(!JSON.stringify(conn).includes(t.accessToken) && !JSON.stringify(conn).includes(t.refreshToken), 'tokens are stored encrypted');

    // the saved tokens really work for that company
    const c = await ctx();
    assert.equal((await c.client.get(`/v1/companies/${company.uuid}`)).name, 'Harbor Motel LLC');
});

test('a state can be used once only', async () => {
    await mockPost('/app-company');
    const { url } = await appConnect.startAuthorization(await ctx());
    const back = await approve(url);
    await appConnect.completeAuthorization(back, deps());
    await assert.rejects(() => appConnect.completeAuthorization(back, deps()), (e) => e.code === 'bad_state');
});

test('a state we did not issue, or for another company, is refused and changes nothing', async () => {
    await mockPost('/app-company');
    const { url } = await appConnect.startAuthorization(await ctx());
    const back = await approve(url);
    const [who, nonce] = back.state.split('.');
    const otherOrg = Buffer.from('org_someone_else').toString('base64url');
    for (const state of ['', 'nonsense', `${who}.${nonce}x`, `${otherOrg}.${nonce}`, `${who}.`, `.${nonce}`, `${who}.${nonce}.extra`]) {
        await assert.rejects(() => appConnect.completeAuthorization({ ...back, state }, deps()), (e) => e.code === 'bad_state', `state "${state.slice(0, 20)}"`);
    }
    assert.equal(await store.getCompanyTokens(ORG), null);
    assert.notEqual((await store.getConnection(ORG)).status, 'connected');
});

test('a wrong guess connects nothing, and cannot be used to cancel the real request', async () => {
    await mockPost('/app-company');
    const { url } = await appConnect.startAuthorization(await ctx());
    const back = await approve(url);
    const who = back.state.split('.')[0];
    // a guess with the right company but the wrong secret part: refused, and the real one still works because the
    // stored hash is only cleared after it matched
    await assert.rejects(() => appConnect.completeAuthorization({ ...back, state: `${who}.guess` }, deps()), (e) => e.code === 'bad_state');
    const out = await appConnect.completeAuthorization(back, deps());
    assert.equal(out.orgId, ORG);
});

test('a request older than ten minutes is refused', async () => {
    await mockPost('/app-company');
    const { url } = await appConnect.startAuthorization(await ctx());
    const back = await approve(url);
    const later = () => Date.now() + appConnect.STATE_TTL_MS + 1000;
    await assert.rejects(() => appConnect.completeAuthorization(back, { ...deps(), now: later }), (e) => e.code === 'state_expired');
    assert.equal(await store.getCompanyTokens(ORG), null);
});

test('when the owner does not approve, nothing is connected', async () => {
    await mockPost('/app-company');
    await mockPost('/deny-next-authorize');
    const { url } = await appConnect.startAuthorization(await ctx());
    const back = await approve(url);
    assert.equal(back.error, 'access_denied');
    await assert.rejects(() => appConnect.completeAuthorization(back, deps()), (e) => e.code === 'declined');
    assert.equal(await store.getCompanyTokens(ORG), null);
});

test('a code that the provider rejects leaves nothing behind', async () => {
    await mockPost('/app-company');
    const { url } = await appConnect.startAuthorization(await ctx());
    const back = await approve(url);
    await assert.rejects(() => appConnect.completeAuthorization({ ...back, code: 'not-a-real-code' }, deps()), (e) => e.code === 'auth_failed');
    assert.equal(await store.getCompanyTokens(ORG), null);
    assert.notEqual((await store.getConnection(ORG)).status, 'connected');
});

test('a company that is already connected cannot start again until it is disconnected', async () => {
    await mockPost('/app-company');
    const { url } = await appConnect.startAuthorization(await ctx());
    await appConnect.completeAuthorization(await approve(url), deps());
    await assert.rejects(async () => appConnect.startAuthorization(await ctx()), (e) => e.code === 'already_connected');
});

test('connecting a different company forgets the ids remembered for the old one', async () => {
    await mockPost('/app-company', { name: 'First LLC' });
    const first = await appConnect.startAuthorization(await ctx());
    await appConnect.completeAuthorization(await approve(first.url), deps());
    await store.saveLink(ORG, 'employee', 'u1', { gustoUuid: 'old-employee-uuid' });
    await store.clearCompanyTokens(ORG);
    await store.saveConnection(ORG, { status: 'disconnected' });

    const second = await mockPost('/app-company', { name: 'Second LLC' });
    const again = await appConnect.startAuthorization(await ctx());
    const out = await appConnect.completeAuthorization(await approve(again.url), deps());
    assert.equal(out.companyUuid, second.uuid);
    assert.deepEqual(await store.listLinks(ORG, 'employee'), []);
});

test('an expired access token is renewed, sending the return address as an app integration must', async () => {
    const company = await mockPost('/app-company');
    const { url } = await appConnect.startAuthorization(await ctx());
    await appConnect.completeAuthorization(await approve(url), deps());
    const before = await store.getCompanyTokens(ORG);
    await mockPost('/expire-tokens', { company: true });
    const seen = [];
    const spy = async (u, init) => { if (String(u).endsWith('/oauth/token')) seen.push(JSON.parse(init.body)); return fetch(u, init); };
    const c = await makeContext(ORG, { ...deps(), fetchImpl: spy });
    assert.equal((await c.client.get(`/v1/companies/${company.uuid}`)).uuid, company.uuid);
    const after = await store.getCompanyTokens(ORG);
    assert.notEqual(after.refreshToken, before.refreshToken, 'the refresh token rotated');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].grant_type, 'refresh_token');
    assert.equal(seen[0].redirect_uri, RETURN_TO);
});

test('a server set up for Embedded Payroll refuses this flow', async () => {
    await assert.rejects(async () => appConnect.startAuthorization(await ctx({ integration: 'embedded' })), (e) => e.code === 'not_app_integration');
});

test('settings: the return address is checked for an app integration', () => {
    const base = { ...config.resolve({}), mode: 'demo', baseUrl: 'https://api.gusto-demo.com', clientId: 'id', clientSecret: 'secret', integration: 'app' };
    assert.deepEqual(config.validateForMode({ ...base, redirectUri: RETURN_TO }), []);
    assert.ok(config.validateForMode({ ...base, redirectUri: 'not an address' }).some((e) => /GUSTO_REDIRECT_URI/.test(e)));
    process.env.GUSTO_ALLOW_PRODUCTION = 'true';
    try {
        const prod = { ...base, mode: 'production', baseUrl: 'https://api.gusto.com' };
        assert.ok(config.validateForMode({ ...prod, redirectUri: RETURN_TO }).some((e) => /https/.test(e)));
        assert.deepEqual(config.validateForMode({ ...prod, redirectUri: 'https://app.onnhr.com/api/us/gusto/oauth/callback' }), []);
    } finally { delete process.env.GUSTO_ALLOW_PRODUCTION; }
});
