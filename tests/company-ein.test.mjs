// EIN from Gusto first, asked for only when needed (services/company-ein.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CE = require('../services/company-ein.js');

const gustoCompany = {
    uuid: 'c-1', name: 'Prompt AI Ethical Solutions USA LLC', trade_name: 'Prompt AI', ein: '12-3456789', entity_type: 'LLC',
    locations: [
        { street_1: '1 Old Rd', city: 'Austin', state: 'TX', zip: '78701', active: false },
        { street_1: '500 Main St', street_2: 'Suite 2', city: 'Plano', state: 'tx', zip: '75024', active: true, mailing_address: true },
        { street_1: '9 Lake Ave', city: 'Chicago', state: 'IL', zip: '60601', active: true, filing_address: true }
    ]
};

test('Gusto\'s company record gives the EIN, legal name, entity type, filing address and work states', () => {
    const f = CE.factsFromGustoCompany(gustoCompany);
    assert.equal(f.ein, '12-3456789');
    assert.equal(f.legalName, 'Prompt AI Ethical Solutions USA LLC');
    assert.equal(f.entityType, 'llc');
    assert.deepEqual(f.businessAddress, { line1: '9 Lake Ave', line2: '', city: 'Chicago', state: 'IL', zip: '60601' }, 'the filing address wins');
    assert.deepEqual(f.workStates.sort(), ['IL', 'TX'], 'inactive locations do not count');
});

test('odd or missing Gusto values are left out, never stored', () => {
    assert.deepEqual(CE.factsFromGustoCompany(null), {});
    assert.equal(CE.factsFromGustoCompany({ ein: '00-1234567' }).ein, undefined, 'prefix 00 is never issued');
    assert.equal(CE.factsFromGustoCompany({ ein: '123' }).ein, undefined);
    assert.equal(CE.factsFromGustoCompany({ ein: '123456789' }).ein, '12-3456789', 'digits only are formatted');
    for (const [t, want] of [['C-Corporation', 'c_corp'], ['S-Corporation', 's_corp'], ['Sole proprietor', 'sole_proprietorship'], ['Non-Profit', 'nonprofit'], ['General partnership', 'partnership'], ['LLP', 'partnership'], ['Trusteeship', undefined]]) {
        assert.equal(CE.factsFromGustoCompany({ entity_type: t }).entityType, want, t);
    }
    assert.equal(CE.factsFromGustoCompany({ locations: [{ street_1: 'x', city: 'y', state: 'ZZ', zip: '1' }] }).businessAddress, undefined);
});

test('only empty fields are filled: what the company typed is never overwritten, a different EIN is only reported', () => {
    const facts = CE.factsFromGustoCompany(gustoCompany);
    const a = CE.mergeFacts({}, facts);
    assert.deepEqual(a.filled.sort(), ['businessAddress', 'ein', 'entityType', 'legalName', 'workStates']);
    const b = CE.mergeFacts({ ein: '98-7654321', legalName: 'Typed Name', workStates: ['TX'], businessAddress: { line1: '', city: '', state: '', zip: '' } }, facts);
    assert.deepEqual(b.filled.sort(), ['businessAddress', 'entityType']);
    assert.equal(b.einMismatch, true);
    assert.equal(b.patch.ein, undefined);
    assert.equal(CE.mergeFacts({ ein: '123456789' }, facts).einMismatch, false, 'same number, other format');
});

test('filling from Gusto saves the empty fields with a "from Gusto" mark; nothing is saved when all is filled', async () => {
    const saved = [];
    const r = await CE.fillFromGusto('o1', { company: gustoCompany, deps: { org: { usProfile: { legalName: 'Typed' } }, saveProfile: async (p) => saved.push(p) } });
    assert.equal(r.ok, true);
    assert.ok(r.filled.includes('ein') && !r.filled.includes('legalName'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].ein, '12-3456789');
    assert.deepEqual(saved[0].fromGusto.fields.sort(), r.filled.sort());
    const full = { usProfile: { ...CE.factsFromGustoCompany(gustoCompany) } };
    const none = [];
    const r2 = await CE.fillFromGusto('o1', { company: gustoCompany, deps: { org: full, saveProfile: async (p) => none.push(p) } });
    assert.deepEqual(r2.filled, []);
    assert.equal(r2.reason, 'already_filled');
    assert.equal(none.length, 0);
});

test('without a company record it asks Gusto, and says why when it cannot', async () => {
    const asked = [];
    const ctx = (conn, get) => async () => ({ conn, client: { get: async (p) => { asked.push(p); return get(); } } });
    const saved = [];
    const ok = await CE.fillFromGusto('o1', { deps: { org: {}, saveProfile: async (p) => saved.push(p), makeContext: ctx({ status: 'connected', companyUuid: 'c-1' }, () => gustoCompany) } });
    assert.deepEqual(asked, ['/v1/companies/c-1']);
    assert.ok(ok.filled.includes('ein'));
    assert.equal((await CE.fillFromGusto('o1', { deps: { org: {}, makeContext: ctx({ status: 'disconnected' }, () => gustoCompany) } })).reason, 'not_connected');
    assert.equal((await CE.fillFromGusto('o1', { deps: { org: {}, makeContext: ctx({ status: 'connected', companyUuid: 'c-1' }, () => { throw new Error('403 scope'); }) } })).reason, 'gusto_error');
    assert.equal((await CE.fillFromGusto('o1', { deps: { org: {}, makeContext: ctx({ status: 'connected', companyUuid: 'c-1' }, () => ({})) } })).reason, 'nothing_at_gusto');
});

test('a feature that needs the EIN: the saved one, else Gusto, else it must be asked for', async () => {
    assert.deepEqual(await CE.ensureEin('o1', { usProfile: { ein: '12-3456789' } }), { ein: '12-3456789', source: 'profile' });
    const org = { usProfile: {} };
    const fromGusto = await CE.ensureEin('o1', org, { deps: { org, saveProfile: async (p) => Object.assign(org.usProfile, p), makeContext: async () => ({ conn: { status: 'connected', companyUuid: 'c-1' }, client: { get: async () => gustoCompany } }) } });
    assert.deepEqual(fromGusto, { ein: '12-3456789', source: 'gusto' });
    const noGusto = await CE.ensureEin('o1', { usProfile: {} }, { deps: { org: { usProfile: {} }, makeContext: async () => ({ conn: null }) } });
    assert.deepEqual(noGusto, { needed: true, triedGusto: false });
});

test('the "EIN needed" answer has one shape every page can recognise', () => {
    let code; let body;
    const res = { status(c) { code = c; return this; }, json(b) { body = b; return this; } };
    CE.einNeeded(res, 'the state new-hire report');
    assert.equal(code, 409);
    assert.equal(body.code, 'ein_needed');
    assert.match(body.error, /new-hire report/);
});
