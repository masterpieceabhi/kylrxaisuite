const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { admin, db, rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/authMiddleware');
const { getCountryConfig } = require('../country-config');
const rules = require('../services/time-rules');
const policy = require('../services/time-policy');
const clockIo = require('../services/clock-compliance-io');
const access = require('../services/time-access');
const auditChain = require('../services/audit-chain');

const KIOSK_SESSION_SECONDS = 45;
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const DUPLICATE_WINDOW_MS = 15000;
// A punch made without a connection may be sent later, up to this old; after that the person asks for a fix instead
const LATE_PUNCH_MAX_HOURS = 72;
const LATE_PUNCH_FUTURE_GRACE_MS = 2 * 60000;

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Audit entry for a time route (joins the tamper-evident chain; never fails the request) */
function audit(orgId, req, action, targetId, extra = {}) {
    try {
        return auditChain.writeAudit(orgId, {
            action, targetId: targetId === undefined ? null : targetId, actorId: (req.user && (req.user.id || req.user.uid)) || null,
            actorRole: (req.user && req.user.role) || null, at: new Date().toISOString(), ip: req.ip || null, ...extra
        }).catch((e) => logger.error(`Audit write failed: ${e.message}`));
    } catch (e) {
        logger.error(`Audit write failed: ${e.message}`);
        return Promise.resolve();
    }
}

/** Company time zone, country, workweek and overtime setting */
async function orgInfo(orgId) {
    const snap = await rawCollection('organizations').doc(orgId).get();
    const data = exists(snap) ? snap.data() : {};
    const country = getCountryConfig(data.country || data.Country);
    const candidate = (data.usProfile && data.usProfile.timezone) || data.timezone || data.Time_Zone || country.timeZones[0];
    let tz = country.timeZones[0];
    try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }); tz = candidate; } catch (_) {}
    const merged = { ...policy.DEFAULT_RULES, ...((data.usProfile && data.usProfile.timeRules) || {}) };
    merged.workweek = rules.normalizeWorkweek(merged.workweek);
    return { orgId, tz, orgTz: tz, country: country.code, rules: merged, workweek: merged.workweek, overtimeWeeklyHours: country.code === 'US' ? merged.overtimeWeeklyHours : null };
}

/** The id of the place a person works at, wherever it was saved */
function workLocationIdOf(userData) {
    const u = userData || {};
    const p = u.usProfile || {};
    const id = p.workLocationId || p.locationId || u.workLocationId || u.locationId || null;
    return id ? String(id) : null;
}

/** Time zones of a company's locations: Map(locationId -> timeZone) */
async function locationZones(orgId) {
    const snap = await rawCollection('locations').where('orgId', '==', orgId).get();
    return new Map(snap.docs.map((d) => [d.id, d.data().timeZone || null]));
}

/**
 * The company info as it applies to one person: days, "today" and weeks are cut in the time zone of the
 * person's work location when that location has one, and in the company's time zone otherwise.
 * `userData` is the person's stored record when the caller already has it; `zones` a locationZones() map
 * when many people are handled in one request.
 */
async function personInfo(orgId, userId, userData, { info, zones } = {}) {
    const base = info || await orgInfo(orgId);
    let data = userData;
    if (!data && userId) {
        const snap = await rawCollection('users').doc(String(userId)).get();
        data = exists(snap) && snap.data().orgId === orgId ? snap.data() : {};
    }
    const locationId = workLocationIdOf(data);
    if (!locationId) return base;
    let zone = null;
    if (zones) zone = zones.get(locationId) || null;
    else {
        const l = await rawCollection('locations').doc(locationId).get();
        if (exists(l) && l.data().orgId === orgId) zone = l.data().timeZone || null;
    }
    return { ...base, tz: rules.pickTimeZone(zone, base.tz), locationId };
}

/** Punches for a user at or after `sinceIso`, oldest first */
async function punchesSince(orgId, userId, sinceIso, tx) {
    const q = rawCollection('time_punches').where('userId', '==', userId).where('at', '>=', sinceIso).orderBy('at');
    const snap = tx ? await tx.get(q) : await q.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.orgId === orgId && !p.voided);
}

