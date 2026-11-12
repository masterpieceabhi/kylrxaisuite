/**
 * Integration administration for a company: API keys, OAuth apps and consent, webhooks (endpoints,
 * delivery log, replay), SCIM tokens, connectors (catalog, connections, mapping, sync, reconciliation),
 * settings and traffic. Mounted at /api/us/integrations. Read: integrations.view; write: integrations.manage.
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit } = require('./us-hr').helpers;
const { requirePermission } = require('../services/permissions');
const auth = require('../services/api-auth');
const webhooks = require('../services/webhooks');
const events = require('../services/events');
const registry = require('../services/connectors/registry');
const runtime = require('../services/connectors/runtime');
const scim = require('./scim');

router.use(verifyToken);

const view = [requirePermission('integrations.view'), requireUsOrg];
const manage = [requirePermission('integrations.manage'), requireUsOrg];
const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const bad = (res, errors, status = 400) => res.status(status).json({ success: false, errors: Array.isArray(errors) ? errors : [errors] });
const nf = (res, what = 'Not found') => res.status(404).json({ success: false, error: what });

/* ------------------------------- reference data ------------------------------- */

router.get('/meta', ...view, (req, res) => {
    res.json({ success: true, scopes: auth.SCOPES, events: events.CATALOG, note: 'Writes need the integrations.manage permission (super admin). Confirm data-sharing with your own compliance advisor.' });
});

router.get('/overview', ...view, async (req, res) => {
    const org = req.orgId;
    const since = new Date(Date.now() - 24 * 3600e3).toISOString();
    const [keys, apps, hooks, conns, tokens, log, dead, deadC] = await Promise.all([
        auth.listKeys(org), auth.listApps(org), webhooks.listEndpoints(org), runtime.listConnections(org), scim.tokens.listTokens(org),
        rawCollection('api_access_log').where('orgId', '==', org).get().then((s) => s.docs.map((d) => d.data()).filter((r) => r.at >= since)),
        webhooks.listDeliveries(org, { status: 'dead', limit: 500 }),
        Promise.all((await runtime.listConnections(org)).map((c) => runtime.listDeadLetters(org, c.id, 'open').then((l) => l.length)))
    ]);
    const byPrincipal = {};
    for (const r of log) { const p = (byPrincipal[r.principalName || r.principalId] = byPrincipal[r.principalName || r.principalId] || { requests: 0, errors: 0 }); p.requests += 1; if (r.status >= 400) p.errors += 1; }
    res.json({
        success: true,
        counts: { active_keys: keys.filter((k) => k.status === 'active').length, oauth_apps: apps.length, webhooks: hooks.length, connections: conns.length, scim_tokens: tokens.filter((t) => !t.revoked_at).length },
        api_last_24h: { requests: log.length, errors: log.filter((r) => r.status >= 400).length, rate_limited: log.filter((r) => r.status === 429).length, avg_ms: log.length ? Math.round(log.reduce((s, r) => s + (r.ms || 0), 0) / log.length) : 0, by_principal: byPrincipal },
        dead_letters: { webhook_deliveries: dead.length, connector_records: deadC.reduce((a, b) => a + b, 0) },
        connections: conns.map((c) => ({ id: c.id, name: c.name, connector: c.connector_name, status: c.status, last_status: c.last_status, last_run_at: c.last_run_at, health: c.health }))
    });
});

router.get('/settings', ...view, async (req, res) => {
    const s = await rawCollection('organizations').doc(req.orgId).get();
    const v = (exists(s) && s.data().integrationSettings) || {};
    res.json({ success: true, settings: { allowTimeWrite: v.allowTimeWrite === true } });
});
router.put('/settings', ...manage, async (req, res) => {
    const allowTimeWrite = Boolean(req.body && req.body.allowTimeWrite);
    await rawCollection('organizations').doc(req.orgId).set({ integrationSettings: { allowTimeWrite, updatedAt: new Date().toISOString(), updatedBy: req.user.id } }, { merge: true });
    audit(req.orgId, req, 'integration_settings_updated', req.orgId, { allowTimeWrite });
    res.json({ success: true, settings: { allowTimeWrite } });
});

