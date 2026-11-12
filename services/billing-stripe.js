/**
 * Payment provider adapter. BILLING_PROVIDER=mock (default) uses an in-memory fake that behaves like Stripe
 * for local testing; BILLING_PROVIDER=stripe calls the real Stripe REST API with STRIPE_SECRET_KEY
 * (written against the public API but NOT exercised here: it needs live test credentials).
 *
 * Interface (all async): createCustomer, attachPaymentMethod, createSubscription, updateSubscription,
 * cancelSubscription, createInvoice, createPaymentIntent, plus sync verifyWebhook(rawBody, signatureHeader).
 *
 * Webhook signature: Stripe scheme "t=<unix>,v1=<hex hmac-sha256 of `${t}.${rawBody}`>", 5 minute tolerance.
 * Secret: STRIPE_WEBHOOK_SECRET. Idempotency is handled by the caller (billing_events keyed by event id).
 */
const crypto = require('crypto');

const TOLERANCE_SECONDS = 300;

function signPayload(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
    const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    return `t=${timestamp},v1=${v1}`;
}

function verifySignature(payload, header, secret, opts = {}) {
    if (!secret) return { ok: false, reason: 'webhook secret not configured' };
    const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
    if (!parts.t || !parts.v1) return { ok: false, reason: 'missing signature' };
    const now = opts.now !== undefined ? opts.now : Math.floor(Date.now() / 1000);
    if (!Number.isFinite(Number(parts.t)) || Math.abs(now - Number(parts.t)) > (opts.tolerance || TOLERANCE_SECONDS)) return { ok: false, reason: 'timestamp outside tolerance' };
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${payload}`).digest('hex');
    const a = Buffer.from(expected); const b = Buffer.from(String(parts.v1));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature mismatch' };
    return { ok: true };
}

const rid = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;

/* ------------------------------------ mock ------------------------------------ */
function createMock() {
    const customers = new Map(); const subs = new Map(); const invoices = new Map(); const intents = new Map();
    const BRANDS = { pm_card_visa: ['visa', '4242'], pm_card_mastercard: ['mastercard', '4444'], pm_card_chargeDeclined: ['visa', '0002'], pm_fail: ['visa', '0341'] };
    return {
        name: 'mock',
        async createCustomer({ orgId, name, email }) { const c = { id: rid('cus'), orgId, name, email, paymentMethod: null }; customers.set(c.id, c); return { id: c.id }; },
        async attachPaymentMethod(customerId, token) {
            const c = customers.get(customerId); if (!c) throw new Error('No such customer');
            const known = BRANDS[token];
            if (!known) throw new Error('Unknown test payment method. Use pm_card_visa, pm_card_mastercard or pm_card_chargeDeclined');
            c.paymentMethod = { id: rid('pm'), token, brand: known[0], last4: known[1] };
            return { id: c.paymentMethod.id, brand: known[0], last4: known[1] };
        },
        async createSubscription({ customerId, planId, interval }) { const s = { id: rid('sub'), customerId, planId, interval, status: 'active' }; subs.set(s.id, s); return { id: s.id }; },
        async updateSubscription(id, patch) { const s = subs.get(id); if (!s) throw new Error('No such subscription'); Object.assign(s, patch); return { id }; },
        async cancelSubscription(id) { const s = subs.get(id); if (s) s.status = 'canceled'; return { id }; },
        async createInvoice({ customerId, amountCents, description }) { const i = { id: rid('in'), customerId, amountCents, description, status: 'open' }; invoices.set(i.id, i); return { id: i.id }; },
        async createPaymentIntent({ customerId, amountCents, invoiceId }) {
            const c = customers.get(customerId);
            const id = rid('pi');
            if (!c || !c.paymentMethod) { intents.set(id, 'requires_payment_method'); return { id, status: 'requires_payment_method', failureReason: 'no_payment_method' }; }
            const declined = ['pm_fail', 'pm_card_chargeDeclined'].includes(c.paymentMethod.token);
            const status = declined ? 'failed' : 'succeeded';
            intents.set(id, status);
            if (invoiceId && invoices.get(invoiceId) && !declined) invoices.get(invoiceId).status = 'paid';
            return { id, status, amountCents, failureReason: declined ? 'card_declined' : null };
        },
        verifyWebhook(rawBody, header) {
            const v = verifySignature(rawBody, header, process.env.STRIPE_WEBHOOK_SECRET);
            if (!v.ok) { const e = new Error(`Webhook signature invalid: ${v.reason}`); e.statusCode = 400; throw e; }
            return JSON.parse(rawBody);
        },
        _state: { customers, subs, invoices, intents }
    };
}

/* ------------------------------------ real Stripe (untested without credentials) ------------------------------------ */
function createStripe() {
    const key = process.env.STRIPE_SECRET_KEY;
    const form = (obj, prefix, out = []) => {
        for (const [k, v] of Object.entries(obj || {})) {
            if (v === undefined || v === null) continue;
            const name = prefix ? `${prefix}[${k}]` : k;
            if (typeof v === 'object') form(v, name, out); else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(v)}`);
        }
        return out;
    };
    async function call(method, path, body, idem) {
        if (!key) throw new Error('STRIPE_SECRET_KEY is not set');
        const res = await fetch(`https://api.stripe.com/v1${path}`, {
            method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', ...(idem ? { 'Idempotency-Key': idem } : {}) },
            body: body ? form(body).join('&') : undefined
        });
        const json = await res.json();
        if (!res.ok) throw new Error((json.error && json.error.message) || `Stripe error ${res.status}`);
        return json;
    }
    return {
        name: 'stripe',
        async createCustomer({ orgId, name, email }) { const c = await call('POST', '/customers', { name, email, metadata: { orgId } }); return { id: c.id }; },
        async attachPaymentMethod(customerId, pm) {
            await call('POST', `/payment_methods/${pm}/attach`, { customer: customerId });
            await call('POST', `/customers/${customerId}`, { invoice_settings: { default_payment_method: pm } });
            const m = await call('GET', `/payment_methods/${pm}`); return { id: m.id, brand: m.card && m.card.brand, last4: m.card && m.card.last4 };
        },
        async createSubscription({ customerId, priceId }) { const s = await call('POST', '/subscriptions', { customer: customerId, items: [{ price: priceId }] }); return { id: s.id }; },
        async updateSubscription(id, patch) { await call('POST', `/subscriptions/${id}`, patch); return { id }; },
        async cancelSubscription(id) { await call('DELETE', `/subscriptions/${id}`); return { id }; },
        async createInvoice({ customerId, amountCents, description }) {
            await call('POST', '/invoiceitems', { customer: customerId, amount: amountCents, currency: 'usd', description });
            const i = await call('POST', '/invoices', { customer: customerId, auto_advance: false }); return { id: i.id };
        },
        async createPaymentIntent({ customerId, amountCents, invoiceId }) {
            const p = await call('POST', '/payment_intents', { customer: customerId, amount: amountCents, currency: 'usd', confirm: true, off_session: true, metadata: { invoiceId } }, `pi-${invoiceId}`);
            return { id: p.id, status: p.status === 'succeeded' ? 'succeeded' : 'failed', amountCents, failureReason: p.last_payment_error && p.last_payment_error.code };
        },
        verifyWebhook(rawBody, header) {
            const v = verifySignature(rawBody, header, process.env.STRIPE_WEBHOOK_SECRET);
            if (!v.ok) { const e = new Error(`Webhook signature invalid: ${v.reason}`); e.statusCode = 400; throw e; }
            return JSON.parse(rawBody);
        }
    };
}

let instance = null;
function getProvider() {
    if (!instance) instance = String(process.env.BILLING_PROVIDER || 'mock').toLowerCase() === 'stripe' ? createStripe() : createMock();
    return instance;
}
const resetProvider = () => { instance = null; };

module.exports = { getProvider, resetProvider, signPayload, verifySignature, createMock, createStripe, TOLERANCE_SECONDS };
