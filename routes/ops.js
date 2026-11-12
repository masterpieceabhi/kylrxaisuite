/**
 * Operations endpoints (mounted at /api, NOT behind the customer login):
 *   GET  /api/health/deep            monitoring token or platform operator
 *   GET  /api/metrics                Prometheus text, monitoring token or platform operator
 *   GET  /api/status                 public: component status + incident notes
 *   POST /api/status/incidents       platform operator: create/update an incident note
 *   POST /api/billing/webhook        payment provider webhooks (signature + idempotent)
 *   /api/platform/billing/*          platform operator only: cross-customer summary, plan catalog, billing run, credits
 *   POST /api/platform/retention/run platform operator: run retention jobs across all companies
 * (/api/health stays in server.js.)
 */
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const metrics = require('../services/metrics');
const { requireOperator } = require('../services/platform-auth');
const billing = require('../services/billing-service');
const R = require('../services/billing-rules');
const { getProvider } = require('../services/billing-stripe');
const pkg = require('../package.json');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms} ms`)), ms))]);

/* ----------------------------------- health ----------------------------------- */
async function timed(fn) {
    const t = Date.now();
    try { const detail = await fn(); return { status: 'ok', ms: Date.now() - t, ...(detail || {}) }; }
    catch (e) { return { status: 'fail', ms: Date.now() - t, error: e.message }; }
}

async function checkFirestore() {
    await withTimeout(rawCollection('organizations').limit(1).get(), 4000, 'Firestore read');
}

async function checkAuth() {
    const { admin } = require('../config/firebase');
    if (!admin || !admin.apps.length) throw new Error('Firebase Admin is not initialised');
    await withTimeout(admin.auth().listUsers(1), 4000, 'Auth list');
}

async function checkVault() {
    const { ROOT } = require('../services/file-store');
    await fs.promises.mkdir(ROOT, { recursive: true });
    const probe = path.join(ROOT, `.health-${process.pid}-${Date.now()}`);
    await fs.promises.writeFile(probe, 'ok');
    await fs.promises.rm(probe, { force: true });
    return { path: path.basename(ROOT) };
}

async function checkDisk() {
    const { ROOT } = require('../services/file-store');
    const target = fs.existsSync(ROOT) ? ROOT : os.tmpdir();
    const s = await fs.promises.statfs(target);
    const total = Number(s.blocks) * Number(s.bsize); const free = Number(s.bavail) * Number(s.bsize);
    const freePct = total ? Math.round((free / total) * 1000) / 10 : null;
    const freeMb = Math.round(free / 1048576);
    if (freePct !== null && (freePct < 2 || freeMb < 200)) throw new Error(`Only ${freeMb} MB (${freePct}%) free`);
    return { freeMb, freePct, warn: freePct !== null && freePct < 10 };
}

async function checkClock() {
    const { admin } = require('../config/firebase');
    const ref = rawCollection('system_config').doc('health_probe');
    const before = Date.now();
    await withTimeout(ref.set({ at: admin.firestore.FieldValue.serverTimestamp() }), 4000, 'Clock probe write');
    const snap = await ref.get();
    const after = Date.now();
    const server = snap.data().at.toMillis();
    const skewMs = Math.round(((before + after) / 2) - server);
    if (Math.abs(skewMs) > 30000) throw new Error(`Clock is ${skewMs} ms away from the database clock`);
    return { skewMs, warn: Math.abs(skewMs) > 5000 };
}

const buildInfo = () => ({ version: pkg.version, build: process.env.BUILD_ID || process.env.GIT_SHA || 'local', node: process.version, env: process.env.NODE_ENV || 'development', uptimeSeconds: Math.round(process.uptime()), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() });

async function deepHealth() {
    const [firestore, auth, vault, disk, clock] = await Promise.all([timed(checkFirestore), timed(checkAuth), timed(checkVault), timed(checkDisk), timed(checkClock)]);
    const checks = { firestore, auth, vault, disk, clock };
    const failed = Object.values(checks).some((c) => c.status === 'fail');
    const warned = Object.values(checks).some((c) => c.warn);
    return { status: failed ? 'fail' : (warned ? 'degraded' : 'ok'), timestamp: new Date().toISOString(), build: buildInfo(), checks };
}

router.get('/health/deep', requireOperator({ allowMonitoring: true }), async (req, res) => {
    const h = await deepHealth();
    res.status(h.status === 'fail' ? 503 : 200).json({ success: h.status !== 'fail', ...h });
});

router.get('/metrics', requireOperator({ allowMonitoring: true }), async (req, res) => {
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').send(await metrics.render());
});

/* ----------------------------------- public status ----------------------------------- */
const STATUS_DOC = () => rawCollection('system_config').doc('platform_status');
const IMPACT = ['none', 'minor', 'major', 'critical'];
const PHASES = ['investigating', 'identified', 'monitoring', 'resolved'];
let statusCache = { at: 0, value: null };

async function liveComponents() {
    if (statusCache.value && Date.now() - statusCache.at < 30000) return statusCache.value;
    const [db, vault] = await Promise.all([timed(checkFirestore), timed(checkVault)]);
    const map = (c) => (c.status === 'ok' ? 'operational' : 'outage');
    const value = [
        { key: 'api', name: 'Application and API', status: 'operational' },
        { key: 'database', name: 'Database', status: map(db) },
        { key: 'documents', name: 'Document storage', status: map(vault) },
        { key: 'payments', name: 'Billing and payments', status: getProvider().name === 'mock' ? 'operational' : 'operational' }
    ];
    statusCache = { at: Date.now(), value };
    return value;
}

router.get('/status', async (req, res) => {
    let incidents = [];
    try { const s = await STATUS_DOC().get(); if (exists(s)) incidents = s.data().incidents || []; } catch (e) { logger.warn(`Status doc read failed: ${e.message}`); }
    const components = (await liveComponents()).map((c) => ({ ...c }));
    const active = incidents.filter((i) => i.status !== 'resolved');
    const rank = { none: 0, minor: 1, major: 2, critical: 3 };
    for (const inc of active) for (const key of inc.components || []) {
        const c = components.find((x) => x.key === key);
        if (c && inc.impact !== 'none') { const level = inc.impact === 'minor' ? 'degraded' : (inc.impact === 'major' ? 'partial_outage' : 'outage'); if (c.status === 'operational' || (rank[inc.impact] >= 2 && c.status === 'degraded')) c.status = level; }
    }
    const worst = components.some((c) => c.status === 'outage') ? 'outage' : (components.some((c) => c.status !== 'operational') ? 'degraded' : 'operational');
    res.set('Cache-Control', 'public, max-age=15');
    res.json({ success: true, overall: worst, components, incidents: incidents.slice(0, 10), generatedAt: new Date().toISOString() });
});

router.post('/status/incidents', requireOperator(), async (req, res) => {
    const b = req.body || {};
    const title = String(b.title || '').trim().slice(0, 120);
    if (!title) return res.status(400).json({ success: false, error: 'title is required' });
    if (!PHASES.includes(b.status)) return res.status(400).json({ success: false, error: `status must be one of ${PHASES.join(', ')}` });
    if (!IMPACT.includes(b.impact)) return res.status(400).json({ success: false, error: `impact must be one of ${IMPACT.join(', ')}` });
    const snap = await STATUS_DOC().get();
    const incidents = exists(snap) ? (snap.data().incidents || []) : [];
    const at = new Date().toISOString();
    const note = String(b.body || '').trim().slice(0, 1000);
    let inc = b.id ? incidents.find((i) => i.id === b.id) : null;
    if (b.id && !inc) return res.status(404).json({ success: false, error: 'Incident not found' });
    if (!inc) { inc = { id: `inc_${Date.now().toString(36)}`, startedAt: at, updates: [] }; incidents.unshift(inc); }
    Object.assign(inc, { title, status: b.status, impact: b.impact, components: Array.isArray(b.components) ? b.components.filter((c) => /^[a-z_]{2,20}$/.test(c)) : (inc.components || []) });
    if (b.status === 'resolved') inc.resolvedAt = at;
    inc.updates.push({ at, status: b.status, body: note });
    await STATUS_DOC().set({ incidents: incidents.slice(0, 50), updatedAt: at }, { merge: true });
    statusCache = { at: 0, value: null };
    logger.info(`Status incident ${inc.id} ${b.status} by ${req.operator.via}`);
    res.status(201).json({ success: true, incident: inc });
});

/* ----------------------------------- payment webhook ----------------------------------- */
router.post('/billing/webhook', async (req, res) => {
    const raw = req.rawBody;
    if (typeof raw !== 'string' || !raw) return res.status(400).json({ success: false, error: 'Empty body' });
    let evt;
    try { evt = getProvider().verifyWebhook(raw, req.headers['stripe-signature']); }
    catch (e) { logger.warn(`Billing webhook rejected: ${e.message}`); return res.status(400).json({ success: false, error: 'Invalid signature' }); }
    try {
        const r = await billing.handleWebhookEvent(evt);
        res.json({ success: true, received: true, duplicate: Boolean(r.duplicate), handled: Boolean(r.handled) });
    } catch (e) {
        logger.error(`Billing webhook processing failed: ${e.message}`);
        res.status(e.statusCode || 500).json({ success: false, error: 'Could not process the event' });
    }
});

/* ----------------------------------- platform operator: billing ----------------------------------- */
const op = requireOperator();

router.get('/platform/billing/summary', op, async (req, res) => {
    res.json({ success: true, ...(await billing.platformSummary()) });
});

router.get('/platform/billing/plans', op, async (req, res) => {
    const c = await billing.loadPlans({ includeInactive: true });
    res.json({ success: true, plans: c.plans, dunning: c.dunning });
});

router.put('/platform/billing/plans', op, async (req, res) => {
    const list = Array.isArray(req.body.plans) ? req.body.plans : null;
    if (!list || !list.length) return res.status(400).json({ success: false, error: 'plans must be a non-empty list' });
    const errors = []; const plans = [];
    list.forEach((p, i) => { const r = R.validatePlan(p); if (r.errors.length) errors.push(...r.errors.map((e) => `plan ${i + 1}: ${e}`)); else plans.push(r.value); });
    if (new Set(plans.map((p) => p.id)).size !== plans.length) errors.push('plan ids must be unique');
    let dunning;
    if (req.body.dunning) {
        const d = req.body.dunning;
        if (!Array.isArray(d.retryAfterDays) || !d.retryAfterDays.every((n) => Number.isInteger(n) && n > 0) || !Number.isInteger(d.graceDays) || d.graceDays < 1 || d.graceDays > 90) errors.push('dunning needs retryAfterDays (list of days) and graceDays (1-90)');
        else dunning = { retryAfterDays: d.retryAfterDays, graceDays: d.graceDays, reminderEmailDays: Array.isArray(d.reminderEmailDays) ? d.reminderEmailDays.filter(Number.isInteger) : R.DEFAULT_DUNNING.reminderEmailDays };
    }
    if (errors.length) return res.status(400).json({ success: false, errors });
    await billing.savePlans(plans, dunning, req.operator.id || 'token');
    res.json({ success: true, plans });
});

router.post('/platform/billing/run', op, async (req, res) => {
    const today = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.today || '')) ? req.body.today : undefined;
    res.json({ success: true, result: await billing.runCycle(today, { dryRun: req.body.dryRun !== false }), note: 'Dry run unless dryRun is false' });
});

router.post('/platform/billing/accounts/:orgId/credit', op, async (req, res) => {
    const cents = Number(req.body.amountCents);
    if (!Number.isInteger(cents) || cents === 0 || Math.abs(cents) > 10000000) return res.status(400).json({ success: false, error: 'amountCents must be a non-zero whole number' });
    if (String(req.body.reason || '').trim().length < 5) return res.status(400).json({ success: false, error: 'A reason is required' });
    const a = await billing.getAccount(String(req.params.orgId));
    if (!a) return res.status(404).json({ success: false, error: 'No billing account' });
    await billing.saveAccount(a.orgId, { creditCents: Math.max(0, (a.creditCents || 0) + cents) });
    await billing.logEvent(a.orgId, 'operator_credit', { amountCents: cents, reason: String(req.body.reason).slice(0, 200), by: req.operator.via });
    res.json({ success: true, creditCents: Math.max(0, (a.creditCents || 0) + cents) });
});

router.post('/platform/retention/run', op, async (req, res) => {
    const jobs = require('../services/retention-jobs');
    const dryRun = req.body.dryRun !== false;
    res.json({ success: true, dryRun, result: await jobs.runAllOrgs({ dryRun, keys: Array.isArray(req.body.keys) ? req.body.keys : undefined, actor: 'platform-operator' }) });
});

module.exports = router;
module.exports.helpers = { deepHealth, buildInfo };
