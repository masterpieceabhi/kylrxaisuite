/**
 * Integration alerts (pure rules). An alert is raised when
 *   - a connector's sync run fails N times in a row (default 3), or
 *   - a webhook endpoint fails N delivery attempts in a row (default 5).
 * One alert per source at a time: more failures update the same alert instead of adding new ones.
 * States: open -> acknowledged -> resolved, or open -> resolved. An alert resolves by itself when the
 * source works again. Shown on the Integrations page; nothing is e-mailed.
 */
const KINDS = ['connector_sync', 'webhook_endpoint'];
const STATES = ['open', 'acknowledged', 'resolved'];
const DEFAULT_SETTINGS = { enabled: true, syncFailures: 3, webhookFailures: 5 };
const MIN_THRESHOLD = 1; const MAX_THRESHOLD = 50;

/** Settings stored for a company -> complete, safe settings */
function normalizeSettings(stored) {
    const s = stored && typeof stored === 'object' ? stored : {};
    const n = (v, d) => (Number.isInteger(v) && v >= MIN_THRESHOLD && v <= MAX_THRESHOLD ? v : d);
    return { enabled: s.enabled !== false, syncFailures: n(s.syncFailures, DEFAULT_SETTINGS.syncFailures), webhookFailures: n(s.webhookFailures, DEFAULT_SETTINGS.webhookFailures) };
}

/** Validates a settings change from the page. Only the fields that are sent are changed. */
function validateSettings(input, current) {
    const b = input && typeof input === 'object' ? input : {};
    const value = { ...normalizeSettings(current) }; const errors = [];
    if (b.enabled !== undefined) { if (typeof b.enabled !== 'boolean') errors.push('enabled must be true or false'); else value.enabled = b.enabled; }
    for (const [key, label] of [['syncFailures', 'Failed sync runs in a row'], ['webhookFailures', 'Failed webhook attempts in a row']]) {
        if (b[key] === undefined) continue;
        const v = Number(b[key]);
        if (!Number.isInteger(v) || v < MIN_THRESHOLD || v > MAX_THRESHOLD) errors.push(`${label} must be a whole number from ${MIN_THRESHOLD} to ${MAX_THRESHOLD}`); else value[key] = v;
    }
    return { errors, value };
}

/**
 * Failed-runs-in-a-row counter for a connector. A run that fails outright adds one; a run that fully
 * works clears it; a partly successful run changes nothing (some records went through, so the
 * connection itself works, and the records that did not are listed under the connection's errors).
 */
function nextSyncStreak(previous, runStatus) {
    const prev = Number.isInteger(previous) && previous > 0 ? previous : 0;
    if (runStatus === 'failed') return prev + 1;
    if (runStatus === 'success') return 0;
    return prev;
}

const thresholdFor = (kind, settings) => (kind === 'webhook_endpoint' ? normalizeSettings(settings).webhookFailures : normalizeSettings(settings).syncFailures);

/**
 * What to do after a result. `active` is the alert for this source that is not resolved yet (or null).
 * Returns { action: 'none' | 'raise' | 'update' | 'resolve' }.
 */
function decide({ kind, failures, settings, active }) {
    const s = normalizeSettings(settings);
    const count = Number.isInteger(failures) && failures > 0 ? failures : 0;
    if (count === 0) return { action: active ? 'resolve' : 'none' };
    if (active) return { action: 'update' };
    if (!s.enabled) return { action: 'none' };
    return { action: count >= thresholdFor(kind, s) ? 'raise' : 'none' };
}

/** Removes anything that looks like a credential and keeps the text short */
const safeText = (s, max = 300) => String(s === undefined || s === null ? '' : s)
    .replace(/(Bearer\s+)[\w.\-]+/gi, '$1***').replace(/(password|secret|token|key)(["':= ]+)[^\s"',}]+/gi, '$1$2***').replace(/[\r\n\t]+/g, ' ').slice(0, max);

/** Host only: a webhook address can carry a secret in its path or query */
function hostOf(url) { try { return new URL(String(url)).host; } catch (_) { return 'unknown address'; } }

/** The record stored for a new alert */
function buildAlert({ orgId, kind, sourceId, sourceName, failures, threshold, detail, now }) {
    if (!KINDS.includes(kind)) throw new Error(`unknown alert kind ${kind}`);
    const at = now || new Date().toISOString();
    return {
        orgId, kind, sourceId: String(sourceId), sourceName: safeText(sourceName, 120) || String(sourceId), status: 'open',
        failures, threshold, lastError: safeText(detail), raisedAt: at, lastSeenAt: at,
        acknowledgedAt: null, acknowledgedBy: null, acknowledgeNote: null, resolvedAt: null
    };
}

/** Plain-words title and text for the page */
function describe(alert) {
    const n = alert.failures;
    if (alert.kind === 'webhook_endpoint') {
        return { title: `Webhook to ${alert.sourceName} keeps failing`, message: `${n} delivery attempts in a row have failed. Check that the receiving address is up and answers with a 2xx status. Events are kept and retried.` };
    }
    return { title: `Sync for "${alert.sourceName}" keeps failing`, message: `${n} sync runs in a row have failed. Open the connection, use "Test connection", and check its credentials and error list.` };
}

/** Public view (no orgId) with the plain-words text */
function publicAlert(id, a) {
    return {
        id, kind: a.kind, source_id: a.sourceId, source_name: a.sourceName, status: a.status, failures: a.failures, threshold: a.threshold,
        last_error: a.lastError || null, raised_at: a.raisedAt, last_seen_at: a.lastSeenAt, acknowledged_at: a.acknowledgedAt || null,
        acknowledged_by: a.acknowledgedBy || null, acknowledge_note: a.acknowledgeNote || null, resolved_at: a.resolvedAt || null, ...describe(a)
    };
}

/** Can this alert be acknowledged? Returns { ok } or { ok:false, error } (a state conflict) */
function canAcknowledge(alert) {
    if (alert.status === 'open') return { ok: true };
    return { ok: false, error: alert.status === 'acknowledged' ? 'This alert was already acknowledged' : 'This alert is already resolved' };
}

function validateAcknowledge(input) {
    const note = String((input && input.note) || '').trim();
    if (note.length > 300) return { errors: ['note can be at most 300 characters'], value: null };
    return { errors: [], value: { note: note || null } };
}

/** Open first, then acknowledged, then resolved; newest first inside each group */
function sortAlerts(list) {
    const rank = { open: 0, acknowledged: 1, resolved: 2 };
    return [...list].sort((a, b) => (rank[a.status] - rank[b.status]) || String(b.last_seen_at || b.lastSeenAt).localeCompare(String(a.last_seen_at || a.lastSeenAt)));
}

module.exports = {
    KINDS, STATES, DEFAULT_SETTINGS, MIN_THRESHOLD, MAX_THRESHOLD, normalizeSettings, validateSettings, nextSyncStreak, thresholdFor, decide,
    safeText, hostOf, buildAlert, describe, publicAlert, canAcknowledge, validateAcknowledge, sortAlerts
};
