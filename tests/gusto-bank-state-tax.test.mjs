import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeHarness } from './gusto-harness.mjs';

const require = createRequire(import.meta.url);
const M = require('../services/gusto/mapping.js');
const sync = require('../services/gusto/sync.js');
const { encryptField } = require('../services/pii-crypto.js');

const acct = (id, type, value, last4 = '6789', extra = {}) => ({ id, bankName: `Bank ${id}`, routingNumber: '021000021', accountType: 'checking', accountNumberEnc: 'v1:x', last4, allocation: { type, value }, ...extra });

/* ------------------------------- rules ------------------------------- */

test('bank accounts are read from the split list, or from the single account, like the direct deposit page does', () => {
    assert.deepEqual(M.bankAccountsFromForms({}), []);
    const single = M.bankAccountsFromForms({ directDeposit: { bankName: 'First', routingNumber: '021000021', accountType: 'savings', accountNumberEncrypted: 'v1:a', accountLast4: '1111' } });
    assert.deepEqual(single, [{ id: 'legacy', bankName: 'First', routingNumber: '021000021', accountType: 'savings', accountNumberEnc: 'v1:a', last4: '1111', allocation: { type: 'remainder', value: null } }]);
    const splits = [{ id: 'a', bankName: 'A', routingNumber: '021000021', accountType: 'checking', accountNumberEncrypted: 'v1:a', accountLast4: '1111', allocation: { type: 'percent', value: 20 } }, { id: 'b', bankName: 'B', routingNumber: '021000021', accountType: 'checking', accountNumberEncrypted: 'v1:b', accountLast4: '2222', allocation: { type: 'remainder', value: null } }];
    assert.deepEqual(M.bankAccountsFromForms({ directDepositSplits: splits, directDeposit: { split: true, accountLast4: '2222' } }).map((a) => a.id), ['a', 'b']);
    // a newer single account (no split marker) replaces an older split list
    assert.deepEqual(M.bankAccountsFromForms({ directDepositSplits: splits, directDeposit: { accountLast4: '9999', bankName: 'New' } }).map((a) => a.last4), ['9999']);
    const p = M.personFromDoc('u1', { usForms: { directDepositSplits: splits, directDeposit: { split: true, accountLast4: '2222' }, stateTax: { WI: { answers: { filing_status: 'S' } } } } });
    assert.equal(p.bank.length, 2); assert.deepEqual(p.stateTax, { WI: { answers: { filing_status: 'S' } } });
});

test('pay splits: one account, percents, fixed amounts; a mix or a decimal percent is not sent and says why', () => {
    assert.deepEqual(M.toGustoPaymentSplits([acct('a', 'remainder', null)]).body, { type: 'Direct Deposit', split_by: 'Percentage', splits: [{ uuid: 'a', name: 'Bank a', priority: 1, split_amount: 100 }] });
    const pct = M.toGustoPaymentSplits([acct('a', 'percent', 20), acct('b', 'remainder', null), acct('c', 'percent', 30)], (a) => `g-${a.id}`).body;
    assert.equal(pct.split_by, 'Percentage');
    assert.deepEqual(pct.splits.map((s) => [s.uuid, s.priority, s.split_amount]), [['g-a', 1, 20], ['g-b', 2, 50], ['g-c', 3, 30]]);
    const amt = M.toGustoPaymentSplits([acct('b', 'remainder', null), acct('a', 'amount', 150.5), acct('c', 'amount', 25)]).body;
    assert.equal(amt.split_by, 'Amount');
    assert.deepEqual(amt.splits.map((s) => [s.uuid, s.priority, s.split_amount]), [['a', 1, 15050], ['c', 2, 2500], ['b', 3, null]], 'fixed amounts in cents first, the rest last');
    assert.match(M.toGustoPaymentSplits([acct('a', 'amount', 10), acct('b', 'percent', 10), acct('c', 'remainder', null)]).reason, /both fixed amounts and percents/);
    assert.match(M.toGustoPaymentSplits([acct('a', 'percent', 12.5), acct('c', 'remainder', null)]).reason, /whole percents/);
    assert.match(M.toGustoPaymentSplits([acct('a', 'percent', 50), acct('b', 'percent', 50)]).reason, /Exactly one account/);
    assert.match(M.toGustoPaymentSplits([]).reason, /No bank account/);
    assert.deepEqual(M.toGustoBankAccount(acct('a', 'remainder', null, '6789', { accountType: 'savings' }), '0001-2345 6789'), { name: 'Bank a', routing_number: '021000021', account_number: '000123456789', account_type: 'Savings' });
    // the fingerprint follows the last 4 and the share, never the number itself
    assert.equal(M.bankHash([acct('a', 'remainder', null)]), M.bankHash([acct('a', 'remainder', null, '6789', { accountNumberEnc: 'v1:other' })]));
    assert.notEqual(M.bankHash([acct('a', 'remainder', null)]), M.bankHash([acct('a', 'remainder', null, '0000')]));
});

