/**
 * What is waiting for a person's decision (pure).
 *
 * Twelve kinds, each counted only for someone who could actually decide it:
 *   hours sent for approval, punch fixes, shift swaps, requests for an open shift, clock problems
 *                                         time.approve (everyone) or time.approve_team (direct reports)
 *   time-off requests                     leave.decide (everyone) or leave.decide_team (direct reports)
 *   leave cases just asked for            leave.decide
 *   profile changes, join requests        people.write
 *   pay changes                           people.write and people.read_pay, and not the person who entered it
 *   time-off payouts                      payroll.run, and not the person who asked for it
 *   reported training                     compliance.manage
 *   job openings                          the people named as approvers on the opening
 * Nobody counts their own. A role that can look but not decide (auditor, accountant, executive) has nothing waiting.
 */
const P = require('./permissions');

/**
 * user:  the signed-in person ({ id, role })
 * data:  lists of stored documents, any of which may be missing:
 *          weeks, corrections, leave, swaps, shifts, exceptions, leaveCases, profileChanges, joinRequests,
 *          payChanges, payouts, training, requisitions
 *        and people: Map(userId -> stored person data with id), needed for a manager's team
 * Returns { canApprove, scope: { time, leave }, wants: { ... }, <one count per kind>, total }.
 */
function waitingFor(user, data = {}) {
    const people = data.people || new Map();
    const me = user && (user.id || user.uid);
    const scopeOf = (wide, team) => (P.can(user, wide) ? 'all' : P.can(user, team) ? 'team' : 'none');
    const scope = { time: scopeOf('time.approve', 'time.approve_team'), leave: scopeOf('leave.decide', 'leave.decide_team') };
    // what this person could decide at all: the route reads only these collections
    const wants = {
        time: scope.time !== 'none', leave: scope.leave !== 'none', leaveCases: P.can(user, 'leave.decide'),
        people: P.can(user, 'people.write'), pay: P.can(user, 'people.write') && P.can(user, 'people.read_pay'),
        payouts: P.can(user, 'payroll.run'), training: P.can(user, 'compliance.manage'), requisitions: Boolean(me)
    };
    const inScope = (userId, kind) => {
        if (scope[kind] === 'none' || !userId || userId === me) return false;
        if (scope[kind] === 'all') return true;
        return P.canManage(user, people.get(userId), kind);
    };
    const count = (list, test) => (Array.isArray(list) ? list.filter((x) => x && test(x)).length : 0);
    const notMine = (id) => Boolean(id) && id !== me;

    const out = {
        timesheets: count(data.weeks, (w) => w.status === 'submitted' && inScope(w.userId, 'time')),
        punchFixes: count(data.corrections, (c) => c.status === 'pending' && inScope(c.userId, 'time')),
        leaveRequests: count(data.leave, (r) => r.status === 'pending' && inScope(r.userId, 'leave')),
        // a swap needs the asker in reach and, when there is one, the coworker too; never one you are part of
        shiftSwaps: count(data.swaps, (s) => s.status === 'pending_manager' && inScope(s.requesterId, 'time') && (!s.targetUserId || inScope(s.targetUserId, 'time'))),
        shiftClaims: count(data.shifts, (s) => s.status !== 'cancelled' && s.claim && s.claim.status === 'pending' && inScope(s.claim.userId, 'time')),
        clockProblems: count(data.exceptions, (e) => e.status === 'open' && inScope(e.userId, 'time')),
        leaveCases: wants.leaveCases ? count(data.leaveCases, (c) => c.status === 'requested' && notMine(c.userId)) : 0,
        profileChanges: wants.people ? count(data.profileChanges, (r) => r.status === 'pending' && notMine(r.userId)) : 0,
        joinRequests: wants.people ? count(data.joinRequests, (r) => r.status === 'waiting') : 0,
        payChanges: wants.pay ? count(data.payChanges, (r) => r.status === 'pending_approval' && r.createdBy !== me && notMine(r.userId)) : 0,
        timeOffPayouts: wants.payouts ? count(data.payouts, (p) => p.status === 'pending' && p.requestedBy !== me && notMine(p.userId)) : 0,
        training: wants.training ? count(data.training, (t) => t.status === 'reported' && notMine(t.userId)) : 0,
        jobOpenings: count(data.requisitions, (r) => r.status !== 'closed' && r.status !== 'cancelled' && (r.approvals || []).some((a) => a && a.userId === me && a.decision === 'pending'))
    };
    const total = Object.values(out).reduce((s, n) => s + n, 0);
    const canApprove = wants.time || wants.leave || wants.leaveCases || wants.people || wants.pay || wants.payouts || wants.training || out.jobOpenings > 0;
    return { canApprove, scope, wants, ...out, total };
}

/** Where each kind is decided, for the home page's links */
const LINKS = {
    timesheets: 'admin-us-time.html', punchFixes: 'admin-us-time.html', leaveRequests: 'admin-us-leave.html',
    shiftSwaps: 'admin-us-schedule.html', shiftClaims: 'admin-us-schedule.html', clockProblems: 'admin-us-clock.html',
    leaveCases: 'admin-us-leave-cases.html', profileChanges: 'admin-us-changes.html', joinRequests: 'admin-us-team-import.html',
    payChanges: 'admin-us-pay.html', timeOffPayouts: 'admin-us-leave.html', training: 'admin-us-training.html', jobOpenings: 'admin-us-hiring.html'
};

module.exports = { waitingFor, LINKS };
