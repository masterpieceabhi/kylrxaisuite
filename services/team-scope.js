/**
 * Who a signed-in person may act on. Company-wide roles see everyone; managers see only their
 * direct reports (usProfile.managerId); everyone else only themselves.
 */
const { rawCollection } = require('../config/firebase');
const P = require('./permissions');

/** All people of a company as a Map(id -> person data with id) */
async function loadOrgPeople(orgId) {
    const snap = await rawCollection('users').where('orgId', '==', orgId).get();
    return new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
}

/** Keeps the rows whose person this user may manage for `scope` ('time' or 'leave') */
async function filterRows(user, orgId, rows, scope, userIdOf = (r) => r.userId) {
    const companyWide = scope === 'leave' ? P.can(user, 'leave.decide') || P.can(user, 'leave.view_all') : P.can(user, 'time.approve') || P.can(user, 'time.view_all');
    if (companyWide) return rows;
    const people = await loadOrgPeople(orgId);
    return rows.filter((r) => P.canManage(user, people.get(userIdOf(r)), scope));
}

module.exports = { loadOrgPeople, filterRows };