router.get('/api-log', ...view, async (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const snap = await rawCollection('api_access_log').where('orgId', '==', req.orgId).get();
    const rows = snap.docs.map((d) => d.data()).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit)
        .map((r) => ({ at: r.at, principal: r.principalName || r.principalId, method: r.method, path: r.path, status: r.status, ms: r.ms, request_id: r.requestId }));
    res.json({ success: true, data: rows });
});

/* ---------------------------------- API keys ---------------------------------- */

router.get('/keys', ...view, async (req, res) => res.json({ success: true, data: await auth.listKeys(req.orgId) }));

router.post('/keys', ...manage, async (req, res) => {
    const r = await auth.createKey(req.orgId, req.body || {}, req.user.id);
    if (r.errors) return bad(res, r.errors);
    audit(req.orgId, req, 'integration_key_created', r.record.id, { name: r.record.name, scopes: r.record.scopes });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, key: r.key, record: r.record, note: 'Copy the key now. It is shown only once and cannot be recovered.' });
});

router.patch('/keys/:id', ...manage, async (req, res) => {
    const r = await auth.updateKey(req.orgId, req.params.id, req.body || {});
    if (r.notFound) return nf(res, 'Key not found');
    if (r.errors) return bad(res, r.errors);
    audit(req.orgId, req, 'integration_key_updated', req.params.id, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, record: r.record });
});

router.delete('/keys/:id', ...manage, async (req, res) => {
    const r = await auth.revokeKey(req.orgId, req.params.id);
    if (!r) return nf(res, 'Key not found');
    audit(req.orgId, req, 'integration_key_revoked', req.params.id, {});
    res.json({ success: true, record: r });
});

/* ----------------------------- OAuth apps and consent ----------------------------- */

router.get('/oauth/apps', ...view, async (req, res) => res.json({ success: true, data: await auth.listApps(req.orgId) }));

router.post('/oauth/apps', ...manage, async (req, res) => {
    const r = await auth.createApp(req.orgId, req.body || {}, req.user.id);
    if (r.errors) return bad(res, r.errors);
    audit(req.orgId, req, 'oauth_app_created', r.app.client_id, { name: r.app.name, type: r.app.type, scopes: r.app.scopes });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, app: r.app, client_secret: r.clientSecret, note: r.clientSecret ? 'Copy the client secret now. It is shown only once.' : 'Public client: it has no secret and must use PKCE.' });
});

router.post('/oauth/apps/:id/rotate-secret', ...manage, async (req, res) => {
    const secret = await auth.rotateAppSecret(req.orgId, req.params.id);
    if (!secret) return nf(res, 'App not found (or it is a public client)');
    audit(req.orgId, req, 'oauth_app_secret_rotated', req.params.id, {});
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, client_secret: secret });
});

router.patch('/oauth/apps/:id', ...manage, async (req, res) => {
    const ok = await auth.setAppActive(req.orgId, req.params.id, Boolean(req.body && req.body.active));
    if (!ok) return nf(res, 'App not found');
    audit(req.orgId, req, 'oauth_app_active_changed', req.params.id, { active: Boolean(req.body.active) });
    res.json({ success: true });
});

router.get('/oauth/grants', ...view, async (req, res) => res.json({ success: true, data: await auth.listGrants(req.orgId) }));

router.delete('/oauth/grants/:id', ...manage, async (req, res) => {
    const ok = await auth.revokeGrant(req.orgId, req.params.id);
    if (!ok) return nf(res, 'Grant not found');
    audit(req.orgId, req, 'oauth_grant_revoked', req.params.id, {});
    res.json({ success: true });
});

