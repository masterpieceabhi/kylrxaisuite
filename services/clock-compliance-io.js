/**
 * Clock compliance (I/O side): policies, jurisdiction rows, notice templates, consents, photos, exceptions.
 * Called by routes/time.js (hook inside recordPunch) and routes/us-clock-policy.js. Every doc has orgId.
 */
const crypto = require('crypto');
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const R = require('./clock-compliance-rules');
const files = require('./file-store');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const nowIso = () => new Date().toISOString();
const photoFileId = (id) => `punch_photos_${id}`;

/* ------------------------------ jurisdiction table ------------------------------ */

async function loadJurisdictionRows(orgId, { seed = true } = {}) {
    const col = rawCollection('clock_jurisdiction_rules');
    let snap = await col.where('orgId', '==', orgId).get();
    if (snap.empty && seed) {
        await Promise.all(R.DEFAULT_JURISDICTIONS.map((r) => col.doc(`${orgId}_${r.key}`).set({ ...r, orgId, seededAt: nowIso() })));
        snap = await col.where('orgId', '==', orgId).get();
    }
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

/** Active rows only, for evaluation (a policy's org with no rows yet falls back to the seed without writing) */
async function rulesForEval(orgId) {
    const rows = await loadJurisdictionRows(orgId, { seed: false });
    return rows.length ? rows : R.DEFAULT_JURISDICTIONS;
}

/* ------------------------------ notices ------------------------------ */

async function loadNotices(orgId) {
    const snap = await rawCollection('clock_notices').where('orgId', '==', orgId).get();
    const latest = {};
    snap.docs.map((d) => ({ id: d.id, ...d.data() })).forEach((n) => { if (!latest[n.type] || n.version > latest[n.type].version) latest[n.type] = n; });
    const out = {};
    for (const type of R.CONSENT_TYPES) {
        const n = latest[type] || { type, version: 1, ...R.DEFAULT_NOTICES[type], isDefault: true };
        out[type] = { ...n, textHash: n.textHash || R.textHashOf(n) };
    }
    return out;
}

async function saveNotice(orgId, type, body, userId) {
    const notices = await loadNotices(orgId);
    const cur = notices[type];
    const doc = {
        orgId, type, version: (cur.isDefault ? 1 : cur.version) + 1,
        title_en: String(body.title_en || cur.title_en).slice(0, 200), body_en: String(body.body_en || cur.body_en).slice(0, 6000),
        title_es: String(body.title_es || cur.title_es).slice(0, 200), body_es: String(body.body_es || cur.body_es).slice(0, 6000),
        createdAt: nowIso(), createdBy: userId
    };
    doc.textHash = R.textHashOf(doc);
    const ref = await rawCollection('clock_notices').add(doc);
    return { id: ref.id, ...doc };
}

/* ------------------------------ policies ------------------------------ */

async function loadPolicies(orgId) {
    const snap = await rawCollection('clock_policies').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.active !== false);
}

async function userContext(orgId, userId) {
    const snap = await rawCollection('users').doc(userId).get();
    if (!exists(snap) || snap.data().orgId !== orgId) return null;
    const u = snap.data(); const p = u.usProfile || {};
    let locationId = p.locationId || u.locationId || null;
    let city = p.workCity || p.city || (p.homeAddress && p.homeAddress.city) || null;
    let state = p.workState || null;
    if (locationId) {
        const l = await rawCollection('locations').doc(String(locationId)).get();
        if (exists(l) && l.data().orgId === orgId) { city = l.data().city || city; state = state || l.data().state || null; }
    }
    return { id: userId, data: u, workState: state, city, locationId };
}

/* ------------------------------ consents ------------------------------ */

async function loadConsents(orgId, userId) {
    const snap = await rawCollection('clock_consents').where('userId', '==', userId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => c.orgId === orgId);
}

async function recordConsent(orgId, userId, type, decision, { ip, source, notices } = {}) {
    if (!R.CONSENT_TYPES.includes(type)) throw Object.assign(new Error('Unknown consent type'), { status: 400 });
    const n = (notices || await loadNotices(orgId))[type];
    const doc = {
        orgId, userId, type, version: n.version, textHash: n.textHash, decision: decision === 'declined' ? 'declined' : 'accepted',
        signedAt: nowIso(), ip: ip || null, source: source || 'web', revokedAt: null
    };
    const ref = await rawCollection('clock_consents').add(doc);
    return { id: ref.id, ...doc };
}

async function revokeConsent(orgId, userId, type, byUserId) {
    const mine = (await loadConsents(orgId, userId)).filter((c) => c.type === type && !c.revokedAt && c.decision === 'accepted');
    const at = nowIso();
    await Promise.all(mine.map((c) => rawCollection('clock_consents').doc(c.id).update({ revokedAt: at, revokedBy: byUserId })));
    // Declined marker so the method stays off until the person accepts again
    const marker = await recordConsent(orgId, userId, type, 'declined', { source: 'revocation' });
    const destroyed = type === 'location_notice' ? 0 : await destroyPhotosFor(orgId, userId, 'consent_revoked');
    return { revoked: mine.length, photosDestroyed: destroyed, marker };
}

