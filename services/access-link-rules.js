/**
 * Set-up links, company join links and password rules for US companies (pure, no I/O).
 *
 * HR copies a link or shows a QR code; set-up links are also emailed when email is set up (team-invite-emails.js).
 *   - personal set-up link: one person, one use, 7 days. The person chooses their own password with it.
 *   - company join link: anyone who has it may ASK to join. They can do nothing until HR approves them.
 *   - open join link (for a team meeting or the start of a shift): the first N people who use it are let in at once,
 *     as plain employees. It works for a few hours only, so a photo of the QR code is of little use later.
 * A link is a random 32-byte token. Only its SHA-256 hash is stored, so a copy of the database cannot be used to sign in,
 * and a link cannot be shown a second time (HR makes a new one instead).
 */
const crypto = require('crypto');
const { canonicalRole } = require('./permissions');

const SETUP_LINK_DAYS = 7;
const JOIN_LINK_MAX_DAYS = 30;
const JOIN_LINK_DEFAULT_DAYS = 7;
const MAX_ACTIVE_JOIN_LINKS = 5;
const MAX_WAITING_REQUESTS = 200;
const OPEN_LINK_MAX_HOURS = 24;
const OPEN_LINK_DEFAULT_HOURS = 2;
const OPEN_LINK_MAX_PEOPLE = 100;
const OPEN_LINK_DEFAULT_PEOPLE = 30;
const MAX_APPROVE_AT_ONCE = 50;
const DAY_MS = 86400000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes in URL-safe base64

const hashToken = (token) => crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');

/** A new link token and the hash to store. The token itself is shown once and never stored. */
function newToken() {
    const token = crypto.randomBytes(32).toString('base64url');
    return { token, hash: hashToken(token) };
}

const tokenLooksRight = (token) => typeof token === 'string' && TOKEN_SHAPE.test(token);

/** When a new link stops working. Join links: a whole number of days, 1 to 30, chosen by HR. */
function expiryFor(kind, days, now = new Date()) {
    if (kind === 'setup') return { expiresAt: new Date(now.getTime() + SETUP_LINK_DAYS * DAY_MS).toISOString(), days: SETUP_LINK_DAYS };
    const n = days === undefined || days === null || days === '' ? JOIN_LINK_DEFAULT_DAYS : Number(days);
    if (!Number.isInteger(n) || n < 1 || n > JOIN_LINK_MAX_DAYS) return { error: `Choose how long the link works: 1 to ${JOIN_LINK_MAX_DAYS} days` };
    return { expiresAt: new Date(now.getTime() + n * DAY_MS).toISOString(), days: n };
}

/** An open join link: 1 to 24 whole hours, and 1 to 100 people. Returns { expiresAt, hours, maxPeople } or { error }. */
function openLinkFor(hours, maxPeople, now = new Date()) {
    const h = hours === undefined || hours === null || hours === '' ? OPEN_LINK_DEFAULT_HOURS : Number(hours);
    if (!Number.isInteger(h) || h < 1 || h > OPEN_LINK_MAX_HOURS) return { error: `Choose how long the open link works: 1 to ${OPEN_LINK_MAX_HOURS} hours` };
    const n = maxPeople === undefined || maxPeople === null || maxPeople === '' ? OPEN_LINK_DEFAULT_PEOPLE : Number(maxPeople);
    if (!Number.isInteger(n) || n < 1 || n > OPEN_LINK_MAX_PEOPLE) return { error: `Choose how many people it lets in: 1 to ${OPEN_LINK_MAX_PEOPLE}` };
    return { expiresAt: new Date(now.getTime() + h * 3600000).toISOString(), hours: h, maxPeople: n };
}

/** A list of request ids to approve together: unique, well formed, at most 50. Returns { ids } or { error }. */
function approveIds(input) {
    if (!Array.isArray(input) || !input.length) return { error: 'Choose at least one person to approve' };
    const ids = [...new Set(input.map(String))];
    if (ids.length > MAX_APPROVE_AT_ONCE) return { error: `Approve at most ${MAX_APPROVE_AT_ONCE} people at a time` };
    if (ids.some((id) => !/^[A-Za-z0-9]{10,40}$/.test(id))) return { error: 'Request not found' };
    return { ids };
}

/** 'active' | 'used' | 'revoked' | 'expired' for a stored link */
function linkState(link, now = new Date()) {
    if (!link) return 'expired';
    if (link.revokedAt) return 'revoked';
    if (link.kind === 'setup' && link.usedAt) return 'used';
    if (!link.expiresAt || String(link.expiresAt) <= now.toISOString()) return 'expired';
    return 'active';
}

/**
 * Password rules. The same rules as validatePassword in controllers/authController.js (14 characters, upper and lower
 * case, a number, a special character, not on the short blacklist), plus two that keep both sign-in paths in step:
 * no < or > (the server escapes those in request bodies, so the stored password would differ from the typed one) and
 * at most 72 characters (the hashing used for the server sign-in ignores anything longer).
 * Returns null when the password is fine, or the reason in plain words.
 */
