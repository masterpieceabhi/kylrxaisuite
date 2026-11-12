/**
 * Sync engine: moves canonical records to/from a connector with change tracking, idempotent
 * upserts, per-field conflict policy, retries, a dead-letter queue and reconciliation.
 *
 * The engine does no I/O of its own. It talks to:
 *   adapter  (see adapters/_base.js)                 -> the remote system
 *   store    (connectors/store.js or memoryStore())  -> sync state, dead letters
 *   sources  { [sourceKey]: async (conn, { since, ids }) => canonical records with { id, updated_at } }
 *   inbound  { find(entityKey, mappedRemote) -> local|null, apply(entityKey, localId|null, patch, meta) }   (pull direction)
 */
const crypto = require('crypto');

const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));
const isBlank = (v) => v === undefined || v === null || v === '';

/**
 * Per-field source of truth. policy: { default: 'ours'|'theirs'|'newest', fields: { work_email: 'theirs', ... } }
 *  ours   our system wins when it already has a value (remote only fills blanks)
 *  theirs the remote value always wins
 *  newest the side changed most recently wins
 * Returns { patch (values to write into OUR system), skipped: [{ field, reason }] }
 */
function resolveConflicts({ local, remote, policy = {}, localUpdatedAt, remoteUpdatedAt }) {
    const patch = {}; const skipped = [];
    for (const [field, rv] of Object.entries(remote || {})) {
        const lv = local ? local[field] : undefined;
        if (JSON.stringify(lv) === JSON.stringify(rv)) continue;
        const mode = (policy.fields && policy.fields[field]) || policy.default || 'ours';
        if (isBlank(lv)) { if (!isBlank(rv)) patch[field] = rv; continue; }
        if (mode === 'theirs') patch[field] = rv;
        else if (mode === 'newest') {
            if (remoteUpdatedAt && localUpdatedAt && remoteUpdatedAt > localUpdatedAt) patch[field] = rv;
            else skipped.push({ field, reason: 'local value is newer' });
        } else skipped.push({ field, reason: 'our system is the source of truth for this field' });
    }
    return { patch, skipped };
}

/** Exponential backoff with a cap, used for in-run retries (retryable errors only) */
const retryDelayMs = (attempt, base = 500) => Math.min(base * 2 ** (attempt - 1), 8000);

async function withRetries(fn, { maxAttempts = 3, sleep = sleepDefault, baseMs = 500 } = {}) {
    let last; let made = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try { return { value: await fn(attempt), attempts: attempt }; } catch (e) {
            last = e; made = attempt;
            if (e.retryable !== true) break;
            if (attempt < maxAttempts) await sleep(retryDelayMs(attempt, baseMs));
        }
    }
    const err = last instanceof Error ? last : new Error(String(last));
    err.attempts = made;
    throw err;
}