/** What a worker must still accept (none/stale), with the notice text to show */
async function pendingFor(orgId, userId, { policies, ctx, notices, consents, rows } = {}) {
    ctx = ctx || await userContext(orgId, userId);
    if (!ctx) return null;
    policies = policies || await loadPolicies(orgId);
    const policy = R.resolvePolicy(policies, { state: ctx.workState, locationId: ctx.locationId });
    if (!policy) return { policy: null, pending: [], required: false };
    notices = notices || await loadNotices(orgId);
    consents = consents || await loadConsents(orgId, userId);
    rows = rows || await rulesForEval(orgId);
    const req = R.requirements(policy, ctx.workState, ctx.city, rows);
    const statuses = {};
    req.types.forEach((t) => { statuses[t] = R.consentStatus(consents, t, notices[t].version); });
    const pending = req.types.filter((t) => statuses[t] === 'none' || statuses[t] === 'stale').map((t) => ({
        type: t, version: notices[t].version, textHash: notices[t].textHash, title_en: notices[t].title_en, body_en: notices[t].body_en, title_es: notices[t].title_es, body_es: notices[t].body_es
    }));
    return { policy, req, statuses, pending, required: pending.length > 0, selfie: policy.selfie, geofence: policy.geofence.mode, workState: ctx.workState };
}

/* ------------------------------ photos ------------------------------ */

async function destroyPhoto(orgId, photoDocId) {
    try { await files.removeFile(orgId, photoFileId(photoDocId)); } catch (e) { logger.error(`photo file removal failed: ${e.message}`); }
    await rawCollection('punch_photos').doc(photoDocId).delete();
}

async function destroyPhotosFor(orgId, userId, reason) {
    const snap = await rawCollection('punch_photos').where('userId', '==', userId).get();
    const mine = snap.docs.filter((d) => d.data().orgId === orgId);
    for (const d of mine) await destroyPhoto(orgId, d.id);
    if (mine.length) await rawCollection('organizations').doc(orgId).collection('audit_logs').add({ action: 'punch_photos_destroyed', targetId: userId, at: nowIso(), reason, count: mine.length }).catch(() => {});
    return mine.length;
}

/** Deletes photos past retention, and photos of people who are no longer employed */
async function purgeExpiredPhotos({ orgId = null, now = new Date() } = {}) {
    const iso = now.toISOString();
    const snap = await rawCollection('punch_photos').get();
    let expired = 0; let terminated = 0;
    const statusCache = new Map();
    for (const d of snap.docs) {
        const p = d.data();
        if (orgId && p.orgId !== orgId) continue;
        if (p.expiresAt && p.expiresAt <= iso) { await destroyPhoto(p.orgId, d.id); expired += 1; continue; }
        const key = `${p.orgId}:${p.userId}`;
        if (!statusCache.has(key)) {
            const u = await rawCollection('users').doc(p.userId).get();
            const st = exists(u) ? String(u.data().status || 'active').toLowerCase() : 'deleted';
            statusCache.set(key, !['active', 'terminating'].includes(st));
        }
        if (statusCache.get(key)) { await destroyPhoto(p.orgId, d.id); terminated += 1; }
    }
    if (expired || terminated) logger.info(`Punch photo purge: ${expired} expired, ${terminated} for former employees`);
    return { expired, terminated };
}

/* ------------------------------ the punch hook ------------------------------ */

function exceptionDoc(orgId, userId, punchId, ev, extra) {
    const flagged = ev.reasons.filter((r) => r.code !== 'consent_required');
    return {
        orgId, userId, punchId: punchId || null, decision: ev.decision, codes: flagged.map((r) => r.code),
        reasons: flagged.map((r) => ({ code: r.code, severity: r.severity, en: r.en, es: r.es })),
        status: 'open', createdAt: nowIso(), ...extra
    };
}

/**
 * Runs before a punch is written. Returns null when the company has no clock policy (the plain one-tap
 * path), otherwise { block, code, evaluation, pending, punchExtras, photo, ... }.
 */
