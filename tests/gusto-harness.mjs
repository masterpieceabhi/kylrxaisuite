// Shared setup for the gusto-*.test.mjs files that need a connected, approved company on the mock provider.
// Each test file gets its own mock on a random free port and its own in-memory store.
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-gusto-integration';
process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);
const { createMockGusto } = require('../services/gusto/mock-server.js');
const { createMemoryStore } = require('../services/gusto/store.js');
const { resetAppState } = require('../services/gusto/client.js');
const { makeContext } = require('../services/gusto/index.js');
const onboarding = require('../services/gusto/onboarding.js');
const mapping = require('../services/gusto/mapping.js');
const { encryptField } = require('../services/pii-crypto.js');

export const iso = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
export const today = () => iso(new Date());

export function makeHarness(ORG = 'org_test_gusto_extras') {
    const org = { phone: '5125550100', usProfile: { legalName: 'Test Co LLC', ein: '12-3456789', entityType: 'llc', businessAddress: { line1: '100 Main St', line2: '', city: 'Austin', state: 'TX', zip: '78701' }, workStates: ['TX'] } };
    const personDoc = (id, name, extra = {}, forms = {}) => {
        const [first, last] = name.split(' ');
        return {
            orgId: ORG, name, email: `${id}@example.test`, employeeId: `EMP-${id}`, jobTitle: 'Cashier', status: 'Active', joiningDate: '2026-01-05',
            usProfile: {
                legalFirstName: first, legalLastName: last, dateOfBirth: '1990-04-12', homeAddress: { line1: '1 Elm St', city: 'Austin', state: 'TX', zip: '78702' }, workState: 'TX',
                classification: 'W2', flsaStatus: 'non_exempt', payType: 'hourly', payRate: 20, payFrequency: 'biweekly', startDate: '2026-01-05',
                taxpayerIdEncrypted: encryptField('123456789', `${ORG}:${id}`), taxpayerIdLast4: '6789', ...extra
            },
            usForms: { w4: { current: { taxYear: 2026, filingStatus: 'single_or_mfs', qualifyingChildren: 1, otherDependents: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, multipleJobs: false } }, ...forms }
        };
    };
    const person = (id, name, extra, forms) => mapping.personFromDoc(id, personDoc(id, name, extra, forms));
    const h = {
        ORG, org, person, personDoc, mock: null, baseUrl: null, store: null,
        people: [person('u1', 'Ann Alpha'), person('u2', 'Bob Beta'), person('u3', 'Cy Gamma', { payType: 'salary', payRate: 52000, flsaStatus: 'exempt' })],
        contractors: [], ledger: new Map(), ledgerFailures: 0, feed: { rows: [], errors: [], percents: new Map() }, payDb: new Map(), events: []
    };
    const silent = { info() {}, warn() {}, error() {} };
    const ledger = {
        async create(id, doc) { if (h.ledgerFailures > 0) { h.ledgerFailures -= 1; throw new Error('ledger is down'); } if (h.ledger.has(id)) return false; h.ledger.set(id, { ...doc }); return true; },
        async void(id, orgId, patch) { const d = h.ledger.get(id); if (!d || d.orgId !== orgId) return false; Object.assign(d, patch); return true; }
    };
    const deps = () => ({
        store: h.store, log: silent, org, loadPeople: async () => h.people, loadLeave: async () => [], loadWeeks: async () => [],
        loadContractors: async () => h.contractors, ledger, loadDeductionFeed: async () => h.feed,
        savePayResults: async (orgId, rows) => rows.forEach((r) => h.payDb.set(r.id, { ...r })),
        listPayResults: async (orgId, uuid) => [...h.payDb.values()].filter((r) => r.orgId === orgId && (!uuid || r.payrollUuid === uuid)),
        deletePayResults: async (orgId, ids) => ids.forEach((id) => h.payDb.delete(id)),
        emitEvent: (orgId, type, data) => { h.events.push({ orgId, type, data }); return 'evt_test'; },
        optsOverride: { baseUrl: h.baseUrl, backoffBaseMs: 5, rateLimitPerMinute: 100000, lockLeaseMs: 3000 }, pollOpts: { intervalMs: 20 }
    });
    h.ctx = async () => makeContext(ORG, deps());
    h.mockPost = (path, body) => fetch(`${h.baseUrl}/__mock${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
    h.mockGet = (path) => fetch(`${h.baseUrl}/__mock${path}`).then((r) => r.json());
    h.start = async () => { h.mock = createMockGusto(); const r = await h.mock.listen(0); h.baseUrl = r.url; };
    h.stop = async () => { await h.mock.close(); };
    /** A fresh company: connected, every setup step done, approved; all people sent and (by default) finished at the provider */
    h.connect = async ({ finishAll = true } = {}) => {
        resetAppState();
        h.store = createMemoryStore(); h.ledger.clear(); h.payDb.clear(); h.events.length = 0;
        await h.mockPost('/reset');
        await h.mockPost('/rate', { max: 100000, windowMs: 60000 });
        let ctx = await h.ctx();
        const refresh = async () => { ctx.conn = await h.store.getConnection(ORG); };
        await onboarding.connectCompany(ctx, { companyName: 'Test Co LLC', ein: '12-3456789', admin: { firstName: 'Olive', lastName: 'Owner', email: 'olive@example.test' } }, 'actor1');
        await refresh();
        const run = async (k, input) => { const r = await onboarding.runStep(ctx, k, input); await refresh(); return r; };
        await run('terms', { email: 'olive@example.test', ipAddress: '203.0.113.5', externalUserId: 'actor1' });
        await run('locations');
        await run('federal_tax', {});
        await run('industry', { naicsCode: '722511', title: 'Full-service restaurants' });
        await run('bank', { routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking' });
        const dep = await h.mockGet('/deposits');
        await run('bank_verify', { deposit1: dep.deposit_1, deposit2: dep.deposit_2 });
        await run('pay_schedule', { frequency: 'biweekly', anchorPayDate: '2026-11-13', anchorEndOfPayPeriod: '2026-11-08' });
        await run('employees', {});
        await run('employee_onboarded', {});
        await run('state_taxes', { states: { TX: { state_tax_id: '12345678901', sui_rate: '2.7' } } });
        await run('signatory', { firstName: 'Olive', lastName: 'Owner', email: 'olive@example.test', title: 'Owner', ssn: '123-45-6789', birthday: '1980-01-01' });
        await run('forms', { agree: true, signatureText: 'Olive Owner', ipAddress: '203.0.113.5' });
        await run('finish');
        if (finishAll) {
            for (const l of (await h.store.listLinks(ORG, 'employee')).filter((x) => x.gustoUuid && !(x.gusto && x.gusto.onboarded))) await run('employee_onboarded', { userId: l.ourId });
        }
        ctx = await h.ctx();
        return ctx;
    };
    return h;
}
