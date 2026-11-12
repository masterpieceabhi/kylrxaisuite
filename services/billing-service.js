/**
 * Billing I/O: accounts, invoices, events in Firestore (billing_accounts, billing_invoices, billing_events),
 * the provider adapter, the billing cycle, dunning and webhooks. Pure math lives in billing-rules.js.
 *
 * Export for the rest of the app:  getBillingState(orgId) -> { state, readOnly, ... }
 * A suspended or cancelled company is READ-ONLY: routes may call `readOnlyGuard` (an Express middleware that
 * rejects writes with 402) when the owner decides to enforce it. Companies with no billing account are not locked.
 */
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const R = require('./billing-rules');
const { getProvider } = require('./billing-stripe');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const nowIso = () => new Date().toISOString();
const todayUtc = () => nowIso().slice(0, 10);

const accounts = () => rawCollection('billing_accounts');
const invoices = () => rawCollection('billing_invoices');
const events = () => rawCollection('billing_events');

/* ----------------------------- plan catalog (editable, global) ----------------------------- */
async function loadPlans({ includeInactive = false } = {}) {
    let plans = R.DEFAULT_PLANS;
    let dunning = R.DEFAULT_DUNNING;
    try {
        const snap = await rawCollection('system_config').doc('billing_plans').get();
        if (exists(snap)) { const d = snap.data(); if (Array.isArray(d.plans) && d.plans.length) plans = d.plans; if (d.dunning) dunning = { ...R.DEFAULT_DUNNING, ...d.dunning }; }
    } catch (e) { logger.warn(`Billing plan catalog read failed: ${e.message}`); }
    return { plans: includeInactive ? plans : plans.filter((p) => p.active !== false), dunning };
}

async function savePlans(plans, dunning, by) {
    const patch = { plans, updatedAt: nowIso(), updatedBy: by || null };
    if (dunning) patch.dunning = dunning;
    await rawCollection('system_config').doc('billing_plans').set(patch, { merge: true });
}

/* ----------------------------- account state ----------------------------- */
const stateCache = new Map();
const CACHE_MS = 15000;

async function getAccount(orgId) {
    const snap = await accounts().doc(orgId).get();
    return exists(snap) && snap.data().orgId === orgId ? { id: snap.id, ...snap.data() } : null;
}

async function saveAccount(orgId, patch) {
    stateCache.delete(orgId);
    await accounts().doc(orgId).set({ ...patch, orgId, updatedAt: nowIso() }, { merge: true });
}

/** For the whole app: is this company current, and is it read-only? Never throws. */
async function getBillingState(orgId) {
    const hit = stateCache.get(orgId);
    if (hit && hit.at > Date.now() - CACHE_MS) return hit.value;
    let value = { state: 'none', readOnly: false, planId: null };
    try {
        const a = await getAccount(orgId);
        if (a) value = { state: a.state, readOnly: R.isReadOnly(a.state), planId: a.planId, graceEndsAt: a.graceEndsAt || null, trialEndsAt: a.trialEndsAt || null };
    } catch (e) { logger.warn(`getBillingState failed for ${orgId}: ${e.message}`); }
    stateCache.set(orgId, { at: Date.now(), value });
    return value;
}

/** Express middleware to refuse writes (not GET/HEAD) for a read-only company. Opt-in. */
function readOnlyGuard(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const orgId = req.orgId || (req.user && req.user.orgId);
    if (!orgId) return next();
    getBillingState(orgId).then((s) => {
        if (!s.readOnly) return next();
        res.status(402).json({ success: false, error: 'This company account is read-only because of a billing problem. The owner can fix it in Billing.', billingState: s.state });
    }).catch(next);
}

/* ----------------------------- metering ----------------------------- */
async function headcountFor(orgId, includeContractors) {
    const snap = await rawCollection('users').where('orgId', '==', orgId).get();
    return R.countBillable(snap.docs.map((d) => d.data()), { includeContractors });
}

/* ----------------------------- events ----------------------------- */
async function logEvent(orgId, type, data = {}, id) {
    const ref = id ? events().doc(id) : events().doc();
    await ref.set({ orgId: orgId || null, type, receivedAt: nowIso(), ...data });
    return ref.id;
}

/* ----------------------------- subscribe / change / cancel ----------------------------- */
async function planById(id) { const { plans } = await loadPlans({ includeInactive: true }); return plans.find((p) => p.id === id) || null; }

