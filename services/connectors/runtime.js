/**
 * Connector runtime: per-company connections, encrypted credentials, mapping overrides, manual and scheduled
 * sync runs, event delivery (Slack/Teams), health checks, reconciliation, dead-letter retry.
 * Credentials are encrypted with services/pii-crypto (context orgId:conn:id) and never returned or logged.
 */
const { rawCollection } = require('../../config/firebase');
const { encryptField, decryptField } = require('../pii-crypto');
const C = require('../canonical');
const people = require('../person-store');
const events = require('../events');
const registry = require('./registry');
const { createHttp } = require('./http');
const engine = require('./sync-engine');
const { syncStore, log, listLogs } = require('./store');
const { mergeMappings, validateMapping, setPath, applyMapping } = require('./mapping');
const { aggregatePayResults } = require('./journal');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const nowIso = () => new Date().toISOString();

/** Expands flat dotted keys ("accounts.wages_expense") into nested config */
function expandConfig(flat) {
    const out = {};
    for (const [k, v] of Object.entries(flat || {})) { if (k === '__proto__' || k.includes('__proto__') || k.includes('constructor')) continue; setPath(out, k, v); }
    return out;
}
const deepMerge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
    return out;
};

const encCreds = (orgId, id, creds) => encryptField(JSON.stringify(creds || {}), `${orgId}:conn:${id}`);
const decCreds = (orgId, id, enc) => (enc ? JSON.parse(decryptField(enc, `${orgId}:conn:${id}`)) : {});

function publicConnection(id, d, adapter) {
    const a = adapter || registry.get(d.connectorKey);
    let creds = {}; try { creds = decCreds(d.orgId, id, d.credentialsEnc); } catch (_) { /* unreadable */ }
    return {
        id, connector: d.connectorKey, connector_name: a ? a.name : d.connectorKey, category: a ? a.category : null, name: d.name, status: d.status,
        config: d.config || {}, mapping: d.mapping || {}, conflict_policy: d.conflictPolicy || { default: 'ours', fields: {} }, entities: d.entities || {},
        schedule: d.schedule || { enabled: false, intervalMinutes: 60 }, next_run_at: d.nextRunAt || null, last_run_at: d.lastRunAt || null, last_status: d.lastStatus || null,
        health: d.health || null, created_at: d.createdAt,
        credentials: Object.fromEntries((a ? a.credentialFields : []).map((f) => [f.key, creds[f.key] ? `••••${String(creds[f.key]).slice(-4)}` : null]))
    };
}

async function loadRaw(orgId, id) {
    const snap = await rawCollection('connector_connections').doc(String(id)).get();
    if (!exists(snap) || snap.data().orgId !== orgId) return null;
    return { id: snap.id, ref: snap.ref, data: snap.data() };
}

function validateSchedule(s) {
    if (s === undefined) return { value: undefined };
    const enabled = Boolean(s && s.enabled); const m = Number(s && s.intervalMinutes);
    if (!Number.isFinite(m) || m < 1 || m > 10080) return { error: 'schedule.intervalMinutes must be between 1 and 10080' };
    return { value: { enabled, intervalMinutes: Math.round(m) } };
}

function validateConflictPolicy(p) {
    if (p === undefined) return { value: undefined };
    const ok = ['ours', 'theirs', 'newest'];
    if (!p || !ok.includes(p.default || 'ours')) return { error: 'conflictPolicy.default must be ours, theirs or newest' };
    for (const [f, m] of Object.entries(p.fields || {})) if (!ok.includes(m)) return { error: `conflictPolicy.fields.${f} must be ours, theirs or newest` };
    return { value: { default: p.default || 'ours', fields: p.fields || {} } };
}

async function createConnection(orgId, body, actor) {
    const adapter = registry.get(body.connector);
    if (!adapter) return { errors: ['unknown connector'] };
    const errors = [];
    const config = expandConfig(body.config);
    for (const f of adapter.configFields.filter((x) => x.required)) if (config[f.key.split('.')[0]] === undefined || config[f.key.split('.')[0]] === '') errors.push(`${f.label} is required`);
    const creds = {}; for (const f of adapter.credentialFields) if (body.credentials && body.credentials[f.key]) creds[f.key] = String(body.credentials[f.key]);
    if (adapter.credentialFields.length && !Object.keys(creds).length && !adapter.credentialFields.every((f) => f.optional)) errors.push('credentials are required');
    const sch = validateSchedule(body.schedule || { enabled: false, intervalMinutes: 60 }); if (sch.error) errors.push(sch.error);
    const pol = validateConflictPolicy(body.conflictPolicy); if (pol.error) errors.push(pol.error);
    for (const [e, rules] of Object.entries(body.mapping || {})) errors.push(...validateMapping(rules).map((m) => `${e}: ${m}`));
    if (errors.length) return { errors };
    const ref = rawCollection('connector_connections').doc();
    const doc = {
        orgId, connectorKey: adapter.key, name: String(body.name || adapter.name).slice(0, 80), status: 'active', config, credentialsEnc: encCreds(orgId, ref.id, creds), mapping: body.mapping || {},
        conflictPolicy: pol.value || { default: 'ours', fields: {} }, entities: body.entities || {}, cursors: {}, schedule: sch.value, scheduleEnabled: sch.value.enabled,
        nextRunAt: sch.value.enabled ? new Date(Date.now() + sch.value.intervalMinutes * 60000).toISOString() : null, createdAt: nowIso(), createdBy: actor || null, lastRunAt: null, lastStatus: null, runningUntil: null
    };
    await ref.set(doc);
    await log(orgId, ref.id, 'info', `Connection created (${adapter.name})`);
    return { connection: publicConnection(ref.id, doc, adapter), id: ref.id };
}

