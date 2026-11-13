/**
 * Gusto webhooks.
 *  - subscribe: POST /v1/webhook_subscriptions (system token); Gusto then posts a verification_token to our URL and we
 *    confirm with PUT .../verify. The token is only trusted after Gusto accepts it, then stored encrypted.
 *  - receive: verify X-Gusto-Signature (HMAC-SHA256 of the raw body, timing-safe), acknowledge at once, queue the event.
 *    Deduplicated by event uuid, so Gusto's retries (up to 16 over 3 days) and our Events API poll are harmless.
 *  - process: asynchronous, idempotent, with our own retry schedule.
 *  - pollEvents: Events API backstop (cursor starting_after_uuid) for anything missed.
 */
const rules = require('./rules');
const onboarding = require('./onboarding');
const payroll = require('./payroll');
const { GustoError } = require('./client');

const SUBSCRIPTION_TYPES = ['Company', 'Employee', 'Payroll', 'Form', 'Document', 'TimeOffRequest', 'Notifications'];
const nowIso = () => new Date().toISOString();
const errMessage = (e) => (e && e.message ? String(e.message).slice(0, 300) : 'Unknown error');
const webhookState = (ctx) => (ctx.conn && ctx.conn.webhook) || {};

async function refreshConn(ctx) { ctx.conn = await ctx.store.getConnection(ctx.orgId); return ctx.conn; }
async function patchWebhook(ctx, patch) { await ctx.store.saveConnection(ctx.orgId, { webhook: patch }); await refreshConn(ctx); }

/* ------------------------------- subscription ------------------------------- */

function urlFor(ctx, publicBaseUrl) {
    const base = String(publicBaseUrl || ctx.opts.publicBaseUrl || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) throw new GustoError('Set PUBLIC_BASE_URL (the address Gusto can reach this server at) or send publicBaseUrl', { status: 400, code: 'validation' });
    if (ctx.opts.mode !== 'mock' && !/^https:\/\//.test(base)) throw new GustoError('Gusto needs an https:// address for webhooks', { status: 400, code: 'validation' });
    return `${base}/api/webhooks/gusto/${ctx.orgId}`;
}

/** Ask Gusto to confirm a verification token; only a token Gusto accepts is stored. */
async function verifyWithGusto(ctx, token) {
    const w = webhookState(ctx);
    if (!w.subscriptionUuid) return { verified: false, reason: 'subscription_not_saved_yet' };
    try {
        await ctx.client.put(`/v1/webhook_subscriptions/${w.subscriptionUuid}/verify`, { verification_token: token }, { as: 'system' });
    } catch (e) {
        await ctx.store.clearPendingVerificationToken(ctx.orgId);
        await ctx.store.logError(ctx.orgId, { scope: 'webhook', ref: 'verify', code: e.code || 'error', message: `Gusto did not accept the verification token: ${errMessage(e)}` });
        return { verified: false, reason: 'rejected' };
    }
    await ctx.store.saveVerificationToken(ctx.orgId, token);
    await ctx.store.clearPendingVerificationToken(ctx.orgId);
    await patchWebhook(ctx, { status: 'verified', verifiedAt: nowIso() });
    await ctx.store.resolveErrors(ctx.orgId, 'webhook', 'verify');
    return { verified: true };
}

async function subscribe(ctx, { publicBaseUrl, types } = {}) {
    const url = urlFor(ctx, publicBaseUrl);
    const subscriptionTypes = (types && types.length ? types : SUBSCRIPTION_TYPES);
    // mark pending BEFORE calling Gusto: the handshake can arrive before the response does
    await ctx.store.clearPendingVerificationToken(ctx.orgId);
    await patchWebhook(ctx, { status: 'pending', url, types: subscriptionTypes, startedAt: nowIso(), subscriptionUuid: null });
    const s = await ctx.client.post('/v1/webhook_subscriptions', { url, subscription_types: subscriptionTypes }, { as: 'system' });
    await patchWebhook(ctx, { subscriptionUuid: s.uuid, status: s.status === 'verified' ? 'verified' : 'pending' });
    const pending = await ctx.store.getPendingVerificationToken(ctx.orgId);
    if (pending) await verifyWithGusto(ctx, pending);
    return { subscriptionUuid: s.uuid, url, status: webhookState(ctx).status };
}

/* ------------------------------- receiving ------------------------------- */

const isHandshake = (b) => b && b.verification_token && (!b.uuid || /verif/i.test(String(b.event_type || '')));

/**
 * Handle one inbound webhook. Returns { status, body } for the route to send. Never throws on bad input.
 * `rawBody` is the exact request body (Buffer). `deps` supplies makeContext for async processing.
 */
async function receive(orgId, rawBody, headers, deps) {
    const store = deps.store;
    const conn = await store.getConnection(orgId);
    if (!conn || !conn.companyUuid) return { status: 404, body: { success: false } };
    let evt;
    try { evt = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody)); } catch (_) { return { status: 400, body: { success: false, error: 'Body is not JSON' } }; }
    if (!evt || typeof evt !== 'object') return { status: 400, body: { success: false, error: 'Body is not an object' } };

    const w = conn.webhook || {};
    if (isHandshake(evt) && !headers['x-gusto-signature']) {
        if (w.status !== 'pending') return { status: 200, body: { success: true, ignored: true } };
        await store.savePendingVerificationToken(orgId, String(evt.verification_token));
        const ctx = await deps.makeContext(orgId);
        if (webhookState(ctx).subscriptionUuid) await verifyWithGusto(ctx, String(evt.verification_token)).catch(() => {}); // re-read after saving: subscribe() may have stored the uuid in between
        return { status: 200, body: { success: true, handshake: true } };
    }

    const token = await store.getVerificationToken(orgId);
    const sigOk = token && rules.verifySignature(rawBody, token, headers['x-gusto-signature']);
    if (!sigOk) {
        await store.saveConnection(orgId, { webhook: { rejectedCount: ((w.rejectedCount) || 0) + 1, lastRejectedAt: nowIso() } });
        return { status: 401, body: { success: false, error: 'Invalid signature' } };
    }
    if (evt.company_uuid && evt.company_uuid !== conn.companyUuid) return { status: 200, body: { success: true, ignored: true } }; // another company's event on a shared subscription
    const key = rules.eventKey(evt);
    const isNew = await store.putEventIfNew(orgId, key, evt, 'webhook');
    await store.saveConnection(orgId, { webhook: { lastReceivedAt: nowIso(), receivedCount: ((w.receivedCount) || 0) + (isNew ? 1 : 0) } });
    if (!isNew) return { status: 200, body: { success: true, duplicate: true } };
    setImmediate(() => { deps.makeContext(orgId).then((ctx) => processEvent(ctx, key)).catch(() => {}); });
    return { status: 200, body: { success: true } };
}