const authParams = (src) => ({ client_id: String(src.client_id || ''), redirect_uri: String(src.redirect_uri || ''), response_type: String(src.response_type || ''), scope: String(src.scope || ''), state: src.state ? String(src.state) : undefined, code_challenge: src.code_challenge ? String(src.code_challenge) : undefined, code_challenge_method: src.code_challenge_method ? String(src.code_challenge_method) : undefined });

/** What the consent page shows the admin before approving */
router.get('/oauth/authorize-info', ...manage, async (req, res) => {
    const d = await auth.describeAuthorization(authParams(req.query));
    if (d.error) return res.status(400).json({ success: false, error: d.error, error_description: d.description || null, can_redirect: Boolean(d.redirect) });
    res.json({ success: true, app: d.app, scopes: d.scopes, scope_descriptions: d.scopeDescriptions, company_id: req.orgId });
});

/** Approve or deny. Returns the URL the browser must go to (the app's redirect URI with code/state). */
router.post('/oauth/authorize', ...manage, async (req, res) => {
    const p = authParams(req.body || {});
    const decision = (req.body || {}).decision;
    const d = await auth.describeAuthorization(p);
    if (d.error && !d.redirect) return res.status(400).json({ success: false, error: d.error });
    const url = new URL(p.redirect_uri);
    if (p.state) url.searchParams.set('state', p.state);
    if (d.error) { url.searchParams.set('error', d.error); if (d.description) url.searchParams.set('error_description', d.description); return res.json({ success: true, redirect_url: url.toString() }); }
    if (decision !== 'approve') {
        url.searchParams.set('error', 'access_denied');
        audit(req.orgId, req, 'oauth_app_denied', p.client_id, {});
        return res.json({ success: true, redirect_url: url.toString() });
    }
    const a = await auth.approveAuthorization(req.orgId, req.user.id, p);
    if (a.error) return res.status(400).json({ success: false, error: a.error });
    url.searchParams.set('code', a.code);
    audit(req.orgId, req, 'oauth_app_approved', p.client_id, { scopes: d.scopes });
    res.json({ success: true, redirect_url: url.toString() });
});

/* ----------------------------------- webhooks ----------------------------------- */

router.get('/webhooks', ...view, async (req, res) => res.json({ success: true, data: await webhooks.listEndpoints(req.orgId) }));

router.post('/webhooks', ...manage, async (req, res) => {
    const b = req.body || {};
    const r = await webhooks.createEndpoint(req.orgId, { url: b.url, description: b.description, events: b.events, source: 'admin' }, req.user.id);
    if (r.errors) return bad(res, r.errors);
    audit(req.orgId, req, 'webhook_created', r.id, { host: new URL(b.url).host, events: r.endpoint.events });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, endpoint: r.endpoint, secret: r.secret, note: 'Copy the signing secret now. It is shown only once.' });
});

router.get('/webhooks/deliveries', ...view, async (req, res) => {
    res.json({ success: true, data: await webhooks.listDeliveries(req.orgId, { endpointId: req.query.endpointId, status: req.query.status, limit: Math.min(300, parseInt(req.query.limit, 10) || 100) }) });
});

router.post('/webhooks/deliveries/:id/replay', ...manage, async (req, res) => {
    const id = await webhooks.replay(req.orgId, req.params.id);
    if (!id) return nf(res, 'Delivery not found');
    webhooks.kick();
    audit(req.orgId, req, 'webhook_delivery_replayed', req.params.id, { newDelivery: id });
    res.status(201).json({ success: true, delivery_id: id });
});

router.patch('/webhooks/:id', ...manage, async (req, res) => {
    const r = await webhooks.updateEndpoint(req.orgId, req.params.id, req.body || {});
    if (r.notFound) return nf(res, 'Webhook not found');
    if (r.errors) return bad(res, r.errors);
    audit(req.orgId, req, 'webhook_updated', req.params.id, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, endpoint: r.endpoint });
});