async function beforePunch({ orgId, userId, type, source, deviceId, location, photo, consents, ip, tz, loadPunches }) {
    const policies = await loadPolicies(orgId);
    if (!policies.length) return null;
    const ctx = await userContext(orgId, userId);
    if (!ctx) return null;
    const policy = R.resolvePolicy(policies, { state: ctx.workState, locationId: ctx.locationId });
    if (!policy) return null;
    const at = nowIso();
    const notices = await loadNotices(orgId);
    if (Array.isArray(consents)) {
        for (const c of consents.slice(0, 8)) {
            if (c && R.CONSENT_TYPES.includes(c.type)) await recordConsent(orgId, userId, c.type, c.decision === 'declined' ? 'declined' : 'accepted', { ip, source: source === 'kiosk' ? 'kiosk' : 'web', notices });
        }
    }
    const [rows, consentDocs] = await Promise.all([rulesForEval(orgId), loadConsents(orgId, userId)]);
    const req = R.requirements(policy, ctx.workState, ctx.city, rows);
    const statuses = {};
    req.types.forEach((t) => { statuses[t] = R.consentStatus(consentDocs, t, notices[t].version); });

    const parsed = photo ? R.parsePhoto(photo) : { ok: false };
    const geoOn = req.inUse.includes('geofence');
    let sites = [];
    if (geoOn) {
        const snap = await rawCollection('locations').where('orgId', '==', orgId).get();
        sites = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.active !== false);
        const only = policy.scope === 'location' ? policy.locationId : ctx.locationId;
        if (only && sites.some((s) => s.id === only)) sites = sites.filter((s) => s.id === only);
    }
    const punches = await loadPunches();
    const last = punches.length ? punches[punches.length - 1] : null;
    const deviceHash = deviceId ? sha256(`${orgId}:${deviceId}`) : null;
    let deviceDoc = null;
    if (deviceHash && source !== 'kiosk') {
        const s = await rawCollection('clock_devices').doc(`${orgId}_${deviceHash.slice(0, 32)}`).get();
        deviceDoc = exists(s) ? s.data() : null;
    }
    let shifts = [];
    try {
        const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(at));
        const ss = await rawCollection('schedule_shifts').where('userId', '==', userId).get();
        shifts = ss.docs.map((d) => d.data()).filter((s) => s.orgId === orgId && s.status === 'published' && s.date === localDay && s.startAt);
    } catch (_) { /* schedule module is optional */ }

    const ev = R.evaluatePunch({
        policy, rules: rows, workState: ctx.workState, city: ctx.city, type, source, hasPhoto: parsed.ok, location, statuses, sites,
        deviceHash, deviceDoc, userDeviceHashes: Array.from(new Set(punches.map((p) => p.deviceHash).filter(Boolean))),
        prev: last, recent: punches, shifts, nowIso: at, tz, userId
    });
    const result = { evaluation: ev, policy, deviceHash, pending: [], ctx };
    if (ev.decision === 'block') {
        result.block = true; result.code = ev.reasons.find((r) => r.severity === 'block').code;
        if (result.code === 'consent_required') {
            result.pending = ev.pendingTypes.map((t) => ({ type: t, version: notices[t].version, title_en: notices[t].title_en, body_en: notices[t].body_en, title_es: notices[t].title_es, body_es: notices[t].body_es }));
        } else {
            await rawCollection('clock_exceptions').add(exceptionDoc(orgId, userId, null, ev, { kind: 'blocked_attempt', type, source: source || 'web', distanceMeters: ev.distanceMeters }));
        }
        return result;
    }
    const photoId = ev.usePhoto ? rawCollection('punch_photos').doc().id : null;
    result.photo = ev.usePhoto ? { id: photoId, buffer: parsed.buffer, retentionDays: policy.photoRetentionDays } : null;
    result.punchExtras = {
        deviceHash: deviceHash || null, ...(source !== 'kiosk' && deviceHash ? { deviceId: null } : {}),
        distanceMeters: ev.distanceMeters, nearestSiteId: ev.nearest ? ev.nearest.id : null,
        geofence: ev.nearest ? (ev.nearest.inside ? 'inside' : 'outside') : null,
        complianceFlags: ev.reasons.map((r) => r.code), photoId, policyId: policy.id
    };
    if (!ev.storeLocation) result.dropLocation = true;
    return result;
}

/** Runs after the punch is stored */
async function afterPunch(c, { orgId, userId, punchId, type, source, tz }) {
    if (!c) return;
    const at = nowIso();
    if (c.photo) {
        await files.saveFile(orgId, photoFileId(c.photo.id), c.photo.buffer);
        await rawCollection('punch_photos').doc(c.photo.id).set({
            orgId, userId, punchId, takenAt: at, bytes: c.photo.buffer.length, status: 'pending', source: source || 'web',
            expiresAt: new Date(Date.now() + c.photo.retentionDays * 86400000).toISOString(), retentionDays: c.photo.retentionDays
        });
    }
    if (c.evaluation.reasons.length) {
        await rawCollection('clock_exceptions').add(exceptionDoc(orgId, userId, punchId, c.evaluation, { kind: 'flagged_punch', type, source: source || 'web', distanceMeters: c.evaluation.distanceMeters }));
    }
    if (c.deviceHash && source !== 'kiosk') {
        const ref = rawCollection('clock_devices').doc(`${orgId}_${c.deviceHash.slice(0, 32)}`);
        const s = await ref.get();
        const users = exists(s) ? (s.data().users || {}) : {};
        users[userId] = at;
        await ref.set({ orgId, hashPrefix: c.deviceHash.slice(0, 12), users, lastSeen: at });
    }
}

module.exports = {
    loadJurisdictionRows, rulesForEval, loadNotices, saveNotice, loadPolicies, userContext, loadConsents, recordConsent, revokeConsent,
    pendingFor, destroyPhoto, destroyPhotosFor, purgeExpiredPhotos, beforePunch, afterPunch, photoFileId
};
