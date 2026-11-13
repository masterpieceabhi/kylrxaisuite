/**
 * Firestore persistence for the connector runtime (see sync-engine.js for the interface).
 * Collections (every doc has orgId): connector_connections, connector_sync_state, connector_dead_letters,
 * connector_runs, connector_logs.
 */
const crypto = require('crypto');
const { rawCollection } = require('../../config/firebase');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const stateId = (c, e, r) => crypto.createHash('sha256').update(`${c}|${e}|${r}`).digest('hex');
const nowIso = () => new Date().toISOString();

function syncStore(orgId) {
    return {
        async getState(connId, entity, recordId) {
            const s = await rawCollection('connector_sync_state').doc(stateId(connId, entity, recordId)).get();
            return exists(s) && s.data().orgId === orgId ? s.data() : null;
        },
        async putState(connId, entity, recordId, patch) {
            const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
            await rawCollection('connector_sync_state').doc(stateId(connId, entity, recordId)).set({ orgId, connectionId: connId, entity, recordId, updatedAt: nowIso(), ...clean }, { merge: true });
        },
        async listStates(connId, entity) {
            const q = await rawCollection('connector_sync_state').where('connectionId', '==', connId).get();
            return q.docs.map((d) => d.data()).filter((d) => d.orgId === orgId && d.entity === entity);
        },
        async addDeadLetter(connId, d) {
            await rawCollection('connector_dead_letters').add({ orgId, connectionId: connId, status: 'open', createdAt: nowIso(), ...d, payload: d.payload === undefined ? null : d.payload });
        },
        async resolveDeadLetters(connId, entity, recordId) {
            const q = await rawCollection('connector_dead_letters').where('connectionId', '==', connId).get();
            await Promise.all(q.docs.filter((d) => d.data().orgId === orgId && d.data().entity === entity && d.data().recordId === recordId && d.data().status === 'open').map((d) => d.ref.update({ status: 'resolved', resolvedAt: nowIso() })));
        },
        async listDeadLetters(connId, { status } = {}) {
            const q = await rawCollection('connector_dead_letters').where('connectionId', '==', connId).get();
            return q.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.orgId === orgId && (!status || d.status === status)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        }
    };
}

async function log(orgId, connId, level, message) {
    try { await rawCollection('connector_logs').add({ orgId, connectionId: connId, level, message: String(message).slice(0, 500), at: nowIso() }); } catch (_) { /* logging must not break a run */ }
}

async function listLogs(orgId, connId, limit = 100) {
    const q = await rawCollection('connector_logs').where('connectionId', '==', connId).get();
    return q.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.orgId === orgId).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

module.exports = { syncStore, log, listLogs, stateId };
