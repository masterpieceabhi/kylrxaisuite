// Who may use the compliance routes (workplace notices, notice texts, EEO, injury log): every route, all eight roles.
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
const router = require('../routes/us-compliance.js');
const P = require('../services/permissions.js');
const allowed = guardChecker(router, requireUsOrg);

// route -> the roles that are let in. Everyone else gets 403.
const EXPECTED = [
    ['get', '/postings', OWNER_HR_AUDITOR],
    ['put', '/postings/:key', OWNER_HR],
    ['put', '/postings/:key/template', OWNER_HR],
    ['get', '/notice-templates', OWNER_HR_AUDITOR],
    ['get', '/notice-templates/:key', OWNER_HR_AUDITOR],
    ['post', '/notice-templates', OWNER_HR],
    ['put', '/notice-templates/:key', OWNER_HR],
    ['delete', '/notice-templates/:key', OWNER_HR],
    ['post', '/notice-templates/:key/reviewed', OWNER_HR],
    ['post', '/notice-templates/:key/restore', OWNER_HR],
    ['post', '/notice-templates/:key/render', OWNER_HR],
    ['put', '/notice-defaults', OWNER_HR],
    ['put', '/eeo/job-category/:userId', OWNER_HR],
    ['get', '/eeo/report', OWNER_HR],
    ['put', '/osha/incidents/:id/classify', OWNER_HR],
    ['get', '/osha/log', OWNER_HR_AUDITOR],
    ['get', '/osha/summary', OWNER_HR_AUDITOR]
];
// any signed-in person of the company: their own EEO answers, reporting an injury, their own reports
const OPEN = ['get /eeo/options', 'get /eeo/me', 'put /eeo/me', 'post /osha/report', 'get /osha/incidents'];

for (const [method, path, allow] of EXPECTED) {
    test(`${method.toUpperCase()} ${path}: allowed for ${allow.join(', ')} and nobody else`, () => {
        for (const role of ROLES) assert.equal(allowed(method, path, role), allow.includes(role), `${role} on ${method} ${path}`);
    });
}

test('every route of this file is covered above or is open to any person of the company', () => {
    assert.deepEqual(routeList(router), [...EXPECTED.map(([m, p]) => `${m} ${p}`), ...OPEN].sort());
    assertOpenRoutes(router, requireUsOrg, OPEN);
});

test('older role spellings still work the way they did; unknown roles get nothing', () => {
    for (const role of ['Super Admin', 'Admin', 'HRMS', 'hr_payroll', 'HR Admin']) {
        assert.equal(allowed('get', '/postings', role), true, role);
        assert.equal(allowed('put', '/postings/:key', role), true, role);
        assert.equal(allowed('get', '/osha/log', role), true, role);
    }
    for (const role of ['Manager', 'Employee', '', undefined, 'something odd']) {
        assert.equal(allowed('get', '/postings', role), false, String(role));
        assert.equal(allowed('get', '/eeo/report', role), false, String(role));
    }
});

test('the old role lists are gone from routes/us-compliance.js', () => {
    const src = fs.readFileSync(new URL('../routes/us-compliance.js', import.meta.url), 'utf8');
    assert.equal(/authorize\(|ADMIN_HR_ROLES|SENSITIVE_ROLES/.test(src), false);
    for (const p of ['compliance.view', 'compliance.manage', 'eeo.report', 'safety.manage']) { assert.ok(P.KNOWN_PERMISSIONS.includes(p), p); assert.ok(src.includes(`'${p}'`), p); }
});

/* ------------------------------ live: the auditor reads, nobody but HR writes ------------------------------ */

let srv;
test.before(async () => { srv = await startServer(router); });
test.after(async () => { await srv.stop(); });

test('live: an auditor reads notices, notice texts and the injury log but cannot change anything', async () => {
    await seedCompanies(db, mem);
    const { call } = srv;
    for (const path of ['/postings', '/notice-templates', '/notice-templates/fmla_rights', '/osha/log', '/osha/summary']) {
        assert.equal((await call('GET', path, 'auditorA')).status, 200, `auditor GET ${path}`);
        assert.equal((await call('GET', path, 'hr_adminA')).status, 200, `HR GET ${path}`);
        for (const who of ['payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA']) assert.equal((await call('GET', path, who)).status, 403, `${who} GET ${path}`);
        assert.equal((await call('GET', path, 'saIN')).status, 409, `India company GET ${path}`);
        assert.equal((await call('GET', path, null)).status, 401, `no token GET ${path}`);
    }
    assert.equal((await call('PUT', '/postings/flsa', 'auditorA', { postedOn: '2026-01-05' })).status, 403);
    assert.equal((await call('POST', '/notice-templates', 'auditorA', { title: 'Auditor text', body: 'An auditor must not be able to add this text.' })).status, 403);
    assert.equal((await call('POST', '/notice-templates/fmla_rights/render', 'auditorA', {})).status, 403);
    assert.equal((await call('GET', '/eeo/report', 'auditorA')).status, 403, 'EEO totals stay with HR');
    assert.equal((await call('GET', '/eeo/report', 'hr_adminA')).status, 200);
});

test('live: injury reports - a worker sees their own, HR and the auditor see all, only HR classifies; companies are separate', async () => {
    await seedCompanies(db, mem);
    const { call } = srv;
    const today = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10); // safely in the past in the company's time zone
    const report = { dateOfIncident: today, description: 'Cut a finger on the slicer while cleaning it', location: 'Kitchen' };
    const mine = await call('POST', '/osha/report', 'workerA', report);
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    assert.equal((await call('POST', '/osha/report', 'managerA', { ...report, description: 'Slipped on a wet floor near the back door' })).status, 201);
    assert.equal((await call('POST', '/osha/report', 'workerB', { ...report, description: 'Another company, a burn from the fryer' })).status, 201);

    const own = await call('GET', '/osha/incidents', 'workerA');
    assert.equal(own.body.count, 1); assert.equal(own.body.data[0].id, mine.body.id); assert.equal(own.body.data[0].userId, undefined, 'a worker gets the short form of their own report');
    for (const who of ['payroll_adminA', 'accountantA', 'executiveA', 'employeeA']) assert.equal((await call('GET', '/osha/incidents', who)).body.count, 0, `${who} sees no one else's reports`);
    for (const who of ['hr_adminA', 'super_adminA', 'auditorA']) {
        const all = await call('GET', '/osha/incidents', who);
        assert.equal(all.body.count, 2, `${who} sees every report of the company`); assert.ok(all.body.data.every((r) => r.orgId === 'orgA'));
    }
    assert.equal((await call('PUT', `/osha/incidents/${mine.body.id}/classify`, 'auditorA', {})).status, 403);
    assert.equal((await call('PUT', `/osha/incidents/${mine.body.id}/classify`, 'managerA', {})).status, 403);
    assert.equal((await call('PUT', `/osha/incidents/${mine.body.id}/classify`, 'hr_adminA', {})).status, 400, 'HR is let in and the empty form is refused');
    assert.equal((await call('PUT', `/osha/incidents/${mine.body.id}/classify`, 'hrB', {})).status, 404, 'another company cannot touch it');
});
