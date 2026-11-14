/**
 * What is waiting for the signed-in person's decision: hours sent for approval, punch fixes and time-off requests.
 * One small read for the home page, so a manager sees a number instead of having to open each page to look.
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

/**
 * GET /api/us/approvals/waiting
 * Anyone signed in may ask. People who cannot decide anything get zeros and canApprove false (no error),
 * so the home page can call it for everybody. Managers are counted for their own direct reports only;
 * HR counts everyone; payroll admins count everyone's hours but no time off (they do not decide it).
 */
router.get('/approvals/waiting', requireUsOrg, async (req, res) => {
    const none = A.waitingFor(req.user, {});
    res.set('Cache-Control', 'no-store');
    if (!none.canApprove) return res.json({ success: true, ...none, links: {} });
    const mine = (name) => rawCollection(name).where('orgId', '==', req.orgId).get().then((snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    const wantsTime = none.scope.time !== 'none'; const wantsLeave = none.scope.leave !== 'none';
    const [weeks, corrections, leave, people] = await Promise.all([
        wantsTime ? mine('timesheet_weeks') : [], wantsTime ? mine('punch_corrections') : [], wantsLeave ? mine('leave_requests') : [],
        none.scope.time === 'team' || none.scope.leave === 'team' ? teamScope.loadOrgPeople(req.orgId) : new Map()
    ]);
    const out = A.waitingFor(req.user, { weeks, corrections, leave, people });
    res.json({
        success: true, ...out,
        links: { ...(wantsTime ? { timesheets: 'admin-us-time.html', punchFixes: 'admin-us-time.html' } : {}), ...(wantsLeave ? { leaveRequests: 'admin-us-leave.html' } : {}) }
    });
});

module.exports = router;
