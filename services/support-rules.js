/**
 * Support access (pure rules): the state of a customer's grant and who may see grants across companies.
 * A grant is what a company owner gives support staff: read-only, for a limited time, with a reason.
 */
const STATES = ['active', 'expired', 'revoked'];

/** active | expired | revoked. Revoked wins over expired, so the history shows who ended it. */
function grantState(grant, nowIso) {
    if (!grant) return 'expired';
    if (grant.revokedAt) return 'revoked';
    return String(grant.expiresAt || '') > String(nowIso) ? 'active' : 'expired';
}

/** Whole minutes left on an active grant (0 otherwise) */
function minutesLeft(grant, nowIso) {
    if (grantState(grant, nowIso) !== 'active') return 0;
    return Math.max(0, Math.floor((new Date(grant.expiresAt).getTime() - new Date(nowIso).getTime()) / 60000));
}

const emailList = (raw) => String(raw || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/**
 * Who may list grants from every company (the support-staff screen):
 *   - a signed-in person whose e-mail is in PLATFORM_SUPPORT_EMAILS, or
 *   - a super admin of the platform's own company, but only when PLATFORM_ORG_ID is set.
 * A customer's own super admin is never enough, and with neither setting in place the list is closed to everyone.
 */
function canListAllGrants(user, env = {}) {
    if (!user) return false;
    const email = String(user.email || '').toLowerCase();
    if (email && emailList(env.PLATFORM_SUPPORT_EMAILS).includes(email)) return true;
    const role = String(user.role || '').toLowerCase().replace(/[\s_-]+/g, '');
    return Boolean(env.PLATFORM_ORG_ID) && role === 'superadmin' && user.orgId === env.PLATFORM_ORG_ID;
}

/** Only an address in PLATFORM_SUPPORT_EMAILS can start a read-only session (this is what the session route checks) */
const canStartSession = (user, env = {}) => Boolean(user && user.email && emailList(env.PLATFORM_SUPPORT_EMAILS).includes(String(user.email).toLowerCase()));

/** Row for the support-staff screen */
function publicGrant(id, g, nowIso, companyName) {
    return {
        id, company_id: g.orgId, company_name: companyName || null, reason: g.reason || '', mode: g.mode || 'read_only', granted_by: g.grantedByEmail || g.grantedBy || null,
        created_at: g.createdAt || null, expires_at: g.expiresAt || null, revoked_at: g.revokedAt || null,
        state: grantState(g, nowIso), minutes_left: minutesLeft(g, nowIso)
    };
}

/** Active first (soonest to end on top), then the rest newest first */
function sortGrants(rows) {
    return [...rows].sort((a, b) => {
        if ((a.state === 'active') !== (b.state === 'active')) return a.state === 'active' ? -1 : 1;
        if (a.state === 'active') return String(a.expires_at).localeCompare(String(b.expires_at));
        return String(b.created_at).localeCompare(String(a.created_at));
    });
}

const countByState = (rows) => Object.fromEntries(STATES.map((s) => [s, rows.filter((r) => r.state === s).length]));

module.exports = { STATES, grantState, minutesLeft, emailList, canListAllGrants, canStartSession, publicGrant, sortGrants, countByState };
