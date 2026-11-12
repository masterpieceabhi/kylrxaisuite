import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeHarness } from './gusto-harness.mjs';

const require = createRequire(import.meta.url);
const X = require('../services/gusto/extras-rules.js');
const benefits = require('../services/gusto/benefits.js');
const B = require('../services/benefits-rules.js');

const row = (userId, name, planType, planName, employeeDeduction, employerCost, taxTreatment = 'pre_tax') => ({ employeeId: `EMP-${userId}`, userId, name, payFrequency: 'biweekly', planType, planName, carrier: '', tier: 'employee_only', taxTreatment, employeeDeduction, employerCost, periodEnd: '2026-11-22', effectiveDate: '2026-01-01' });
const catalog = [{ benefit_type: 1, name: 'Medical Insurance' }, { benefit_type: 2, name: 'Dental Insurance' }, { benefit_type: 5, name: '401(k)' }, { benefit_type: 105, name: 'Roth 401(k)' }];

/* ------------------------------- rules ------------------------------- */

test('wanted deductions: one per person per plan, Roth kept apart, 401(k) as a percent when it is known', () => {
    const w = X.wantedDeductions([
        row('u1', 'Ann', 'medical', 'Gold  PPO', 55.5, 120), row('u1', 'Ann', '401k', 'Company 401k', 96, 48), row('u2', 'Bob', '401k', 'Company 401k', 80, 0, 'roth')
    ], new Map([['u1|401k|Company 401k', 6]]));
    assert.deepEqual(w.map((x) => [x.userId, x.kind, x.planName, x.employeeCents, x.employerCents, x.percent]), [['u1', '401k', 'Company 401k', 9600, 4800, 6], ['u1', 'medical', 'Gold PPO', 5550, 12000, null], ['u2', '401k_roth', 'Company 401k', 8000, 0, null]]);
    assert.match(w[0].notes.join(), /percent of pay/);
    assert.match(w[2].notes.join(), /estimated amount/);
    assert.deepEqual(X.toGustoEmployeeBenefit(w[0]), { active: true, employee_deduction: '6', deduct_as_percentage: true, contribution: { type: 'amount', value: '48.00' } });
    assert.deepEqual(X.toGustoEmployeeBenefit(w[1]), { active: true, employee_deduction: '55.50', deduct_as_percentage: false, contribution: { type: 'amount', value: '120.00' } });
});

test('the plan: create, update, unchanged, end, not at the provider, cannot be sent; hand-made benefits are only listed', () => {
    const wanted = X.wantedDeductions([
        row('u1', 'Ann', 'medical', 'Gold PPO', 55.5, 120), row('u1', 'Ann', 'dental', 'Smile', 10, 5), row('u2', 'Bob', 'medical', 'Gold PPO', 60, 120),
        row('u3', 'Cy', 'medical', 'Gold PPO', 55.5, 120), row('u1', 'Ann', 'life', 'Term Life', 4, 0, 'post_tax')
    ]);
    const companyBenefits = [{ uuid: 'cb-med', benefit_type: 1, description: 'gold ppo' }, { uuid: 'cb-old', benefit_type: 2, description: 'Old Dental' }, { uuid: 'cb-hand', benefit_type: 5, description: 'Hand made 401k' }];
    const current = new Map([
        ['g1', [{ uuid: 'eb1', company_benefit_uuid: 'cb-med', active: true, employee_deduction: '55.50', deduct_as_percentage: false, contribution: { type: 'amount', value: '120.00' } }, { uuid: 'eb-old', company_benefit_uuid: 'cb-old', active: true, employee_deduction: '8.00', company_contribution: '2.00' }, { uuid: 'eb-hand', company_benefit_uuid: 'cb-hand', active: true, employee_deduction: '5', deduct_as_percentage: true }]],
        ['g2', [{ uuid: 'eb2', company_benefit_uuid: 'cb-med', active: true, employee_deduction: '50.00', deduct_as_percentage: false, company_contribution: '120.00' }]]
    ]);
    const managed = [{ id: 'u1|dental|Old Dental', userId: 'u1', name: 'Ann', key: 'dental|Old Dental', planName: 'Old Dental', employeeBenefitUuid: 'eb-old' }];
    const p = X.planDeductions({ wanted, links: { u1: { gustoUuid: 'g1' }, u2: { gustoUuid: 'g2' } }, catalog, companyBenefits, current, managed });
    const by = Object.fromEntries(p.rows.map((r) => [r.id, r]));
    assert.equal(by['u1|medical|Gold PPO'].action, 'unchanged');
    assert.equal(by['u2|medical|Gold PPO'].action, 'update');
    assert.deepEqual(by['u2|medical|Gold PPO'].current, { employee: 50, percent: null, employer: 120, active: true });
    assert.equal(by['u1|dental|Smile'].action, 'create'); assert.equal(by['u1|dental|Smile'].companyBenefitUuid, null);
    assert.equal(by['u3|medical|Gold PPO'].action, 'not_in_provider');
    assert.equal(by['u1|life|Term Life'].action, 'cannot_send'); assert.match(by['u1|life|Term Life'].reason, /no benefit that matches/);
    assert.equal(by['u1|dental|Old Dental'].action, 'end');
    assert.deepEqual(p.companyBenefitsToCreate, [{ key: 'dental|Smile', benefitType: 2, description: 'Smile' }]);
    assert.deepEqual(p.unmanaged, [{ userId: 'u1', description: 'Hand made 401k', employee: null, percent: 5 }]);
    assert.deepEqual(p.totals, { create: 1, update: 1, end: 1, unchanged: 1, notInProvider: 1, cannotSend: 1 });
    assert.equal(p.changes, 3);
    // the fingerprint moves when an amount moves
    const p2 = X.planDeductions({ wanted: X.wantedDeductions([row('u1', 'Ann', 'medical', 'Gold PPO', 55.51, 120)]), links: { u1: { gustoUuid: 'g1' } }, catalog, companyBenefits, current, managed: [] });
    const p3 = X.planDeductions({ wanted: X.wantedDeductions([row('u1', 'Ann', 'medical', 'Gold PPO', 55.52, 120)]), links: { u1: { gustoUuid: 'g1' } }, catalog, companyBenefits, current, managed: [] });
    assert.notEqual(p2.fingerprint, p3.fingerprint);
});

