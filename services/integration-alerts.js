/**
 * Integration alerts: storage for the rules in integration-alert-rules.js.
 * Collection `integration_alerts` (every doc has orgId). Thresholds live in organizations/{orgId}.integrationSettings.alerts.
 * The record functions never throw: an alert problem must not break a sync run or a webhook delivery.
 */
const { rawCollection } = require('../config/firebase');
const R = require('./integration-alert-rules');
const logger = require('../utils/logger');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const nowIso = () => new Date().toISOString();
const col = () => rawCollection('integration_alerts');

async function getSettings(orgId) {
    const s = await rawCollection('organizations').doc(orgId).get();
    return R.normalizeSettings(exists(s) ? ((s.data().integrationSettings || {}).alerts) : null);
}

async function saveSettings(orgId, input, actor) {
    const { errors, value } = R.validateSettings(input, await getSettings(orgId));
    if (errors.length) return { errors };
    await rawCollection('organizations').doc(orgId).set({ integrationSettings: { alerts: { ...value, updatedAt: nowIso(), updatedBy: actor || null } } }, { merge: true });
    return { settings: value };
}

/** The alert for this source that is not resolved yet, or null */
async function activeFor(orgId, kind, sourceId) {
    const snap = await col().where('orgId', '==', orgId).where('sourceId', '==', String(sourceId)).get();
    const hit = snap.docs.filter((d) => d.data().kind === kind && d.data().status !== 'resolved').sort((a, b) => String(b.data().raisedAt).localeCompare(String(a.data().raisedAt)))[0];
    return hit ? { id: hit.id, ref: hit.ref, data: hit.data() } : null;
}

/** Applies one result. Returns { action, id } (action: none, raise, update or resolve). */
async function record(orgId, { kind, sourceId, sourceName, failures, detail }) {
    const [settings, active] = await Promise.all([getSettings(orgId), activeFor(orgId, kind, sourceId)]);
    const d = R.decide({ kind, failures, settings, active: active && active.data });
    const at = nowIso();
    if (d.action === 'raise') {
        const ref = await col().add(R.buildAlert({ orgId, kind, sourceId, sourceName, failures, threshold: R.thresholdFor(kind, settings), detail, now: at }));
        return { action: 'raise', id: ref.id };
    }
    if (d.action === 'update') { await active.ref.update({ failures, lastSeenAt: at, lastError: R.safeText(detail), sourceName: R.safeText(sourceName, 120) || active.data.sourceName }); return { action: 'update', id: active.id }; }
    if (d.action === 'resolve') { await active.ref.update({ status: 'resolved', resolvedAt: at }); return { action: 'resolve', id: active.id }; }
    return { action: 'none', id: null };
}

const quiet = (what, p) => p.catch((e) => { logger.error(`Integration alert (${what}) failed: ${e.message}`); return { action: 'none', id: null }; });

/** After a connector sync run. `streak` is the failed-runs-in-a-row count including this run. */
function recordSyncResult(orgId, conn, streak, detail) {
    return quiet('sync', record(orgId, { kind: 'connector_sync', sourceId: conn.id, sourceName: conn.name, failures: streak, detail }));
}

/** After a webhook delivery attempt. `failures` is the endpoint's failed-attempts-in-a-row count. */
function recordWebhookResult(orgId, endpoint, failures, detail) {
    return quiet('webhook', record(orgId, { kind: 'webhook_endpoint', sourceId: endpoint.id, sourceName: R.hostOf(endpoint.url), failures, detail }));
}

/** When a connection or endpoint is deleted, its alert has nothing left to point at */
function resolveForSource(orgId, kind, sourceId) {
    return quiet('cleanup', record(orgId, { kind, sourceId, failures: 0 }));
}

/** status: active (default: open or acknowledged), open, acknowledged, resolved or all */
async function list(orgId, { status = 'active' } = {}) {
    const snap = await col().where('orgId', '==', orgId).get();
    let rows = snap.docs.map((d) => R.publicAlert(d.id, d.data()));
    if (status && status !== 'all') rows = rows.filter((a) => (status === 'active' ? a.status !== 'resolved' : a.status === status));
    return R.sortAlerts(rows).slice(0, 200);
}

/** Returns { alert } | { notFound } | { conflict } | { errors } */
async function acknowledge(orgId, id, actor, input) {
    const { errors, value } = R.validateAcknowledge(input);
    if (errors.length) return { errors };
    const ref = col().doc(String(id)); const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== orgId) return { notFound: true };
    const ok = R.canAcknowledge(snap.data());
    if (!ok.ok) return { conflict: ok.error };
    const patch = { status: 'acknowledged', acknowledgedAt: nowIso(), acknowledgedBy: actor || null, acknowledgeNote: value.note };
    await ref.update(patch);
    return { alert: R.publicAlert(snap.id, { ...snap.data(), ...patch }) };
}

module.exports = { getSettings, saveSettings, activeFor, record, recordSyncResult, recordWebhookResult, resolveForSource, list, acknowledge };
