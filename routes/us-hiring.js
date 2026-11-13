/**
 * Recruiting / applicant tracking (signed-in side): requisitions, candidates, pipeline, scorecards,
 * interviews, offers, hire -> employee. Background checks, E-Verify and new-hire reporting live in
 * routes/us-hiring-compliance.js and are mounted on this router.
 * Hiring managers only ever see requisitions where they are the hiring manager (hiringManagerId).
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { requirePermission, can, canonicalRole } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const H = require('../services/hiring-rules');
const people = require('../services/us-people-service');
const store = require('../services/file-store');
const eeoRules = require('../services/eeo-rules');
const bgRules = require('../services/background-check-rules');

router.use(verifyToken);

const NOTE = 'Hiring and screening practices are regulated by federal, state and local law. Confirm yours with a US compliance advisor.';
const nowIso = () => new Date().toISOString();
const today = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const isManagerRole = (u) => canonicalRole(u.role) === 'manager';
const view = requirePermission('hiring.view');
const manage = requirePermission('hiring.manage');

/** Settings document (one per company) */
async function loadSettings(orgId) {
    const snap = await rawCollection('hiring_settings').doc(orgId).get();
    return exists(snap) ? snap.data() : { orgId };
}

/** May this user see (and for managers, work on) this requisition? */
const canSeeReq = (user, r) => !isManagerRole(user) || r.hiringManagerId === user.id;

const pubReq = (id, r, extra = {}) => ({
    id, title: r.title, department: r.department, location: r.location, state: r.state || null, employmentType: r.employmentType, payMin: r.payMin == null ? null : r.payMin, payMax: r.payMax == null ? null : r.payMax,
    payUnit: r.payUnit || 'hour', headcount: r.headcount, filledCount: r.filledCount || 0, status: r.status, hiringManagerId: r.hiringManagerId || null, hiringManagerName: r.hiringManagerName || null,
    approvals: r.approvals || [], description: r.description || '', competencies: r.competencies || H.DEFAULT_COMPETENCIES, targetStartDate: r.targetStartDate || null, createdAt: r.createdAt, openedAt: r.openedAt || null, ...extra
});
const pubCand = (id, c) => ({
    id, name: c.name, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, source: c.source, requisitionId: c.requisitionId, requisitionTitle: c.requisitionTitle, stage: c.stage,
    appliedAt: c.appliedAt, updatedAt: c.updatedAt, hasResume: Boolean(c.resume && c.resume.fileId), resumeName: c.resume ? c.resume.fileName : null, possibleDuplicates: (c.duplicateOfIds || []).length,
    offerStatus: c.offerStatus || null, offer: c.offer || null, personId: c.personId || null, employeeId: c.employeeId || null, erased: Boolean(c.erased)
});

