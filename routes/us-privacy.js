/**
 * Privacy requests (CCPA/CPRA style). Employees file their own (they are logged in, so identity is verified);
 * HR (privacy.manage) can file on someone's behalf with a recorded verification, work the queue, extend once,
 * produce the access export and run deletions (with a retention table). Rules and wording are data, not law.
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { can, requirePermission } = require('../services/permissions');
const P = require('../services/privacy-rules');
const S = require('../services/privacy-service');

router.use(verifyToken);

const nowIso = () => new Date().toISOString();
const manages = (req) => can(req.user, 'privacy.manage');
const publicReq = (id, r, settings) => ({
    id, type: r.type, typeLabel: P.REQUEST_TYPES[r.type] || null, status: r.status, source: r.source, userId: r.userId, employeeId: r.employeeId || null, subjectName: r.subjectName || null, details: r.details || '',
    receivedAt: r.receivedAt, acknowledgeBy: r.acknowledgeBy, dueAt: r.dueAt, originalDueAt: r.originalDueAt, extensionsUsed: r.extensionsUsed || 0, extensionReason: r.extensionReason || null,
    verification: r.verification ? { method: r.verification.method, note: r.verification.note, verifiedAt: r.verification.verifiedAt } : null,
    export: r.export ? { generatedAt: r.export.generatedAt, expiresAt: r.export.expiresAt, expired: Boolean(r.export.expired) || (r.export.expiresAt && r.export.expiresAt < nowIso()), available: Boolean(r.export.fileId) && r.export.expiresAt > nowIso() && (r.export.downloads || 0) < (r.export.maxDownloads || 99), downloads: r.export.downloads || 0 } : null,
    resolution: r.resolution || null, deletionResult: r.deletionResult || null, history: (r.history || []).slice(-30),
    sla: P.slaStatus({ status: r.status, dueAt: r.dueAt }, nowIso(), settings)
});

async function loadRequest(req, res, { needManage = false } = {}) {
    const snap = await rawCollection('privacy_requests').doc(String(req.params.id)).get();
    const ok = exists(snap) && snap.data().orgId === req.orgId;
    if (!ok) { res.status(404).json({ success: false, error: 'Request not found' }); return null; }
    const data = snap.data();
    if (!manages(req) && (needManage || data.userId !== req.user.id)) { res.status(needManage ? 403 : 404).json({ success: false, error: needManage ? 'You do not have permission to do this' : 'Request not found' }); return null; }
    return { ref: snap.ref, id: snap.id, data };
}

const push = (r, by, action, note) => [...(r.history || []), { at: nowIso(), by, action, note: note ? String(note).slice(0, 300) : undefined }].slice(-100);

router.get('/privacy/types', requireUsOrg, async (req, res) => {
    const s = await S.loadSettings(req.orgId);
    res.json({ success: true, types: Object.entries(P.REQUEST_TYPES).map(([key, label]) => ({ key, ...label })), responseDays: s.responseDays, extensionDays: s.extensionDays, note: 'Privacy rules and deadlines are set by your company. Confirm them with a US privacy advisor.' });
});

router.post('/privacy/requests', requireUsOrg, async (req, res) => {
    const b = req.body || {};
    const onBehalf = Boolean(b.onBehalfOf);
    if (onBehalf && !manages(req)) return res.status(403).json({ success: false, error: 'Only HR can file a request for someone else' });
    const { errors, value } = P.validateNewRequest(b, { onBehalf });
    if (errors.length) return res.status(400).json({ success: false, errors });
    const subjectId = onBehalf ? String(b.onBehalfOf) : req.user.id;
    const uSnap = await rawCollection('users').doc(subjectId).get();
    if (!exists(uSnap) || uSnap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Person not found' });
    const subject = uSnap.data();
    const open = await rawCollection('privacy_requests').where('userId', '==', subjectId).get();
    if (open.docs.some((d) => d.data().orgId === req.orgId && d.data().type === value.type && P.OPEN.includes(d.data().status))) return res.status(409).json({ success: false, error: 'There is already an open request of this kind' });

    const settings = await S.loadSettings(req.orgId);
    let receivedAt = nowIso();
    if (onBehalf && b.receivedAt) { const t = Date.parse(b.receivedAt); if (Number.isNaN(t) || t > Date.now()) return res.status(400).json({ success: false, error: 'receivedAt cannot be in the future' }); receivedAt = new Date(t).toISOString(); }
    const d = P.deadlines(receivedAt, settings, 0);
    const doc = {
        orgId: req.orgId, userId: subjectId, employeeId: subject.employeeId || null, subjectName: subject.name || null, type: value.type, details: value.details,
        status: 'received', source: onBehalf ? 'hr' : 'self', receivedAt, acknowledgeBy: d.acknowledgeBy, dueAt: d.dueAt, originalDueAt: d.originalDueAt, extensionsUsed: 0,
        verification: onBehalf ? { method: b.verification.method, note: String(b.verification.note).slice(0, 300), verifiedAt: nowIso(), by: req.user.id } : { method: 'employee_logged_in', note: 'Signed in to their own account', verifiedAt: nowIso(), by: subjectId },
        filedBy: req.user.id, createdAt: nowIso(), history: [{ at: nowIso(), by: req.user.id, action: 'received' }]
    };
    const ref = await rawCollection('privacy_requests').add(doc);
    audit(req.orgId, req, 'privacy_request_created', subjectId, { requestId: ref.id, type: value.type, source: doc.source });
    res.status(201).json({ success: true, request: publicReq(ref.id, doc, settings) });
});

router.get('/privacy/requests/mine', requireUsOrg, async (req, res) => {
    const settings = await S.loadSettings(req.orgId);
    const snap = await rawCollection('privacy_requests').where('userId', '==', req.user.id).get();
    const rows = snap.docs.filter((d) => d.data().orgId === req.orgId).map((d) => publicReq(d.id, d.data(), settings)).sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    res.json({ success: true, count: rows.length, data: rows });
});

router.get('/privacy/requests', requirePermission('privacy.manage'), requireUsOrg, async (req, res) => {
    const settings = await S.loadSettings(req.orgId);
    const snap = await rawCollection('privacy_requests').where('orgId', '==', req.orgId).get();
    let rows = snap.docs.map((d) => publicReq(d.id, d.data(), settings));
    const q = req.query;
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    if (q.type) rows = rows.filter((r) => r.type === q.type);
    if (q.sla) rows = rows.filter((r) => r.sla.state === q.sla);
    rows.sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
    res.json({ success: true, count: rows.length, data: rows.slice(0, 500).map(({ history, ...r }) => r) });
});

router.get('/privacy/summary', requirePermission('privacy.manage'), requireUsOrg, async (req, res) => {
    const settings = await S.loadSettings(req.orgId);
    const snap = await rawCollection('privacy_requests').where('orgId', '==', req.orgId).get();
    const rows = snap.docs.map((d) => publicReq(d.id, d.data(), settings));
    const by = (f) => rows.reduce((a, r) => { a[f(r)] = (a[f(r)] || 0) + 1; return a; }, {});
    res.json({ success: true, total: rows.length, open: rows.filter((r) => P.OPEN.includes(r.status)).length, byStatus: by((r) => r.status), byType: by((r) => r.type), bySla: by((r) => r.sla.state), overdue: rows.filter((r) => r.sla.state === 'overdue').map((r) => r.id) });
});

router.get('/privacy/settings', requirePermission('privacy.manage'), requireUsOrg, async (req, res) => {
    res.json({ success: true, settings: await S.loadSettings(req.orgId), note: 'These numbers are suggestions. Confirm them with a US privacy and employment advisor.' });
});

router.put('/privacy/settings', requirePermission('privacy.manage'), requireUsOrg, async (req, res) => {
    const { errors, value } = P.validateSettings(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    await S.saveSettings(req.orgId, value, req.user.id);
    audit(req.orgId, req, 'privacy_settings_updated', req.orgId, { responseDays: value.responseDays, extensionDays: value.extensionDays });
    res.json({ success: true, settings: value });
});

router.get('/privacy/requests/:id', requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res); if (!r) return;
    res.json({ success: true, request: publicReq(r.id, r.data, await S.loadSettings(req.orgId)) });
});

router.post('/privacy/requests/:id/cancel', requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res); if (!r) return;
    if (!P.OPEN.includes(r.data.status)) return res.status(409).json({ success: false, error: 'This request is already closed' });
    await r.ref.update({ status: 'cancelled', history: push(r.data, req.user.id, 'cancelled', req.body && req.body.reason), resolution: { outcome: 'cancelled', at: nowIso(), by: req.user.id } });
    audit(req.orgId, req, 'privacy_request_status_changed', r.data.userId, { requestId: r.id, status: 'cancelled' });
    res.json({ success: true });
});

/* ----------------------------- access export ----------------------------- */
router.post('/privacy/requests/:id/export', requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res); if (!r) return;
    if (r.data.type !== 'access') return res.status(409).json({ success: false, error: 'Only a "know / get a copy" request has an export' });
    if (!P.OPEN.includes(r.data.status) && !(r.data.status === 'completed')) return res.status(409).json({ success: false, error: 'This request is closed' });
    const settings = await S.loadSettings(req.orgId);
    const out = await S.generateExport(req.orgId, { id: r.id, ...r.data }, settings, r.ref);
    await r.ref.update({ status: 'completed', resolution: { outcome: 'export_provided', at: nowIso(), by: req.user.id }, history: push(r.data, req.user.id, 'export_generated') });
    audit(req.orgId, req, 'privacy_access_export_generated', r.data.userId, { requestId: r.id, ...out.summary });
    res.json({ success: true, expiresAt: out.export.expiresAt, summary: out.summary, downloadUrl: `/api/us/privacy/requests/${r.id}/export/download`, hours: settings.exportLinkHours });
});

