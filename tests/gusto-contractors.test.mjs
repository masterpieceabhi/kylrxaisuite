import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeHarness, addDays, today } from './gusto-harness.mjs';

const require = createRequire(import.meta.url);
const X = require('../services/gusto/extras-rules.js');
const contractors = require('../services/gusto/contractors.js');
const { encryptField } = require('../services/pii-crypto.js');

const ORG = 'org_test_contractors';
const addr = { line1: '9 Oak Ave', line2: '', city: 'Austin', state: 'TX', zip: '78703' };
const mk = (id, name, w9) => ({ id, name, businessName: '', email: `${id}@example.test`, active: true, createdAt: '2026-03-02T10:00:00.000Z', w9: w9 === null ? null : { status: 'received', legalName: name, businessName: '', taxClassification: 'individual', tinType: 'SSN', tinLast4: '4321', hasTin: true, tinEncrypted: encryptField('987654321', `${ORG}:${id}:contractor-tin`), address: addr, ...(w9 || {}) } });

/* ------------------------------- rules ------------------------------- */

test('contractor rules: who can be sent, and the body for an individual and for a business', () => {
    assert.deepEqual(X.contractorProblems(mk('c1', 'Dana Diaz')), []);
    assert.match(X.contractorProblems(mk('c2', 'No Form', null)).join(), /W-9 is needed/);
    assert.match(X.contractorProblems(mk('c3', 'Cher')).join(), /first and a last name/);
    assert.match(X.contractorProblems(mk('c4', 'Dana Diaz', { address: { line1: '1 A St' } })).join(), /address on the W-9 is not complete/);
    const ind = X.toGustoContractor(mk('c1', 'Dana Maria Diaz'), '987-65-4321');
    assert.deepEqual(ind, { wage_type: 'Fixed', start_date: '2026-03-02', self_onboarding: false, file_new_hire_report: false, email: 'c1@example.test', type: 'Individual', first_name: 'Dana', last_name: 'Maria Diaz', ssn: '987654321' });
    const biz = X.toGustoContractor(mk('c5', 'Diaz Design', { tinType: 'EIN', businessName: 'Diaz Design LLC', taxClassification: 'llc_p' }), '12-3456789');
    assert.equal(biz.type, 'Business'); assert.equal(biz.business_name, 'Diaz Design LLC'); assert.equal(biz.ein, '123456789'); assert.equal(biz.ssn, undefined);
    // the fingerprint never depends on the taxpayer ID itself, only on its last 4
    assert.equal(X.contractorHash(mk('c1', 'Dana Diaz')), X.contractorHash(mk('c1', 'Dana Diaz', { tinEncrypted: 'other' })));
    assert.notEqual(X.contractorHash(mk('c1', 'Dana Diaz')), X.contractorHash(mk('c1', 'Dana Diaz', { tinLast4: '0000' })));
});

test('contractor payment rules: amount or hours x rate, reimbursement, and what is refused', () => {
    const v = (input) => X.validateContractorPayment(input, { today: '2026-11-12' });
    assert.deepEqual(v({ contractorId: 'c1', date: '2026-11-10', amount: 150.25, reimbursement: '20', memo: ' logo  work ' }).value, { contractorId: 'c1', date: '2026-11-10', hours: null, rate: null, wageCents: 15025, reimbursementCents: 2000, memo: 'logo work' });
    const byHours = v({ contractorId: 'c1', date: '2026-11-10', hours: 7.5, rate: 33.33, requestId: 'req-12345678' });
    assert.deepEqual(byHours.errors, []);
    assert.equal(byHours.value.wageCents, 24998); // 7.5 x 33.33 = 249.975, rounded to the cent
    assert.equal(byHours.value.requestId, 'req-12345678');
    assert.deepEqual(v({ contractorId: 'c1', date: '2026-11-10', reimbursement: 12 }).errors, [], 'a reimbursement alone is fine');
    const errs = (input) => v(input).errors.join(' | ');
    assert.match(errs({ contractorId: 'c1', date: '2026-11-13', amount: 5 }), /cannot be in the future/);
    assert.match(errs({ contractorId: 'c1', date: '2026-11-10' }), /Enter an amount/);
    assert.match(errs({ contractorId: 'c1', date: '2026-11-10', amount: 5, hours: 2, rate: 10 }), /not both/);
    assert.match(errs({ contractorId: 'c1', date: '2026-11-10', hours: 2 }), /rate must be above 0/);
    assert.match(errs({ contractorId: 'c1', date: '2026-11-10', amount: 1.999 }), /cents at most/);
    assert.match(errs({ date: 'soon', amount: 5 }), /contractorId is required.*date must be a date/);
    assert.match(errs({ contractorId: 'c1', date: '2026-11-10', amount: 5, requestId: 'x y' }), /requestId/);
    assert.deepEqual(X.toGustoContractorPayment(byHours.value, 'gk1'), { contractor_uuid: 'gk1', date: '2026-11-10', payment_method: 'Check', wage: '249.98', reimbursement: '0.00' });
});

