/**
 * What is waiting for a person's decision (pure): hours sent for approval, punch fixes and time-off requests.
 * Company-wide roles count everyone; managers count only their direct reports; nobody counts their own.
 * A role that can look but not decide (auditor, accountant, executive) has nothing waiting.
 */
const P = require('./permissions');

/**
 * user:  the signed-in person ({ id, role })
 * data:  { weeks: timesheet_weeks docs, corrections: punch_corrections docs, leave: leave_requests docs,
 *          people: Map(userId -> stored person data with id) }
 * Returns { canApprove, scope: { time, leave }, timesheets, punchFixes, leaveRequests, total }.
 */
function waitingFor(user, data = {}) {
    const people = data.people || new Map();
    const scopeOf = (wide, team) => (P.can(user, wide) ? 'all' : P.can(user, team) ? 'team' : 'none');
    const scope = { time: scopeOf('time.approve', 'time.approve_team'), leave: scopeOf('leave.decide', 'leave.decide_team') };
    const mine = (row) => Boolean(user) && row.userId === user.id;
    const inScope = (row, kind) => {
        if (scope[kind] === 'none' || mine(row)) return false;
        if (scope[kind] === 'all') return true;
        return P.canManage(user, people.get(row.userId), kind);
    };
    const timesheets = (data.weeks || []).filter((w) => w.status === 'submitted' && inScope(w, 'time')).length;
    const punchFixes = (data.corrections || []).filter((c) => c.status === 'pending' && inScope(c, 'time')).length;
    const leaveRequests = (data.leave || []).filter((r) => r.status === 'pending' && inScope(r, 'leave')).length;
    return { canApprove: scope.time !== 'none' || scope.leave !== 'none', scope, timesheets, punchFixes, leaveRequests, total: timesheets + punchFixes + leaveRequests };
}

module.exports = { waitingFor };