test('state tax answers: checked on the way in, and only answers to questions the provider asks are sent', () => {
    const v = M.validateStateTaxAnswers({ state: 'wi', answers: { filing_status: ' S ', withholding_allowance: 2, additional_withholding: '' } });
    assert.deepEqual(v, { errors: [], value: { state: 'WI', answers: { filing_status: 'S', withholding_allowance: 2 } } });
    assert.match(M.validateStateTaxAnswers({ state: 'Wisconsin', answers: [] }).errors.join(), /two letters.*question and answer/);
    assert.match(M.validateStateTaxAnswers({ state: 'WI', answers: { 'bad key!': 1, ok: { a: 1 } } }).errors.join(), /not a question name.*answer to ok is not valid/);
    const provider = [{ state: 'WI', questions: [{ key: 'filing_status', label: 'Filing status', answers: [] }, { key: 'withholding_allowance', label: 'Allowances', answers: [] }, { key: 'additional_withholding', label: 'Extra', answers: [{ value: '5.00' }] }] }, { state: 'TX', questions: [] }];
    const r = M.toGustoStateTaxes({ WI: { answers: { filing_status: 'S', made_up: 'x' } }, CA: { answers: { filing_status: 'M' } } }, provider);
    assert.deepEqual(r.states, [{ state: 'WI', questions: [{ key: 'filing_status', answers: [{ value: 'S', valid_from: '2010-01-01', valid_up_to: null }] }] }]);
    assert.equal(r.sent, 1);
    assert.deepEqual(r.unknown, ['WI: made_up', 'CA: Gusto does not list this state for the person']);
    assert.deepEqual(r.unanswered, ['WI: Allowances'], 'a question the provider already has an answer for is not reported');
    assert.equal(M.stateTaxHash({ WI: { answers: { b: 1, a: 2 } } }), M.stateTaxHash({ WI: { answers: { a: 2, b: 1 }, updatedAt: 'later' } }));
});

/* ------------------------------- against the mock provider ------------------------------- */

const ORG = 'org_test_bank';
const h = makeHarness(ORG);
test.before(() => h.start());
test.after(() => h.stop());
const enc = (userId, number) => encryptField(number, `${ORG}:${userId}:bank`);
const splitForms = (userId, rows) => ({ directDepositSplits: rows.map(([id, number, type, value]) => ({ id, bankName: `Bank ${id}`, routingNumber: '021000021', accountType: 'checking', accountNumberEncrypted: enc(userId, number), accountLast4: number.slice(-4), allocation: { type, value } })), directDeposit: { split: true, accountLast4: rows[rows.length - 1][1].slice(-4) } });
const logged = [];
const spy = { info: (m, f) => logged.push(JSON.stringify([m, f])), warn: (m, f) => logged.push(JSON.stringify([m, f])), error: (m, f) => logged.push(JSON.stringify([m, f])) };

