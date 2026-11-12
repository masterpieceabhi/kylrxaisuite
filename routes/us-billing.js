/**
 * Customer billing (owner only: billing.manage). Plan, usage, invoices, payment method.
 * Platform-operator views and the provider webhook live in routes/ops.js (not under the customer login).
 */
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit } = require('./us-hr').helpers;
const { requirePermission } = require('../services/permissions');
const S = require('../services/billing-service');
const R = require('../services/billing-rules');

router.use(verifyToken);

const guard = [requirePermission('billing.manage'), requireUsOrg];
const fail = (res, e) => res.status(e.statusCode || 500).json({ success: false, error: e.statusCode ? e.message : 'Billing request failed' });
const publicInvoice = (id, i) => ({
    id, number: i.number, kind: i.kind, status: i.status, period: i.period, planName: i.planName, interval: i.interval, headcount: i.headcount, lines: i.lines,
    subtotalCents: i.subtotalCents, taxCents: i.taxCents, creditAppliedCents: i.creditAppliedCents, totalCents: i.totalCents, issuedAt: i.issuedAt, paidAt: i.paidAt, attempts: i.attempts, lastFailureReason: i.lastFailureReason || null
});

router.get('/billing', ...guard, async (req, res) => {
    res.json({ success: true, billing: await S.summary(req.orgId) });
});

router.get('/billing/plans', ...guard, async (req, res) => {
    res.json({ success: true, data: (await S.loadPlans()).plans, note: 'Prices are set by the platform. Taxes are not calculated here.' });
});

router.post('/billing/subscribe', ...guard, async (req, res) => {
    try {
        const a = await S.subscribe(req.orgId, req.org, { planId: req.body.planId, interval: req.body.interval, includeContractors: req.body.includeContractors === true, by: req.user.id });
        audit(req.orgId, req, 'billing_subscribed', req.orgId, { planId: a.planId, interval: a.interval, state: a.state });
        res.status(201).json({ success: true, billing: await S.summary(req.orgId) });
    } catch (e) { fail(res, e); }
});

router.put('/billing/plan', ...guard, async (req, res) => {
    try {
        const r = await S.changePlan(req.orgId, { planId: req.body.planId, interval: req.body.interval, by: req.user.id });
        audit(req.orgId, req, 'billing_plan_changed', req.orgId, { from: r.previousPlanId, to: r.planId, netCents: r.proration ? r.proration.netCents : 0 });
        res.json({ success: true, result: r, billing: await S.summary(req.orgId) });
    } catch (e) { fail(res, e); }
});

router.put('/billing/settings', ...guard, async (req, res) => {
    if (typeof req.body.includeContractors !== 'boolean') return res.status(400).json({ success: false, error: 'includeContractors must be true or false' });
    if (!(await S.getAccount(req.orgId))) return res.status(409).json({ success: false, error: 'Start a subscription first' });
    await S.saveAccount(req.orgId, { includeContractors: req.body.includeContractors });
    audit(req.orgId, req, 'billing_settings_updated', req.orgId, { includeContractors: req.body.includeContractors });
    res.json({ success: true, billing: await S.summary(req.orgId) });
});

/** Mock mode accepts test tokens (pm_card_visa ...). With the real provider the browser collects the card and sends a pm_ id. */
router.post('/billing/payment-method', ...guard, async (req, res) => {
    const token = String(req.body.token || '');
    if (!/^pm_[A-Za-z0-9_]{2,80}$/.test(token)) return res.status(400).json({ success: false, error: 'A payment method token is required' });
    try {
        const pm = await S.setPaymentMethod(req.orgId, token);
        audit(req.orgId, req, 'billing_payment_method_updated', req.orgId, { brand: pm.brand, last4: pm.last4 });
        res.json({ success: true, paymentMethod: pm });
    } catch (e) { fail(res, e); }
});

/** Placeholder for the provider's hosted "update card" page (Stripe customer portal / setup session) */
router.get('/billing/payment-method-link', ...guard, async (req, res) => {
    res.json({ success: true, url: null, provider: require('../services/billing-stripe').getProvider().name, note: 'Placeholder: with the live provider this returns a one-time hosted page for updating the card. In mock mode use POST /billing/payment-method with a test token.' });
});

router.post('/billing/cancel', ...guard, async (req, res) => {
    if (req.body.confirm !== 'CANCEL') return res.status(400).json({ success: false, error: 'Send confirm: "CANCEL" to cancel the subscription' });
    try { await S.cancel(req.orgId, req.user.id); audit(req.orgId, req, 'billing_cancelled', req.orgId); res.json({ success: true, billing: await S.summary(req.orgId) }); } catch (e) { fail(res, e); }
});

router.get('/billing/invoices', ...guard, async (req, res) => {
    const snap = await S.invoices().where('orgId', '==', req.orgId).get();
    const rows = snap.docs.map((d) => publicInvoice(d.id, d.data())).sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
    res.json({ success: true, count: rows.length, data: rows.slice(0, 200) });
});

async function loadInvoice(req, res) {
    const snap = await S.invoices().doc(String(req.params.id)).get();
    const ok = (typeof snap.exists === 'function' ? snap.exists() : snap.exists) && snap.data().orgId === req.orgId;
    if (!ok) { res.status(404).json({ success: false, error: 'Invoice not found' }); return null; }
    return { id: snap.id, ...snap.data() };
}

router.get('/billing/invoices/:id', ...guard, async (req, res) => {
    const inv = await loadInvoice(req, res); if (!inv) return;
    res.json({ success: true, invoice: publicInvoice(inv.id, inv) });
});

router.get('/billing/invoices/:id/download', ...guard, async (req, res) => {
    const inv = await loadInvoice(req, res); if (!inv) return;
    audit(req.orgId, req, 'billing_invoice_downloaded', inv.id, { number: inv.number });
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="${inv.number}.html"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(S.renderInvoiceHtml(inv, req.org));
});

router.post('/billing/invoices/:id/pay', ...guard, async (req, res) => {
    const inv = await loadInvoice(req, res); if (!inv) return;
    if (inv.status === 'paid') return res.status(409).json({ success: false, error: 'This invoice is already paid' });
    try {
        const r = await S.chargeInvoice(req.orgId, inv.id);
        audit(req.orgId, req, 'billing_invoice_pay_attempt', inv.id, { paid: r.paid });
        res.status(r.paid ? 200 : 402).json({ success: r.paid, paid: r.paid, error: r.paid ? undefined : 'The payment did not go through. Update the payment method and try again.', billing: await S.summary(req.orgId) });
    } catch (e) { fail(res, e); }
});

router.get('/billing/status', ...guard, async (req, res) => {
    res.json({ success: true, ...(await S.getBillingState(req.orgId)), states: R.STATES });
});

module.exports = router;