async function ensureCustomer(orgId, org) {
    let a = await getAccount(orgId);
    if (a && a.providerCustomerId) return a;
    const c = await getProvider().createCustomer({ orgId, name: org.name || org.companyName || orgId, email: org.billingEmail || org.email || null });
    await saveAccount(orgId, { providerCustomerId: c.id });
    return { ...(a || {}), providerCustomerId: c.id };
}

async function subscribe(orgId, org, { planId, interval = 'monthly', includeContractors = false, by }) {
    const plan = await planById(planId);
    if (!plan || plan.active === false) throw Object.assign(new Error('Unknown or inactive plan'), { statusCode: 400 });
    if (!R.INTERVALS.includes(interval)) throw Object.assign(new Error('interval must be monthly or annual'), { statusCode: 400 });
    const existing = await getAccount(orgId);
    if (existing && existing.state !== 'cancelled') throw Object.assign(new Error('This company already has a subscription. Use change plan.'), { statusCode: 409 });
    const base = await ensureCustomer(orgId, org);
    const sub = await getProvider().createSubscription({ customerId: base.providerCustomerId, planId, interval });
    const today = todayUtc();
    const trialEndsAt = plan.trialDays > 0 && !(existing && existing.trialUsed) ? R.trialEnd(today, plan.trialDays) : null;
    const state = trialEndsAt ? 'trial' : 'past_due';
    const acct = {
        planId, interval, state, trialEndsAt, trialUsed: true, includeContractors: Boolean(includeContractors), providerSubscriptionId: sub.id,
        anchorDate: trialEndsAt || today, currentPeriodStart: today, currentPeriodEnd: trialEndsAt || today,
        creditCents: (existing && existing.creditCents) || 0, subscribedAt: nowIso(), subscribedBy: by || null, cancelledAt: null, firstFailedAt: null, graceEndsAt: null, dunningAttempts: 0
    };
    await saveAccount(orgId, acct);
    await logEvent(orgId, 'subscribed', { planId, interval, state });
    // No trial and no payment method yet: bill immediately later via the cycle; the page asks for a payment method.
    return getAccount(orgId);
}

async function setPaymentMethod(orgId, token) {
    const a = await getAccount(orgId);
    if (!a || !a.providerCustomerId) throw Object.assign(new Error('Start a subscription first'), { statusCode: 409 });
    let pm;
    try { pm = await getProvider().attachPaymentMethod(a.providerCustomerId, token); } catch (e) { throw Object.assign(new Error(e.message), { statusCode: 400 }); }
    await saveAccount(orgId, { paymentMethod: { brand: pm.brand, last4: pm.last4 }, paymentMethodUpdatedAt: nowIso() });
    await logEvent(orgId, 'payment_method_updated', { brand: pm.brand, last4: pm.last4 });
    return { brand: pm.brand, last4: pm.last4 };
}

async function nextInvoiceNumber(orgId) {
    const { db } = require('../config/firebase');
    const ref = accounts().doc(orgId);
    return db.runTransaction(async (tx) => {
        const s = await tx.get(ref); const n = ((s.exists && s.data().invoiceSeq) || 0) + 1;
        tx.set(ref, { invoiceSeq: n }, { merge: true });
        return `INV-${new Date().getUTCFullYear()}-${String(n).padStart(5, '0')}`;
    });
}

/** Creates an invoice record (+ provider invoice) and applies credits. Does not charge. */
async function createInvoice(orgId, account, { kind = 'cycle', period, headcount, adjustments = [], plan, interval, trial = false, taxRatePct = 0, fixedLines = null }) {
    const fixed = fixedLines ? fixedLines.reduce((t, l) => t + l.amountCents, 0) : null;
    const built = fixedLines ? { lines: fixedLines, subtotalCents: fixed, taxCents: 0, taxRatePct: 0, taxNote: 'Tax is a placeholder. Confirm sales tax handling with a US tax advisor.', creditAppliedCents: 0, totalCents: Math.max(0, fixed), negativeCreditCents: 0 } : R.buildInvoice({ plan, interval, headcount: headcount.billable, period: { ...period, snapshotDate: todayUtc() }, adjustments, creditAvailableCents: account.creditCents || 0, taxRatePct, trial });
    const number = await nextInvoiceNumber(orgId);
    const ref = invoices().doc();
    let providerInvoiceId = null;
    if (built.totalCents > 0) providerInvoiceId = (await getProvider().createInvoice({ customerId: account.providerCustomerId, amountCents: built.totalCents, description: `${plan.name} ${period.start}` })).id;
    const doc = {
        orgId, number, kind, period: { start: period.start, end: period.end }, planId: plan.id, planName: plan.name, interval,
        headcount: { employees: headcount.employees, contractors: headcount.contractors, billable: headcount.billable, snapshotDate: todayUtc(), includeContractors: headcount.includeContractors },
        lines: built.lines, subtotalCents: built.subtotalCents, taxCents: built.taxCents, taxRatePct: built.taxRatePct, taxNote: built.taxNote,
        creditAppliedCents: built.creditAppliedCents, totalCents: built.totalCents, currency: 'USD', providerInvoiceId,
        status: built.totalCents === 0 ? 'paid' : 'open', issuedAt: nowIso(), paidAt: built.totalCents === 0 ? nowIso() : null, attempts: 0
    };
    await ref.set(doc);
    const creditLeft = (account.creditCents || 0) - built.creditAppliedCents + built.negativeCreditCents;
    await saveAccount(orgId, { creditCents: creditLeft });
    return { id: ref.id, ...doc };
}