router.delete('/webhooks/:id', ...manage, async (req, res) => {
    if (!(await webhooks.deleteEndpoint(req.orgId, req.params.id))) return nf(res, 'Webhook not found');
    audit(req.orgId, req, 'webhook_deleted', req.params.id, {});
    res.json({ success: true });
});

router.post('/webhooks/:id/rotate-secret', ...manage, async (req, res) => {
    const r = await webhooks.rotateSecret(req.orgId, req.params.id);
    if (r.notFound) return nf(res, 'Webhook not found');
    audit(req.orgId, req, 'webhook_secret_rotated', req.params.id, {});
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, secret: r.secret, previous_secret_expires_at: r.previous_secret_expires_at, note: 'Deliveries are signed with both secrets until the old one expires, so you can switch your receiver without downtime.' });
});

router.post('/webhooks/:id/test', ...manage, async (req, res) => {
    const id = await webhooks.sendTest(req.orgId, req.params.id);
    if (!id) return nf(res, 'Webhook not found');
    res.status(202).json({ success: true, delivery_id: id });
});

router.post('/webhooks/:id/replay-dead-letters', ...manage, async (req, res) => {
    const n = await webhooks.replayDeadLetters(req.orgId, req.params.id);
    webhooks.kick();
    audit(req.orgId, req, 'webhook_dead_letters_replayed', req.params.id, { count: n });
    res.json({ success: true, requeued: n });
});

/* ------------------------------------ SCIM ------------------------------------ */

router.get('/scim/tokens', ...view, async (req, res) => res.json({ success: true, data: await scim.tokens.listTokens(req.orgId), base_path: '/scim/v2' }));

router.post('/scim/tokens', ...manage, async (req, res) => {
    const t = await scim.tokens.createToken(req.orgId, (req.body || {}).name, req.user.id);
    audit(req.orgId, req, 'scim_token_created', t.id, { name: (req.body || {}).name || null });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, token: t.token, id: t.id, base_path: '/scim/v2', note: 'Copy the token now. It is shown only once.' });
});

router.delete('/scim/tokens/:id', ...manage, async (req, res) => {
    if (!(await scim.tokens.revokeToken(req.orgId, req.params.id))) return nf(res, 'Token not found');
    audit(req.orgId, req, 'scim_token_revoked', req.params.id, {});
    res.json({ success: true });
});

/* --------------------------------- connectors --------------------------------- */

router.get('/connectors/catalog', ...view, (req, res) => res.json({ success: true, data: registry.catalog() }));

router.get('/connectors/connections', ...view, async (req, res) => res.json({ success: true, data: await runtime.listConnections(req.orgId) }));

router.post('/connectors/connections', ...manage, async (req, res) => {
    const r = await runtime.createConnection(req.orgId, req.body || {}, req.user.id);
    if (r.errors) return bad(res, r.errors);
    audit(req.orgId, req, 'connector_created', r.id, { connector: r.connection.connector });
    res.status(201).json({ success: true, connection: r.connection });
});

router.get('/connectors/connections/:id', ...view, async (req, res) => {
    const raw = await runtime.loadRaw(req.orgId, req.params.id);
    if (!raw) return nf(res, 'Connection not found');
    res.json({ success: true, connection: runtime.publicConnection(raw.id, raw.data) });
});

router.patch('/connectors/connections/:id', ...manage, async (req, res) => {
    const r = await runtime.updateConnection(req.orgId, req.params.id, req.body || {});
    if (r.notFound) return nf(res, 'Connection not found');
    if (r.errors) return bad(res, r.errors);
    audit(req.orgId, req, 'connector_updated', req.params.id, { fields: Object.keys(req.body || {}).filter((k) => k !== 'credentials') });
    res.json({ success: true, connection: r.connection });
});

