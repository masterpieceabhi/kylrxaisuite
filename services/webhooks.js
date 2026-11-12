/**
 * Outbound webhooks: endpoints, signing, delivery worker with exponential backoff, dead-letter
 * queue, replay, secret rotation. Pure helpers are exported for tests; I/O uses Firestore.
 *
 * Collections (every doc has orgId): webhook_endpoints, webhook_deliveries, event_outbox.
 *
 * Signature header:  X-Kylrx-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex of previous secret>]
 *   v1 = HMAC-SHA256(secret, `${t}.${rawBody}`)
 * Receivers must reject timestamps older than 5 minutes and compare in constant time.
 */
const crypto = require('crypto');
const dns = require('dns').promises;
const { rawCollection } = require('../config/firebase');
const { encryptField, decryptField } = require('./pii-crypto');
const ssrf = require('./ssrf');
const { matchesEvent, buildEvent } = require('./events');

const MAX_ATTEMPTS = 10;
/** Delay after attempt n (1-based) fails: 30s, 2m, 10m, 1h, 4h, 8h, 16h, 24h, 24h => about 3.2 days across 10 attempts */
const DELAYS_MS = [30e3, 120e3, 600e3, 3600e3, 4 * 3600e3, 8 * 3600e3, 16 * 3600e3, 24 * 3600e3, 24 * 3600e3];
const PREVIOUS_SECRET_GRACE_MS = 24 * 3600e3;
const TIMEOUT_MS = 10000;

const scale = () => { const s = Number(process.env.WEBHOOK_BACKOFF_SCALE); return Number.isFinite(s) && s > 0 ? s : 1; };
const nextDelayMs = (attemptsDone) => (attemptsDone >= MAX_ATTEMPTS ? null : Math.round(DELAYS_MS[Math.min(attemptsDone, DELAYS_MS.length) - 1] * scale()));

/* -------------------------------- signing -------------------------------- */

const hmac = (secret, ts, body) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

function signatureHeader(secrets, body, nowSec = Math.floor(Date.now() / 1000)) {
    const list = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
    return `t=${nowSec},${list.map((s) => `v1=${hmac(s, nowSec, body)}`).join(',')}`;
}

/** Receiver-side check (also used by tests and the developer docs) */
function verifySignature(header, body, secret, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
    const parts = String(header || '').split(',').map((p) => p.trim());
    const t = (parts.find((p) => p.startsWith('t=')) || '').slice(2);
    const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
    if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
    if (Math.abs(nowSec - Number(t)) > toleranceSec) return false;
    const expected = Buffer.from(hmac(secret, t, body), 'hex');
    return sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
}

const newSecret = () => `whsec_${crypto.randomBytes(32).toString('base64url')}`;

/* ------------------------------- endpoints ------------------------------- */

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);

async function checkResolvable(url) {
    const v = ssrf.validateUrl(url);
    if (!v.ok) return v.error;
    const host = v.url.hostname.replace(/^\[|\]$/g, '');
    if (require('net').isIP(host)) return null;
    try {
        const addrs = await dns.lookup(host, { all: true });
        const lb = ssrf.loopbackAllowed();
        if (addrs.some((a) => ssrf.isPrivateIp(a.address) && !(lb && ssrf.isLoopback(a.address)))) return 'url resolves to a private or reserved address';
    } catch (_) {
        return 'url host name could not be resolved';
    }
    return null;
}

function publicEndpoint(id, e) {
    return {
        id, url: e.url, description: e.description || '', events: e.events || [], active: e.active !== false, source: e.source || 'admin',
        secret_last4: e.secretLast4 || null, previous_secret_expires_at: e.secretPrev ? e.secretPrev.expiresAt : null,
        created_at: e.createdAt, last_success_at: e.lastSuccessAt || null, last_failure_at: e.lastFailureAt || null, consecutive_failures: e.failureCount || 0
    };
}