test('the feed rows these rules read are the ones services/benefits-rules.js produces', () => {
    const plans = [{ id: 'p1', name: 'Gold PPO', type: 'medical', preTax: true, payPeriodsPerYear: 12, costs: { employee_only: { employee: 120, employer: 300 } } }];
    const feed = B.payrollFeed([{ userId: 'u1', status: 'active', effectiveDate: '2026-01-01', elections: [{ planId: 'p1', tier: 'employee_only' }] }], plans, { u1: { id: 'u1', name: 'Ann', employeeId: 'E1', payFrequency: 'monthly', payType: 'salary', payRate: 60000 } }, { periodEnd: '2026-11-30', limits: [] });
    const w = X.wantedDeductions(feed.rows);
    assert.deepEqual([w[0].userId, w[0].kind, w[0].planName, w[0].employeeCents, w[0].employerCents], ['u1', 'medical', 'Gold PPO', 12000, 30000]);
});

/* ------------------------------- against the mock provider ------------------------------- */

const ORG = 'org_test_benefit_ded';
const h = makeHarness(ORG);
test.before(() => h.start());
test.after(() => h.stop());
const provider = async () => { const s = await h.mockGet('/state'); return { company: s.companyBenefits, emp: s.employeeBenefits }; };

test('preview shows what will change, send does exactly that, the compare afterwards is clean, and a re-send does nothing', async () => {
    const ctx = await h.connect();
    h.people.push(h.person('u8', 'Nell Nolink'));
    h.feed = { rows: [row('u1', 'Ann Alpha', 'medical', 'Gold PPO', 55.5, 120), row('u2', 'Bob Beta', 'medical', 'Gold PPO', 55.5, 120), row('u1', 'Ann Alpha', '401k', 'Company 401k', 96, 48), row('u8', 'Nell Nolink', 'medical', 'Gold PPO', 55.5, 120)], errors: [], percents: new Map([['u1|401k|Company 401k', 6]]) };

    const pre = await benefits.preview(ctx, { periodEnd: '2026-11-22' });
    assert.deepEqual(pre.totals, { create: 3, update: 0, end: 0, unchanged: 0, notInProvider: 1, cannotSend: 0 });
    assert.deepEqual(pre.newCompanyBenefits.sort(), ['Company 401k', 'Gold PPO']);
    assert.ok(pre.rows.every((r) => !('body' in r) && !('employeeUuid' in r)), 'no provider ids or request bodies go to the page');
    assert.equal((await provider()).emp.length, 0, 'a preview sends nothing');

    await assert.rejects(() => benefits.send(ctx, { periodEnd: '2026-11-22', fingerprint: 'stale', actor: 'p' }), (e) => e.code === 'changed' && e.status === 409);
    await assert.rejects(() => benefits.send(ctx, { periodEnd: '2026-11-22', actor: 'p' }), (e) => e.code === 'changed');
    await assert.rejects(() => benefits.preview(ctx, { periodEnd: 'soon' }), (e) => e.status === 400);

    const out = await benefits.send(ctx, { periodEnd: '2026-11-22', fingerprint: pre.fingerprint, actor: 'payroll1' });
    assert.deepEqual([out.sent, out.failed], [3, 0], JSON.stringify(out.results));
    let p = await provider();
    assert.equal(p.company.length, 2); assert.equal(p.emp.length, 3);
    const k401 = p.emp.find((e) => e.deduct_as_percentage);
    assert.deepEqual([k401.employee_deduction, k401.contribution.value], ['6', '48.00']);
    assert.deepEqual(out.after.totals, { create: 0, update: 0, end: 0, unchanged: 3, notInProvider: 1, cannotSend: 0 });
    assert.equal(out.after.changes, 0);

    // sending again with the new preview does nothing at the provider
    const before = (await h.mockGet('/stats')).byPath;
    const again = await benefits.send(ctx, { periodEnd: '2026-11-22', fingerprint: out.after.fingerprint, actor: 'p' });
    assert.deepEqual([again.sent, again.failed], [0, 0]);
    const after = (await h.mockGet('/stats')).byPath;
    assert.equal(after['POST /v1/employees/:id/employee_benefits'], before['POST /v1/employees/:id/employee_benefits']);
    assert.equal(after['PUT /v1/employee_benefits/:id'], before['PUT /v1/employee_benefits/:id']);
    assert.equal((await benefits.lastRun(ctx)).sent, 0);

    // a changed amount is an update; a dropped plan is switched off; a benefit made by hand at the provider is left alone
    const state = h.mock.state();
    const u2 = (await h.store.getLink(ORG, 'employee', 'u2')).gustoUuid;
    const cb401 = p.company.find((c) => c.description === 'Company 401k').uuid;
    state.employeeBenefits.set('hand-1', { uuid: 'hand-1', employee_uuid: u2, company_benefit_uuid: cb401, version: 'v', active: true, employee_deduction: '3', deduct_as_percentage: true, contribution: { type: 'amount', value: '0.00' } });
    h.feed = { rows: [row('u1', 'Ann Alpha', 'medical', 'Gold PPO', 60, 120), row('u2', 'Bob Beta', 'medical', 'Gold PPO', 55.5, 120)], errors: [{ userId: 'u3', planId: 'p9', error: 'payFrequency is missing' }], percents: new Map() };
    const pre2 = await benefits.preview(ctx, { periodEnd: '2026-12-06' });
    assert.deepEqual(pre2.totals, { create: 0, update: 1, end: 1, unchanged: 1, notInProvider: 0, cannotSend: 0 });
    assert.deepEqual(pre2.rows.find((r) => r.action === 'update').current, { employee: 55.5, percent: null, employer: 120, active: true });
    assert.equal(pre2.rows.find((r) => r.action === 'end').planName, 'Company 401k');
    assert.deepEqual(pre2.notFromHere, [{ userId: 'u2', description: 'Company 401k', employee: null, percent: 3 }]);
    assert.equal(pre2.feedErrors.length, 1);
    const out2 = await benefits.send(ctx, { periodEnd: '2026-12-06', fingerprint: pre2.fingerprint, actor: 'p' });
    assert.deepEqual([out2.sent, out2.failed], [2, 0]);
    p = await provider();
    assert.equal(p.emp.length, 4);
    assert.equal(p.emp.find((e) => e.uuid === k401.uuid).active, false, 'the dropped 401(k) is switched off, not deleted');
    assert.equal(p.emp.find((e) => e.uuid === 'hand-1').active, true);
    assert.equal(p.emp.filter((e) => e.employee_deduction === '60.00').length, 1);
    assert.equal(out2.after.changes, 0);
    h.people.pop();
});

