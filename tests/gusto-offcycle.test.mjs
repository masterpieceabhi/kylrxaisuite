import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeHarness, addDays, today } from './gusto-harness.mjs';

const require = createRequire(import.meta.url);
const X = require('../services/gusto/extras-rules.js');
const offcycle = require('../services/gusto/offcycle.js');
const payroll = require('../services/gusto/payroll.js');

/* ------------------------------- rules ------------------------------- */

const people = [{ id: 'u1', name: 'Ann', payType: 'hourly', active: true }, { id: 'u2', name: 'Bob', payType: 'salary', active: true }, { id: 'u9', name: 'Gone', payType: 'hourly', active: false }];
const links = { u1: { gustoUuid: 'g1', meta: { jobUuid: 'j1' } }, u2: { gustoUuid: 'g2', meta: { jobUuid: 'j2' } }, u9: { gustoUuid: 'g9', meta: {} } };
const check = (input) => X.validateOffCycle(input, { today: '2026-11-12', people, links });

test('off-cycle rules: a valid bonus is normalised, with the provider reason and line', () => {
    const r = check({ reason: 'bonus', checkDate: '2026-11-20', people: [{ userId: 'u2', amount: 500 }, { userId: 'u1', amount: '250.50', note: ' holiday ' }] });
    assert.deepEqual(r.errors, []);
    assert.equal(r.value.gustoReason, 'Bonus'); assert.equal(r.value.fixedName, 'Bonus');
    assert.deepEqual(r.value.people.map((p) => [p.userId, p.amountCents]), [['u1', 25050], ['u2', 50000]]);
    assert.equal(r.value.totals.amountCents, 75050);
    assert.equal(r.value.start, '2026-11-12'); assert.equal(r.value.end, '2026-11-12');
    assert.equal(r.value.skipRegularDeductions, true);
    const body = X.toGustoOffCycle(r.value);
    assert.equal(body.off_cycle, true); assert.deepEqual(body.employee_uuids, ['g1', 'g2']); assert.equal(body.check_date, '2026-11-20');
});

test('off-cycle rules: what is refused, in plain words', () => {
    const errs = (input) => check(input).errors.join(' | ');
    assert.match(errs({ reason: 'gift', checkDate: '2026-11-20', people: [{ userId: 'u1', amount: 1 }] }), /reason must be one of/);
    assert.match(errs({ reason: 'bonus', checkDate: '2026-11-01', people: [{ userId: 'u1', amount: 1 }] }), /cannot be in the past/);
    assert.match(errs({ reason: 'bonus', checkDate: '2026-11-20', people: [] }), /at least one person/);
    assert.match(errs({ reason: 'bonus', checkDate: '2026-11-20', people: [{ userId: 'u1' }] }), /enter an amount or hours/);
    assert.match(errs({ reason: 'bonus', checkDate: '2026-11-20', people: [{ userId: 'u1', amount: 10.005 }] }), /cents at most/);
    assert.match(errs({ reason: 'bonus', checkDate: '2026-11-20', people: [{ userId: 'u1', amount: -5 }] }), /zero or more/);
    assert.match(errs({ reason: 'correction', checkDate: '2026-11-20', people: [{ userId: 'u2', hours: 3 }] }), /not paid by the hour/);
    assert.match(errs({ reason: 'bonus', checkDate: '2026-11-20', people: [{ userId: 'u1', amount: 5 }, { userId: 'u1', amount: 5 }] }), /listed twice/);
    assert.match(errs({ reason: 'bonus', checkDate: '2026-11-20', people: [{ userId: 'nobody', amount: 5 }] }), /not found/);
    assert.match(errs({ reason: 'bonus', checkDate: '2026-11-20', people: [{ userId: 'u9', amount: 5 }] }), /no longer active/);
    assert.match(errs({ reason: 'bonus', checkDate: '2026-11-20', start: '2026-11-19', end: '2026-11-25', people: [{ userId: 'u1', amount: 5 }] }), /cannot end after the pay date/);
    assert.match(X.validateOffCycle({ reason: 'bonus', checkDate: '2026-11-20', people: [{ userId: 'u1', amount: 5 }] }, { today: '2026-11-12', people, links: {} }).errors.join(), /not in Gusto yet/);
    // someone who left can get final pay, with hours at their rate
    const fin = check({ reason: 'final_pay', checkDate: '2026-11-13', people: [{ userId: 'u9', hours: 12.5, amount: 80 }] });
    assert.deepEqual(fin.errors, []);
    assert.equal(fin.value.gustoReason, 'Dismissed employee'); assert.equal(fin.value.skipRegularDeductions, false);
});

