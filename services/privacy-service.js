/**
 * Privacy request I/O: gathers everything held about one person, builds the access export, stores it encrypted
 * (services/file-store, VAULT_DIR) and executes deletions according to the retention plan. Rules are in privacy-rules.js.
 */
const crypto = require('crypto');
const { rawCollection, admin } = require('../config/firebase');
const logger = require('../utils/logger');
const P = require('./privacy-rules');
const V = require('./vault-rules');
const store = require('./file-store');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const nowIso = () => new Date().toISOString();
const FieldValue = () => admin.firestore.FieldValue;

async function loadSettings(orgId) {
    const snap = await rawCollection('organizations').doc(orgId).collection('privacy_settings').doc('current').get();
    const saved = exists(snap) ? snap.data() : {};
    return { ...P.DEFAULT_SETTINGS, ...saved, retention: saved.retention || P.DEFAULT_RETENTION };
}

async function saveSettings(orgId, value, by) {
    await rawCollection('organizations').doc(orgId).collection('privacy_settings').doc('current').set({ ...value, updatedAt: nowIso(), updatedBy: by });
}

const OPTIONAL_PROFILE = ['phone', 'personalEmail', 'emergencyContacts', 'emergencyContact', 'preferredName', 'pronouns'];

async function byUser(collection, orgId, userId) {
    const snap = await rawCollection(collection).where('userId', '==', userId).get();
    return snap.docs.filter((d) => d.data().orgId === orgId).map((d) => ({ id: d.id, ...d.data() }));
}

/** Everything we hold about a person (raw, for the bundle and for the retention plan). Never crosses companies. */
async function gather(orgId, userId) {
    const uSnap = await rawCollection('users').doc(userId).get();
    if (!exists(uSnap) || uSnap.data().orgId !== orgId) return null;
    const user = { id: uSnap.id, ...uSnap.data() };
    const [punches, leave, docs, consents, osha, requests, photos, eeoSnap, auditSnap] = await Promise.all([
        byUser('time_punches', orgId, userId), byUser('leave_requests', orgId, userId), byUser('vault_documents', orgId, userId), byUser('clock_consents', orgId, userId),
        byUser('osha_incidents', orgId, userId), byUser('privacy_requests', orgId, userId), byUser('punch_photos', orgId, userId),
        rawCollection('eeo_selfid').doc(`${orgId}_${userId}`).get(),
        rawCollection('organizations').doc(orgId).collection('audit_logs').where('targetId', '==', userId).limit(500).get()
    ]);
    const eeo = exists(eeoSnap) && eeoSnap.data().orgId === orgId ? eeoSnap.data().record : null;
    // Records added after this file was first written. Each one is read on its own, so a module that is not in use
    // (or a read that fails) leaves that list empty instead of stopping the request.
    const soft = (p) => p.catch((e) => { logger.warn(`Privacy: some records could not be read: ${e.message}`); return []; });
    const [weeks, shifts, corrections, adjustments, payResults, compHistory, notices, gustoSheets, gustoLinks, qrLinks] = await Promise.all([
        soft(byUser('timesheet_weeks', orgId, userId)), soft(byUser('schedule_shifts', orgId, userId)), soft(byUser('punch_corrections', orgId, userId)),
        soft(byUser('leave_adjustments', orgId, userId)), soft(byUser('pay_results', orgId, userId)), soft(byUser('comp_history', orgId, userId)),
        soft(byUser('schedule_notices', orgId, userId)), soft(byUser('gusto_time_sheets', orgId, userId)),
        soft(rawCollection('gusto_links').where('ourId', '==', userId).get().then((q) => q.docs.filter((d) => d.data().orgId === orgId).map((d) => ({ id: d.id, ...d.data() })))),
        soft(rawCollection('signin_qr_links').where('uid', '==', userId).get().then((q) => q.docs.filter((d) => d.data().orgId === orgId).map((d) => ({ id: d.id, ...d.data() }))))
    ]);
    const more = { weeks, shifts, corrections, adjustments, payResults, compHistory, notices, gustoSheets, gustoLinks, qrLinks };
    const audit = auditSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    return { user, punches, leave, docs, consents, osha, requests, photos, eeo, audit, more };
}

function terminationDate(user) {
    if (!/^terminated$/i.test(String(user.status || ''))) return null;
    const t = user.usProfile && user.usProfile.termination;
    return (t && t.lastDay) || String(user.terminatedAt || user.updatedAt || nowIso()).slice(0, 10);
}