const PASSWORD_MIN = 14;
const PASSWORD_MAX = 72;
const PASSWORD_BLACKLIST = ['Password123!', 'Admin12345678!', 'Qwertyuiop123!'];
function passwordProblem(password, { email } = {}) {
    if (typeof password !== 'string' || password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters long`;
    if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters long`;
    if (/[<>]/.test(password)) return 'Password cannot contain the characters < or >';
    if (!/[A-Z]/.test(password)) return 'Password must contain an uppercase letter';
    if (!/[a-z]/.test(password)) return 'Password must contain a lowercase letter';
    if (!/[0-9]/.test(password)) return 'Password must contain a number';
    if (!/[!@#$%^&*(),.?":{}|]/.test(password)) return 'Password must contain a special character, like ! # $ % & * ?';
    if (PASSWORD_BLACKLIST.includes(password)) return 'That password is too common. Choose another one.';
    const local = String(email || '').split('@')[0].toLowerCase();
    if (local.length >= 4 && password.toLowerCase().includes(local)) return 'Password cannot contain your email name';
    return null;
}
const PASSWORD_RULES_TEXT = `At least ${PASSWORD_MIN} characters, with an uppercase letter, a lowercase letter, a number and a special character (like ! # $ % & * ?).`;

/** Who outranks whom when HR resets somebody's sign-in. Read-only roles sit level with a manager. */
const RANK = { super_admin: 100, hr_admin: 80, payroll_admin: 60, manager: 40, accountant: 40, auditor: 40, executive: 40, employee: 10 };
const roleRank = (role) => RANK[canonicalRole(role)] || 10;

/**
 * May this requester give this person a new temporary password or set-up link?
 * Never for someone with a higher role, never for yourself (use "change password"), never for someone who has left.
 */
function mayResetAccess(requester, target) {
    if (!requester || !target) return { ok: false, status: 404, error: 'Employee not found' };
    const targetId = target.uid || target.id;
    if (targetId && targetId === requester.id) return { ok: false, status: 409, error: 'You cannot reset your own sign-in here. Change your own password instead.' };
    if (roleRank(target.role) > roleRank(requester.role)) return { ok: false, status: 403, error: 'You cannot reset the sign-in of someone with a higher role than yours' };
    if (/^terminated$/i.test(String(target.status || ''))) return { ok: false, status: 409, error: 'This person no longer works here' };
    return { ok: true };
}

/** Where a person is with signing in, for the list HR sees */
function accessStatus(user) {
    if (!user) return 'unknown';
    if (/^terminated$/i.test(String(user.status || ''))) return 'ended';
    if (user.setup_pending === true) return 'waiting_for_setup';
    if (user.must_change_password === true) return 'temporary_password';
    return 'active';
}

const EMAIL = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;
const tidy = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** What a person types on the join page (the password is checked separately) */
function validateJoinRequest(input) {
    const b = input || {}; const errors = [];
    const value = { firstName: tidy(b.firstName, 80), lastName: tidy(b.lastName, 80), email: tidy(b.email, 200).toLowerCase(), phone: tidy(b.phone, 30) };
    if (!value.firstName) errors.push('First name is required');
    if (!value.lastName) errors.push('Last name is required');
    if (!EMAIL.test(value.email)) errors.push('Enter a valid email address');
    if (value.phone && value.phone.replace(/\D/g, '').length < 10) errors.push('Enter a phone number with 10 digits, or leave it empty');
    return { errors, value };
}

/**
 * Requests that a person with must_change_password may still make. Everything else answers 403 until they choose a
 * new password. Kept here (pure) so the rule can be tested without a server.
 */
const PASSWORD_CHANGE_PATHS = ['/api/auth/change-password', '/api/auth/password-status', '/api/us/me']; // "who am I" tells a client app that the password must be changed
function pathAllowedBeforePasswordChange(originalUrl) {
    const p = String(originalUrl || '').split('?')[0].replace(/\/+$/, '').toLowerCase();
    return PASSWORD_CHANGE_PATHS.includes(p);
}

/**
 * Must this request be refused because the person still has a temporary password?
 * Only password sign-ins are held back: someone who came in through Google or company single sign-on never types the
 * temporary password, so it cannot leak through them.
 */
function mustChangeBlocks(user, decodedToken, originalUrl) {
    if (!user || user.must_change_password !== true) return false;
    const provider = decodedToken && decodedToken.firebase && decodedToken.firebase.sign_in_provider;
    if (provider && provider !== 'password') return false;
    return !pathAllowedBeforePasswordChange(originalUrl);
}

module.exports = {
    OPEN_LINK_MAX_HOURS, OPEN_LINK_DEFAULT_HOURS, OPEN_LINK_MAX_PEOPLE, OPEN_LINK_DEFAULT_PEOPLE, MAX_APPROVE_AT_ONCE, openLinkFor, approveIds,
    SETUP_LINK_DAYS, JOIN_LINK_MAX_DAYS, JOIN_LINK_DEFAULT_DAYS, MAX_ACTIVE_JOIN_LINKS, MAX_WAITING_REQUESTS, PASSWORD_MIN, PASSWORD_MAX, PASSWORD_RULES_TEXT, PASSWORD_CHANGE_PATHS,
    hashToken, newToken, tokenLooksRight, expiryFor, linkState, passwordProblem, roleRank, mayResetAccess, accessStatus, validateJoinRequest,
    pathAllowedBeforePasswordChange, mustChangeBlocks
};
