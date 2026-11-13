/**
 * Review cycles and feedback from coworkers (US). Extends goals and reviews (routes/us-performance.js).
 *
 * Who may write, open, close and delete a cycle: HR and the owner (people.write).
 * Who may see a cycle's progress and each person's part of it: HR and the owner, read-only roles holding
 *   people.read, and a manager for their own direct reports only (usProfile.managerId).
 * Who writes what while a cycle is open:
 *   the person writes their own self review (their manager and HR see it once it has been sent);
 *   the direct manager or HR writes the manager review. It is an ordinary review record (performance_reviews)
 *   with a cycleId, kept as a private draft, and closing the cycle shares the finished ones with the employee;
 *   the manager or HR picks coworkers, and each coworker answers once.
 *
 * Privacy of coworker feedback: an answer is stored in `review_peer_answers` with no giver id and no date.
 * That a coworker answered is stored separately in `review_peer_responders` under a hashed key, only so a second
 * answer can be refused. Answering is deliberately not written to the audit log (it would record who and when).
 * The combined answers are given to the manager and HR only once enough coworkers answered (never fewer than 3),
 * and to the person reviewed only if the cycle says so and only after it has closed.
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { can, canonicalRole } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const R = require('../services/review-cycle-rules');
const P = require('../services/performance-rules');
const peopleStore = require('../services/people-data-store');

router.use(verifyToken);

const nowIso = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const today = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const col = (n) => rawCollection(n);
const me = (req) => String(req.user.id || req.user.uid);
const who = (req) => req.user.name || req.user.email || 'someone';
const safeId = (v) => { const s = String(v || ''); return s && !s.includes('/') && s.length <= 200 ? s : null; };
const alreadyExists = (err) => Boolean(err) && (err.code === 6 || /already exists/i.test(String(err.message)));
const reviewIdFor = (cycleId, userId) => `cycle_${cycleId}_${userId}`;

/** What this signed-in person is, for the HR page */
function viewerOf(req) {
    const hr = can(req.user, 'people.write');
    const reader = !hr && can(req.user, 'people.read');
    const manager = canonicalRole(req.user.role) === 'manager';
    return { hr, reader, manager, companyWide: hr || reader, any: hr || reader || manager };
}
/** 'self' | 'hr' | 'manager' | 'reader' | null for one person in a cycle */
function relationTo(req, userId, people) {
    if (userId === me(req)) return 'self';
    const v = viewerOf(req);
    if (v.hr) return 'hr';
    const p = people.get(userId);
    if (v.manager && p && p.managerId === me(req)) return 'manager';
    if (v.reader) return 'reader';
    return null;
}
const mayWrite = (rel) => rel === 'hr' || rel === 'manager';

