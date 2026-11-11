const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const timeRules = require('../services/time-rules');
const V = require('../services/vault-rules');
const store = require('../services/file-store');

const CONFIDENTIAL_ROLES = ['Super Admin', 'super_admin', 'hr_admin'];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: V.MAX_BYTES + 1, files: 1, fields: 12 } });

router.use(verifyToken);

const norm = (r) => String(r || '').toLowerCase().replace(/[\s_-]+/g, '');
const hasRole = (user, list) => list.some((r) => norm(r) === norm(user.role));
const today = async (orgId) => timeRules.localDate(new Date().toISOString(), (await orgInfo(orgId)).tz);

const publicDoc = (id, d) => ({
    id, scope: d.scope, category: d.category, categoryLabel: (V.categoryOf(d.category) || {}).label, title: d.title, userId: d.userId || null, employeeName: d.employeeName || null,
    fileName: d.fileName, mime: d.mime, size: d.size, uploadedAt: d.uploadedAt, expiresOn: d.expiresOn || null, retainUntil: d.retainUntil || null,
    shared: Boolean(d.shared), confidential: Boolean(d.confidential), legalHold: Boolean(d.legalHold)
});

async function loadDoc(req, res) {
    const snap = await rawCollection('vault_documents').doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().deleted) { res.status(404).json({ success: false, error: 'Document not found' }); return null; }
    return { ref: snap.ref, id: snap.id, data: snap.data() };
}

router.get('/vault/categories', requireUsOrg, (req, res) => {
    res.json({ success: true, note: 'Retention years are suggestions. Confirm the right period for your state with an advisor.', data: V.CATEGORIES });
});

router.post('/vault/documents', authorize(ADMIN_HR_ROLES), requireUsOrg, (req, res, next) => {
    upload.single('file')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: 'The file is larger than 10 MB' });
        if (err) return res.status(400).json({ success: false, error: 'Could not read the upload' });
        next();
    });
}, async (req, res) => {
    const meta = { ...req.body, shared: req.body.shared === 'true' || req.body.shared === true };
    const { errors, value } = V.validateUpload(meta, req.file);
    if (errors.length) return res.status(400).json({ success: false, errors });
    if (value.confidential && !hasRole(req.user, CONFIDENTIAL_ROLES)) return res.status(403).json({ success: false, error: 'Only a super admin or HR admin can store confidential documents' });

    let employeeName = null;
    if (value.scope === 'employee') {
        const u = await rawCollection('users').doc(String(value.userId)).get();
        if (!exists(u) || u.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Employee not found' });
        employeeName = u.data().name || null;
    }
    const ref = rawCollection('vault_documents').doc();
    const nowIso = new Date().toISOString();
    await store.saveFile(req.orgId, ref.id, req.file.buffer);
    const doc = {
        orgId: req.orgId, ...value, employeeName, size: req.file.buffer.length, sha256: crypto.createHash('sha256').update(req.file.buffer).digest('hex'),
        uploadedAt: nowIso, uploadedBy: req.user.id, retainUntil: V.retainUntil(value.category, nowIso), deleted: false, legalHold: false
    };
    try {
        await ref.set(doc);
    } catch (e) {
        await store.removeFile(req.orgId, ref.id).catch(() => {});
        throw e;
    }
    audit(req.orgId, req, 'vault_document_uploaded', ref.id, { category: value.category, scope: value.scope, userId: value.userId, size: doc.size });
    res.status(201).json({ success: true, document: publicDoc(ref.id, doc) });
});

router.get('/vault/documents', requireUsOrg, async (req, res) => {
    const snap = await rawCollection('vault_documents').where('orgId', '==', req.orgId).get();
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => V.canView(d, req.user));
    if (req.query.scope) rows = rows.filter((d) => d.scope === req.query.scope);
    if (req.query.userId) rows = rows.filter((d) => d.userId === req.query.userId);
    if (req.query.category) rows = rows.filter((d) => d.category === req.query.category);
    rows.sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
    res.json({ success: true, count: rows.length, data: rows.slice(0, 500).map((d) => publicDoc(d.id, d)) });
});

