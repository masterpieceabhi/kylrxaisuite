import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../services/permissions.js');

const u = (role, id = 'u1') => ({ id, role });

test('old role names map onto the canonical roles', () => {
    assert.equal(P.canonicalRole('Super Admin'), 'super_admin');
    assert.equal(P.canonicalRole('super_admin'), 'super_admin');
    assert.equal(P.canonicalRole('Admin'), 'hr_admin');
    assert.equal(P.canonicalRole('HRMS'), 'hr_admin');
    assert.equal(P.canonicalRole('hr_payroll'), 'hr_admin');
    assert.equal(P.canonicalRole('Payroll Admin'), 'payroll_admin');
    assert.equal(P.canonicalRole('client_executive'), 'executive');
    assert.equal(P.canonicalRole('Manager'), 'manager');
    assert.equal(P.canonicalRole('something odd'), 'employee');
    assert.equal(P.canonicalRole(undefined), 'employee');
});

test('owner holds every permission; employees hold none of the admin ones', () => {
    for (const p of P.KNOWN_PERMISSIONS) assert.equal(P.can(u('super_admin'), p), true, p);
    for (const p of ['people.read', 'people.write', 'pii.reveal', 'time.approve', 'reports.view', 'billing.manage', 'integrations.manage']) assert.equal(P.can(u('employee'), p), false, p);
    assert.equal(P.can(u('employee'), 'not.a.permission'), false);
});

test('HR does not hold billing, integrations or payroll-run rights', () => {
    assert.equal(P.can(u('hr_admin'), 'people.write'), true);
    assert.equal(P.can(u('hr_admin'), 'pii.reveal'), true);
    assert.equal(P.can(u('hr_admin'), 'billing.manage'), false);
    assert.equal(P.can(u('hr_admin'), 'integrations.manage'), false);
    assert.equal(P.can(u('hr_admin'), 'payroll.run'), false);
});

test('payroll admin handles hours and payroll but not people records or SSNs', () => {
    assert.equal(P.can(u('payroll_admin'), 'time.approve'), true);
    assert.equal(P.can(u('payroll_admin'), 'time.export'), true);
    assert.equal(P.can(u('payroll_admin'), 'payroll.run'), true);
    assert.equal(P.can(u('payroll_admin'), 'people.write'), false);
    assert.equal(P.can(u('payroll_admin'), 'pii.reveal'), false);
    assert.equal(P.can(u('payroll_admin'), 'vault.confidential'), false);
});

test('accountant and auditor are read-only', () => {
    for (const role of ['accountant', 'auditor']) {
        for (const p of P.KNOWN_PERMISSIONS.filter((x) => /\.(write|manage|run|approve|decide|reveal|impersonate)$/.test(x) || x === 'time.approve')) assert.equal(P.can(u(role), p), false, `${role} ${p}`);
    }
    assert.equal(P.can(u('accountant'), 'payroll.view'), true);
    assert.equal(P.can(u('accountant'), 'time.export'), true);
    assert.equal(P.can(u('accountant'), 'people.read'), false);
    assert.equal(P.can(u('auditor'), 'people.read'), true);
    assert.equal(P.can(u('auditor'), 'audit.view'), true);
    assert.equal(P.can(u('auditor'), 'vault.confidential'), false);
    assert.equal(P.can(u('auditor'), 'pii.reveal'), false);
});

test('executives see reports only', () => {
    assert.deepEqual(P.permissionsFor('executive'), ['reports.view']);
});

test('managers see only their direct reports, never themselves', () => {
    const mgr = u('manager', 'm1');
    assert.equal(P.canManage(mgr, { id: 'e1', usProfile: { managerId: 'm1' } }), true);
    assert.equal(P.canManage(mgr, { id: 'e2', usProfile: { managerId: 'm2' } }), false);
    assert.equal(P.canManage(mgr, { id: 'e3' }), false);
    assert.equal(P.canManage(mgr, { id: 'm1', usProfile: { managerId: 'm1' } }), false);
    assert.equal(P.canManage(mgr, { id: 'e4', managerId: 'm1' }), true);
    assert.equal(P.canManage(mgr, { id: 'e5', reportingManagerId: 'm1' }, 'leave'), true);
});

test('company-wide roles manage anyone; others cannot', () => {
    const anyone = { id: 'e1', usProfile: { managerId: 'm9' } };
    assert.equal(P.canManage(u('hr_admin'), anyone), true);
    assert.equal(P.canManage(u('payroll_admin'), anyone, 'time'), true);
    assert.equal(P.canManage(u('payroll_admin'), anyone, 'leave'), false); // payroll does not decide leave
    assert.equal(P.canManage(u('employee'), anyone), false);
    assert.equal(P.canManage(u('accountant'), anyone), false);
    assert.equal(P.canManage(null, anyone), false);
});

test('middleware allows or refuses by permission', () => {
    const run = (mw, role) => { let status = 200; let nextCalled = false; mw({ user: { role } }, { status(c) { status = c; return this; }, json() {} }, () => { nextCalled = true; }); return nextCalled ? 200 : status; };
    const mw = P.requirePermission('time.approve');
    assert.equal(run(mw, 'hr_admin'), 200); assert.equal(run(mw, 'employee'), 403); assert.equal(run(mw, 'auditor'), 403);
    assert.equal(run(P.requireAnyPermission('time.approve', 'reports.view'), 'accountant'), 200);
    assert.throws(() => P.requirePermission('nope'));
});