async function ownedCycle(req, res) {
    const id = safeId(req.params.id);
    const snap = id ? await col('review_cycles').doc(id).get() : null;
    if (!snap || !exists(snap) || snap.data().orgId !== req.orgId) { fail(res, 404, 'Review not found'); return null; }
    return { ref: snap.ref, id: snap.id, data: { id: snap.id, ...snap.data() }, updateTime: snap.updateTime };
}
/** Write only if nobody changed the record since it was read (two people saving at once) */
async function guardedUpdate(res, doc, patch, what) {
    try { await doc.ref.update(patch, doc.updateTime ? { lastUpdateTime: doc.updateTime } : undefined); return true; } catch (err) {
        if (err && (err.code === 9 || /precondition/i.test(String(err.message)))) { fail(res, 409, `Someone else just changed ${what}. Reload and try again.`); return false; }
        throw err;
    }
}
async function memberOf(orgId, cycleId, userId) {
    const uid = safeId(userId); if (!uid) return null;
    const snap = await col('review_cycle_members').doc(R.memberId(cycleId, uid)).get();
    if (!exists(snap)) return null;
    const data = snap.data();
    if (data.orgId !== orgId || data.cycleId !== cycleId || data.userId !== uid) return null;
    return { ref: snap.ref, id: snap.id, data, updateTime: snap.updateTime };
}
async function listWhere(name, orgId, field, value) {
    const snap = await col(name).where(field, '==', value).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.orgId === orgId);
}
const peopleMap = async (orgId, opts) => new Map((await peopleStore.loadPeople(orgId, opts)).map((p) => [p.id, p]));
async function areasFor(orgId) {
    const s = await col('performance_settings').doc(orgId).get();
    const a = exists(s) && Array.isArray(s.data().areas) ? s.data().areas : null;
    return a && a.length ? a : P.DEFAULT_AREAS;
}
async function reviewDoc(orgId, cycleId, userId) {
    const snap = await col('performance_reviews').doc(reviewIdFor(cycleId, userId)).get();
    if (!exists(snap)) return null;
    const data = snap.data();
    if (data.orgId !== orgId || data.userId !== userId || data.cycleId !== cycleId) return null;
    return { ref: snap.ref, id: snap.id, data, updateTime: snap.updateTime };
}
const countBySubject = (answers) => { const n = {}; answers.forEach((a) => { n[a.subjectId] = (n[a.subjectId] || 0) + 1; }); return n; };
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

const pubCycle = (c, t, extra = {}) => ({ id: c.id, name: c.name, periodStart: c.periodStart, periodEnd: c.periodEnd, dueDate: c.dueDate, status: c.status, late: R.isLate(c, t), audience: c.audience, peopleIds: c.peopleIds || [],
    selfReview: Boolean(c.selfReview), managerReview: Boolean(c.managerReview), peerFeedback: Boolean(c.peerFeedback), sharePeerFeedback: Boolean(c.sharePeerFeedback), peerMinAnswers: R.minAnswers(c), peerSuggested: Math.max(R.minAnswers(c), Number(c.peerSuggested) || 0),
    selfQuestions: c.selfQuestions || [], peerQuestions: c.peerQuestions || [], createdAt: c.createdAt, createdByName: c.createdByName || null, openedAt: c.openedAt || null, closedAt: c.closedAt || null, ...extra });
const pubReview = (id, r) => ({ id, userId: r.userId, periodStart: r.periodStart, periodEnd: r.periodEnd, status: r.status, ratings: r.ratings || [], overall: r.overall ?? null, average: P.averageRating(r), strengths: r.strengths || '', improvements: r.improvements || '', nextSteps: r.nextSteps || '',
    privateNote: r.privateNote || '', reviewerName: r.reviewerName || null, sharedAt: r.sharedAt || null, acknowledgedAt: r.acknowledgedAt || null, employeeComment: r.employeeComment || '', createdAt: r.createdAt, updatedAt: r.updatedAt || r.createdAt || null });

router.get('/review-cycles/options', requireUsOrg, async (req, res) => {
    const v = viewerOf(req);
    res.json({ success: true, noteHr: R.NOTE_HR, notePrivacy: R.NOTE_PRIVACY, canManage: v.hr, canSeeAll: v.companyWide, isManager: v.manager, peerMinFloor: R.PEER_MIN_FLOOR, peerMinDefault: R.PEER_MIN_DEFAULT, maxPeers: R.MAX_PEERS, maxQuestions: R.MAX_QUESTIONS,
        defaultSelfQuestions: R.DEFAULT_SELF_QUESTIONS, defaultPeerQuestions: R.DEFAULT_PEER_QUESTIONS, ratingLabels: P.RATING_LABELS });
});

/** Names to choose from (who is in a cycle, which coworkers to ask). Not for plain employees. */
router.get('/review-cycles/people', requireUsOrg, async (req, res) => {
    if (!viewerOf(req).any) return fail(res, 403, 'You do not have permission to do this');
    const data = (await peopleStore.loadPeople(req.orgId)).map((p) => ({ id: p.id, name: p.name, employeeId: p.employeeId, jobTitle: p.jobTitle || null })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ success: true, data });
});