function validateEventFilters(events) {
    if (events === undefined) return { value: ['*'] };
    if (!Array.isArray(events) || events.some((e) => typeof e !== 'string' || !/^(\*|[a-z][a-z0-9_]*(\.[a-z0-9_]+)*(\.\*)?)$/.test(e))) return { error: 'events must be a list such as ["person.*","leave.approved"]' };
    return { value: events.length ? events : ['*'] };
}

async function createEndpoint(orgId, { url, description, events, source }, actor) {
    const urlErr = await checkResolvable(url);
    if (urlErr) return { errors: [urlErr] };
    const f = validateEventFilters(events);
    if (f.error) return { errors: [f.error] };
    const ref = rawCollection('webhook_endpoints').doc();
    const secret = newSecret();
    const doc = {
        orgId, url: String(url), description: String(description || '').slice(0, 200), events: f.value, active: true, source: source || 'admin',
        secretEnc: encryptField(secret, `${orgId}:wh:${ref.id}`), secretLast4: secret.slice(-4), secretPrev: null,
        createdAt: new Date().toISOString(), createdBy: actor || null, failureCount: 0
    };
    await ref.set(doc);
    return { endpoint: publicEndpoint(ref.id, doc), secret, id: ref.id };
}

async function loadEndpoint(orgId, id) {
    const snap = await rawCollection('webhook_endpoints').doc(String(id)).get();
    if (!exists(snap) || snap.data().orgId !== orgId) return null;
    return { id: snap.id, ref: snap.ref, data: snap.data() };
}

async function listEndpoints(orgId) {
    const snap = await rawCollection('webhook_endpoints').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => publicEndpoint(d.id, d.data())).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function updateEndpoint(orgId, id, body) {
    const ep = await loadEndpoint(orgId, id);
    if (!ep) return { notFound: true };
    const patch = {};
    if (body.url !== undefined) { const e = await checkResolvable(body.url); if (e) return { errors: [e] }; patch.url = String(body.url); }
    if (body.events !== undefined) { const f = validateEventFilters(body.events); if (f.error) return { errors: [f.error] }; patch.events = f.value; }
    if (body.description !== undefined) patch.description = String(body.description).slice(0, 200);
    if (body.active !== undefined) { patch.active = Boolean(body.active); if (patch.active) patch.failureCount = 0; }
    await ep.ref.update(patch);
    return { endpoint: publicEndpoint(id, { ...ep.data, ...patch }) };
}

async function rotateSecret(orgId, id) {
    const ep = await loadEndpoint(orgId, id);
    if (!ep) return { notFound: true };
    const secret = newSecret();
    const patch = {
        secretEnc: encryptField(secret, `${orgId}:wh:${id}`), secretLast4: secret.slice(-4),
        secretPrev: ep.data.secretEnc ? { enc: ep.data.secretEnc, expiresAt: new Date(Date.now() + PREVIOUS_SECRET_GRACE_MS).toISOString() } : null
    };
    await ep.ref.update(patch);
    return { secret, previous_secret_expires_at: patch.secretPrev && patch.secretPrev.expiresAt };
}

async function deleteEndpoint(orgId, id) {
    const ep = await loadEndpoint(orgId, id);
    if (!ep) return false;
    await ep.ref.delete();
    return true;
}

/** Plain secrets to sign with: current, plus the previous one during its grace period */
function activeSecrets(orgId, id, e, now = Date.now()) {
    const out = [decryptField(e.secretEnc, `${orgId}:wh:${id}`)];
    if (e.secretPrev && e.secretPrev.enc && new Date(e.secretPrev.expiresAt).getTime() > now) out.push(decryptField(e.secretPrev.enc, `${orgId}:wh:${id}`));
    return out;
}

/* ------------------------------- deliveries ------------------------------- */

const publicDelivery = (id, d) => ({
    id, endpoint_id: d.endpointId, event_id: d.eventId, event_type: d.eventType, status: d.status, attempts: d.attempts,
    next_attempt_at: d.status === 'pending' ? d.nextAttemptAt : null, last_status_code: d.lastStatus || null, last_error: d.lastError || null,
    created_at: d.createdAt, delivered_at: d.deliveredAt || null, replay_of: d.replayOf || null, attempt_log: d.attemptLog || []
});

