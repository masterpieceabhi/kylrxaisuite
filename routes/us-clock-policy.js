const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { requirePermission, requireAnyPermission, can, canManage } = require('../services/permissions');
const teamScope = require('../services/team-scope');
const R = require('../services/clock-compliance-rules');
const io = require('../services/clock-compliance-io');
const files = require('../services/file-store');
const bio = require('../services/biometric-adapter');

router.use(verifyToken);
const REVIEWER = requireAnyPermission('time.approve', 'time.approve_team');
const base = '/clock';

const activeStatus = (u) => ['active', 'terminating'].includes(String(u.status || 'active').toLowerCase());

/* ------------------------------ employee ------------------------------ */

router.get(`${base}/my-requirements`, requireUsOrg, async (req, res) => {
    const c = await io.pendingFor(req.orgId, req.user.id);
    res.set('Cache-Control', 'no-store');
    if (!c || !c.policy) return res.json({ success: true, policy: false, required: false, pending: [], selfie: 'off', geofence: 'off' });
    res.json({ success: true, policy: true, required: c.required, pending: c.pending, selfie: c.selfie, geofence: c.geofence, methodsInUse: c.req.inUse });
});

router.get(`${base}/my-consents`, requireUsOrg, async (req, res) => {
    const notices = await io.loadNotices(req.orgId);
    const consents = await io.loadConsents(req.orgId, req.user.id);
    res.json({ success: true, data: consents.sort((a, b) => String(b.signedAt).localeCompare(String(a.signedAt))).map((c) => ({ ...c, title_en: notices[c.type] && notices[c.type].title_en })) });
});

router.post(`${base}/consents`, requireUsOrg, async (req, res) => {
    const type = String((req.body && req.body.type) || '');
    if (!R.CONSENT_TYPES.includes(type)) return res.status(400).json({ success: false, error: 'Unknown notice type' });
    const decision = req.body.decision === 'declined' ? 'declined' : 'accepted';
    const rec = await io.recordConsent(req.orgId, req.user.id, type, decision, { ip: req.ip, source: 'web' });
    audit(req.orgId, req, `clock_consent_${decision}`, req.user.id, { type, version: rec.version });
    res.status(201).json({ success: true, consent: rec });
});

router.post(`${base}/consents/revoke`, requireUsOrg, async (req, res) => {
    const type = String((req.body && req.body.type) || '');
    if (!R.CONSENT_TYPES.includes(type)) return res.status(400).json({ success: false, error: 'Unknown notice type' });
    const out = await io.revokeConsent(req.orgId, req.user.id, type, req.user.id);
    audit(req.orgId, req, 'clock_consent_revoked', req.user.id, { type, photosDestroyed: out.photosDestroyed });
    res.json({ success: true, revoked: out.revoked, photosDestroyed: out.photosDestroyed });
});

/* ------------------------------ policies ------------------------------ */

router.get(`${base}/policies`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    res.json({ success: true, data: await io.loadPolicies(req.orgId) });
});

async function workersInScope(orgId, policy) {
    const snap = await rawCollection('users').where('orgId', '==', orgId).get();
    const locs = new Map((await rawCollection('locations').where('orgId', '==', orgId).get()).docs.map((d) => [d.id, d.data()]));
    return snap.docs.filter((d) => activeStatus(d.data())).map((d) => {
        const p = d.data().usProfile || {};
        const lid = p.locationId || d.data().locationId || null;
        const loc = lid ? locs.get(String(lid)) : null;
        return { userId: d.id, workState: p.workState || (loc && loc.state) || null, city: (loc && loc.city) || p.workCity || null, locationId: lid };
    }).filter((w) => policy.scope === 'state' ? w.workState === policy.state : policy.scope === 'location' ? w.locationId === policy.locationId : true);
}

