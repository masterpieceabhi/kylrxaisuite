/**
 * Persistence for the Gusto integration. One store API, two backends:
 *   createFirestoreStore()  production / live testing (top-level collections, every doc has orgId)
 *   createMemoryStore()     unit and integration tests (no emulator needed)
 *
 * Collections:
 *   gusto_connections/{orgId}          connection, encrypted tokens, onboarding state, webhook state, settings
 *   gusto_locks/{orgId}                lease lock that serialises token refresh across processes
 *   gusto_links/{orgId__kind__ourId}   our id <-> Gusto uuid + version + sync state
 *   gusto_errors/{auto}                sync / webhook / payroll errors with retry info
 *   gusto_events/{orgId__eventKey}     received webhook / polled events (dedupe + processing queue)
 *   gusto_payrolls/{orgId__payrollUuid}  our record of each payroll we prepared / submitted
 *
 * Secrets (access/refresh tokens, verification tokens, client secret) are always stored encrypted with
 * services/pii-crypto and are only ever decrypted inside this module's token helpers.
 */
const crypto = require('crypto');
const { encryptField, decryptField } = require('../pii-crypto');

const COL = {
    connections: 'gusto_connections', locks: 'gusto_locks', links: 'gusto_links',
    errors: 'gusto_errors', events: 'gusto_events', payrolls: 'gusto_payrolls'
};

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const nowIso = () => new Date().toISOString();

function deepMerge(base, patch) {
    const out = { ...(base || {}) };
    for (const [k, v] of Object.entries(patch || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) out[k] = deepMerge(out[k], v);
        else out[k] = v;
    }
    return out;
}

/* ------------------------------- key-value backends ------------------------------- */

function memoryKv() {
    const cols = new Map();
    const col = (n) => { if (!cols.has(n)) cols.set(n, new Map()); return cols.get(n); };
    return {
        async get(c, id) { const v = col(c).get(id); return v === undefined ? null : clone(v); },
        async set(c, id, data, merge) { col(c).set(id, merge ? deepMerge(col(c).get(id), clone(data)) : clone(data)); },
        async create(c, id, data) { if (col(c).has(id)) return false; col(c).set(id, clone(data)); return true; },
        async delete(c, id) { col(c).delete(id); },
        async add(c, data) { const id = crypto.randomBytes(10).toString('hex'); col(c).set(id, clone(data)); return id; },
        async all(c) { return [...col(c).entries()].map(([id, v]) => ({ id, ...clone(v) })); },
        async where(c, orgId) { return [...col(c).entries()].filter(([, v]) => v.orgId === orgId).map(([id, v]) => ({ id, ...clone(v) })); },
        async transact(c, id, fn) { const cur = col(c).get(id); const res = fn(cur === undefined ? null : clone(cur)); if (res && res.write) col(c).set(id, clone(res.write)); return res ? res.result : undefined; }
    };
}

function firestoreKv() {
    const { db, rawCollection } = require('../../config/firebase');
    const exists = (s) => (typeof s.exists === 'function' ? s.exists() : s.exists);
    return {
        async get(c, id) { const s = await rawCollection(c).doc(id).get(); return exists(s) ? s.data() : null; },
        async set(c, id, data, merge) { await rawCollection(c).doc(id).set(data, merge ? { merge: true } : undefined); },
        async create(c, id, data) {
            try { await rawCollection(c).doc(id).create(data); return true; } catch (e) {
                if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) return false;
                throw e;
            }
        },
        async delete(c, id) { await rawCollection(c).doc(id).delete(); },
        async add(c, data) { const r = await rawCollection(c).add(data); return r.id; },
        async all(c) { const s = await rawCollection(c).get(); return s.docs.map((d) => ({ id: d.id, ...d.data() })); },
        async where(c, orgId) { const s = await rawCollection(c).where('orgId', '==', orgId).get(); return s.docs.map((d) => ({ id: d.id, ...d.data() })); },
        async transact(c, id, fn) {
            const ref = rawCollection(c).doc(id);
            return db.runTransaction(async (tx) => {
                const s = await tx.get(ref);
                const res = fn(exists(s) ? s.data() : null);
                if (res && res.write) tx.set(ref, res.write);
                return res ? res.result : undefined;
            });
        }
    };
}