async function loadReq(req, res, id) {
    const snap = await rawCollection('job_requisitions').doc(String(id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId || !canSeeReq(req.user, snap.data())) { res.status(404).json({ success: false, error: 'Requisition not found' }); return null; }
    return { ref: snap.ref, id: snap.id, data: snap.data() };
}
async function loadCandidate(req, res, id) {
    const snap = await rawCollection('candidates').doc(String(id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { res.status(404).json({ success: false, error: 'Candidate not found' }); return null; }
    const d = snap.data();
    if (isManagerRole(req.user) && d.hiringManagerId !== req.user.id) { res.status(404).json({ success: false, error: 'Candidate not found' }); return null; }
    return { ref: snap.ref, id: snap.id, data: d };
}
const event = (orgId, candidateId, type, by, data) => rawCollection('candidate_events').add({ orgId, candidateId, type, at: nowIso(), by: by || null, data: data || {} });

async function userInOrg(orgId, uid) {
    const s = await rawCollection('users').doc(String(uid)).get();
    return exists(s) && s.data().orgId === orgId ? { id: s.id, ...s.data() } : null;
}

/* --------------------------------------------- settings --------------------------------------------- */

router.get('/hiring/settings', manage, requireUsOrg, async (req, res) => {
    const s = await loadSettings(req.orgId);
    res.json({ success: true, note: NOTE, careersEnabled: req.org.careersEnabled !== false, careersPath: `/careers.html?org=${encodeURIComponent(req.orgId)}`, everify: { ...require('../services/everify-rules').DEFAULT_SETTINGS, ...(s.everify || {}) }, background: { ...bgRules.DEFAULT_SETTINGS, ...(s.background || {}) } });
});

router.put('/hiring/settings', manage, requireUsOrg, async (req, res) => {
    const b = req.body || {};
    const errors = []; const patch = {};
    if (b.careersEnabled !== undefined) await rawCollection('organizations').doc(req.orgId).set({ careersEnabled: b.careersEnabled === true }, { merge: true });
    if (b.background !== undefined) { const r = bgRules.validateSettings(b.background); errors.push(...r.errors); if (r.value) patch.background = r.value; }
    if (b.everify !== undefined) { const r = require('../services/everify-rules').validateSettings(b.everify); errors.push(...r.errors); if (r.value) patch.everify = r.value; }
    if (errors.length) return res.status(400).json({ success: false, errors });
    if (Object.keys(patch).length) await rawCollection('hiring_settings').doc(req.orgId).set({ orgId: req.orgId, ...patch, updatedAt: nowIso() }, { merge: true });
    audit(req.orgId, req, 'hiring_settings_updated', req.orgId, { fields: [...Object.keys(patch), ...(b.careersEnabled !== undefined ? ['careersEnabled'] : [])] });
    res.json({ success: true });
});

router.get('/hiring/options', view, requireUsOrg, (req, res) => {
    res.json({ success: true, note: NOTE, stages: H.STAGES, reqStatuses: H.REQ_STATUSES, employmentTypes: H.EMPLOYMENT_TYPES, sources: H.SOURCES, recommendations: H.RECOMMENDATIONS, defaultCompetencies: H.DEFAULT_COMPETENCIES, managerStages: H.MANAGER_STAGES });
});

/* ------------------------------------------- requisitions ------------------------------------------- */

router.get('/hiring/requisitions', view, requireUsOrg, async (req, res) => {
    const [rs, cs] = await Promise.all([rawCollection('job_requisitions').where('orgId', '==', req.orgId).get(), rawCollection('candidates').where('orgId', '==', req.orgId).get()]);
    const counts = {};
    cs.docs.forEach((d) => { const c = d.data(); if (!H.TERMINAL_STAGES.includes(c.stage)) counts[c.requisitionId] = (counts[c.requisitionId] || 0) + 1; });
    let rows = rs.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => canSeeReq(req.user, r));
    if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, count: rows.length, data: rows.map((r) => pubReq(r.id, r, { activeCandidates: counts[r.id] || 0 })) });
});

async function buildApprovals(orgId, ids) {
    const out = [];
    for (const id of ids) {
        const u = await userInOrg(orgId, id);
        if (!u) return { error: `Approver ${id} was not found in your company` };
        out.push({ userId: id, name: u.name || u.email, decision: 'pending', at: null, note: null });
    }
    return { approvals: out };
}

router.post('/hiring/requisitions', manage, requireUsOrg, async (req, res) => {
    const { errors, value } = H.validateRequisition({ ...req.body, status: undefined });
    if (errors.length) return res.status(400).json({ success: false, errors });
    const doc = { orgId: req.orgId, ...value, status: 'draft', filledCount: 0, createdAt: nowIso(), createdBy: req.user.id, approvals: [], competencies: value.competencies || H.DEFAULT_COMPETENCIES };
    if (value.hiringManagerId) {
        const m = await userInOrg(req.orgId, value.hiringManagerId);
        if (!m) return res.status(400).json({ success: false, errors: ['hiringManagerId was not found in your company'] });
        doc.hiringManagerName = m.name || m.email;
    }
    if ((value.approverIds || []).length) {
        const a = await buildApprovals(req.orgId, value.approverIds);
        if (a.error) return res.status(400).json({ success: false, errors: [a.error] });
        doc.approvals = a.approvals;
    }
    delete doc.approverIds;
    const ref = rawCollection('job_requisitions').doc();
    await ref.set(doc);
    audit(req.orgId, req, 'requisition_created', ref.id, { title: doc.title });
    res.status(201).json({ success: true, requisition: pubReq(ref.id, doc) });
});

router.get('/hiring/requisitions/:id', view, requireUsOrg, async (req, res) => {
    const r = await loadReq(req, res, req.params.id); if (!r) return;
    res.json({ success: true, requisition: pubReq(r.id, r.data) });
});

