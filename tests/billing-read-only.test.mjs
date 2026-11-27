// A company whose subscription is suspended or cancelled is read-only when BILLING_ENFORCE=on: the guard that every
// US route passes through (requireUsOrg in routes/us-hr.js), with companies held in the in-memory test database.
// What this does NOT cover: real Stripe, how an account becomes suspended (services/billing-service.js, with its own
// tests), and the /api/time routes, which are deliberately not held back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-billing-read-only';
process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);
const { rawCollection } = require('../config/firebase.js');
const { requireUsOrg } = require('../routes/us-hr.js').helpers;

let n = 0;
async function company(state) {
    n += 1;
    const orgId = `org_bill_${Date.now()}_${n}`;
    await rawCollection('organizations').doc(orgId).set({ orgId, country: 'United States', countryCode: 'US' });
    if (state) await rawCollection('billing_accounts').doc(orgId).set({ orgId, state, planId: 'standard' });
    return orgId;
}
async function ask(orgId, method, originalUrl) {
    const req = { method, originalUrl, user: { id: 'owner1', orgId, role: 'super_admin' } };
    const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    let passed = false;
    await requireUsOrg(req, res, () => { passed = true; });
    return { passed, code: res.code, body: res.body };
}
const withEnforce = async (value, fn) => { const old = process.env.BILLING_ENFORCE; if (value === undefined) delete process.env.BILLING_ENFORCE; else process.env.BILLING_ENFORCE = value; try { return await fn(); } finally { if (old === undefined) delete process.env.BILLING_ENFORCE; else process.env.BILLING_ENFORCE = old; } };

test('switched off (the default), a suspended company is not held back at all', async () => {
    const org = await company('suspended');
    await withEnforce(undefined, async () => { assert.equal((await ask(org, 'POST', '/api/us/employees')).passed, true); });
});

test('switched on: a suspended or cancelled company can read, pay, use its privacy rights and its own things, and change nothing else', async () => {
    await withEnforce('on', async () => {
        for (const state of ['suspended', 'cancelled']) {
            const org = await company(state);
            for (const [method, url] of [['GET', '/api/us/employees'], ['GET', '/api/us/reports/labor?from=2026-11-02'], ['HEAD', '/api/us/employees']]) assert.equal((await ask(org, method, url)).passed, true, `${state}: ${method} ${url}`);
            for (const url of ['/api/us/billing/payment-method', '/api/us/billing/invoices/inv1/pay', '/api/us/billing', '/api/us/privacy/requests', '/api/us/me/notices/read-all', '/api/us/me/authenticator/start', '/api/us/me?x=1']) assert.equal((await ask(org, 'POST', url)).passed, true, `${state}: POST ${url}`);
            for (const [method, url] of [['POST', '/api/us/employees'], ['PUT', '/api/us/company/profile'], ['DELETE', '/api/us/people/u1/signin-qr'], ['POST', '/api/us/leave/requests'], ['POST', '/api/us/measures'], ['POST', '/api/us/billing-export'], ['PUT', '/api/us/people/u1/assignment']]) {
                const r = await ask(org, method, url);
                assert.deepEqual([r.passed, r.code, r.body.code, r.body.billingState], [false, 402, 'account_read_only', state], `${state}: ${method} ${url}`);
            }
        }
    });
});

test('switched on: a company that is active, on trial, past due, or has no subscription at all works as usual', async () => {
    await withEnforce('on', async () => {
        for (const state of ['active', 'trial', 'past_due', null]) {
            const org = await company(state);
            assert.equal((await ask(org, 'POST', '/api/us/employees')).passed, true, String(state));
        }
    });
});

test('the guard still refuses a company that is not a US one, before anything about billing', async () => {
    const orgId = `org_bill_in_${Date.now()}`;
    await rawCollection('organizations').doc(orgId).set({ orgId, country: 'India' });
    await withEnforce('on', async () => { const r = await ask(orgId, 'POST', '/api/us/employees'); assert.deepEqual([r.passed, r.code], [false, 409]); });
});
