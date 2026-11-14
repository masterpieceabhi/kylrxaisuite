// Who may list and download a person's payslips (routes/payroll.js, services/payroll-doc-access.js):
// the person themself or a role that may see pay, and always inside one company.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { ROLES, seedCompanies } from './helpers/permission-harness.mjs';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const mem = require('./helpers/memory-firestore.js');
const { db, admin } = mem.install();
const A = require('../services/payroll-doc-access.js');
const router = require('../routes/payroll.js');

const PAY_ROLES = ['super_admin', 'hr_admin', 'payroll_admin', 'accountant', 'auditor'];
const INDIA_HR = ['Admin', 'Super Admin', 'super_admin', 'HRMS', 'hr_admin', 'hr_payroll'];

/* ------------------------------------------- pure ------------------------------------------- */

test('a person asks for their own documents; otherwise only a role that may see pay', () => {
    for (const role of ROLES) {
        assert.equal(A.mayAskFor({ id: 'me', role }, 'me'), true, `${role} reads their own`);
        assert.equal(A.mayAskFor({ id: 'me', role }, 'someone'), PAY_ROLES.includes(role), `${role} reading another person's`);
    }
    for (const role of INDIA_HR) assert.equal(A.mayAskFor({ id: 'me', role }, 'someone'), true, `India HR name ${role}`);
    for (const role of ['Manager', 'Employee', 'client_executive', '', undefined, 'made_up']) assert.equal(A.mayAskFor({ id: 'me', role }, 'someone'), false, `${role}`);
    assert.equal(A.mayAskFor(null, 'someone'), false);
    assert.equal(A.mayAskFor({ role: 'employee' }, undefined), false, 'no id on either side is not "own"');
});

test('the person and the document must be in the caller\'s company', () => {
    const hr = { id: 'hr', role: 'hr_admin' };
    const base = { user: hr, callerOrgId: 'orgA', employeeId: 'w1' };
    assert.deepEqual(A.decide(base), { ok: true });
    assert.equal(A.decide({ ...base, callerOrgId: null }).status, 403, 'a caller without a company sees nothing');
    assert.equal(A.decide({ ...base, person: { orgId: 'orgA' } }).ok, true);
    assert.equal(A.decide({ ...base, person: { orgId: 'orgB' } }).status, 403);
    assert.equal(A.decide({ ...base, person: null, doc: { orgId: 'orgA', employeeId: 'w1' } }).ok, true, 'no person record: the document decides');
    assert.equal(A.decide({ ...base, doc: { orgId: 'orgB', employeeId: 'w1' } }).status, 404, 'another company\'s document looks missing');
    assert.equal(A.decide({ ...base, doc: null }).status, 404);
    assert.equal(A.decide({ ...base, doc: { orgId: 'orgA', employeeId: 'w2' } }).status, 403, 'the document is someone else\'s');
    // the role check comes first, whatever else is true
    assert.equal(A.decide({ user: { id: 'm', role: 'manager' }, callerOrgId: 'orgA', employeeId: 'w1', person: { orgId: 'orgA' }, doc: { orgId: 'orgA', employeeId: 'w1' } }).status, 403);
    assert.equal(A.decide({ user: { id: 'w1', role: 'employee' }, callerOrgId: 'orgA', employeeId: 'w1', person: { orgId: 'orgA' }, doc: { orgId: 'orgA', employeeId: 'w1' } }).ok, true);
});

test('records from before companies existed belong to the first company only', () => {
    const { LEGACY_ORG_ID } = require('../config/tenant.js');
    assert.equal(A.inCompany(LEGACY_ORG_ID, { employeeId: 'x' }), true);
    assert.equal(A.inCompany('orgA', { employeeId: 'x' }), false);
    assert.equal(A.inCompany('orgA', null), false);
    assert.equal(A.inCompany(null, { orgId: null }), false);
});

/* ------------------------------------------- live ------------------------------------------- */