/* ------------------------------ my own part (everyone) ------------------------------ */

/** My self reviews, the coworkers I was asked to write about, and what was shared with me */
router.get('/review-cycles/mine', requireUsOrg, async (req, res) => {
    const uid = me(req);
    const [t, mineRows, askedSnap] = await Promise.all([today(req.orgId), listWhere('review_cycle_members', req.orgId, 'userId', uid), col('review_cycle_members').where('peerIds', 'array-contains', uid).get()]);
    const asked = askedSnap.docs.map((d) => d.data()).filter((m) => m.orgId === req.orgId && m.userId !== uid);
    const cycleIds = [...new Set([...mineRows, ...asked].map((m) => m.cycleId))];
    const cycles = {};
    await Promise.all(cycleIds.map(async (id) => { const s = await col('review_cycles').doc(id).get(); if (exists(s) && s.data().orgId === req.orgId && s.data().status !== 'draft') cycles[id] = { id, ...s.data() }; }));

    const mine = await Promise.all(mineRows.filter((m) => cycles[m.cycleId]).map(async (m) => {
        const c = cycles[m.cycleId];
        let coworkerFeedback = null;
        if (c.peerFeedback) {
            coworkerFeedback = { willBeShared: Boolean(c.sharePeerFeedback), hidden: true };
            if (c.sharePeerFeedback && c.status === 'closed') {
                const answers = (await listWhere('review_peer_answers', req.orgId, 'cycleId', c.id)).filter((a) => a.subjectId === uid);
                const combined = R.combinePeerFeedback(c, answers, { viewer: 'self' });
                if (!combined.hidden) coworkerFeedback = { willBeShared: true, hidden: false, answered: combined.answered, rating: combined.rating, questions: combined.questions };
            }
        }
        const self = R.selfReviewFor(m, 'self');
        return { id: c.id, name: c.name, periodStart: c.periodStart, periodEnd: c.periodEnd, dueDate: c.dueDate, status: c.status, late: R.isLate(c, t),
            self: c.selfReview ? { questions: c.selfQuestions || [], answers: self ? self.answers : {}, savedAt: self ? self.savedAt : null, submittedAt: self ? self.submittedAt : null, canWrite: c.status === 'open' } : null,
            managerReview: Boolean(c.managerReview), coworkerFeedback };
    }));
    mine.sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || String(b.periodEnd).localeCompare(String(a.periodEnd)));

    const requests = await Promise.all(asked.filter((m) => cycles[m.cycleId] && cycles[m.cycleId].status === 'open' && cycles[m.cycleId].peerFeedback).map(async (m) => {
        const c = cycles[m.cycleId];
        const mark = await col('review_peer_responders').doc(R.peerKey(c.id, m.userId, uid)).get();
        return { cycleId: c.id, cycleName: c.name, subjectId: m.userId, subjectName: m.name || null, dueDate: c.dueDate, late: R.isLate(c, t), answered: exists(mark), questions: c.peerQuestions || [] };
    }));
    requests.sort((a, b) => Number(a.answered) - Number(b.answered) || String(a.dueDate).localeCompare(String(b.dueDate)) || String(a.subjectName).localeCompare(String(b.subjectName)));
    const waiting = mine.filter((c) => c.self && c.self.canWrite && !c.self.submittedAt).length + requests.filter((r) => !r.answered).length;
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, today: t, notePrivacy: R.NOTE_PRIVACY, ratingLabels: P.RATING_LABELS, waiting, cycles: mine, requests });
});