/** Attempts payment for an open invoice and moves the account state accordingly */
async function chargeInvoice(orgId, invoiceId, dunning, todayIso) {
    const iRef = invoices().doc(invoiceId);
    const iSnap = await iRef.get();
    if (!exists(iSnap) || iSnap.data().orgId !== orgId) throw Object.assign(new Error('Invoice not found'), { statusCode: 404 });
    const inv = iSnap.data();
    if (inv.status === 'paid') return { invoice: { id: invoiceId, ...inv }, paid: true, already: true };
    const account = await getAccount(orgId);
    const attempt = await getProvider().createPaymentIntent({ customerId: account.providerCustomerId, amountCents: inv.totalCents, invoiceId: inv.providerInvoiceId });
    const paid = attempt.status === 'succeeded';
    const patch = { attempts: (inv.attempts || 0) + 1, lastAttemptAt: nowIso(), paymentIntentId: attempt.id, lastFailureReason: paid ? null : (attempt.failureReason || 'failed') };
    if (paid) { patch.status = 'paid'; patch.paidAt = nowIso(); } else patch.status = 'open';
    await iRef.set(patch, { merge: true });
    const cfg = dunning || (await loadPlans()).dunning;
    const next = R.nextState(account, { type: paid ? 'payment_succeeded' : 'payment_failed' }, todayIso || nowIso(), cfg);
    await saveAccount(orgId, { state: next.state, firstFailedAt: next.firstFailedAt || null, graceEndsAt: next.graceEndsAt || null, dunningAttempts: next.dunningAttempts || 0 });
    await logEvent(orgId, paid ? 'payment_succeeded' : 'payment_failed', { invoiceId, number: inv.number, amountCents: inv.totalCents, reason: patch.lastFailureReason });
    return { invoice: { id: invoiceId, ...inv, ...patch }, paid };
}

