const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { admin, db, rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { getCountryConfig } = require('../country-config');
const rules = require('../services/time-rules');

const KIOSK_SESSION_SECONDS = 45;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const DUPLICATE_WINDOW_MS = 15000;
const MANAGER_ROLES = [...ADMIN_HR_ROLES, 'Manager', 'manager'];

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Company time zone, country and overtime setting */
async function orgInfo(orgId) {
    const snap = await rawCollection('organizations').doc(orgId).get();
    const data = exists(snap) ? snap.data() : {};
    const country = getCountryConfig(data.country || data.Country);
    const candidate = (data.usProfile && data.usProfile.timezone) || data.timezone || data.Time_Zone || country.timeZones[0];
    let tz = country.timeZones[0];
    try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }); tz = candidate; } catch (_) {}
    return { orgId, tz, country: country.code, overtimeWeeklyHours: country.code === 'US' ? 40 : null };
}

/** Punches for a user at or after `sinceIso`, oldest first */
async function punchesSince(orgId, userId, sinceIso, tx) {
    const q = rawCollection('time_punches').where('userId', '==', userId).where('at', '>=', sinceIso).orderBy('at');
    const snap = tx ? await tx.get(q) : await q.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.orgId === orgId);
}

function buildStatus(punches, info, nowIso) {
    const state = rules.stateOf(punches);
    const sheet = rules.timesheet(punches, info.tz, nowIso, info.overtimeWeeklyHours);
    const today = sheet.days.find((d) => d.date === rules.localDate(nowIso, info.tz));
    const week = sheet.weeks.find((w) => w.weekStart === rules.weekStart(rules.localDate(nowIso, info.tz)));
    const last = punches.length ? punches[punches.length - 1] : null;
    const lastIn = [...punches].reverse().find((p) => p.type === 'in');
    return {
        state,
        allowed: rules.allowedActions(state),
        lastPunchAt: last ? last.at : null,
        shiftStartedAt: state !== 'out' && lastIn ? lastIn.at : null,
        todayMinutes: today ? today.workedMinutes : 0,
        weekMinutes: week ? week.workedMinutes : 0,
        forgottenClockOut: rules.isForgottenClockOut(punches, nowIso),
        timeZone: info.tz,
        serverNow: nowIso
    };
}

const daysAgoIso = (n, from = new Date()) => new Date(from.getTime() - n * 86400000).toISOString();

function cleanLocation(loc) {
    if (!loc || typeof loc !== 'object') return null;
    const lat = Number(loc.lat);
    const lng = Number(loc.lng);
    if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) return null;
    const out = { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 };
    if (Number.isFinite(Number(loc.accuracy))) out.accuracy = Math.round(Number(loc.accuracy));
    return out;
}

/**
 * Records one punch if it is allowed. Runs in a transaction so two quick taps cannot both
 * clock in. A repeat of the same action within 15 seconds is treated as the same tap.
 */
async function recordPunch({ orgId, userId, employeeId, type, source, deviceId, location, note, addedBy }) {
    const info = await orgInfo(orgId);
    const nowIso = new Date().toISOString();
    return admin.firestore().runTransaction(async (tx) => {
        const punches = await punchesSince(orgId, userId, daysAgoIso(8), tx);
        const last = punches.length ? punches[punches.length - 1] : null;
        if (last && last.type === type && (Date.now() - new Date(last.at).getTime()) < DUPLICATE_WINDOW_MS) {
            return { ok: true, duplicate: true, status: buildStatus(punches, info, nowIso) };
        }
        const code = rules.checkPunch(rules.stateOf(punches), type);
        if (code) return { ok: false, code, status: buildStatus(punches, info, nowIso) };
        const punch = {
            orgId, userId, employeeId: employeeId || null, type, at: nowIso,
            localDate: rules.localDate(nowIso, info.tz), tz: info.tz, source: source || 'web',
            deviceId: deviceId || null, location: cleanLocation(location), note: note ? String(note).slice(0, 200) : null,
            addedBy: addedBy || null
        };
        tx.set(rawCollection('time_punches').doc(), punch);
        return { ok: true, duplicate: false, status: buildStatus([...punches, punch], info, nowIso) };
    });
}

