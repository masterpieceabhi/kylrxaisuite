// Who may use the document vault routes: every route, all eight roles, and who may see which kind of document.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROLES, OWNER_HR, OWNER_HR_AUDITOR, guardChecker, routeList, assertOpenRoutes, startServer, seedCompanies } from './helpers/permission-harness.mjs';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kylrx-vault-test-'));
process.env.VAULT_DIR = vaultDir;
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const { requireUsOrg } = require('../routes/us-hr.js').helpers;
const router = require('../routes/us-vault.js');
const P = require('../services/permissions.js');
const allowed = guardChecker(router, requireUsOrg);
const { canSee } = router.helpers;

const EXPECTED = [
    ['post', '/vault/documents', OWNER_HR],
    ['put', '/vault/documents/:id', OWNER_HR],
    ['delete', '/vault/documents/:id', OWNER_HR],
    ['get', '/vault/expiring', OWNER_HR_AUDITOR]
];
// the list and the download decide per document (canSee); the categories are not secret
const OPEN = ['get /vault/categories', 'get /vault/documents', 'get /vault/documents/:id/download'];

for (const [method, route, allow] of EXPECTED) {
    test(`${method.toUpperCase()} ${route}: allowed for ${allow.join(', ')} and nobody else`, () => {
        for (const role of ROLES) assert.equal(allowed(method, route, role), allow.includes(role), `${role} on ${method} ${route}`);
    });
}

test('every route of this file is covered above or decides per document', () => {
    assert.deepEqual(routeList(router), [...EXPECTED.map(([m, p]) => `${m} ${p}`), ...OPEN].sort());
    assertOpenRoutes(router, requireUsOrg, OPEN);
});

test('who sees which document: confidential files are closed to everyone but HR and the owner, auditors included', () => {
    const user = (role, id = 'someone') => ({ id, role });
    const kinds = {
        confidential: { scope: 'employee', userId: 'emp1', confidential: true, shared: false },
        privatePerson: { scope: 'employee', userId: 'emp1', shared: false },
        sharedPerson: { scope: 'employee', userId: 'emp1', shared: true },
        privateCompany: { scope: 'company', shared: false },
        sharedCompany: { scope: 'company', shared: true }
    };
    const see = { confidential: OWNER_HR, privatePerson: OWNER_HR_AUDITOR, sharedPerson: OWNER_HR_AUDITOR, privateCompany: OWNER_HR_AUDITOR, sharedCompany: ROLES };
    for (const [kind, doc] of Object.entries(kinds)) {
        for (const role of ROLES) assert.equal(canSee(doc, user(role)), see[kind].includes(role), `${role} and a ${kind} document`);
        for (const role of ROLES) assert.equal(canSee({ ...doc, deleted: true }, user(role)), false, `${role} and a deleted ${kind} document`);
    }
    // a person sees a document shared with them, and never a confidential one about themselves
    for (const role of ROLES) assert.equal(canSee(kinds.sharedPerson, user(role, 'emp1')), true, `${role} and their own shared document`);
    for (const role of ['payroll_admin', 'manager', 'employee', 'accountant', 'auditor', 'executive']) {
        assert.equal(canSee(kinds.confidential, user(role, 'emp1')), false, `${role} and a confidential document about themselves`);
        assert.equal(canSee(kinds.privatePerson, user(role, 'emp1')), role === 'auditor', `${role} and their own unshared document`);
    }
    assert.equal(canSee(kinds.sharedPerson, { role: 'employee' }), false, 'no id never matches');
    assert.equal(canSee(null, user('super_admin')), false); assert.equal(canSee(kinds.sharedCompany, null), false);
});

