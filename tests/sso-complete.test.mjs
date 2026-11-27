// Finishing a company SSO sign-in on the server (services/sso-complete.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../services/sso-complete.js');

const TOKEN = 'x'.repeat(40);
function deps(over = {}) {
    const calls = { minted: [], deleted: [] };
    const d = {
        verifyIdToken: async () => ({ uid: 'sso-uid', email: 'Jay@PromptAIUSA.com', firebase: { sign_in_provider: 'oidc.entra' } }),
        discover: async (email) => (email.endsWith('@promptaiusa.com') ? { orgId: 'org1', providerId: 'oidc.entra', enforce: false } : null),
        findPerson: async (orgId, email) => (orgId === 'org1' && email === 'jay@promptaiusa.com' ? { id: 'jay-uid', status: 'Active' } : null),
        mintToken: async (uid) => { calls.minted.push(uid); return `custom-${uid}`; },
        deleteUser: async (uid) => { calls.deleted.push(uid); },
        ...over
    };
    return { d, calls };
}

test('a good SSO sign-in gives a token for the person\'s own account and removes the provider\'s extra account', async () => {
    const { d, calls } = deps();
    const out = await S.complete(TOKEN, d);
    assert.equal(out.token, 'custom-jay-uid');
    assert.equal(out.orgId, 'org1');
    assert.deepEqual(calls.minted, ['jay-uid']);
    assert.deepEqual(calls.deleted, ['sso-uid']);
});

test('when the provider account already is the person\'s account, nothing is deleted', async () => {
    const { d, calls } = deps({ verifyIdToken: async () => ({ uid: 'jay-uid', email: 'jay@promptaiusa.com', firebase: { sign_in_provider: 'oidc.entra' } }) });
    await S.complete(TOKEN, d);
    assert.deepEqual(calls.deleted, []);
});

test('refused: a bad token, a password or Google sign-in, no email', async () => {
    await assert.rejects(S.complete('short', deps().d), { code: 'bad_token', status: 400 });
    await assert.rejects(S.complete(TOKEN, deps({ verifyIdToken: async () => { throw new Error('expired'); } }).d), { code: 'bad_token', status: 401 });
    for (const p of ['password', 'google.com', 'custom', undefined]) {
        await assert.rejects(S.complete(TOKEN, deps({ verifyIdToken: async () => ({ uid: 'u', email: 'jay@promptaiusa.com', firebase: { sign_in_provider: p } }) }).d), { code: 'not_sso' }, String(p));
    }
    await assert.rejects(S.complete(TOKEN, deps({ verifyIdToken: async () => ({ uid: 'u', firebase: { sign_in_provider: 'saml.okta' } }) }).d), { code: 'no_email' });
});

test('the email comes from the SAML identities when the token has no email field', async () => {
    const { d } = deps({ verifyIdToken: async () => ({ uid: 'u', firebase: { sign_in_provider: 'oidc.entra', identities: { email: ['jay@promptaiusa.com'] } } }) });
    assert.equal((await S.complete(TOKEN, d)).token, 'custom-jay-uid');
});

test('never crosses companies: the provider must be that company\'s, and the person must be in it and active', async () => {
    const other = deps({ verifyIdToken: async () => ({ uid: 'u', email: 'jay@promptaiusa.com', firebase: { sign_in_provider: 'oidc.someone-else' } }) });
    await assert.rejects(S.complete(TOKEN, other.d), { code: 'no_account' }, 'another company\'s provider cannot sign into this company');
    assert.deepEqual(other.calls.minted, []);
    await assert.rejects(S.complete(TOKEN, deps({ verifyIdToken: async () => ({ uid: 'u', email: 'eve@elsewhere.com', firebase: { sign_in_provider: 'oidc.entra' } }) }).d), { code: 'no_account' });
    await assert.rejects(S.complete(TOKEN, deps({ findPerson: async () => null }).d), { code: 'no_account' });
    await assert.rejects(S.complete(TOKEN, deps({ findPerson: async () => ({ id: 'jay-uid', status: 'Terminated' }) }).d), { code: 'no_account' });
    await assert.rejects(S.complete(TOKEN, deps({ findPerson: async () => ({ id: 'jay-uid', disabled: true }) }).d), { code: 'no_account' });
});

test('a failed clean-up of the provider account never fails the sign-in', async () => {
    const { d } = deps({ deleteUser: async () => { throw new Error('nope'); } });
    assert.equal((await S.complete(TOKEN, d)).token, 'custom-jay-uid');
});

test('PIN, code and QR sign-in refuse people whose company requires SSO, except break-glass accounts', async () => {
    const sso = require('../services/sso.js');
    const users = { a: { orgId: 'o', email: 'a@x.com' }, boss: { orgId: 'o', email: 'boss@x.com' } };
    const minted = [];
    const guarded = sso.guardMint(async (uid) => { minted.push(uid); return `t-${uid}`; }, {
        load: async (uid) => users[uid],
        blocked: async (u) => u.email !== 'boss@x.com'
    });
    await assert.rejects(guarded('a'), { status: 403, code: 'sso_required' });
    assert.equal(await guarded('boss'), 't-boss');
    assert.deepEqual(minted, ['boss'], 'no token is made for a refused person');
});