test('ledger rows: income and reimbursement are separate rows with ids fixed by the provider payment', () => {
    const rows = X.ledgerRowsFor({ contractorId: 'c1', gustoUuid: 'pay-1', date: '2026-11-10', wageCents: 24998, reimbursementCents: 2000, hours: 7.5, rate: 33.33, memo: 'October' });
    assert.deepEqual(rows.map((r) => [r.id, r.amount, r.category, r.method]), [['gusto_pay-1', 249.98, 'nonemployee_compensation', 'check'], ['gusto_pay-1_reimb', 20, 'reimbursement', 'check']]);
    assert.match(rows[0].description, /7\.5 hour\(s\) at \$33\.33\. October/);
    assert.equal(X.ledgerRowsFor({ contractorId: 'c1', gustoUuid: 'p2', date: '2026-11-10', wageCents: 0, reimbursementCents: 500 }).length, 1);
});

/* ------------------------------- against the mock provider ------------------------------- */

const h = makeHarness(ORG);
test.before(() => h.start());
test.after(() => h.stop());
const ledgerRows = () => [...h.ledger.entries()].map(([id, d]) => ({ id, ...d }));

test('contractors are sent once, blocked ones say why, and a re-run makes no provider calls', async () => {
    const ctx = await h.connect();
    h.contractors = [mk('c1', 'Dana Diaz'), mk('c2', 'No Form', null), mk('c5', 'Diaz Design', { tinType: 'EIN', businessName: 'Diaz Design LLC' }), { ...mk('c6', 'Old Vendor'), active: false }];
    const out = await contractors.syncContractors(ctx);
    assert.deepEqual([out.total, out.synced, out.blocked, out.skipped, out.errors], [4, 2, 1, 1, 0], JSON.stringify(out.results));
    const state = await h.mockGet('/state');
    assert.equal(state.contractors.length, 2);
    assert.ok(state.contractors.every((k) => k.onboarded && k.hasTin && k.address && k.wage_type === 'Fixed'));
    assert.deepEqual(state.contractors.map((k) => k.type).sort(), ['Business', 'Individual']);
    assert.ok(!JSON.stringify(await h.store.listLinks(ORG, 'contractor')).includes('987654321'), 'the taxpayer ID is never stored in our links');

    const before = (await h.mockGet('/stats')).requests;
    const again = await contractors.syncContractors(ctx);
    assert.equal(again.unchanged, 2);
    assert.equal((await h.mockGet('/stats')).requests, before, 'nothing changed, so nothing was sent');

    // an address change is sent as an update, not as a second contractor
    h.contractors[0] = mk('c1', 'Dana Diaz', { address: { ...addr, line1: '10 Oak Ave' } });
    const upd = await contractors.syncContractors(ctx, { ids: ['c1'] });
    assert.equal(upd.synced, 1);
    const after = await h.mockGet('/state');
    assert.equal(after.contractors.length, 2);
    assert.equal(after.contractors.find((k) => k.first_name === 'Dana').address.street_1, '10 Oak Ave');

    const list = await contractors.listContractors(ctx);
    assert.deepEqual(list.map((c) => [c.contractorId, c.syncState, c.inGusto]), [['c1', 'synced', true], ['c5', 'synced', true], ['c2', 'blocked', false], ['c6', 'not_sent', false]].sort((a, b) => list.findIndex((c) => c.contractorId === a[0]) - list.findIndex((c) => c.contractorId === b[0])));
    assert.match(list.find((c) => c.contractorId === 'c2').blockedReasons.join(), /W-9/);
});

