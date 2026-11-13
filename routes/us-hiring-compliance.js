/**
 * Hiring compliance: background checks (FCRA workflow), E-Verify case tracking and state new-hire
 * reporting. Mounted by routes/us-hiring.js (which already runs verifyToken).
 * Nothing here states a law as fact: day counts are editable data, and a note tells the user to confirm.
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { requireUsOrg, findEmployee, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { requirePermission } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const { decryptField } = require('../services/pii-crypto');
const bg = require('../services/background-check-rules');
const provider = require('../services/background-provider');
const ev = require('../services/everify-rules');
const nh = require('../services/new-hire-rules');
const checklists = require('../services/us-checklist-service');
const { addBusinessDays } = require('../services/us-forms');

const nowIso = () => new Date().toISOString();
const today = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const bgManage = requirePermission('background.manage');
const COMPLIANCE_NOTE = 'Confirm these steps and day counts with a US compliance advisor. They can differ by state, city and program.';

async function settings(orgId) {
    const snap = await rawCollection('hiring_settings').doc(orgId).get();
    const s = exists(snap) ? snap.data() : {};
    return { background: { ...bg.DEFAULT_SETTINGS, ...(s.background || {}) }, everify: { ...ev.DEFAULT_SETTINGS, ...(s.everify || {}) } };
}
const orgOptions = (org) => ({ skipFederalHolidays: Boolean(org.usProfile && org.usProfile.i9SkipFederalHolidays) });

/* ============================== background checks (HR only) ============================== */

async function loadCheck(req, res, { create = false } = {}) {
    const cand = await rawCollection('candidates').doc(String(req.params.id)).get();
    if (!exists(cand) || cand.data().orgId !== req.orgId) { res.status(404).json({ success: false, error: 'Candidate not found' }); return null; }
    const ref = rawCollection('background_checks').doc(cand.id);
    const snap = await ref.get();
    if (exists(snap) && snap.data().orgId === req.orgId) return { ref, cand: { id: cand.id, ...cand.data() }, check: { id: cand.id, ...snap.data() } };
    if (!create) { res.status(404).json({ success: false, error: 'No background check for this candidate yet' }); return null; }
    const doc = bg.newCheck(req.orgId, cand.id, nowIso(), req.user.id);
    await ref.set(doc);
    return { ref, cand: { id: cand.id, ...cand.data() }, check: { id: cand.id, ...doc } };
}

async function applyStep(req, res, step) {
    const c = await loadCheck(req, res, { create: true }); if (!c) return;
    const result = await step(c);
    if (result.error) return res.status(result.status || 409).json({ success: false, error: result.error });
    await c.ref.update(result.patch);
    audit(req.orgId, req, `background_${result.action}`, c.cand.id);
    res.json({ success: true, check: bg.summarize({ ...c.check, ...result.patch }, await today(req.orgId)) });
}

router.get('/hiring/background', bgManage, requireUsOrg, async (req, res) => {
    const snap = await rawCollection('background_checks').where('orgId', '==', req.orgId).get();
    const t = await today(req.orgId);
    const rows = snap.docs.map((d) => bg.summarize({ id: d.id, ...d.data() }, t)).map(({ history, ...r }) => r);
    res.json({ success: true, note: COMPLIANCE_NOTE, settings: (await settings(req.orgId)).background, count: rows.length, data: rows });
});

router.get('/hiring/candidates/:id/background', bgManage, requireUsOrg, async (req, res) => {
    const c = await loadCheck(req, res); if (!c) return;
    audit(req.orgId, req, 'background_viewed', c.cand.id);
    res.json({ success: true, note: COMPLIANCE_NOTE, check: bg.summarize(c.check, await today(req.orgId)) });
});

router.post('/hiring/candidates/:id/background/disclosure', bgManage, requireUsOrg, (req, res) =>
    applyStep(req, res, async (c) => ({ ...bg.recordDisclosure(c.check, req.body, nowIso(), req.user.id), action: 'disclosure_recorded' })));

router.post('/hiring/candidates/:id/background/authorization', bgManage, requireUsOrg, (req, res) =>
    applyStep(req, res, async (c) => {
        const b = req.body || {};
        if (b.method === 'esign') {
            if (!b.signRequestId) return { error: 'Give the signed request (signRequestId) for an e-signed authorization', status: 400 };
            const sr = await rawCollection('sign_requests').doc(String(b.signRequestId)).get();
            if (!exists(sr) || sr.data().orgId !== req.orgId || sr.data().candidateId !== c.cand.id || sr.data().status !== 'signed') return { error: 'That signature request is not a signed document for this candidate' };
        }
        return { ...bg.recordAuthorization(c.check, b, nowIso(), req.user.id), action: 'authorization_recorded' };
    }));

