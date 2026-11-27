// What a separate client app depends on: which web addresses may call the API, the company time zone on the
// company profile, the "who am I" call being reachable with a temporary password, department names in reports,
// and notices that never fail the request that caused them.
// What this does NOT cover: the routes themselves (kiosk sign-in inside one company, signup defaults, GET /api/us/me,
// the notices list). Those were run by hand against a local server with the Firebase emulators on 2026-11-17.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-client-app-readiness';
const require = createRequire(import.meta.url);
const origins = require('../middleware/allowed-origins.js');
const { checkProductionEnv } = require('../services/production-check.js');
const { validateCompanyProfile } = require('../services/us-validation.js');
const access = require('../services/access-link-rules.js');
const reports = require('../services/us-reports.js');
const timeRules = require('../services/time-rules.js');

/* ------------------------------- which addresses may call the API ------------------------------- */

test('the product\'s own addresses and no address at all are allowed; localhost only outside production', () => {
    const prod = { NODE_ENV: 'production' }; const dev = { NODE_ENV: 'development' };
    assert.equal(origins.isAllowedOrigin(undefined, prod), true, 'a phone app or a server sends no Origin');
    for (const o of origins.BUILT_IN) assert.equal(origins.isAllowedOrigin(o, prod), true, o);
    assert.equal(origins.isAllowedOrigin('http://localhost:5173', dev), true);
    assert.equal(origins.isAllowedOrigin('http://127.0.0.1:3000', dev), true);
    assert.equal(origins.isAllowedOrigin('http://localhost:5173', prod), false);
    assert.equal(origins.isAllowedOrigin('https://app.onnhr.com', prod), false, 'not allowed until it is named');
});

