import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const L = require('../services/access-link-rules.js');

const NOW = new Date('2026-11-12T12:00:00.000Z');

test('link tokens: 32 random bytes, URL-safe, only the hash is meant to be stored', () => {
    const a = L.newToken(); const b = L.newToken();
    assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(a.token, 'base64url').length, 32);
    assert.notEqual(a.token, b.token);
    assert.match(a.hash, /^[0-9a-f]{64}$/);
    assert.equal(a.hash, L.hashToken(a.token));
    assert.notEqual(a.hash, a.token);
    assert.equal(L.tokenLooksRight(a.token), true);
    for (const bad of ['', null, undefined, 'short', `${a.token}x`, a.token.slice(1), `${a.token.slice(0, 42)}/`, { toString: () => a.token }, 12345]) assert.equal(L.tokenLooksRight(bad), false, String(bad));
});

test('expiry: personal links 7 days; join links 1 to 30 whole days chosen by HR', () => {
    assert.equal(L.expiryFor('setup', 99, NOW).expiresAt, '2026-11-19T12:00:00.000Z');
    assert.equal(L.expiryFor('join', 30, NOW).expiresAt, '2026-12-12T12:00:00.000Z');
    assert.equal(L.expiryFor('join', '3', NOW).days, 3);
    assert.equal(L.expiryFor('join', undefined, NOW).days, L.JOIN_LINK_DEFAULT_DAYS);
    for (const bad of [0, -1, 31, 365, 1.5, 'soon', NaN]) assert.ok(L.expiryFor('join', bad, NOW).error, String(bad));
});

test('link state: active, used (personal links only), revoked, expired', () => {
    const base = { kind: 'setup', expiresAt: '2026-11-19T12:00:00.000Z', usedAt: null, revokedAt: null };
    assert.equal(L.linkState(base, NOW), 'active');
    assert.equal(L.linkState({ ...base, usedAt: '2026-11-12T11:00:00.000Z' }, NOW), 'used');
    assert.equal(L.linkState({ ...base, revokedAt: '2026-11-12T11:00:00.000Z' }, NOW), 'revoked');
    assert.equal(L.linkState({ ...base, revokedAt: 'x', usedAt: 'y' }, NOW), 'revoked');
    assert.equal(L.linkState({ ...base, expiresAt: '2026-11-12T12:00:00.000Z' }, NOW), 'expired'); // the very moment it ends
    assert.equal(L.linkState({ ...base, expiresAt: '2026-11-12T11:59:59.999Z' }, NOW), 'expired');
    assert.equal(L.linkState({ ...base, expiresAt: undefined }, NOW), 'expired');
    assert.equal(L.linkState(null, NOW), 'expired');
    assert.equal(L.linkState({ kind: 'join', expiresAt: '2026-11-19T12:00:00.000Z', usedAt: 'ignored for join links' }, NOW), 'active');
});

test('password rules: the same as the existing sign-up rules, plus no < or > and at most 72 characters', () => {
    assert.equal(L.passwordProblem('LocalTest#2026'), null);
    assert.equal(L.passwordProblem('Correct-Horse.9!'), null);
    assert.match(L.passwordProblem('Short#1a'), /at least 14/);
    assert.match(L.passwordProblem('alllowercase#2026'), /uppercase/);
    assert.match(L.passwordProblem('ALLUPPERCASE#2026'), /lowercase/);
    assert.match(L.passwordProblem('NoNumbersHere#!!'), /number/);
    assert.match(L.passwordProblem('NoSpecials20262026'), /special/);
    assert.match(L.passwordProblem('Has<Angle>#2026x'), /< or >/);
    assert.match(L.passwordProblem(`Aa1#${'x'.repeat(70)}`), /at most 72/);
    assert.match(L.passwordProblem('Maria.lopez#2026', { email: 'maria.lopez@x.com' }), /email/);
    assert.equal(L.passwordProblem('Maria.lopez#2026', { email: 'ml@x.com' }), null);
    for (const bad of [undefined, null, '', 12345678901234, {}]) assert.ok(L.passwordProblem(bad));
    // the rules in the existing controller have not drifted away from this copy
    const src = fs.readFileSync(new URL('../controllers/authController.js', import.meta.url), 'utf8');
    assert.match(src, /password\.length < 14/);
    for (const banned of ['Password123!', 'Admin12345678!', 'Qwertyuiop123!']) assert.ok(src.includes(banned));
    assert.ok(L.PASSWORD_RULES_TEXT.includes('14'));
});