router.post('/hiring/candidates/:id/background/order', bgManage, requireUsOrg, (req, res) =>
    applyStep(req, res, async (c) => {
        const can = bg.canOrder(c.check);
        if (!can.ok) return { error: can.reason }; // FCRA: never order before disclosure + authorization
        let p;
        try { p = provider.getProvider(req.body && req.body.provider); } catch (e) { return { error: e.message, status: 400 }; }
        const order = await p.order({ candidate: { id: c.cand.id, firstName: c.cand.firstName, lastName: c.cand.lastName, email: c.cand.email }, package: (req.body && req.body.package) || 'standard' });
        return { ...bg.recordOrder(c.check, { provider: p.name, reference: order.reference, package: (req.body && req.body.package) || 'standard', status: order.status }, nowIso(), req.user.id), action: 'ordered' };
    }));

/** Asks the provider for the result and records it (status and a reference only) */
router.post('/hiring/candidates/:id/background/refresh', bgManage, requireUsOrg, (req, res) =>
    applyStep(req, res, async (c) => {
        if (!c.check.order || !c.check.order.reference) return { error: 'Order the report first' };
        if (c.check.result) return { error: 'A result is already recorded' };
        const p = provider.getProvider(c.check.order.provider);
        const r = await p.fetchResult(c.check.order.reference, { id: c.cand.id, lastName: c.cand.lastName });
        if (r.status !== 'complete') return { error: 'The report is not finished yet' };
        return { ...bg.recordResult(c.check, { status: r.result, reportReference: r.reportReference }, nowIso(), req.user.id), action: 'result_recorded' };
    }));

router.post('/hiring/candidates/:id/background/pre-adverse', bgManage, requireUsOrg, (req, res) =>
    applyStep(req, res, async (c) => ({ ...bg.preAdverse(c.check, req.body, await today(req.orgId), (await settings(req.orgId)).background, req.user.id, nowIso()), action: 'pre_adverse_sent' })));

router.post('/hiring/candidates/:id/background/adverse', bgManage, requireUsOrg, (req, res) =>
    applyStep(req, res, async (c) => ({ ...bg.sendAdverse(c.check, await today(req.orgId), req.user.id, nowIso()), action: 'adverse_action_sent' })));

router.post('/hiring/candidates/:id/background/dispute', bgManage, requireUsOrg, (req, res) =>
    applyStep(req, res, async (c) => ({ ...bg.openDispute(c.check, req.body, nowIso(), req.user.id), action: 'dispute_opened' })));

router.post('/hiring/candidates/:id/background/dispute/resolve', bgManage, requireUsOrg, (req, res) =>
    applyStep(req, res, async (c) => ({ ...bg.resolveDispute(c.check, req.body, nowIso(), req.user.id), action: 'dispute_resolved' })));

/* ================================== E-Verify tracking ================================== */

const pubCase = (id, c, t) => ({
    id, userId: c.userId, employeeId: c.employeeId || null, name: c.name, hireDate: c.hireDate, dueDate: c.dueDate, caseNumber: c.caseNumber, createdDate: c.createdDate, status: c.status,
    photoMatchRequired: Boolean(c.photoMatchRequired), tnc: c.tnc || null, closedOn: c.closedOn || null, notes: c.notes || '', flags: ev.caseFlags(c, t), history: c.history || []
});

router.get('/hiring/everify/cases', requirePermission('compliance.view'), requireUsOrg, async (req, res) => {
    const s = await settings(req.orgId);
    const t = await today(req.orgId);
    const cs = await rawCollection('everify_cases').where('orgId', '==', req.orgId).get();
    const cases = cs.docs.map((d) => pubCase(d.id, d.data(), t));
    let missing = [];
    if (s.everify.used) {
        const us = await rawCollection('users').where('orgId', '==', req.orgId).get();
        const since = nh.addCalendarDays(t, -90);
        const hires = us.docs.map((d) => ({ id: d.id, ...d.data() })).filter((u) => !/^terminated$/i.test(String(u.status || ''))).map((u) => ({ userId: u.id, name: u.name, hireDate: nh.startDateOf(u) })).filter((h) => h.hireDate && h.hireDate >= since);
        missing = ev.missingCases(hires, new Set(cases.map((c) => c.userId)), s.everify, t, orgOptions(req.org));
    }
    res.json({ success: true, note: COMPLIANCE_NOTE, used: s.everify.used, settings: s.everify, cases, missing, overdue: { cases: cases.filter((c) => c.flags.length), missing: missing.filter((m) => m.overdue) } });
});

