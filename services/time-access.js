/**
 * Who may use the time-clock routes (pure). One place, so the routes and the tests agree.
 *
 * United States companies follow services/permissions.js:
 *   time.view_all      see everyone's hours and who is working (owner, HR, payroll admin, auditor)
 *   time.approve       approve hours, add a missed punch, reopen a week (owner, HR, payroll admin)
 *   time.approve_team  managers: the same for their own direct reports only (see permissions.canManage)
 *   time.kiosk         shared tablets and kiosk PINs (owner, HR)
 * Companies outside the United States keep the role lists the older pages were built on, unchanged:
 *   admin and HR roles everything; "Manager" sees who is working now across the company and nothing else.
 */
const P = require('./permissions');

const norm = (r) => String(r || '').toLowerCase().replace(/[\s_-]+/g, '');
const LEGACY_ADMIN_HR = ['admin', 'superadmin', 'hrms', 'hradmin', 'hrpayroll'];
const LEGACY_MANAGER = [...LEGACY_ADMIN_HR, 'manager'];

/**
 * What this user may do on the time routes. `country` is the company's country code ('US', 'IN', ...).
 * Scopes are 'all' (everyone in the company), 'team' (direct reports only) or 'none'.
 */
function timeAccess(user, country) {
    const role = norm(user && user.role);
    if (country !== 'US') {
        const adminHr = LEGACY_ADMIN_HR.includes(role);
        return {
            legacy: true,
            teamNow: LEGACY_MANAGER.includes(role) ? 'all' : 'none',
            timesheets: adminHr ? 'all' : 'none',
            addPunch: adminHr ? 'all' : 'none',
            kioskManage: adminHr,
            kioskView: adminHr
        };
    }
    const everyone = P.can(user, 'time.view_all') || P.can(user, 'time.approve');
    const team = P.can(user, 'time.approve_team');
    return {
        legacy: false,
        teamNow: everyone ? 'all' : team ? 'team' : 'none',
        timesheets: everyone ? 'all' : team ? 'team' : 'none',
        addPunch: P.can(user, 'time.approve') ? 'all' : 'none',
        kioskManage: P.can(user, 'time.kiosk'),
        kioskView: P.can(user, 'time.kiosk') || P.can(user, 'time.view_all')
    };
}

/** May this user see or act on this one person, given a scope from timeAccess()? `person` is the stored user data with its id. */
function allowedFor(user, scope, person) {
    if (scope === 'all') return true;
    if (scope === 'team') return P.canManage(user, person, 'time');
    return false;
}

module.exports = { LEGACY_ADMIN_HR, LEGACY_MANAGER, timeAccess, allowedFor };
