/**
 * Deciding your own request.
 *
 * The rule, the same everywhere: nobody approves, corrects or changes their own hours, time off, shifts, training or
 * clock problems. A second person does. The one exception is a company where there is no second person who could:
 * a sole owner with no manager and nobody else holding the permission. Without that exception the owner's own week
 * could never be approved at all, and with it the decision is still written to the audit log marked as their own.
 *
 * "Someone else could" means: another person who is still working here and either holds the company-wide
 * permission, or is this person's own manager.
 */
const { can } = require('./permissions');

const working = (p) => !/^(terminated|inactive|offboarded|suspended|locked)$/i.test(String((p && p.status) || 'active'));

/**
 * people: every person of the company, as { id, role, status, managerId } (managerId: the id of the person they report to)
 * Returns true when somebody other than `userId` could decide a request of `userId` that needs `permission`.
 */
function someoneElseCould(people, userId, permission) {
    const list = Array.isArray(people) ? people : [];
    const me = list.find((p) => p.id === userId) || null;
    const others = list.filter((p) => p && p.id !== userId && working(p));
    if (others.some((p) => can({ role: p.role }, permission))) return true;
    const managerId = me && me.managerId;
    return Boolean(managerId && others.some((p) => p.id === managerId));
}

/**
 * For a route: is this the signed-in person's own request, and if so may they go on?
 *   { own: false }                          someone else's request: nothing to add
 *   { own: true, allowed: false, error }    refuse with 403 and this text
 *   { own: true, allowed: true }            the only person who could decide: go on, and audit it as their own
 * loadPeople(orgId) is only called when the request is the person's own.
 */
async function check({ orgId, user, targetUserId, permission, what, loadPeople }) {
    const myId = user && (user.id || user.uid);
    if (!myId || !targetUserId || String(targetUserId) !== String(myId)) return { own: false };
    const people = await (loadPeople || defaultLoad)(orgId);
    if (someoneElseCould(people, myId, permission)) return { own: true, allowed: false, error: `You cannot ${what || 'decide your own request'}. Ask another person who can.` };
    return { own: true, allowed: true };
}

async function defaultLoad(orgId) {
    const rows = await require('./people-data-store').listByOrg('users', orgId);
    return rows.map((p) => ({ id: p.id, role: p.role || null, status: p.status || 'active', managerId: (p.usProfile && p.usProfile.managerId) || p.reportingManagerId || null }));
}

/**
 * The same for an Express route. Answers 403 itself when the person may not; resolves:
 *   null    refused, the response is already sent: stop
 *   {}      not their own request
 *   { selfDecision: true }   their own, allowed because nobody else could: spread this into the audit entry
 */
async function guard(req, res, targetUserId, permission, what) {
    const r = await check({ orgId: req.orgId, user: req.user, targetUserId, permission, what });
    if (!r.own) return {};
    if (!r.allowed) { res.status(403).json({ success: false, code: 'own_request', error: r.error }); return null; }
    return { selfDecision: true };
}

module.exports = { someoneElseCould, check, guard };