/* ------------------------------- the store ------------------------------- */

function createStore(kv) {
    const linkId = (orgId, kind, ourId) => `${orgId}__${kind}__${ourId}`;
    const ctx = (orgId, what) => `${orgId}:gusto:${what}`;
    const enc = (orgId, what, v) => (v ? encryptField(v, ctx(orgId, what)) : null);
    const dec = (orgId, what, v) => (v ? decryptField(v, ctx(orgId, what)) : null);

    const store = {
        kv,

        /* connection */
        async getConnection(orgId) { return kv.get(COL.connections, orgId); },
        async saveConnection(orgId, patch) { await kv.set(COL.connections, orgId, { orgId, ...patch, updatedAt: nowIso() }, true); },
        async listConnectedOrgIds() { return (await kv.all(COL.connections)).filter((c) => c.status === 'connected' && c.companyUuid).map((c) => c.orgId || c.id); },
        async deleteConnection(orgId) { await kv.delete(COL.connections, orgId); },

        /* tokens (company) */
        async getCompanyTokens(orgId) {
            const c = await kv.get(COL.connections, orgId);
            const t = c && c.tokens;
            if (!t || !t.accessEnc) return null;
            return { accessToken: dec(orgId, 'access', t.accessEnc), refreshToken: dec(orgId, 'refresh', t.refreshEnc), expiresAt: t.expiresAt || 0, refreshedAt: t.refreshedAt || null, generation: t.generation || 0 };
        },
        async saveCompanyTokens(orgId, { accessToken, refreshToken, expiresAt }) {
            const c = (await kv.get(COL.connections, orgId)) || {};
            const generation = ((c.tokens && c.tokens.generation) || 0) + 1;
            await kv.set(COL.connections, orgId, { orgId, tokens: { accessEnc: enc(orgId, 'access', accessToken), refreshEnc: enc(orgId, 'refresh', refreshToken), expiresAt, refreshedAt: nowIso(), generation } }, true);
            return generation;
        },
        async clearCompanyTokens(orgId) { await kv.set(COL.connections, orgId, { orgId, tokens: { accessEnc: null, refreshEnc: null, expiresAt: 0 } }, true); },

        /* webhook secrets */
        async saveVerificationToken(orgId, token) { await kv.set(COL.connections, orgId, { orgId, webhook: { verificationTokenEnc: enc(orgId, 'verify', token) } }, true); },
        async getVerificationToken(orgId) { const c = await kv.get(COL.connections, orgId); return dec(orgId, 'verify', c && c.webhook && c.webhook.verificationTokenEnc); },
        async savePendingVerificationToken(orgId, token) { await kv.set(COL.connections, orgId, { orgId, webhook: { pendingTokenEnc: enc(orgId, 'pending', token) } }, true); },
        async getPendingVerificationToken(orgId) { const c = await kv.get(COL.connections, orgId); return dec(orgId, 'pending', c && c.webhook && c.webhook.pendingTokenEnc); },
        async clearPendingVerificationToken(orgId) { await kv.set(COL.connections, orgId, { orgId, webhook: { pendingTokenEnc: null } }, true); },

        /* optional stored app credentials (env wins; see config.js) */
        async saveClientSecret(orgId, secret) { await kv.set(COL.connections, orgId, { orgId, clientSecretEnc: enc(orgId, 'client_secret', secret) }, true); },
        async getClientSecret(orgId) { const c = await kv.get(COL.connections, orgId); return dec(orgId, 'client_secret', c && c.clientSecretEnc); },

        /* refresh lock: a lease so a crashed holder cannot block refreshes forever */
        async acquireLock(orgId, holder, leaseMs) {
            const now = Date.now();
            return kv.transact(COL.locks, orgId, (cur) => {
                if (cur && cur.holder !== holder && cur.expiresAt > now) return { result: false };
                return { write: { orgId, holder, expiresAt: now + leaseMs }, result: true };
            });
        },
        async releaseLock(orgId, holder) {
            await kv.transact(COL.locks, orgId, (cur) => (cur && cur.holder === holder ? { write: { orgId, holder: null, expiresAt: 0 }, result: true } : { result: false }));
        },

        /* links */
        async getLink(orgId, kind, ourId) { return kv.get(COL.links, linkId(orgId, kind, ourId)); },
        async saveLink(orgId, kind, ourId, patch) {
            const id = linkId(orgId, kind, ourId);
            const cur = await kv.get(COL.links, id);
            const next = deepMerge(cur || { orgId, kind, ourId, createdAt: nowIso() }, { ...patch, updatedAt: nowIso() });
            await kv.set(COL.links, id, next, false);
            return next;
        },
        async listLinks(orgId, kind) { return (await kv.where(COL.links, orgId)).filter((l) => !kind || l.kind === kind); },
        async deleteLink(orgId, kind, ourId) { await kv.delete(COL.links, linkId(orgId, kind, ourId)); },

        /* errors */
        async logError(orgId, rec) {
            const doc = { orgId, at: nowIso(), resolved: false, attempts: 1, ...rec };
            // one open error per (scope, ref): update instead of piling up
            if (rec.scope && rec.ref) {
                const open = (await kv.where(COL.errors, orgId)).find((e) => !e.resolved && e.scope === rec.scope && e.ref === rec.ref);
                if (open) { await kv.set(COL.errors, open.id, { ...open, id: undefined, message: rec.message, at: nowIso(), attempts: (open.attempts || 1) + 1, code: rec.code || null }, false); return open.id; }
            }
            return kv.add(COL.errors, doc);
        },
        async listErrors(orgId, { includeResolved = false } = {}) {
            return (await kv.where(COL.errors, orgId)).filter((e) => includeResolved || !e.resolved).sort((a, b) => String(b.at).localeCompare(String(a.at)));
        },
        async getError(orgId, id) { const e = await kv.get(COL.errors, id); return e && e.orgId === orgId ? { id, ...e } : null; },
        async resolveErrors(orgId, scope, ref) {
            const open = (await kv.where(COL.errors, orgId)).filter((e) => !e.resolved && e.scope === scope && (ref === undefined || e.ref === ref));
            for (const e of open) { const { id, ...rest } = e; await kv.set(COL.errors, id, { ...rest, resolved: true, resolvedAt: nowIso() }, false); }
            return open.length;
        },

        /* events */
        async putEventIfNew(orgId, key, evt, source) {
            return kv.create(COL.events, `${orgId}__${key}`, { orgId, key, source, receivedAt: nowIso(), status: 'received', attempts: 0, nextAttemptAt: nowIso(), event: evt });
        },
        async getEvent(orgId, key) { const e = await kv.get(COL.events, `${orgId}__${key}`); return e || null; },
        async updateEvent(orgId, key, patch) { await kv.set(COL.events, `${orgId}__${key}`, patch, true); },
        async listEvents(orgId, status) { return (await kv.where(COL.events, orgId)).filter((e) => !status || e.status === status).sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt))); },

        /* payrolls */
        async getPayroll(orgId, uuid) { return kv.get(COL.payrolls, `${orgId}__${uuid}`); },
        async savePayroll(orgId, uuid, patch) { await kv.set(COL.payrolls, `${orgId}__${uuid}`, { orgId, payrollUuid: uuid, ...patch, updatedAt: nowIso() }, true); return kv.get(COL.payrolls, `${orgId}__${uuid}`); },
        /** Atomically move a payroll record from one of `fromStatuses` to a new status (guards double submit). Returns the record or null. */
        async claimPayroll(orgId, uuid, fromStatuses, patch) {
            return kv.transact(COL.payrolls, `${orgId}__${uuid}`, (cur) => {
                if (!cur || !fromStatuses.includes(cur.status)) return { result: null };
                const next = { ...cur, ...patch, updatedAt: nowIso() };
                return { write: next, result: next };
            });
        },
        async listPayrolls(orgId) { return (await kv.where(COL.payrolls, orgId)).sort((a, b) => String(b.periodStart || b.updatedAt).localeCompare(String(a.periodStart || a.updatedAt))); }
    };
    return store;
}

const createMemoryStore = () => createStore(memoryKv());
const createFirestoreStore = () => createStore(firestoreKv());

let shared = null;
/** The process-wide store (Firestore unless a test replaced it) */
function defaultStore() { if (!shared) shared = createFirestoreStore(); return shared; }
function setDefaultStore(s) { shared = s; }

module.exports = { COL, createStore, createMemoryStore, createFirestoreStore, defaultStore, setDefaultStore, deepMerge };