const ERROR_TEXT = {
    already_in: 'You are already clocked in.', not_in: 'You are not clocked in.', already_on_break: 'You are already on a break.',
    not_on_break: 'You are not on a break.', unknown_action: 'Unknown action.', not_allowed: 'That is not possible right now.'
};

/* ----------------------------- Shared-device kiosk (no login) ----------------------------- */

const kioskLimiter = rateLimit({
    windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
    message: { success: false, error: 'Too many attempts. Please wait a minute.' }
});

async function kioskFromRequest(req) {
    const key = String(req.get('X-Kiosk-Key') || '');
    if (key.length < 20) return null;
    const q = await rawCollection('kiosks').where('keyHash', '==', sha256(key)).limit(1).get();
    if (q.empty) return null;
    const k = q.docs[0].data();
    return k.active === false ? null : { id: q.docs[0].id, orgId: k.orgId, name: k.name };
}

router.post('/kiosk/identify', kioskLimiter, async (req, res) => {
    const kiosk = await kioskFromRequest(req);
    if (!kiosk) return res.status(401).json({ success: false, code: 'kiosk_not_authorized', error: 'This device is not set up' });
    const employeeId = rules.employeeIdFromKeypad(req.body && req.body.employeeNumber);
    const pin = String((req.body && req.body.pin) || '');
    if (!employeeId || !rules.validPin(pin)) return res.status(400).json({ success: false, code: 'bad_input', error: 'Check your number and PIN' });

    const q = await rawCollection('users').where('employeeId', '==', employeeId).limit(5).get();
    const doc = q.docs.find((d) => d.data().orgId === kiosk.orgId);
    const generic = () => res.status(401).json({ success: false, code: 'wrong_pin', error: 'Number or PIN is not right' });
    if (!doc) { await bcrypt.compare(pin, '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali'); return generic(); }
    const u = doc.data();
    if (u.status && !['active', 'terminating'].includes(String(u.status).toLowerCase())) return res.status(403).json({ success: false, code: 'inactive', error: 'This account is not active' });
    if (u.pinLockedUntil && new Date(u.pinLockedUntil) > new Date()) {
        return res.status(423).json({ success: false, code: 'locked', error: 'Too many wrong tries. Ask your manager for help.' });
    }
    const ok = u.pinHash ? await bcrypt.compare(pin, u.pinHash) : false;
    if (!ok) {
        const attempts = (u.pinAttempts || 0) + 1;
        const patch = { pinAttempts: attempts };
        if (attempts >= PIN_MAX_ATTEMPTS) { patch.pinLockedUntil = new Date(Date.now() + PIN_LOCK_MINUTES * 60000).toISOString(); patch.pinAttempts = 0; }
        await doc.ref.update(patch);
        return generic();
    }
    if (u.pinAttempts) await doc.ref.update({ pinAttempts: 0 });

    const info = await orgInfo(kiosk.orgId);
    const nowIso = new Date().toISOString();
    const status = buildStatus(await punchesSince(kiosk.orgId, doc.id, daysAgoIso(8)), info, nowIso);
    const session = jwt.sign({ type: 'kiosk_session', uid: doc.id, orgId: kiosk.orgId, kioskId: kiosk.id }, process.env.JWT_SECRET, { expiresIn: KIOSK_SESSION_SECONDS });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, session, name: u.name || employeeId, firstName: String(u.name || '').split(' ')[0], status });
});

router.post('/kiosk/punch', kioskLimiter, async (req, res) => {
    const kiosk = await kioskFromRequest(req);
    if (!kiosk) return res.status(401).json({ success: false, code: 'kiosk_not_authorized', error: 'This device is not set up' });
    let claims;
    try {
        claims = jwt.verify(String((req.body && req.body.session) || ''), process.env.JWT_SECRET);
    } catch (_) {
        return res.status(401).json({ success: false, code: 'session_expired', error: 'Please enter your PIN again' });
    }
    if (claims.type !== 'kiosk_session' || claims.kioskId !== kiosk.id || claims.orgId !== kiosk.orgId) {
        return res.status(401).json({ success: false, code: 'session_expired', error: 'Please enter your PIN again' });
    }
    const userSnap = await rawCollection('users').doc(claims.uid).get();
    const u = exists(userSnap) ? userSnap.data() : {};
    const result = await recordPunch({
        orgId: kiosk.orgId, userId: claims.uid, employeeId: u.employeeId, type: String(req.body.action || ''),
        source: 'kiosk', deviceId: kiosk.id
    });
    if (!result.ok) return res.status(409).json({ success: false, code: result.code, error: ERROR_TEXT[result.code], status: result.status });
    res.json({ success: true, duplicate: result.duplicate, name: u.name || null, status: result.status });
});