/** Save my self review (submit: true sends it to my manager) */
router.put('/review-cycles/:id/self', requireUsOrg, async (req, res) => {
    const c = await ownedCycle(req, res); if (!c) return;
    const m = await memberOf(req.orgId, c.id, me(req));
    if (!m || c.data.status === 'draft') return fail(res, 404, 'Review not found');
    const blocked = R.cycleChangeError(c.data, 'self');
    if (blocked) return fail(res, 409, blocked);
    const submit = Boolean(req.body && req.body.submit);
    const { errors, value } = R.validateSelfReview(c.data, req.body && req.body.answers, { submit });
    if (errors.length) return invalid(res, errors);
    const at = nowIso(); const before = m.data.self || {};
    const self = { answers: value.answers, savedAt: at, submittedAt: submit ? at : before.submittedAt || null };
    await m.ref.update({ self });
    audit(req.orgId, req, submit ? 'review_cycle_self_review_sent' : 'review_cycle_self_review_saved', c.id, { userId: me(req) });
    res.json({ success: true, self: { ...self, canWrite: true } });
});

/** Answer as a coworker about one person. Once only; it cannot be read back or changed afterwards. */
router.post('/review-cycles/:id/peer-answers/:subjectId', requireUsOrg, async (req, res) => {
    const c = await ownedCycle(req, res); if (!c) return;
    const uid = me(req); const subjectId = safeId(req.params.subjectId);
    if (subjectId === uid) return fail(res, 403, 'You cannot give coworker feedback about yourself');
    const m = c.data.status === 'draft' ? null : await memberOf(req.orgId, c.id, subjectId);
    if (!m || !(m.data.peerIds || []).includes(uid)) return fail(res, 404, 'You were not asked for feedback about this person');
    const blocked = R.cycleChangeError(c.data, 'peer_answer');
    if (blocked) return fail(res, 409, blocked);
    const { errors, value } = R.validatePeerAnswer(c.data, req.body);
    if (errors.length) return invalid(res, errors);
    const markRef = col('review_peer_responders').doc(R.peerKey(c.id, subjectId, uid));
    try {
        await markRef.create({ orgId: req.orgId, cycleId: c.id });
    } catch (err) {
        if (alreadyExists(err)) return fail(res, 409, 'You already gave your feedback about this person');
        throw err;
    }
    try {
        // no giver id and no date: the answer cannot be tied back to the coworker
        await col('review_peer_answers').add({ orgId: req.orgId, cycleId: c.id, subjectId, answers: value.answers, rating: value.rating });
    } catch (err) {
        await markRef.delete().catch(() => {});
        throw err;
    }
    res.status(201).json({ success: true });
});

/* ------------------------------ cycles (HR; managers see their team) ------------------------------ */

router.get('/review-cycles', requireUsOrg, async (req, res) => {
    const v = viewerOf(req);
    if (!v.any) return fail(res, 403, 'You do not have permission to do this');
    const [t, cycles, members, answers, reviews, people, active] = await Promise.all([today(req.orgId), peopleStore.listByOrg('review_cycles', req.orgId), peopleStore.listByOrg('review_cycle_members', req.orgId),
        peopleStore.listByOrg('review_peer_answers', req.orgId), peopleStore.listByOrg('performance_reviews', req.orgId), peopleMap(req.orgId, { includeInactive: true }), peopleStore.loadPeople(req.orgId)]);
    const reviewsById = byId(reviews.filter((r) => r.cycleId));
    const order = { open: 0, draft: 1, closed: 2 };
    const data = cycles.map((c) => {
        if (c.status === 'draft') return v.companyWide ? pubCycle(c, t, { progress: R.cycleProgress([]), included: R.audienceFor(c, active).length }) : null;
        const counts = countBySubject(answers.filter((a) => a.cycleId === c.id));
        const mine = R.visibleMembers(members.filter((m) => m.cycleId === c.id), people, { viewerId: me(req), companyWide: v.companyWide, manager: v.manager });
        if (!v.companyWide && !mine.length) return null;
        const rows = mine.map((m) => R.memberProgress(c, m, { peerAnswers: counts[m.userId] || 0, review: reviewsById[reviewIdFor(c.id, m.userId)] || null }));
        return pubCycle(c, t, { progress: R.cycleProgress(rows), included: mine.length });
    }).filter(Boolean).sort((a, b) => order[a.status] - order[b.status] || String(b.periodEnd).localeCompare(String(a.periodEnd)) || String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, today: t, canManage: v.hr, wholeCompany: v.companyWide, data });
});