test('people sync sends bank accounts, the pay split and state tax answers; nothing secret is stored or logged; a re-run sends nothing', async () => {
    h.people = [
        h.person('u1', 'Ann Alpha', {}, splitForms('u1', [['a1', '111122223333', 'percent', 25], ['a2', '444455556666', 'remainder', null]])),
        h.person('u2', 'Bob Beta', { homeAddress: { line1: '5 Lake Rd', city: 'Madison', state: 'WI', zip: '53703' } }, { directDeposit: { bankName: 'Solo Bank', routingNumber: '021000021', accountType: 'savings', accountNumberEncrypted: enc('u2', '777788889999'), accountLast4: '9999' }, stateTax: { WI: { answers: { filing_status: 'S', withholding_allowance: 1, made_up: 'x' } } } }),
        h.person('u3', 'Cy Gamma', {}, splitForms('u3', [['c1', '121212121212', 'amount', 100], ['c2', '343434343434', 'percent', 10], ['c3', '565656565656', 'remainder', null]]))
    ];
    const ctx = await h.connect({ finishAll: false });
    const state = await h.mockGet('/state');
    const uuidOf = async (id) => (await h.store.getLink(ORG, 'employee', id)).gustoUuid;
    const [g1, g2, g3] = [await uuidOf('u1'), await uuidOf('u2'), await uuidOf('u3')];

    const banks = (g) => state.employeeBanks.filter((b) => b.employee_uuid === g);
    assert.equal(banks(g1).length, 2); assert.ok(banks(g1).every((b) => b.hasNumber));
    const pm1 = state.paymentMethods.find((m) => m.employee_uuid === g1);
    assert.equal(pm1.type, 'Direct Deposit'); assert.equal(pm1.split_by, 'Percentage');
    assert.deepEqual(pm1.splits.map((s) => s.split_amount), [25, 75]);
    assert.deepEqual([banks(g2).length, banks(g2)[0].account_type, banks(g2)[0].hidden_account_number], [1, 'Savings', 'XXXX9999']);
    assert.equal(state.paymentMethods.find((m) => m.employee_uuid === g2).splits[0].split_amount, 100);

    // a mix of fixed amount and percent is not sent, and the person's record says why
    assert.equal(banks(g3).length, 0);
    const l3 = await h.store.getLink(ORG, 'employee', 'u3');
    assert.match(l3.meta.bankNote, /both fixed amounts and percents/);
    assert.equal(l3.hashes.bank, undefined);
    assert.equal(l3.syncState, 'synced', 'the rest of the person still went through');

    // state tax: the two answers the provider asks for are there; the made-up one is reported, not sent
    const wi = state.stateTaxes.find((s) => s.employee_uuid === g2).states.find((s) => s.state === 'WI');
    assert.deepEqual(wi.questions.map((q) => [q.key, q.answers.length ? q.answers[0].value : null]), [['filing_status', 'S'], ['withholding_allowance', 1], ['additional_withholding', null]]);
    assert.match((await h.store.getLink(ORG, 'employee', 'u2')).meta.stateTaxNote, /WI: made_up/);

    // no account number anywhere in what we keep
    const kept = JSON.stringify([await h.store.listLinks(ORG), await h.store.listErrors(ORG, { includeResolved: true }), await h.store.getConnection(ORG)]);
    for (const n of ['111122223333', '444455556666', '777788889999', '121212121212']) assert.ok(!kept.includes(n), 'account number is not stored');

    const before = (await h.mockGet('/stats')).requests;
    const again = await sync.syncPeople(ctx);
    assert.equal(again.synced, 0); assert.equal(again.unchanged, 3);
    assert.equal((await h.mockGet('/stats')).requests, before, 'nothing changed, so nothing was sent to the provider');
});

