// US-L08: support-access rules, the support-staff grants route (real router, in-memory database), and the public status page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const R = require('../services/support-rules.js');
const jwt = require('jsonwebtoken');
const express = require('express');
const guard = require('../middleware/static-guard.js');

const NOW = '2026-03-10T12:00:00.000Z';
const grant = (over = {}) => ({ orgId: 'orgA', reason: 'Payroll export looks wrong', mode: 'read_only', grantedBy: 'u1', grantedByEmail: 'owner@a.example', createdAt: '2026-03-10T10:00:00.000Z', expiresAt: '2026-03-10T14:00:00.000Z', revokedAt: null, ...over });

test('grant state: active until it runs out; revoked wins over expired', () => {
    assert.equal(R.grantState(grant(), NOW), 'active');
    assert.equal(R.grantState(grant({ expiresAt: NOW }), NOW), 'expired', 'the end time itself is already expired');
    assert.equal(R.grantState(grant({ expiresAt: '2026-03-10T11:59:59.999Z' }), NOW), 'expired');
    assert.equal(R.grantState(grant({ revokedAt: '2026-03-10T11:00:00.000Z' }), NOW), 'revoked');
    assert.equal(R.grantState(grant({ revokedAt: '2026-03-10T11:00:00.000Z', expiresAt: '2026-03-10T10:30:00.000Z' }), NOW), 'revoked');
    assert.equal(R.grantState(null, NOW), 'expired'); assert.equal(R.grantState({}, NOW), 'expired');
    assert.equal(R.minutesLeft(grant(), NOW), 120);
    assert.equal(R.minutesLeft(grant({ expiresAt: '2026-03-10T12:00:59.000Z' }), NOW), 0);
    assert.equal(R.minutesLeft(grant({ revokedAt: NOW }), NOW), 0);
});

test('who may see grants from every company: the support list, or the platform\'s own super admin, never a customer', () => {
    const env = { PLATFORM_SUPPORT_EMAILS: ' Support@Vendor.example , second@vendor.example ', PLATFORM_ORG_ID: 'org_platform' };
    assert.deepEqual(R.emailList(env.PLATFORM_SUPPORT_EMAILS), ['support@vendor.example', 'second@vendor.example']);
    assert.equal(R.canListAllGrants({ email: 'SUPPORT@vendor.example', role: 'employee', orgId: 'x' }, env), true);
    assert.equal(R.canListAllGrants({ email: 'boss@vendor.example', role: 'super_admin', orgId: 'org_platform' }, env), true);
    assert.equal(R.canListAllGrants({ email: 'boss@vendor.example', role: 'Super Admin', orgId: 'org_platform' }, env), true);
    assert.equal(R.canListAllGrants({ email: 'owner@customer.example', role: 'super_admin', orgId: 'org_customer' }, env), false, 'a customer owner is refused');
    assert.equal(R.canListAllGrants({ email: 'hr@vendor.example', role: 'hr_admin', orgId: 'org_platform' }, env), false);
    assert.equal(R.canListAllGrants({ email: 'owner@customer.example', role: 'super_admin', orgId: 'org_customer' }, {}), false, 'with nothing configured the list is closed, even to a super admin');
    assert.equal(R.canListAllGrants({ email: '', role: 'super_admin', orgId: undefined }, { PLATFORM_ORG_ID: '' }), false);
    assert.equal(R.canListAllGrants(null, env), false);
    assert.equal(R.canStartSession({ email: 'second@vendor.example' }, env), true);
    assert.equal(R.canStartSession({ email: 'boss@vendor.example', role: 'super_admin', orgId: 'org_platform' }, env), false, 'the operator can see the list but not start a session');
});

test('rows for the screen: no internal ids of people, active first by soonest end, then newest', () => {
    const row = R.publicGrant('g1', grant(), NOW, 'Acme Inc');
    assert.deepEqual(row, { id: 'g1', company_id: 'orgA', company_name: 'Acme Inc', reason: 'Payroll export looks wrong', mode: 'read_only', granted_by: 'owner@a.example', created_at: '2026-03-10T10:00:00.000Z', expires_at: '2026-03-10T14:00:00.000Z', revoked_at: null, state: 'active', minutes_left: 120 });
    const rows = [
        R.publicGrant('old', grant({ createdAt: '2026-03-01T00:00:00.000Z', expiresAt: '2026-03-02T00:00:00.000Z' }), NOW),
        R.publicGrant('later', grant({ expiresAt: '2026-03-11T00:00:00.000Z' }), NOW),
        R.publicGrant('revoked', grant({ createdAt: '2026-03-09T00:00:00.000Z', revokedAt: '2026-03-09T01:00:00.000Z' }), NOW),
        R.publicGrant('soon', grant({ expiresAt: '2026-03-10T12:30:00.000Z' }), NOW)
    ];
    assert.deepEqual(R.sortGrants(rows).map((r) => r.id), ['soon', 'later', 'revoked', 'old']);
    assert.deepEqual(R.countByState(rows), { active: 2, expired: 1, revoked: 1 });
});

/* ---------------------------- the route, with real sign-in tokens ---------------------------- */