router.put('/hiring/requisitions/:id', manage, requireUsOrg, async (req, res) => {
    const r = await loadReq(req, res, req.params.id); if (!r) return;
    const { errors, value } = H.validateRequisition(req.body, { partial: true });
    if (errors.length) return res.status(400).json({ success: false, errors });
    const patch = { ...value, updatedAt: nowIso() };
    delete patch.approverIds;
    if (value.hiringManagerId) {
        const m = await userInOrg(req.orgId, value.hiringManagerId);
        if (!m) return res.status(400).json({ success: false, errors: ['hiringManagerId was not found in your company'] });
        patch.hiringManagerName = m.name || m.email;
        // keep candidates' copy of the manager in step so the manager-only view stays correct
        const cs = await rawCollection('candidates').where('orgId', '==', req.orgId).where('requisitionId', '==', r.id).get();
        await Promise.all(cs.docs.map((d) => d.ref.update({ hiringManagerId: value.hiringManagerId })));
    }
    if (value.approverIds) {
        const a = await buildApprovals(req.orgId, value.approverIds);
        if (a.error) return res.status(400).json({ success: false, errors: [a.error] });
        const done = new Map((r.data.approvals || []).map((x) => [x.userId, x]));
        patch.approvals = a.approvals.map((x) => done.get(x.userId) || x);
    }
    if (!Object.keys(value).length) return res.status(400).json({ success: false, error: 'Nothing to change' });
    await r.ref.update(patch);
    audit(req.orgId, req, 'requisition_updated', r.id, { fields: Object.keys(value) });
    res.json({ success: true, requisition: pubReq(r.id, { ...r.data, ...patch }) });
});

router.post('/hiring/requisitions/:id/status', manage, requireUsOrg, async (req, res) => {
    const r = await loadReq(req, res, req.params.id); if (!r) return;
    const to = String((req.body && req.body.status) || '');
    const ok = H.canSetRequisitionStatus(r.data, to);
    if (!ok.ok) return res.status(409).json({ success: false, error: ok.reason });
    const patch = { status: to, statusChangedAt: nowIso() };
    if (to === 'open' && !r.data.openedAt) patch.openedAt = nowIso();
    await r.ref.update(patch);
    audit(req.orgId, req, 'requisition_status_changed', r.id, { from: r.data.status, to });
    res.json({ success: true, requisition: pubReq(r.id, { ...r.data, ...patch }) });
});

/** A named approver (or the owner) approves or rejects opening a requisition */
router.post('/hiring/requisitions/:id/approve', requireUsOrg, async (req, res) => {
    const snap = await rawCollection('job_requisitions').doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Requisition not found' });
    const r = snap.data();
    const decision = String((req.body && req.body.decision) || '');
    if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ success: false, error: 'decision must be approved or rejected' });
    const mine = (r.approvals || []).find((a) => a.userId === req.user.id);
    if (!mine) return res.status(403).json({ success: false, error: 'You are not an approver for this requisition' });
    mine.decision = decision; mine.at = nowIso(); mine.note = H.clean((req.body || {}).note, 300) || null;
    await snap.ref.update({ approvals: r.approvals });
    audit(req.orgId, req, 'requisition_approval', snap.id, { decision });
    res.json({ success: true, approvals: r.approvals });
});

/* --------------------------------------------- candidates --------------------------------------------- */

router.get('/hiring/candidates', view, requireUsOrg, async (req, res) => {
    const snap = await rawCollection('candidates').where('orgId', '==', req.orgId).get();
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => !c.erased && (!isManagerRole(req.user) || c.hiringManagerId === req.user.id));
    for (const k of ['stage', 'requisitionId', 'source']) if (req.query[k]) rows = rows.filter((c) => c[k] === req.query[k]);
    if (req.query.q) { const q = String(req.query.q).toLowerCase(); rows = rows.filter((c) => `${c.name} ${c.email}`.toLowerCase().includes(q)); }
    rows.sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));
    res.json({ success: true, count: rows.length, data: rows.slice(0, 500).map((c) => pubCand(c.id, c)) });
});