test('a look-alike address is refused: every match is exact', () => {
    const prod = { NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://app.onnhr.com' };
    for (const o of ['https://evilkylrxai.firebaseapp.com', 'https://x-kylrxai.web.app', 'https://notapp.kylrxai.com', 'https://evil.example/app.kylrxai.com',
        'http://app.kylrxai.com', 'https://app.onnhr.com.evil.example', 'https://evil-app.onnhr.com', 'http://app.onnhr.com', 'https://app.onnhr.com:8443', 'http://localhost.evil.example']) {
        assert.equal(origins.isAllowedOrigin(o, prod), false, o);
    }
    assert.equal(origins.isAllowedOrigin('https://app.onnhr.com', prod), true);
});

test('ALLOWED_ORIGINS takes exact https addresses; anything else is ignored and reported', () => {
    const env = { NODE_ENV: 'production', ALLOWED_ORIGINS: ' https://app.onnhr.com/ , https://staging.onnhr.com,https://app.onnhr.com, *.onnhr.com, https://x.example/path, http://plain.example, not a url, http://localhost:4000 ' };
    const c = origins.configured(env);
    assert.deepEqual(c.origins, ['https://app.onnhr.com', 'https://staging.onnhr.com', 'http://localhost:4000']);
    assert.deepEqual(c.rejected, ['*.onnhr.com', 'https://x.example/path', 'http://plain.example', 'not a url']);
    assert.equal(origins.isAllowedOrigin('https://staging.onnhr.com', env), true);
    assert.equal(origins.isAllowedOrigin('https://x.example', env), false);
    assert.equal(origins.isAllowedOrigin('http://localhost:4000', env), false, 'localhost stays refused in production even when named');
    assert.deepEqual(origins.configured({}).origins, []);
});

test('the production settings check stops on an ALLOWED_ORIGINS entry that would be ignored', () => {
    const base = { NODE_ENV: 'production' };
    const bad = checkProductionEnv({ ...base, ALLOWED_ORIGINS: 'https://app.onnhr.com,*.onnhr.com' }, {});
    assert.ok(bad.problems.some((p) => /ALLOWED_ORIGINS has 1 entry/.test(p)), bad.problems.join(' | '));
    const good = checkProductionEnv({ ...base, ALLOWED_ORIGINS: 'https://app.onnhr.com' }, {});
    assert.ok(!good.problems.some((p) => /ALLOWED_ORIGINS/.test(p)));
});

/* ------------------------------- the company's time zone ------------------------------- */

const COMPANY = { ein: '12-3456789', entityType: 'llc', legalName: 'Harbor Motel LLC', businessAddress: { line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' }, workStates: ['TX'] };

test('the company profile takes a time zone, refuses one that does not exist, and leaves it alone when not sent', () => {
    const plain = validateCompanyProfile(COMPANY);
    assert.deepEqual(plain.errors, [], 'the fixture itself is a valid profile');
    assert.equal('timezone' in plain.value, false, 'not sent: the saved zone is not touched');
    const set = validateCompanyProfile({ ...COMPANY, timezone: ' America/Denver ' });
    assert.deepEqual(set.errors, []); assert.equal(set.value.timezone, 'America/Denver');
    for (const zone of ['Mars/Olympus', '', '   ', 'x'.repeat(80)]) {
        const bad = validateCompanyProfile({ ...COMPANY, timezone: zone });
        assert.ok(bad.errors.some((e) => /timezone must be a time zone name/.test(e)), `"${zone}"`);
    }
});

/* ------------------------------- "who am I" with a temporary password ------------------------------- */

test('a person who must change their password may still ask who they are, and nothing else new', () => {
    const user = { must_change_password: true }; const token = { firebase: { sign_in_provider: 'password' } };
    assert.equal(access.mustChangeBlocks(user, token, '/api/us/me'), false);
    assert.equal(access.mustChangeBlocks(user, token, '/api/us/me?x=1'), false);
    assert.equal(access.mustChangeBlocks(user, token, '/api/us/me/notices'), true);
    assert.equal(access.mustChangeBlocks(user, token, '/api/us/me/profile'), true);
    assert.equal(access.mustChangeBlocks(user, token, '/api/us/employees'), true);
});

/* ------------------------------- department names in the standard reports ------------------------------- */

test('a person placed in a department through the org page is reported under that department\'s name', () => {
    const names = new Map([['dep1', 'Store'], ['dep2', 'Cafe']]);
    const doc = (extra) => ({ orgId: 'o1', employeeId: 'EMP0001', name: 'Ann Alpha', usProfile: { startDate: '2026-01-05' }, ...extra });
    assert.equal(reports.normalizePerson('u1', doc({ usProfile: { startDate: '2026-01-05', departmentId: 'dep2' } }), names).department, 'Cafe');
    assert.equal(reports.normalizePerson('u1', doc({ usProfile: { startDate: '2026-01-05', departmentId: 'dep2' }, departmentName: 'Old name' }), names).department, 'Cafe', 'the id wins over an older stored name');
    assert.equal(reports.normalizePerson('u1', doc({ usProfile: { startDate: '2026-01-05', departmentId: 'gone' }, departmentName: 'Kitchen' }), names).department, 'Kitchen', 'an id that no longer exists falls back to the stored name');
    assert.equal(reports.normalizePerson('u1', doc({ departmentName: 'Kitchen' }), names).department, 'Kitchen');
    assert.equal(reports.normalizePerson('u1', doc({}), names).department, 'Unassigned');
    assert.equal(reports.normalizePerson('u1', doc({ usProfile: { startDate: '2026-01-05', departmentId: 'dep1' } })).department, 'Unassigned', 'without the list of names it is as before');
});

/* ------------------------------- the kiosk keypad follows the company's number format ------------------------------- */

test('a number typed on the kiosk is built with the company\'s own prefix and length', () => {
    assert.equal(timeRules.employeeIdFromKeypad('9'), 'EMP0009');
    assert.equal(timeRules.employeeIdFromKeypad('9', 'ST', 3), 'ST009');
    assert.equal(timeRules.employeeIdFromKeypad('00123', 'W', 6), 'W000123');
    assert.equal(timeRules.employeeIdFromKeypad(''), null);
    assert.equal(timeRules.employeeIdFromKeypad('1234567'), null, 'far too long for a 4-digit number');
});

/* ------------------------------- notices never fail what caused them ------------------------------- */

test('a notice with nobody to tell is skipped, and a failing database is swallowed', async () => {
    const stub = (rel, exports) => { const id = require.resolve(rel); const old = require.cache[id]; require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] }; return () => { if (old) require.cache[id] = old; else delete require.cache[id]; }; };
    const saved = [];
    let fail = false;
    const undoDb = stub('../config/firebase.js', { rawCollection: (name) => ({ add: async (d) => { if (fail) throw new Error('database is down'); saved.push({ name, ...d }); return { id: 'n1' }; } }) });
    const undoLog = stub('../utils/logger.js', { info() {}, warn() {}, error() {} });
    try {
        const notices = require('../services/notices.js');
        assert.equal(await notices.notify('o1', '', 'leave_approved', 'T', 'M'), false);
        assert.equal(await notices.notify('', 'u1', 'leave_approved', 'T', 'M'), false);
        assert.equal(saved.length, 0);
        assert.equal(await notices.notify('o1', 'u1', 'leave_approved', 'Time off approved', `  Your time off\n was approved. ${'x'.repeat(900)}`, { requestId: 'r1', orgId: 'someone-elses', userId: 'someone-else', read: true }), true);
        assert.equal(saved.length, 1);
        const n = saved[0];
        assert.deepEqual([n.name, n.orgId, n.userId, n.type, n.title, n.read, n.requestId], ['schedule_notices', 'o1', 'u1', 'leave_approved', 'Time off approved', false, 'r1'], 'extra fields cannot change who a notice is for or mark it read');
        assert.equal(n.message.length, 500); assert.ok(n.message.startsWith('Your time off was approved.'));
        fail = true;
        assert.equal(await notices.notify('o1', 'u1', 'leave_denied', 'T', 'M'), false, 'no throw');
    } finally { undoDb(); undoLog(); }
});
