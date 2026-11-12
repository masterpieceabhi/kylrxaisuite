/**
 * Goals and performance reviews (US).
 *
 * Who may see a person's goals and reviews:
 *   the person themself (never a draft review, never the reviewer's private note),
 *   their direct manager,
 *   HR and the owner (people.write), and read-only roles that hold people.read.
 * Who may write a review: the direct manager, HR or the owner. Nobody writes their own review.
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, findEmployee, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { can, canonicalRole } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const P = require('../services/performance-rules');
const peopleStore = require('../services/people-data-store');

router.use(verifyToken);

const nowIso = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const today = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const col = (n) => rawCollection(n);
const managerOf = (emp) => (emp.data.usProfile && emp.data.usProfile.managerId) || emp.data.managerId || null;

/** 'self' | 'manager' | 'hr' | 'reader' | null */
function relation(req, emp) {
    if (emp.id === req.user.id) return 'self';
    if (can(req.user, 'people.write')) return 'hr';
    if (canonicalRole(req.user.role) === 'manager' && managerOf(emp) === req.user.id) return 'manager';
    if (can(req.user, 'people.read')) return 'reader';
    return null;
}
const mayWrite = (rel) => rel === 'manager' || rel === 'hr';

async function personFor(req, res, id) {
    const emp = await findEmployee(req.orgId, String(id || req.user.id));
    if (!emp) { fail(res, 404, 'Person not found'); return null; }
    const rel = relation(req, emp);
    if (!rel) { fail(res, 403, 'You can only see your own goals and reviews, or those of people who report to you'); return null; }
    return { emp, rel };
}
async function ownedDoc(req, res, name, label) {
    const snap = await col(name).doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { fail(res, 404, `${label} not found`); return null; }
    const data = snap.data();
    const emp = await findEmployee(req.orgId, data.userId);
    if (!emp) { fail(res, 404, `${label} not found`); return null; }
    const rel = relation(req, emp);
    if (!rel) { fail(res, 404, `${label} not found`); return null; }
    return { ref: snap.ref, id: snap.id, data, emp, rel };
}
async function listFor(name, orgId, userId) {
    const snap = await col(name).where('userId', '==', userId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.orgId === orgId);
}
async function areasFor(orgId) {
    const s = await col('performance_settings').doc(orgId).get();
    const a = exists(s) && Array.isArray(s.data().areas) ? s.data().areas : null;
    return a && a.length ? a : P.DEFAULT_AREAS;
}
const pubGoal = (g, t) => ({ id: g.id, userId: g.userId, title: g.title, detail: g.detail || '', dueDate: g.dueDate || null, progress: g.progress || 0, status: g.status, overdue: P.isOverdue(g, t), notes: (g.notes || []).slice(-20), createdAt: g.createdAt, createdByName: g.createdByName || null, updatedAt: g.updatedAt || null });
const pubReview = (r, rel) => {
    const base = { id: r.id, userId: r.userId, name: r.name || null, periodStart: r.periodStart, periodEnd: r.periodEnd, status: r.status, ratings: r.ratings || [], overall: r.overall ?? null, average: P.averageRating(r), strengths: r.strengths || '', improvements: r.improvements || '', nextSteps: r.nextSteps || '', reviewerName: r.reviewerName || null, sharedAt: r.sharedAt || null, acknowledgedAt: r.acknowledgedAt || null, employeeComment: r.employeeComment || '', createdAt: r.createdAt, updatedAt: r.updatedAt || null, privateNote: r.privateNote || '' };
    return rel === 'self' ? P.employeeView(base) : base;
};

router.get('/performance/options', requireUsOrg, async (req, res) => {
    res.json({ success: true, note: P.NOTE, areas: await areasFor(req.orgId), ratingLabels: P.RATING_LABELS, canEditAreas: can(req.user, 'people.write') });
});

router.put('/performance/options', requireUsOrg, async (req, res) => {
    if (!can(req.user, 'people.write')) return fail(res, 403, 'You do not have permission to do this');
    const areas = [...new Set((Array.isArray(req.body && req.body.areas) ? req.body.areas : []).map((a) => P.clean(a, 60)).filter((a) => a.length >= 2))];
    if (areas.length < 1 || areas.length > 12) return invalid(res, ['Give 1 to 12 things to rate']);
    await col('performance_settings').doc(req.orgId).set({ orgId: req.orgId, areas, updatedAt: nowIso(), updatedBy: req.user.id || null });
    audit(req.orgId, req, 'performance_areas_updated', req.orgId, { count: areas.length });
    res.json({ success: true, areas });
});

/* ------------------------------------ goals ------------------------------------ */

