/**
 * Pulse surveys and eNPS (US).
 *
 * Who may write, open and close a survey: HR and the owner (people.write).
 * Who may see results: HR, the owner, and read-only roles holding people.read or reports.view,
 *   and only once the survey is closed or its last day has passed (while it is open they see the count only).
 *   Managers do not see results: a small team would give away who said what.
 * Who may answer: everyone signed in to the company, once per survey.
 *
 * Privacy: an answer is stored in `survey_responses` with no user id and only the day, not the time.
 * That a person answered is stored separately in `survey_responders` under a hashed key, so a second
 * answer can be refused. Answering is deliberately not written to the audit log (it would record who and when).
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { can } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const S = require('../services/survey-rules');
const peopleStore = require('../services/people-data-store');

router.use(verifyToken);

const nowIso = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const today = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const col = (n) => rawCollection(n);
const mayManage = (req) => can(req.user, 'people.write');
const maySeeResults = (req) => can(req.user, 'people.write') || can(req.user, 'people.read') || can(req.user, 'reports.view');
const userId = (req) => String(req.user.id || req.user.uid);

async function owned(req, res) {
    const snap = await col('surveys').doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { fail(res, 404, 'Survey not found'); return null; }
    return { ref: snap.ref, id: snap.id, data: snap.data() };
}
async function responsesFor(orgId, surveyId) {
    const snap = await col('survey_responses').where('surveyId', '==', surveyId).get();
    return snap.docs.map((d) => d.data()).filter((d) => d.orgId === orgId);
}
const audienceFor = async (orgId) => (await peopleStore.loadPeople(orgId)).length;
const pub = (id, s, t, extra = {}) => ({ id, title: s.title, intro: s.intro || '', status: s.status, closesOn: s.closesOn || null, minResponses: s.minResponses, questions: s.questions || [], accepting: S.isAcceptingAnswers(s, t), createdAt: s.createdAt, createdByName: s.createdByName || null, openedAt: s.openedAt || null, closedAt: s.closedAt || null, ...extra });

router.get('/surveys/options', requireUsOrg, async (req, res) => {
    res.json({ success: true, noteHr: S.NOTE_HR, notePrivacy: S.NOTE_PRIVACY, types: S.QUESTION_TYPES, scaleLabels: S.SCALE_LABELS, templates: S.TEMPLATES, minFloor: S.MIN_RESPONSES_FLOOR, minDefault: S.MIN_RESPONSES_DEFAULT, maxQuestions: S.MAX_QUESTIONS, canManage: mayManage(req), canSeeResults: maySeeResults(req) });
});

/* ------------------------------ answering (everyone) ------------------------------ */

/** Surveys I can answer now, and whether I already did */
router.get('/surveys/mine', requireUsOrg, async (req, res) => {
    const t = await today(req.orgId);
    const snap = await col('surveys').where('orgId', '==', req.orgId).get();
    const open = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => S.isAcceptingAnswers(s, t));
    const data = await Promise.all(open.map(async (s) => {
        const mark = await col('survey_responders').doc(S.responderKey(s.id, userId(req))).get();
        return { id: s.id, title: s.title, intro: s.intro || '', closesOn: s.closesOn || null, answered: exists(mark), questions: s.questions.map((q) => ({ id: q.id, type: q.type, text: q.text, required: q.required })) };
    }));
    data.sort((a, b) => Number(a.answered) - Number(b.answered) || String(a.closesOn || '9999').localeCompare(String(b.closesOn || '9999')));
    res.json({ success: true, today: t, notePrivacy: S.NOTE_PRIVACY, scaleLabels: S.SCALE_LABELS, waiting: data.filter((s) => !s.answered).length, data });
});

router.post('/surveys/:id/answers', requireUsOrg, async (req, res) => {
    const s = await owned(req, res); if (!s) return;
    const t = await today(req.orgId);
    const blocked = S.surveyChangeError(s.data, 'answer', t);
    if (blocked) return fail(res, 409, blocked);
    const { errors, value } = S.validateAnswers(s.data, req.body && req.body.answers);
    if (errors.length) return invalid(res, errors);
    const markRef = col('survey_responders').doc(S.responderKey(s.id, userId(req)));
    try {
        await markRef.create({ orgId: req.orgId, surveyId: s.id, day: t });
    } catch (err) {
        if (err && (err.code === 6 || /already exists/i.test(String(err.message)))) return fail(res, 409, 'You already answered this survey');
        throw err;
    }
    try {
        // no user id and no time of day: the answer cannot be tied back to the person
        await col('survey_responses').add({ orgId: req.orgId, surveyId: s.id, day: t, answers: value });
    } catch (err) {
        await markRef.delete().catch(() => {});
        throw err;
    }
    res.status(201).json({ success: true });
});