test('a bank change: nothing is logged in the clear, the old account goes only after the new one works, and a finished person needs "overwrite"', async () => {
    h.people = [h.person('u1', 'Ann Alpha', {}, splitForms('u1', [['a1', '111122223333', 'remainder', null]])), h.person('u2', 'Bob Beta')];
    await h.connect({ finishAll: false });
    const { makeContext } = require('../services/gusto/index.js');
    const ctx = await makeContext(ORG, { store: h.store, log: spy, org: h.org, loadPeople: async () => h.people, loadLeave: async () => [], loadWeeks: async () => [], optsOverride: { baseUrl: h.baseUrl, backoffBaseMs: 5, rateLimitPerMinute: 100000 } });
    const links = await h.store.listLinks(ORG, 'employee');
    const done = links.find((l) => l.gusto && l.gusto.onboarded).ourId; // finished at the provider: the provider's own data wins
    const open = links.find((l) => !(l.gusto && l.gusto.onboarded)).ourId;
    const st = h.mock.state();
    const g = (id) => links.find((l) => l.ourId === id).gustoUuid;
    const banksOf = (id) => [...st.empBanks.values()].filter((b) => b.employee_uuid === g(id));

    // new bank details for both people
    h.people = [h.person('u1', 'Ann Alpha', {}, splitForms('u1', [['a9', '900090009000', 'remainder', null]])), h.person('u2', 'Bob Beta', {}, splitForms('u2', [['b9', '800080008000', 'remainder', null]]))];
    logged.length = 0;
    const r = await sync.syncPeople(ctx);
    assert.equal(r.errors, 0, JSON.stringify(r.results));
    assert.equal(banksOf(open).length, 1, 'the person who is not finished got the new account (and the old one, if any, was removed)');
    assert.equal(banksOf(open)[0].hidden_account_number.slice(-4), open === 'u1' ? '9000' : '8000');
    const doneBefore = banksOf(done).map((b) => b.hidden_account_number);
    assert.ok(!doneBefore.some((n) => n.endsWith(done === 'u1' ? '9000' : '8000')), 'a finished person is left alone without overwrite');
    await sync.syncPeople(ctx, { overwrite: true });
    assert.deepEqual(banksOf(done).map((b) => b.hidden_account_number.slice(-4)), [done === 'u1' ? '9000' : '8000']);
    const all = logged.join('\n');
    assert.ok(logged.length > 5);
    for (const n of ['900090009000', '800080008000', '111122223333', '021000021']) assert.ok(!all.includes(n), 'no bank number in the logs');

    // the provider refuses the new account: the account that works stays, and the next try succeeds
    const person = done; const tail = person === 'u1' ? '9000' : '8000';
    h.people = h.people.map((p) => (p.id === person ? h.person(person, p.name, {}, splitForms(person, [['z1', '12', 'remainder', null]])) : p)); // 2 digits: refused by the provider
    const bad = await sync.syncPeople(ctx, { ids: [person], overwrite: true });
    assert.equal(bad.errors, 1);
    assert.deepEqual(banksOf(person).map((b) => b.hidden_account_number.slice(-4)), [tail], 'the working account is still there');
    assert.equal(st.payMethods.get(g(person)).type, 'Direct Deposit');
    h.people = h.people.map((p) => (p.id === person ? h.person(person, p.name, {}, splitForms(person, [['z1', '123412341234', 'remainder', null]])) : p));
    const good = await sync.syncPeople(ctx, { ids: [person], overwrite: true });
    assert.equal(good.errors, 0, JSON.stringify(good.results));
    assert.deepEqual(banksOf(person).map((b) => b.hidden_account_number.slice(-4)), ['1234']);
});

test('state tax answers can be read with the provider\'s questions and sent on their own', async () => {
    h.people = [h.person('u1', 'Ann Alpha', { homeAddress: { line1: '5 Lake Rd', city: 'Madison', state: 'WI', zip: '53703' } }), h.person('u2', 'Bob Beta')];
    const ctx = await h.connect();
    const view = await sync.stateTaxFor(ctx, h.people[0]);
    assert.equal(view.inGusto, true);
    assert.deepEqual(view.states.map((s) => [s.state, s.questions.length]).sort(), [['TX', 0], ['WI', 3]]);
    await assert.rejects(() => sync.sendStateTax(ctx, h.person('u9', 'No Link')), (e) => e.code === 'not_linked' && e.status === 409);
    const withAnswers = h.person('u1', 'Ann Alpha', { homeAddress: { line1: '5 Lake Rd', city: 'Madison', state: 'WI', zip: '53703' } }, { stateTax: { WI: { answers: { filing_status: 'M', withholding_allowance: 3 } } } });
    const out = await sync.sendStateTax(ctx, withAnswers); // works for a person who already finished at the provider
    assert.deepEqual([out.sent, out.notAsked, out.unanswered], [2, [], ['WI: additional withholding']]);
    const after = await sync.stateTaxFor(ctx, withAnswers);
    assert.deepEqual(after.states.find((s) => s.state === 'WI').questions.map((q) => q.current), ['M', 3, null]);
    assert.deepEqual(after.states.find((s) => s.state === 'WI').saved, { filing_status: 'M', withholding_allowance: 3 });
});