router.get('/performance/goals', requireUsOrg, async (req, res) => {
    const p = await personFor(req, res, req.query.userId); if (!p) return;
    const t = await today(req.orgId);
    const goals = (await listFor('performance_goals', req.orgId, p.emp.id)).sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(a.dueDate || '9999').localeCompare(String(b.dueDate || '9999')));
    res.json({ success: true, userId: p.emp.id, name: p.emp.data.name || null, canEdit: p.rel !== 'reader', summary: P.goalSummary(goals, t), data: goals.map((g) => pubGoal(g, t)) });
});

router.post('/performance/goals', requireUsOrg, async (req, res) => {
    const p = await personFor(req, res, req.body && req.body.userId); if (!p) return;
    if (p.rel === 'reader') return fail(res, 403, 'You do not have permission to do this');
    const { errors, value } = P.validateGoal(req.body);
    if (errors.length) return invalid(res, errors);
    const doc = { orgId: req.orgId, userId: p.emp.id, title: value.title, detail: value.detail || '', dueDate: value.dueDate || null, progress: value.progress || 0, status: 'open', notes: [], createdAt: nowIso(), createdBy: req.user.id || null, createdByName: req.user.name || null };
    const ref = await col('performance_goals').add(doc);
    audit(req.orgId, req, 'performance_goal_created', p.emp.id, { goalId: ref.id, by: p.rel });
    res.status(201).json({ success: true, goal: pubGoal({ id: ref.id, ...doc }, await today(req.orgId)) });
});

router.put('/performance/goals/:id', requireUsOrg, async (req, res) => {
    const g = await ownedDoc(req, res, 'performance_goals', 'Goal'); if (!g) return;
    if (g.rel === 'reader') return fail(res, 403, 'You do not have permission to do this');
    const { errors, value } = P.validateGoal(req.body, { partial: true });
    if (errors.length) return invalid(res, errors);
    const patch = { ...value, updatedAt: nowIso(), updatedBy: req.user.id || null };
    const note = P.clean(req.body && req.body.note, 500);
    if (note) patch.notes = [...(g.data.notes || []), { at: nowIso(), by: req.user.name || req.user.email || 'someone', text: note }].slice(-50);
    await g.ref.update(patch);
    audit(req.orgId, req, 'performance_goal_updated', g.data.userId, { goalId: g.id, fields: Object.keys(value) });
    res.json({ success: true, goal: pubGoal({ id: g.id, ...g.data, ...patch }, await today(req.orgId)) });
});

router.delete('/performance/goals/:id', requireUsOrg, async (req, res) => {
    const g = await ownedDoc(req, res, 'performance_goals', 'Goal'); if (!g) return;
    // a person may remove a goal they created themself; a manager or HR may remove any
    if (!(mayWrite(g.rel) || (g.rel === 'self' && g.data.createdBy === req.user.id))) return fail(res, 403, 'Only your manager or HR can remove a goal they gave you. You can mark it as dropped.');
    await g.ref.delete();
    audit(req.orgId, req, 'performance_goal_deleted', g.data.userId, { goalId: g.id, title: g.data.title });
    res.json({ success: true });
});

/* ----------------------------------- reviews ----------------------------------- */

router.get('/performance/reviews', requireUsOrg, async (req, res) => {
    const p = await personFor(req, res, req.query.userId); if (!p) return;
    const rows = (await listFor('performance_reviews', req.orgId, p.emp.id)).sort((a, b) => String(b.periodEnd).localeCompare(String(a.periodEnd)));
    if (p.rel !== 'self') audit(req.orgId, req, 'performance_reviews_viewed', p.emp.id, { count: rows.length });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, userId: p.emp.id, name: p.emp.data.name || null, canWrite: mayWrite(p.rel), data: rows.map((r) => pubReview(r, p.rel)).filter(Boolean) });
});

async function saveReview(req, res, existing) {
    const p = existing ? { emp: existing.emp, rel: existing.rel } : await personFor(req, res, req.body && req.body.userId);
    if (!p) return;
    if (!mayWrite(p.rel)) return fail(res, 403, p.rel === 'self' ? 'You cannot write your own review' : 'Only the person\'s manager or HR can write a review');
    if (existing) { const why = P.reviewChangeError(existing.data, 'edit'); if (why) return fail(res, 409, why); }
    const { errors, value } = P.validateReview(req.body, await areasFor(req.orgId));
    if (errors.length) return invalid(res, errors);
    const privateNote = P.block(req.body && req.body.privateNote, 2000);
    if (existing) {
        const patch = { ...value, privateNote, updatedAt: nowIso(), updatedBy: req.user.id || null };
        await existing.ref.update(patch);
        audit(req.orgId, req, 'performance_review_updated', existing.data.userId, { reviewId: existing.id });
        return res.json({ success: true, review: pubReview({ id: existing.id, ...existing.data, ...patch }, p.rel) });
    }
    const doc = { orgId: req.orgId, userId: p.emp.id, name: p.emp.data.name || null, ...value, privateNote, status: 'draft', reviewerId: req.user.id || null, reviewerName: req.user.name || req.user.email || null, createdAt: nowIso() };
    const ref = await col('performance_reviews').add(doc);
    audit(req.orgId, req, 'performance_review_created', p.emp.id, { reviewId: ref.id, by: p.rel });
    return res.status(201).json({ success: true, review: pubReview({ id: ref.id, ...doc }, p.rel) });
}
router.post('/performance/reviews', requireUsOrg, (req, res) => saveReview(req, res, null));
router.put('/performance/reviews/:id', requireUsOrg, async (req, res) => { const r = await ownedDoc(req, res, 'performance_reviews', 'Review'); if (r) await saveReview(req, res, r); });