async function updateConnection(orgId, id, body) {
    const raw = await loadRaw(orgId, id);
    if (!raw) return { notFound: true };
    const adapter = registry.get(raw.data.connectorKey); const patch = {}; const errors = [];
    if (body.name !== undefined) patch.name = String(body.name).slice(0, 80);
    if (body.status !== undefined) { if (!['active', 'paused'].includes(body.status)) errors.push('status must be active or paused'); else patch.status = body.status; }
    if (body.config !== undefined) patch.config = deepMerge(raw.data.config || {}, expandConfig(body.config));
    if (body.credentials) {
        const cur = decCreds(orgId, id, raw.data.credentialsEnc);
        for (const f of adapter.credentialFields) if (body.credentials[f.key]) cur[f.key] = String(body.credentials[f.key]);
        patch.credentialsEnc = encCreds(orgId, id, cur);
    }
    if (body.mapping !== undefined) {
        for (const [e, rules] of Object.entries(body.mapping || {})) errors.push(...validateMapping(rules).map((m) => `${e}: ${m}`));
        patch.mapping = body.mapping;
    }
    const pol = validateConflictPolicy(body.conflictPolicy); if (pol.error) errors.push(pol.error); else if (pol.value) patch.conflictPolicy = pol.value;
    const sch = validateSchedule(body.schedule); if (sch.error) errors.push(sch.error);
    else if (sch.value) { patch.schedule = sch.value; patch.scheduleEnabled = sch.value.enabled; patch.nextRunAt = sch.value.enabled ? new Date(Date.now() + sch.value.intervalMinutes * 60000).toISOString() : null; }
    if (body.entities !== undefined) patch.entities = body.entities;
    if (errors.length) return { errors };
    await raw.ref.update(patch);
    await log(orgId, id, 'info', `Connection updated (${Object.keys(patch).filter((k) => k !== 'credentialsEnc').join(', ')}${patch.credentialsEnc ? ', credentials' : ''})`);
    return { connection: publicConnection(id, { ...raw.data, ...patch }, adapter) };
}

async function listConnections(orgId) {
    const snap = await rawCollection('connector_connections').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => publicConnection(d.id, d.data())).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function deleteConnection(orgId, id) {
    const raw = await loadRaw(orgId, id);
    if (!raw) return false;
    await raw.ref.delete();
    for (const col of ['connector_sync_state', 'connector_dead_letters']) {
        const q = await rawCollection(col).where('connectionId', '==', id).get();
        await Promise.all(q.docs.filter((d) => d.data().orgId === orgId).map((d) => d.ref.delete()));
    }
    return true;
}

/** Context handed to adapters */
function buildCtx(orgId, raw, http) {
    const creds = decCreds(orgId, raw.id, raw.data.credentialsEnc);
    const ctx = {
        conn: { id: raw.id, orgId, config: raw.data.config || {}, credentials: creds, mapping: raw.data.mapping || {}, conflictPolicy: raw.data.conflictPolicy, cursors: raw.data.cursors || {}, entities: raw.data.entities || {} },
        http: http || createHttp(), now: () => new Date(),
        async saveCredentials(p) { Object.assign(creds, p); await raw.ref.update({ credentialsEnc: encCreds(orgId, raw.id, creds) }); }
    };
    return ctx;
}

/* ----------------------------- canonical sources ----------------------------- */