async function enqueue(orgId, endpointId, event, extra = {}) {
    const ref = rawCollection('webhook_deliveries').doc();
    const nowIso = new Date().toISOString();
    await ref.set({
        orgId, endpointId, eventId: event.id, eventType: event.type, body: JSON.stringify(event), status: 'pending', attempts: 0,
        nextAttemptAt: nowIso, createdAt: nowIso, attemptLog: [], ...extra
    });
    return ref.id;
}

/** Stores the outbox event's deliveries (one per matching active endpoint) */
async function fanOut(orgId, event) {
    const snap = await rawCollection('webhook_endpoints').where('orgId', '==', orgId).get();
    const targets = snap.docs.filter((d) => d.data().active !== false && matchesEvent(d.data().events, event.type));
    for (const d of targets) await enqueue(orgId, d.id, event);
    return targets.length;
}

/** One delivery attempt; updates the delivery document */
async function attempt(deliveryId) {
    const ref = rawCollection('webhook_deliveries').doc(deliveryId);
    const snap = await ref.get();
    if (!exists(snap)) return null;
    const d = snap.data();
    if (d.status !== 'pending') return d;
    const ep = await loadEndpoint(d.orgId, d.endpointId);
    const attemptsNow = d.attempts + 1;
    const log = { at: new Date().toISOString(), attempt: attemptsNow };
    let ok = false; let status = null; let error = null;
    if (!ep || ep.data.active === false) {
        error = ep ? 'endpoint is disabled' : 'endpoint was deleted';
    } else {
        try {
            const sig = signatureHeader(activeSecrets(d.orgId, ep.id, ep.data), d.body);
            const res = await ssrf.safeRequest({
                url: ep.data.url, method: 'POST', body: d.body, timeoutMs: TIMEOUT_MS,
                headers: {
                    'Content-Type': 'application/json', 'User-Agent': 'Kylrx-Webhooks/1', 'X-Kylrx-Signature': sig, 'X-Kylrx-Event': d.eventType,
                    'X-Kylrx-Event-Id': d.eventId, 'X-Kylrx-Delivery': deliveryId, 'X-Kylrx-Attempt': String(attemptsNow)
                }
            });
            status = res.status; log.ms = res.ms;
            ok = res.status >= 200 && res.status < 300;
            if (!ok) error = res.redirected ? `redirect (${res.status}) not followed` : `HTTP ${res.status}`;
        } catch (e) {
            error = e.code === 'SSRF_BLOCKED' ? e.message : (e.code || e.message || 'network error');
        }
    }
    log.status = status; log.error = error; log.ok = ok;
    const attemptLog = [...(d.attemptLog || []), log].slice(-10);
    const patch = { attempts: attemptsNow, lastStatus: status, lastError: error, attemptLog };
    if (ok) { patch.status = 'delivered'; patch.deliveredAt = log.at; }
    else if (!ep || attemptsNow >= MAX_ATTEMPTS) { patch.status = 'dead'; patch.deadAt = log.at; }
    else { patch.nextAttemptAt = new Date(Date.now() + nextDelayMs(attemptsNow)).toISOString(); }
    patch.claimedUntil = null;
    await ref.update(patch);
    if (ep) {
        await ep.ref.update(ok ? { lastSuccessAt: log.at, failureCount: 0 } : { lastFailureAt: log.at, failureCount: (ep.data.failureCount || 0) + 1 }).catch(() => {});
    }
    return { ...d, ...patch };
}