async function checkedCycle(req, res) {
    const { errors, value } = R.validateCycle(req.body);
    if (errors.length) { invalid(res, errors); return null; }
    if (value.audience === 'chosen') {
        const gone = R.unknownPeople(value.peopleIds, await peopleStore.loadPeople(req.orgId));
        if (gone.length) { invalid(res, [`${gone.length} of the people chosen were not found or no longer work here`]); return null; }
    }
    return value;
}

router.post('/review-cycles', requireUsOrg, async (req, res) => {
    if (!viewerOf(req).hr) return fail(res, 403, 'You do not have permission to do this');
    const value = await checkedCycle(req, res); if (!value) return;
    const doc = { orgId: req.orgId, ...value, status: 'draft', createdAt: nowIso(), createdBy: me(req), createdByName: who(req) };
    const ref = await col('review_cycles').add(doc);
    audit(req.orgId, req, 'review_cycle_created', ref.id, { name: value.name, audience: value.audience });
    res.status(201).json({ success: true, cycle: pubCycle({ id: ref.id, ...doc }, await today(req.orgId)) });
});

router.put('/review-cycles/:id', requireUsOrg, async (req, res) => {
    if (!viewerOf(req).hr) return fail(res, 403, 'You do not have permission to do this');
    const c = await ownedCycle(req, res); if (!c) return;
    const blocked = R.cycleChangeError(c.data, 'edit');
    if (blocked) return fail(res, 409, blocked);
    const value = await checkedCycle(req, res); if (!value) return;
    const patch = { ...value, updatedAt: nowIso(), updatedBy: me(req) };
    if (!(await guardedUpdate(res, c, patch, 'this review'))) return;
    audit(req.orgId, req, 'review_cycle_updated', c.id, { name: value.name, audience: value.audience });
    res.json({ success: true, cycle: pubCycle({ ...c.data, ...patch }, await today(req.orgId)) });
});

router.delete('/review-cycles/:id', requireUsOrg, async (req, res) => {
    if (!viewerOf(req).hr) return fail(res, 403, 'You do not have permission to do this');
    const c = await ownedCycle(req, res); if (!c) return;
    const blocked = R.cycleChangeError(c.data, 'delete');
    if (blocked) return fail(res, 409, blocked);
    await c.ref.delete();
    audit(req.orgId, req, 'review_cycle_deleted', c.id, { name: c.data.name });
    res.json({ success: true });
});

/** Open: make one record per person included, then let people start */
router.post('/review-cycles/:id/open', requireUsOrg, async (req, res) => {
    if (!viewerOf(req).hr) return fail(res, 403, 'You do not have permission to do this');
    const c = await ownedCycle(req, res); if (!c) return;
    const t = await today(req.orgId);
    const blocked = R.cycleChangeError(c.data, 'open', t);
    if (blocked) return fail(res, 409, blocked);
    const included = R.audienceFor(c.data, await peopleStore.loadPeople(req.orgId));
    if (!included.length) return fail(res, 409, 'Nobody is included in this review. Choose people first.');
    const at = nowIso();
    // create (never overwrite): if two people press Open at once, the second finds the records already there
    for (let i = 0; i < included.length; i += 50) {
        await Promise.all(included.slice(i, i + 50).map((p) => col('review_cycle_members').doc(R.memberId(c.id, p.id)).create(R.newMember(c.id, req.orgId, p, at)).catch((err) => { if (!alreadyExists(err)) throw err; })));
    }
    const patch = { status: 'open', openedAt: at, openedBy: me(req), memberCount: included.length };
    if (!(await guardedUpdate(res, c, patch, 'this review'))) return;
    audit(req.orgId, req, 'review_cycle_opened', c.id, { name: c.data.name, people: included.length });
    res.json({ success: true, cycle: pubCycle({ ...c.data, ...patch }, t, { included: included.length }) });
});