test('one person failing does not stop the others, the failure is kept as a problem, and the retry goes through', async () => {
    const ctx = await h.connect();
    h.feed = { rows: [row('u1', 'Ann Alpha', 'dental', 'Smile', 10, 5), row('u2', 'Bob Beta', 'dental', 'Smile', 10, 5)], errors: [], percents: new Map() };
    const pre = await benefits.preview(ctx, { periodEnd: '2026-11-22' });
    const state = h.mock.state();
    const u2 = (await h.store.getLink(ORG, 'employee', 'u2')).gustoUuid;
    const real = ctx.client.post;
    ctx.client.post = async (path, body, o) => { if (path.includes(u2) && path.endsWith('/employee_benefits')) return real(path, { ...body, employee_deduction: '-1' }, o); return real(path, body, o); };
    const out = await benefits.send(ctx, { periodEnd: '2026-11-22', fingerprint: pre.fingerprint, actor: 'p' });
    assert.deepEqual([out.sent, out.failed], [1, 1]);
    assert.match(out.results.find((r) => !r.ok).error, /zero or more/);
    assert.equal(state.employeeBenefits.size, 1);
    assert.equal((await h.store.listErrors(ORG)).filter((e) => e.scope === 'benefit_deduction').length, 1);
    assert.deepEqual(out.after.totals.create, 1, 'the compare still shows the one that is missing');
    ctx.client.post = real;
    const retry = await benefits.send(ctx, { periodEnd: '2026-11-22', fingerprint: out.after.fingerprint, actor: 'p' });
    assert.deepEqual([retry.sent, retry.failed], [1, 0]);
    assert.equal(state.employeeBenefits.size, 2);
    assert.equal(state.companyBenefits.size, 1, 'the company benefit was made once');
    assert.equal((await h.store.listErrors(ORG)).filter((e) => e.scope === 'benefit_deduction').length, 0);
});
