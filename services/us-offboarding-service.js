/**
 * Offboarding rules (pure) and the actions that cut a person's access and record the exit.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { admin, rawCollection } = require('../config/firebase');
const { parseIsoDate } = require('./us-forms');

const TERMINATION_TYPES = ['resignation', 'termination_for_cause', 'layoff', 'end_of_contract', 'retirement', 'other'];

function validateTermination(input, startDateIso, todayIso) {
    const errors = [];
    const b = input || {};
    const value = {};
    const last = parseIsoDate(b.lastDay) ? b.lastDay : null;
    if (!last) errors.push('lastDay must be a real date (YYYY-MM-DD)');
    else {
        if (startDateIso && last < startDateIso) errors.push('lastDay cannot be before the start date');
        const limit = new Date(`${todayIso}T00:00:00Z`); limit.setUTCFullYear(limit.getUTCFullYear() + 1);
        if (new Date(`${last}T00:00:00Z`) > limit) errors.push('lastDay is more than a year away');
        value.lastDay = last;
    }
    if (!TERMINATION_TYPES.includes(b.type)) errors.push(`type must be one of: ${TERMINATION_TYPES.join(', ')}`);
    else value.type = b.type;
    const reason = String(b.reason || '').trim();
    if (reason.length < 3) errors.push('reason is required');
    else value.reason = reason.slice(0, 300);
    value.rehireEligible = b.rehireEligible !== false;
    if (b.notes) value.notes = String(b.notes).slice(0, 500);
    return { errors, value };
}

/** Whether a rehire can reuse the old I-9 (Section 3) or needs a new one: 3 years from the original I-9 */
function i9RehireAction(i9, rehireIso) {
    const signed = i9 && i9.section1 && i9.section1.signedAt ? String(i9.section1.signedAt).slice(0, 10) : null;
    if (!signed) return { action: 'new_i9', reason: 'No earlier I-9 on file' };
    const d = new Date(`${signed}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + 3);
    return d.toISOString().slice(0, 10) >= rehireIso
        ? { action: 'update_section_3', reason: `The earlier I-9 is less than 3 years old (signed ${signed})` }
        : { action: 'new_i9', reason: `The earlier I-9 is more than 3 years old (signed ${signed})` };
}

/** Switches off the person's login, kiosk PIN and punching. Idempotent. */
async function cutAccess(emp) {
    try {
        await admin.auth().updateUser(emp.id, { disabled: true });
        await admin.auth().revokeRefreshTokens(emp.id);
    } catch (_) { /* no login to disable */ }
    await emp.ref.set({ status: 'Terminated', terminationStatus: 'effective', pinHash: null, pinLockedUntil: null, usProfile: { termination: { effectiveAt: new Date().toISOString() } } }, { merge: true });
}

/** Re-enables a login for a rehire and returns a new temporary password (shown once) */
async function restoreAccess(emp) {
    const password = temporaryPassword();
    try {
        await admin.auth().updateUser(emp.id, { disabled: false, password });
    } catch (_) { /* no login existed */ }
    return { password, hash: await bcrypt.hash(password, 10) };
}

function temporaryPassword() {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '#$%&*+?'];
    const pick = (s) => s[crypto.randomInt(s.length)];
    const chars = [pick(sets[0]), pick(sets[1]), pick(sets[2]), pick(sets[3])];
    while (chars.length < 14) chars.push(pick(sets.join('')));
    for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    return chars.join('');
}

/** Cancels approved or pending leave that starts after the last day */
async function cancelLeaveAfter(orgId, userId, lastDay) {
    const snap = await rawCollection('leave_requests').where('userId', '==', userId).get();
    let n = 0;
    for (const d of snap.docs) {
        const r = d.data();
        if (r.orgId === orgId && ['pending', 'approved'].includes(r.status) && r.startDate > lastDay) {
            await d.ref.update({ status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: 'Employment ended' });
            n += 1;
        }
    }
    return n;
}

module.exports = { TERMINATION_TYPES, validateTermination, i9RehireAction, cutAccess, restoreAccess, cancelLeaveAfter };
