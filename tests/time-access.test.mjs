import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../services/time-access.js');
const W = require('../services/approvals-rules.js');
const P = require('../services/permissions.js');

const user = (role, id = `u_${role}`) => ({ id, role });
const ROLES = ['super_admin', 'hr_admin', 'payroll_admin', 'manager', 'employee', 'accountant', 'auditor', 'executive'];
const us = (role) => A.timeAccess(user(role), 'US');

test('United States: what each of the eight roles may do on the time routes', () => {
    const table = Object.fromEntries(ROLES.map((r) => { const a = us(r); return [r, [a.teamNow, a.timesheets, a.addPunch, a.kioskManage, a.kioskView]]; }));
    assert.deepEqual(table, {
        super_admin:   ['all', 'all', 'all', true, true],
        hr_admin:      ['all', 'all', 'all', true, true],
        payroll_admin: ['all', 'all', 'all', false, true],   // was refused by the old role lists
        manager:       ['team', 'team', 'none', false, false],
        employee:      ['none', 'none', 'none', false, false],
        accountant:    ['none', 'none', 'none', false, false],
        auditor:       ['all', 'all', 'none', false, true],  // sees everything, changes nothing
        executive:     ['none', 'none', 'none', false, false]
    });
    ROLES.forEach((r) => assert.equal(us(r).legacy, false));
});

test('United States: the older spellings of the roles land on the same answers', () => {
    assert.deepEqual(A.timeAccess(user('Super Admin'), 'US'), us('super_admin'));
    assert.deepEqual(A.timeAccess(user('HRMS'), 'US'), us('hr_admin'));
    assert.deepEqual(A.timeAccess(user('Admin'), 'US'), us('hr_admin'));
    assert.deepEqual(A.timeAccess(user('Payroll Admin'), 'US'), us('payroll_admin'));
    assert.deepEqual(A.timeAccess(user('Manager'), 'US'), us('manager'));
    assert.deepEqual(A.timeAccess(user('something new'), 'US'), us('employee'));
    assert.deepEqual(A.timeAccess(null, 'US'), us('employee'));
});

test('a manager is limited to their own direct reports, and never themselves', () => {
    const mgr = user('manager', 'm1');
    const report = { id: 'e1', usProfile: { managerId: 'm1' } };
    const other = { id: 'e2', usProfile: { managerId: 'm2' } };
    const nobody = { id: 'e3' };
    assert.equal(A.allowedFor(mgr, 'team', report), true);
    assert.equal(A.allowedFor(mgr, 'team', other), false);
    assert.equal(A.allowedFor(mgr, 'team', nobody), false);
    assert.equal(A.allowedFor(mgr, 'team', { id: 'm1', usProfile: { managerId: 'm1' } }), false);
    assert.equal(A.allowedFor(mgr, 'team', undefined), false);
    assert.equal(A.allowedFor(mgr, 'none', report), false);
    // the whole-company roles see anyone
    for (const r of ['super_admin', 'hr_admin', 'payroll_admin', 'auditor']) assert.equal(A.allowedFor(user(r), us(r).teamNow, other), true);
    // an employee with a scope of none sees no one, even someone who lists them as manager
    assert.equal(A.allowedFor(user('employee', 'm1'), us('employee').teamNow, report), false);
});

test('outside the United States the old role lists still decide, exactly as before', () => {
    const inAccess = (role) => { const a = A.timeAccess(user(role), 'IN'); return [a.teamNow, a.timesheets, a.addPunch, a.kioskManage, a.kioskView]; };
    const adminHr = ['all', 'all', 'all', true, true];
    for (const r of ['Admin', 'Super Admin', 'super_admin', 'HRMS', 'hr_admin', 'hr_payroll']) assert.deepEqual(inAccess(r), adminHr, r);
    // "Manager" saw who is working across the company and nothing else
    assert.deepEqual(inAccess('Manager'), ['all', 'none', 'none', false, false]);
    assert.deepEqual(inAccess('manager'), ['all', 'none', 'none', false, false]);
    for (const r of ['Employee', 'employee', 'payroll_admin', 'auditor', 'accountant', 'executive', '']) assert.deepEqual(inAccess(r), ['none', 'none', 'none', false, false], r);
    assert.equal(A.timeAccess(user('Admin'), 'IN').legacy, true);
    assert.equal(A.timeAccess(user('Admin'), undefined).legacy, true);
    // these are the same names the old middleware lists held
    assert.deepEqual(A.LEGACY_ADMIN_HR.sort(), ['admin', 'hradmin', 'hrms', 'hrpayroll', 'superadmin']);
});