/** Close: nobody can write any more, and the finished manager reviews are shared with the employees */
router.post('/review-cycles/:id/close', requireUsOrg, async (req, res) => {
    if (!viewerOf(req).hr) return fail(res, 403, 'You do not have permission to do this');
    const c = await ownedCycle(req, res); if (!c) return;
    const blocked = R.cycleChangeError(c.data, 'close');
    if (blocked) return fail(res, 409, blocked);
    const [members, reviews] = await Promise.all([listWhere('review_cycle_members', req.orgId, 'cycleId', c.id), listWhere('performance_reviews', req.orgId, 'cycleId', c.id)]);
    const reviewsById = byId(reviews);
    const plan = R.reviewsToShareOnClose(c.data, members, reviewsById);
    const at = nowIso();
    const patch = { status: 'closed', closedAt: at, closedBy: me(req) };
    if (!(await guardedUpdate(res, c, patch, 'this review'))) return;
    const done = await Promise.allSettled(plan.share.map((id) => col('performance_reviews').doc(id).update({ status: 'shared', sharedAt: at, sharedBy: me(req), sharedByCycle: c.id })));
    let shared = 0;
    done.forEach((d, i) => { if (d.status === 'fulfilled') { shared += 1; audit(req.orgId, req, 'performance_review_shared', reviewsById[plan.share[i]].userId, { reviewId: plan.share[i], cycleId: c.id }); } });
    const notShared = plan.notReady.length + (plan.share.length - shared);
    audit(req.orgId, req, 'review_cycle_closed', c.id, { name: c.data.name, shared, notShared });
    res.json({ success: true, cycle: pubCycle({ ...c.data, ...patch }, await today(req.orgId)), shared, notShared: c.data.managerReview ? notShared : 0 });
});

/** One cycle with each person's progress (a manager gets their own team only) */
router.get('/review-cycles/:id', requireUsOrg, async (req, res) => {
    const v = viewerOf(req);
    if (!v.any) return fail(res, 403, 'You do not have permission to do this');
    const c = await ownedCycle(req, res); if (!c) return;
    const t = await today(req.orgId);
    if (c.data.status === 'draft') {
        if (!v.companyWide) return fail(res, 404, 'Review not found');
        return res.json({ success: true, cycle: pubCycle(c.data, t, { included: R.audienceFor(c.data, await peopleStore.loadPeople(req.orgId)).length }), canManage: v.hr, wholeCompany: true, progress: R.cycleProgress([]), rows: [] });
    }
    const [members, answers, reviews, people] = await Promise.all([listWhere('review_cycle_members', req.orgId, 'cycleId', c.id), listWhere('review_peer_answers', req.orgId, 'cycleId', c.id), listWhere('performance_reviews', req.orgId, 'cycleId', c.id), peopleMap(req.orgId, { includeInactive: true })]);
    const mine = R.visibleMembers(members, people, { viewerId: me(req), companyWide: v.companyWide, manager: v.manager });
    if (!v.companyWide && !mine.length) return fail(res, 404, 'Review not found');
    const counts = countBySubject(answers); const reviewsById = byId(reviews);
    const rows = mine.map((m) => {
        const p = people.get(m.userId); const boss = p && p.managerId ? people.get(p.managerId) : null;
        return { userId: m.userId, name: (p && p.name) || m.name || m.userId, employeeId: m.employeeId || null, jobTitle: (p && p.jobTitle) || null, managerName: boss ? boss.name : null, you: m.userId === me(req),
            ...R.memberProgress(c.data, m, { peerAnswers: counts[m.userId] || 0, review: reviewsById[reviewIdFor(c.id, m.userId)] || null }) };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ success: true, cycle: pubCycle(c.data, t, { included: rows.length }), canManage: v.hr, wholeCompany: v.companyWide, progress: R.cycleProgress(rows), rows });
});

