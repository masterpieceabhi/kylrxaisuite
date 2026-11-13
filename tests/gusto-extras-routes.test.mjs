// The new /api/us/gusto routes, run in this process: the real router and services, the mock provider on a random
// port, the gusto store in memory, and small stand-ins for sign-in, the US-company guard, the audit log and Firestore.
// What this does NOT cover: real sign-in tokens, the real US-company guard and real Firestore (the live check does).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-gusto-integration';
process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);

/* ------------------------------- stand-ins, installed before the router loads ------------------------------- */
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const merge = (a, b) => { const o = { ...(a || {}) }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' ? merge(o[k], v) : v; return o; };
const db = new Map();
const colOf = (name) => { if (!db.has(name)) db.set(name, new Map()); return db.get(name); };
function fakeCollection(name) {
    const col = colOf(name);
    const doc = (id) => {
        const ref = {
            id,
            async get() { const d = col.get(id); return { id, exists: d !== undefined, data: () => clone(d), ref }; },
            async set(d, o) { col.set(id, o && o.merge ? merge(col.get(id), clone(d)) : clone(d)); },
            async create(d) { if (col.has(id)) throw Object.assign(new Error('6 ALREADY_EXISTS: already exists'), { code: 6 }); col.set(id, clone(d)); },
            async update(patch) { const cur = clone(col.get(id)) || {}; for (const [k, v] of Object.entries(patch)) { const parts = k.split('.'); let o = cur; while (parts.length > 1) { const p = parts.shift(); o[p] = o[p] && typeof o[p] === 'object' ? o[p] : {}; o = o[p]; } o[parts[0]] = clone(v); } col.set(id, cur); },
            async delete() { col.delete(id); }
        };
        return ref;
    };
    const query = (filters) => ({
        where: (f, op, v) => query([...filters, [f, v]]),
        limit: () => query(filters),
        async get() { const docs = [...col.entries()].filter(([, d]) => filters.every(([f, v]) => d[f] === v)).map(([id, d]) => ({ id, exists: true, data: () => clone(d), ref: doc(id) })); return { docs, empty: !docs.length }; }
    });
    return { doc: (id) => doc(id || `auto${Math.random().toString(16).slice(2)}`), where: (f, op, v) => query([[f, v]]), get: () => query([]).get(), async add(d) { const id = `auto${Math.random().toString(16).slice(2)}`; col.set(id, clone(d)); return { id }; } };
}
const audits = [];
const USERS = {};
const stub = (rel, exports) => { const id = require.resolve(rel); require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] }; };
stub('../config/firebase.js', { admin: {}, db: { collection: fakeCollection }, messaging: {}, rawCollection: fakeCollection });
stub('../utils/logger.js', { info() {}, warn() {}, error() {}, debug() {} });
stub('../middleware/authMiddleware.js', { verifyToken: (req, res, next) => { const u = USERS[req.headers['x-test-user']]; if (!u) return res.status(401).json({ success: false, error: 'Sign in' }); req.user = u; return next(); } });
const usHr = () => {};
usHr.helpers = {
    requireUsOrg: (req, res, next) => { if (req.user.orgId === 'org_india') return res.status(409).json({ success: false, error: 'This organization is not a US company' }); req.orgId = req.user.orgId; req.org = {}; return next(); },
    audit: async (orgId, req, action, targetId, extra) => { audits.push({ orgId, by: req.user.id, action, targetId, extra }); },
    findEmployee: async (orgId, id) => { const d = colOf('users').get(id); return d && d.orgId === orgId ? { id, data: clone(d), ref: fakeCollection('users').doc(id) } : null; }
};
stub('../routes/us-hr.js', usHr);
const timeStub = () => {}; timeStub.helpers = { orgInfo: async () => ({ tz: 'America/Chicago', country: 'US', rules: {} }) };
stub('../routes/time.js', timeStub);

const { makeHarness, addDays, today } = await import('./gusto-harness.mjs');
const express = require('express');
const { setDefaultStore } = require('../services/gusto/store.js');
const { encryptField } = require('../services/pii-crypto.js');