test('nobody resets the sign-in of someone with a higher role, of themselves, or of someone who has left', () => {
    const who = (role, id = 'me') => ({ id, role });
    const person = (role, extra = {}) => ({ id: 'them', uid: 'them', role, status: 'Active', ...extra });
    const ok = (a, b) => L.mayResetAccess(a, b).ok;
    assert.equal(ok(who('hr_admin'), person('employee')), true);
    assert.equal(ok(who('hr_admin'), person('manager')), true);
    assert.equal(ok(who('hr_admin'), person('hr_admin')), true); // same level
    assert.equal(ok(who('hr_admin'), person('payroll_admin')), true);
    assert.equal(ok(who('hr_admin'), person('super_admin')), false);
    assert.equal(L.mayResetAccess(who('hr_admin'), person('Super Admin')).status, 403);
    assert.equal(ok(who('HRMS'), person('SUPER_ADMIN')), false); // old spellings
    assert.equal(ok(who('super_admin'), person('super_admin')), true);
    assert.equal(ok(who('super_admin'), person('hr_admin')), true);
    assert.equal(ok(who('manager'), person('hr_admin')), false);
    assert.equal(ok(who('employee'), person('manager')), false);
    assert.equal(L.mayResetAccess(who('hr_admin', 'them'), person('hr_admin')).status, 409); // yourself
    assert.equal(L.mayResetAccess(who('super_admin'), person('employee', { status: 'Terminated' })).status, 409);
    assert.equal(L.mayResetAccess(who('hr_admin'), null).status, 404);
    assert.equal(ok(who('hr_admin'), person(undefined)), true); // no role stored means employee
    assert.ok(L.roleRank('super_admin') > L.roleRank('hr_admin') && L.roleRank('hr_admin') > L.roleRank('payroll_admin') && L.roleRank('payroll_admin') > L.roleRank('manager') && L.roleRank('manager') > L.roleRank('employee'));
});

test('where a person is with signing in', () => {
    assert.equal(L.accessStatus({ setup_pending: true }), 'waiting_for_setup');
    assert.equal(L.accessStatus({ must_change_password: true }), 'temporary_password');
    assert.equal(L.accessStatus({ must_change_password: false }), 'active');
    assert.equal(L.accessStatus({}), 'active');
    assert.equal(L.accessStatus({ status: 'terminated', must_change_password: true }), 'ended');
    assert.equal(L.accessStatus(null), 'unknown');
});

test('join request: name and a real email; angle brackets never get through', () => {
    const ok = L.validateJoinRequest({ firstName: ' Maria ', lastName: 'Lopez', email: ' Maria@X.com ', phone: '(512) 555-0101' });
    assert.deepEqual(ok, { errors: [], value: { firstName: 'Maria', lastName: 'Lopez', email: 'maria@x.com', phone: '(512) 555-0101' } });
    assert.equal(L.validateJoinRequest({ firstName: '<b>M</b>', lastName: 'L', email: 'm@x.com' }).value.firstName, 'bM/b');
    assert.equal(L.validateJoinRequest({}).errors.length, 3);
    assert.equal(L.validateJoinRequest(null).errors.length, 3);
    assert.ok(L.validateJoinRequest({ firstName: 'M', lastName: 'L', email: 'm@x.com', phone: '555' }).errors[0].includes('phone'));
    for (const bad of ['no-at-sign', 'a@b', 'a b@x.com', 'a@x.com,b@x.com']) assert.ok(L.validateJoinRequest({ firstName: 'M', lastName: 'L', email: bad }).errors.length, bad);
    // a role or company sent along is ignored: the request can only ever carry these four things
    assert.deepEqual(Object.keys(L.validateJoinRequest({ firstName: 'M', lastName: 'L', email: 'm@x.com', role: 'super_admin', orgId: 'other' }).value), ['firstName', 'lastName', 'email', 'phone']);
});

