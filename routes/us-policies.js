/**
 * Company policy library with versions (US).
 *
 * Who may write, publish, archive and delete: HR and the owner (people.write).
 * Who may see drafts, old versions and who has acknowledged: HR, the owner and read-only roles holding people.read.
 * Everyone signed in to the company reads the published policies and acknowledges the ones that ask for it.
 * An acknowledgement is one record per person per version and is never changed or removed.
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { can } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const P = require('../services/policy-rules');
const peopleStore = require('../services/people-data-store');

router.use(verifyToken);

const nowIso = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const today = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const col = (n) => rawCollection(n);
const mayManage = (req) => can(req.user, 'people.write');
const maySeeAll = (req) => can(req.user, 'people.write') || can(req.user, 'people.read');
const me = (req) => String(req.user.id || req.user.uid);
const who = (req) => req.user.name || req.user.email || 'someone';
const ackId = (policyId, version, userId) => `${policyId}_v${version}_${userId}`;

async function owned(req, res) {
    const snap = await col('policies').doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { fail(res, 404, 'Policy not found'); return null; }
    return { ref: snap.ref, id: snap.id, data: { id: snap.id, ...snap.data() }, updateTime: snap.updateTime };
}
/** Write only if nobody changed the policy since it was read (two people publishing at once) */
async function guardedUpdate(res, p, patch) {
    try { await p.ref.update(patch, p.updateTime ? { lastUpdateTime: p.updateTime } : undefined); return true; } catch (err) {
        if (err && (err.code === 9 || /precondition/i.test(String(err.message)))) { fail(res, 409, 'Someone else just changed this policy. Reload and try again.'); return false; }
        throw err;
    }
}
async function acksFor(orgId, field, value) {
    const snap = await col('policy_acks').where(field, '==', value).get();
    return snap.docs.map((d) => d.data()).filter((a) => a.orgId === orgId);
}
const people = async (orgId) => (await peopleStore.loadPeople(orgId)).map((p) => ({ id: p.id, name: p.name, employeeId: p.employeeId }));
/** The HR view of a policy, without the long texts unless asked */
function pub(p, { full = false, report = null } = {}) {
    const cur = P.currentVersion(p); const d = p.draft || {};
    return { id: p.id, status: p.status, title: d.title || (cur && cur.title) || '', category: d.category || (cur && cur.category) || '', version: cur ? cur.version : 0, effectiveDate: cur ? cur.effectiveDate : null, publishedAt: cur ? cur.publishedAt : null,
        requireAck: cur ? cur.requireAck : Boolean(d.requireAck), unpublishedChanges: p.status !== 'archived' && P.hasUnpublishedChanges(p), createdAt: p.createdAt, updatedAt: p.updatedAt || null,
        ...(report ? { ack: { asked: report.asked, total: report.total, done: report.done, waiting: report.waiting } } : {}),
        ...(full ? { draft: { title: d.title || '', category: d.category || '', body: d.body || '', effectiveDate: d.effectiveDate || null, requireAck: Boolean(d.requireAck), changeNote: d.changeNote || '' },
            versions: (p.versions || []).map((v) => ({ version: v.version, title: v.title, category: v.category, body: v.body, effectiveDate: v.effectiveDate || null, requireAck: v.requireAck, changeNote: v.changeNote || '', minor: Boolean(v.minor), ackFrom: v.ackFrom || v.version, publishedAt: v.publishedAt, publishedByName: v.publishedByName || null })) } : {}) };
}

router.get('/policies/options', requireUsOrg, async (req, res) => {
    res.json({ success: true, note: P.NOTE, categories: P.CATEGORIES, bodyMin: P.BODY_MIN, bodyMax: P.BODY_MAX, canManage: mayManage(req), canSeeAll: maySeeAll(req) });
});

/* ------------------------------ reading (everyone) ------------------------------ */

