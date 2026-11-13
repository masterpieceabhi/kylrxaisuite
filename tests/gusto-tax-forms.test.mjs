import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeHarness } from './gusto-harness.mjs';

const require = createRequire(import.meta.url);
const X = require('../services/gusto/extras-rules.js');
const taxForms = require('../services/gusto/tax-forms.js');
const contractors = require('../services/gusto/contractors.js');
const { encryptField } = require('../services/pii-crypto.js');

test('form rules: W-2 and 1099 are recognised, other forms are left out, drafts do not count as available', () => {
    const forms = [
        { uuid: 'a', name: 'US_W-2', title: 'W-2 2025', year: 2025 }, { uuid: 'b', name: 'US_W-2', title: 'W-2 2024', year: 2024, draft: true },
        { uuid: 'c', name: 'US_W-4', title: 'Form W-4' }, { uuid: 'd', name: 'employee_direct_deposit', title: 'Direct Deposit Authorization' },
        { uuid: 'e', name: 'US_1099', title: 'Form 1099-NEC 2025' }, { uuid: 'f', name: 'W2', title: 'Wage statement', description: 'For tax year 2023' }, { name: 'US_W-2', title: 'no id' }
    ];
    const w2 = X.taxFormsOf(forms, 'w2');
    assert.deepEqual(w2.map((f) => [f.id, f.year, f.draft]), [['a', 2025, false], ['b', 2024, true], ['f', 2023, false]]);
    assert.deepEqual(X.yearsOf(w2), [2025, 2023]);
    assert.deepEqual(X.taxFormsOf(forms, '1099').map((f) => [f.id, f.year]), [['e', 2025]]);
    assert.equal(X.classifyForm({ name: 'US_W-4' }), null);
    assert.deepEqual(X.taxFormsOf(null, 'w2'), []);
    assert.ok(w2.every((f) => !('document_url' in f)), 'nothing but id, kind, title, year and draft leaves the server');
});

const ORG = 'org_test_taxforms';
const h = makeHarness(ORG);
test.before(() => h.start());
test.after(() => h.stop());

test('availability per person, a person\'s own list, and the PDF comes through the server', async () => {
    const ctx = await h.connect();
    h.contractors = [{ id: 'c1', name: 'Dana Diaz', email: 'c1@example.test', active: true, createdAt: '2026-03-02T10:00:00.000Z', w9: { status: 'received', legalName: 'Dana Diaz', taxClassification: 'individual', tinType: 'SSN', tinLast4: '4321', hasTin: true, tinEncrypted: encryptField('987654321', `${ORG}:c1:contractor-tin`), address: { line1: '9 Oak Ave', city: 'Austin', state: 'TX', zip: '78703' } } }];
    await contractors.syncContractors(ctx);

    let av = await taxForms.availability(ctx);
    assert.equal(av.employees.length, 3); assert.equal(av.contractors.length, 1);
    assert.ok(av.employees.every((p) => p.years.length === 0 && p.error === null), 'nothing is ready before the year end');

    const company = (await h.store.getConnection(ORG)).companyUuid;
    await h.mockPost('/year-end', { company_uuid: company, year: 2025, all_contractors: true });
    const u1 = (await h.store.getLink(ORG, 'employee', 'u1')).gustoUuid;
    const u2 = (await h.store.getLink(ORG, 'employee', 'u2')).gustoUuid;
    await h.mockPost('/tax-form', { employee_uuid: u1, name: 'US_W-2', title: 'W-2 2024', year: 2024 });
    await h.mockPost('/tax-form', { employee_uuid: u1, name: 'US_W-2', title: 'W-2 2026 (draft)', year: 2026, draft: true });
    await h.mockPost('/tax-form', { employee_uuid: u1, name: 'US_W-4', title: 'Form W-4', year: 2026 });

    av = await taxForms.availability(ctx);
    const ann = av.employees.find((p) => p.id === 'u1');
    assert.deepEqual(ann.years, [2025, 2024]);
    assert.equal(ann.forms.length, 3, 'the W-4 is not a tax form for this list');
    assert.deepEqual(av.employees.find((p) => p.id === 'u2').years, [2025]);
    assert.deepEqual(av.contractors[0].years, [2025]);
    assert.equal(av.contractors[0].forms[0].kind, '1099');
    assert.ok(!JSON.stringify(av).includes('document_url') && !JSON.stringify(av).includes(h.baseUrl), 'no provider address in what the page gets');

    const mine = await taxForms.formsFor(ctx, 'employee', 'u1');
    const w2 = mine.find((f) => f.year === 2025);
    const file = await taxForms.pdf(ctx, 'employee', 'u1', w2.id);
    assert.equal(file.filename, 'W-2-2025.pdf');
    assert.equal(file.buffer.slice(0, 5).toString(), '%PDF-');
    assert.match(file.buffer.toString('latin1'), /W-2 2025/);

    // somebody else's form id finds nothing; a draft is refused; a W-4 id is not a tax form
    const bobs = (await taxForms.formsFor(ctx, 'employee', 'u2'))[0];
    await assert.rejects(() => taxForms.pdf(ctx, 'employee', 'u1', bobs.id), (e) => e.status === 404);
    await assert.rejects(() => taxForms.pdf(ctx, 'employee', 'u1', mine.find((f) => f.draft).id), (e) => e.code === 'draft' && e.status === 409);
    const w4 = [...h.mock.state().taxForms.values()].find((f) => f.name === 'US_W-4');
    await assert.rejects(() => taxForms.pdf(ctx, 'employee', 'u1', w4.uuid), (e) => e.status === 404);
    await assert.rejects(() => taxForms.pdf(ctx, 'employee', 'nobody', w2.id), (e) => e.status === 404);

    const c1099 = await taxForms.pdf(ctx, 'contractor', 'c1', av.contractors[0].forms[0].id);
    assert.equal(c1099.filename, '1099-2025.pdf');
    assert.deepEqual(await taxForms.formsFor(ctx, 'employee', 'not-linked'), []);
});

test('the server only follows a file link that is https or on the provider\'s own address, and only passes on a real PDF', async () => {
    const ctx = await h.connect();
    await assert.rejects(() => ctx.client.download('http://169.254.169.254/latest/meta-data'), (e) => e.code === 'bad_file_link');
    await assert.rejects(() => ctx.client.download('file:///etc/passwd'), (e) => e.code === 'bad_file_link');
    await assert.rejects(() => ctx.client.download('not a link'), (e) => e.code === 'bad_file_link');
    await assert.rejects(() => ctx.client.download(`${h.baseUrl}/__files/unknown.pdf`), (e) => e.status === 404);
    // the provider answers with something that is not a PDF
    const u1 = (await h.store.getLink(ORG, 'employee', 'u1')).gustoUuid;
    const f = await h.mockPost('/tax-form', { employee_uuid: u1, name: 'US_W-2', title: 'W-2 2025', year: 2025 });
    const real = ctx.client.download;
    ctx.client.download = async () => ({ buffer: Buffer.from('<html>sign in</html>'), contentType: 'text/html' });
    await assert.rejects(() => taxForms.pdf(ctx, 'employee', 'u1', f.uuid), (e) => /did not return a PDF/.test(e.message) && e.status === 502);
    ctx.client.download = real;
});