test('a contractor payment is recorded at the provider and written to the 1099 ledger exactly once', async () => {
    const ctx = await h.connect();
    h.contractors = [mk('c1', 'Dana Diaz'), mk('c2', 'No Form', null)];
    await contractors.syncContractors(ctx);
    const date = addDays(today(), -1);

    await assert.rejects(() => contractors.createPayment(ctx, { contractorId: 'c1', date, amount: 0 }, { actor: 'p' }), (e) => e.code === 'validation' && e.status === 400);
    await assert.rejects(() => contractors.createPayment(ctx, { contractorId: 'nope', date, amount: 5 }, { actor: 'p' }), (e) => e.status === 404);
    await assert.rejects(() => contractors.createPayment(ctx, { contractorId: 'c2', date, amount: 5 }, { actor: 'p' }), (e) => e.code === 'not_linked' && e.status === 409);
    assert.equal(h.ledger.size, 0);

    const input = { contractorId: 'c1', date, hours: 10, rate: 45, reimbursement: 30, memo: 'Site photos', requestId: 'req-photo-0001' };
    const first = await contractors.createPayment(ctx, input, { actor: 'payroll1' });
    assert.equal(first.duplicate, false);
    assert.deepEqual([first.payment.amount, first.payment.reimbursement, first.payment.status, first.payment.inLedger], [450, 30, 'recorded', true]);
    let rows = ledgerRows();
    assert.deepEqual(rows.map((r) => [r.contractorId, r.amount, r.category, r.method, r.voided, r.orgId]).sort(), [['c1', 30, 'reimbursement', 'check', false, ORG], ['c1', 450, 'nonemployee_compensation', 'check', false, ORG]]);
    assert.equal((await h.mockGet('/state')).contractorPayments.length, 1);

    // the same request again (double click, retry, refresh): the first payment comes back, nothing new anywhere
    const [a, b] = await Promise.all([contractors.createPayment(ctx, input, { actor: 'payroll1' }), contractors.createPayment(ctx, input, { actor: 'payroll1' })]);
    assert.ok(a.duplicate && b.duplicate); assert.equal(a.payment.id, first.payment.id);
    assert.equal((await h.mockGet('/state')).contractorPayments.length, 1);
    assert.equal(h.ledger.size, 2);
    // the same request id for a different payment is refused
    await assert.rejects(() => contractors.createPayment(ctx, { ...input, hours: 11 }, { actor: 'p' }), (e) => e.code === 'request_reused');
    // a new request that looks like the same payment needs an explicit yes
    await assert.rejects(() => contractors.createPayment(ctx, { ...input, requestId: 'req-photo-0002' }, { actor: 'p' }), (e) => e.code === 'possible_duplicate' && e.status === 409);
    const second = await contractors.createPayment(ctx, { ...input, requestId: 'req-photo-0002', allowDuplicate: true }, { actor: 'p' });
    assert.equal(second.duplicate, false);
    assert.equal(h.ledger.size, 4);
    // writing the ledger again for a recorded payment adds nothing
    await contractors.ensureLedger(ctx, first.payment.id);
    assert.equal(h.ledger.size, 4);

    const list = await contractors.listPayments(ctx, {});
    assert.equal(list.length, 2);
    assert.ok(list.every((p) => p.contractorName === 'Dana Diaz' && p.mayCancel));

    // cancel: gone at the provider, ledger rows voided (not deleted), a second cancel is refused
    await assert.rejects(() => contractors.cancelPayment(ctx, second.payment.id, { actor: 'p', reason: '' }), (e) => e.code === 'validation');
    const cancelled = await contractors.cancelPayment(ctx, second.payment.id, { actor: 'p', reason: 'entered twice' });
    assert.equal(cancelled.status, 'cancelled');
    assert.equal((await h.mockGet('/state')).contractorPayments.length, 1);
    rows = ledgerRows();
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((r) => r.voided).length, 2);
    assert.ok(rows.filter((r) => r.voided).every((r) => /entered twice/.test(r.voidReason)));
    await assert.rejects(() => contractors.cancelPayment(ctx, second.payment.id, { actor: 'p', reason: 'again' }), (e) => e.code === 'wrong_state' && e.status === 409);
    // asking again with the cancelled payment's request id does not pay again
    assert.equal((await contractors.createPayment(ctx, { ...input, requestId: 'req-photo-0002', allowDuplicate: true }, { actor: 'p' })).duplicate, true);
    assert.equal((await h.mockGet('/state')).contractorPayments.length, 1);
});