router.post('/hiring/everify/cases', requirePermission('compliance.manage'), requireUsOrg, async (req, res) => {
    const s = await settings(req.orgId);
    if (!s.everify.used) return res.status(409).json({ success: false, error: 'E-Verify is turned off for this company (Settings)' });
    const emp = await findEmployee(req.orgId, String((req.body && req.body.userId) || ''));
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const hireDate = nh.startDateOf(emp.data);
    if (!hireDate) return res.status(400).json({ success: false, errors: ['This employee has no start date'] });
    const t = await today(req.orgId);
    const { errors, value } = ev.validateCase(req.body, t);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const dup = await rawCollection('everify_cases').where('orgId', '==', req.orgId).where('userId', '==', emp.id).get();
    if (!dup.empty) return res.status(409).json({ success: false, error: 'This employee already has an E-Verify case' });
    const ref = rawCollection('everify_cases').doc();
    const doc = { orgId: req.orgId, userId: emp.id, employeeId: emp.data.employeeId || null, name: emp.data.name || null, hireDate, dueDate: ev.caseDueDate(hireDate, s.everify, orgOptions(req.org)), ...value, status: 'initial', tnc: null, createdAt: nowIso(), createdBy: req.user.id, history: [{ at: nowIso(), from: null, to: 'initial', by: req.user.id }] };
    await ref.set(doc);
    audit(req.orgId, req, 'everify_case_created', ref.id, { userId: emp.id });
    res.status(201).json({ success: true, case: pubCase(ref.id, doc, t) });
});

router.post('/hiring/everify/cases/:id/status', requirePermission('compliance.manage'), requireUsOrg, async (req, res) => {
    const snap = await rawCollection('everify_cases').doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Case not found' });
    const s = await settings(req.orgId);
    const t = await today(req.orgId);
    const r = ev.transition(snap.data(), String((req.body && req.body.status) || ''), req.body, s.everify, t, nowIso(), req.user.id);
    if (r.error) return res.status(409).json({ success: false, error: r.error });
    await snap.ref.update(r.patch);
    audit(req.orgId, req, 'everify_case_status', snap.id, { to: r.patch.status });
    res.json({ success: true, case: pubCase(snap.id, { ...snap.data(), ...r.patch }, t) });
});

/* =========================== state new-hire reporting ============================ */

const NH_REVEAL = requirePermission('pii.reveal');
const nhManage = requirePermission('compliance.manage');

async function agencyMap(orgId) {
    const snap = await rawCollection('new_hire_agencies').where('orgId', '==', orgId).get();
    return Object.fromEntries(snap.docs.map((d) => [d.data().state, { id: d.id, ...d.data() }]));
}
async function submittedSet(orgId) {
    const snap = await rawCollection('new_hire_submissions').where('orgId', '==', orgId).get();
    return { ids: new Set(snap.docs.map((d) => d.data().userId)), rows: snap.docs.map((d) => ({ id: d.id, ...d.data() })) };
}
async function pending(req) {
    const t = await today(req.orgId);
    const days = Math.min(365, Math.max(1, Number(req.query.sinceDays) || 60));
    const us = await rawCollection('users').where('orgId', '==', req.orgId).get();
    const rows = nh.pendingList(us.docs.map((d) => ({ id: d.id, data: d.data() })), await agencyMap(req.orgId), (await submittedSet(req.orgId)).ids, req.org, t, nh.addCalendarDays(t, -days));
    return { rows: req.query.state ? rows.filter((r) => r.state === String(req.query.state).toUpperCase()) : rows, today: t };
}

router.get('/hiring/newhire/agencies', requirePermission('compliance.view'), requireUsOrg, async (req, res) => {
    const m = await agencyMap(req.orgId);
    res.json({ success: true, note: 'Due days and portals are editable. Seeded values are placeholders: verify with your state agency.', count: Object.keys(m).length, data: Object.values(m).sort((a, b) => a.state.localeCompare(b.state)) });
});

router.post('/hiring/newhire/agencies/seed', nhManage, requireUsOrg, async (req, res) => {
    const have = await agencyMap(req.orgId);
    const onlyStates = (req.org.usProfile && req.org.usProfile.workStates) || null;
    const seeds = nh.seedAgencies(req.body && req.body.allStates === true ? null : (onlyStates && onlyStates.length ? onlyStates : null)).filter((a) => !have[a.state]);
    await Promise.all(seeds.map((a) => rawCollection('new_hire_agencies').doc(`${req.orgId}_${a.state}`).set({ orgId: req.orgId, ...a, createdAt: nowIso() })));
    audit(req.orgId, req, 'new_hire_agencies_seeded', req.orgId, { count: seeds.length });
    res.json({ success: true, created: seeds.length, note: 'Seed values are placeholders. Verify the due days and portal with each state agency.' });
});