/* ------------------------------- processing ------------------------------- */

async function handle(ctx, evt) {
    const kind = rules.classifyEvent(evt);
    const type = String(evt.event_type || '').toLowerCase();
    if (kind === 'company') {
        if (type === 'company.approved') { await onboarding.markApproved(ctx); await refreshConn(ctx); }
        return { handled: type };
    }
    if (kind === 'payroll') {
        const uuid = evt.resource_uuid || evt.entity_uuid;
        const rec = uuid ? await ctx.store.getPayroll(ctx.orgId, uuid) : null;
        if (rec) await payroll.refreshPayroll(ctx, uuid);
        return { handled: type, known: Boolean(rec) };
    }
    if (kind === 'employee') {
        const uuid = evt.resource_uuid || evt.entity_uuid;
        const link = uuid ? (await ctx.store.listLinks(ctx.orgId, 'employee')).find((l) => l.gustoUuid === uuid) : null;
        if (link) {
            const g = await ctx.client.get(`/v1/employees/${uuid}`);
            const mapping = require('./mapping');
            const info = mapping.fromGustoEmployee(g);
            await ctx.store.saveLink(ctx.orgId, 'employee', link.ourId, { version: info.version, gusto: { onboarded: info.onboarded, onboardingStatus: info.onboardingStatus, terminated: info.terminated, rate: info.rate, paymentUnit: info.paymentUnit }, lastPulledAt: nowIso() });
        }
        return { handled: type, known: Boolean(link) };
    }
    return { handled: type, note: 'recorded only' };
}

/** Process one queued event. Safe to call repeatedly: already-processed events are left alone. */
async function processEvent(ctx, key) {
    const rec = await ctx.store.getEvent(ctx.orgId, key);
    if (!rec || rec.status === 'processed' || rec.status === 'dead') return { skipped: true };
    await ctx.store.updateEvent(ctx.orgId, key, { status: 'processing', startedAt: nowIso() });
    try {
        const out = await handle(ctx, rec.event);
        await ctx.store.updateEvent(ctx.orgId, key, { status: 'processed', processedAt: nowIso(), attempts: (rec.attempts || 0) + 1, result: out, lastError: null });
        await ctx.store.resolveErrors(ctx.orgId, 'webhook', key);
        return { processed: true, ...out };
    } catch (e) {
        const attempts = (rec.attempts || 0) + 1;
        const delay = rules.processRetryDelayMs(attempts);
        await ctx.store.updateEvent(ctx.orgId, key, { status: delay === null ? 'dead' : 'failed', attempts, lastError: errMessage(e), nextAttemptAt: delay === null ? null : new Date(Date.now() + delay).toISOString() });
        await ctx.store.logError(ctx.orgId, { scope: 'webhook', ref: key, code: e.code || 'error', message: `Could not process ${rec.event && rec.event.event_type}: ${errMessage(e)}` });
        return { processed: false, error: errMessage(e) };
    }
}