function sourcesFor(orgId) {
    const since = (rows, s) => (s ? rows.filter((r) => (r.updated_at || '') >= s) : rows);
    const ids = (rows, i) => (i ? rows.filter((r) => i.includes(String(r.id))) : rows);
    return {
        async people(conn, { since: s, ids: i } = {}) {
            const rows = (await people.loadPeople(orgId)).map((u) => C.toPerson(u));
            return ids(since(rows, s), i);
        },
        async payroll_journal(conn, { since: s, ids: i } = {}) {
            const snap = await rawCollection('pay_results').where('orgId', '==', orgId).get().catch(() => ({ docs: [] }));
            const rows = aggregatePayResults(snap.docs.map((d) => C.toPayResult({ id: d.id, ...d.data() })));
            return ids(since(rows, s), i);
        },
        async time_weeks(conn, { since: s, ids: i } = {}) {
            const snap = await rawCollection('timesheet_weeks').where('orgId', '==', orgId).get();
            const rows = snap.docs.map((d) => C.toWeeklyTimeEntry({ id: d.id, ...d.data() }, d.data())).filter((e) => e.status === 'approved');
            return ids(since(rows, s), i);
        }
    };
}

/* ---------------------------------- runs ---------------------------------- */

const running = new Set();

async function runConnection(orgId, id, { trigger = 'manual', http, opts = {}, sources } = {}) {
    const raw = await loadRaw(orgId, id);
    if (!raw) return { notFound: true };
    const adapter = registry.get(raw.data.connectorKey);
    if (!adapter.entities.length) return { error: 'This connector is event-driven (nothing to sync). Use "Send test event".' };
    if (running.has(id)) return { error: 'A sync is already running for this connection' };
    running.add(id);
    try {
        const ctx = buildCtx(orgId, raw, http);
        await log(orgId, id, 'info', `Sync started (${trigger})`);
        const summary = await engine.runSync({ adapter, conn: ctx.conn, ctx, store: syncStore(orgId), sources: sources || sourcesFor(orgId), inbound: undefined, opts });
        const runRef = await rawCollection('connector_runs').add({ orgId, connectionId: id, trigger, ...summary });
        const interval = (raw.data.schedule || {}).intervalMinutes || 60;
        await raw.ref.update({ cursors: summary.cursors, lastRunAt: summary.finishedAt, lastStatus: summary.status, nextRunAt: (raw.data.schedule || {}).enabled ? new Date(Date.now() + interval * 60000).toISOString() : null, ...(summary.status === 'failed' ? { status: raw.data.status === 'paused' ? 'paused' : 'error' } : (raw.data.status === 'error' ? { status: 'active' } : {})) });
        await log(orgId, id, summary.status === 'success' ? 'info' : 'error', `Sync ${summary.status}: ${Object.entries(summary.stats).map(([e, s]) => `${e} +${s.created} ~${s.updated} =${s.skipped} !${s.failed}`).join('; ') || 'nothing to do'}`);
        if (summary.status !== 'success') events.emit(orgId, 'connector.sync.failed', { connection_id: id, connector: adapter.key, errors: summary.errors.slice(0, 5).map((e) => ({ entity: e.entity, message: e.message })) });
        return { run: { id: runRef.id, ...summary } };
    } finally { running.delete(id); }
}

async function listRuns(orgId, id, limit = 30) {
    const q = await rawCollection('connector_runs').where('connectionId', '==', id).get();
    return q.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.orgId === orgId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt))).slice(0, limit);
}

async function healthCheck(orgId, id, { http } = {}) {
    const raw = await loadRaw(orgId, id);
    if (!raw) return { notFound: true };
    const adapter = registry.get(raw.data.connectorKey);
    const ctx = buildCtx(orgId, raw, http);
    const h = await adapter.healthCheck(ctx);
    const health = { ok: h.ok, detail: h.detail, latencyMs: h.latencyMs, at: nowIso() };
    await raw.ref.update({ health, ...(h.ok && raw.data.status === 'error' ? { status: 'active' } : {}) });
    await log(orgId, id, h.ok ? 'info' : 'error', `Health check ${h.ok ? 'passed' : 'failed'}: ${h.detail}`);
    return { health };
}

async function reconcileConnection(orgId, id, { http, sources } = {}) {
    const raw = await loadRaw(orgId, id);
    if (!raw) return { notFound: true };
    const adapter = registry.get(raw.data.connectorKey);
    const ctx = buildCtx(orgId, raw, http);
    return { report: await engine.reconcile({ adapter, conn: ctx.conn, ctx, store: syncStore(orgId), sources: sources || sourcesFor(orgId) }) };
}