test('the old role lists are gone from routes/us-vault.js', () => {
    const src = fs.readFileSync(new URL('../routes/us-vault.js', import.meta.url), 'utf8');
    assert.equal(/authorize\(|ADMIN_HR_ROLES|CONFIDENTIAL_ROLES|hasRole|V\.canView/.test(src), false);
    for (const p of ['vault.manage', 'vault.confidential', 'people.read', 'compliance.view']) { assert.ok(P.KNOWN_PERMISSIONS.includes(p), p); assert.ok(src.includes(`'${p}'`), p); }
});

/* ------------------------------------------- live ------------------------------------------- */

let srv;
test.before(async () => { srv = await startServer(router); });
test.after(async () => { await srv.stop(); fs.rmSync(vaultDir, { recursive: true, force: true }); });

const pdf = (text) => new Blob([`%PDF-1.4\n${text}\n%%EOF`], { type: 'application/pdf' });
function form(fields, name = 'paper.pdf') { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('file', pdf(`content of ${fields.title}`), name); return f; }

test('live: HR stores documents; the auditor reads the ordinary ones and never a confidential one; nobody else gets in', async () => {
    await seedCompanies(db, mem);
    const { call } = srv;
    const up = async (who, fields) => call('POST', '/vault/documents', who, form(fields));
    const offer = await up('hr_adminA', { scope: 'employee', category: 'offer_letter', title: 'Offer letter', userId: 'workerA' });
    assert.equal(offer.status, 201, offer.text);
    const medical = await up('hr_adminA', { scope: 'employee', category: 'medical_confidential', title: 'Doctor note', userId: 'workerA' });
    assert.equal(medical.status, 201); assert.equal(medical.body.document.confidential, true);
    const handbook = await up('super_adminA', { scope: 'company', category: 'handbook', title: 'Handbook', shared: 'true' });
    const license = await up('hr_adminA', { scope: 'company', category: 'business_license', title: 'City permit', expiresOn: '2020-01-01' });
    assert.equal(handbook.status, 201); assert.equal(license.status, 201);
    for (const who of ['auditorA', 'payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA']) {
        assert.equal((await up(who, { scope: 'company', category: 'handbook', title: 'Not allowed' })).status, 403, `${who} cannot store a document`);
    }
    assert.equal((await up('hr_adminA', { scope: 'employee', category: 'offer_letter', title: 'Wrong company', userId: 'workerB' })).status, 404);
    assert.equal((await up('saIN', { scope: 'company', category: 'handbook', title: 'India' })).status, 409);

    const ids = (r) => r.body.data.map((d) => d.id).sort();
    const all = [offer, medical, handbook, license].map((r) => r.body.document.id).sort();
    assert.deepEqual(ids(await call('GET', '/vault/documents', 'hr_adminA')), all);
    assert.deepEqual(ids(await call('GET', '/vault/documents', 'super_adminA')), all);
    assert.deepEqual(ids(await call('GET', '/vault/documents', 'auditorA')), all.filter((id) => id !== medical.body.document.id), 'the auditor sees everything but the confidential file');
    for (const who of ['payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA', 'workerA']) assert.deepEqual(ids(await call('GET', '/vault/documents', who)), [handbook.body.document.id], `${who} sees only what is shared`);
    assert.deepEqual(ids(await call('GET', '/vault/documents', 'hrB')), [], 'another company sees nothing');

    const dl = (who, r) => call('GET', `/vault/documents/${r.body.document.id}/download`, who);
    assert.equal((await dl('auditorA', offer)).status, 200); assert.match((await dl('auditorA', offer)).text, /content of Offer letter/);
    assert.equal((await dl('auditorA', medical)).status, 403, 'a confidential file stays closed to the auditor');
    assert.equal((await dl('hr_adminA', medical)).status, 200);
    assert.equal((await dl('workerA', offer)).status, 403, 'not shared with the person');
    assert.equal((await dl('workerA', medical)).status, 403);
    assert.equal((await dl('employeeA', handbook)).status, 200);
    assert.equal((await dl('hrB', offer)).status, 404);

    const exp = await call('GET', '/vault/expiring', 'auditorA');
    assert.equal(exp.status, 200); assert.deepEqual(exp.body.data.map((d) => d.id), [license.body.document.id]);
    for (const who of ['payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA']) assert.equal((await call('GET', '/vault/expiring', who)).status, 403, `${who} expiring list`);

    assert.equal((await call('PUT', `/vault/documents/${offer.body.document.id}`, 'auditorA', { title: 'Changed' })).status, 403);
    assert.equal((await call('DELETE', `/vault/documents/${license.body.document.id}`, 'auditorA')).status, 403);
    assert.equal((await call('PUT', `/vault/documents/${offer.body.document.id}`, 'hr_adminA', { legalHold: true })).body.document.legalHold, true);
    assert.equal((await call('DELETE', `/vault/documents/${offer.body.document.id}`, 'hr_adminA')).status, 409, 'a legal hold blocks deletion');
    assert.equal((await call('DELETE', `/vault/documents/${license.body.document.id}`, 'hr_adminA')).status, 200);
    assert.equal((await dl('hr_adminA', license)).status, 404);

    await new Promise((r) => setTimeout(r, 30));
    const audit = (await db.collection('organizations/orgA/audit_logs').get()).docs.map((d) => d.data());
    for (const action of ['vault_document_uploaded', 'vault_document_downloaded', 'vault_document_updated', 'vault_document_deleted']) assert.ok(audit.some((a) => a.action === action), `${action} is in the audit log`);
    assert.ok(audit.some((a) => a.action === 'vault_document_downloaded' && a.actorId === 'auditorA'), 'the auditor\'s download is logged');
});