router.post('/performance/reviews/:id/share', requireUsOrg, async (req, res) => {
    const r = await ownedDoc(req, res, 'performance_reviews', 'Review'); if (!r) return;
    if (!mayWrite(r.rel)) return fail(res, 403, 'Only the person\'s manager or HR can share a review');
    const why = P.reviewChangeError(r.data, 'share'); if (why) return fail(res, 409, why);
    const ready = P.readyToShare(r.data);
    if (!ready.ok) return invalid(res, [`Before sharing, add: ${ready.missing.join('; ')}`]);
    const patch = { status: 'shared', sharedAt: nowIso(), sharedBy: req.user.id || null };
    await r.ref.update(patch);
    audit(req.orgId, req, 'performance_review_shared', r.data.userId, { reviewId: r.id });
    res.json({ success: true, review: pubReview({ id: r.id, ...r.data, ...patch }, r.rel) });
});

router.post('/performance/reviews/:id/acknowledge', requireUsOrg, async (req, res) => {
    const r = await ownedDoc(req, res, 'performance_reviews', 'Review'); if (!r) return;
    if (r.rel !== 'self') return fail(res, 403, 'Only the person reviewed can acknowledge it');
    const why = P.reviewChangeError(r.data, 'acknowledge'); if (why) return fail(res, r.data.status === 'draft' ? 404 : 409, r.data.status === 'draft' ? 'Review not found' : why);
    const patch = { status: 'acknowledged', acknowledgedAt: nowIso(), employeeComment: P.block(req.body && req.body.comment, 2000) };
    await r.ref.update(patch);
    audit(req.orgId, req, 'performance_review_acknowledged', r.data.userId, { reviewId: r.id, commented: Boolean(patch.employeeComment) });
    res.json({ success: true, review: pubReview({ id: r.id, ...r.data, ...patch }, 'self') });
});

router.delete('/performance/reviews/:id', requireUsOrg, async (req, res) => {
    const r = await ownedDoc(req, res, 'performance_reviews', 'Review'); if (!r) return;
    if (!mayWrite(r.rel)) return fail(res, 403, 'You do not have permission to do this');
    const why = P.reviewChangeError(r.data, 'delete'); if (why) return fail(res, 409, why);
    await r.ref.delete();
    audit(req.orgId, req, 'performance_review_draft_deleted', r.data.userId, { reviewId: r.id });
    res.json({ success: true });
});

/* ------------------------------ team overview ------------------------------ */

/** The people this user may review, with goal counts and their last review */
router.get('/performance/team', requireUsOrg, async (req, res) => {
    const hr = can(req.user, 'people.write') || can(req.user, 'people.read');
    const isManager = canonicalRole(req.user.role) === 'manager';
    if (!hr && !isManager) return fail(res, 403, 'You do not have permission to do this');
    const t = await today(req.orgId);
    const people = (await peopleStore.loadPeople(req.orgId)).filter((p) => p.id !== req.user.id && (hr || p.managerId === req.user.id));
    const [goalSnap, reviewSnap] = await Promise.all([col('performance_goals').where('orgId', '==', req.orgId).get(), col('performance_reviews').where('orgId', '==', req.orgId).get()]);
    const goals = goalSnap.docs.map((d) => d.data()); const reviews = reviewSnap.docs.map((d) => d.data());
    const data = people.map((p) => {
        const mine = reviews.filter((r) => r.userId === p.id).sort((a, b) => String(b.periodEnd).localeCompare(String(a.periodEnd)));
        return { userId: p.id, employeeId: p.employeeId, name: p.name, jobTitle: p.jobTitle || null, goals: P.goalSummary(goals.filter((g) => g.userId === p.id), t), reviews: mine.length, lastReview: mine[0] ? { periodEnd: mine[0].periodEnd, status: mine[0].status, overall: mine[0].overall ?? null } : null, draft: mine.some((r) => r.status === 'draft'), waiting: mine.some((r) => r.status === 'shared') };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ success: true, today: t, canWrite: can(req.user, 'people.write') || isManager, count: data.length, data });
});

module.exports = router;