router.get('/hiring/candidates/:id', view, requireUsOrg, async (req, res) => {
    const c = await loadCandidate(req, res, req.params.id); if (!c) return;
    const evSnap = await rawCollection('candidate_events').where('orgId', '==', req.orgId).where('candidateId', '==', c.id).get();
    const events = evSnap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const scorecards = events.filter((e) => e.type === 'scorecard').map((e) => ({ id: e.id, by: e.by, byName: e.data.byName, ...e.data, at: e.at }));
    const dupSnap = (c.data.duplicateOfIds || []).length ? await rawCollection('candidates').where('orgId', '==', req.orgId).where('email', '==', c.data.email).get() : { docs: [] };
    const out = {
        ...pubCand(c.id, c.data), stageHistory: c.data.stageHistory || [], interviews: c.data.interviews || [], notes: events.filter((e) => e.type === 'note').map((e) => ({ at: e.at, by: e.data.byName || e.by, text: e.data.text })),
        events: events.filter((e) => e.type !== 'scorecard').map((e) => ({ at: e.at, type: e.type, by: e.by, data: e.type === 'note' ? undefined : e.data })), scorecards,
        scorecardAverage: scorecards.length ? Math.round((scorecards.reduce((s, x) => s + x.average, 0) / scorecards.length) * 100) / 100 : null,
        duplicates: dupSnap.docs.filter((d) => d.id !== c.id).map((d) => ({ id: d.id, requisitionTitle: d.data().requisitionTitle, stage: d.data().stage, appliedAt: d.data().appliedAt }))
    };
    const rq = await rawCollection('job_requisitions').doc(c.data.requisitionId).get();
    out.competencies = exists(rq) ? (rq.data().competencies || H.DEFAULT_COMPETENCIES) : H.DEFAULT_COMPETENCIES;
    if (can(req.user, 'background.manage')) {
        const bg = await rawCollection('background_checks').doc(c.id).get();
        out.background = exists(bg) && bg.data().orgId === req.orgId ? bgRules.summarize({ id: bg.id, ...bg.data() }, await today(req.orgId)) : null;
    }
    audit(req.orgId, req, 'candidate_viewed', c.id);
    res.json({ success: true, candidate: out });
});

router.put('/hiring/candidates/:id/stage', view, requireUsOrg, async (req, res) => {
    const c = await loadCandidate(req, res, req.params.id); if (!c) return;
    const to = String((req.body && req.body.stage) || '');
    const fullRights = can(req.user, 'hiring.manage');
    if (!fullRights && !(isManagerRole(req.user) && H.managerMayMove(to))) return res.status(403).json({ success: false, error: 'You can move candidates between screen, interview and assessment. HR handles offers, hires and rejections' });
    if (!fullRights && !H.OPEN_STAGES.includes(c.data.stage)) return res.status(403).json({ success: false, error: 'Only HR can change this candidate' });
    const ok = H.canMoveStage(c.data.stage, to);
    if (!ok.ok) return res.status(409).json({ success: false, error: ok.reason });
    if (to === 'hired') return res.status(409).json({ success: false, error: 'Use the hire endpoint to turn a candidate into an employee' });
    const note = req.body.note ? H.clean(req.body.note, 300) : null;
    if (to === 'rejected' && !note) return res.status(400).json({ success: false, error: 'Add a short reason when rejecting a candidate' });
    const at = nowIso();
    await c.ref.update({ stage: to, stageHistory: H.addStageHistory(c.data.stageHistory, to, at, req.user.id, note), updatedAt: at });
    await event(req.orgId, c.id, 'stage_change', req.user.id, { from: c.data.stage, to, note });
    audit(req.orgId, req, 'candidate_stage_changed', c.id, { from: c.data.stage, to });
    res.json({ success: true, stage: to });
});

router.post('/hiring/candidates/:id/notes', view, requireUsOrg, async (req, res) => {
    if (!can(req.user, 'hiring.manage') && !isManagerRole(req.user)) return res.status(403).json({ success: false, error: 'Not allowed' });
    const c = await loadCandidate(req, res, req.params.id); if (!c) return;
    const text = H.cleanBlock(req.body && req.body.text, 2000);
    if (text.length < 2) return res.status(400).json({ success: false, error: 'Write a note' });
    await event(req.orgId, c.id, 'note', req.user.id, { text, byName: req.user.name || req.user.email });
    res.status(201).json({ success: true });
});

router.post('/hiring/candidates/:id/scorecards', view, requireUsOrg, async (req, res) => {
    if (!can(req.user, 'hiring.manage') && !isManagerRole(req.user)) return res.status(403).json({ success: false, error: 'Only interviewers can submit a scorecard' });
    const c = await loadCandidate(req, res, req.params.id); if (!c) return;
    if (!H.OPEN_STAGES.includes(c.data.stage)) return res.status(409).json({ success: false, error: 'This candidate is no longer in the pipeline' });
    const rq = await rawCollection('job_requisitions').doc(c.data.requisitionId).get();
    const { errors, value } = H.validateScorecard(req.body, exists(rq) ? rq.data().competencies : null);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const slug = value.round.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30) || 'interview';
    const ref = rawCollection('candidate_events').doc(`sc_${c.id}_${req.user.id}_${slug}`); // one scorecard per interviewer per round, resubmitting replaces it
    await ref.set({ orgId: req.orgId, candidateId: c.id, type: 'scorecard', at: nowIso(), by: req.user.id, data: { ...value, byName: req.user.name || req.user.email } });
    audit(req.orgId, req, 'scorecard_submitted', c.id, { round: value.round, average: value.average });
    res.status(201).json({ success: true, average: value.average });
});