function planningFacts(g) {
    const f = g.user.usForms || {};
    const dd = (iso) => String(iso || '').slice(0, 10) || nowIso().slice(0, 10);
    const m = { weeks: [], shifts: [], corrections: [], adjustments: [], payResults: [], compHistory: [], gustoSheets: [], ...(g.more || {}) };
    const inCol = (col, list, dateOf) => list.map((x) => ({ id: `${col}/${x.id}`, date: dd(dateOf(x)) }));
    return {
        terminationDate: terminationDate(g.user),
        hireDate: (g.user.usProfile && g.user.usProfile.startDate) || g.user.startDate || g.user.joiningDate || null,
        legalHoldUser: g.user.legalHold === true,
        counts: {
            optionalProfileFields: OPTIONAL_PROFILE.filter((k) => (g.user.usProfile && g.user.usProfile[k]) || g.user[k]).length,
            consents: g.consents.length, punchPhotos: g.photos.length, eeo: g.eeo ? 1 : 0,
            payrollForms: [f.w4, f.directDeposit].filter(Boolean).length + m.payResults.length + m.compHistory.length, i9: f.i9 ? 1 : 0
        },
        // time records: punches, the approved weeks made from them, punch fixes, shifts, and the copies sent to Gusto
        punches: [
            ...g.punches.map((p) => ({ id: p.id, date: dd(p.localDate || p.at) })),
            ...inCol('timesheet_weeks', m.weeks, (w) => w.weekEnd || w.weekStart), ...inCol('punch_corrections', m.corrections, (c) => c.localDate || c.createdAt),
            ...inCol('schedule_shifts', m.shifts, (x) => x.date || x.weekStart), ...inCol('gusto_time_sheets', m.gustoSheets, (x) => x.date)
        ],
        leave: [...g.leave.map((l) => ({ id: l.id, date: dd(l.endDate || l.startDate || l.createdAt) })), ...inCol('leave_adjustments', m.adjustments, (a) => a.date || a.createdAt)],
        osha: g.osha.map((o) => ({ id: o.id, date: dd(o.dateOfIncident || o.reportedAt) })),
        vault: g.docs.map((d) => ({ id: d.id, retainUntil: d.retainUntil || null, legalHold: Boolean(d.legalHold), deletedAlready: Boolean(d.deleted) })),
        audit: g.audit.map((a) => ({ date: dd(a.at) })),
        privacyRequests: g.requests.map((r) => ({ date: dd(r.receivedAt) }))
    };
}

async function previewDeletion(orgId, userId, settings, todayIso = nowIso().slice(0, 10)) {
    const g = await gather(orgId, userId);
    if (!g) return null;
    return { person: { id: userId, name: g.user.name || null, employeeId: g.user.employeeId || null, status: g.user.status || null }, plan: P.planDeletion(planningFacts(g), settings.retention, todayIso) };
}

/* ------------------------------ access export ------------------------------ */

/**
 * The newer records about a person, for their copy of their data: approved weeks, punch fixes, shifts, changes to
 * their time-off balance, what they were paid, their pay history and the notices they were sent. Each is cut to the
 * fields that are about the person; who decided something, internal ids and anything secret are left out (P.redact
 * also masks account-like numbers).
 */