/* ------------------------------ one person in a cycle (manager, HR) ------------------------------ */

/** Loads the cycle, the person's record and what the signed-in person is to them; answers 403/404 itself */
async function memberFor(req, res) {
    const c = await ownedCycle(req, res); if (!c) return null;
    const people = await peopleMap(req.orgId, { includeInactive: true });
    const m = c.data.status === 'draft' ? null : await memberOf(req.orgId, c.id, req.params.userId);
    const rel = m ? relationTo(req, m.data.userId, people) : null;
    if (!viewerOf(req).any && rel !== 'self') { fail(res, 403, 'You do not have permission to do this'); return null; }
    // a manager asking about someone outside their team gets the same answer as for someone who is not in the review
    if (!m || !rel) { fail(res, 404, 'This person is not part of the review'); return null; }
    if (rel === 'self') { fail(res, 403, 'You cannot open your own record here. Use "My reviews".'); return null; }
    return { c, m, rel, people };
}

router.get('/review-cycles/:id/members/:userId', requireUsOrg, async (req, res) => {
    const x = await memberFor(req, res); if (!x) return;
    const { c, m, rel, people } = x; const uid = m.data.userId;
    const [answersAll, rev, areas, t] = await Promise.all([listWhere('review_peer_answers', req.orgId, 'cycleId', c.id), reviewDoc(req.orgId, c.id, uid), areasFor(req.orgId), today(req.orgId)]);
    const answers = answersAll.filter((a) => a.subjectId === uid);
    const person = people.get(uid); const boss = person && person.managerId ? people.get(person.managerId) : null;
    const feedback = c.data.peerFeedback ? R.combinePeerFeedback(c.data, answers, { asked: (m.data.peerIds || []).length, viewer: rel }) : null;
    audit(req.orgId, req, 'review_cycle_person_viewed', c.id, { userId: uid, as: rel, coworkerFeedbackShown: Boolean(feedback && !feedback.hidden) });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, cycle: pubCycle(c.data, t), canWrite: mayWrite(rel) && c.data.status === 'open',
        person: { userId: uid, name: (person && person.name) || m.data.name || uid, jobTitle: (person && person.jobTitle) || null, managerId: (person && person.managerId) || null, managerName: boss ? boss.name : null },
        progress: R.memberProgress(c.data, m.data, { peerAnswers: answers.length, review: rev ? rev.data : null }),
        self: c.data.selfReview ? R.selfReviewFor(m.data, rel) : null,
        // who was asked is shown (the manager chose them); who has answered, and who wrote what, is not
        coworkers: c.data.peerFeedback ? { asked: (m.data.peerIds || []).map((id) => ({ id, name: (people.get(id) || {}).name || 'Someone who has left' })), locked: R.peersLocked(c.data, answers.length), suggested: Math.max(R.minAnswers(c.data), Number(c.data.peerSuggested) || 0), minAnswers: R.minAnswers(c.data), max: R.MAX_PEERS } : null,
        feedback, review: rev ? pubReview(rev.id, rev.data) : null, areas, ratingLabels: P.RATING_LABELS });
});