router.post('/hiring/candidates/:id/interviews', view, requireUsOrg, async (req, res) => {
    if (!can(req.user, 'hiring.manage') && !isManagerRole(req.user)) return res.status(403).json({ success: false, error: 'Not allowed' });
    const c = await loadCandidate(req, res, req.params.id); if (!c) return;
    const { errors, value } = H.validateInterview(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const interviews = [...(c.data.interviews || []), { id: `i${Date.now().toString(36)}`, ...value, createdBy: req.user.id, createdAt: nowIso() }];
    await c.ref.update({ interviews, updatedAt: nowIso() });
    await event(req.orgId, c.id, 'interview_scheduled', req.user.id, { when: value.when, interviewers: value.interviewers });
    res.status(201).json({ success: true, interviews });
});

router.put('/hiring/candidates/:id/offer', manage, requireUsOrg, async (req, res) => {
    const c = await loadCandidate(req, res, req.params.id); if (!c) return;
    if (!H.OPEN_STAGES.includes(c.data.stage)) return res.status(409).json({ success: false, error: 'This candidate is no longer in the pipeline' });
    if (c.data.offerStatus === 'accepted') return res.status(409).json({ success: false, error: 'The offer was already accepted' });
    const { errors, value } = H.validateOffer(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const at = nowIso();
    const patch = { offer: { ...value, preparedBy: req.user.id, preparedAt: at }, offerStatus: 'drafted', updatedAt: at };
    if (c.data.stage !== 'offer') { patch.stage = 'offer'; patch.stageHistory = H.addStageHistory(c.data.stageHistory, 'offer', at, req.user.id, 'Offer prepared'); }
    await c.ref.update(patch);
    await event(req.orgId, c.id, 'offer_prepared', req.user.id, { jobTitle: value.jobTitle, startDate: value.startDate });
    audit(req.orgId, req, 'candidate_offer_prepared', c.id);
    res.json({ success: true, offer: patch.offer, stage: patch.stage || c.data.stage });
});

router.get('/hiring/candidates/:id/resume', view, requireUsOrg, async (req, res) => {
    const c = await loadCandidate(req, res, req.params.id); if (!c) return;
    if (!c.data.resume || !c.data.resume.fileId || c.data.erased) return res.status(404).json({ success: false, error: 'No resume on file' });
    let buf;
    try { buf = await store.readFile(req.orgId, c.data.resume.fileId); } catch (e) { logger.error(`Resume read failed ${c.id}: ${e.message}`); return res.status(500).json({ success: false, error: 'Could not open the file' }); }
    audit(req.orgId, req, 'candidate_resume_downloaded', c.id);
    res.set({ 'Content-Type': c.data.resume.mime, 'Content-Disposition': `attachment; filename="${String(c.data.resume.fileName).replace(/[^A-Za-z0-9._ -]/g, '_')}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(buf);
});

/** Privacy request: removes the resume and personal details; keeps only anonymous pipeline numbers */
router.post('/hiring/candidates/:id/erase', manage, requireUsOrg, async (req, res) => {
    const c = await loadCandidate(req, res, req.params.id); if (!c) return;
    if (c.data.personId) return res.status(409).json({ success: false, error: 'This candidate is now an employee. Use the employee record instead' });
    if (c.data.resume && c.data.resume.fileId) await store.removeFile(req.orgId, c.data.resume.fileId).catch(() => {});
    await c.ref.update({ erased: true, erasedAt: nowIso(), name: 'Erased', firstName: 'Erased', lastName: '', email: `erased-${c.id}@invalid.local`, phone: '', resume: null, interviews: [], offer: null, duplicateOfIds: [] });
    audit(req.orgId, req, 'candidate_erased', c.id);
    res.json({ success: true });
});

/* ----------------------------------------- hire -> employee ----------------------------------------- */

router.post('/hiring/candidates/:id/hire', manage, requireUsOrg, requirePermission('people.write'), async (req, res) => {
    const c = await loadCandidate(req, res, req.params.id); if (!c) return;
    const d = c.data;
    if (d.personId) return res.status(409).json({ success: false, error: 'This candidate was already hired' });
    if (d.stage !== 'offer') return res.status(409).json({ success: false, error: 'Only a candidate in the Offer stage can be hired' });
    const b = req.body || {};
    if (d.offerStatus !== 'accepted' && b.acceptedOffline !== true) return res.status(409).json({ success: false, error: 'The offer has not been accepted. Send the offer for signature, or confirm it was accepted offline (acceptedOffline: true)' });
    const bgSnap = await rawCollection('background_checks').doc(c.id).get();
    if (exists(bgSnap) && bgSnap.data().orgId === req.orgId) {
        const st = bgRules.statusOf(bgSnap.data());
        if (['consider_review', 'waiting_period', 'adverse_action_final', 'disputed', 'in_progress', 'ordered'].includes(st)) return res.status(409).json({ success: false, error: `The background check is not finished (${st}). Finish it before hiring` });
    }
    const rq = await rawCollection('job_requisitions').doc(d.requisitionId).get();
    const job = exists(rq) ? rq.data() : {};
    const validated = people.validatePerson({
        firstName: d.firstName, lastName: d.lastName, email: d.email, phone: d.phone, role: b.role || 'employee', startDate: b.startDate || (d.offer && d.offer.startDate),
        jobTitle: b.jobTitle || (d.offer && d.offer.jobTitle) || job.title, department: b.department || job.department
    });
    if (validated.errors.length) return res.status(400).json({ success: false, errors: validated.errors });
    if (await people.emailTaken(validated.value.email)) return res.status(409).json({ success: false, error: 'A login with this email already exists' });

    const [employeeId] = await people.allocateEmployeeIds(req.orgId, 1);
    const person = await people.createPerson(req.orgId, validated, employeeId, req.user.id);
    const at = nowIso();
    // new-hire reporting and the I-9 clock read usProfile.startDate / workState
    const profilePatch = { startDate: validated.value.startDate };
    if (job.state) profilePatch.workState = job.state;
    await rawCollection('users').doc(person.uid).set({ usProfile: profilePatch }, { merge: true });
    await c.ref.update({ stage: 'hired', stageHistory: H.addStageHistory(d.stageHistory, 'hired', at, req.user.id, 'Converted to employee'), personId: person.uid, employeeId, hiredAt: at, updatedAt: at });
    await event(req.orgId, c.id, 'hired', req.user.id, { personId: person.uid, employeeId });
    // signed documents from the hiring process now belong to the new employee
    const vault = await rawCollection('vault_documents').where('orgId', '==', req.orgId).where('candidateId', '==', c.id).get();
    await Promise.all(vault.docs.map((v) => v.ref.update({ userId: person.uid, employeeName: person.name, shared: true })));
    if (exists(rq)) {
        const filled = (job.filledCount || 0) + 1;
        const patch = { filledCount: filled };
        if (filled >= job.headcount && job.status === 'open') patch.status = 'filled';
        await rq.ref.update(patch);
    }
    audit(req.orgId, req, 'candidate_hired', c.id, { personId: person.uid, employeeId });
    res.status(201).json({ success: true, employee: person, note: 'Share the temporary password with the new hire securely. It is shown only once.' });
});

/* ------------------------------------------------ reports ------------------------------------------------ */

router.get('/hiring/funnel', view, requireUsOrg, async (req, res) => {
    const snap = await rawCollection('candidates').where('orgId', '==', req.orgId).get();
    let rows = snap.docs.map((d) => d.data()).filter((c) => !c.erased && (!isManagerRole(req.user) || c.hiringManagerId === req.user.id));
    if (req.query.requisitionId) rows = rows.filter((c) => c.requisitionId === req.query.requisitionId);
    res.json({ success: true, ...H.funnel(rows, nowIso()) });
});

/** Applicant EEO answers, totals only (small groups are hidden) */
router.get('/hiring/eeo-summary', requirePermission('eeo.report'), requireUsOrg, async (req, res) => {
    const snap = await rawCollection('candidate_eeo').where('orgId', '==', req.orgId).get();
    let rows = snap.docs.map((d) => d.data());
    if (req.query.requisitionId) rows = rows.filter((r) => r.requisitionId === req.query.requisitionId);
    audit(req.orgId, req, 'applicant_eeo_summary_viewed', req.orgId);
    res.json({ success: true, note: 'Voluntary answers, stored apart from applications and shown only as totals.', ...H.aggregateApplicantEeo(rows.map((r) => r.record)), eeoCategories: { sex: eeoRules.SEX } });
});

router.use(require('./us-hiring-compliance'));

router.helpers = { loadSettings, today };
module.exports = router;
