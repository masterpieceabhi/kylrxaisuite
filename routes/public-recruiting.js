/**
 * PUBLIC endpoints (no login): the careers page API and the e-signature page API.
 * Mounted at /api/public WITHOUT verifyToken. Everything here is rate limited per IP, validated, and
 * returns nothing about other applicants or other companies.
 */
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { resolveCountryCode } = require('../country-config');
const H = require('../services/hiring-rules');
const E = require('../services/esign-rules');
const S = require('../services/esign-service');
const eeo = require('../services/eeo-rules');
const store = require('../services/file-store');

const exists = S.exists;
const ORG_ID = /^[A-Za-z0-9_-]{1,100}$/;

// Limits can be tuned (and lowered for tests) from the environment
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const applyLimiter = H.createLimiter({ max: num(process.env.PUBLIC_APPLY_MAX, 5), windowMs: num(process.env.PUBLIC_APPLY_WINDOW_MS, 60 * 60 * 1000) });
const readLimiter = H.createLimiter({ max: num(process.env.PUBLIC_READ_MAX, 120), windowMs: num(process.env.PUBLIC_READ_WINDOW_MS, 10 * 60 * 1000) });
const signLimiter = H.createLimiter({ max: num(process.env.PUBLIC_SIGN_MAX, 60), windowMs: 10 * 60 * 1000 });
const badTokenLimiter = H.createLimiter({ max: num(process.env.PUBLIC_BADTOKEN_MAX, 10), windowMs: 15 * 60 * 1000 });
router.limiters = { applyLimiter, readLimiter, signLimiter, badTokenLimiter };

const limit = (limiter) => (req, res, next) => {
    const r = limiter.check(req.ip || 'unknown');
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ success: false, error: 'Too many requests. Please try again later.', retryAfterSec: r.retryAfterSec });
};

router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': req.path.startsWith('/sign') ? 'noindex, nofollow' : 'index' }); next(); });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: H.MAX_RESUME_BYTES + 1, files: 1, fields: 20, fieldSize: 20000 } });

async function publicOrg(orgId) {
    if (!ORG_ID.test(String(orgId))) return null;
    const snap = await rawCollection('organizations').doc(String(orgId)).get();
    if (!exists(snap)) return null;
    const d = snap.data();
    if (resolveCountryCode(d.country || d.Country) !== 'US') return null;
    if (d.careersEnabled === false) return null;
    return d;
}
const notFound = (res) => res.status(404).json({ success: false, error: 'Not found' });

/* ------------------------------------------ careers ------------------------------------------ */

router.get('/careers/:orgId/jobs', limit(readLimiter), async (req, res) => {
    const org = await publicOrg(req.params.orgId);
    if (!org) return notFound(res);
    const snap = await rawCollection('job_requisitions').where('orgId', '==', req.params.orgId).get();
    const jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.status === 'open')
        .sort((a, b) => String(b.openedAt || b.createdAt).localeCompare(String(a.openedAt || a.createdAt))).map(H.pickPublicJob);
    res.json({ success: true, company: S.companyNameOf(org), count: jobs.length, jobs, privacyNotice: H.PRIVACY_NOTICE, sources: H.SOURCES, eeoOptions: { sex: eeo.SEX, races: eeo.RACES, hispanic: eeo.HISPANIC, veteran: eeo.VETERAN, disability: eeo.DISABILITY } });
});