/* ----------------------------- Signed-in users (any role) ----------------------------- */

router.use(verifyToken);

function orgIdOf(req) {
    return req.user.orgId || req.tenantOrgId || null;
}

function requireOrg(req, res, next) {
    const orgId = orgIdOf(req);
    if (!orgId) return res.status(404).json({ success: false, error: 'No organization for this user' });
    req.orgId = orgId;
    next();
}

const norm = (r) => String(r || '').toLowerCase().replace(/[\s_-]+/g, '');
const hasRole = (user, list) => list.some((r) => norm(r) === norm(user.role));

router.get('/status', requireOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const nowIso = new Date().toISOString();
    const punches = await punchesSince(req.orgId, req.user.id, daysAgoIso(8));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, name: req.user.name || null, country: info.country, status: buildStatus(punches, info, nowIso) });
});

router.post('/punch', requireOrg, async (req, res) => {
    const result = await recordPunch({
        orgId: req.orgId, userId: req.user.id, employeeId: req.user.employeeId, type: String((req.body && req.body.action) || ''),
        source: 'web', deviceId: req.body && req.body.deviceId ? String(req.body.deviceId).slice(0, 60) : null,
        location: req.body && req.body.location, note: req.body && req.body.note
    });
    if (!result.ok) return res.status(409).json({ success: false, code: result.code, error: ERROR_TEXT[result.code], status: result.status });
    res.json({ success: true, duplicate: result.duplicate, status: result.status });
});

router.get('/timesheet', requireOrg, async (req, res) => {
    const targetId = req.query.userId && req.query.userId !== req.user.id ? String(req.query.userId) : req.user.id;
    if (targetId !== req.user.id && !hasRole(req.user, ADMIN_HR_ROLES)) {
        return res.status(403).json({ success: false, error: 'Not allowed' });
    }
    if (targetId !== req.user.id) {
        const t = await rawCollection('users').doc(targetId).get();
        if (!exists(t) || t.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Person not found' });
    }
    const info = await orgInfo(req.orgId);
    const nowIso = new Date().toISOString();
    const today = rules.localDate(nowIso, info.tz);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : rules.weekStart(today);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const sinceIso = new Date(new Date(`${from}T00:00:00Z`).getTime() - 86400000).toISOString();
    const punches = (await punchesSince(req.orgId, targetId, sinceIso)).filter((p) => p.localDate <= to);
    const sheet = rules.timesheet(punches, info.tz, nowIso, info.overtimeWeeklyHours);
    res.json({
        success: true, userId: targetId, from, to, timeZone: info.tz, overtimeWeeklyHours: info.overtimeWeeklyHours,
        days: sheet.days.filter((d) => d.date >= from && d.date <= to), weeks: sheet.weeks
    });
});

/** Who is working right now (managers and HR) */
router.get('/team/now', authorize(MANAGER_ROLES), requireOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const nowIso = new Date().toISOString();
    const [people, punchSnap] = await Promise.all([
        rawCollection('users').where('orgId', '==', req.orgId).get(),
        rawCollection('time_punches').where('orgId', '==', req.orgId).where('at', '>=', daysAgoIso(2)).orderBy('at').get()
    ]);
    const byUser = new Map();
    punchSnap.docs.forEach((d) => { const p = d.data(); if (!byUser.has(p.userId)) byUser.set(p.userId, []); byUser.get(p.userId).push(p); });
    const rows = people.docs.filter((d) => ['active', 'terminating'].includes(String(d.data().status || 'Active').toLowerCase())).map((d) => {
        const u = d.data();
        const s = buildStatus(byUser.get(d.id) || [], info, nowIso);
        return { userId: d.id, employeeId: u.employeeId || null, name: u.name, jobTitle: u.jobTitle || null, department: u.departmentName || null,
            hasPin: Boolean(u.pinHash), state: s.state, since: s.shiftStartedAt, todayMinutes: s.todayMinutes, forgottenClockOut: s.forgottenClockOut };
    }).sort((a, b) => (a.state === 'out') - (b.state === 'out') || String(a.name).localeCompare(String(b.name)));
    res.json({ success: true, timeZone: info.tz, counts: { in: rows.filter((r) => r.state === 'in').length, break: rows.filter((r) => r.state === 'break').length, out: rows.filter((r) => r.state === 'out').length }, data: rows });
});