/** Choose the coworkers asked for feedback about this person */
router.put('/review-cycles/:id/members/:userId/coworkers', requireUsOrg, async (req, res) => {
    const x = await memberFor(req, res); if (!x) return;
    const { c, m, rel } = x; const uid = m.data.userId;
    if (!mayWrite(rel)) return fail(res, 403, 'Only the person\'s manager or HR can choose coworkers');
    const blocked = R.cycleChangeError(c.data, 'peers');
    if (blocked) return fail(res, 409, blocked);
    const [answersAll, active] = await Promise.all([listWhere('review_peer_answers', req.orgId, 'cycleId', c.id), peopleStore.loadPeople(req.orgId)]);
    if (R.peersLocked(c.data, answersAll.filter((a) => a.subjectId === uid).length)) return fail(res, 409, 'Enough coworkers have answered, so the list can no longer be changed. Adding someone now could give their answer away.');
    const subject = active.find((p) => p.id === uid) || x.people.get(uid) || {};
    const { errors, value } = R.validatePeers(c.data, { subjectId: uid, managerId: subject.managerId || null, pickerId: me(req), peerIds: req.body && req.body.peerIds, knownIds: active.map((p) => p.id) });
    if (errors.length) return invalid(res, errors);
    if (!(await guardedUpdate(res, m, { peerIds: value, peersUpdatedAt: nowIso(), peersUpdatedBy: me(req) }, 'this person\'s record'))) return;
    audit(req.orgId, req, 'review_cycle_coworkers_chosen', c.id, { userId: uid, count: value.length, by: rel });
    res.json({ success: true, asked: value.map((id) => ({ id, name: (active.find((p) => p.id === id) || {}).name || id })) });
});

/** Write the manager review for this person (finish: true marks it as ready; closing the cycle then shares it) */
router.put('/review-cycles/:id/members/:userId/manager-review', requireUsOrg, async (req, res) => {
    const x = await memberFor(req, res); if (!x) return;
    const { c, m, rel, people } = x; const uid = m.data.userId; const b = req.body || {};
    if (!mayWrite(rel)) return fail(res, 403, 'Only the person\'s manager or HR can write this review');
    const blocked = R.cycleChangeError(c.data, 'manager_review');
    if (blocked) return fail(res, 409, blocked);
    const existing = await reviewDoc(req.orgId, c.id, uid);
    if (existing) {
        const why = P.reviewChangeError(existing.data, 'edit'); if (why) return fail(res, 409, why);
        const seen = existing.data.updatedAt || existing.data.createdAt || null;
        if (b.baseUpdatedAt !== undefined && b.baseUpdatedAt !== null && b.baseUpdatedAt !== seen) return fail(res, 409, 'Someone else changed this review after you opened it. Reload and try again.');
    }
    const { errors, value } = P.validateReview({ ...b, periodStart: c.data.periodStart, periodEnd: c.data.periodEnd }, await areasFor(req.orgId));
    if (errors.length) return invalid(res, errors);
    const finish = Boolean(b.finish);
    if (finish) { const ready = P.readyToShare(value); if (!ready.ok) return invalid(res, [`Before marking it as finished, add: ${ready.missing.join('; ')}`]); }
    const at = nowIso(); const privateNote = P.block(b.privateNote, 2000);
    let saved;
    if (existing) {
        const patch = { ...value, privateNote, updatedAt: at, updatedBy: me(req) };
        if (!(await guardedUpdate(res, existing, patch, 'this review'))) return;
        saved = { ...existing.data, ...patch };
    } else {
        saved = { orgId: req.orgId, userId: uid, name: (people.get(uid) || {}).name || m.data.name || null, ...value, privateNote, status: 'draft', reviewerId: me(req), reviewerName: who(req), cycleId: c.id, cycleName: c.data.name, createdAt: at };
        try { await col('performance_reviews').doc(reviewIdFor(c.id, uid)).create(saved); } catch (err) {
            if (alreadyExists(err)) return fail(res, 409, 'Someone else just started this review. Reload and try again.');
            throw err;
        }
    }
    await m.ref.update({ managerReviewId: reviewIdFor(c.id, uid), managerDoneAt: finish ? at : null, managerDoneBy: finish ? me(req) : null });
    audit(req.orgId, req, finish ? 'review_cycle_manager_review_finished' : 'review_cycle_manager_review_saved', c.id, { userId: uid, reviewId: reviewIdFor(c.id, uid), by: rel });
    res.status(existing ? 200 : 201).json({ success: true, review: pubReview(reviewIdFor(c.id, uid), saved), state: finish ? 'finished' : 'draft' });
});

module.exports = router;