router.get('/privacy/requests/:id/export/download', requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res); if (!r) return;
    const ex = r.data.export;
    if (!ex || !ex.fileId) return res.status(404).json({ success: false, error: 'There is no export for this request' });
    if (ex.expiresAt < nowIso()) return res.status(410).json({ success: false, error: 'This download link has expired. Ask HR or file a new request.' });
    if ((ex.downloads || 0) >= (ex.maxDownloads || 99)) return res.status(410).json({ success: false, error: 'The download limit was reached' });
    let bundle;
    try { bundle = await S.readExport(req.orgId, ex); } catch (e) { return res.status(500).json({ success: false, error: 'Could not open the export' }); }
    await r.ref.update({ 'export.downloads': (ex.downloads || 0) + 1 });
    audit(req.orgId, req, 'privacy_export_downloaded', r.data.userId, { requestId: r.id, by: req.user.id === r.data.userId ? 'subject' : 'hr' });
    const html = String(req.query.format) === 'html';
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="my-data-${r.id}.${html ? 'html' : 'json'}"` });
    res.send(html ? P.renderBundleHtml(bundle, req.query.lang === 'es' ? 'es' : 'en') : JSON.stringify(bundle, null, 2));
});

/* ----------------------------- HR actions ----------------------------- */
router.post('/privacy/requests/:id/start', requirePermission('privacy.manage'), requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res, { needManage: true }); if (!r) return;
    if (r.data.status !== 'received') return res.status(409).json({ success: false, error: 'Only a new request can be started' });
    await r.ref.update({ status: 'in_progress', history: push(r.data, req.user.id, 'in_progress') });
    audit(req.orgId, req, 'privacy_request_status_changed', r.data.userId, { requestId: r.id, status: 'in_progress' });
    res.json({ success: true });
});

router.post('/privacy/requests/:id/extend', requirePermission('privacy.manage'), requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res, { needManage: true }); if (!r) return;
    const settings = await S.loadSettings(req.orgId);
    const check = P.canExtend(r.data, nowIso(), settings);
    if (!check.ok) return res.status(409).json({ success: false, error: check.reason });
    const reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 10) return res.status(400).json({ success: false, error: 'Give the person a reason for the extension (10+ characters)' });
    const d = P.deadlines(r.data.receivedAt, settings, 1);
    await r.ref.update({ extensionsUsed: 1, extensionReason: reason.slice(0, 500), extensionNoticeAt: nowIso(), dueAt: d.dueAt, history: push(r.data, req.user.id, 'extended', reason) });
    audit(req.orgId, req, 'privacy_request_extended', r.data.userId, { requestId: r.id, newDueAt: d.dueAt });
    res.json({ success: true, dueAt: d.dueAt, note: 'Tell the person about the extension and the reason in writing.' });
});

router.post('/privacy/requests/:id/deny', requirePermission('privacy.manage'), requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res, { needManage: true }); if (!r) return;
    if (!P.OPEN.includes(r.data.status)) return res.status(409).json({ success: false, error: 'This request is already closed' });
    const reason = String((req.body || {}).reason || '').trim();
    if (reason.length < 10) return res.status(400).json({ success: false, error: 'A reason of at least 10 characters is required' });
    await r.ref.update({ status: 'denied', resolution: { outcome: 'denied', note: reason.slice(0, 500), at: nowIso(), by: req.user.id }, history: push(r.data, req.user.id, 'denied', reason) });
    audit(req.orgId, req, 'privacy_request_status_changed', r.data.userId, { requestId: r.id, status: 'denied' });
    res.json({ success: true });
});

/** Closes a correct / limit / opt-out request. Limit and opt-out also set the flag on the profile. */
router.post('/privacy/requests/:id/complete', requirePermission('privacy.manage'), requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res, { needManage: true }); if (!r) return;
    if (!P.OPEN.includes(r.data.status)) return res.status(409).json({ success: false, error: 'This request is already closed' });
    if (['access', 'delete'].includes(r.data.type)) return res.status(409).json({ success: false, error: r.data.type === 'access' ? 'Generate the export to complete this request' : 'Run the deletion to complete this request' });
    const note = String((req.body || {}).note || '').trim();
    if (note.length < 5) return res.status(400).json({ success: false, error: 'Say what was done (5+ characters)' });
    let flag = null;
    if (r.data.type === 'limit_sensitive' || r.data.type === 'opt_out') { flag = await S.applyFlags(req.orgId, r.data.userId, r.data.type); audit(req.orgId, req, 'privacy_flags_applied', r.data.userId, { requestId: r.id, flag }); }
    await r.ref.update({ status: 'completed', resolution: { outcome: 'completed', note: note.slice(0, 500), flag, at: nowIso(), by: req.user.id }, history: push(r.data, req.user.id, 'completed', note) });
    audit(req.orgId, req, 'privacy_request_status_changed', r.data.userId, { requestId: r.id, status: 'completed' });
    res.json({ success: true, flag });
});

/* ----------------------------- deletion ----------------------------- */
router.post('/privacy/requests/:id/deletion/preview', requirePermission('privacy.manage'), requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res, { needManage: true }); if (!r) return;
    if (r.data.type !== 'delete') return res.status(409).json({ success: false, error: 'This is not a deletion request' });
    const settings = await S.loadSettings(req.orgId);
    const p = await S.previewDeletion(req.orgId, r.data.userId, settings);
    if (!p) return res.status(404).json({ success: false, error: 'Person not found' });
    audit(req.orgId, req, 'privacy_deletion_previewed', r.data.userId, { requestId: r.id });
    const confirmText = `DELETE ${p.person.employeeId || p.person.id}`;
    res.json({ success: true, person: p.person, employmentActive: p.plan.employmentActive, legalHold: p.plan.legalHold, rows: p.plan.rows.map(({ deleteIds, ...x }) => x), anythingToDelete: p.plan.anythingToDelete, confirmText, warning: 'Deleting is permanent and cannot be undone. Kept records are listed with the reason and date. Confirm the retention periods with a US compliance advisor.' });
});

router.post('/privacy/requests/:id/deletion/execute', requirePermission('privacy.manage'), requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res, { needManage: true }); if (!r) return;
    if (r.data.type !== 'delete') return res.status(409).json({ success: false, error: 'This is not a deletion request' });
    if (!P.OPEN.includes(r.data.status)) return res.status(409).json({ success: false, error: 'This request is already closed' });
    const uSnap = await rawCollection('users').doc(r.data.userId).get();
    if (!exists(uSnap) || uSnap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Person not found' });
    if (r.data.userId === req.user.id) return res.status(409).json({ success: false, error: 'You cannot run a deletion on your own record. Ask another administrator.' });
    const expected = `DELETE ${uSnap.data().employeeId || uSnap.id}`;
    if (req.body.acknowledgeIrreversible !== true || req.body.confirmText !== expected) return res.status(400).json({ success: false, error: `This cannot be undone. Send acknowledgeIrreversible:true and confirmText:"${expected}"` });
    const settings = await S.loadSettings(req.orgId);
    const out = await S.executeDeletion(req.orgId, r.data.userId, settings);
    const failed = out.table.filter((t) => t.result === 'failed').length;
    await r.ref.update({
        status: failed ? 'in_progress' : 'completed', deletionResult: { executedAt: nowIso(), by: req.user.id, table: out.table },
        resolution: failed ? null : { outcome: 'deleted_subject_to_retention', at: nowIso(), by: req.user.id }, history: push(r.data, req.user.id, failed ? 'deletion_partial' : 'deletion_executed')
    });
    audit(req.orgId, req, 'privacy_deletion_executed', r.data.userId, { requestId: r.id, deleted: out.table.filter((t) => ['deleted', 'partially_deleted', 'anonymized'].includes(t.result)).map((t) => t.key), retained: out.table.filter((t) => t.result === 'retained' || t.retained > 0).map((t) => t.key), failed });
    res.json({ success: failed === 0, table: out.table, employmentActive: out.plan.employmentActive, legalHold: out.plan.legalHold });
});

module.exports = router;