router.post('/careers/:orgId/apply', limit(applyLimiter), (req, res, next) => {
    upload.single('resume')(req, res, (err) => {
        if (err && err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ success: false, error: 'The resume is larger than 5 MB' });
        if (err) return res.status(400).json({ success: false, error: 'Could not read the upload' });
        next();
    });
}, async (req, res) => {
    const orgId = req.params.orgId;
    const b = req.body || {};
    // Anti-spam honeypot: a hidden field real people never fill. Pretend it worked, store nothing.
    if (H.isHoneypotTripped(b)) { logger.warn('Careers honeypot tripped'); return res.status(201).json({ success: true, received: true }); }
    const org = await publicOrg(orgId);
    if (!org) return notFound(res);

    const app = H.validateApplication({ ...b, privacyAccepted: b.privacyAccepted });
    const resume = H.validateResume(req.file);
    const errors = [...app.errors, ...resume.errors];
    const reqSnap = b.requisitionId && ORG_ID.test(String(b.requisitionId)) ? await rawCollection('job_requisitions').doc(String(b.requisitionId)).get() : null;
    if (!reqSnap || !exists(reqSnap) || reqSnap.data().orgId !== orgId || reqSnap.data().status !== 'open') errors.push('That job is not open for applications');
    if (errors.length) return res.status(400).json({ success: false, errors });

    const job = reqSnap.data();
    const now = new Date().toISOString();
    const sameEmail = await rawCollection('candidates').where('orgId', '==', orgId).where('email', '==', app.value.email).get();
    const existing = sameEmail.docs.map((d) => ({ id: d.id, ...d.data() }));
    const again = existing.find((c) => c.requisitionId === reqSnap.id);
    if (again) { // already applied to this job: keep one record, note it
        await rawCollection('candidate_events').add({ orgId, candidateId: again.id, type: 're_applied', at: now, by: 'applicant', data: {} });
        return res.status(201).json({ success: true, received: true });
    }

    const ref = rawCollection('candidates').doc();
    const fileId = `${ref.id}_resume`;
    await store.saveFile(orgId, fileId, req.file.buffer);
    const candidate = {
        orgId, requisitionId: reqSnap.id, requisitionTitle: job.title, department: job.department, hiringManagerId: job.hiringManagerId || null,
        ...app.value, stage: 'applied', stageHistory: H.addStageHistory([], 'applied', now, 'applicant'), appliedAt: now, updatedAt: now,
        resume: { fileId, ...resume.value }, privacyAcceptedAt: now, duplicateOfIds: existing.map((c) => c.id), personId: null, offerStatus: null, offer: null
    };
    try { await ref.set(candidate); } catch (e) { await store.removeFile(orgId, fileId).catch(() => {}); throw e; }
    await rawCollection('candidate_events').add({ orgId, candidateId: ref.id, type: 'applied', at: now, by: 'applicant', data: { source: app.value.source, duplicates: existing.length } });

    // Voluntary EEO answers: stored apart from the candidate (no link back), only ever shown as totals
    if (b.eeo) {
        let parsed = null;
        try { parsed = typeof b.eeo === 'string' ? JSON.parse(b.eeo) : b.eeo; } catch (_) {}
        const r = parsed ? eeo.validateSelfId(parsed) : { errors: ['x'] };
        if (!r.errors.length) await rawCollection('candidate_eeo').add({ orgId, requisitionId: reqSnap.id, month: now.slice(0, 7), record: r.value });
    }
    S.auditPublic(orgId, 'candidate_applied', ref.id, req.ip, { requisitionId: reqSnap.id });
    res.status(201).json({ success: true, received: true, reference: ref.id.slice(0, 8).toUpperCase() });
});

/* ------------------------------------------- signing ------------------------------------------ */

const ctxOf = (req) => ({ ip: req.ip || null, userAgent: req.get('user-agent') || '', lang: req.body && req.body.lang === 'es' ? 'es' : 'en' });
const invalidLink = (req, res) => {
    const r = badTokenLimiter.check(req.ip || 'unknown');
    if (!r.ok) { res.set('Retry-After', String(r.retryAfterSec)); return res.status(429).json({ success: false, error: 'Too many invalid attempts. Please try again later.' }); }
    return res.status(404).json({ success: false, error: 'This link is not valid' });
};
const closedMessage = { signed: 'This document has already been signed', declined: 'This document was declined', voided: 'This request was cancelled', expired: 'This link has expired. Ask the sender for a new one', locked: 'Too many attempts. Ask the sender for a new link' };

/** Finds the request for a token (or answers 404/429) and settles an expired state */
async function openRequest(req, res) {
    const found = await S.findByToken(req.params.token);
    if (!found) { invalidLink(req, res); return null; }
    const st = E.effectiveStatus(found.data, S.nowIso());
    if (st === 'expired' && found.data.status !== 'expired') {
        found.data.status = 'expired';
        await found.ref.update({ status: 'expired', history: [...(found.data.history || []), S.histEntry('expired', req.ip)] }).catch(() => {});
    }
    return found;
}

