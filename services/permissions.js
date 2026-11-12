/**
 * Roles and permissions for the whole app (pure). One place decides who may do what.
 *
 * Canonical roles:
 *   super_admin    owner: everything, including billing, integrations and security settings
 *   hr_admin       people, hiring, leave, compliance, reports (no billing or integrations)
 *   payroll_admin  time approval, hours export, payroll provider, payroll reports (no HR records or SSNs)
 *   manager        their own direct reports only (scoped: see canManage)
 *   employee       their own information
 *   accountant     read-only finance: payroll, labor cost, hours export, reports
 *   auditor        read-only everything except confidential files and full taxpayer IDs
 *   executive      read-only company reports
 * Older role names used by the existing app are mapped onto these.
 */

const ALIASES = {
    superadmin: 'super_admin', admin: 'hr_admin', hradmin: 'hr_admin', hrms: 'hr_admin', hrpayroll: 'hr_admin',
    payrolladmin: 'payroll_admin', manager: 'manager', employee: 'employee', accountant: 'accountant', auditor: 'auditor',
    executive: 'executive', clientexecutive: 'executive'
};

const norm = (r) => String(r || '').toLowerCase().replace(/[\s_-]+/g, '');

/** Maps any spelling of a role to its canonical key; unknown roles are plain employees */
function canonicalRole(role) {
    return ALIASES[norm(role)] || 'employee';
}

const SA = 'super_admin'; const HR = 'hr_admin'; const PAY = 'payroll_admin'; const MGR = 'manager';
const ACC = 'accountant'; const AUD = 'auditor'; const EXE = 'executive'; const EMP = 'employee';

/** permission key -> canonical roles that hold it. "Scoped" ones for managers are checked with canManage too. */
const PERMISSIONS = {
    // people
    'people.read': [SA, HR, AUD],
    'people.write': [SA, HR],
    'people.read_team': [MGR],
    'people.read_pay': [SA, HR, PAY, ACC, AUD],
    'pii.reveal': [SA, HR],
    'org.settings': [SA, HR],
    // hiring and onboarding
    'hiring.manage': [SA, HR],
    'hiring.view': [SA, HR, MGR, AUD],
    'background.manage': [SA, HR],
    'onboarding.manage': [SA, HR],
    // time and leave
    'time.approve': [SA, HR, PAY],
    'time.approve_team': [MGR],
    'time.manage_rules': [SA, HR, PAY],
    'time.export': [SA, HR, PAY, ACC],
    'time.view_all': [SA, HR, PAY, AUD],
    'time.kiosk': [SA, HR],
    'leave.decide': [SA, HR],
    'leave.decide_team': [MGR],
    'leave.policies': [SA, HR],
    'leave.view_all': [SA, HR, AUD],
    // benefits and compliance
    'benefits.manage': [SA, HR],
    'benefits.view': [SA, HR, AUD],
    'compliance.manage': [SA, HR],
    'compliance.view': [SA, HR, AUD],
    'eeo.report': [SA, HR],
    'vault.manage': [SA, HR],
    'vault.confidential': [SA, HR],
    'safety.manage': [SA, HR],
    // payroll provider and finance
    'payroll.view': [SA, PAY, ACC, AUD, HR],
    'payroll.run': [SA, PAY],
    'payroll.connect': [SA],
    // reports, audit, settings
    'reports.view': [SA, HR, PAY, ACC, AUD, EXE],
    'audit.view': [SA, AUD, HR],
    'integrations.manage': [SA],
    'integrations.view': [SA, HR, PAY, AUD],
    'billing.manage': [SA],
    'security.manage': [SA],
    'support.impersonate': [SA],
    'privacy.manage': [SA, HR]
};

const KNOWN_PERMISSIONS = Object.keys(PERMISSIONS);

/** Does this user's role hold the permission? (Manager permissions still need canManage for the person.) */
function can(user, permission) {
    const roles = PERMISSIONS[permission];
    if (!roles) return false;
    const role = canonicalRole(user && user.role);
    return role === SA || roles.includes(role); // the owner holds every permission
}

/** Every permission a role holds */
function permissionsFor(role) {
    const r = canonicalRole(role);
    return KNOWN_PERMISSIONS.filter((p) => r === SA || PERMISSIONS[p].includes(r));
}

/** Roles that see everyone in the company for time and leave decisions */
const isCompanyWide = (user) => can(user, 'time.approve') || can(user, 'leave.decide');

/**
 * May this user act on this person's records (approve hours, decide leave, see their team data)?
 * Company-wide roles: any person. Managers: only their direct reports, never themselves.
 * `target` is a stored person document (the data object).
 */
function canManage(user, target, scope = 'time') {
    if (!user || !target) return false;
    const companyWide = scope === 'leave' ? can(user, 'leave.decide') : can(user, 'time.approve');
    if (companyWide) return true;
    if (canonicalRole(user.role) !== 'manager') return false;
    const managerId = (target.usProfile && target.usProfile.managerId) || target.managerId || target.reportingManagerId || null;
    if (!managerId || managerId !== user.id) return false;
    return target.id !== user.id && target.uid !== user.id;
}

/** Express middleware: 403 unless the role holds the permission */
function requirePermission(permission) {
    if (!PERMISSIONS[permission]) throw new Error(`Unknown permission: ${permission}`);
    return (req, res, next) => {
        if (can(req.user, permission)) return next();
        return res.status(403).json({ success: false, error: 'You do not have permission to do this', permission });
    };
}

/** Express middleware: 403 unless the role holds at least one of the permissions */
function requireAnyPermission(...permissions) {
    permissions.forEach((p) => { if (!PERMISSIONS[p]) throw new Error(`Unknown permission: ${p}`); });
    return (req, res, next) => {
        if (permissions.some((p) => can(req.user, p))) return next();
        return res.status(403).json({ success: false, error: 'You do not have permission to do this' });
    };
}

const ROLE_LABELS = {
    super_admin: 'Owner / Super admin', hr_admin: 'HR admin', payroll_admin: 'Payroll admin', manager: 'Manager', employee: 'Employee',
    accountant: 'Accountant (read-only)', auditor: 'Auditor (read-only)', executive: 'Executive (reports only)'
};

module.exports = { PERMISSIONS, KNOWN_PERMISSIONS, ROLE_LABELS, canonicalRole, can, permissionsFor, canManage, isCompanyWide, requirePermission, requireAnyPermission };
