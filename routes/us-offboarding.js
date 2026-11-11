const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { requireUsOrg, findEmployee, audit, PEOPLE_COLLECTIONS } = require('./us-hr').helpers;
const { orgInfo, punchesSince } = require('./time').helpers;
const { balanceFor, loadPolicies, hireDateOf } = require('./us-leave').helpers;
const timeRules = require('../services/time-rules');
const leaveRules = require('../services/leave-rules');
const forms = require('../services/us-forms');
const store = require('../services/us-checklist-service');
const checklistRules = require('../services/checklist-rules');
const svc = require('../services/us-offboarding-service');

const OFFBOARD_ROLES = ['Super Admin', 'super_admin', 'hr_admin', 'Admin'];

const todayIn = (tz) => timeRules.localDate(new Date().toISOString(), tz);
const isTerminated = (d) => /^terminated$/i.test(String(d.status || ''));

/** Applies every scheduled termination whose last day has passed (also run hourly) */
async function applyDueTerminations() {
    const snap = await rawCollection('users').where('terminationStatus', '==', 'scheduled').get();
    let applied = 0;
    for (const doc of snap.docs) {
        const data = doc.data();
        const last = data.usProfile && data.usProfile.termination && data.usProfile.termination.lastDay;
        if (!last || !data.orgId) continue;
        const info = await orgInfo(data.orgId);
        if (last <= todayIn(info.tz)) {
            await svc.cutAccess({ id: doc.id, ref: doc.ref, data });
            rawCollection('organizations').doc(data.orgId).collection('audit_logs').add({
                action: 'us_termination_effective', targetId: doc.id, actorId: 'system', at: new Date().toISOString(), lastDay: last
            }).catch(() => {});
            applied += 1;
        }
    }
    return applied;
}

if (process.env.NODE_ENV !== 'test') {
    const run = () => applyDueTerminations().catch((e) => logger.error(`Termination job failed: ${e.message}`));
    setTimeout(run, 15000).unref();
    setInterval(run, 60 * 60 * 1000).unref();
}

router.use(verifyToken);

/** Everyone who is leaving or has left, with their checklist progress */
router.get('/offboarding', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    await applyDueTerminations();
    const info = await orgInfo(req.orgId);
    const today = todayIn(info.tz);
    const [snaps, lists] = await Promise.all([
        Promise.all(PEOPLE_COLLECTIONS.map((n) => db.collection(n).get())),
        rawCollection('checklists').where('orgId', '==', req.orgId).where('kind', '==', 'offboarding').get()
    ]);
    const byUser = new Map(lists.docs.map((d) => [d.data().userId, d]));
    const rows = snaps.flatMap((s) => s.docs).filter((d) => d.data().orgId === req.orgId && d.data().usProfile && d.data().usProfile.termination)
        .map((d) => {
            const u = d.data(); const t = u.usProfile.termination; const cl = byUser.get(d.id);
            const ev = cl && !cl.data().cancelled ? checklistRules.evaluate(cl.data().tasks, store.factsFor(u), today) : null;
            return { userId: d.id, employeeId: u.employeeId || null, name: u.name || null, status: u.status, lastDay: t.lastDay, type: t.type, reason: t.reason, rehireEligible: t.rehireEligible,
                listId: cl ? cl.id : null, progress: ev ? ev.summary : null };
        }).sort((a, b) => String(a.lastDay).localeCompare(String(b.lastDay)));
    res.json({ success: true, today, data: rows });
});

router.post('/offboarding/:id/terminate', authorize(OFFBOARD_ROLES), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (emp.id === req.user.id) return res.status(403).json({ success: false, error: 'You cannot end your own employment' });
    if (isTerminated(emp.data) || (emp.data.usProfile && emp.data.usProfile.termination && emp.data.terminationStatus === 'scheduled')) {
        return res.status(409).json({ success: false, error: 'This person is already leaving or has left' });
    }
    const info = await orgInfo(req.orgId);
    const today = todayIn(info.tz);
    const { errors, value } = svc.validateTermination(req.body, hireDateOf(emp), today);
    if (errors.length) return res.status(400).json({ success: false, errors });
    if (value.type === 'termination_for_cause' && String(value.reason).length < 5) return res.status(400).json({ success: false, errors: ['reason needs at least 5 characters for a termination for cause'] });

    const termination = { ...value, recordedAt: new Date().toISOString(), recordedBy: req.user.id, i9RetainUntil: forms.retainUntil(hireDateOf(emp), value.lastDay) };
    const immediate = value.lastDay <= today;
    await emp.ref.set({ status: immediate ? 'Terminated' : 'Terminating', terminationStatus: immediate ? 'effective' : 'scheduled', usProfile: { termination } }, { merge: true });
    if (immediate) await svc.cutAccess({ ...emp });
    const cancelledLeave = await svc.cancelLeaveAfter(req.orgId, emp.id, value.lastDay);
    await store.createChecklist(req.orgId, emp, 'offboarding', value.lastDay, { skipFederalHolidays: Boolean(req.org.usProfile && req.org.usProfile.i9SkipFederalHolidays) });
    audit(req.orgId, req, 'us_termination_recorded', emp.id, { lastDay: value.lastDay, type: value.type, immediate, cancelledLeave });
    res.status(201).json({ success: true, immediate, cancelledLeaveRequests: cancelledLeave, termination });
});

