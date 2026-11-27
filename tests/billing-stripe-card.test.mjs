// The real Stripe adapter (services/billing-stripe.js) against a stand-in for Stripe's API: card page, saving the card,
// charging it, declines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createStripe } = require('../services/billing-stripe.js');

function stub(routes) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url); const key = `${opts.method || 'GET'} ${u.pathname}`;
    const body = Object.fromEntries(new URLSearchParams(opts.body || ''));
    calls.push({ key, body, search: u.search, headers: opts.headers || {} });
    const h = routes[key];
    if (!h) return { ok: false, status: 404, json: async () => ({ error: { message: `no stub for ${key}` } }) };
    const [status, json] = h(body, u);
    return { ok: status < 300, status, json: async () => json };
  };
  return { calls, restore: () => { global.fetch = orig; } };
}

test.beforeEach(() => { process.env.STRIPE_SECRET_KEY = 'sk_test_stub'; });

test('the card page is a Stripe Checkout setup session for this customer and company; nothing is charged', async () => {
  const s = stub({ 'POST /v1/checkout/sessions': () => [200, { id: 'cs_test_123456', url: 'https://checkout.stripe.com/c/pay/cs_test_123456' }] });
  try {
    const r = await createStripe().createCardSession({ customerId: 'cus_1', orgId: 'org1', successUrl: 'https://app/x?session={CHECKOUT_SESSION_ID}', cancelUrl: 'https://app/y' });
    assert.equal(r.url, 'https://checkout.stripe.com/c/pay/cs_test_123456');
    const b = s.calls[0].body;
    assert.equal(b.mode, 'setup'); assert.equal(b.customer, 'cus_1'); assert.equal(b['metadata[orgId]'], 'org1'); assert.equal(b['metadata[purpose]'], 'onnhr_card');
    assert.equal(b.success_url, 'https://app/x?session={CHECKOUT_SESSION_ID}');
    assert.equal(b['payment_method_types[0]'], 'card');
    assert.ok(!('amount' in b));
  } finally { s.restore(); }
});

test('finishing the card page checks customer, company and completion before taking the card', async () => {
  const session = (over) => () => [200, { id: 'cs_test_abcdef', customer: 'cus_1', metadata: { orgId: 'org1' }, status: 'complete', setup_intent: { status: 'succeeded', payment_method: 'pm_123' }, ...over }];
  let s = stub({ 'GET /v1/checkout/sessions/cs_test_abcdef': session({}) });
  try { assert.deepEqual(await createStripe().finishCardSession({ sessionId: 'cs_test_abcdef', customerId: 'cus_1', orgId: 'org1' }), { paymentMethodId: 'pm_123' }); assert.match(s.calls[0].search, /expand/); } finally { s.restore(); }
  s = stub({ 'GET /v1/checkout/sessions/cs_test_abcdef': session({ metadata: { orgId: 'other' } }) });
  try { await assert.rejects(createStripe().finishCardSession({ sessionId: 'cs_test_abcdef', customerId: 'cus_1', orgId: 'org1' }), /another account/); } finally { s.restore(); }
  s = stub({ 'GET /v1/checkout/sessions/cs_test_abcdef': session({ customer: 'cus_2' }) });
  try { await assert.rejects(createStripe().finishCardSession({ sessionId: 'cs_test_abcdef', customerId: 'cus_1', orgId: 'org1' }), /another account/); } finally { s.restore(); }
  s = stub({ 'GET /v1/checkout/sessions/cs_test_abcdef': session({ status: 'open', setup_intent: { status: 'requires_payment_method' } }) });
  try { await assert.rejects(createStripe().finishCardSession({ sessionId: 'cs_test_abcdef', customerId: 'cus_1', orgId: 'org1' }), /not saved/); } finally { s.restore(); }
  await assert.rejects(createStripe().finishCardSession({ sessionId: '../../v1/customers', customerId: 'cus_1', orgId: 'org1' }), /not valid/);
});