router.put('/hiring/newhire/agencies/:state', nhManage, requireUsOrg, async (req, res) => {
    const { errors, value } = nh.validateAgency({ ...req.body, state: req.params.state });
    if (errors.length) return res.status(400).json({ success: false, errors });
    await rawCollection('new_hire_agencies').doc(`${req.orgId}_${value.state}`).set({ orgId: req.orgId, ...value, updatedAt: nowIso(), updatedBy: req.user.id }, { merge: true });
    audit(req.orgId, req, 'new_hire_agency_saved', value.state, { dueDays: value.dueDays });
    res.json({ success: true, agency: value });
});

router.get('/hiring/newhire/pending', requirePermission('compliance.view'), requireUsOrg, async (req, res) => {
    const { rows, today: t } = await pending(req);
    res.json({ success: true, note: 'On screen only the last 4 digits of the SSN are shown.', today: t, count: rows.length, overdue: rows.filter((r) => r.overdue).length, data: rows });
});

router.get('/hiring/newhire/submissions', requirePermission('compliance.view'), requireUsOrg, async (req, res) => {
    const s = await submittedSet(req.orgId);
    res.json({ success: true, count: s.rows.length, data: s.rows.sort((a, b) => String(b.submittedOn).localeCompare(String(a.submittedOn))).slice(0, 500) });
});

/** The only place a full SSN leaves the system: the downloadable file, for the owner and HR admin, with an audit entry */
router.get('/hiring/newhire/export.csv', NH_REVEAL, requireUsOrg, async (req, res) => {
    const state = String(req.query.state || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) return res.status(400).json({ success: false, error: 'state is required (2-letter code)' });
    const { rows } = await pending({ ...req, query: { ...req.query, state } });
    let chosen = rows;
    if (req.query.userIds) { const ids = new Set(String(req.query.userIds).split(',')); chosen = rows.filter((r) => ids.has(r.userId)); }
    if (!chosen.length) return res.status(404).json({ success: false, error: 'No pending new hires for that state' });
    const entries = [];
    for (const r of chosen) {
        const u = (await rawCollection('users').doc(r.userId).get()).data();
        let ssn = '';
        if (u.usProfile && u.usProfile.taxpayerIdEncrypted) {
            try { ssn = decryptField(u.usProfile.taxpayerIdEncrypted, `${req.orgId}:${r.userId}`); } catch (e) { logger.error(`New-hire export decrypt failed for ${r.userId}: ${e.message}`); }
        }
        entries.push({ user: u, ssn });
    }
    await audit(req.orgId, req, 'new_hire_csv_downloaded', state, { count: entries.length, includesFullSsn: true });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="new-hires-${state}.csv"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.send(nh.buildCsv(entries, req.org));
});

router.post('/hiring/newhire/submit', nhManage, requireUsOrg, async (req, res) => {
    const t = await today(req.orgId);
    const { errors, value } = nh.validateSubmission(req.body, t);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const done = []; const skipped = [];
    for (const uid of value.userIds) {
        const emp = await findEmployee(req.orgId, uid);
        if (!emp) { skipped.push({ userId: uid, reason: 'not found' }); continue; }
        const ref = rawCollection('new_hire_submissions').doc(`${req.orgId}_${emp.id}`);
        if (exists(await ref.get())) { skipped.push({ userId: uid, reason: 'already submitted' }); continue; }
        await ref.set({ orgId: req.orgId, userId: emp.id, employeeId: emp.data.employeeId || null, name: emp.data.name || null, state: value.state, confirmationNumber: value.confirmationNumber, submittedOn: value.submittedOn, recordedAt: nowIso(), recordedBy: req.user.id });
        // tick the onboarding checklist task
        for (const list of await checklists.listForUser(req.orgId, emp.id)) {
            const task = (list.tasks || []).find((x) => x.id === 'new_hire_report');
            if (task && task.status !== 'done') {
                task.status = 'done'; task.doneAt = nowIso(); task.doneBy = req.user.id; task.note = `Reported to ${value.state}, confirmation ${value.confirmationNumber}`;
                await rawCollection('checklists').doc(list.id).update({ tasks: list.tasks });
            }
        }
        done.push(emp.id);
    }
    audit(req.orgId, req, 'new_hire_report_submitted', value.state, { count: done.length, confirmationNumber: value.confirmationNumber });
    res.json({ success: true, submitted: done.length, skipped });
});

module.exports = router;
module.exports.addBusinessDays = addBusinessDays;