test('a payment the provider already funded cannot be cancelled, and a ledger failure is repaired without a double write', async () => {
    const ctx = await h.connect();
    h.contractors = [mk('c1', 'Dana Diaz')];
    await contractors.syncContractors(ctx);
    const date = today();
    h.ledgerFailures = 1; // the first ledger write fails after the provider accepted the payment
    const made = await contractors.createPayment(ctx, { contractorId: 'c1', date, amount: 80, requestId: 'req-funded-01' }, { actor: 'p' });
    assert.equal(made.payment.status, 'recorded'); assert.equal(made.payment.inLedger, false); assert.match(made.payment.ledgerProblem, /ledger is down/);
    assert.equal(h.ledger.size, 0);
    assert.equal((await h.store.listErrors(ORG)).filter((e) => e.scope === 'contractor_ledger').length, 1);
    const fixed = await contractors.ensureLedger(ctx, made.payment.id);
    assert.equal(fixed.inLedger, true); assert.equal(h.ledger.size, 1);
    assert.equal((await h.store.listErrors(ORG)).filter((e) => e.scope === 'contractor_ledger').length, 0);

    const uuid = (await h.mockGet('/state')).contractorPayments[0].uuid;
    await h.mockPost('/contractor-payment-funded', { uuid });
    await assert.rejects(() => contractors.cancelPayment(ctx, made.payment.id, { actor: 'p', reason: 'wrong person' }), (e) => e.code === 'cannot_cancel' && e.status === 409);
    const still = (await contractors.listPayments(ctx, {}))[0];
    assert.equal(still.status, 'recorded'); assert.equal(still.mayCancel, false);
    assert.equal(ledgerRows()[0].voided, false);
});

test('a provider failure leaves no ledger row, and the same request can be tried again', async () => {
    const ctx = await h.connect();
    h.contractors = [mk('c1', 'Dana Diaz')];
    await contractors.syncContractors(ctx);
    const state = h.mock.state();
    const k = [...state.contractors.values()][0];
    k.onboarded = false; // the provider now refuses payments for this contractor
    const input = { contractorId: 'c1', date: today(), amount: 60, requestId: 'req-retry-001' };
    await assert.rejects(() => contractors.createPayment(ctx, input, { actor: 'p' }), (e) => e.code === 'validation');
    assert.equal(h.ledger.size, 0);
    assert.equal((await contractors.listPayments(ctx, {}))[0].status, 'failed');
    k.onboarded = true;
    const ok = await contractors.createPayment(ctx, input, { actor: 'p' });
    assert.equal(ok.payment.status, 'recorded'); assert.equal(h.ledger.size, 1);
    assert.equal(state.contractorPayments.size, 1);
});
