import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const router = require('../routes/us-hr.js');
const P = require('../services/permissions.js');

const ROLES = ['super_admin', 'hr_admin', 'payroll_admin', 'manager', 'employee', 'accountant', 'auditor', 'executive'];

/** Runs the permission check that guards a route (the first handler, before the company lookup) and says if it lets the role through */
function allowed(method, path, role) {
    const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
    assert.ok(layer, `route ${method} ${path} exists`);
    const guard = layer.route.stack[0].handle;
    assert.notEqual(guard, router.helpers.requireUsOrg, `${method} ${path} has a permission check before the company lookup`);
    let passed = false; let status = null; let body = null;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    guard({ user: { id: 'u1', role } }, res, () => { passed = true; });
    if (!passed) { assert.equal(status, 403, `${role} ${method} ${path}`); assert.equal(body.success, false); assert.equal(typeof body.error, 'string'); }
    return passed;
}

// route -> the roles that are let in. Everyone else gets 403.
const EXPECTED = [
    ['get', '/company/profile', ['super_admin', 'hr_admin', 'payroll_admin', 'accountant', 'auditor']],
    ['put', '/company/profile', ['super_admin', 'hr_admin']],
    ['get', '/employees', ['super_admin', 'hr_admin', 'auditor']],
    ['put', '/employees/:id/profile', ['super_admin', 'hr_admin']],
    ['post', '/employees/:id/taxpayer-id/reveal', ['super_admin', 'hr_admin']]
];

for (const [method, path, allow] of EXPECTED) {
    test(`${method.toUpperCase()} ${path}: allowed for ${allow.join(', ')} and nobody else`, () => {
        for (const role of ROLES) assert.equal(allowed(method, path, role), allow.includes(role), `${role} on ${method} ${path}`);
    });
}

test('every route of this file is covered above or checks the person inside the handler', () => {
    const routes = router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`).sort();
    const covered = [...EXPECTED.map(([m, p]) => `${m} ${p}`), 'get /employees/:id/profile'].sort();
    assert.deepEqual(routes, covered);
});

test('a person reads their own US profile; other people need people.read', () => {
    const { canSeeProfile } = router.helpers;
    const emp = { id: 'emp1', data: { uid: 'emp1', orgId: 'o1' } };
    const other = (role) => ({ id: 'someone-else', role });
    const expected = { super_admin: true, hr_admin: true, auditor: true, payroll_admin: false, manager: false, employee: false, accountant: false, executive: false };
    for (const role of ROLES) {
        assert.equal(canSeeProfile(other(role), emp), expected[role], `${role} reading another person`);
        assert.equal(canSeeProfile({ id: 'emp1', role }, emp), true, `${role} reading their own profile`);
    }
    // roster records keep the login id in uid / userId
    assert.equal(canSeeProfile({ id: 'login9', role: 'employee' }, { id: 'EMP-9', data: { userId: 'login9' } }), true);
    assert.equal(canSeeProfile({ id: 'login9', role: 'employee' }, { id: 'EMP-9', data: { uid: 'login9' } }), true);
    // no id on the user must never match a record that has no ids either
    assert.equal(canSeeProfile({ role: 'employee' }, { id: undefined, data: {} }), false);
    assert.equal(canSeeProfile(null, emp), false);
    assert.equal(canSeeProfile({ id: 'x', role: 'employee' }, null), false);
});

test('older role spellings still work the way they did', () => {
    for (const role of ['Super Admin', 'Admin', 'HRMS', 'hr_payroll', 'HR Admin']) {
        assert.equal(allowed('get', '/employees', role), true, role);
        assert.equal(allowed('put', '/employees/:id/profile', role), true, role);
        assert.equal(allowed('put', '/company/profile', role), true, role);
    }
    for (const role of ['Manager', 'Employee', '', undefined, 'something odd']) {
        assert.equal(allowed('get', '/employees', role), false, String(role));
        assert.equal(allowed('get', '/company/profile', role), false, String(role));
    }
});

test('the old role lists are gone from routes/us-hr.js', () => {
    const src = fs.readFileSync(new URL('../routes/us-hr.js', import.meta.url), 'utf8');
    assert.equal(/authorize\(|ADMIN_HR_ROLES|REVEAL_ROLES|COMPANY_WRITE_ROLES/.test(src), false);
    assert.match(src, /services\/permissions/);
    for (const p of ['org.settings', 'payroll.view', 'people.read', 'people.write', 'pii.reveal']) assert.ok(P.KNOWN_PERMISSIONS.includes(p), p);
});