router.get('/sign/:token', limit(signLimiter), async (req, res) => {
    const f = await openRequest(req, res); if (!f) return;
    const now = S.nowIso();
    const can = E.canSign(f.data, now);
    if (!can.ok) return res.status(410).json({ success: false, code: can.code, error: closedMessage[can.code] || can.reason, templateName: f.data.templateName });
    if (!f.data.viewedAt) {
        await f.ref.update({ status: 'viewed', viewedAt: now, history: [...(f.data.history || []), S.histEntry('viewed', req.ip, { userAgent: String(req.get('user-agent') || '').slice(0, 200) })] });
        S.auditPublic(f.data.orgId, 'esign_document_viewed', f.id, req.ip);
    }
    const orgSnap = await rawCollection('organizations').doc(f.data.orgId).get();
    res.json({
        success: true, templateName: f.data.templateName, signerName: f.data.signerName, companyName: S.companyNameOf(exists(orgSnap) ? orgSnap.data() : {}), html: f.data.renderedHtml, documentHash: f.data.documentHash,
        expiresAt: f.data.expiresAt, attemptsLeft: (f.data.maxAttempts || E.DEFAULT_MAX_ATTEMPTS) - (f.data.attempts || 0), consentText: E.CONSENT_TEXT
    });
});

router.post('/sign/:token/sign', limit(signLimiter), async (req, res) => {
    const f = await openRequest(req, res); if (!f) return;
    const now = S.nowIso();
    const can = E.canSign(f.data, now);
    if (!can.ok) return res.status(410).json({ success: false, code: can.code, error: closedMessage[can.code] || can.reason });
    const { errors, value } = E.validateSignature(req.body, f.data.signerName);
    if (errors.length) {
        const attempts = (f.data.attempts || 0) + 1;
        const locked = attempts >= (f.data.maxAttempts || E.DEFAULT_MAX_ATTEMPTS);
        await f.ref.update({ attempts, status: locked ? 'locked' : f.data.status, history: [...(f.data.history || []), S.histEntry(locked ? 'locked_too_many_attempts' : 'failed_attempt', req.ip)] });
        S.auditPublic(f.data.orgId, locked ? 'esign_locked' : 'esign_failed_attempt', f.id, req.ip);
        return res.status(locked ? 429 : 400).json({ success: false, errors: locked ? [...errors, 'Too many attempts. Ask the sender for a new link'] : errors, attemptsLeft: Math.max(0, (f.data.maxAttempts || E.DEFAULT_MAX_ATTEMPTS) - attempts) });
    }
    try {
        const done = await S.completeSigning(f, value, ctxOf(req));
        res.json({ success: true, signedAt: done.signedAt, documentHash: done.documentHash, message: 'Signed. A completion certificate was saved.' });
    } catch (e) {
        if (e.conflict) return res.status(409).json({ success: false, error: e.message });
        throw e;
    }
});

router.post('/sign/:token/decline', limit(signLimiter), async (req, res) => {
    const f = await openRequest(req, res); if (!f) return;
    const can = E.canSign(f.data, S.nowIso());
    if (!can.ok) return res.status(410).json({ success: false, code: can.code, error: closedMessage[can.code] || can.reason });
    const reason = String((req.body && req.body.reason) || '').replace(/[<>]/g, '').trim().slice(0, 300);
    const now = S.nowIso();
    await f.ref.update({ status: 'declined', declinedAt: now, declineReason: reason, tokenUsedAt: now, history: [...(f.data.history || []), S.histEntry('declined', req.ip, { reason })] });
    if (f.data.signerType === 'candidate' && f.data.candidateId && f.data.templateType === 'offer_letter') {
        const cref = rawCollection('candidates').doc(f.data.candidateId);
        const c = await cref.get();
        if (exists(c) && c.data().orgId === f.data.orgId) {
            await cref.update({ offerStatus: 'declined', offerDeclinedAt: now });
            await rawCollection('candidate_events').add({ orgId: f.data.orgId, candidateId: f.data.candidateId, type: 'offer_declined', at: now, by: 'esign', data: { reason } });
        }
    }
    S.auditPublic(f.data.orgId, 'esign_document_declined', f.id, req.ip);
    res.json({ success: true });
});

module.exports = router;