router.get('/policies/mine', requireUsOrg, async (req, res) => {
    const [snap, mine, t] = await Promise.all([col('policies').where('orgId', '==', req.orgId).get(), acksFor(req.orgId, 'userId', me(req)), today(req.orgId)]);
    const data = snap.docs.map((d) => ({ id: d.id, ...d.data() })).map((p) => {
        const view = P.employeeView(p, { withBody: false }); if (!view) return null;
        const own = mine.filter((a) => a.policyId === p.id); const state = P.ackState(p, own.map((a) => a.version));
        const at = state.done ? (own.find((a) => a.version === state.version) || {}).at || null : null;
        return { ...view, needsAck: state.needed, acknowledgedAt: at, acknowledgedVersion: state.version, notYetInEffect: Boolean(view.effectiveDate && view.effectiveDate > t) };
    }).filter(Boolean).sort((a, b) => Number(b.needsAck) - Number(a.needsAck) || String(a.category).localeCompare(String(b.category)) || String(a.title).localeCompare(String(b.title)));
    res.json({ success: true, today: t, waiting: data.filter((p) => p.needsAck).length, data });
});

router.get('/policies/:id/read', requireUsOrg, async (req, res) => {
    const p = await owned(req, res); if (!p) return;
    const view = P.employeeView(p.data);
    if (!view) return fail(res, 404, 'Policy not found');
    const own = (await acksFor(req.orgId, 'userId', me(req))).filter((a) => a.policyId === p.id); const state = P.ackState(p.data, own.map((a) => a.version));
    res.json({ success: true, policy: { ...view, needsAck: state.needed, acknowledgedAt: state.done ? (own.find((a) => a.version === state.version) || {}).at || null : null, acknowledgedVersion: state.version } });
});

router.post('/policies/:id/acknowledge', requireUsOrg, async (req, res) => {
    const p = await owned(req, res); if (!p) return;
    const blocked = P.changeError(p.data, 'acknowledge');
    if (blocked) return fail(res, p.data.status === 'published' ? 409 : 404, blocked);
    const cur = P.currentVersion(p.data);
    // the person must say which version they read, so a version published a second ago is not acknowledged unread
    if (Number(req.body && req.body.version) !== cur.version) return fail(res, 409, 'This policy was just updated. Read the new version, then acknowledge it.');
    const at = nowIso();
    try {
        await col('policy_acks').doc(ackId(p.id, cur.version, me(req))).create({ orgId: req.orgId, policyId: p.id, version: cur.version, userId: me(req), name: who(req), at, title: cur.title });
    } catch (err) {
        if (err && (err.code === 6 || /already exists/i.test(String(err.message)))) return fail(res, 409, 'You already acknowledged this version');
        throw err;
    }
    audit(req.orgId, req, 'policy_acknowledged', p.id, { version: cur.version });
    res.status(201).json({ success: true, acknowledgedAt: at, version: cur.version });
});

/* ------------------------------ managing (HR, owner) ------------------------------ */

router.get('/policies', requireUsOrg, async (req, res) => {
    if (!maySeeAll(req)) return fail(res, 403, 'You do not have permission to do this');
    const [snap, ackSnap, ppl] = await Promise.all([col('policies').where('orgId', '==', req.orgId).get(), col('policy_acks').where('orgId', '==', req.orgId).get(), people(req.orgId)]);
    const acks = ackSnap.docs.map((d) => d.data());
    const order = { published: 0, draft: 1, archived: 2 };
    const data = snap.docs.map((d) => ({ id: d.id, ...d.data() })).map((p) => pub(p, { report: P.ackReport(p, ppl, acks.filter((a) => a.policyId === p.id)) }))
        .sort((a, b) => order[a.status] - order[b.status] || String(a.category).localeCompare(String(b.category)) || String(a.title).localeCompare(String(b.title)));
    res.json({ success: true, canManage: mayManage(req), people: ppl.length, data });
});

router.get('/policies/:id', requireUsOrg, async (req, res) => {
    if (!maySeeAll(req)) return fail(res, 403, 'You do not have permission to do this');
    const p = await owned(req, res); if (!p) return;
    res.json({ success: true, policy: pub(p.data, { full: true }) });
});