function buildStatus(punches, info, nowIso) {
    const state = rules.stateOf(punches);
    const sheet = rules.timesheet(punches, info.tz, nowIso, info.overtimeWeeklyHours, info.workweek);
    const todayIso = rules.localDate(nowIso, info.tz);
    const today = sheet.days.find((d) => d.date === todayIso);
    const range = rules.weekRange(todayIso, info.workweek);
    const week = sheet.weeks.find((w) => w.weekStart === range.start);
    const last = punches.length ? punches[punches.length - 1] : null;
    const lastIn = [...punches].reverse().find((p) => p.type === 'in');
    return {
        state,
        allowed: rules.allowedActions(state),
        lastPunchAt: last ? last.at : null,
        shiftStartedAt: state !== 'out' && lastIn ? lastIn.at : null,
        todayMinutes: today ? today.workedMinutes : 0,
        weekMinutes: week ? week.workedMinutes : 0,
        weekStart: range.start,
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
 * True when the person's workweek containing `localDay` has been approved (it is then locked).
 * With the company's workweek setting the week is looked up directly. Without it (older callers) every
 * approved week of the person is checked by its dates, so the answer is right whatever day the workweek starts on.
 */
async function weekIsLocked(userId, localDay, workweek) {
    if (workweek) {
        const snap = await rawCollection('timesheet_weeks').doc(`${userId}_${rules.weekStartFor(localDay, workweek)}`).get();
        return exists(snap) && snap.data().status === 'approved';
    }
    const snap = await rawCollection('timesheet_weeks').where('userId', '==', userId).get();
    return snap.docs.some((d) => {
        const w = d.data();
        return w.status === 'approved' && w.weekStart <= localDay && localDay <= (w.weekEnd || rules.addDaysIso(w.weekStart, 6));
    });
}

const cleanClientKey = (k) => (typeof k === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(k) ? k : null);

/**
 * Records one punch if it is allowed. Runs in a transaction so two quick taps cannot both
 * clock in. A repeat of the same action within 15 seconds is treated as the same tap.
 *
 * clientKey: a random key the page makes for each tap. The same key is only ever recorded once, so a page that
 *   sends a punch again (because it never saw the answer) cannot make a second punch.
 * clientAt: only for a punch made without a connection and sent later. The punch is recorded at that time, marked
 *   "sent late" with the time the server received it, and listed for the manager to look at.
 */
async function recordPunch({ orgId, userId, userData, employeeId, type, source, deviceId, location, note, addedBy, photo, consents, ip, clientKey, clientAt }) {
    const info = await personInfo(orgId, userId, userData);
    const nowIso = new Date().toISOString();
    const status = async () => buildStatus(await punchesSince(orgId, userId, daysAgoIso(8)), info, nowIso);
    const key = cleanClientKey(clientKey);
    const punchRef = key ? rawCollection('time_punches').doc(`ck_${sha256(`${userId}:${key}`).slice(0, 40)}`) : rawCollection('time_punches').doc();
    if (key) {
        const already = await punchRef.get();
        if (exists(already) && already.data().orgId === orgId && already.data().userId === userId) return { ok: true, duplicate: true, status: await status() };
    }
    let atIso = nowIso;
    const late = clientAt !== undefined && clientAt !== null && clientAt !== '';
    if (late) {
        const when = new Date(clientAt);
        if (!key || Number.isNaN(when.getTime()) || when.getTime() > Date.now() + LATE_PUNCH_FUTURE_GRACE_MS) return { ok: false, code: 'late_bad_time', status: await status() };
        if (Date.now() - when.getTime() > LATE_PUNCH_MAX_HOURS * 3600000) return { ok: false, code: 'late_too_old', status: await status() };
        atIso = new Date(Math.min(when.getTime(), Date.now())).toISOString();
    }
    if (await weekIsLocked(userId, rules.localDate(atIso, info.tz), info.workweek)) {
        return { ok: false, code: 'week_locked', status: await status() };
    }
    // Clock compliance hook: does nothing (returns null) until the company sets a clock policy.
    // A punch sent late is not put through it: it carries no photo or location, and it is flagged for the manager anyway.
    let comp = null;
    if (!late) {
        try {
            comp = await clockIo.beforePunch({ orgId, userId, type, source, deviceId, location, photo, consents, ip, tz: info.tz, loadPunches: () => punchesSince(orgId, userId, daysAgoIso(8)) });
        } catch (e) { logger.error(`Clock compliance check failed: ${e.message}`); }
        if (comp && comp.block) {
            return { ok: false, code: comp.code, status: await status(), compliance: complianceView(comp) };
        }
    }
    const out = await admin.firestore().runTransaction(async (tx) => {
        if (key) {
            const again = await tx.get(punchRef);
            if (exists(again)) return { ok: true, duplicate: true };
        }
        const punches = await punchesSince(orgId, userId, daysAgoIso(8), tx);
        const last = punches.length ? punches[punches.length - 1] : null;
        if (!late && last && last.type === type && (Date.now() - new Date(last.at).getTime()) < DUPLICATE_WINDOW_MS) {
            return { ok: true, duplicate: true, status: buildStatus(punches, info, nowIso) };
        }
        // a late punch has to come after everything already recorded, or the order of in/break/out would be wrong
        if (late && last && atIso <= last.at) return { ok: false, code: 'late_out_of_order', status: buildStatus(punches, info, nowIso) };
        const code = rules.checkPunch(rules.stateOf(punches), type);
        if (code) return { ok: false, code, status: buildStatus(punches, info, nowIso) };
        const punch = {
            orgId, userId, employeeId: employeeId || null, type, at: atIso,
            localDate: rules.localDate(atIso, info.tz), tz: info.tz, source: source || 'web',
            deviceId: deviceId || null, location: comp && comp.dropLocation ? null : cleanLocation(location), note: note ? String(note).slice(0, 200) : null,
            addedBy: addedBy || null, ...(comp ? comp.punchExtras : {}),
            ...(key ? { clientKey: key } : {}),
            ...(late ? { sentLate: true, receivedAt: nowIso, clientAt: atIso, complianceFlags: ['sent_late'] } : {})
        };
        tx.set(punchRef, punch);
        return { ok: true, duplicate: false, status: buildStatus([...punches, punch], info, nowIso) };
    });
    if (out.ok && !out.status) out.status = await status();
    if (comp && out.ok && !out.duplicate) {
        try { await clockIo.afterPunch(comp, { orgId, userId, punchId: punchRef.id, type, source, tz: info.tz }); } catch (e) { logger.error(`Clock compliance follow-up failed: ${e.message}`); }
        out.compliance = complianceView(comp);
    }
    if (late && out.ok && !out.duplicate) {
        out.late = { punchAt: atIso, receivedAt: nowIso };
        try { await clockIo.recordLatePunch({ orgId, userId, punchId: punchRef.id, type, source, punchAt: atIso, receivedAt: nowIso }); } catch (e) { logger.error(`Late punch flag failed: ${e.message}`); }
    }
    if (out.ok && !out.duplicate) out.punchId = punchRef.id;
    return out;
}

/** What the clock pages need to know about a compliance check (never includes photo bytes) */
function complianceView(comp) {
    const ev = comp.evaluation;
    return { decision: ev.decision, reasons: ev.reasons.map((r) => ({ code: r.code, severity: r.severity, en: r.en, es: r.es })), pending: comp.pending || [], photoSaved: Boolean(comp.photo) };
}

const ERROR_TEXT = {
    already_in: 'You are already clocked in.', not_in: 'You are not clocked in.', already_on_break: 'You are already on a break.',
    not_on_break: 'You are not on a break.', unknown_action: 'Unknown action.', not_allowed: 'That is not possible right now.',
    week_locked: 'This week has been approved. Ask your manager if something needs to change.',
    consent_required: 'Please read and accept the notice first.', selfie_required: 'A photo is required. Please take one.', outside_geofence: 'You are outside the work site area.',
    low_accuracy: 'Your phone location is not accurate enough.', location_required: 'Location is required to clock in here.',
    outside_network: 'This device is not on an approved work network. Connect to the work network and try again.',
    late_bad_time: 'The saved time of this punch could not be read. Ask your manager to add it.',
    late_too_old: 'This punch was saved too long ago to be sent. Ask your manager to add it.',
    late_out_of_order: 'This saved punch is older than a punch already recorded. Ask your manager to check your hours.'
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

    const info = await personInfo(kiosk.orgId, doc.id, u);
    const nowIso = new Date().toISOString();
    const status = buildStatus(await punchesSince(kiosk.orgId, doc.id, daysAgoIso(8)), info, nowIso);
    let compliance = null;
    try { const c = await clockIo.pendingFor(kiosk.orgId, doc.id); if (c && c.policy) compliance = { pending: c.pending, selfie: c.selfie, required: c.required }; } catch (e) { logger.error(`Kiosk compliance lookup failed: ${e.message}`); }
    // Reading a notice or taking a photo needs more time than a plain punch
    const extra = compliance && ((compliance.pending || []).length || compliance.selfie !== 'off');
    const session = jwt.sign({ type: 'kiosk_session', uid: doc.id, orgId: kiosk.orgId, kioskId: kiosk.id }, process.env.JWT_SECRET, { expiresIn: extra ? KIOSK_SESSION_SECONDS * 4 : KIOSK_SESSION_SECONDS });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, session, name: u.name || employeeId, firstName: String(u.name || '').split(' ')[0], status, compliance });
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
    const u = exists(userSnap) && userSnap.data().orgId === kiosk.orgId ? userSnap.data() : {};
    // clientKey: the tablet sends the same key if it has to send a punch again, so it is never recorded twice
    const result = await recordPunch({
        orgId: kiosk.orgId, userId: claims.uid, userData: u, employeeId: u.employeeId, type: String(req.body.action || ''),
        source: 'kiosk', deviceId: kiosk.id, photo: req.body.photo, consents: req.body.consents, ip: req.ip, clientKey: req.body.clientKey
    });
    if (!result.ok) return res.status(409).json({ success: false, code: result.code, error: ERROR_TEXT[result.code], status: result.status, compliance: result.compliance });
    res.json({ success: true, duplicate: result.duplicate, name: u.name || null, status: result.status, compliance: result.compliance });
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

const forbidden = (res) => res.status(403).json({ success: false, error: 'You do not have permission to do this' });

router.get('/status', requireOrg, async (req, res) => {
    const info = await personInfo(req.orgId, req.user.id, req.user);
    const nowIso = new Date().toISOString();
    const punches = await punchesSince(req.orgId, req.user.id, daysAgoIso(8));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, name: req.user.name || null, country: info.country, leaving: /^terminating$/i.test(String(req.user.status || '')), status: buildStatus(punches, info, nowIso) });
});