const redact = (s) => String(s).replace(/(Bearer\s+)[\w.\-]+/gi, '$1***').replace(/(password|secret|token)(["':= ]+)[^\s"',}]+/gi, '$1$2***').slice(0, 400);

/**
 * One full run for a connection. Returns the run summary (the caller persists it).
 *   opts: { onlyRecordIds, maxAttempts, sleep, now }
 */
async function runSync({ adapter, conn, ctx, store, sources = {}, inbound, opts = {} }) {
    const now = opts.now || (() => new Date());
    const started = now().toISOString();
    const stats = {}; const errors = []; const cursors = { ...(conn.cursors || {}) };
    const summary = { startedAt: started, finishedAt: null, status: 'success', stats, errors, cursors };
    const entityFilter = (e) => !(conn.entities && conn.entities[e.key] === false);
    const note = (entity, msg) => { if (errors.length < 25) errors.push({ entity, message: redact(msg) }); };

    try {
        await adapter.authenticate(ctx);
    } catch (e) {
        summary.status = 'failed'; summary.finishedAt = now().toISOString(); note('auth', `authentication failed: ${e.message}`);
        return summary;
    }

    for (const entity of (adapter.entities || []).filter(entityFilter)) {
        const s = (stats[entity.key] = { fetched: 0, created: 0, updated: 0, skipped: 0, failed: 0, conflicts: 0 });
        try {
            if (entity.direction === 'push') await pushEntity({ adapter, conn, ctx, store, sources, entity, s, cursors, note, opts });
            else if (entity.direction === 'pull') await pullEntity({ adapter, conn, ctx, store, entity, s, cursors, note, inbound, opts });
        } catch (e) {
            s.failed += 1; note(entity.key, `entity run failed: ${e.message}`);
        }
    }
    const failed = Object.values(stats).reduce((n, x) => n + x.failed, 0);
    const done = Object.values(stats).reduce((n, x) => n + x.created + x.updated + x.skipped, 0);
    summary.status = failed === 0 ? 'success' : (done > 0 ? 'partial' : 'failed');
    summary.finishedAt = now().toISOString();
    return summary;
}

async function pushEntity({ adapter, conn, ctx, store, sources, entity, s, cursors, note, opts }) {
    const since = opts.onlyRecordIds ? null : (cursors[entity.key] || null);
    const records = (await sources[entity.source](conn, { since, ids: opts.onlyRecordIds })).slice().sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')) || String(a.id).localeCompare(String(b.id)));
    s.fetched = records.length;
    let advance = true; let maxTs = since;
    const batch = [];
    for (const record of records) {
        const rid = String(record.id);
        const state = await store.getState(conn.id, entity.key, rid);
        let mapped;
        try {
            mapped = adapter.map(entity.key, record, ctx);
            const errs = [...(mapped.errors || []), ...(adapter.validate ? adapter.validate(entity.key, mapped.payload, record, ctx) : [])];
            if (errs.length) throw Object.assign(new Error(errs.join('; ')), { retryable: false, validation: true });
        } catch (e) {
            s.failed += 1; note(entity.key, `${rid}: ${e.message}`);
            await store.addDeadLetter(conn.id, { entity: entity.key, recordId: rid, error: redact(e.message), kind: e.validation ? 'validation' : 'mapping', attempts: 0, payload: null });
            await store.putState(conn.id, entity.key, rid, { status: 'error', error: redact(e.message), hash: state && state.hash, remoteId: state && state.remoteId });
            advance = false; continue;
        }
        const hash = sha(mapped.payload);
        if (state && state.status === 'ok' && state.hash === hash) {
            s.skipped += 1; if (advance && record.updated_at && (!maxTs || record.updated_at > maxTs)) maxTs = record.updated_at;
            continue;
        }
        if (adapter.batch) { batch.push({ record, payload: mapped.payload, hash, state }); continue; }
        try {
            const { value } = await withRetries(() => adapter.push(entity.key, mapped.payload, ctx, { remoteId: state && state.remoteId, record, hash }), { maxAttempts: opts.maxAttempts || 3, sleep: opts.sleep });
            await store.putState(conn.id, entity.key, rid, { status: 'ok', hash, remoteId: value.remoteId || (state && state.remoteId) || null, lastSyncedAt: new Date().toISOString(), error: null });
            if (state && state.remoteId) s.updated += 1; else s.created += 1;
            await store.resolveDeadLetters(conn.id, entity.key, rid);
            if (advance && record.updated_at && (!maxTs || record.updated_at > maxTs)) maxTs = record.updated_at;
        } catch (e) {
            s.failed += 1; note(entity.key, `${rid}: ${e.message}`);
            await store.addDeadLetter(conn.id, { entity: entity.key, recordId: rid, error: redact(e.message), kind: 'push', attempts: e.attempts || 1, payload: mapped.payload });
            await store.putState(conn.id, entity.key, rid, { status: 'error', error: redact(e.message), hash: state && state.hash, remoteId: state && state.remoteId });
            advance = false;
        }
    }
    if (adapter.batch && batch.length) {
        try {
            const out = await withRetries(() => adapter.pushBatch(entity.key, batch.map((b) => ({ id: String(b.record.id), payload: b.payload, record: b.record })), ctx), { maxAttempts: opts.maxAttempts || 3, sleep: opts.sleep });
            for (const b of batch) {
                await store.putState(conn.id, entity.key, String(b.record.id), { status: 'ok', hash: b.hash, remoteId: (out.value && out.value.file) || null, lastSyncedAt: new Date().toISOString(), error: null });
                if (b.state && b.state.remoteId) s.updated += 1; else s.created += 1;
                if (b.record.updated_at && (!maxTs || b.record.updated_at > maxTs)) maxTs = b.record.updated_at;
            }
        } catch (e) {
            s.failed += batch.length; note(entity.key, `batch export failed: ${e.message}`);
            for (const b of batch) await store.addDeadLetter(conn.id, { entity: entity.key, recordId: String(b.record.id), error: redact(e.message), kind: 'push', attempts: e.attempts || 1, payload: b.payload });
            advance = false;
        }
    }
    if (!opts.onlyRecordIds && advance && maxTs) cursors[entity.key] = maxTs;
    else if (!opts.onlyRecordIds && !advance && maxTs) cursors[entity.key] = maxTs; // progress up to the last record before the first failure
}

async function pullEntity({ adapter, conn, ctx, store, entity, s, cursors, note, inbound, opts }) {
    if (!inbound) throw new Error('this connection has no inbound handler');
    const { records, cursor } = await withRetries(() => adapter.pull(entity.key, ctx, { cursor: cursors[entity.key] || null }), { maxAttempts: opts.maxAttempts || 3, sleep: opts.sleep }).then((r) => r.value);
    s.fetched = records.length;
    for (const remote of records) {
        const rid = String(remote.id || remote.externalId || '');
        try {
            const mapped = adapter.mapInbound ? adapter.mapInbound(entity.key, remote, ctx) : { value: remote, errors: [] };
            if (mapped.errors && mapped.errors.length) throw Object.assign(new Error(mapped.errors.join('; ')), { retryable: false });
            const local = await inbound.find(entity.key, mapped.value, remote);
            const { patch, skipped } = resolveConflicts({ local: local && local.fields, remote: mapped.value, policy: conn.conflictPolicy, localUpdatedAt: local && local.updated_at, remoteUpdatedAt: remote.updated_at });
            s.conflicts += skipped.length;
            if (!Object.keys(patch).length && local) { s.skipped += 1; continue; }
            await inbound.apply(entity.key, local ? local.id : null, patch, { remoteId: rid, source: adapter.key });
            await store.putState(conn.id, entity.key, local ? local.id : rid, { status: 'ok', remoteId: rid, lastSyncedAt: new Date().toISOString(), fieldSources: Object.fromEntries(Object.keys(patch).map((f) => [f, 'remote'])), hash: sha(mapped.value) });
            if (local) s.updated += 1; else s.created += 1;
        } catch (e) {
            s.failed += 1; note(entity.key, `${rid}: ${e.message}`);
            await store.addDeadLetter(conn.id, { entity: entity.key, recordId: rid, error: redact(e.message), kind: 'inbound', attempts: 1, payload: null });
        }
    }
    if (cursor) cursors[entity.key] = cursor;
}

/**
 * Reconciliation report: what we have vs what was synced (push entities).
 * Counts: local_total, in_sync, pending (never synced), changed (needs resend), errored, orphaned (synced before, gone locally).
 */
async function reconcile({ adapter, conn, ctx, store, sources }) {
    const report = { generatedAt: new Date().toISOString(), entities: {} };
    for (const entity of (adapter.entities || []).filter((e) => e.direction === 'push')) {
        const records = await sources[entity.source](conn, { since: null });
        const states = await store.listStates(conn.id, entity.key);
        const byId = new Map(states.map((x) => [x.recordId, x]));
        const r = { local_total: records.length, in_sync: 0, pending: 0, changed: 0, errored: 0, orphaned: 0, samples: { pending: [], changed: [], errored: [], orphaned: [] } };
        const seen = new Set();
        for (const rec of records) {
            const id = String(rec.id); seen.add(id);
            const st = byId.get(id);
            let hash = null;
            try { hash = sha(adapter.map(entity.key, rec, ctx).payload); } catch (_) { /* counted as errored below */ }
            if (!st) { r.pending += 1; if (r.samples.pending.length < 20) r.samples.pending.push(id); }
            else if (st.status === 'error') { r.errored += 1; if (r.samples.errored.length < 20) r.samples.errored.push({ id, error: st.error }); }
            else if (hash && st.hash !== hash) { r.changed += 1; if (r.samples.changed.length < 20) r.samples.changed.push(id); }
            else r.in_sync += 1;
        }
        for (const st of states) if (!seen.has(st.recordId) && st.status === 'ok') { r.orphaned += 1; if (r.samples.orphaned.length < 20) r.samples.orphaned.push(st.recordId); }
        r.dead_letters_open = (await store.listDeadLetters(conn.id, { status: 'open' })).filter((d) => d.entity === entity.key).length;
        report.entities[entity.key] = r;
    }
    return report;
}

/** In-memory store with the same interface as connectors/store.js (tests) */
function memoryStore() {
    const states = new Map(); const dead = []; let n = 0;
    const k = (c, e, r) => `${c}|${e}|${r}`;
    return {
        states, dead,
        async getState(c, e, r) { return states.get(k(c, e, r)) || null; },
        async putState(c, e, r, patch) { states.set(k(c, e, r), { ...(states.get(k(c, e, r)) || {}), recordId: r, entity: e, connectionId: c, ...patch }); },
        async listStates(c, e) { return [...states.values()].filter((x) => x.connectionId === c && x.entity === e); },
        async addDeadLetter(c, d) { dead.push({ id: `dl${++n}`, connectionId: c, status: 'open', createdAt: new Date().toISOString(), ...d }); },
        async resolveDeadLetters(c, e, r) { dead.filter((d) => d.connectionId === c && d.entity === e && d.recordId === r && d.status === 'open').forEach((d) => { d.status = 'resolved'; }); },
        async listDeadLetters(c, { status } = {}) { return dead.filter((d) => d.connectionId === c && (!status || d.status === status)); }
    };
}

module.exports = { runSync, reconcile, resolveConflicts, withRetries, retryDelayMs, memoryStore, sha, redact };