/** Delivers everything that is due. Claims each delivery first so two workers do not double-send. */
async function processDue(limit = 50) {
    const snap = await rawCollection('webhook_deliveries').where('status', '==', 'pending').limit(500).get();
    const nowMs = Date.now();
    const due = snap.docs.filter((d) => new Date(d.data().nextAttemptAt).getTime() <= nowMs && (!d.data().claimedUntil || new Date(d.data().claimedUntil).getTime() < nowMs)).slice(0, limit);
    let sent = 0;
    for (const doc of due) {
        try {
            await rawCollection('webhook_deliveries').doc(doc.id).update({ claimedUntil: new Date(nowMs + TIMEOUT_MS * 2).toISOString() });
            await attempt(doc.id);
            sent += 1;
        } catch (_) { /* next tick retries */ }
    }
    return sent;
}

/** Moves outbox events to webhook deliveries and event-driven connectors */
async function processOutbox(limit = 50) {
    const snap = await rawCollection('event_outbox').where('status', '==', 'pending').limit(limit).get();
    let n = 0;
    for (const doc of snap.docs) {
        const { orgId, event } = doc.data();
        try {
            await fanOut(orgId, event);
            try { await require('./connectors/runtime').handleEvent(orgId, event); } catch (_) { /* connector errors are logged in their own runs */ }
            await doc.ref.update({ status: 'dispatched', dispatchedAt: new Date().toISOString() });
            n += 1;
        } catch (e) {
            await doc.ref.update({ attempts: (doc.data().attempts || 0) + 1, lastError: String(e.message).slice(0, 200) }).catch(() => {});
        }
    }
    return n;
}

let running = false; let timer = null; let again = false;
async function tick() {
    if (running) { again = true; return; }
    running = true;
    try { await processOutbox(); await processDue(); } catch (_) { /* logged by caller state */ } finally {
        running = false;
        if (again) { again = false; setImmediate(tick); }
    }
}
/** Called by emit() after it writes to the outbox */
function kick() { if (timer) setImmediate(tick); }

function start({ intervalMs = 5000 } = {}) {
    if (timer) return;
    timer = setInterval(tick, intervalMs);
    if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }

async function replay(orgId, deliveryId) {
    const snap = await rawCollection('webhook_deliveries').doc(String(deliveryId)).get();
    if (!exists(snap) || snap.data().orgId !== orgId) return null;
    const d = snap.data();
    return enqueue(orgId, d.endpointId, JSON.parse(d.body), { replayOf: deliveryId });
}

async function replayDeadLetters(orgId, endpointId) {
    const snap = await rawCollection('webhook_deliveries').where('orgId', '==', orgId).where('status', '==', 'dead').get();
    let n = 0;
    for (const d of snap.docs) {
        if (endpointId && d.data().endpointId !== endpointId) continue;
        await enqueue(orgId, d.data().endpointId, JSON.parse(d.data().body), { replayOf: d.id });
        await d.ref.update({ status: 'dead_replayed' });
        n += 1;
    }
    return n;
}

async function listDeliveries(orgId, { endpointId, status, limit = 100 } = {}) {
    const snap = await rawCollection('webhook_deliveries').where('orgId', '==', orgId).get();
    let rows = snap.docs.map((d) => publicDelivery(d.id, d.data()));
    if (endpointId) rows = rows.filter((r) => r.endpoint_id === endpointId);
    if (status) rows = rows.filter((r) => r.status === status);
    return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
}

/** Sends a test event now and returns the delivery id (worker picks it up) */
async function sendTest(orgId, endpointId) {
    const ep = await loadEndpoint(orgId, endpointId);
    if (!ep) return null;
    const id = await enqueue(orgId, endpointId, buildEvent(orgId, 'webhook.test', { message: 'Test event from Kylrx' }));
    kick();
    return id;
}

module.exports = {
    MAX_ATTEMPTS, DELAYS_MS, nextDelayMs, signatureHeader, verifySignature, newSecret, checkResolvable, validateEventFilters,
    createEndpoint, listEndpoints, updateEndpoint, rotateSecret, deleteEndpoint, loadEndpoint, publicEndpoint, activeSecrets,
    enqueue, fanOut, attempt, processDue, processOutbox, tick, kick, start, stop, replay, replayDeadLetters, listDeliveries, sendTest, publicDelivery
};