/** Retry anything stuck or failed whose time has come */
async function processPending(ctx, { limit = 50, force = false } = {}) {
    const now = Date.now();
    const rows = (await ctx.store.listEvents(ctx.orgId)).filter((e) => (e.status === 'received' && now - Date.parse(e.receivedAt) > 5000) || (e.status === 'failed' && (force || Date.parse(e.nextAttemptAt) <= now)) || (e.status === 'processing' && now - Date.parse(e.startedAt || e.receivedAt) > 120000));
    let done = 0;
    for (const e of rows.slice(0, limit)) { const r = await processEvent(ctx, e.key); if (r.processed) done += 1; }
    return { tried: Math.min(rows.length, limit), processed: done };
}

/* ------------------------------- Events API backstop ------------------------------- */

async function pollEvents(ctx, { maxPages = 5 } = {}) {
    const c = ctx.conn.companyUuid;
    if (!c) throw new GustoError('This company is not connected to Gusto', { status: 409, code: 'not_connected' });
    let cursor = webhookState(ctx).lastEventUuid || null;
    let fetched = 0; let added = 0;
    for (let page = 0; page < maxPages; page += 1) {
        const rows = await ctx.client.get('/v1/events', { query: { starting_after_uuid: cursor, limit: 100, company_uuid: c } });
        if (!Array.isArray(rows) || !rows.length) break;
        for (const evt of rows) {
            fetched += 1;
            const isNew = await ctx.store.putEventIfNew(ctx.orgId, rules.eventKey(evt), evt, 'poll');
            if (isNew) { added += 1; await processEvent(ctx, rules.eventKey(evt)); }
            cursor = evt.uuid || cursor;
        }
        if (rows.length < 100) break;
    }
    await patchWebhook(ctx, { lastEventUuid: cursor, lastPollAt: nowIso() });
    const retried = await processPending(ctx);
    return { fetched, added, retried };
}

/* ------------------------------- health ------------------------------- */

async function health(ctx) {
    await refreshConn(ctx);
    const w = webhookState(ctx);
    const events = await ctx.store.listEvents(ctx.orgId);
    const count = (s) => events.filter((e) => e.status === s).length;
    return {
        subscription: { status: w.status || 'none', url: w.url || null, types: w.types || [], subscriptionUuid: w.subscriptionUuid || null, verifiedAt: w.verifiedAt || null },
        lastReceivedAt: w.lastReceivedAt || null, lastPollAt: w.lastPollAt || null, rejectedSignatures: w.rejectedCount || 0, lastRejectedAt: w.lastRejectedAt || null,
        counts: { total: events.length, received: count('received'), processing: count('processing'), processed: count('processed'), failed: count('failed'), dead: count('dead') },
        healthy: w.status === 'verified' && !count('failed') && !count('dead'),
        recent: events.slice(0, 15).map((e) => ({ key: e.key, type: e.event && e.event.event_type, status: e.status, source: e.source, receivedAt: e.receivedAt, attempts: e.attempts, lastError: e.lastError || null }))
    };
}

/* ------------------------------- background job ------------------------------- */

/** Poll every connected company on a timer. Off unless GUSTO_POLL_JOB=on (see routes/us-gusto.js). */
function startPollJob({ makeContext, store, intervalMs = 5 * 60 * 1000, log = console }) {
    const timer = setInterval(async () => {
        try {
            for (const orgId of await store.listConnectedOrgIds()) {
                try { await pollEvents(await makeContext(orgId)); } catch (e) { log.warn && log.warn(`gusto poll failed for ${orgId}: ${errMessage(e)}`); }
            }
        } catch (e) { log.warn && log.warn(`gusto poll job: ${errMessage(e)}`); }
    }, intervalMs);
    if (timer.unref) timer.unref();
    return () => clearInterval(timer);
}

module.exports = { SUBSCRIPTION_TYPES, subscribe, verifyWithGusto, receive, processEvent, processPending, pollEvents, health, startPollJob, urlFor };