test('off-cycle rules: compensation lines, people missing from the payroll, and a stable fingerprint', () => {
    const v = check({ reason: 'correction', checkDate: '2026-11-20', people: [{ userId: 'u1', hours: 2.5, amount: 10 }, { userId: 'u2', amount: 40 }] }).value;
    const { comps, missing } = X.offCycleCompensations(v, [{ employee_uuid: 'g1', fixed_compensations: [{ name: 'Bonus', job_uuid: 'jx' }] }]);
    assert.deepEqual(missing, [{ userId: 'u2', name: 'Bob' }]);
    assert.deepEqual(comps, [{ employee_uuid: 'g1', excluded: false, fixed_compensations: [{ name: 'Correction Payment', amount: '10.00', job_uuid: 'j1' }], hourly_compensations: [{ name: 'Regular Hours', job_uuid: 'j1', hours: '2.500', compensation_multiplier: 1 }] }]);
    const same = check({ reason: 'correction', checkDate: '2026-11-20', people: [{ userId: 'u2', amount: '40.00' }, { userId: 'u1', amount: 10, hours: '2.5' }] }).value;
    assert.equal(X.offCycleHash(same), X.offCycleHash(v));
    const other = check({ reason: 'correction', checkDate: '2026-11-20', people: [{ userId: 'u2', amount: 41 }, { userId: 'u1', amount: 10, hours: 2.5 }] }).value;
    assert.notEqual(X.offCycleHash(other), X.offCycleHash(v));
});

/* ------------------------------- against the mock provider ------------------------------- */

const h = makeHarness('org_test_offcycle');
test.before(() => h.start());
test.after(() => h.stop());
const payDay = () => addDays(today(), 10);

test('off-cycle bonus: create -> preview -> submit needs the typed confirmation, and only one submit wins', async () => {
    const ctx = await h.connect();
    const who = await offcycle.candidates(ctx);
    assert.deepEqual(who.map((p) => p.userId), ['u1', 'u2', 'u3']);
    assert.ok(who.every((p) => p.finishedInGusto));

    await assert.rejects(() => offcycle.createOffCycle(ctx, { reason: 'bonus', checkDate: payDay(), people: [] }, { actor: 'p' }), (e) => e.code === 'validation' && e.status === 400 && e.errors.length > 0);

    const prep = await offcycle.createOffCycle(ctx, { reason: 'bonus', checkDate: payDay(), people: [{ userId: 'u1', amount: 300 }, { userId: 'u3', amount: 1000.5 }] }, { actor: 'payroll1' });
    assert.equal(prep.status, 'prepared'); assert.equal(prep.kind, 'off_cycle');
    // the salaried person gets the bonus only, never a salary on top
    assert.equal(prep.totals.gross_pay, '1300.50');
    assert.deepEqual(prep.employees.map((e) => [e.name, e.gross]).sort(), [['Ann Alpha', '300.00'], ['Cy Gamma', '1000.50']]);
    assert.equal(prep.canSubmit, true);
    const atProvider = (await h.mockGet('/state')).payrolls.filter((p) => p.off_cycle);
    assert.equal(atProvider.length, 1);
    assert.equal(atProvider[0].off_cycle_reason, 'Bonus'); assert.equal(atProvider[0].check_date, payDay());
    assert.equal(atProvider[0].employee_compensations.length, 2, 'only the chosen people are on the payroll');

    // asking for exactly the same again re-uses the open preparation: no second payroll at the provider
    const again = await offcycle.createOffCycle(ctx, { reason: 'bonus', checkDate: payDay(), people: [{ userId: 'u3', amount: '1000.50' }, { userId: 'u1', amount: 300 }] }, { actor: 'payroll1' });
    assert.equal(again.payrollUuid, prep.payrollUuid); assert.equal(again.reused, true);
    assert.equal((await h.mockGet('/state')).payrolls.filter((p) => p.off_cycle).length, 1);

    const prev = await payroll.previewPayroll(ctx, prep.payrollUuid);
    assert.equal(prev.kind, 'off_cycle'); assert.equal(prev.stale, false); assert.equal(prev.totals.gross_pay, '1300.50'); assert.equal(prev.employees.length, 2);

    await assert.rejects(() => payroll.submitPayroll(ctx, prep.payrollUuid, { actor: 'p' }), (e) => e.code === 'confirmation_required');
    await assert.rejects(() => payroll.submitPayroll(ctx, prep.payrollUuid, { confirm: true, confirmPayrollId: 'wrong', actor: 'p' }), (e) => e.code === 'confirmation_required');
    const [r1, r2] = await Promise.allSettled([
        payroll.submitPayroll(ctx, prep.payrollUuid, { confirm: true, confirmPayrollId: prep.payrollUuid, actor: 'p1' }),
        payroll.submitPayroll(ctx, prep.payrollUuid, { confirm: true, confirmPayrollId: prep.payrollUuid, actor: 'p2' })
    ]);
    assert.equal([r1, r2].filter((r) => r.status === 'fulfilled').length, 1, 'exactly one concurrent submit wins');
    await assert.rejects(() => payroll.submitPayroll(ctx, prep.payrollUuid, { confirm: true, confirmPayrollId: prep.payrollUuid, actor: 'p' }), (e) => e.code === 'wrong_state');

    const hist = await payroll.history(ctx);
    assert.equal(hist.length, 1); assert.equal(hist[0].status, 'submitted'); assert.equal(hist[0].kind, 'off_cycle'); assert.equal(hist[0].reason, 'bonus');
    const reg = await payroll.register(ctx, prep.payrollUuid);
    assert.equal(reg.rows.length, 2); assert.equal(reg.totals.gross, 1300.5);

    // paying the identical bonus a second time needs an explicit yes
    await assert.rejects(() => offcycle.createOffCycle(ctx, { reason: 'bonus', checkDate: payDay(), people: [{ userId: 'u1', amount: 300 }, { userId: 'u3', amount: 1000.5 }] }, { actor: 'p' }), (e) => e.code === 'already_submitted' && e.status === 409);
    const repeat = await offcycle.createOffCycle(ctx, { reason: 'bonus', checkDate: payDay(), allowRepeat: true, people: [{ userId: 'u1', amount: 300 }, { userId: 'u3', amount: 1000.5 }] }, { actor: 'p' });
    assert.notEqual(repeat.payrollUuid, prep.payrollUuid);
});