let server; let base;
const jwt = require('jsonwebtoken');
const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: 600 });
async function call(method, path, id, body) {
    const res = await fetch(`${base}/api/payroll${path}`, { method, headers: { Authorization: `Bearer ${tokenFor(id)}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, body: json, text };
}

test.before(async () => {
    const express = require('express');
    const app = express(); app.use(express.json()); app.use('/api/payroll', router);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 300)); });

async function seed() {
    const { person } = await seedCompanies(db, mem);
    // the older India role names, in company A
    await person('adminA', 'orgA', 'Admin', 'Asha Admin'); await person('hrmsA', 'orgA', 'HRMS', 'Hari HRMS'); await person('hrPayA', 'orgA', 'hr_payroll', 'Pia Payroll');
    await person('ownerSpacedA', 'orgA', 'Super Admin', 'Sam Owner'); await person('clientExecA', 'orgA', 'client_executive', 'Cy Exec');
    const pay = (id, orgId, employeeId, extra = {}) => db.collection('payroll_documents').doc(id).set({ orgId, employeeId, docType: 'Payslip', period: 'October 2026', status: 'Generated', fileName: `${id}.pdf`, storageUrl: `https://files.example/${id}.pdf`, createdAt: '2026-11-01T00:00:00.000Z', ...extra });
    await pay('payA1', 'orgA', 'workerA'); await pay('payA2', 'orgA', 'workerA', { period: 'September 2026', createdAt: '2026-10-01T00:00:00.000Z' });
    await pay('payEmpA', 'orgA', 'employeeA'); await pay('payB1', 'orgB', 'workerB');
    await pay('payClash', 'orgB', 'workerA'); // another company uses the same employee id
}

const LIST = '/employee/workerA/documents';
const GET = '/documents/payA1/download-url?employeeId=workerA';

test('live: the person, and the roles that may see pay, list and download; a manager, an executive and another employee do not', async () => {
    await seed();
    const mine = await call('GET', LIST, 'workerA');
    assert.equal(mine.status, 200, mine.text);
    assert.deepEqual(mine.body.data.map((d) => d.id), ['payA1', 'payA2'], 'own documents, newest first, and not the other company\'s with the same employee id');
    const got = await call('GET', GET, 'workerA');
    assert.equal(got.status, 200, got.text); assert.equal(got.body.url, 'https://files.example/payA1.pdf');

    for (const who of ['super_adminA', 'hr_adminA', 'payroll_adminA', 'accountantA', 'auditorA', 'adminA', 'hrmsA', 'hrPayA', 'ownerSpacedA']) {
        const l = await call('GET', LIST, who);
        assert.equal(l.status, 200, `${who} lists: ${l.text}`); assert.equal(l.body.count, 2, who);
        assert.equal((await call('GET', GET, who)).status, 200, `${who} downloads`);
    }
    for (const who of ['managerA', 'executiveA', 'employeeA', 'clientExecA']) {
        assert.equal((await call('GET', LIST, who)).status, 403, `${who} cannot list another person's payslips`);
        assert.equal((await call('GET', GET, who)).status, 403, `${who} cannot download another person's payslip`);
    }
    // each of them still reads their own
    assert.equal((await call('GET', '/employee/employeeA/documents', 'employeeA')).body.count, 1);
    assert.equal((await call('GET', '/employee/managerA/documents', 'managerA')).status, 200);
    assert.equal((await call('GET', '/documents/payEmpA/download-url?employeeId=employeeA', 'employeeA')).status, 200);
    // a person cannot fetch someone else's document by naming themself
    assert.equal((await call('GET', '/documents/payA1/download-url?employeeId=employeeA', 'employeeA')).status, 403);
    assert.equal((await call('GET', '/documents/payA1/download-url', 'hr_adminA')).status, 400, 'employeeId is required');
});

test('live: one company never reads another company\'s payslips', async () => {
    await seed();
    assert.equal((await call('GET', LIST, 'hrB')).status, 403, 'HR of company B, person of company A');
    assert.equal((await call('GET', GET, 'hrB')).status, 403);
    // by the document id alone, with an employee id that has no person record
    assert.equal((await call('GET', '/documents/payA1/download-url?employeeId=nobody', 'hrB')).status, 404);
    // company B's own person, company A's document
    assert.equal((await call('GET', '/documents/payA1/download-url?employeeId=workerB', 'hrB')).status, 404);
    // company A's HR and the document company B filed under the same employee id
    assert.equal((await call('GET', '/documents/payClash/download-url?employeeId=workerA', 'hr_adminA')).status, 404);
    assert.equal((await call('GET', '/documents/payClash/download-url?employeeId=workerA', 'workerA')).status, 404);
    const own = await call('GET', '/employee/workerB/documents', 'hrB');
    assert.deepEqual(own.body.data.map((d) => d.id), ['payB1']);
    // the India super admin of a third company
    assert.equal((await call('GET', LIST, 'saIN')).status, 403);
    // the vault list (HR only) holds only the caller's company's documents
    // (the document service holds no database under NODE_ENV=test, so the filter in front of it is run directly)
    const layer = router.stack.find((l) => l.route && l.route.path === '/documents/vault');
    let sent = null;
    const res = { json(b) { sent = b; return this; } };
    layer.route.stack[0].handle({ user: { id: 'hr_adminA', role: 'hr_admin', orgId: 'orgA' } }, res, () => {});
    res.json({ success: true, count: 3, documents: [{ id: 'payA1', orgId: 'orgA' }, { id: 'payB1', orgId: 'orgB' }, { id: 'old' }] });
    assert.deepEqual(sent, { success: true, count: 1, documents: [{ id: 'payA1', orgId: 'orgA' }] });
    res.json({ success: false, error: 'x' });
    assert.deepEqual(sent, { success: false, error: 'x' }, 'other answers pass through unchanged');
    assert.equal((await call('GET', '/documents/vault', 'hr_adminA')).status, 200);
});

test('live: the permission check answers before "not configured", and before anything is read', async () => {
    await seed();
    const apps = admin.apps.splice(0, admin.apps.length); // as when the server has no database connection
    try {
        assert.equal((await call('GET', GET, 'employeeA')).status, 403, 'refused, not 503');
        assert.equal((await call('GET', GET, 'managerA')).status, 403);
        assert.equal((await call('GET', GET, 'workerA')).status, 503, 'the person themself gets the honest "not configured"');
        assert.equal((await call('GET', GET, 'hr_adminA')).status, 503);
    } finally { admin.apps.push(...apps); }
    assert.equal((await call('GET', GET, 'workerA')).status, 200);
});

test('live: only the two person-document reads are open to non-HR roles; a look-alike path does not pass the role check', async () => {
    await seed();
    for (const path of ['/disburse/batch/download-url/status', '/documents/vault', '/runs', '/batches', '/runs/download-url/summary', '/employee', '/documents/payA1/download-url/extra']) {
        const r = await call('GET', path, 'employeeA');
        assert.equal(r.status, 403, `employee GET ${path}: ${r.text}`);
    }
    assert.equal((await call('GET', '/disburse/batch/download-url/status', 'accountantA')).status, 403, 'read-only finance does not reach the HR routes');
});

test('live: run totals, bank files and settlements stay inside the caller\'s company', async () => {
    await seed();
    await db.collection('payroll_runs').doc('runB').set({ orgId: 'orgB', totals: { total_gross_earnings: 999, total_net_payable: 900, total_headcount: 3 } });
    await db.collection('payroll_runs').doc('runA').set({ orgId: 'orgA', totals: { total_gross_earnings: 500, total_net_payable: 450, total_headcount: 2 } });
    await db.collection('users').doc('workerB').set({ salary: 50000 }, { merge: true });
    const other = await call('GET', '/runs/runB/summary', 'hr_adminA');
    assert.equal(other.status, 200, other.text);
    assert.equal(other.body.summary.gross_payroll, 0, 'company B\'s run is not shown, and company B\'s salaries are not counted');
    assert.equal(other.body.summary.total_headcount, 0);
    assert.equal((await call('GET', '/runs/runA/summary', 'hr_adminA')).body.summary.gross_payroll, 500);
    assert.equal((await call('GET', '/runs/runB/summary', 'hrB')).body.summary.gross_payroll, 999);

    const rec = { employee_id: 'E1', employee_name: 'Bo Li', net_payable_amount: 100, account_number: '123456789012', ifsc_code: 'HDFC0001234', payment_reference: 'R1' };
    await db.collection('payment_batches').doc('batchB').set({ orgId: 'orgB', status: 'APPROVED', records: [rec] });
    assert.equal((await call('POST', '/batches/batchB/generate-bank-file', 'hr_adminA', {})).status, 404, 'company A cannot build company B\'s bank file');
    const ownFile = await call('POST', '/batches/batchB/generate-bank-file', 'hrB', {});
    assert.equal(ownFile.status, 200, ownFile.text); assert.ok(ownFile.body.file_content.includes('123456789012'));

    const settle = await call('POST', '/reconciliation/upload', 'hr_adminA', { batch_id: 'batchB', file_content: 'Transaction_ID,Bank_Ref,Employee_ID,Amount,Status\nT1,U1,E1,100,PAID' });
    assert.equal(settle.status, 404, settle.text);
    assert.equal((await db.collection('payment_batches').doc('batchB').get()).data().status, 'APPROVED', 'company B\'s batch is untouched');

    const fix = await call('POST', '/batches/batchB/resolve-issue', 'hr_adminA', { issue_id: 'i1', field: 'ifsc_code', updated_value: 'HDFC0009999', employee_id: 'workerB' });
    assert.equal(fix.status, 404, fix.text);
    assert.equal((await db.collection('users').doc('workerB').get()).data().ifsc_code, undefined, 'company B\'s person is untouched');
    // a batch id of the caller's own company, but another company's person
    await db.collection('payment_batches').doc('batchA').set({ orgId: 'orgA', status: 'FAILED', records: [{ ...rec, employee_id: 'workerB' }] });
    assert.equal((await call('POST', '/batches/batchA/resolve-issue', 'hr_adminA', { issue_id: 'i2', field: 'ifsc_code', updated_value: 'HDFC0009999', employee_id: 'workerB' })).status, 404);
    assert.equal((await db.collection('users').doc('workerB').get()).data().ifsc_code, undefined);
});