test('saving a card already attached by the card page does not attach it twice, and makes it the default', async () => {
  const s = stub({
    'GET /v1/payment_methods/pm_123': () => [200, { id: 'pm_123', customer: 'cus_1', card: { brand: 'visa', last4: '4242' } }],
    'POST /v1/customers/cus_1': () => [200, { id: 'cus_1' }]
  });
  try {
    const r = await createStripe().attachPaymentMethod('cus_1', 'pm_123');
    assert.deepEqual(r, { id: 'pm_123', brand: 'visa', last4: '4242' });
    assert.ok(!s.calls.some((c) => c.key.endsWith('/attach')));
    assert.equal(s.calls.find((c) => c.key === 'POST /v1/customers/cus_1').body['invoice_settings[default_payment_method]'], 'pm_123');
  } finally { s.restore(); }
  const s2 = stub({ 'GET /v1/payment_methods/pm_9': () => [200, { id: 'pm_9', customer: 'cus_other', card: {} }] });
  try { await assert.rejects(createStripe().attachPaymentMethod('cus_1', 'pm_9'), /another customer/); } finally { s2.restore(); }
});

test('charging: the saved card off-session, a new idempotency key per attempt, declines come back as failed', async () => {
  let s = stub({ 'POST /v1/payment_intents': () => [200, { id: 'pi_1', status: 'succeeded' }] });
  try {
    const r = await createStripe().createPaymentIntent({ customerId: 'cus_1', amountCents: 4500, invoiceId: 'inv1', paymentMethodId: 'pm_123', attempt: 2 });
    assert.equal(r.status, 'succeeded');
    const c = s.calls[0];
    assert.equal(c.body.payment_method, 'pm_123'); assert.equal(c.body.off_session, 'true'); assert.equal(c.body.confirm, 'true'); assert.equal(c.body.amount, '4500');
    assert.equal(c.headers['Idempotency-Key'], 'pi-inv1-2');
  } finally { s.restore(); }
  s = stub({ 'POST /v1/payment_intents': () => [402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', payment_intent: { id: 'pi_2' } } }] });
  try { const r = await createStripe().createPaymentIntent({ customerId: 'cus_1', amountCents: 100, invoiceId: 'inv1', paymentMethodId: 'pm_1' }); assert.deepEqual([r.status, r.failureReason, r.id], ['failed', 'insufficient_funds', 'pi_2']); } finally { s.restore(); }
  s = stub({ 'POST /v1/payment_intents': () => [200, { id: 'pi_3', status: 'requires_action' }] });
  try { const r = await createStripe().createPaymentIntent({ customerId: 'cus_1', amountCents: 100, invoiceId: 'inv1', paymentMethodId: 'pm_1' }); assert.deepEqual([r.status, r.failureReason], ['failed', 'authentication_required']); } finally { s.restore(); }
  s = stub({ 'GET /v1/customers/cus_1': () => [200, { id: 'cus_1', invoice_settings: { default_payment_method: null } }] });
  try { const r = await createStripe().createPaymentIntent({ customerId: 'cus_1', amountCents: 100, invoiceId: 'inv1' }); assert.deepEqual([r.status, r.failureReason], ['failed', 'no_payment_method']); } finally { s.restore(); }
  s = stub({ 'POST /v1/payment_intents': () => [500, { error: { type: 'api_error', message: 'Stripe is down' } }] });
  try { await assert.rejects(createStripe().createPaymentIntent({ customerId: 'cus_1', amountCents: 100, invoiceId: 'inv1', paymentMethodId: 'pm_1' }), /Stripe is down/); } finally { s.restore(); }
});

test('Onn HR keeps plans and invoices itself: no Stripe subscription, price or invoice is created', async () => {
  const s = stub({});
  try {
    const st = createStripe();
    assert.match((await st.createSubscription({ customerId: 'cus_1', planId: 'starter' })).id, /^local_sub_/);
    assert.match((await st.createInvoice({ customerId: 'cus_1', amountCents: 100 })).id, /^local_in_/);
    await st.cancelSubscription('local_sub_x');
    assert.equal(s.calls.length, 0);
  } finally { s.restore(); }
});