test('the permissions the approval routes check are held by the roles they are meant for', () => {
    const holders = (perm) => ROLES.filter((r) => P.can(user(r), perm));
    assert.deepEqual(holders('time.approve'), ['super_admin', 'hr_admin', 'payroll_admin']);        // decide for anyone, reopen a week
    assert.deepEqual(holders('time.approve_team'), ['super_admin', 'manager']);                     // decide for direct reports
    assert.deepEqual(holders('time.view_all'), ['super_admin', 'hr_admin', 'payroll_admin', 'auditor']); // see the approval lists
    assert.deepEqual(holders('time.manage_rules'), ['super_admin', 'hr_admin', 'payroll_admin']);
    assert.deepEqual(holders('time.export'), ['super_admin', 'hr_admin', 'payroll_admin', 'accountant']);
});

test('waiting for approval: what each of the eight roles is told', () => {
    const people = new Map([
        ['e1', { id: 'e1', usProfile: { managerId: 'u_manager' } }], ['e2', { id: 'e2', usProfile: { managerId: 'someone_else' } }],
        ['u_manager', { id: 'u_manager', usProfile: { managerId: 'u_hr_admin' } }], ['u_hr_admin', { id: 'u_hr_admin' }]
    ]);
    const data = {
        people,
        weeks: [
            { userId: 'e1', status: 'submitted' }, { userId: 'e1', status: 'approved' }, { userId: 'e2', status: 'submitted' },
            { userId: 'u_manager', status: 'submitted' }, { userId: 'u_hr_admin', status: 'submitted' }, { userId: 'e2', status: 'rejected' }
        ],
        corrections: [{ userId: 'e1', status: 'pending' }, { userId: 'e2', status: 'pending' }, { userId: 'e2', status: 'approved' }],
        leave: [{ userId: 'e1', status: 'pending' }, { userId: 'e2', status: 'pending' }, { userId: 'u_manager', status: 'pending' }, { userId: 'e1', status: 'cancelled' }]
    };
    const told = Object.fromEntries(ROLES.map((r) => { const w = W.waitingFor(user(r), data); return [r, [w.canApprove, w.timesheets, w.punchFixes, w.leaveRequests, w.total]]; }));
    assert.deepEqual(told, {
        super_admin:   [true, 4, 2, 3, 9],
        hr_admin:      [true, 3, 2, 3, 8],     // everyone's, but not their own week
        payroll_admin: [true, 4, 2, 0, 6],     // hours for everyone; they do not decide time off
        manager:       [true, 1, 1, 1, 3],     // only e1, who reports to them; not their own week or request
        employee:      [false, 0, 0, 0, 0],
        accountant:    [false, 0, 0, 0, 0],
        auditor:       [false, 0, 0, 0, 0],    // can look, cannot decide: nothing is waiting for them
        executive:     [false, 0, 0, 0, 0]
    });
    assert.deepEqual(W.waitingFor(user('manager'), data).scope, { time: 'team', leave: 'team' });
    assert.deepEqual(W.waitingFor(user('payroll_admin'), data).scope, { time: 'all', leave: 'none' });
    // nothing loaded yet: zeros, and the answer about who may decide is still right
    assert.deepEqual(W.waitingFor(user('hr_admin'), {}), { canApprove: true, scope: { time: 'all', leave: 'all' }, timesheets: 0, punchFixes: 0, leaveRequests: 0, total: 0 });
    assert.equal(W.waitingFor(null, data).total, 0);
    // a manager whose report is not in the people list is not counted (no guessing)
    assert.equal(W.waitingFor(user('manager'), { ...data, people: new Map() }).total, 0);
});