router.put(`${base}/policies`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    const { errors, value } = R.validatePolicy(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    if (value.scope === 'location') {
        const l = await rawCollection('locations').doc(value.locationId).get();
        if (!exists(l) || l.data().orgId !== req.orgId) return res.status(400).json({ success: false, errors: ['Location not found'] });
    }
    if (value.biometric.enabled) {
        // Hard guard: biometrics stay off where a notice or consent is required until everyone affected has it
        const [rows, notices, workers, consentSnap] = await Promise.all([
            io.rulesForEval(req.orgId), io.loadNotices(req.orgId), workersInScope(req.orgId, value),
            rawCollection('clock_consents').where('orgId', '==', req.orgId).get()
        ]);
        const byUser = new Map();
        consentSnap.docs.forEach((d) => { const c = d.data(); if (!byUser.has(c.userId)) byUser.set(c.userId, []); byUser.get(c.userId).push(c); });
        const g = R.biometricGuard(value, workers, rows, (uid, t) => R.consentStatus(byUser.get(uid) || [], t, notices[t].version));
        if (!g.ok) {
            return res.status(409).json({ success: false, code: 'biometric_consent_missing', error: `Biometric clocking cannot be enabled yet: ${g.missing.length} worker(s) have not given the required consent or notice.`, missing: g.missing.slice(0, 50), adapterAvailable: bio.isAvailable() });
        }
    }
    const id = value.scope === 'org' ? `${req.orgId}_org` : value.scope === 'state' ? `${req.orgId}_state_${value.state}` : `${req.orgId}_loc_${value.locationId}`;
    const doc = { ...value, orgId: req.orgId, active: true, updatedAt: new Date().toISOString(), updatedBy: req.user.id };
    await rawCollection('clock_policies').doc(id).set(doc);
    audit(req.orgId, req, 'clock_policy_saved', id, { scope: value.scope, selfie: value.selfie, geofence: value.geofence.mode, biometric: value.biometric.enabled });
    res.json({ success: true, policy: { id, ...doc } });
});

router.delete(`${base}/policies/:id`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    const ref = rawCollection('clock_policies').doc(req.params.id);
    const s = await ref.get();
    if (!exists(s) || s.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Policy not found' });
    await ref.delete();
    audit(req.orgId, req, 'clock_policy_removed', req.params.id);
    res.json({ success: true });
});

router.get(`${base}/requirements`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    const state = String(req.query.state || '').toUpperCase(); const city = req.query.city || null;
    const policies = await io.loadPolicies(req.orgId);
    const policy = R.resolvePolicy(policies, { state, locationId: req.query.locationId });
    const rows = await io.rulesForEval(req.orgId);
    res.json({ success: true, policyId: policy ? policy.id : null, requirements: policy ? R.requirements(policy, state, city, rows) : null });
});

/* ------------------------------ jurisdiction table and notices ------------------------------ */

router.get(`${base}/jurisdictions`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    res.json({ success: true, note: 'Confirm every row with counsel. Rows are starting points, not legal advice.', canEdit: can(req.user, 'security.manage'), data: await io.loadJurisdictionRows(req.orgId) });
});

router.put(`${base}/jurisdictions/:key`, requirePermission('security.manage'), requireUsOrg, async (req, res) => {
    const key = String(req.params.key).replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
    if (!key) return res.status(400).json({ success: false, error: 'Invalid key' });
    const b = req.body || {};
    const errors = [];
    const arr = (v) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
    const methods = arr(b.methods).filter((m) => R.METHODS.includes(m));
    const requires = (Array.isArray(b.requires) ? b.requires : []).map((r) => ({ type: String(r.type), level: String(r.level || 'notice').slice(0, 40) })).filter((r) => R.CONSENT_TYPES.includes(r.type));
    const states = arr(b.states).map((s) => s.toUpperCase());
    if (!String(b.name || '').trim()) errors.push('name is required');
    if (!states.length || states.some((s) => !/^[A-Z]{2}$/.test(s))) errors.push('states must be 2-letter codes');
    if (!methods.length) errors.push('Choose at least one method');
    if (errors.length) return res.status(400).json({ success: false, errors });
    const seed = R.DEFAULT_JURISDICTIONS.find((r) => r.key === key);
    const doc = {
        orgId: req.orgId, key, name: String(b.name).slice(0, 160), states, cities: arr(b.cities).map((c) => c.toLowerCase()), methods, requires,
        summary: String(b.summary || '').slice(0, 800), retention: b.retention || null, enabled: b.enabled !== false,
        verify: true, note: 'Confirm with counsel before relying on this row.', custom: !seed, updatedAt: new Date().toISOString(), updatedBy: req.user.id
    };
    await rawCollection('clock_jurisdiction_rules').doc(`${req.orgId}_${key}`).set(doc);
    audit(req.orgId, req, 'clock_jurisdiction_saved', key, { enabled: doc.enabled });
    res.json({ success: true, row: doc });
});

router.get(`${base}/notices`, requireAnyPermission('time.manage_rules', 'people.read'), requireUsOrg, async (req, res) => {
    res.json({ success: true, data: Object.values(await io.loadNotices(req.orgId)) });
});