function moreForExport(more) {
    const m = { weeks: [], corrections: [], shifts: [], adjustments: [], payResults: [], compHistory: [], notices: [], ...(more || {}) };
    const pick = (o, keys) => P.redact(Object.fromEntries(keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => [k, o[k]])));
    const by = (key) => (a, b) => String(b[key] || '').localeCompare(String(a[key] || ''));
    return {
        timesheetWeeks: [...m.weeks].sort(by('weekStart')).map((w) => pick(w, ['weekStart', 'weekEnd', 'status', 'submittedAt', 'decidedAt', 'decisionNote', 'totals', 'days', 'holidayPay', 'timeZone'])),
        punchFixes: [...m.corrections].sort(by('createdAt')).map((c) => pick(c, ['kind', 'type', 'localDate', 'at', 'originalAt', 'reason', 'status', 'createdAt', 'decidedAt', 'decisionNote'])),
        shifts: m.shifts.filter((x) => x.status !== 'draft').sort(by('date')).map((x) => pick(x, ['date', 'startTime', 'endTime', 'status', 'role', 'notes', 'publishedAt'])),
        timeOffAdjustments: [...m.adjustments].sort(by('date')).map((a) => pick(a, ['date', 'hours', 'reason', 'createdAt'])),
        payResults: [...m.payResults].sort(by('payDate')).map((r) => pick(r, ['payDate', 'periodStart', 'periodEnd', 'status', 'currency', 'gross', 'net', 'employeeTaxes', 'deductions', 'hours', 'source'])),
        payHistory: [...m.compHistory].sort(by('effectiveDate')).map((r) => pick(r, ['effectiveDate', 'payType', 'payRate', 'payFrequency', 'jobTitle', 'reason', 'status', 'createdAt'])),
        notices: [...m.notices].sort(by('createdAt')).slice(0, 500).map((n) => pick(n, ['type', 'title', 'message', 'createdAt', 'read']))
    };
}
const exportFileId = (requestId) => `privx_${requestId}`;

async function generateExport(orgId, request, settings, requestRef) {
    const g = await gather(orgId, request.userId);
    if (!g) throw Object.assign(new Error('Person not found'), { statusCode: 404 });
    const bundle = P.buildAccessBundle({
        now: nowIso(), requestId: request.id, user: g.user, punches: g.punches.sort((a, b) => String(b.at).localeCompare(String(a.at))), leave: g.leave,
        documents: g.docs.filter((d) => !d.deleted), consents: g.consents, eeo: g.eeo, audit: g.audit, requests: g.requests
    });
    Object.assign(bundle, moreForExport(g.more));
    const buf = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
    const fileId = exportFileId(request.id);
    await store.removeFile(orgId, fileId).catch(() => {});
    await store.saveFile(orgId, fileId, buf);
    const expiresAt = new Date(Date.now() + settings.exportLinkHours * 3600000).toISOString();
    const exp = { fileId, generatedAt: nowIso(), expiresAt, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), downloads: 0, maxDownloads: settings.exportMaxDownloads };
    await requestRef.update({ export: exp });
    return { export: exp, summary: { punches: bundle.timePunches.length, leave: bundle.leave.length, documents: bundle.documents.length, auditEntries: bundle.auditEntriesAboutYou.length } };
}

async function readExport(orgId, exp) {
    return JSON.parse((await store.readFile(orgId, exp.fileId)).toString('utf8'));
}

/* ------------------------------ deletion ------------------------------ */
async function deleteDocs(collection, ids) {
    const { db } = require('../config/firebase');
    for (let i = 0; i < ids.length; i += 400) {
        const batch = db.batch();
        ids.slice(i, i + 400).forEach((id) => batch.delete(rawCollection(collection).doc(id)));
        await batch.commit();
    }
}

/** Deletes ids that may be written "collection/id"; a plain id belongs to `fallback` */
async function deleteMixed(fallback, ids) {
    const by = new Map();
    for (const raw of ids || []) {
        const at = String(raw).indexOf('/');
        const col = at > 0 ? String(raw).slice(0, at) : fallback;
        const id = at > 0 ? String(raw).slice(at + 1) : String(raw);
        if (!by.has(col)) by.set(col, []);
        by.get(col).push(id);
    }
    for (const [col, list] of by) await deleteDocs(col, list);
}