router.get('/vault/documents/:id/download', requireUsOrg, async (req, res) => {
    const doc = await loadDoc(req, res); if (!doc) return;
    if (!V.canView({ ...doc.data }, req.user)) return res.status(403).json({ success: false, error: 'Not allowed' });
    let buf;
    try {
        buf = await store.readFile(req.orgId, doc.id);
    } catch (e) {
        logger.error(`Vault read failed for ${doc.id}: ${e.message}`);
        return res.status(500).json({ success: false, error: 'Could not open the file' });
    }
    audit(req.orgId, req, 'vault_document_downloaded', doc.id, { category: doc.data.category, userId: doc.data.userId || null });
    res.set({ 'Content-Type': doc.data.mime, 'Content-Disposition': `attachment; filename="${V.safeFileName(doc.data.fileName)}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(buf);
});

router.put('/vault/documents/:id', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const doc = await loadDoc(req, res); if (!doc) return;
    if (doc.data.confidential && !hasRole(req.user, CONFIDENTIAL_ROLES)) return res.status(403).json({ success: false, error: 'Not allowed' });
    const b = req.body || {};
    const patch = {};
    if (b.title !== undefined) { const t = String(b.title).trim(); if (!t) return res.status(400).json({ success: false, error: 'title cannot be empty' }); patch.title = t.slice(0, 120); }
    if (b.expiresOn !== undefined) { if (b.expiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(b.expiresOn)) return res.status(400).json({ success: false, error: 'expiresOn must be YYYY-MM-DD' }); patch.expiresOn = b.expiresOn || null; }
    if (b.shared !== undefined && !doc.data.confidential) patch.shared = b.shared === true;
    if (b.legalHold !== undefined) {
        if (!hasRole(req.user, CONFIDENTIAL_ROLES)) return res.status(403).json({ success: false, error: 'Only a super admin or HR admin can place a legal hold' });
        patch.legalHold = b.legalHold === true;
    }
    if (!Object.keys(patch).length) return res.status(400).json({ success: false, error: 'Nothing to change' });
    await doc.ref.update(patch);
    audit(req.orgId, req, 'vault_document_updated', doc.id, { fields: Object.keys(patch) });
    res.json({ success: true, document: publicDoc(doc.id, { ...doc.data, ...patch }) });
});

router.delete('/vault/documents/:id', authorize(CONFIDENTIAL_ROLES), requireUsOrg, async (req, res) => {
    const doc = await loadDoc(req, res); if (!doc) return;
    const check = V.deletionCheck(doc.data, await today(req.orgId));
    if (!check.ok) return res.status(409).json({ success: false, error: check.reason });
    await store.removeFile(req.orgId, doc.id);
    await doc.ref.update({ deleted: true, deletedAt: new Date().toISOString(), deletedBy: req.user.id });
    audit(req.orgId, req, 'vault_document_deleted', doc.id, { category: doc.data.category, title: doc.data.title });
    res.json({ success: true });
});

/** Documents (licenses, insurance, certificates) that expire soon or already have */
router.get('/vault/expiring', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const t = await today(req.orgId);
    const window = Math.min(365, Math.max(1, Number(req.query.days) || 60));
    const snap = await rawCollection('vault_documents').where('orgId', '==', req.orgId).get();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => !d.deleted && d.expiresOn && V.canView(d, req.user))
        .map((d) => ({ ...publicDoc(d.id, d), daysLeft: V.daysUntil(d.expiresOn, t) })).filter((d) => d.daysLeft <= window).sort((a, b) => a.daysLeft - b.daysLeft);
    res.json({ success: true, window, count: rows.length, data: rows });
});

module.exports = router;