router.put(`${base}/notices/:type`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    if (!R.CONSENT_TYPES.includes(req.params.type)) return res.status(404).json({ success: false, error: 'Unknown notice type' });
    const b = req.body || {};
    if (![b.title_en, b.body_en, b.title_es, b.body_es].some(Boolean)) return res.status(400).json({ success: false, error: 'Nothing to change' });
    const n = await io.saveNotice(req.orgId, req.params.type, b, req.user.id);
    audit(req.orgId, req, 'clock_notice_new_version', req.params.type, { version: n.version });
    res.status(201).json({ success: true, notice: n });
});

/** Consent status per person */
router.get(`${base}/consents/status`, requireAnyPermission('time.manage_rules', 'people.read'), requireUsOrg, async (req, res) => {
    const [users, policies, notices, rows, snap] = await Promise.all([
        rawCollection('users').where('orgId', '==', req.orgId).get(), io.loadPolicies(req.orgId), io.loadNotices(req.orgId), io.rulesForEval(req.orgId),
        rawCollection('clock_consents').where('orgId', '==', req.orgId).get()
    ]);
    const locs = new Map((await rawCollection('locations').where('orgId', '==', req.orgId).get()).docs.map((d) => [d.id, d.data()]));
    const byUser = new Map();
    snap.docs.forEach((d) => { const c = d.data(); if (!byUser.has(c.userId)) byUser.set(c.userId, []); byUser.get(c.userId).push(c); });
    const data = [];
    for (const d of users.docs) {
        const u = d.data(); if (!activeStatus(u)) continue;
        const p = u.usProfile || {}; const lid = p.locationId || u.locationId || null; const loc = lid ? locs.get(String(lid)) : null;
        const workState = p.workState || (loc && loc.state) || null; const city = (loc && loc.city) || p.workCity || null;
        const policy = R.resolvePolicy(policies, { state: workState, locationId: lid });
        if (!policy) { data.push({ userId: d.id, name: u.name, workState, policy: null, types: [] }); continue; }
        const rq = R.requirements(policy, workState, city, rows);
        data.push({
            userId: d.id, name: u.name || null, workState, policy: policy.scope, selfie: policy.selfie, geofence: policy.geofence.mode,
            types: rq.types.map((t) => ({ type: t, status: R.consentStatus(byUser.get(d.id) || [], t, notices[t].version) }))
        });
    }
    res.json({ success: true, data });
});

router.get(`${base}/biometric`, requirePermission('time.manage_rules'), requireUsOrg, (req, res) => {
    res.json({ success: true, implemented: false, adapterAvailable: bio.isAvailable(), note: 'Biometric clocking is not implemented. Only a vendor-device adapter interface exists.', contract: bio.CONTRACT });
});

/* ------------------------------ photos ------------------------------ */

async function targetPerson(orgId, userId) {
    const s = await rawCollection('users').doc(String(userId)).get();
    return exists(s) && s.data().orgId === orgId ? { id: s.id, ...s.data() } : null;
}

async function mayReview(req, photo) {
    const person = await targetPerson(req.orgId, photo.userId);
    if (!person || photo.userId === req.user.id) return false;
    return canManage(req.user, person, 'time');
}

router.get(`${base}/photos/queue`, REVIEWER, requireUsOrg, async (req, res) => {
    const status = String(req.query.status || 'pending');
    const snap = await rawCollection('punch_photos').where('orgId', '==', req.orgId).get();
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => status === 'all' || p.status === status);
    rows = (await teamScope.filterRows(req.user, req.orgId, rows, 'time')).filter((p) => p.userId !== req.user.id);
    const people = await teamScope.loadOrgPeople(req.orgId);
    rows.sort((a, b) => String(b.takenAt).localeCompare(String(a.takenAt)));
    res.json({ success: true, data: rows.slice(0, 200).map((p) => ({ id: p.id, userId: p.userId, name: (people.get(p.userId) || {}).name || null, punchId: p.punchId, takenAt: p.takenAt, expiresAt: p.expiresAt, status: p.status, reviewedBy: p.reviewedBy || null, note: p.note || null })) });
});

