const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, findEmployee, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { requirePermission, can } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const E = require('../services/esign-rules');
const S = require('../services/esign-service');
const store = require('../services/file-store');

router.use(verifyToken);

const manage = requirePermission('onboarding.manage');
const today = async (orgId) => timeRules.localDate(new Date().toISOString(), (await orgInfo(orgId)).tz);
const NOTE = 'Document wording and e-signature practice should be reviewed by counsel. These are generic starter drafts.';

const publicTemplate = (id, d) => ({ id, name: d.name, type: d.type, typeLabel: (E.typeOf(d.type) || {}).label, language: d.language || 'en', body: d.body, active: d.active !== false, fields: E.extractFields(d.body), unknownFields: E.extractFields(d.body).filter((f) => !E.MERGE_FIELDS.includes(f)), updatedAt: d.updatedAt, createdAt: d.createdAt });

async function loadTemplate(req, res) {
    const snap = await rawCollection('doc_templates').doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { res.status(404).json({ success: false, error: 'Template not found' }); return null; }
    return { ref: snap.ref, id: snap.id, data: snap.data() };
}
async function loadRequest(req, res) {
    const snap = await rawCollection('sign_requests').doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { res.status(404).json({ success: false, error: 'Request not found' }); return null; }
    return { ref: snap.ref, id: snap.id, data: snap.data() };
}

router.get('/esign/options', requireUsOrg, (req, res) => {
    res.json({ success: true, note: NOTE, types: E.TEMPLATE_TYPES, mergeFields: E.MERGE_FIELDS, consentText: E.CONSENT_TEXT, defaults: { expiryDays: E.DEFAULT_EXPIRY_DAYS, maxAttempts: E.DEFAULT_MAX_ATTEMPTS } });
});

/* ------------------------------------ templates ------------------------------------ */

router.get('/esign/templates', manage, requireUsOrg, async (req, res) => {
    const snap = await rawCollection('doc_templates').where('orgId', '==', req.orgId).get();
    const rows = snap.docs.map((d) => publicTemplate(d.id, d.data())).filter((t) => req.query.all === 'true' || t.active).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, note: NOTE, count: rows.length, data: rows });
});

