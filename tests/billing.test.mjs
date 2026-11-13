import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('../services/billing-rules.js');
const stripe = require('../services/billing-stripe.js');
const growth = B.DEFAULT_PLANS.find((p) => p.id === 'growth');
const starter = B.DEFAULT_PLANS.find((p) => p.id === 'starter');

test('headcount counts people with an employeeId who are not terminated; contractors optional', () => {
    const people = [
        { employeeId: 'E1', status: 'Active' }, { employeeId: 'E2', status: 'terminated' }, { employeeId: 'E3' },
        { employeeId: 'E4', usProfile: { classification: '1099' } }, { name: 'no id' }
    ];
    assert.deepEqual(B.countBillable(people), { employees: 2, contractors: 1, billable: 2, includeContractors: false });
    assert.equal(B.countBillable(people, { includeContractors: true }).billable, 3);
});

test('price = base + per employee, with a minimum, and annual discount', () => {
    assert.equal(B.priceCycle(growth, 50).totalCents, 9900 + 50 * 1200);
    assert.equal(B.priceCycle(starter, 0).totalCents, 4900);
    const lowMin = { ...starter, minimumCents: 20000 };
    assert.equal(B.priceCycle(lowMin, 2).totalCents, 20000);
    assert.equal(B.priceCycle(lowMin, 2).minimumTopUpCents, 20000 - 4900 - 1600);
    const annual = B.priceCycle(growth, 50, 'annual');
    assert.equal(annual.totalCents, (9900 + 60000) * 12 - Math.round((9900 + 60000) * 12 * 0.15));
});

test('billing periods are anchored and clamp month ends', () => {
    assert.deepEqual(B.periodFor('2026-01-31', 'monthly', '2026-02-15'), { start: '2026-01-31', end: '2026-02-28' });
    assert.deepEqual(B.periodFor('2026-01-31', 'monthly', '2026-02-28'), { start: '2026-02-28', end: '2026-03-31' });
    assert.deepEqual(B.periodFor('2026-03-10', 'annual', '2027-03-09'), { start: '2026-03-10', end: '2027-03-10' });
});

test('proration credits the unused old plan and charges the rest on the new one', () => {
    const p = B.prorate(10000, 20000, '2026-06-01', '2026-07-01', '2026-06-16');
    assert.equal(p.daysTotal, 30); assert.equal(p.daysLeft, 15);
    assert.equal(p.creditCents, 5000); assert.equal(p.chargeCents, 10000); assert.equal(p.netCents, 5000);
    const down = B.prorate(20000, 10000, '2026-06-01', '2026-07-01', '2026-06-16');
    assert.equal(down.netCents, -5000);
    assert.equal(B.prorate(1000, 2000, '2026-06-01', '2026-07-01', '2026-07-01').netCents, 0);
});

test('invoice lines, credits and the tax placeholder', () => {
    const period = { start: '2026-06-01', end: '2026-07-01' };
    const inv = B.buildInvoice({ plan: growth, headcount: 120, period, creditAvailableCents: 5000, taxRatePct: 0 });
    assert.equal(inv.subtotalCents, 9900 + 120 * 1200);
    assert.equal(inv.creditAppliedCents, 5000);
    assert.equal(inv.totalCents, inv.subtotalCents - 5000);
    assert.match(inv.taxNote, /placeholder/);
    const taxed = B.buildInvoice({ plan: starter, headcount: 10, period, taxRatePct: 8.25 });
    assert.equal(taxed.taxCents, Math.round((4900 + 8000) * 0.0825));
    const trial = B.buildInvoice({ plan: starter, headcount: 10, period, trial: true });
    assert.equal(trial.totalCents, 0);
    const credit = B.buildInvoice({ plan: starter, headcount: 0, period, adjustments: [{ description: 'Proration credit', amountCents: -99999 }] });
    assert.equal(credit.totalCents, 0); assert.ok(credit.negativeCreditCents > 0);
});

test('payment state machine: trial, failure, grace, suspension, recovery, cancel', () => {
    let a = { state: 'trial' };
    assert.equal(B.nextState(a, { type: 'trial_ended', hasPaymentMethod: true }, '2026-06-15').state, 'active');
    assert.equal(B.nextState(a, { type: 'trial_ended', hasPaymentMethod: false }, '2026-06-15').state, 'past_due');
    a = B.nextState({ state: 'active' }, { type: 'payment_failed' }, '2026-06-15');
    assert.equal(a.state, 'past_due'); assert.equal(a.graceEndsAt, '2026-06-29');
    assert.equal(B.dunningAction(a, '2026-06-16').action, 'retry');
    assert.equal(B.dunningAction(a, '2026-06-17').action, 'none');
    assert.equal(B.dunningAction(a, '2026-06-29').action, 'suspend');
    const s = B.nextState(a, { type: 'grace_expired' }, '2026-06-29');
    assert.equal(s.state, 'suspended'); assert.ok(B.isReadOnly(s.state));
    const r = B.nextState(s, { type: 'payment_succeeded' }, '2026-07-01');
    assert.equal(r.state, 'active'); assert.equal(r.graceEndsAt, null);
    assert.equal(B.nextState(r, { type: 'cancel' }, '2026-07-02').state, 'cancelled');
    assert.equal(B.nextState({ state: 'cancelled' }, { type: 'payment_succeeded' }, '2026-07-02').state, 'cancelled');
});

test('plan validation', () => {
    assert.ok(B.validatePlan({ id: 'x', name: 'X', baseFeeCents: 1, perEmployeeCents: 1 }).errors.length > 0);
    assert.deepEqual(B.validatePlan({ id: 'pro', name: 'Pro', baseFeeCents: 1000, perEmployeeCents: 100 }).errors, []);
    assert.ok(B.validatePlan({ id: 'pro', name: 'Pro', baseFeeCents: 10.5, perEmployeeCents: 100 }).errors.length > 0);
});

test('mock Stripe webhook: signature verification, tolerance and tampering', () => {
    const secret = 'whsec_test';
    const payload = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: {} } });
    const header = stripe.signPayload(payload, secret, 1700000000);
    assert.equal(stripe.verifySignature(payload, header, secret, { now: 1700000100 }).ok, true);
    assert.equal(stripe.verifySignature(payload + ' ', header, secret, { now: 1700000100 }).ok, false);
    assert.equal(stripe.verifySignature(payload, header, 'other', { now: 1700000100 }).ok, false);
    assert.equal(stripe.verifySignature(payload, header, secret, { now: 1700009999 }).reason, 'timestamp outside tolerance');
    assert.equal(stripe.verifySignature(payload, '', secret).ok, false);
});