router.get(`${base}/photos/:id/image`, REVIEWER, requireUsOrg, async (req, res) => {
    const s = await rawCollection('punch_photos').doc(req.params.id).get();
    if (!exists(s) || s.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Photo not found' });
    if (!(await mayReview(req, s.data()))) return res.status(403).json({ success: false, error: 'Not allowed' });
    let buf;
    try { buf = await files.readFile(req.orgId, io.photoFileId(req.params.id)); } catch (_) { return res.status(404).json({ success: false, error: 'Photo has been deleted' }); }
    audit(req.orgId, req, 'punch_photo_viewed', req.params.id, { userId: s.data().userId });
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(buf);
});

router.put(`${base}/photos/:id/review`, REVIEWER, requireUsOrg, async (req, res) => {
    const decision = String((req.body && req.body.decision) || '');
    if (!['approve', 'flag'].includes(decision)) return res.status(400).json({ success: false, error: 'decision must be approve or flag' });
    const ref = rawCollection('punch_photos').doc(req.params.id);
    const s = await ref.get();
    if (!exists(s) || s.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Photo not found' });
    if (!(await mayReview(req, s.data()))) return res.status(403).json({ success: false, error: 'Not allowed' });
    const patch = { status: decision === 'approve' ? 'approved' : 'flagged', reviewedBy: req.user.id, reviewedAt: new Date().toISOString(), note: String((req.body && req.body.note) || '').slice(0, 300) };
    await ref.update(patch);
    audit(req.orgId, req, decision === 'approve' ? 'punch_photo_approved' : 'punch_photo_flagged', req.params.id, { userId: s.data().userId });
    res.json({ success: true, photo: { id: s.id, ...patch } });
});

router.post(`${base}/photos/purge`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    const out = await io.purgeExpiredPhotos({ orgId: req.orgId, now: req.body && req.body.now && process.env.NODE_ENV !== 'production' ? new Date(req.body.now) : new Date() });
    audit(req.orgId, req, 'punch_photos_purged', null, out);
    res.json({ success: true, ...out });
});

router.delete(`${base}/photos/person/:userId`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    if (!(await targetPerson(req.orgId, req.params.userId))) return res.status(404).json({ success: false, error: 'Person not found' });
    const n = await io.destroyPhotosFor(req.orgId, req.params.userId, 'manual_or_termination');
    res.json({ success: true, destroyed: n });
});

/* ------------------------------ exceptions ------------------------------ */

router.get(`${base}/exceptions`, REVIEWER, requireUsOrg, async (req, res) => {
    const status = String(req.query.status || 'open');
    const snap = await rawCollection('clock_exceptions').where('orgId', '==', req.orgId).get();
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((e) => status === 'all' || e.status === status);
    if (req.query.from) rows = rows.filter((e) => e.createdAt >= req.query.from);
    if (req.query.to) rows = rows.filter((e) => e.createdAt <= `${req.query.to}T23:59:59Z`);
    rows = await teamScope.filterRows(req.user, req.orgId, rows, 'time');
    const people = await teamScope.loadOrgPeople(req.orgId);
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const byCode = {};
    rows.forEach((e) => (e.codes || []).forEach((c) => { byCode[c] = (byCode[c] || 0) + 1; }));
    res.json({ success: true, count: rows.length, byCode, data: rows.slice(0, 300).map((e) => ({ ...e, name: (people.get(e.userId) || {}).name || null })) });
});

router.put(`${base}/exceptions/:id/resolve`, REVIEWER, requireUsOrg, async (req, res) => {
    const ref = rawCollection('clock_exceptions').doc(req.params.id);
    const s = await ref.get();
    if (!exists(s) || s.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Exception not found' });
    const person = await targetPerson(req.orgId, s.data().userId);
    if (!person || !canManage(req.user, person, 'time')) return res.status(403).json({ success: false, error: 'Not allowed' });
    const patch = { status: 'resolved', resolvedBy: req.user.id, resolvedAt: new Date().toISOString(), resolution: String((req.body && req.body.note) || '').slice(0, 300) };
    await ref.update(patch);
    audit(req.orgId, req, 'clock_exception_resolved', req.params.id, { userId: s.data().userId });
    res.json({ success: true });
});

/* ------------------------------ hourly photo purge ------------------------------ */

if (process.env.NODE_ENV !== 'test' && !process.env.DISABLE_PHOTO_PURGE_JOB) {
    const timer = setInterval(() => { io.purgeExpiredPhotos().catch((e) => logger.error(`Photo purge failed: ${e.message}`)); }, 60 * 60 * 1000);
    if (timer.unref) timer.unref();
}

module.exports = router;