/** HR adds a missed punch (with a reason, written to the audit log) */
router.post('/punches/manual', authorize(ADMIN_HR_ROLES), requireOrg, async (req, res) => {
    const { userId, type, at, reason } = req.body || {};
    if (!rules.PUNCH_TYPES.includes(type)) return res.status(400).json({ success: false, error: 'type must be in, out, break_start or break_end' });
    const when = new Date(at);
    if (!userId || Number.isNaN(when.getTime()) || when > new Date()) return res.status(400).json({ success: false, error: 'userId and a past time (at) are required' });
    if (String(reason || '').trim().length < 5) return res.status(400).json({ success: false, error: 'A reason of at least 5 characters is required' });
    const t = await rawCollection('users').doc(String(userId)).get();
    if (!exists(t) || t.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Person not found' });
    const info = await orgInfo(req.orgId);
    const atIso = when.toISOString();
    await rawCollection('time_punches').add({
        orgId: req.orgId, userId, employeeId: t.data().employeeId || null, type, at: atIso, localDate: rules.localDate(atIso, info.tz),
        tz: info.tz, source: 'manual', deviceId: null, location: null, note: String(reason).slice(0, 200), addedBy: req.user.id
    });
    rawCollection('organizations').doc(req.orgId).collection('audit_logs').add({
        action: 'time_punch_added_manually', targetId: userId, actorId: req.user.id, at: new Date().toISOString(), type, punchAt: atIso, reason: String(reason).slice(0, 200)
    }).catch((e) => logger.error(`Audit write failed: ${e.message}`));
    res.status(201).json({ success: true });
});

/** HR sets or resets a worker's kiosk PIN; if none is given a random 4-digit PIN is made and shown once */
router.put('/pin', authorize(ADMIN_HR_ROLES), requireOrg, async (req, res) => {
    const userId = String((req.body && req.body.userId) || '');
    const t = await rawCollection('users').doc(userId).get();
    if (!userId || !exists(t) || t.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Person not found' });
    const pin = req.body.pin ? String(req.body.pin) : String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!rules.validPin(pin)) return res.status(400).json({ success: false, error: 'PIN must be 4 to 6 digits' });
    await t.ref.update({ pinHash: await bcrypt.hash(pin, 10), pinAttempts: 0, pinLockedUntil: null, pinSetAt: new Date().toISOString() });
    rawCollection('organizations').doc(req.orgId).collection('audit_logs').add({
        action: 'kiosk_pin_set', targetId: userId, actorId: req.user.id, at: new Date().toISOString()
    }).catch(() => {});
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, employeeId: t.data().employeeId || null, name: t.data().name || null, pin });
});

/** Kiosk devices: the key is shown once when the kiosk is created */
router.post('/kiosks', authorize(ADMIN_HR_ROLES), requireOrg, async (req, res) => {
    const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    const key = crypto.randomBytes(32).toString('base64url');
    const ref = await rawCollection('kiosks').add({ orgId: req.orgId, name, keyHash: sha256(key), active: true, createdAt: new Date().toISOString(), createdBy: req.user.id });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, id: ref.id, name, key, setupPath: `/kiosk.html?key=${key}` });
});

router.get('/kiosks', authorize(ADMIN_HR_ROLES), requireOrg, async (req, res) => {
    const snap = await rawCollection('kiosks').where('orgId', '==', req.orgId).get();
    res.json({ success: true, data: snap.docs.map((d) => ({ id: d.id, name: d.data().name, active: d.data().active !== false, createdAt: d.data().createdAt })) });
});

router.delete('/kiosks/:id', authorize(ADMIN_HR_ROLES), requireOrg, async (req, res) => {
    const ref = rawCollection('kiosks').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Kiosk not found' });
    await ref.update({ active: false, deactivatedAt: new Date().toISOString() });
    res.json({ success: true });
});

// Shared with the leave routes (worked hours drive hours-based accrual)
router.helpers = { orgInfo, punchesSince };

module.exports = router;