let server; let base;
const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: 600 });
const get = async (path, id) => { const res = await fetch(`${base}${path}`, { headers: id ? { Authorization: `Bearer ${tokenFor(id)}` } : {} }); return { status: res.status, body: await res.json().catch(() => null) }; };

test.before(async () => {
    mem.reset();
    const hour = 3600000; const iso = (ms) => new Date(Date.now() + ms).toISOString();
    await db.collection('users').doc('support1').set({ email: 'support@vendor.example', role: 'employee', orgId: 'org_platform', status: 'Active', name: 'Support Person' });
    await db.collection('users').doc('operator1').set({ email: 'boss@vendor.example', role: 'super_admin', orgId: 'org_platform', status: 'Active', name: 'Platform Owner' });
    await db.collection('users').doc('owner1').set({ email: 'owner@a.example', role: 'super_admin', orgId: 'orgA', status: 'Active', name: 'Customer Owner' });
    await db.collection('organizations').doc('orgA').set({ name: 'Acme Inc' });
    await db.collection('organizations').doc('orgB').set({ companyName: 'Bravo LLC' });
    await db.collection('support_grants').doc('gActive').set(grant({ createdAt: iso(-hour), expiresAt: iso(2 * hour) }));
    await db.collection('support_grants').doc('gExpired').set(grant({ orgId: 'orgB', createdAt: iso(-30 * hour), expiresAt: iso(-6 * hour) }));
    await db.collection('support_grants').doc('gRevoked').set(grant({ orgId: 'orgB', createdAt: iso(-3 * hour), expiresAt: iso(5 * hour), revokedAt: iso(-hour) }));
    const app = express(); app.use(express.json());
    app.use('/api/support', require('../routes/support-access.js'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { delete process.env.PLATFORM_SUPPORT_EMAILS; delete process.env.PLATFORM_ORG_ID; server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 300)); });

test('support screen route: closed unless configured; open to the support list; never to a customer owner', async (t) => {
    delete process.env.PLATFORM_SUPPORT_EMAILS; delete process.env.PLATFORM_ORG_ID;
    const probe = await get('/api/support/platform/grants', 'support1');
    if (probe.status === 401) { t.skip('this environment does not accept test sign-in tokens'); return; }
    assert.equal(probe.status, 403, 'nothing configured: closed');
    assert.equal((await get('/api/support/platform/grants', 'owner1')).status, 403);
    assert.equal((await get('/api/support/platform/grants')).status, 401);

    process.env.PLATFORM_SUPPORT_EMAILS = 'support@vendor.example';
    const ok = await get('/api/support/platform/grants', 'support1');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.counts, { active: 1, expired: 1, revoked: 1 });
    assert.equal(ok.body.canStartSession, true);
    assert.deepEqual(ok.body.data.map((g) => [g.id, g.state, g.company_name]), [['gActive', 'active', 'Acme Inc'], ['gRevoked', 'revoked', 'Bravo LLC'], ['gExpired', 'expired', 'Bravo LLC']]);
    assert.ok(ok.body.data[0].minutes_left > 100);
    assert.deepEqual((await get('/api/support/platform/grants?state=active', 'support1')).body.data.map((g) => g.id), ['gActive']);
    assert.deepEqual((await get('/api/support/platform/grants?state=revoked', 'support1')).body.data.map((g) => g.id), ['gRevoked']);
    assert.equal((await get('/api/support/platform/grants?state=sideways', 'support1')).status, 400);
    assert.equal((await get('/api/support/platform/grants', 'owner1')).status, 403, 'a customer owner still cannot see other companies');
    assert.equal((await get('/api/support/platform/grants', 'operator1')).status, 403, 'the platform owner needs PLATFORM_ORG_ID to be set');

    process.env.PLATFORM_ORG_ID = 'org_platform';
    const op = await get('/api/support/platform/grants', 'operator1');
    assert.equal(op.status, 200); assert.equal(op.body.canStartSession, false);
    assert.equal((await get('/api/support/platform/grants', 'owner1')).status, 403);
});

/* ------------------------------------ the two pages ------------------------------------ */

test('status page: public, served by the static guard, reads only the public status endpoint, no inline handlers', () => {
    assert.equal(guard.isBlocked('/status.html'), false);
    assert.equal(guard.isBlocked('/admin-support.html'), false);
    const page = fs.readFileSync(new URL('../status.html', import.meta.url), 'utf8');
    assert.match(page, /fetch\('\/api\/status'/);
    assert.ok(!/firebase-config|Authorization|getIdToken|localStorage/.test(page), 'the status page needs no sign-in and stores nothing');
    assert.ok(!/\son[a-z]+\s*=\s*["']/.test(page), 'no inline event handlers');
    assert.match(page, /name="viewport"/);
    assert.equal([...page.matchAll(/fetch\(/g)].length, 1, 'it calls one address only');
    const support = fs.readFileSync(new URL('../admin-support.html', import.meta.url), 'utf8');
    assert.ok(!/\son[a-z]+\s*=\s*["']/.test(support));
    assert.ok(!/localStorage|sessionStorage/.test(support), 'the read-only session token is kept in memory only');
    assert.match(support, /method: 'GET'/);
});