/** Take back a scheduled termination before the last day has passed */
router.post('/offboarding/:id/cancel', authorize(OFFBOARD_ROLES), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (emp.data.terminationStatus !== 'scheduled') return res.status(409).json({ success: false, error: 'Only a termination that has not taken effect can be cancelled. Use rehire for someone who has left.' });
    const t = emp.data.usProfile.termination;
    await emp.ref.update({ status: 'Active', terminationStatus: null, 'usProfile.termination': null, 'usProfile.terminationCancelled': { ...t, cancelledAt: new Date().toISOString(), cancelledBy: req.user.id } });
    const list = await rawCollection('checklists').doc(store.docIdFor(emp.id, 'offboarding')).get();
    if (store.exists(list)) await list.ref.update({ cancelled: true });
    audit(req.orgId, req, 'us_termination_cancelled', emp.id, { lastDay: t.lastDay });
    res.json({ success: true });
});

/** What HR needs to finish: leave to pay out, I-9 retention date, hours in the last two weeks */
router.get('/offboarding/:id/summary', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const t = emp.data.usProfile && emp.data.usProfile.termination;
    if (!t) return res.status(409).json({ success: false, error: 'No termination is recorded for this person' });
    const info = await orgInfo(req.orgId);
    const policies = (await loadPolicies(req.orgId)).filter((p) => leaveRules.appliesTo(p, emp.data.usProfile));
    const leave = [];
    for (const p of policies) {
        const r = await balanceFor(req.orgId, emp, p, info);
        if (r.error) continue;
        leave.push({ policy: p.name, type: p.type, balanceHours: r.balance.balance, payoutRequired: Boolean(p.payoutAtTermination), payoutHours: p.payoutAtTermination ? r.balance.balance : 0 });
    }
    const since = new Date(Date.now() - 15 * 86400000).toISOString();
    const sheet = timeRules.timesheet(await punchesSince(req.orgId, emp.id, since), info.tz, new Date().toISOString(), info.overtimeWeeklyHours);
    res.json({
        success: true, name: emp.data.name, lastDay: t.lastDay, type: t.type, rehireEligible: t.rehireEligible, i9RetainUntil: t.i9RetainUntil,
        leave, totalPayoutHours: leave.reduce((s, l) => s + l.payoutHours, 0),
        lastTwoWeeks: sheet.days.map((d) => ({ date: d.date, workedMinutes: d.workedMinutes })),
        notes: ['Final-pay timing and unused-leave payout rules differ by state: confirm them with a US advisor.']
    });
});

/** Bring a former employee back. Returns a new temporary password once. */
router.post('/offboarding/:id/rehire', authorize(OFFBOARD_ROLES), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!isTerminated(emp.data)) return res.status(409).json({ success: false, error: 'Only someone who has left can be rehired' });
    const t = emp.data.usProfile.termination;
    const start = String((req.body && req.body.startDate) || '');
    if (!forms.parseIsoDate(start) || start < t.lastDay) return res.status(400).json({ success: false, errors: ['startDate must be a real date on or after the last day of the earlier job'] });
    if (t.rehireEligible === false && !(req.body && req.body.override === true && String(req.body.reason || '').length >= 5)) {
        return res.status(409).json({ success: false, error: 'This person was marked not eligible for rehire. Send override: true and a reason to continue.' });
    }
    const access = await svc.restoreAccess(emp);
    const history = [...(emp.data.employmentHistory || []), { startDate: hireDateOf(emp), endDate: t.lastDay, type: t.type, reason: t.reason }];
    await emp.ref.update({
        status: 'Active', terminationStatus: null, joiningDate: start, password: access.hash, must_change_password: true, is_temporary_password: true, invite_status: 'pending',
        employmentHistory: history, 'usProfile.termination': null, 'usProfile.startDate': start, 'usProfile.previousTermination': t
    });
    const i9 = svc.i9RehireAction((emp.data.usForms || {}).i9, start);
    await store.createChecklist(req.orgId, emp, 'rehire', start, { skipFederalHolidays: Boolean(req.org.usProfile && req.org.usProfile.i9SkipFederalHolidays) });
    audit(req.orgId, req, 'us_rehired', emp.id, { startDate: start, i9: i9.action });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, startDate: start, i9, temporaryPassword: access.password });
});

router.helpers = { applyDueTerminations };
module.exports = router;