/* ------------------------------ managing (HR, owner) ------------------------------ */

router.get('/surveys', requireUsOrg, async (req, res) => {
    if (!maySeeResults(req)) return fail(res, 403, 'You do not have permission to do this');
    const t = await today(req.orgId);
    const [snap, respSnap, audience] = await Promise.all([col('surveys').where('orgId', '==', req.orgId).get(), col('survey_responses').where('orgId', '==', req.orgId).get(), audienceFor(req.orgId)]);
    const counts = {}; respSnap.docs.forEach((d) => { const id = d.data().surveyId; counts[id] = (counts[id] || 0) + 1; });
    const order = { open: 0, draft: 1, closed: 2 };
    const data = snap.docs.map((d) => pub(d.id, d.data(), t, { responses: counts[d.id] || 0 }))
        .sort((a, b) => order[a.status] - order[b.status] || String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, today: t, audience, canManage: mayManage(req), data });
});

router.post('/surveys', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const { errors, value } = S.validateSurvey(req.body);
    if (errors.length) return invalid(res, errors);
    const doc = { orgId: req.orgId, ...value, status: 'draft', createdAt: nowIso(), createdBy: userId(req), createdByName: req.user.name || null };
    const ref = await col('surveys').add(doc);
    audit(req.orgId, req, 'survey_created', ref.id, { questions: value.questions.length });
    res.status(201).json({ success: true, survey: pub(ref.id, doc, await today(req.orgId), { responses: 0 }) });
});

router.put('/surveys/:id', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const s = await owned(req, res); if (!s) return;
    const blocked = S.surveyChangeError(s.data, 'edit');
    if (blocked) return fail(res, 409, blocked);
    const { errors, value } = S.validateSurvey(req.body);
    if (errors.length) return invalid(res, errors);
    const patch = { ...value, updatedAt: nowIso(), updatedBy: userId(req) };
    await s.ref.update(patch);
    audit(req.orgId, req, 'survey_updated', s.id, { questions: value.questions.length });
    res.json({ success: true, survey: pub(s.id, { ...s.data, ...patch }, await today(req.orgId), { responses: 0 }) });
});

async function move(req, res, action, patchFor) {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const s = await owned(req, res); if (!s) return;
    const t = await today(req.orgId);
    const blocked = S.surveyChangeError(s.data, action, t);
    if (blocked) return fail(res, 409, blocked);
    const patch = patchFor();
    await s.ref.update(patch);
    audit(req.orgId, req, `survey_${action === 'open' ? 'opened' : 'closed'}`, s.id, { title: s.data.title });
    res.json({ success: true, survey: pub(s.id, { ...s.data, ...patch }, t) });
}
router.post('/surveys/:id/open', requireUsOrg, (req, res) => move(req, res, 'open', () => ({ status: 'open', openedAt: nowIso(), openedBy: userId(req) })));
router.post('/surveys/:id/close', requireUsOrg, (req, res) => move(req, res, 'close', () => ({ status: 'closed', closedAt: nowIso(), closedBy: userId(req) })));

router.delete('/surveys/:id', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const s = await owned(req, res); if (!s) return;
    const blocked = S.surveyChangeError(s.data, 'delete');
    if (blocked) return fail(res, 409, blocked);
    await s.ref.delete();
    audit(req.orgId, req, 'survey_deleted', s.id, { title: s.data.title });
    res.json({ success: true });
});

router.get('/surveys/:id/results', requireUsOrg, async (req, res) => {
    if (!maySeeResults(req)) return fail(res, 403, 'You do not have permission to do this');
    const s = await owned(req, res); if (!s) return;
    const [responses, audience, t] = await Promise.all([responsesFor(req.orgId, s.id), audienceFor(req.orgId), today(req.orgId)]);
    audit(req.orgId, req, 'survey_results_viewed', s.id, { responses: responses.length });
    res.json({ success: true, survey: pub(s.id, s.data, t), scaleLabels: S.SCALE_LABELS, results: S.summarize(s.data, responses, { audience, accepting: S.isAcceptingAnswers(s.data, t) }) });
});

module.exports = router;