async function changePlan(orgId, { planId, interval, by }) {
    const a = await getAccount(orgId);
    if (!a || a.state === 'cancelled') throw Object.assign(new Error('No active subscription'), { statusCode: 409 });
    if (R.isReadOnly(a.state)) throw Object.assign(new Error('Resolve the unpaid balance before changing plans'), { statusCode: 409 });
    const next = await planById(planId);
    if (!next || next.active === false) throw Object.assign(new Error('Unknown or inactive plan'), { statusCode: 400 });
    if (interval && !R.INTERVALS.includes(interval)) throw Object.assign(new Error('interval must be monthly or annual'), { statusCode: 400 });
    if (next.id === a.planId && (!interval || interval === a.interval)) throw Object.assign(new Error('Already on that plan'), { statusCode: 409 });
    const old = await planById(a.planId);
    const count = await headcountFor(orgId, a.includeContractors);
    const today = todayUtc();
    const result = { planId: next.id, previousPlanId: old && old.id };
    if (interval && interval !== a.interval) await saveAccount(orgId, { pendingInterval: interval }); // applies at the next renewal
    if (a.state === 'trial') {
        await saveAccount(orgId, { planId: next.id });
    } else if (a.currentPeriodStart && a.currentPeriodEnd && today < a.currentPeriodEnd) {
        const oldTotal = R.priceCycle(old, count.billable, a.interval).totalCents;
        const newTotal = R.priceCycle(next, count.billable, a.interval).totalCents;
        const pr = R.prorate(oldTotal, newTotal, a.currentPeriodStart, a.currentPeriodEnd, today);
        result.proration = pr;
        await saveAccount(orgId, { planId: next.id });
        const fresh = await getAccount(orgId);
        if (pr.netCents > 0) {
            const lines = [
                { key: 'proration_credit', description: `Unused time on ${old.name} (${pr.daysLeft} of ${pr.daysTotal} days)`, quantity: 1, unitCents: -pr.creditCents, amountCents: -pr.creditCents },
                { key: 'proration_charge', description: `${next.name} for the rest of the period (${pr.daysLeft} of ${pr.daysTotal} days)`, quantity: 1, unitCents: pr.chargeCents, amountCents: pr.chargeCents }
            ];
            const inv = await createInvoice(orgId, fresh, { kind: 'proration', period: { start: today, end: a.currentPeriodEnd }, headcount: count, plan: next, interval: a.interval, fixedLines: lines });
            result.invoiceId = inv.id;
            const charge = await chargeInvoice(orgId, inv.id);
            result.paid = charge.paid;
        } else if (pr.netCents < 0) {
            await saveAccount(orgId, { creditCents: (fresh.creditCents || 0) + (-pr.netCents) });
            result.creditedCents = -pr.netCents;
        }
    } else {
        await saveAccount(orgId, { planId: next.id });
    }
    if (a.providerSubscriptionId) await getProvider().updateSubscription(a.providerSubscriptionId, { planId: next.id }).catch((e) => logger.warn(`Provider plan update failed: ${e.message}`));
    await logEvent(orgId, 'plan_changed', { from: old && old.id, to: next.id, by: by || null, proration: result.proration || null });
    return result;
}

async function cancel(orgId, by) {
    const a = await getAccount(orgId);
    if (!a || a.state === 'cancelled') throw Object.assign(new Error('No active subscription'), { statusCode: 409 });
    if (a.providerSubscriptionId) await getProvider().cancelSubscription(a.providerSubscriptionId).catch((e) => logger.warn(`Provider cancel failed: ${e.message}`));
    await saveAccount(orgId, { state: 'cancelled', cancelledAt: nowIso(), cancelledBy: by || null });
    await logEvent(orgId, 'cancelled', { by: by || null });
}

/* ----------------------------- the cycle (run daily by the platform scheduler) ----------------------------- */
async function runCycle(todayIso = todayUtc(), { dryRun = false } = {}) {
    const { plans, dunning } = await loadPlans({ includeInactive: true });
    const snap = await accounts().get();
    const out = { today: todayIso, dryRun, invoiced: [], retried: [], suspended: [], reminded: [], errors: [] };
    for (const d of snap.docs) {
        let a = { id: d.id, ...d.data() };
        const orgId = a.orgId || d.id;
        try {
            if (a.state === 'past_due') {
                const act = R.dunningAction(a, todayIso, dunning);
                if (act.action === 'suspend') {
                    out.suspended.push(orgId);
                    if (!dryRun) { await saveAccount(orgId, { state: 'suspended', suspendedAt: nowIso() }); await logEvent(orgId, 'suspended', { reason: 'grace period over' }); }
                } else if (act.action === 'retry') {
                    out.retried.push(orgId);
                    if (!dryRun) {
                        const open = await invoices().where('orgId', '==', orgId).where('status', '==', 'open').get();
                        const first = open.docs.sort((x, y) => String(x.data().issuedAt).localeCompare(String(y.data().issuedAt)))[0];
                        if (first) await chargeInvoice(orgId, first.id, dunning, todayIso);
                    }
                } else if (act.remind) out.reminded.push(orgId);
                continue;
            }
            if (!R.invoiceDue(a, todayIso)) continue;
            const plan = plans.find((p) => p.id === a.planId);
            if (!plan) { out.errors.push({ orgId, error: 'plan missing' }); continue; }
            const wasTrial = a.state === 'trial';
            const interval = a.pendingInterval || a.interval;
            const period = R.periodFor(a.anchorDate || todayIso, interval, todayIso);
            const count = await headcountFor(orgId, a.includeContractors);
            out.invoiced.push({ orgId, planId: plan.id, headcount: count.billable, wasTrial, totalCents: R.buildInvoice({ plan, interval, headcount: count.billable, period, creditAvailableCents: a.creditCents || 0 }).totalCents });
            if (dryRun) continue;
            const org = await rawCollection('organizations').doc(orgId).get();
            const taxRatePct = exists(org) ? Number((org.data().billingTaxRatePct) || 0) : 0;
            await saveAccount(orgId, { interval, pendingInterval: null, currentPeriodStart: period.start, currentPeriodEnd: period.end, state: wasTrial ? 'active' : a.state });
            if (wasTrial) a = { ...a, ...(await getAccount(orgId)) };
            const inv = await createInvoice(orgId, await getAccount(orgId), { period, headcount: count, plan, interval, taxRatePct });
            if (inv.status !== 'paid') await chargeInvoice(orgId, inv.id, dunning, todayIso);
        } catch (e) { logger.error(`Billing cycle failed for ${orgId}: ${e.message}`); out.errors.push({ orgId, error: e.message }); }
    }
    return out;
}

