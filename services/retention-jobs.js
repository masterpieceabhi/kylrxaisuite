/**
 * Data retention jobs: a registry plus built-in jobs. Every job supports dry-run (the default for callers)
 * and returns { scanned, eligible, affected, sample[] }. Nothing is deleted unless dryRun === false.
 *
 * Other modules add jobs without editing this file:
 *   require('./retention-jobs').register({
 *     key: 'punch_photos', label: 'Expired punch photos', description: '...',
 *     run: async ({ orgId, dryRun, nowIso, todayIso }) => ({ scanned, eligible, affected, sample: [] })
 *   });
 * `orgId === null` means "records not tied to a company" (platform-run only).
 */
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const V = require('./vault-rules');
const store = require('./file-store');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const registry = new Map();

function register(job) {
    if (!job || !/^[a-z0-9_]{2,40}$/.test(job.key || '') || typeof job.run !== 'function') throw new Error('A retention job needs a key and a run function');
    registry.set(job.key, { label: job.key, description: '', installed: true, ...job });
}

const list = () => [...registry.values()].map(({ key, label, description, installed, orgScoped }) => ({ key, label, description, installed: installed !== false, orgScoped: orgScoped !== false }));

const result = (over = {}) => ({ scanned: 0, eligible: 0, affected: 0, sample: [], ...over });

/* ------------------------------ built-in jobs ------------------------------ */

register({
    key: 'vault_expired_docs', label: 'Expired vault documents',
    description: 'Deletes vault documents whose retention date has passed, unless a legal hold is on them (same rule as manual deletion).',
    async run({ orgId, dryRun, nowIso, todayIso, actor }) {
        if (!orgId) return result();
        const snap = await rawCollection('vault_documents').where('orgId', '==', orgId).get();
        const out = result();
        for (const d of snap.docs) {
            const doc = d.data(); if (doc.deleted) continue;
            out.scanned += 1;
            if (!doc.retainUntil) continue; // no retention date = never auto-deleted
            if (!V.deletionCheck(doc, todayIso).ok) continue;
            out.eligible += 1;
            if (out.sample.length < 50) out.sample.push({ id: d.id, title: doc.title, category: doc.category, retainUntil: doc.retainUntil });
            if (dryRun) continue;
            try {
                await store.removeFile(orgId, d.id);
                await d.ref.update({ deleted: true, deletedAt: nowIso, deletedBy: actor || 'retention-job', deletedReason: 'retention period ended' });
                out.affected += 1;
            } catch (e) { logger.error(`Retention: could not delete vault doc ${d.id}: ${e.message}`); (out.errors = out.errors || []).push({ id: d.id, error: e.message }); }
        }
        return out;
    }
});

register({
    key: 'privacy_exports', label: 'Expired privacy export bundles',
    description: 'Removes personal-data export files after their download link has expired.',
    async run({ orgId, dryRun, nowIso }) {
        if (!orgId) return result();
        const snap = await rawCollection('privacy_requests').where('orgId', '==', orgId).get();
        const out = result();
        for (const d of snap.docs) {
            const ex = d.data().export;
            if (!ex || !ex.fileId) continue;
            out.scanned += 1;
            if (!ex.expiresAt || ex.expiresAt > nowIso) continue;
            out.eligible += 1;
            if (out.sample.length < 50) out.sample.push({ requestId: d.id, expiredAt: ex.expiresAt });
            if (dryRun) continue;
            try {
                await store.removeFile(orgId, ex.fileId);
                await d.ref.update({ export: { ...ex, fileId: null, purgedAt: nowIso, expired: true } });
                out.affected += 1;
            } catch (e) { (out.errors = out.errors || []).push({ id: d.id, error: e.message }); }
        }
        return out;
    }
});

const WEBHOOK_LOG_DAYS = () => Number(process.env.WEBHOOK_LOG_RETENTION_DAYS) || 180;
register({
    key: 'webhook_logs', label: 'Old webhook and billing event logs',
    description: 'Deletes payment webhook records older than WEBHOOK_LOG_RETENTION_DAYS (default 180). Also run with no company for events that matched none.',
    orgScoped: false,
    async run({ orgId, dryRun, nowIso }) {
        const cutoff = new Date(Date.parse(nowIso) - WEBHOOK_LOG_DAYS() * 86400000).toISOString();
        const snap = await rawCollection('billing_events').where('receivedAt', '<', cutoff).get();
        const out = result();
        for (const d of snap.docs) {
            const e = d.data();
            if ((e.orgId || null) !== (orgId || null)) continue;
            out.scanned += 1; out.eligible += 1;
            if (out.sample.length < 50) out.sample.push({ id: d.id, type: e.type, receivedAt: e.receivedAt });
            if (dryRun) continue;
            await d.ref.delete(); out.affected += 1;
        }
        out.cutoff = cutoff;
        return out;
    }
});

// Punch photos belong to another module. It replaces this placeholder with register({ key: 'punch_photos', ... }).
register({
    key: 'punch_photos', label: 'Expired punch photos', installed: false,
    description: 'Provided by the clock-in module. Not installed until that module registers its job here.',
    async run() { return result({ note: 'No punch photo job is registered yet' }); }
});

/* ------------------------------ running ------------------------------ */

async function runJob(key, { orgId, dryRun = true, actor = 'system', now = new Date() } = {}) {
    const job = registry.get(key);
    if (!job) throw Object.assign(new Error(`Unknown job ${key}`), { statusCode: 404 });
    const nowIso = now.toISOString();
    const started = Date.now();
    const r = await job.run({ orgId: orgId === undefined ? null : orgId, dryRun: dryRun !== false, nowIso, todayIso: nowIso.slice(0, 10), actor });
    return { key, label: job.label, orgId: orgId || null, dryRun: dryRun !== false, ms: Date.now() - started, ...r };
}

/** Platform scheduler entry: every company (and the unattributed bucket for company-less jobs) */
async function runAllOrgs({ dryRun = true, keys, actor = 'system' } = {}) {
    const orgs = await rawCollection('organizations').get();
    const selected = list().filter((j) => j.installed && (!keys || keys.includes(j.key)));
    const out = [];
    for (const j of selected) {
        for (const o of orgs.docs) {
            try {
                const r = await runJob(j.key, { orgId: o.id, dryRun, actor });
                if (r.eligible || r.affected || r.errors) out.push(r);
                if (!dryRun && r.affected) {
                    await rawCollection('organizations').doc(o.id).collection('audit_logs').add({ action: 'retention_job_run', targetId: j.key, actorId: actor, actorRole: 'system', at: new Date().toISOString(), affected: r.affected });
                }
            } catch (e) { out.push({ key: j.key, orgId: o.id, error: e.message }); }
        }
        if (j.orgScoped === false) { try { const r = await runJob(j.key, { orgId: null, dryRun, actor }); if (r.eligible || r.affected) out.push(r); } catch (e) { out.push({ key: j.key, orgId: null, error: e.message }); } }
    }
    return out;
}

module.exports = { register, list, runJob, runAllOrgs };
