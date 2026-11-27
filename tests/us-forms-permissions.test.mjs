// Who may use the new-hire form routes (W-4, I-9, direct deposit): every route, all eight roles.
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
const router = require('../routes/us-forms.js');
const P = require('../services/permissions.js');
const allowed = guardChecker(router, requireUsOrg);

const EXPECTED = [
    ['put', '/employees/:id/i9/section2', OWNER_HR],
    ['get', '/i9/options', OWNER_HR_AUDITOR],
    ['get', '/i9', OWNER_HR_AUDITOR],
    ['get', '/employees/:id/i9', OWNER_HR_AUDITOR],
    ['post', '/employees/:id/i9/reverification', OWNER_HR],
    ['post', '/employees/:id/i9/documents', OWNER_HR],
    ['post', '/employees/:id/i9/document-number/reveal', OWNER_HR],
    ['get', '/compliance/onboarding', OWNER_HR_AUDITOR]
];
// the person's own forms: the handler lets in the person, or people.read (to read) / people.write (to fill in)
const OPEN = ['get /employees/:id/forms', 'put /employees/:id/w4', 'put /employees/:id/direct-deposit', 'put /employees/:id/i9/section1'];

for (const [method, path, allow] of EXPECTED) {
    test(`${method.toUpperCase()} ${path}: allowed for ${allow.join(', ')} and nobody else`, () => {
        for (const role of ROLES) assert.equal(allowed(method, path, role), allow.includes(role), `${role} on ${method} ${path}`);
    });
}

test('every route of this file is covered above or checks the person inside the handler', () => {
    assert.deepEqual(routeList(router), [...EXPECTED.map(([m, p]) => `${m} ${p}`), ...OPEN].sort());
    assertOpenRoutes(router, requireUsOrg, OPEN);
});

test('a person reads and fills in their own forms; other people need people.read to read and people.write to fill in', () => {
    const { canRead, canWrite } = router.helpers;
    const emp = { id: 'emp1', data: { uid: 'emp1', orgId: 'o1' } };
    for (const role of ROLES) {
        assert.equal(canRead({ id: 'other', role }, emp), OWNER_HR_AUDITOR.includes(role), `${role} reading another person's forms`);
        assert.equal(canWrite({ id: 'other', role }, emp), OWNER_HR.includes(role), `${role} filling in another person's forms`);
        assert.equal(canRead({ id: 'emp1', role }, emp), true, `${role} reading their own forms`);
        assert.equal(canWrite({ id: 'emp1', role }, emp), true, `${role} filling in their own forms`);
    }
    assert.equal(canWrite({ id: 'login9', role: 'employee' }, { id: 'EMP-9', data: { userId: 'login9' } }), true, 'roster records keep the login id in userId');
    assert.equal(canRead({ role: 'employee' }, { id: undefined, data: {} }), false, 'no id on the user never matches a record without ids');
});

test('the old role lists are gone from routes/us-forms.js', () => {
    const src = fs.readFileSync(new URL('../routes/us-forms.js', import.meta.url), 'utf8');
    assert.equal(/authorize\(|ADMIN_HR_ROLES|isStaff/.test(src), false);
    for (const p of ['people.read', 'people.write', 'compliance.view', 'compliance.manage', 'pii.reveal', 'vault.confidential']) { assert.ok(P.KNOWN_PERMISSIONS.includes(p), p); assert.ok(src.includes(`'${p}'`), p); }
});

/* ------------------------------------------- live ------------------------------------------- */

let srv;
test.before(async () => { srv = await startServer(router); });
test.after(async () => { await srv.stop(); });

test('live: forms of another person - HR reads and writes, the auditor only reads, everyone else is refused; the paperwork list opens for the auditor', async () => {
    const { person } = await seedCompanies(db, mem);
    const { call } = srv;
    await person('newA', 'orgA', 'employee', 'Nia New', { usProfile: { startDate: '2026-01-05' } });
    const w4 = { taxYear: 2026, filingStatus: 'single_or_mfs', declarationAccepted: true, signedName: 'Nia New' };
    const bank = { bankName: 'First Bank', routingNumber: '021000021', accountNumber: '123456789012', accountType: 'checking', authorized: true };

    assert.equal((await call('GET', '/employees/newA/forms', 'newA')).status, 200);
    assert.equal((await call('GET', '/employees/newA/forms', 'hr_adminA')).status, 200);
    assert.equal((await call('GET', '/employees/newA/forms', 'auditorA')).status, 200, 'the auditor reads');
    for (const who of ['payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA']) assert.equal((await call('GET', '/employees/newA/forms', who)).status, 403, `${who} reading`);
    assert.equal((await call('GET', '/employees/newA/forms', 'hrB')).status, 404);
    assert.equal((await call('GET', '/employees/newA/forms', 'saIN')).status, 409);
    assert.equal((await call('GET', '/employees/newA/forms', null)).status, 401);

    for (const who of ['auditorA', 'payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA']) {
        assert.equal((await call('PUT', '/employees/newA/w4', who, w4)).status, 403, `${who} W-4`);
        assert.equal((await call('PUT', '/employees/newA/direct-deposit', who, bank)).status, 403, `${who} bank details`);
        assert.equal((await call('PUT', '/employees/newA/i9/section1', who, {})).status, 403, `${who} Section 1`);
    }
    assert.equal((await call('PUT', '/employees/newA/w4', 'newA', w4)).status, 200);
    assert.equal((await call('PUT', '/employees/newA/w4', 'hr_adminA', w4)).status, 200);
    assert.equal((await call('PUT', '/employees/newA/i9/section1', 'hr_adminA', {})).status, 400, 'HR is let in and the empty form is refused');

    const list = await call('GET', '/compliance/onboarding', 'auditorA');
    assert.equal(list.status, 200); assert.ok(list.body.data.some((r) => r.name === 'Nia New' && r.w4 === 'complete'));
    for (const who of ['payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA']) assert.equal((await call('GET', '/compliance/onboarding', who)).status, 403, `${who} paperwork list`);
    assert.ok(!(await call('GET', '/compliance/onboarding', 'hrB')).body.data.some((r) => r.name === 'Nia New'));
});