test('off-cycle correction with hours; totals changed at the provider after review block the submit; discard removes it there', async () => {
    const ctx = await h.connect();
    const prep = await offcycle.createOffCycle(ctx, { reason: 'correction', checkDate: payDay(), people: [{ userId: 'u1', hours: 4, amount: 12.25 }] }, { actor: 'p' });
    assert.equal(prep.totals.gross_pay, '92.25'); // 4 hours at $20 plus 12.25

    // somebody edits the payroll at the provider after it was reviewed here
    const state = h.mock.state();
    const p = state.payrolls.get(prep.payrollUuid);
    p.employee_compensations[0].fixed_compensations[0].amount = '500.00'; p.totals.gross_pay = '580.00';
    assert.equal((await payroll.previewPayroll(ctx, prep.payrollUuid)).stale, true);
    await assert.rejects(() => payroll.submitPayroll(ctx, prep.payrollUuid, { confirm: true, confirmPayrollId: prep.payrollUuid, actor: 'p' }), (e) => e.code === 'stale_totals' && e.status === 409);

    const out = await payroll.cancelPayroll(ctx, prep.payrollUuid, { actor: 'p' });
    assert.equal(out.status, 'discarded');
    assert.equal(state.payrolls.has(prep.payrollUuid), false, 'the unsubmitted off-cycle payroll is deleted at the provider');
    await assert.rejects(() => payroll.submitPayroll(ctx, prep.payrollUuid, { confirm: true, confirmPayrollId: prep.payrollUuid, actor: 'p' }), (e) => e.code === 'wrong_state');
});

test('off-cycle: a person who has not finished at the provider is reported, and nothing is left behind when nobody can be paid', async () => {
    const ctx = await h.connect({ finishAll: false }); // only one person finished onboarding at the provider
    const links = await h.store.listLinks(h.ORG, 'employee');
    const done = links.find((l) => l.gusto && l.gusto.onboarded).ourId;
    const notDone = links.find((l) => !(l.gusto && l.gusto.onboarded)).ourId;
    await assert.rejects(() => offcycle.createOffCycle(ctx, { reason: 'bonus', checkDate: payDay(), people: [{ userId: notDone, amount: 50 }] }, { actor: 'p' }), (e) => e.code === 'not_in_payroll' && e.status === 409);
    assert.equal(h.mock.state().payrolls.size, 0, 'the empty payroll was removed at the provider');
    const prep = await offcycle.createOffCycle(ctx, { reason: 'bonus', checkDate: payDay(), people: [{ userId: notDone, amount: 50 }, { userId: done, amount: 75 }] }, { actor: 'p' });
    assert.equal(prep.totals.gross_pay, '75.00');
    assert.ok(prep.issues.some((i) => i.code === 'not_in_payroll' && i.userId === notDone));
});

test('an off-cycle payroll never stands in for the regular payroll of the same dates', async () => {
    const ctx = await h.connect();
    const prep = await offcycle.createOffCycle(ctx, { reason: 'bonus', checkDate: payDay(), people: [{ userId: 'u1', amount: 20 }] }, { actor: 'p' });
    const regular = await payroll.listPayrolls(ctx, { start: addDays(today(), -40), end: addDays(today(), 40) });
    assert.ok(regular.length > 0);
    assert.ok(regular.every((p) => p.payroll_uuid !== prep.payrollUuid && !p.off_cycle));
});