const ORG = 'org_test_routes';
const h = makeHarness(ORG);
let server; let base; let mockUrlBefore;
Object.assign(USERS, {
    owner: { id: 'owner1', role: 'super_admin', orgId: ORG, email: 'owner@example.test' },
    pay: { id: 'pay1', role: 'payroll_admin', orgId: ORG },
    acct: { id: 'acct1', role: 'accountant', orgId: ORG }, // may view payroll and pay, may not run payroll
    mgr: { id: 'mgr1', role: 'manager', orgId: ORG },
    ann: { id: 'u1', role: 'employee', orgId: ORG },
    bob: { id: 'u2', role: 'employee', orgId: ORG },
    india: { id: 'in1', role: 'super_admin', orgId: 'org_india' },
    other: { id: 'x1', role: 'super_admin', orgId: 'org_other_us' }
});
const call = async (user, method, path, body) => {
    const res = await fetch(`${base}/api/us/gusto${path}`, { method, headers: { 'content-type': 'application/json', 'x-test-user': user }, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};

test.before(async () => {
    await h.start();
    mockUrlBefore = process.env.GUSTO_MOCK_URL; process.env.GUSTO_MOCK_URL = h.baseUrl; // the routes build their own context: point it at this test's mock
    await h.connect();
    setDefaultStore(h.store);
    for (const [id, name] of [['u1', 'Ann Alpha'], ['u2', 'Bob Beta'], ['u3', 'Cy Gamma']]) colOf('users').set(id, h.personDoc(id, name, id === 'u3' ? { payType: 'salary', payRate: 52000, flsaStatus: 'exempt' } : {}));
    colOf('users').set('zed', { ...h.personDoc('zed', 'Zed Other'), orgId: 'org_other_us' });
    colOf('contractors').set('c1', { orgId: ORG, name: 'Dana Diaz', email: 'dana@example.test', active: true, createdAt: '2026-03-02T10:00:00.000Z' });
    colOf('contractor_w9').set('c1', { orgId: ORG, contractorId: 'c1', status: 'received', legalName: 'Dana Diaz', taxClassification: 'individual', tinType: 'SSN', tinLast4: '4321', tinEncrypted: encryptField('987654321', `${ORG}:c1:contractor-tin`), address: { line1: '9 Oak Ave', city: 'Austin', state: 'TX', zip: '78703' } });
    const app = express(); app.use(express.json());
    app.use('/api/us/gusto', require('../routes/us-gusto.js'));
    app.use((err, req, res, next) => { res.status(500).json({ success: false, error: `unhandled: ${err.message}` }); }); // eslint-disable-line no-unused-vars
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((r) => server.close(r)); await h.stop(); if (mockUrlBefore === undefined) delete process.env.GUSTO_MOCK_URL; else process.env.GUSTO_MOCK_URL = mockUrlBefore; });

test('who may do what: view vs run, employees, a non-US company, another company', async () => {
    assert.equal((await call('nobody', 'GET', '/garnishments')).status, 401);
    for (const [method, path] of [['GET', '/off-cycle/options'], ['GET', '/contractors'], ['GET', '/contractor-payments'], ['GET', '/tax-forms'], ['GET', '/garnishments'], ['GET', '/benefit-deductions/preview'], ['GET', '/people/u1/state-tax']]) {
        assert.equal((await call('ann', method, path)).status, 403, `employee ${path}`);
        assert.equal((await call('mgr', method, path)).status, 403, `manager ${path}`);
        assert.equal((await call('india', method, path)).status, 409, `non-US company ${path}`);
        assert.equal((await call('acct', method, path)).status, 200, `accountant may read ${path}`);
    }
    for (const [method, path] of [['POST', '/off-cycle'], ['POST', '/sync/contractors'], ['POST', '/contractor-payments'], ['POST', '/contractor-payments/x/cancel'], ['POST', '/contractor-payments/x/ledger'], ['POST', '/garnishments'], ['POST', '/garnishments/x/send'], ['POST', '/garnishments/x/end'], ['POST', '/benefit-deductions/send'], ['PUT', '/people/u1/state-tax']]) {
        assert.equal((await call('acct', method, path, {})).status, 403, `read-only role ${method} ${path}`);
        assert.equal((await call('ann', method, path, {})).status, 403, `employee ${method} ${path}`);
    }
    // another US company sees none of this company's records, and cannot reach its people
    const other = await call('other', 'GET', '/garnishments');
    assert.equal(other.status, 200); assert.deepEqual(other.body.data, []);
    assert.equal((await call('other', 'GET', '/people/u1/state-tax')).status, 404);
    assert.deepEqual((await call('other', 'GET', '/contractors')).body.data, []);
});

test('off-cycle: options, validation, prepare, then the ordinary preview / submit / history', async () => {
    const opt = await call('pay', 'GET', '/off-cycle/options');
    assert.deepEqual(Object.keys(opt.body.reasons), ['bonus', 'correction', 'final_pay']);
    assert.equal(opt.body.people.length, 3);
    const bad = await call('pay', 'POST', '/off-cycle', { reason: 'bonus', checkDate: addDays(today(), -9), people: [] });
    assert.equal(bad.status, 400); assert.equal(bad.body.success, false); assert.ok(bad.body.errors.length >= 2);
    const made = await call('pay', 'POST', '/off-cycle', { reason: 'bonus', checkDate: addDays(today(), 12), people: [{ userId: 'u1', amount: 125 }] });
    assert.equal(made.status, 201, JSON.stringify(made.body)); assert.equal(made.body.totals.gross_pay, '125.00');
    const id = made.body.payrollUuid;
    assert.equal((await call('pay', 'POST', '/off-cycle', { reason: 'bonus', checkDate: addDays(today(), 12), people: [{ userId: 'u1', amount: 125 }] })).status, 200, 'the same request again re-uses it');
    const prev = await call('acct', 'GET', `/payroll/${id}`);
    assert.equal(prev.body.kind, 'off_cycle'); assert.equal(prev.body.employees[0].name, 'Ann Alpha');
    assert.equal((await call('pay', 'POST', `/payroll/${id}/submit`, { confirm: true })).status, 400, 'the typed confirmation is still needed');
    const sub = await call('pay', 'POST', `/payroll/${id}/submit`, { confirm: true, confirmPayrollId: id });
    assert.equal(sub.status, 200, JSON.stringify(sub.body)); assert.equal(sub.body.status, 'submitted');
    assert.equal((await call('pay', 'POST', `/payroll/${id}/submit`, { confirm: true, confirmPayrollId: id })).status, 409);
    const again = await call('pay', 'POST', '/off-cycle', { reason: 'bonus', checkDate: addDays(today(), 12), people: [{ userId: 'u1', amount: 125 }] });
    assert.equal(again.status, 409); assert.equal(again.body.code, 'already_submitted');
    const hist = await call('acct', 'GET', '/payroll/history');
    assert.deepEqual([hist.body.data[0].kind, hist.body.data[0].reason, hist.body.data[0].status], ['off_cycle', 'bonus', 'submitted']);
    assert.ok(audits.some((a) => a.action === 'gusto_off_cycle_prepared' && a.targetId === id && a.by === 'pay1'));
    const reg = await call('acct', 'GET', `/payroll/${id}/register`);
    assert.equal(reg.status, 200); assert.deepEqual(reg.body.rows.map((r) => [r.name, r.gross]), [['Ann Alpha', 125]]);
});

test('contractors: send, pay once into the real ledger collection, cancel voids it', async () => {
    const sync1 = await call('pay', 'POST', '/sync/contractors', {});
    assert.equal(sync1.status, 200); assert.equal(sync1.body.synced, 1, JSON.stringify(sync1.body));
    const list = await call('acct', 'GET', '/contractors');
    assert.deepEqual([list.body.data[0].name, list.body.data[0].inGusto, list.body.data[0].w9], ['Dana Diaz', true, 'received']);
    assert.ok(!JSON.stringify(list.body).includes('987654321') && !JSON.stringify(list.body).includes('tinEncrypted'));

    assert.equal((await call('pay', 'POST', '/contractor-payments', { contractorId: 'c1', date: addDays(today(), 3), amount: 10 })).status, 400);
    assert.equal((await call('pay', 'POST', '/contractor-payments', { contractorId: 'nope', date: addDays(today(), -1), amount: 10 })).status, 404); // yesterday: the company's own day can be a day behind UTC
    const body = { contractorId: 'c1', date: addDays(today(), -1), hours: 4, rate: 50, reimbursement: 15, memo: 'Repairs', requestId: 'route-test-0001' };
    const p1 = await call('pay', 'POST', '/contractor-payments', body);
    assert.equal(p1.status, 201, JSON.stringify(p1.body)); assert.equal(p1.body.payment.amount, 200); assert.equal(p1.body.payment.inLedger, true);
    const p2 = await call('pay', 'POST', '/contractor-payments', body);
    assert.equal(p2.status, 200); assert.equal(p2.body.duplicate, true);
    const ledger = [...colOf('contractor_payments').values()];
    assert.equal(ledger.length, 2, 'one income row and one reimbursement row, once');
    assert.deepEqual(ledger.map((r) => [r.orgId, r.contractorId, r.amount, r.category, r.method, r.voided]).sort(), [[ORG, 'c1', 15, 'reimbursement', 'check', false], [ORG, 'c1', 200, 'nonemployee_compensation', 'check', false]]);
    assert.equal((await call('pay', 'POST', '/contractor-payments', { ...body, requestId: 'route-test-0002' })).status, 409);

    assert.equal((await call('pay', 'POST', `/contractor-payments/${p1.body.payment.id}/cancel`, {})).status, 400, 'a reason is needed');
    assert.equal((await call('pay', 'POST', '/contractor-payments/unknown/cancel', { reason: 'typo' })).status, 404);
    const c = await call('pay', 'POST', `/contractor-payments/${p1.body.payment.id}/cancel`, { reason: 'wrong contractor' });
    assert.equal(c.status, 200); assert.equal(c.body.payment.status, 'cancelled');
    assert.ok([...colOf('contractor_payments').values()].every((r) => r.voided === true && /wrong contractor/.test(r.voidReason)));
    assert.equal((await call('pay', 'POST', `/contractor-payments/${p1.body.payment.id}/cancel`, { reason: 'again' })).status, 409);
    assert.equal((await call('pay', 'POST', `/contractor-payments/${p1.body.payment.id}/ledger`, {})).status, 409, 'a cancelled payment is not written to the ledger');
    assert.equal((await call('acct', 'GET', '/contractor-payments?year=1999')).status, 400);
    assert.equal((await call('acct', 'GET', `/contractor-payments?year=${today().slice(0, 4)}`)).body.data.length >= 1, true);
});

test('tax forms: the payroll page list, a person\'s own list only, and PDFs through this server', async () => {
    const company = (await h.store.getConnection(ORG)).companyUuid;
    await h.mockPost('/year-end', { company_uuid: company, year: 2025, all_contractors: true });
    const all = await call('acct', 'GET', '/tax-forms');
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.employees.map((p) => p.years), [[2025], [2025], [2025]]);
    assert.deepEqual(all.body.contractors.map((p) => p.years), [[2025]]);
    assert.ok(!JSON.stringify(all.body).includes('document_url') && !JSON.stringify(all.body).includes(h.baseUrl));

    const mine = await call('ann', 'GET', '/my/tax-forms');
    assert.equal(mine.status, 200); assert.equal(mine.body.data.length, 1);
    const bobs = (await call('bob', 'GET', '/my/tax-forms')).body.data[0];
    assert.notEqual(bobs.id, mine.body.data[0].id);
    const pdf = await call('ann', 'GET', `/my/tax-forms/${mine.body.data[0].id}/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /attachment; filename="W-2-2025\.pdf"/);
    assert.equal(pdf.headers.get('cache-control'), 'no-store');
    assert.equal(pdf.body.slice(0, 5).toString(), '%PDF-');
    assert.equal((await call('ann', 'GET', `/my/tax-forms/${bobs.id}/pdf`)).status, 404, 'somebody else\'s form');
    assert.equal((await call('ann', 'GET', `/tax-forms/employee/u2/${bobs.id}/pdf`)).status, 403, 'an employee cannot use the payroll route');
    assert.equal((await call('mgr', 'GET', '/my/tax-forms')).body.data.length, 0, 'a person who is not at the provider has an empty list');
    const hr = await call('acct', 'GET', `/tax-forms/employee/u2/${bobs.id}/pdf`);
    assert.equal(hr.status, 200); assert.equal(hr.body.slice(0, 5).toString(), '%PDF-');
    const c = await call('acct', 'GET', `/tax-forms/contractor/c1/${all.body.contractors[0].forms[0].id}/pdf`);
    assert.equal(c.status, 200); assert.match(c.headers.get('content-disposition'), /1099-2025\.pdf/);
    assert.equal((await call('acct', 'GET', `/tax-forms/company/u2/${bobs.id}/pdf`)).status, 400);
    assert.ok(audits.some((a) => a.action === 'gusto_my_tax_form_downloaded' && a.by === 'u1'));
});

test('garnishments: recorded and sent by payroll, case number only for readers of pay data, never in the audit log', async () => {
    const bad = await call('pay', 'POST', '/garnishments', { userId: 'u2', type: 'creditor' });
    assert.equal(bad.status, 400); assert.ok(bad.body.errors.length >= 3);
    assert.equal((await call('pay', 'POST', '/garnishments', { userId: 'zed', type: 'creditor', caseNumber: 'A-1', amountType: 'amount', value: 5, startDate: today() })).status, 404, 'a person of another company');
    const made = await call('pay', 'POST', '/garnishments', { userId: 'u2', type: 'creditor', caseNumber: 'CV-2026-554433', amountType: 'percent', value: 10, limits: { perPayPeriodMax: 150 }, startDate: addDays(today(), -2), payeeNotes: 'County court' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.garnishment.provider.state, 'sent'); assert.equal(made.body.garnishment.caseNumber, 'CV-2026-554433');
    assert.match(made.body.note, /confirm with a US compliance advisor/i);
    const id = made.body.garnishment.id;
    const seen = await call('acct', 'GET', '/garnishments');
    assert.equal(seen.body.data[0].caseNumber, 'CV-2026-554433'); assert.deepEqual(seen.body.can, { write: false, readCase: true });
    assert.ok(!JSON.stringify(audits).includes('554433'), 'the case number is never written to the audit log');
    assert.ok(audits.some((a) => a.action === 'garnishments_viewed_with_case_numbers'));
    assert.ok(!JSON.stringify(seen.body).includes('caseNumberEnc'));
    assert.equal((await call('pay', 'POST', `/garnishments/${id}/send`, {})).status, 200);
    assert.equal((await call('pay', 'POST', `/garnishments/${id}/end`, { endDate: addDays(today(), -30) })).status, 400);
    const ended = await call('pay', 'POST', `/garnishments/${id}/end`, { reason: 'paid in full' });
    assert.equal(ended.status, 200); assert.equal(ended.body.garnishment.status, 'ended');
    assert.equal((await call('pay', 'POST', `/garnishments/${id}/end`, {})).status, 409);
    assert.equal((await call('pay', 'POST', '/garnishments/nope/send', {})).status, 404);
    assert.equal((await h.mockGet('/state')).garnishments[0].active, false);
});

test('benefit deductions: preview from the benefits collections, send needs the reviewed fingerprint, compare is clean after', async () => {
    colOf('benefit_plans').set('p1', { orgId: ORG, name: 'Gold PPO', type: 'medical', preTax: true, payPeriodsPerYear: 12, planYear: 2026, costs: { employee_only: { employee: 130, employer: 260 } } });
    colOf('benefit_plans').set('p2', { orgId: ORG, name: 'Company 401k', type: '401k', preTax: true, planYear: 2026 });
    colOf('benefit_enrollments').set('e1', { orgId: ORG, userId: 'u1', status: 'active', effectiveDate: '2026-01-01', elections: [{ planId: 'p1', tier: 'employee_only' }, { planId: 'p2', deferralPercent: 5, contributionType: 'pre_tax' }] });
    colOf('benefit_enrollments').set('e9', { orgId: 'org_other_us', userId: 'zed', status: 'active', effectiveDate: '2026-01-01', elections: [{ planId: 'p1', tier: 'employee_only' }] });
    assert.equal((await call('acct', 'GET', '/benefit-deductions/preview?periodEnd=tomorrow')).status, 400);
    const pre = await call('acct', 'GET', '/benefit-deductions/preview?periodEnd=2026-11-22');
    assert.equal(pre.status, 200, JSON.stringify(pre.body));
    assert.deepEqual(pre.body.totals, { create: 2, update: 0, end: 0, unchanged: 0, notInProvider: 0, cannotSend: 0 });
    const med = pre.body.rows.find((r) => r.planName === 'Gold PPO');
    assert.deepEqual(med.wanted, { employee: 60, percent: null, employer: 120 }, 'a monthly premium on a biweekly paycheck: 130 x 12 / 26');
    assert.equal(pre.body.rows.find((r) => r.planName === 'Company 401k').wanted.percent, 5);
    assert.equal((await call('pay', 'POST', '/benefit-deductions/send', { periodEnd: '2026-11-22', fingerprint: pre.body.fingerprint })).status, 400, 'confirm=true is needed');
    assert.equal((await call('pay', 'POST', '/benefit-deductions/send', { confirm: true, periodEnd: '2026-11-22', fingerprint: 'old' })).status, 409);
    const sent = await call('pay', 'POST', '/benefit-deductions/send', { confirm: true, periodEnd: '2026-11-22', fingerprint: pre.body.fingerprint });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.deepEqual([sent.body.sent, sent.body.failed, sent.body.after.changes], [2, 0, 0]);
    const after = await call('acct', 'GET', '/benefit-deductions/preview?periodEnd=2026-11-22');
    assert.equal(after.body.totals.unchanged, 2); assert.ok(after.body.lastSent);
    assert.equal((await h.mockGet('/state')).employeeBenefits.length, 2);
});

test('state tax answers: saved on the person, sent, and replaced as a whole', async () => {
    colOf('users').set('u2', { ...colOf('users').get('u2'), usProfile: { ...colOf('users').get('u2').usProfile } });
    // give Bob a second state at the provider so there is something to answer
    const u2 = (await h.store.getLink(ORG, 'employee', 'u2')).gustoUuid;
    h.mock.state().homes.forEach((home) => { if (home.employee_uuid === u2) home.state = 'WI'; });
    const view = await call('acct', 'GET', '/people/u2/state-tax');
    assert.equal(view.status, 200); assert.equal(view.body.states.find((s) => s.state === 'WI').questions.length, 3);
    assert.equal((await call('pay', 'PUT', '/people/u2/state-tax', { state: 'Wisconsin', answers: {} })).status, 400);
    assert.equal((await call('pay', 'PUT', '/people/nobody/state-tax', { state: 'WI', answers: {} })).status, 404);
    const put = await call('pay', 'PUT', '/people/u2/state-tax', { state: 'WI', answers: { filing_status: 'S', withholding_allowance: '2', additional_withholding: '' } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.deepEqual([put.body.saved, put.body.sentToGusto, put.body.sent], [true, true, 2]);
    assert.deepEqual(colOf('users').get('u2').usForms.stateTax.WI.answers, { filing_status: 'S', withholding_allowance: '2' });
    assert.ok(colOf('users').get('u2').usForms.w4, 'the rest of the person\'s forms are untouched');
    await call('pay', 'PUT', '/people/u2/state-tax', { state: 'WI', answers: { filing_status: 'M' } });
    assert.deepEqual(colOf('users').get('u2').usForms.stateTax.WI.answers, { filing_status: 'M' }, 'a cleared answer does not linger');
    const people = await call('acct', 'GET', '/people');
    assert.equal(people.body.data.find((p) => p.userId === 'u2').stateTax, 'sent');
});
