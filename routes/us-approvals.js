/**
 * What is waiting for the signed-in person's decision, in one small read for the home page: hours, punch fixes,
 * time off, shift swaps and claims, clock problems, leave cases, profile changes, join requests, pay changes,
 * time-off payouts, reported training and job openings (services/approvals-rules.js says who counts what).
 *
 * Mount in server.js:  app.use("/api/us", require("./routes/us-approvals"));
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg } = require('./us-hr').helpers;
const teamScope = require('../services/team-scope');
const A = require('../services/approvals-rules');

router.use(verifyToken);

const LABELS = {
    timesheets: ['timesheet', 'timesheets'], punchFixes: ['punch fix', 'punch fixes'], leaveRequests: ['time-off request', 'time-off requests'],
    shiftSwaps: ['shift change', 'shift changes'], shiftClaims: ['request for an open shift', 'requests for open shifts'], clockProblems: ['clock problem', 'clock problems'],
    leaveCases: ['new leave case', 'new leave cases'], profileChanges: ['profile change', 'profile changes'], joinRequests: ['person asking to join', 'people asking to join'],
    payChanges: ['pay change', 'pay changes'], timeOffPayouts: ['time-off payout', 'time-off payouts'], training: ['training to confirm', 'trainings to confirm'],
    jobOpenings: ['job opening', 'job openings']
};

/**
 * GET /api/us/approvals/waiting
 * Anyone signed in may ask. People who cannot decide anything get zeros and canApprove false (no error),
 * so the home page can call it for everybody. Managers are counted for their own direct reports only.
 * Only the collections this person could decide something in are read. A kind that cannot be read (its module is
 * not in use, say) counts as nothing rather than failing the whole answer.
 */
router.get('/approvals/waiting', requireUsOrg, async (req, res) => {
    const none = A.waitingFor(req.user, {});
    res.set('Cache-Control', 'no-store');
    const w = none.wants;
    const mine = (name) => rawCollection(name).where('orgId', '==', req.orgId).get().then((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }))).catch(() => []);
    const when = (yes, name) => (yes ? mine(name) : []);
    const [weeks, corrections, swaps, shifts, exceptions, leave, leaveCases, profileChanges, joinRequests, payChanges, payouts, training, requisitions, people] = await Promise.all([
        when(w.time, 'timesheet_weeks'), when(w.time, 'punch_corrections'), when(w.time, 'shift_swaps'), when(w.time, 'schedule_shifts'), when(w.time, 'clock_exceptions'),
        when(w.leave, 'leave_requests'), when(w.leaveCases, 'leave_cases'), when(w.people, 'profile_change_requests'), when(w.people, 'us_join_requests'),
        when(w.pay, 'comp_history'), when(w.payouts, 'leave_payouts'), when(w.training, 'training_completions'), mine('job_requisitions'),
        none.scope.time === 'team' || none.scope.leave === 'team' ? teamScope.loadOrgPeople(req.orgId) : new Map()
    ]);
    const out = A.waitingFor(req.user, { weeks, corrections, swaps, shifts, exceptions, leave, leaveCases, profileChanges, joinRequests, payChanges, payouts, training, requisitions, people });
    const { wants, ...rest } = out; // eslint-disable-line no-unused-vars
    // the kinds with something waiting, ready to show: [{ kind, count, label, link }]
    const items = Object.keys(LABELS).filter((k) => out[k] > 0).map((k) => ({ kind: k, count: out[k], label: `${out[k]} ${LABELS[k][out[k] === 1 ? 0 : 1]}`, link: A.LINKS[k] }));
    const links = Object.fromEntries(Object.keys(LABELS).filter((k) => out.canApprove && (out[k] > 0 || ['timesheets', 'punchFixes', 'leaveRequests'].includes(k))).map((k) => [k, A.LINKS[k]]));
    if (!wants.time) { delete links.timesheets; delete links.punchFixes; }
    if (!wants.leave) delete links.leaveRequests;
    res.json({ success: true, ...rest, items, links });
});

module.exports = router;