router.get('/policies/:id/acks', requireUsOrg, async (req, res) => {
    if (!maySeeAll(req)) return fail(res, 403, 'You do not have permission to do this');
    const p = await owned(req, res); if (!p) return;
    const [ppl, acks] = await Promise.all([people(req.orgId), acksFor(req.orgId, 'policyId', p.id)]);
    audit(req.orgId, req, 'policy_acks_viewed', p.id, {});
    const cur = P.currentVersion(p.data);
    res.json({ success: true, policy: { id: p.id, title: (cur && cur.title) || (p.data.draft || {}).title || '', version: cur ? cur.version : 0, status: p.data.status }, report: P.ackReport(p.data, ppl, acks),
        // every acknowledgement ever given, including of old versions and by people who have since left
        all: acks.map((a) => ({ userId: a.userId, name: a.name || null, version: a.version, at: a.at })).sort((a, b) => String(b.at).localeCompare(String(a.at))) });
});

router.post('/policies', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const { errors, value } = P.validatePolicy(req.body);
    if (errors.length) return invalid(res, errors);
    const at = nowIso();
    const doc = { orgId: req.orgId, status: 'draft', draft: { effectiveDate: null, requireAck: true, changeNote: '', ...value }, versions: [], createdAt: at, createdBy: me(req), createdByName: who(req) };
    const ref = await col('policies').add(doc);
    audit(req.orgId, req, 'policy_created', ref.id, { title: value.title });
    res.status(201).json({ success: true, policy: pub({ id: ref.id, ...doc }, { full: true }) });
});

router.put('/policies/:id', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const p = await owned(req, res); if (!p) return;
    const blocked = P.changeError(p.data, 'edit');
    if (blocked) return fail(res, 409, blocked);
    const { errors, value } = P.validatePolicy(req.body, { partial: true });
    if (errors.length) return invalid(res, errors);
    const patch = { draft: { ...(p.data.draft || {}), ...value }, updatedAt: nowIso(), updatedBy: me(req) };
    if (!(await guardedUpdate(res, p, patch))) return;
    audit(req.orgId, req, 'policy_draft_saved', p.id, { fields: Object.keys(value) });
    res.json({ success: true, policy: pub({ ...p.data, ...patch }, { full: true }) });
});

router.post('/policies/:id/publish', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const p = await owned(req, res); if (!p) return;
    const minor = Boolean(req.body && req.body.minor);
    const blocked = P.changeError(p.data, 'publish', { minor });
    if (blocked) return fail(res, 409, blocked);
    const at = nowIso();
    const v = P.nextVersion(p.data, { at, by: who(req), minor });
    const patch = { status: 'published', versions: P.addVersion(p.data, v), draft: { ...p.data.draft, changeNote: '' }, updatedAt: at, updatedBy: me(req) };
    if (!(await guardedUpdate(res, p, patch))) return;
    audit(req.orgId, req, 'policy_published', p.id, { version: v.version, minor: v.minor, requireAck: v.requireAck });
    res.json({ success: true, policy: pub({ ...p.data, ...patch }, { full: true }) });
});

async function move(req, res, action, status, name) {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const p = await owned(req, res); if (!p) return;
    const blocked = P.changeError(p.data, action);
    if (blocked) return fail(res, 409, blocked);
    const patch = { status, updatedAt: nowIso(), updatedBy: me(req) };
    if (!(await guardedUpdate(res, p, patch))) return;
    audit(req.orgId, req, name, p.id, {});
    res.json({ success: true, policy: pub({ ...p.data, ...patch }) });
}
router.post('/policies/:id/archive', requireUsOrg, (req, res) => move(req, res, 'archive', 'archived', 'policy_archived'));
router.post('/policies/:id/restore', requireUsOrg, (req, res) => move(req, res, 'restore', 'published', 'policy_restored'));

router.delete('/policies/:id', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const p = await owned(req, res); if (!p) return;
    const blocked = P.changeError(p.data, 'delete');
    if (blocked) return fail(res, 409, blocked);
    await p.ref.delete();
    audit(req.orgId, req, 'policy_deleted', p.id, { title: (p.data.draft || {}).title || null });
    res.json({ success: true });
});

module.exports = router;
