import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const router = require('../routes/us-people.js');
const usHr = require('../routes/us-hr.js');
const P = require('../services/permissions.js');

const ROLES = ['super_admin', 'hr_admin', 'payroll_admin', 'manager', 'employee', 'accountant', 'auditor', 'executive'];
const WRITERS = ['super_admin', 'hr_admin'];

/** Runs the permission check that guards a route (the first handler, before the company lookup) and says if it lets the role through */
function allowed(method, path, role) {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    assert.ok(layer, `route ${method} ${path} exists`);
    const guard = layer.route.stack[0].handle;
    assert.notEqual(guard, usHr.helpers.requireUsOrg, `${method} ${path} has a permission check before the company lookup`);
    assert.equal(layer.route.stack[1].handle, usHr.helpers.requireUsOrg, `${method} ${path} checks the company right after the permission`);
    let passed = false; let status = null; let body = null;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    guard({ user: { id: 'u1', role } }, res, () => { passed = true; });
    if (!passed) { assert.equal(status, 403, `${role} ${method} ${path}`); assert.equal(body.success, false); assert.equal(typeof body.error, 'string'); }
    return passed;
}

// Every route of this file needs people.write: adding people, links, approvals and sign-in resets are all changes to people.
const ROUTES = [
    ['post', '/employees'], ['post', '/employees/bulk'],
    ['get', '/team-import/fields'], ['post', '/team-import/analyze'], ['post', '/team-import/check'], ['post', '/team-import/create'],
    ['get', '/team-import/access'], ['post', '/team-import/people/:id/reissue'],
    ['get', '/team-import/join-links'], ['post', '/team-import/join-links'], ['delete', '/team-import/join-links/:id'],
    ['get', '/team-import/join-requests'], ['post', '/team-import/join-requests/:id/approve'], ['post', '/team-import/join-requests/:id/reject'], ['post', '/team-import/join-requests/approve-many']
];

for (const [method, path] of ROUTES) {
    test(`${method.toUpperCase()} ${path}: owner and HR admin only, of the eight roles`, () => {
        for (const role of ROLES) assert.equal(allowed(method, path, role), WRITERS.includes(role), `${role} on ${method} ${path}`);
    });
}

test('every route of this file is covered above', () => {
    const routes = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`).sort();
    assert.deepEqual(routes, ROUTES.map(([m, p]) => `${m} ${p}`).sort());
});

test('older role spellings still work the way they did with the old role list', () => {
    for (const role of ['Super Admin', 'Admin', 'HRMS', 'hr_payroll', 'HR Admin', 'SUPER_ADMIN']) {
        assert.equal(allowed('post', '/employees', role), true, role);
        assert.equal(allowed('post', '/employees/bulk', role), true, role);
        assert.equal(allowed('post', '/team-import/create', role), true, role);
    }
    for (const role of ['Manager', 'Employee', 'payroll_admin', '', undefined, 'something odd']) {
        assert.equal(allowed('post', '/employees', role), false, String(role));
        assert.equal(allowed('post', '/team-import/people/:id/reissue', role), false, String(role));
    }
});

test('nobody gets in without signing in: the sign-in check runs before every route', () => {
    const { verifyToken } = require('../middleware/authMiddleware.js');
    const first = router.stack[0];
    assert.equal(first.route, undefined); assert.equal(first.handle, verifyToken);
});

test('the old role lists are gone from routes/us-people.js', () => {
    const src = fs.readFileSync(new URL('../routes/us-people.js', import.meta.url), 'utf8');
    assert.equal(/authorize\(|ADMIN_HR_ROLES|MANAGER_ROLES/.test(src), false);
    assert.match(src, /services\/permissions/);
    assert.ok(P.KNOWN_PERMISSIONS.includes('people.write'));
    assert.deepEqual(P.PERMISSIONS['people.write'], ['super_admin', 'hr_admin']);
});

test('the public set-up and join routes are rate limited, and the two signed-in ones check the sign-in', () => {
    const { verifyToken } = require('../middleware/authMiddleware.js');
    const pub = require('../routes/team-access-public.js');
    const routes = Object.fromEntries(pub.stack.filter((l) => l.route).map((l) => [`${Object.keys(l.route.methods)[0]} ${l.route.path}`, l.route.stack.map((s) => s.handle)]));
    assert.deepEqual(Object.keys(routes).sort(), ['get /password-status', 'post /change-password', 'post /team/join/info', 'post /team/join/request', 'post /team/setup/complete', 'post /team/setup/info']);
    for (const key of ['post /team/setup/info', 'post /team/setup/complete', 'post /team/join/info', 'post /team/join/request', 'post /change-password']) {
        assert.equal(routes[key].length >= 2, true, `${key} has a limiter before its handler`);
        assert.notEqual(routes[key][0], verifyToken);
    }
    assert.equal(routes['get /password-status'][0], verifyToken);
    assert.equal(routes['post /change-password'][1], verifyToken);
    // link tokens are read from the request body, never from the address (addresses end up in access logs)
    const src = fs.readFileSync(new URL('../routes/team-access-public.js', import.meta.url), 'utf8');
    assert.equal(/req\.(params|query)/.test(src), false);
    // and the auth router really mounts them
    assert.match(fs.readFileSync(new URL('../routes/auth.js', import.meta.url), 'utf8'), /require\('\.\/team-access-public'\)/);
});

test('only a hash of a link token is ever written to the database', () => {
    const src = fs.readFileSync(new URL('../services/us-people-service.js', import.meta.url), 'utf8');
    const writes = src.split('\n').filter((l) => /rawCollection\(LINKS\)\.doc\(/.test(l));
    assert.ok(writes.length >= 3);
    writes.forEach((l) => assert.match(l, /doc\((hash|L\.hashToken\(token\)|String\(id\))\)/, l));
    assert.equal(/\btoken\b\s*[:,]\s*token|[{,]\s*token\s*[,}]/.test(src.split('\n').filter((l) => /\.set\(|\.add\(/.test(l)).join('\n')), false);
});