router.post('/punch', requireOrg, async (req, res) => {
    const b = req.body || {};
    const result = await recordPunch({
        orgId: req.orgId, userId: req.user.id, userData: req.user, employeeId: req.user.employeeId, type: String(b.action || ''),
        source: 'web', deviceId: b.deviceId ? String(b.deviceId).slice(0, 60) : null,
        location: b.location, note: b.note, photo: b.photo, ip: req.ip, clientKey: b.clientKey, clientAt: b.clientAt
    });
    if (!result.ok) return res.status(409).json({ success: false, code: result.code, error: ERROR_TEXT[result.code], status: result.status, compliance: result.compliance });
    if (result.late) audit(req.orgId, req, 'time_punch_sent_late', req.user.id, { type: String(b.action || ''), punchAt: result.late.punchAt, receivedAt: result.late.receivedAt, punchId: result.punchId });
    res.json({ success: true, duplicate: result.duplicate, late: Boolean(result.late), recordedAt: result.late ? result.late.punchAt : undefined, receivedAt: result.late ? result.late.receivedAt : undefined, status: result.status, compliance: result.compliance });
});

router.get('/timesheet', requireOrg, async (req, res) => {
    const targetId = req.query.userId && req.query.userId !== req.user.id ? String(req.query.userId) : req.user.id;
    const base = await orgInfo(req.orgId);
    let targetData = req.user;
    if (targetId !== req.user.id) {
        const scope = access.timeAccess(req.user, base.country).timesheets;
        if (scope === 'none') return res.status(403).json({ success: false, error: 'Not allowed' });
        const t = await rawCollection('users').doc(targetId).get();
        if (!exists(t) || t.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Person not found' });
        targetData = t.data();
        if (!access.allowedFor(req.user, scope, { ...targetData, id: targetId })) return res.status(403).json({ success: false, error: 'You can only see hours for people who report to you' });
    }
    const info = await personInfo(req.orgId, targetId, targetData, { info: base });
    const nowIso = new Date().toISOString();
    const today = rules.localDate(nowIso, info.tz);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : rules.weekStartFor(today, info.workweek);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const sinceIso = new Date(new Date(`${from}T00:00:00Z`).getTime() - 2 * 86400000).toISOString();
    const punches = (await punchesSince(req.orgId, targetId, sinceIso)).filter((p) => rules.localDate(p.at, info.tz) <= to);
    const sheet = rules.timesheet(punches, info.tz, nowIso, info.overtimeWeeklyHours, info.workweek);
    res.json({
        success: true, userId: targetId, from, to, timeZone: info.tz, overtimeWeeklyHours: info.overtimeWeeklyHours,
        days: sheet.days.filter((d) => d.date >= from && d.date <= to), weeks: sheet.weeks
    });
});

/** Who is working right now: everyone for HR, payroll and auditors; their own direct reports for managers */
router.get('/team/now', requireOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const scope = access.timeAccess(req.user, info.country).teamNow;
    if (scope === 'none') return forbidden(res);
    const nowIso = new Date().toISOString();
    const [people, punchSnap, zones] = await Promise.all([
        rawCollection('users').where('orgId', '==', req.orgId).get(),
        rawCollection('time_punches').where('orgId', '==', req.orgId).where('at', '>=', daysAgoIso(2)).orderBy('at').get(),
        locationZones(req.orgId)
    ]);
    const byUser = new Map();
    punchSnap.docs.forEach((d) => { const p = d.data(); if (p.voided) return; if (!byUser.has(p.userId)) byUser.set(p.userId, []); byUser.get(p.userId).push(p); });
    const rows = [];
    for (const d of people.docs) {
        const u = d.data();
        if (!['active', 'terminating'].includes(String(u.status || 'Active').toLowerCase())) continue;
        if (!access.allowedFor(req.user, scope, { ...u, id: d.id })) continue;
        const mine = await personInfo(req.orgId, d.id, u, { info, zones });
        const s = buildStatus(byUser.get(d.id) || [], mine, nowIso);
        rows.push({ userId: d.id, employeeId: u.employeeId || null, name: u.name, jobTitle: u.jobTitle || null, department: u.departmentName || null,
            hasPin: Boolean(u.pinHash), state: s.state, since: s.shiftStartedAt, todayMinutes: s.todayMinutes, forgottenClockOut: s.forgottenClockOut, timeZone: mine.tz });
    }
    rows.sort((a, b) => (a.state === 'out') - (b.state === 'out') || String(a.name).localeCompare(String(b.name)));
    const acc = access.timeAccess(req.user, info.country);
    res.json({ success: true, timeZone: info.tz, scope, can: { addPunch: acc.addPunch === 'all', kiosk: acc.kioskManage, kioskView: acc.kioskView },
        counts: { in: rows.filter((r) => r.state === 'in').length, break: rows.filter((r) => r.state === 'break').length, out: rows.filter((r) => r.state === 'out').length }, data: rows });
});