/* ----------------------------- webhooks (idempotent) ----------------------------- */
async function accountForEvent(obj) {
    const orgId = obj && obj.metadata && obj.metadata.orgId;
    if (orgId) return getAccount(orgId);
    if (obj && obj.customer) {
        const q = await accounts().where('providerCustomerId', '==', obj.customer).limit(1).get();
        if (!q.empty) return { id: q.docs[0].id, ...q.docs[0].data() };
    }
    return null;
}

/** Returns { duplicate, handled, orgId }. Claims the event id first so a replay never applies twice. */
async function handleWebhookEvent(evt) {
    if (!evt || !evt.id || !evt.type) throw Object.assign(new Error('Malformed event'), { statusCode: 400 });
    const claim = events().doc(String(evt.id));
    try {
        await claim.create({ orgId: null, type: `webhook:${evt.type}`, eventId: evt.id, receivedAt: nowIso(), status: 'processing' });
    } catch (e) {
        if (e.code === 6 || /already exists/i.test(e.message)) return { duplicate: true };
        throw e;
    }
    try {
        const obj = evt.data && evt.data.object;
        const acct = await accountForEvent(obj);
        let handled = false;
        if (acct) {
            const orgId = acct.orgId || acct.id;
            const { dunning } = await loadPlans();
            if (evt.type === 'invoice.paid' || evt.type === 'invoice.payment_failed') {
                const paid = evt.type === 'invoice.paid';
                const q = obj.id ? await invoices().where('providerInvoiceId', '==', obj.id).limit(1).get() : { empty: true };
                if (!q.empty && q.docs[0].data().orgId === orgId) {
                    await q.docs[0].ref.set(paid ? { status: 'paid', paidAt: nowIso() } : { status: 'open', lastFailureReason: obj.failure_reason || 'payment_failed' }, { merge: true });
                }
                const next = R.nextState(acct, { type: paid ? 'payment_succeeded' : 'payment_failed' }, nowIso(), dunning);
                await saveAccount(orgId, { state: next.state, firstFailedAt: next.firstFailedAt || null, graceEndsAt: next.graceEndsAt || null, dunningAttempts: next.dunningAttempts || 0 });
                handled = true;
            } else if (evt.type === 'customer.subscription.deleted') {
                await saveAccount(orgId, { state: 'cancelled', cancelledAt: nowIso() }); handled = true;
            }
            await claim.set({ orgId, status: handled ? 'processed' : 'ignored', processedAt: nowIso() }, { merge: true });
            return { duplicate: false, handled, orgId };
        }
        await claim.set({ status: 'ignored', processedAt: nowIso(), note: 'no matching account' }, { merge: true });
        return { duplicate: false, handled: false };
    } catch (e) {
        await claim.delete().catch(() => {}); // let the provider retry
        throw e;
    }
}