router.post('/esign/templates', manage, requireUsOrg, async (req, res) => {
    const { errors, value, warnings } = E.validateTemplate(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ref = rawCollection('doc_templates').doc();
    const doc = { orgId: req.orgId, ...value, active: true, createdAt: S.nowIso(), updatedAt: S.nowIso(), createdBy: req.user.id };
    await ref.set(doc);
    audit(req.orgId, req, 'esign_template_created', ref.id, { type: value.type });
    res.status(201).json({ success: true, warnings, template: publicTemplate(ref.id, doc) });
});

router.post('/esign/templates/seed-defaults', manage, requireUsOrg, async (req, res) => {
    const snap = await rawCollection('doc_templates').where('orgId', '==', req.orgId).get();
    const have = new Set(snap.docs.map((d) => d.data().name));
    const made = [];
    for (const t of E.DEFAULT_TEMPLATES) {
        if (have.has(t.name)) continue;
        const ref = rawCollection('doc_templates').doc();
        await ref.set({ orgId: req.orgId, ...t, language: 'en', active: true, seeded: true, createdAt: S.nowIso(), updatedAt: S.nowIso(), createdBy: req.user.id });
        made.push(ref.id);
    }
    audit(req.orgId, req, 'esign_templates_seeded', req.orgId, { count: made.length });
    res.json({ success: true, note: NOTE, created: made.length });
});

router.post('/esign/templates/preview', manage, requireUsOrg, (req, res) => {
    const body = String((req.body && req.body.body) || '');
    if (body.length > 30000) return res.status(400).json({ success: false, error: 'body is too long' });
    const r = E.renderTemplate(body, (req.body && req.body.values) || {});
    res.json({ success: true, html: r.html, unknown: r.unknown, missing: r.missing });
});

router.put('/esign/templates/:id', manage, requireUsOrg, async (req, res) => {
    const t = await loadTemplate(req, res); if (!t) return;
    const merged = { name: t.data.name, type: t.data.type, body: t.data.body, language: t.data.language, ...req.body };
    const { errors, value, warnings } = E.validateTemplate(merged);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const patch = { ...value, updatedAt: S.nowIso(), updatedBy: req.user.id };
    if (req.body.active !== undefined) patch.active = req.body.active === true;
    await t.ref.update(patch); // requests already sent keep the exact text they were sent with
    audit(req.orgId, req, 'esign_template_updated', t.id, { fields: Object.keys(patch) });
    res.json({ success: true, warnings, template: publicTemplate(t.id, { ...t.data, ...patch }) });
});

router.delete('/esign/templates/:id', manage, requireUsOrg, async (req, res) => {
    const t = await loadTemplate(req, res); if (!t) return;
    await t.ref.update({ active: false, updatedAt: S.nowIso() });
    audit(req.orgId, req, 'esign_template_archived', t.id);
    res.json({ success: true });
});

/* ------------------------------------ requests ------------------------------------ */

router.post('/esign/requests', manage, requireUsOrg, async (req, res) => {
    const b = req.body || {};
    const errors = [];
    if (!b.templateId) errors.push('templateId is required');
    if (!['employee', 'candidate'].includes(b.signerType)) errors.push('signerType must be employee or candidate');
    if (b.signerType === 'employee' && !b.userId) errors.push('userId is required for an employee');
    if (b.signerType === 'candidate' && !b.candidateId) errors.push('candidateId is required for a candidate');
    if (errors.length) return res.status(400).json({ success: false, errors });
    const tsnap = await rawCollection('doc_templates').doc(String(b.templateId)).get();
    if (!exists(tsnap) || tsnap.data().orgId !== req.orgId || tsnap.data().active === false) return res.status(404).json({ success: false, error: 'Template not found' });
    const tpl = tsnap.data();

    let signer;
    if (b.signerType === 'employee') {
        const emp = await findEmployee(req.orgId, String(b.userId));
        if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
        signer = { type: 'employee', id: emp.id, data: { ...emp.data }, name: emp.data.name || '', email: emp.data.email || '' };
    } else {
        const c = await rawCollection('candidates').doc(String(b.candidateId)).get();
        if (!exists(c) || c.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Candidate not found' });
        signer = { type: 'candidate', id: c.id, data: c.data(), name: c.data().name || '', email: c.data().email || '' };
    }
    const todayIso = await today(req.orgId);
    const orgSnap = await rawCollection('organizations').doc(req.orgId).get();
    const values = await S.mergeValues(req.orgId, orgSnap.data() || {}, signer, b.fields, todayIso);
    const r = E.renderTemplate(tpl.body, values);
    if (r.unknown.length || r.missing.length) {
        return res.status(400).json({ success: false, errors: [...r.unknown.map((f) => `Unknown merge field {{${f}}} in the template`), ...r.missing.map((f) => `No value for {{${f}}}: supply it in "fields"`)], unknown: r.unknown, missing: r.missing });
    }
    const dup = await rawCollection('sign_requests').where('orgId', '==', req.orgId).get();
    const key = signer.type === 'employee' ? 'userId' : 'candidateId';
    if (dup.docs.some((d) => d.data()[key] === signer.id && d.data().templateId === tsnap.id && E.OPEN_STATUSES.includes(E.effectiveStatus(d.data(), S.nowIso())))) {
        return res.status(409).json({ success: false, error: 'There is already an open request for this document and person. Resend or void it instead' });
    }
    const { token, hash } = E.generateToken();
    const now = S.nowIso();
    const ref = rawCollection('sign_requests').doc();
    const doc = {
        orgId: req.orgId, templateId: tsnap.id, templateName: tpl.name, templateType: tpl.type, signerType: signer.type, userId: signer.type === 'employee' ? signer.id : null, candidateId: signer.type === 'candidate' ? signer.id : null,
        signerName: signer.name, signerEmail: signer.email, renderedHtml: r.html, documentHash: E.sha256(r.html), tokenHash: hash, status: 'pending', attempts: 0, maxAttempts: E.clampAttempts(b.maxAttempts),
        createdAt: now, sentAt: now, createdBy: req.user.id, expiresAt: E.expiresAtFor(now, b.expiresInDays), reminders: [], history: [S.histEntry('created', req.ip, { by: req.user.id })]
    };
    await ref.set(doc);
    if (signer.type === 'candidate') await rawCollection('candidate_events').add({ orgId: req.orgId, candidateId: signer.id, type: 'document_sent', at: now, by: req.user.id, data: { templateName: tpl.name, signRequestId: ref.id } });
    audit(req.orgId, req, 'esign_request_created', ref.id, { templateType: tpl.type, signerType: signer.type });
    res.status(201).json({ success: true, request: S.publicRequest(ref.id, doc, now), signUrl: S.signUrl(req, token), linkShownOnce: true });
});

router.get('/esign/requests', requirePermission('compliance.view'), requireUsOrg, async (req, res) => {
    const snap = await rawCollection('sign_requests').where('orgId', '==', req.orgId).get();
    const now = S.nowIso();
    let rows = snap.docs.map((d) => S.publicRequest(d.id, d.data(), now));
    for (const k of ['status', 'userId', 'candidateId', 'signerType']) if (req.query[k]) rows = rows.filter((r) => r[k] === req.query[k]);
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, count: rows.length, data: rows.slice(0, 500) });
});

router.get('/esign/reminders', manage, requireUsOrg, async (req, res) => {
    const snap = await rawCollection('sign_requests').where('orgId', '==', req.orgId).get();
    const rows = E.remindersDue(snap.docs.map((d) => ({ id: d.id, ...d.data() })), S.nowIso(), { everyDays: Number(req.query.everyDays) || 3, soonDays: Number(req.query.soonDays) || 3 });
    res.json({ success: true, count: rows.length, data: rows });
});

