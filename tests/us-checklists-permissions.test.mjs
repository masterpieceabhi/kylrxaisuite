// Who may use the checklist routes (new-hire and leaving tasks): every route, all eight roles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ROLES, OWNER_HR, OWNER_HR_AUDITOR, guardChecker, routeList, assertOpenRoutes, startServer, seedCompanies } from './helpers/permission-harness.mjs';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const { requireUsOrg } = require('../routes/us-hr.js').helpers;
const router = require('../routes/us-checklists.js');
const P = require('../services/permissions.js');
const allowed = guardChecker(router, requireUsOrg);

const EXPECTED = [
    ['post', '/checklists/person/:userId/:listId/tasks', OWNER_HR],
    ['get', '/checklists/templates', OWNER_HR_AUDITOR],
    ['put', '/checklists/templates', OWNER_HR],
    ['get', '/checklists/overview', OWNER_HR_AUDITOR]
];
// a person's own lists and ticking a task are decided inside the handler
const OPEN = ['get /checklists/person/:userId', 'get /checklists/mine', 'put /checklists/person/:userId/:listId/tasks/:taskId'];

for (const [method, path, allow] of EXPECTED) {
    test(`${method.toUpperCase()} ${path}: allowed for ${allow.join(', ')} and nobody else`, () => {
        for (const role of ROLES) assert.equal(allowed(method, path, role), allow.includes(role), `${role} on ${method} ${path}`);
    });
}

test('every route of this file is covered above or checks the person inside the handler', () => {
    assert.deepEqual(routeList(router), [...EXPECTED.map(([m, p]) => `${m} ${p}`), ...OPEN].sort());
    assertOpenRoutes(router, requireUsOrg, OPEN);
});

test('reading anyone\'s lists needs people.read; skipping a required task needs people.write', () => {
    const { canReadAll, isStaff } = router.helpers;
    for (const role of ROLES) {
        assert.equal(canReadAll({ id: 'x', role }), OWNER_HR_AUDITOR.includes(role), `${role} reading another person's lists`);
        assert.equal(isStaff({ id: 'x', role }), OWNER_HR.includes(role), `${role} skipping a required task`);
    }
    for (const role of ['Super Admin', 'Admin', 'HRMS', 'hr_payroll']) assert.equal(isStaff({ role }), true, role);
});

test('the old role lists are gone from routes/us-checklists.js', () => {
    const src = fs.readFileSync(new URL('../routes/us-checklists.js', import.meta.url), 'utf8');
    assert.equal(/authorize\(|ADMIN_HR_ROLES/.test(src), false);
    for (const p of ['people.read', 'people.write']) { assert.ok(P.KNOWN_PERMISSIONS.includes(p), p); assert.ok(src.includes(`'${p}'`), p); }
});

/* ------------------------------------------- live ------------------------------------------- */

let srv;
test.before(async () => { srv = await startServer(router); });
test.after(async () => { await srv.stop(); });

test('live: HR and the auditor read a new hire\'s list; only HR adds, skips and changes templates; a person sees and ticks their own', async () => {
    const { person } = await seedCompanies(db, mem);
    const { call } = srv;
    const start = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
    await person('newA', 'orgA', 'employee', 'Nia New', { usProfile: { startDate: start } });

    const first = await call('GET', '/checklists/person/newA', 'hr_adminA');
    assert.equal(first.status, 200, first.text); assert.equal(first.body.lists.length, 1); assert.equal(first.body.lists[0].kind, 'onboarding');
    const list = first.body.lists[0];
    assert.equal((await call('GET', '/checklists/person/newA', 'auditorA')).body.lists[0].id, list.id, 'the auditor reads it');
    assert.equal((await call('GET', '/checklists/person/newA', 'newA')).status, 200, 'the person reads their own');
    for (const who of ['payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA']) assert.equal((await call('GET', '/checklists/person/newA', who)).status, 403, `${who} cannot read another person's list`);
    assert.equal((await call('GET', '/checklists/person/newA', 'hrB')).status, 404);
    assert.equal((await call('GET', '/checklists/person/newA', 'saIN')).status, 409);

    for (const path of ['/checklists/overview', '/checklists/templates']) {
        assert.equal((await call('GET', path, 'auditorA')).status, 200, `auditor ${path}`);
        assert.equal((await call('GET', path, 'hr_adminA')).status, 200);
        for (const who of ['payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA']) assert.equal((await call('GET', path, who)).status, 403, `${who} ${path}`);
    }
    assert.ok((await call('GET', '/checklists/overview', 'auditorA')).body.data.some((r) => r.userId === 'newA'));
    assert.equal((await call('GET', '/checklists/overview', 'hrB')).body.data.length, 0, 'another company has none of these tasks');

    const add = { title: 'Hand over the store keys', assignee: 'hr', dueDate: start };
    assert.equal((await call('POST', `/checklists/person/newA/${list.id}/tasks`, 'auditorA', add)).status, 403);
    assert.equal((await call('POST', `/checklists/person/newA/${list.id}/tasks`, 'newA', add)).status, 403);
    assert.equal((await call('PUT', '/checklists/templates', 'auditorA', { settings: {} })).status, 403);

    const mineTask = list.tasks.find((t) => t.assignee === 'employee'); const hrTask = list.tasks.find((t) => t.assignee === 'hr' && t.required);
    assert.ok(mineTask && hrTask, 'the built-in list has a task for the person and a required one for HR');
    const tick = (who, task, status) => call('PUT', `/checklists/person/newA/${list.id}/tasks/${task.id}`, who, { status });
    assert.equal((await tick('auditorA', hrTask, 'done')).status, 403, 'the auditor cannot tick');
    assert.equal((await tick('employeeA', mineTask, 'done')).status, 403, 'another employee cannot tick');
    assert.equal((await tick('newA', hrTask, 'done')).status, 403, 'the person cannot tick an HR task');
    if (mineTask.required) assert.equal((await tick('newA', mineTask, 'skipped')).status, 403, 'only HR skips a required task');
    assert.equal((await tick('newA', mineTask, 'done')).status, 200);
    assert.equal((await tick('hr_adminA', hrTask, 'skipped')).status, 200);
    assert.equal((await tick('hrB', hrTask, 'done')).status, 404);
});