/** HR or payroll adds a missed punch (with a reason, written to the audit log) */
router.post('/punches/manual', requireOrg, async (req, res) => {
    const base = await orgInfo(req.orgId);
    if (access.timeAccess(req.user, base.country).addPunch !== 'all') return forbidden(res);
    const { userId, type, at, reason } = req.body || {};
    if (!rules.PUNCH_TYPES.includes(type)) return res.status(400).json({ success: false, error: 'type must be in, out, break_start or break_end' });
    const when = new Date(at);
    if (!userId || Number.isNaN(when.getTime()) || when > new Date()) return res.status(400).json({ success: false, error: 'userId and a past time (at) are required' });
    if (String(reason || '').trim().length < 5) return res.status(400).json({ success: false, error: 'A reason of at least 5 characters is required' });
    const t = await rawCollection('users').doc(String(userId)).get();
    if (!exists(t) || t.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Person not found' });
    const info = await personInfo(req.orgId, String(userId), t.data(), { info: base });
    const atIso = when.toISOString();
    if (await weekIsLocked(userId, rules.localDate(atIso, info.tz), info.workweek)) return res.status(409).json({ success: false, error: 'That week is approved. Reopen it first.' });
    const ref = await rawCollection('time_punches').add({
        orgId: req.orgId, userId, employeeId: t.data().employeeId || null, type, at: atIso, localDate: rules.localDate(atIso, info.tz),
        tz: info.tz, source: 'manual', deviceId: null, location: null, note: String(reason).slice(0, 200), addedBy: req.user.id
    });
    audit(req.orgId, req, 'time_punch_added_manually', userId, { type, punchAt: atIso, punchId: ref.id, reason: String(reason).slice(0, 200) });
    res.status(201).json({ success: true });
});

/** HR sets or resets a worker's kiosk PIN; if none is given a random 4-digit PIN is made and shown once */
router.put('/pin', requireOrg, async (req, res) => {
    const base = await orgInfo(req.orgId);
    if (!access.timeAccess(req.user, base.country).kioskManage) return forbidden(res);
    const userId = String((req.body && req.body.userId) || '');
    const t = userId ? await rawCollection('users').doc(userId).get() : null;
    if (!t || !exists(t) || t.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Person not found' });
    const pin = req.body.pin ? String(req.body.pin) : String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!rules.validPin(pin)) return res.status(400).json({ success: false, error: 'PIN must be 4 to 6 digits' });
    await t.ref.update({ pinHash: await bcrypt.hash(pin, 10), pinAttempts: 0, pinLockedUntil: null, pinSetAt: new Date().toISOString() });
    audit(req.orgId, req, 'kiosk_pin_set', userId);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, employeeId: t.data().employeeId || null, name: t.data().name || null, pin });
});

