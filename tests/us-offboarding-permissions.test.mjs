// Who may use the offboarding routes (terminations, rehire, exit interviews): every route, all eight roles.
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
const router = require('../routes/us-offboarding.js');
const P = require('../services/permissions.js');
const allowed = guardChecker(router, requireUsOrg);

const EXPECTED = [
    ['get', '/offboarding', OWNER_HR_AUDITOR],
    ['get', '/offboarding/:id/summary', OWNER_HR_AUDITOR],
    ['post', '/offboarding/:id/terminate', OWNER_HR],
    ['post', '/offboarding/:id/cancel', OWNER_HR],
    ['post', '/offboarding/:id/rehire', OWNER_HR],
    // exit interviews: answers are for HR and the owner only, never an auditor
    ['get', '/exit-interviews/questions', OWNER_HR],
    ['put', '/exit-interviews/questions', OWNER_HR],
    ['post', '/exit-interviews/questions/reset', OWNER_HR],
    ['get', '/exit-interviews/summary', OWNER_HR],
    ['get', '/exit-interviews', OWNER_HR],
    ['get', '/exit-interviews/:id', OWNER_HR],
    ['put', '/exit-interviews/:id', OWNER_HR]
];
const OPEN = ['get /exit-interview/me', 'put /exit-interview/me']; // the person's own exit interview

for (const [method, path, allow] of EXPECTED) {
    test(`${method.toUpperCase()} ${path}: allowed for ${allow.join(', ')} and nobody else`, () => {
        for (const role of ROLES) assert.equal(allowed(method, path, role), allow.includes(role), `${role} on ${method} ${path}`);
    });
}

test('every route of this file is covered above or is the person\'s own exit interview', () => {
    assert.deepEqual(routeList(router), [...EXPECTED.map(([m, p]) => `${m} ${p}`), ...OPEN].sort());
    assertOpenRoutes(router, requireUsOrg, OPEN);
});

test('older role spellings: every HR spelling may now record a termination', () => {
    for (const role of ['Super Admin', 'Admin', 'HRMS', 'hr_payroll', 'HR Admin']) {
        assert.equal(allowed('post', '/offboarding/:id/terminate', role), true, role);
        assert.equal(allowed('get', '/offboarding', role), true, role);
    }
    for (const role of ['Manager', 'Employee', '', undefined, 'something odd']) assert.equal(allowed('get', '/offboarding', role), false, String(role));
});

test('the old role lists are gone from routes/us-offboarding.js', () => {
    const src = fs.readFileSync(new URL('../routes/us-offboarding.js', import.meta.url), 'utf8');
    assert.equal(/authorize\(|ADMIN_HR_ROLES|OFFBOARD_ROLES/.test(src), false);
    for (const p of ['people.read', 'people.write']) { assert.ok(P.KNOWN_PERMISSIONS.includes(p), p); assert.ok(src.includes(`'${p}'`), p); }
});

/* ------------------------------------------- live ------------------------------------------- */

let srv;
test.before(async () => { srv = await startServer(router); });
test.after(async () => { await srv.stop(); });

test('live: HR records a termination; the auditor reads the list and the summary but cannot change anything; a rehire leaves a note for the I-9', async () => {
    const { person } = await seedCompanies(db, mem);
    const { call } = srv;
    const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    await person('goA', 'orgA', 'employee', 'Gia Going', { joiningDate: iso(-400), usProfile: { startDate: iso(-400) }, usForms: { i9: { section1: { signedAt: `${iso(-400)}T10:00:00.000Z` }, section2: { examinedOn: iso(-399) } } } });
    const end = { lastDay: iso(-2), type: 'resignation', reason: 'moving away' };

    for (const who of ['auditorA', 'payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA']) assert.equal((await call('POST', '/offboarding/goA/terminate', who, end)).status, 403, `${who} cannot record a termination`);
    assert.equal((await call('POST', '/offboarding/goA/terminate', 'hrB', end)).status, 404);
    assert.equal((await call('POST', '/offboarding/goA/terminate', 'saIN', end)).status, 409);
    assert.equal((await call('POST', '/offboarding/hr_adminA/terminate', 'hr_adminA', end)).status, 403, 'nobody ends their own employment');
    const done = await call('POST', '/offboarding/goA/terminate', 'hr_adminA', end);
    assert.equal(done.status, 201, done.text); assert.equal(done.body.immediate, true);

    for (const who of ['hr_adminA', 'super_adminA', 'auditorA']) {
        const list = await call('GET', '/offboarding', who);
        assert.equal(list.status, 200, `${who} list`); assert.deepEqual(list.body.data.map((r) => r.userId), ['goA']);
        assert.equal((await call('GET', '/offboarding/goA/summary', who)).status, 200, `${who} summary`);
    }
    for (const who of ['payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA']) {
        assert.equal((await call('GET', '/offboarding', who)).status, 403, `${who} list`);
        assert.equal((await call('GET', '/offboarding/goA/summary', who)).status, 403, `${who} summary`);
    }
    assert.deepEqual((await call('GET', '/offboarding', 'hrB')).body.data, []);
    assert.equal((await call('GET', '/exit-interviews/goA', 'auditorA')).status, 403, 'exit interview answers stay with HR');

    assert.equal((await call('POST', '/offboarding/goA/rehire', 'auditorA', { startDate: iso(0) })).status, 403);
    assert.equal((await call('POST', '/offboarding/goA/cancel', 'auditorA', {})).status, 403);
    const back = await call('POST', '/offboarding/goA/rehire', 'hr_adminA', { startDate: iso(0) });
    assert.equal(back.status, 201, back.text); assert.equal(back.body.i9.action, 'update_section_3');
    const stored = (await db.collection('users').doc('goA').get()).data();
    assert.equal(stored.status, 'Active');
    assert.deepEqual({ action: stored.usForms.i9.rehire.action, startDate: stored.usForms.i9.rehire.startDate }, { action: 'update_section_3', startDate: iso(0) });
    assert.ok(stored.usForms.i9.section1 && stored.usForms.i9.section2, 'the earlier form is still there');
});
