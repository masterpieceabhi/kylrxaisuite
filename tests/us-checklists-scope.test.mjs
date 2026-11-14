// Checklists: a manager ticks manager tasks only for their own direct reports, and reading a person's lists
// never writes anything for a read-only role (routes/us-checklists.js, services/checklist-rules.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer, seedCompanies } from './helpers/permission-harness.mjs';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const router = require('../routes/us-checklists.js');

let srv;
test.before(async () => { srv = await startServer(router); });
test.after(async () => { await srv.stop(); });

const recentStart = () => new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
const listsOf = async (userId) => (await db.collection('checklists').where('userId', '==', userId).get()).docs;

test('managesPerson: only the manager a person reports to, never the manager themself', () => {
    const { managesPerson } = router.helpers;
    const mgr = { id: 'm1', role: 'manager' };
    assert.equal(managesPerson(mgr, { id: 'w1', data: { usProfile: { managerId: 'm1' } } }), true);
    assert.equal(managesPerson(mgr, { id: 'w1', data: { managerId: 'm1' } }), true, 'the older field');
    assert.equal(managesPerson(mgr, { id: 'w2', data: { usProfile: { managerId: 'm2' } } }), false);
    assert.equal(managesPerson(mgr, { id: 'w3', data: {} }), false, 'nobody set as manager');
    assert.equal(managesPerson(mgr, { id: 'm1', data: { usProfile: { managerId: 'm1' } } }), false, 'not their own lists');
    assert.equal(managesPerson({ id: 'e1', role: 'employee' }, { id: 'w1', data: { usProfile: { managerId: 'e1' } } }), false, 'the role must be manager');
});

test('live: a manager ticks a manager task for a direct report, not for someone on another team', async () => {
    const { person } = await seedCompanies(db, mem);
    const { call } = srv;
    const start = recentStart();
    await person('otherMgrA', 'orgA', 'manager', 'Mo Other');
    await person('mineA', 'orgA', 'employee', 'Rae Report', { usProfile: { startDate: start, managerId: 'managerA' } });
    await person('theirsA', 'orgA', 'employee', 'Tom Theirs', { usProfile: { startDate: start, managerId: 'otherMgrA' } });
    await person('nobodysA', 'orgA', 'employee', 'Ned Nobody', { usProfile: { startDate: start } });

    const setUp = async (userId) => {
        const list = (await call('GET', `/checklists/person/${userId}`, 'hr_adminA')).body.lists[0];
        const added = await call('POST', `/checklists/person/${userId}/${list.id}/tasks`, 'hr_adminA', { title: 'Walk the new hire through the floor', assignee: 'manager', dueDate: start });
        assert.equal(added.status, 201, added.text);
        return { list, task: added.body.task, employeeTask: list.tasks.find((t) => t.assignee === 'employee'), hrTask: list.tasks.find((t) => t.assignee === 'hr') };
    };
    const tick = (who, userId, s, task, status = 'done') => call('PUT', `/checklists/person/${userId}/${s.list.id}/tasks/${task.id}`, who, { status });

    const mine = await setUp('mineA'); const theirs = await setUp('theirsA'); const nobodys = await setUp('nobodysA');

    assert.equal((await tick('managerA', 'theirsA', theirs, theirs.task)).status, 403, 'another manager\'s report');
    assert.equal((await tick('managerA', 'nobodysA', nobodys, nobodys.task)).status, 403, 'a person with no manager set');
    assert.equal((await tick('otherMgrA', 'mineA', mine, mine.task)).status, 403);
    const stored = async (s) => (await db.collection('checklists').doc(s.list.id).get()).data().tasks.find((t) => t.id === s.task.id);
    assert.equal((await stored(theirs)).status, 'open', 'nothing was ticked');

    const ok = await tick('managerA', 'mineA', mine, mine.task);
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await stored(mine)).status, 'done'); assert.equal((await stored(mine)).doneBy, 'managerA');
    assert.equal((await tick('otherMgrA', 'theirsA', theirs, theirs.task)).status, 200, 'their own manager can');

    // a manager still cannot tick HR tasks or the person's own tasks, even for a direct report
    assert.equal((await tick('managerA', 'mineA', mine, mine.hrTask)).status, 403);
    assert.equal((await tick('managerA', 'mineA', mine, mine.employeeTask)).status, 403);
    // HR ticks a manager task for anyone; the person themself and other roles do not
    assert.equal((await tick('hr_adminA', 'nobodysA', nobodys, nobodys.task)).status, 200);
    for (const who of ['mineA', 'employeeA', 'payroll_adminA', 'accountantA', 'auditorA', 'executiveA']) assert.equal((await tick(who, 'mineA', mine, mine.task, 'open')).status, 403, who);
    // a manager task on the manager's own list is for THEIR manager
    await db.collection('users').doc('managerA').set({ usProfile: { startDate: start, managerId: 'managerA' } }, { merge: true });
    const own = await setUp('managerA');
    assert.equal((await tick('managerA', 'managerA', own, own.task)).status, 403);
});

test('live: an auditor reading a new hire\'s lists creates nothing; HR or the person opening them does', async () => {
    const { person } = await seedCompanies(db, mem);
    const { call } = srv;
    await person('newA', 'orgA', 'employee', 'Nia New', { usProfile: { startDate: recentStart() } });
    await person('new2A', 'orgA', 'employee', 'Ola Other', { usProfile: { startDate: recentStart() } });

    const read = await call('GET', '/checklists/person/newA', 'auditorA');
    assert.equal(read.status, 200, read.text);
    assert.deepEqual(read.body.lists, [], 'no list exists yet, and the read did not make one');
    assert.equal((await listsOf('newA')).length, 0, 'nothing was written');
    assert.equal(mem.install().db._dump().checklists, undefined);

    const hr = await call('GET', '/checklists/person/newA', 'hr_adminA');
    assert.equal(hr.body.lists.length, 1); assert.equal((await listsOf('newA')).length, 1, 'HR opening it starts the list');
    const again = await call('GET', '/checklists/person/newA', 'auditorA');
    assert.equal(again.body.lists[0].id, hr.body.lists[0].id, 'the auditor then reads the same list');
    assert.equal((await listsOf('newA')).length, 1);

    // the new hire opening their own page starts it too (both ways of asking)
    assert.equal((await call('GET', '/checklists/person/new2A', 'auditorA')).body.lists.length, 0);
    const mineList = await call('GET', '/checklists/mine', 'new2A');
    assert.equal(mineList.body.lists.length, 1); assert.equal((await listsOf('new2A')).length, 1);
    await person('new3A', 'orgA', 'employee', 'Pat Third', { usProfile: { startDate: recentStart() } });
    assert.equal((await call('GET', '/checklists/person/new3A', 'new3A')).body.lists.length, 1);
    assert.equal((await listsOf('new3A')).length, 1);
});
