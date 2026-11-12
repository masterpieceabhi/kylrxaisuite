import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeHarness, addDays, today } from './gusto-harness.mjs';

const require = createRequire(import.meta.url);
const garnishments = require('../services/gusto/garnishments.js');
const sync = require('../services/gusto/sync.js');

const ORG = 'org_test_garnish';
const h = makeHarness(ORG);
test.before(() => h.start());
test.after(() => h.stop());
const atProvider = async () => (await h.mockGet('/state')).garnishments;

test('an order is recorded, sent to the provider, shown with or without its case number, and ended', async () => {
    const ctx = await h.connect();
    await assert.rejects(() => garnishments.create(ctx, { userId: 'u1', type: 'creditor' }, { actor: 'p' }), (e) => e.code === 'validation' && e.status === 400 && e.errors.length >= 3);
    await assert.rejects(() => garnishments.create(ctx, { userId: 'ghost', type: 'creditor', caseNumber: 'A-1', amountType: 'amount', value: 10, startDate: today() }, { actor: 'p' }), (e) => e.status === 404);

    const made = await garnishments.create(ctx, { userId: 'u1', type: 'child_support', issuingState: 'TX', caseNumber: 'CS-2026-778899', amountType: 'amount', value: 212.5, limits: { perPayPeriodMax: 250 }, startDate: addDays(today(), -3), payeeNotes: 'State disbursement unit' }, { actor: 'payroll1' });
    assert.equal(made.status, 'active'); assert.equal(made.provider.state, 'sent'); assert.equal(made.caseNumber, 'CS-2026-778899'); assert.deepEqual(made.attention, []);
    let g = await atProvider();
    assert.equal(g.length, 1);
    assert.deepEqual([g[0].amount, g[0].garnishment_type, g[0].court_ordered, g[0].active, g[0].pay_period_maximum, g[0].child_support.case_number, g[0].child_support.state], ['212.50', 'child_support', true, true, '250.00', 'CS-2026-778899', 'TX']);

    // stored: the case number is encrypted, never in the clear
    const stored = JSON.stringify(await h.store.listRecords('garnishments', ORG));
    assert.ok(!stored.includes('CS-2026-778899'));
    assert.match(stored, /"caseNumberEnc":"v1:/);

    const hidden = await garnishments.list(ctx, { showCase: false });
    assert.equal(hidden[0].caseNumber, null); assert.ok(!JSON.stringify(hidden).includes('778899'));
    const shown = await garnishments.list(ctx, { showCase: true });
    assert.equal(shown[0].caseNumber, 'CS-2026-778899'); assert.equal(shown[0].name, 'Ann Alpha');

    // sending again updates the same garnishment instead of adding one
    await garnishments.send(ctx, made.id);
    assert.equal((await atProvider()).length, 1);

    // a later end date is only recorded; today's end switches it off at the provider; a second end is refused
    const planned = await garnishments.end(ctx, made.id, { endDate: addDays(today(), 30), reason: 'order says 30 more days' }, { actor: 'p' });
    assert.equal(planned.planned, true); assert.equal(planned.garnishment.status, 'active');
    assert.equal((await atProvider())[0].active, true);
    const ended = await garnishments.end(ctx, made.id, { reason: 'released by the court' }, { actor: 'p' });
    assert.equal(ended.planned, false); assert.equal(ended.garnishment.status, 'ended'); assert.equal(ended.garnishment.provider.active, false);
    g = await atProvider();
    assert.equal(g.length, 1); assert.equal(g[0].active, false);
    await assert.rejects(() => garnishments.end(ctx, made.id, {}, { actor: 'p' }), (e) => e.code === 'wrong_state' && e.status === 409);
    await assert.rejects(() => garnishments.send(ctx, made.id), (e) => e.code === 'wrong_state');
    await assert.rejects(() => garnishments.end(ctx, 'missing', {}, { actor: 'p' }), (e) => e.status === 404);
});

test('a future order waits; a person who is not at the provider is kept and can be sent later; a provider refusal is kept as a problem', async () => {
    const ctx = await h.connect();
    const future = await garnishments.create(ctx, { userId: 'u2', type: 'tax_levy', levyAuthority: 'federal', caseNumber: 'LEVY 44-1', amountType: 'percent', value: 15, startDate: addDays(today(), 5) }, { actor: 'p' });
    assert.equal(future.status, 'scheduled'); assert.equal(future.provider.state, 'not_sent');
    assert.match(future.attention.join(), /starts on/);
    assert.equal((await atProvider()).length, 0);
    await assert.rejects(() => garnishments.send(ctx, future.id), (e) => e.code === 'not_started' && e.status === 409);

    // someone with a profile here who was never sent to the provider
    h.people.push(h.person('u7', 'Newt Nolink'));
    const waiting = await garnishments.create(ctx, { userId: 'u7', type: 'other', caseNumber: 'MISC-7', amountType: 'amount', value: 40, startDate: today() }, { actor: 'p' });
    assert.equal(waiting.status, 'active'); assert.equal(waiting.provider.state, 'blocked');
    assert.match(waiting.attention.join(), /not in Gusto yet/);
    await sync.syncPeople(ctx, { ids: ['u7'] });
    const sent = await garnishments.send(ctx, waiting.id);
    assert.equal(sent.provider.state, 'sent');
    const g = await atProvider();
    assert.equal(g.length, 1);
    assert.equal(g[0].garnishment_type, 'other_garnishment');
    assert.ok(!JSON.stringify(g[0]).includes('MISC-7'), 'only child support has a case number field at the provider');
    h.people.pop();

    // the provider refuses once (bad request), the record survives with the problem, and the retry goes through
    const state = h.mock.state();
    const u1 = (await h.store.getLink(ORG, 'employee', 'u1')).gustoUuid;
    const saved = state.employees.get(u1); state.employees.delete(u1); // the provider no longer knows this employee
    const bad = await garnishments.create(ctx, { userId: 'u1', type: 'creditor', caseNumber: 'CV-1', amountType: 'amount', value: 25, startDate: today() }, { actor: 'p' });
    assert.equal(bad.provider.state, 'error'); assert.match(bad.attention.join(), /could not be sent/);
    assert.equal((await h.store.listErrors(ORG)).filter((e) => e.scope === 'garnishment').length, 1);
    state.employees.set(u1, saved);
    const retried = await garnishments.send(ctx, bad.id);
    assert.equal(retried.provider.state, 'sent'); assert.deepEqual(retried.attention, []);
    assert.equal((await h.store.listErrors(ORG)).filter((e) => e.scope === 'garnishment').length, 0);
    assert.equal((await garnishments.list(ctx, { userId: 'u1' })).length, 1);
});