router.delete('/connectors/connections/:id', ...manage, async (req, res) => {
    if (!(await runtime.deleteConnection(req.orgId, req.params.id))) return nf(res, 'Connection not found');
    audit(req.orgId, req, 'connector_deleted', req.params.id, {});
    res.json({ success: true });
});

router.post('/connectors/connections/:id/test', ...manage, async (req, res) => {
    const r = await runtime.healthCheck(req.orgId, req.params.id);
    if (r.notFound) return nf(res, 'Connection not found');
    res.json({ success: true, health: r.health });
});

router.post('/connectors/connections/:id/test-event', ...manage, async (req, res) => {
    const r = await runtime.sendTestEvent(req.orgId, req.params.id);
    if (r.notFound) return nf(res, 'Connection not found');
    if (r.error) return res.status(409).json({ success: false, error: r.error });
    res.json({ success: r.ok, ...(r.ok ? {} : { error: r.error }) });
});

router.post('/connectors/connections/:id/sync', ...manage, async (req, res) => {
    const r = await runtime.runConnection(req.orgId, req.params.id, { trigger: 'manual' });
    if (r.notFound) return nf(res, 'Connection not found');
    if (r.error) return res.status(409).json({ success: false, error: r.error });
    audit(req.orgId, req, 'connector_sync_run', req.params.id, { status: r.run.status });
    res.json({ success: true, run: r.run });
});

router.get('/connectors/connections/:id/runs', ...view, async (req, res) => {
    if (!(await runtime.loadRaw(req.orgId, req.params.id))) return nf(res, 'Connection not found');
    res.json({ success: true, data: await runtime.listRuns(req.orgId, req.params.id) });
});

router.get('/connectors/connections/:id/errors', ...view, async (req, res) => {
    if (!(await runtime.loadRaw(req.orgId, req.params.id))) return nf(res, 'Connection not found');
    res.json({ success: true, data: await runtime.listDeadLetters(req.orgId, req.params.id, req.query.status || 'open') });
});

router.post('/connectors/connections/:id/errors/:dl/retry', ...manage, async (req, res) => {
    const r = await runtime.retryDeadLetter(req.orgId, req.params.id, req.params.dl);
    if (r.notFound) return nf(res, 'Error record not found');
    res.json({ success: true, ok: r.ok, error: r.error || null });
});

router.get('/connectors/connections/:id/reconciliation', ...view, async (req, res) => {
    const r = await runtime.reconcileConnection(req.orgId, req.params.id);
    if (r.notFound) return nf(res, 'Connection not found');
    res.json({ success: true, report: r.report });
});

router.get('/connectors/connections/:id/logs', ...view, async (req, res) => {
    if (!(await runtime.loadRaw(req.orgId, req.params.id))) return nf(res, 'Connection not found');
    res.json({ success: true, data: await runtime.listLogs(req.orgId, req.params.id) });
});

/** Shows what a mapping produces for a sample record (the editor's live preview) */
router.post('/connectors/connections/:id/mapping/preview', ...view, async (req, res) => {
    const raw = await runtime.loadRaw(req.orgId, req.params.id);
    if (!raw) return nf(res, 'Connection not found');
    const b = req.body || {};
    const sample = b.record || (await runtime.sourcesFor(req.orgId).people({}, {})).slice(0, 1)[0] || {};
    const r = runtime.previewMapping(raw.data.connectorKey, b.entity, sample, b.rules !== undefined ? b.rules : (raw.data.mapping || {})[b.entity]);
    res.json({ success: true, sample_record_id: sample.id || null, ...r });
});

// Background workers: webhook delivery and scheduled connector syncs
if (process.env.INTEGRATION_WORKERS !== 'off' && process.env.NODE_ENV !== 'test') {
    webhooks.start({ intervalMs: Number(process.env.WEBHOOK_TICK_MS) || 5000 });
    runtime.startScheduler({ intervalMs: Number(process.env.CONNECTOR_TICK_MS) || 60000 });
}

module.exports = router;