/** Kiosk devices: the key is shown once when the kiosk is created */
router.post('/kiosks', requireOrg, async (req, res) => {
    const base = await orgInfo(req.orgId);
    if (!access.timeAccess(req.user, base.country).kioskManage) return forbidden(res);
    const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
    if (!name) return res.status(400).json({ success: false, error: 'name is required' });
    const key = crypto.randomBytes(32).toString('base64url');
    const ref = await rawCollection('kiosks').add({ orgId: req.orgId, name, keyHash: sha256(key), active: true, createdAt: new Date().toISOString(), createdBy: req.user.id });
    audit(req.orgId, req, 'kiosk_added', ref.id, { name });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, id: ref.id, name, key, setupPath: `/kiosk.html?key=${key}` });
});

router.get('/kiosks', requireOrg, async (req, res) => {
    const base = await orgInfo(req.orgId);
    if (!access.timeAccess(req.user, base.country).kioskView) return forbidden(res);
    const snap = await rawCollection('kiosks').where('orgId', '==', req.orgId).get();
    res.json({ success: true, data: snap.docs.map((d) => ({ id: d.id, name: d.data().name, active: d.data().active !== false, createdAt: d.data().createdAt })) });
});

router.delete('/kiosks/:id', requireOrg, async (req, res) => {
    const base = await orgInfo(req.orgId);
    if (!access.timeAccess(req.user, base.country).kioskManage) return forbidden(res);
    const ref = rawCollection('kiosks').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Kiosk not found' });
    await ref.update({ active: false, deactivatedAt: new Date().toISOString() });
    audit(req.orgId, req, 'kiosk_turned_off', req.params.id);
    res.json({ success: true });
});

// Shared with the leave routes (worked hours drive hours-based accrual) and the approval routes
router.helpers = { orgInfo, personInfo, locationZones, workLocationIdOf, punchesSince, buildStatus, weekIsLocked, audit, ERROR_TEXT };

module.exports = router;