async function retryDeadLetter(orgId, id, dlId, { http, opts, sources } = {}) {
    const snap = await rawCollection('connector_dead_letters').doc(String(dlId)).get();
    if (!exists(snap) || snap.data().orgId !== orgId || snap.data().connectionId !== id) return { notFound: true };
    const d = snap.data();
    if (d.kind === 'event') {
        const raw = await loadRaw(orgId, id); const adapter = registry.get(raw.data.connectorKey);
        try { await adapter.handleEvent(d.payload, buildCtx(orgId, raw, http)); await snap.ref.update({ status: 'resolved', resolvedAt: nowIso() }); return { ok: true }; } catch (e) { await snap.ref.update({ error: engine.redact(e.message), attempts: (d.attempts || 0) + 1 }); return { ok: false, error: engine.redact(e.message) }; }
    }
    await snap.ref.update({ status: 'retried', retriedAt: nowIso() });
    const r = await runConnection(orgId, id, { trigger: 'retry', http, opts: { ...(opts || {}), onlyRecordIds: [d.recordId] }, sources });
    return { ok: Boolean(r.run && r.run.status === 'success'), run: r.run || null, error: r.error };
}

async function listDeadLetters(orgId, id, status) { return syncStore(orgId).listDeadLetters(id, { status }); }

/* ---------------------------------- events ---------------------------------- */

/** Delivers an event to every active event-driven connection of the company (Slack, Teams) */
async function handleEvent(orgId, event, { http } = {}) {
    const snap = await rawCollection('connector_connections').where('orgId', '==', orgId).get();
    for (const d of snap.docs) {
        const data = d.data(); const adapter = registry.get(data.connectorKey);
        if (!adapter || !adapter.eventDriven || data.status !== 'active') continue;
        const raw = { id: d.id, ref: d.ref, data };
        try {
            const ctx = buildCtx(orgId, raw, http);
            await adapter.authenticate(ctx);
            const { value } = await engine.withRetries(() => adapter.handleEvent(event, ctx), { maxAttempts: 3, baseMs: 200 });
            if (value && value.sent) await log(orgId, d.id, 'info', `Sent ${event.type}`);
        } catch (e) {
            await log(orgId, d.id, 'error', `Could not send ${event.type}: ${engine.redact(e.message)}`);
            await syncStore(orgId).addDeadLetter(d.id, { entity: 'event', recordId: event.id, error: engine.redact(e.message), kind: 'event', attempts: e.attempts || 1, payload: event });
        }
    }
}

/** Send a test event through one connection (used by the UI) */
async function sendTestEvent(orgId, id, { http } = {}) {
    const raw = await loadRaw(orgId, id);
    if (!raw) return { notFound: true };
    const adapter = registry.get(raw.data.connectorKey);
    if (!adapter.eventDriven) return { error: 'This connector does not send events' };
    const ctx = buildCtx(orgId, raw, http); await adapter.authenticate(ctx);
    const event = events.buildEvent(orgId, 'webhook.test', { message: 'Test message from Kylrx' });
    try { const r = await adapter.handleEvent({ ...event, type: 'webhook.test' }, { ...ctx, conn: { ...ctx.conn, config: { ...ctx.conn.config, events: '*' } } }); await log(orgId, id, 'info', 'Test event sent'); return { ok: true, result: r }; }
    catch (e) { await log(orgId, id, 'error', `Test event failed: ${engine.redact(e.message)}`); return { ok: false, error: engine.redact(e.message) }; }
}

/* -------------------------------- scheduler -------------------------------- */

let timer = null; let ticking = false;
async function tick() {
    if (ticking) return; ticking = true;
    try {
        const snap = await rawCollection('connector_connections').where('scheduleEnabled', '==', true).limit(100).get();
        const now = Date.now();
        const due = snap.docs.filter((d) => d.data().status === 'active' && d.data().nextRunAt && new Date(d.data().nextRunAt).getTime() <= now).slice(0, 5);
        for (const d of due) { try { await runConnection(d.data().orgId, d.id, { trigger: 'schedule' }); } catch (e) { await log(d.data().orgId, d.id, 'error', `Scheduled run crashed: ${engine.redact(e.message)}`); } }
    } catch (_) { /* next tick */ } finally { ticking = false; }
}
function startScheduler({ intervalMs = 60000 } = {}) { if (timer) return; timer = setInterval(tick, intervalMs); if (timer.unref) timer.unref(); }
function stopScheduler() { if (timer) clearInterval(timer); timer = null; }

/** Preview of a mapping on a sample record (for the editor) */
function previewMapping(connectorKey, entityKey, record, overrides) {
    const adapter = registry.get(connectorKey);
    if (!adapter) return { errors: ['unknown connector'] };
    const rules = mergeMappings(adapter.defaultMappings[entityKey] || [], overrides || []);
    const r = applyMapping(rules, record);
    return { rules, output: r.value, errors: r.errors };
}

module.exports = {
    createConnection, updateConnection, listConnections, deleteConnection, loadRaw, publicConnection, runConnection, listRuns, healthCheck, reconcileConnection,
    retryDeadLetter, listDeadLetters, handleEvent, sendTestEvent, tick, startScheduler, stopScheduler, previewMapping, buildCtx, sourcesFor, expandConfig, listLogs
};