router.get('/esign/requests/:id', requirePermission('compliance.view'), requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res); if (!r) return;
    res.json({ success: true, request: S.publicRequest(r.id, r.data, S.nowIso()), history: r.data.history || [], html: r.data.renderedHtml });
});

const OPEN_FOR_CHANGE = ['pending', 'viewed', 'expired', 'locked'];

router.post('/esign/requests/:id/resend', manage, requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res); if (!r) return;
    if (!OPEN_FOR_CHANGE.includes(r.data.status)) return res.status(409).json({ success: false, error: `A ${r.data.status} request cannot be resent` });
    const { token, hash } = E.generateToken();
    const now = S.nowIso();
    const patch = { tokenHash: hash, status: 'pending', attempts: 0, sentAt: now, expiresAt: E.expiresAtFor(now, req.body && req.body.expiresInDays), history: [...(r.data.history || []), S.histEntry('resent', req.ip, { by: req.user.id })] };
    await r.ref.update(patch);
    audit(req.orgId, req, 'esign_request_resent', r.id);
    res.json({ success: true, request: S.publicRequest(r.id, { ...r.data, ...patch }, now), signUrl: S.signUrl(req, token), linkShownOnce: true });
});

router.post('/esign/requests/:id/void', manage, requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res); if (!r) return;
    if (!OPEN_FOR_CHANGE.includes(r.data.status)) return res.status(409).json({ success: false, error: `A ${r.data.status} request cannot be voided` });
    const reason = String((req.body && req.body.reason) || '').replace(/[<>]/g, '').trim().slice(0, 300);
    await r.ref.update({ status: 'voided', voidedAt: S.nowIso(), voidReason: reason, tokenHash: null, history: [...(r.data.history || []), S.histEntry('voided', req.ip, { by: req.user.id, reason })] });
    audit(req.orgId, req, 'esign_request_voided', r.id);
    res.json({ success: true });
});

router.post('/esign/requests/:id/remind', manage, requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res); if (!r) return;
    if (!E.OPEN_STATUSES.includes(E.effectiveStatus(r.data, S.nowIso()))) return res.status(409).json({ success: false, error: 'Only an open request can be reminded' });
    const now = S.nowIso();
    await r.ref.update({ reminders: [...(r.data.reminders || []), { at: now, by: req.user.id }], history: [...(r.data.history || []), S.histEntry('reminder_logged', req.ip, { by: req.user.id })] });
    audit(req.orgId, req, 'esign_reminder_logged', r.id);
    res.json({ success: true, note: 'Reminder recorded. Send the person their link (use Resend to get a fresh link).' });
});

router.get('/esign/requests/:id/certificate', requirePermission('compliance.view'), requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res); if (!r) return;
    if (r.data.status !== 'signed' || !r.data.vaultDocumentId) return res.status(404).json({ success: false, error: 'No certificate yet' });
    let buf;
    try { buf = await store.readFile(req.orgId, r.data.vaultDocumentId); } catch (e) { logger.error(`Certificate read failed ${r.id}: ${e.message}`); return res.status(500).json({ success: false, error: 'Could not open the certificate' }); }
    audit(req.orgId, req, 'esign_certificate_downloaded', r.id);
    res.set({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Disposition': `attachment; filename="certificate-${r.id}.html"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'" });
    res.send(buf);
});

/* ------------------------------ employee: my documents ------------------------------ */

router.get('/esign/my', requireUsOrg, async (req, res) => {
    const snap = await rawCollection('sign_requests').where('orgId', '==', req.orgId).get();
    const now = S.nowIso();
    const rows = snap.docs.filter((d) => d.data().userId === req.user.id).map((d) => S.publicRequest(d.id, d.data(), now))
        .map((r) => ({ id: r.id, templateName: r.templateName, templateType: r.templateType, status: r.status, sentAt: r.sentAt, expiresAt: r.expiresAt, signedAt: r.signedAt, declinedAt: r.declinedAt }));
    rows.sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, count: rows.length, data: rows });
});

/** A fresh single-use link for the employee's own pending document (the old link stops working) */
router.post('/esign/my/:id/link', requireUsOrg, async (req, res) => {
    const r = await loadRequest(req, res); if (!r) return;
    if (r.data.userId !== req.user.id) return res.status(403).json({ success: false, error: 'Not allowed' });
    const st = E.effectiveStatus(r.data, S.nowIso());
    if (!E.OPEN_STATUSES.includes(st)) return res.status(409).json({ success: false, error: `This document is ${st}` });
    const { token, hash } = E.generateToken();
    await r.ref.update({ tokenHash: hash, history: [...(r.data.history || []), S.histEntry('link_issued_to_signer', req.ip, { by: req.user.id })] });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, signUrl: S.signUrl(req, token) });
});

router.helpers = { can };
module.exports = router;