/* ----------------------------- views ----------------------------- */
async function summary(orgId) {
    const a = await getAccount(orgId);
    const { plans } = await loadPlans();
    if (!a) return { subscribed: false, plans, state: 'none', readOnly: false };
    const plan = await planById(a.planId);
    const count = await headcountFor(orgId, a.includeContractors);
    const interval = a.pendingInterval || a.interval;
    return {
        subscribed: true, state: a.state, readOnly: R.isReadOnly(a.state), plan, interval, pendingInterval: a.pendingInterval || null, trialEndsAt: a.trialEndsAt || null,
        currentPeriodStart: a.currentPeriodStart, currentPeriodEnd: a.currentPeriodEnd, graceEndsAt: a.graceEndsAt || null, creditCents: a.creditCents || 0,
        paymentMethod: a.paymentMethod || null, includeContractors: Boolean(a.includeContractors),
        usage: { ...count, estimateNextCents: plan ? R.priceCycle(plan, count.billable, interval).totalCents : null },
        plans, provider: getProvider().name
    };
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Printable invoice (Save as PDF from the browser); no scripts, safe to open anywhere */
function renderInvoiceHtml(inv, org) {
    const rows = inv.lines.map((l) => `<tr><td>${esc(l.description)}</td><td class="n">${esc(l.quantity)}</td><td class="n">${R.money(l.unitCents)}</td><td class="n">${R.money(l.amountCents)}</td></tr>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${esc(inv.number)}</title><style>
body{font:14px/1.5 system-ui,Segoe UI,sans-serif;color:#0f172a;max-width:760px;margin:32px auto;padding:0 16px}h1{margin:0 0 4px}.m{color:#64748b}
table{width:100%;border-collapse:collapse;margin:20px 0}th,td{padding:8px;border-bottom:1px solid #e2e8f0;text-align:left}.n{text-align:right}th{font-size:12px;color:#64748b}
.t td{border:0}.tot td{font-weight:700;border-top:2px solid #0f172a}.badge{display:inline-block;padding:2px 10px;border-radius:99px;background:#eef2ff;font-weight:600}@media print{body{margin:0}}
</style></head><body><h1>Invoice ${esc(inv.number)}</h1><div class="m">Kylrx AI &middot; issued ${esc(String(inv.issuedAt).slice(0, 10))} &middot; <span class="badge">${esc(inv.status)}</span></div>
<p><strong>Billed to:</strong> ${esc(org.name || org.companyName || inv.orgId)}<br><span class="m">Period ${esc(inv.period.start)} to ${esc(inv.period.end)} &middot; ${esc(inv.planName)} (${esc(inv.interval)}) &middot; ${esc(inv.headcount.billable)} billable people on ${esc(inv.headcount.snapshotDate)}</span></p>
<table><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit</th><th class="n">Amount</th></tr></thead><tbody>${rows}
<tr class="t"><td colspan="3" class="n">Subtotal</td><td class="n">${R.money(inv.subtotalCents)}</td></tr>
<tr class="t"><td colspan="3" class="n">Tax${inv.taxRatePct ? ` (${esc(inv.taxRatePct)}%)` : ' (not calculated)'}</td><td class="n">${R.money(inv.taxCents)}</td></tr>
${inv.creditAppliedCents ? `<tr class="t"><td colspan="3" class="n">Account credit applied</td><td class="n">-${R.money(inv.creditAppliedCents).replace('-', '')}</td></tr>` : ''}
<tr class="tot"><td colspan="3" class="n">Total due</td><td class="n">${R.money(inv.totalCents)}</td></tr></tbody></table>
<p class="m">${esc(inv.taxNote || '')}</p></body></html>`;
}

/* ----------------------------- operator ----------------------------- */
async function platformSummary() {
    const snap = await accounts().get();
    const { plans } = await loadPlans({ includeInactive: true });
    const by = {}; let mrrCents = 0; const rows = [];
    for (const d of snap.docs) {
        const a = d.data();
        by[a.state] = (by[a.state] || 0) + 1;
        const plan = plans.find((p) => p.id === a.planId);
        let monthly = 0;
        if (plan && ['active', 'past_due'].includes(a.state)) {
            const count = await headcountFor(a.orgId || d.id, a.includeContractors);
            const price = R.priceCycle(plan, count.billable, a.interval).totalCents;
            monthly = a.interval === 'annual' ? Math.round(price / 12) : price; mrrCents += monthly;
            rows.push({ orgId: a.orgId || d.id, planId: a.planId, state: a.state, headcount: count.billable, monthlyCents: monthly, creditCents: a.creditCents || 0, graceEndsAt: a.graceEndsAt || null });
        } else rows.push({ orgId: a.orgId || d.id, planId: a.planId, state: a.state, headcount: null, monthlyCents: 0, creditCents: a.creditCents || 0, graceEndsAt: a.graceEndsAt || null });
    }
    return { accounts: snap.size, byState: by, mrrCents, arrCents: mrrCents * 12, atRisk: rows.filter((r) => ['past_due', 'suspended'].includes(r.state)), rows };
}

module.exports = {
    loadPlans, savePlans, getAccount, saveAccount, getBillingState, readOnlyGuard, headcountFor, subscribe, setPaymentMethod, changePlan, cancel,
    createInvoice, chargeInvoice, runCycle, handleWebhookEvent, summary, renderInvoiceHtml, platformSummary, planById, logEvent, invoices, events, accounts
};