test('temporary password: only the two "choose a new password" requests get through', () => {
    const temp = { id: 'u1', must_change_password: true };
    const blocks = (url, user = temp, decoded = { id: 'u1' }) => L.mustChangeBlocks(user, decoded, url);
    assert.equal(blocks('/api/auth/change-password'), false);
    assert.equal(blocks('/api/auth/password-status'), false);
    assert.equal(blocks('/api/auth/password-status?x=1'), false);
    assert.equal(blocks('/api/auth/change-password/'), false);
    assert.equal(blocks('/API/Auth/Change-Password'), false); // Express matches paths without regard to case
    for (const url of ['/api/us/me/permissions', '/api/us/employees', '/api/time/status', '/api/org/profile', '/api/auth/change-password/../../us/employees', '/api/auth/change-passwordx', '/api/auth/unlock/a@b.c', '/api/v1/people', '', undefined]) {
        assert.equal(blocks(url), true, String(url));
    }
    // people without the flag are never held back
    for (const user of [{ id: 'u1' }, { id: 'u1', must_change_password: false }, { id: 'u1', must_change_password: 'true' }, null]) assert.equal(blocks('/api/us/employees', user), false);
    // a Firebase password sign-in is held back; Google or company single sign-on is not (the temporary password was never typed)
    assert.equal(blocks('/api/us/employees', temp, { uid: 'u1', firebase: { sign_in_provider: 'password' } }), true);
    assert.equal(blocks('/api/us/employees', temp, { uid: 'u1', firebase: { sign_in_provider: 'google.com' } }), false);
    assert.equal(blocks('/api/us/employees', temp, { uid: 'u1', firebase: { sign_in_provider: 'saml.acme' } }), false);
    assert.equal(blocks('/api/us/employees', temp, undefined), true);
});

/** Runs verifyToken with a signed token for a user document supplied by the test (no database is touched) */
async function runVerify(userDoc, url, { email = 'worker@x.com' } = {}) {
    const jwt = require('jsonwebtoken');
    const firebase = require('../config/firebase.js');
    const { verifyToken } = require('../middleware/authMiddleware.js');
    const realCollection = firebase.db.collection;
    firebase.db.collection = (name) => ({ doc: () => ({ get: async () => ({ exists: name === 'users' && Boolean(userDoc), data: () => userDoc }) }) });
    try {
        const token = jwt.sign({ id: 'u1', email, role: (userDoc && userDoc.role) || 'employee' }, process.env.JWT_SECRET, { expiresIn: '5m' });
        const out = { status: 200, body: null, passed: false, user: null };
        const req = { headers: { authorization: `Bearer ${token}` }, originalUrl: url, query: {} };
        const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
        await verifyToken(req, res, () => { out.passed = true; out.user = req.user; });
        return out;
    } finally { firebase.db.collection = realCollection; }
}

test('verifyToken: a person with a temporary password gets 403 on every API except choosing a new password', async () => {
    const temp = { orgId: 'o1', role: 'employee', status: 'Active', must_change_password: true };
    for (const url of ['/api/us/me/permissions', '/api/us/employees', '/api/time/status', '/api/org/profile', '/api/us/policies/mine', '/api/payroll/runs']) {
        const r = await runVerify(temp, url);
        assert.equal(r.passed, false, url); assert.equal(r.status, 403, url);
        assert.deepEqual(r.body, { success: false, code: 'password_change_required', mustChangePassword: true, error: 'Choose a new password before you continue' });
    }
    for (const url of ['/api/auth/change-password', '/api/auth/password-status']) {
        const r = await runVerify(temp, url);
        assert.equal(r.passed, true, url); assert.equal(r.user.id, 'u1'); assert.equal(r.user.must_change_password, true);
    }
    // an HR admin with a temporary password is held back just the same
    assert.equal((await runVerify({ ...temp, role: 'hr_admin' }, '/api/us/employees')).status, 403);
});

test('verifyToken: everybody else is let through as before; a person who has left is still refused first', async () => {
    assert.equal((await runVerify({ orgId: 'o1', role: 'employee', status: 'Active' }, '/api/us/me/permissions')).passed, true);
    assert.equal((await runVerify({ orgId: 'o1', role: 'employee', status: 'Active', must_change_password: false }, '/api/us/employees')).passed, true);
    const gone = await runVerify({ orgId: 'o1', role: 'employee', status: 'Terminated', must_change_password: true }, '/api/auth/change-password');
    assert.equal(gone.passed, false); assert.equal(gone.status, 403); assert.equal(gone.body.error, 'This account is no longer active');
    assert.equal((await runVerify(null, '/api/us/me/permissions')).passed, true); // no user document: nothing to hold back
});

test('the exports other files import from the auth middleware are unchanged', () => {
    const m = require('../middleware/authMiddleware.js');
    assert.deepEqual(Object.keys(m).sort(), ['ADMIN_HR_ROLES', 'ALLOWED_ROLES', 'authorize', 'verifyToken']);
    assert.deepEqual(m.ADMIN_HR_ROLES, ['Admin', 'Super Admin', 'super_admin', 'HRMS', 'hr_admin', 'hr_payroll']);
});