/** Executes the plan. Returns the per-category result table. Irreversible. */
async function executeDeletion(orgId, userId, settings, todayIso = nowIso().slice(0, 10)) {
    const g = await gather(orgId, userId);
    if (!g) throw Object.assign(new Error('Person not found'), { statusCode: 404 });
    const plan = P.planDeletion(planningFacts(g), settings.retention, todayIso);
    const userRef = rawCollection('users').doc(userId);
    const FV = FieldValue();
    const table = [];
    const done = (row, result, extra = {}) => table.push({ key: row.key, label: row.label, result, deleted: extra.deleted || 0, retained: extra.retained || 0, retainUntil: row.retainUntil || null, reason: row.reason });

    for (const row of plan.rows) {
        try {
            if (row.action === 'none') { done(row, 'nothing_on_file'); continue; }
            if (row.action === 'retain') { done(row, 'retained', { retained: row.retainCount }); continue; }
            const partial = row.action === 'partial';
            const del = row.deleteCount;
            switch (row.key) {
                case 'profile_optional': {
                    const patch = {};
                    OPTIONAL_PROFILE.forEach((k) => { patch[`usProfile.${k}`] = FV.delete(); patch[k] = FV.delete(); });
                    await userRef.update(patch); break;
                }
                case 'consents': await deleteDocs('clock_consents', g.consents.map((c) => c.id)); break;
                case 'punch_photos': {
                    let io = null; try { io = require('./clock-compliance-io'); } catch (_) {}
                    if (io && io.destroyPhotosFor) await io.destroyPhotosFor(orgId, userId, 'privacy deletion request');
                    else await deleteDocs('punch_photos', g.photos.map((p) => p.id));
                    break;
                }
                case 'eeo_selfid': await rawCollection('eeo_selfid').doc(`${orgId}_${userId}`).delete(); break;
                case 'time_punches': await deleteMixed('time_punches', row.deleteIds || []); break;
                case 'leave_requests': await deleteMixed('leave_requests', row.deleteIds || []); break;
                case 'osha_incidents': await deleteDocs('osha_incidents', row.deleteIds || []); break;
                case 'payroll_forms': {
                    await userRef.update({ 'usForms.w4': FV.delete(), 'usForms.directDeposit': FV.delete() });
                    // what was paid and the pay history go with the pay forms: the same retention period, counted from the last day
                    await deleteDocs('pay_results', ((g.more || {}).payResults || []).map((x) => x.id));
                    await deleteDocs('comp_history', ((g.more || {}).compHistory || []).map((x) => x.id));
                    break;
                }
                case 'i9': await userRef.update({ 'usForms.i9': FV.delete() }); break;
                case 'vault_documents': {
                    for (const id of row.deleteIds || []) {
                        const d = g.docs.find((x) => x.id === id);
                        if (!d || !V.deletionCheck(d, todayIso).ok) continue; // re-checked at deletion time
                        await store.removeFile(orgId, id).catch(() => {});
                        await rawCollection('vault_documents').doc(id).update({ deleted: true, deletedAt: nowIso(), deletedReason: 'privacy deletion request' });
                    }
                    break;
                }
                case 'account': {
                    await userRef.update({
                        name: 'Deleted person', email: FV.delete(), usProfile: FV.delete(), usForms: FV.delete(), phone: FV.delete(), personalEmail: FV.delete(),
                        anonymizedAt: nowIso(), status: 'Terminated'
                    });
                    // nothing to keep these for once the person's record is gone: their notices, unused sign-in QRs,
                    // and the tie to their employee record in the company's Gusto account
                    await deleteDocs('schedule_notices', ((g.more || {}).notices || []).map((x) => x.id));
                    await deleteDocs('signin_qr_links', ((g.more || {}).qrLinks || []).map((x) => x.id));
                    await deleteDocs('gusto_links', ((g.more || {}).gustoLinks || []).map((x) => x.id));
                    await userRef.update({ pinHash: FV.delete(), signinDevices: FV.delete(), password: FV.delete(), totp: FV.delete() });
                    try { await admin.auth().deleteUser(userId); } catch (e) { if (e.code !== 'auth/user-not-found') logger.warn(`Auth user removal failed for ${userId}: ${e.message}`); }
                    break;
                }
                default: break;
            }
            done(row, row.key === 'account' ? 'anonymized' : (partial ? 'partially_deleted' : 'deleted'), { deleted: del, retained: row.retainCount });
        } catch (e) {
            logger.error(`Privacy deletion failed on ${row.key}: ${e.message}`);
            done(row, 'failed', {}); table[table.length - 1].reason = `Could not complete: ${e.message}`;
        }
    }
    return { plan: { employmentActive: plan.employmentActive, legalHold: plan.legalHold }, table };
}

/** Choices that do not delete data: recorded on the profile so other modules can honour them */
async function applyFlags(orgId, userId, type, on = true) {
    const key = type === 'limit_sensitive' ? 'limitSensitiveUse' : 'optOutSaleShare';
    await rawCollection('users').doc(userId).set({ usProfile: { privacyFlags: { [key]: on, [`${key}At`]: nowIso() } } }, { merge: true });
    return key;
}

module.exports = { moreForExport, loadSettings, saveSettings, gather, planningFacts, previewDeletion, generateExport, readExport, executeDeletion, applyFlags, exportFileId };
