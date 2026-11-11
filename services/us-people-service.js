/**
 * Creates US employees (one at a time or from a file). Each person gets a login with a random
 * temporary password (shown once to the administrator, never stored in readable form), a
 * sequential employee ID, and optionally a full US profile.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { admin, db, rawCollection } = require('../config/firebase');
const { encryptField } = require('./pii-crypto');
const v = require('./us-validation');
const forms = require('./us-forms');
const checklists = require('./us-checklist-service');

const ALLOWED_ROLES = ['employee', 'manager', 'hr_admin'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function temporaryPassword() {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '#$%&*+?'];
    const pick = (s) => s[crypto.randomInt(s.length)];
    const chars = [pick(sets[0]), pick(sets[1]), pick(sets[2]), pick(sets[3])];
    const all = sets.join('');
    while (chars.length < 14) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

/** Next sequential employee ID for the organization (EMP0001, EMP0002, ...) */
async function allocateEmployeeIds(orgId, count) {
    const ref = rawCollection('organizations').doc(orgId).collection('counters').doc('employees');
    return admin.firestore().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() : {};
        const prefix = data.prefix || 'EMP';
        const padLength = Number(data.padLength || 4);
        const start = Number(data.currentSequence || 0);
        const ids = [];
        for (let i = 1; i <= count; i++) ids.push(`${prefix}${String(start + i).padStart(padLength, '0')}`);
        tx.set(ref, {
            currentSequence: start + count, prefix, padLength,
            nextIdPreview: `${prefix}${String(start + count + 1).padStart(padLength, '0')}`,
            updatedAt: new Date().toISOString()
        }, { merge: true });
        return ids;
    });
}

/** Validates the basic person fields; profile fields are validated only when supplied */
function validatePerson(input) {
    const errors = [];
    const b = input || {};
    const value = {
        firstName: String(b.firstName || '').trim(),
        lastName: String(b.lastName || '').trim(),
        email: String(b.email || '').trim().toLowerCase(),
        phone: String(b.phone || '').trim(),
        role: String(b.role || 'employee').trim().toLowerCase(),
        startDate: String(b.startDate || '').trim(),
        jobTitle: String(b.jobTitle || '').trim(),
        department: String(b.department || '').trim()
    };
    if (!value.firstName) errors.push('firstName is required');
    if (!value.lastName) errors.push('lastName is required');
    if (!EMAIL.test(value.email)) errors.push('email is not valid');
    if (!ALLOWED_ROLES.includes(value.role)) errors.push(`role must be one of: ${ALLOWED_ROLES.join(', ')}`);
    if (!forms.parseIsoDate(value.startDate)) errors.push('startDate must be a real date (YYYY-MM-DD)');

    let profile = null;
    let taxpayerId = null;
    if (b.profile && Object.keys(b.profile).length) {
        const p = { legalFirstName: value.firstName, legalLastName: value.lastName, ...b.profile };
        const r = v.validateEmployeeProfile(p);
        errors.push(...r.errors);
        profile = r.value;
        if (b.profile.taxpayerId) {
            const t = v.validateTaxpayerId(b.profile.taxpayerId, b.profile.taxpayerIdType);
            if (!t.valid) errors.push(t.error); else taxpayerId = t;
        }
    }
    return { errors, value, profile, taxpayerId };
}

async function emailTaken(email) {
    const q = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!q.empty) return true;
    try {
        await admin.auth().getUserByEmail(email);
        return true;
    } catch (_) {
        return false;
    }
}

/** Creates the login, the person record and the optional profile. Throws on failure. */
async function createPerson(orgId, validated, employeeId, actorId) {
    const { value, profile, taxpayerId } = validated;
    const password = temporaryPassword();
    const name = `${value.firstName} ${value.lastName}`;
    const userRecord = await admin.auth().createUser({
        email: value.email, password, displayName: name, emailVerified: false, disabled: false
    });
    try {
        await admin.auth().setCustomUserClaims(userRecord.uid, { role: value.role, orgId });
        const record = {
            uid: userRecord.uid, id: userRecord.uid, orgId, employeeId, name, email: value.email,
            phone: value.phone, role: value.role, status: 'Active', jobTitle: value.jobTitle,
            departmentName: value.department, joiningDate: value.startDate,
            password: await bcrypt.hash(password, 10),
            must_change_password: true, is_temporary_password: true, invite_status: 'pending',
            createdAt: new Date().toISOString(), createdBy: actorId || null
        };
        if (profile) {
            record.usProfile = {
                ...profile,
                startDate: value.startDate,
                taxpayerIdEncrypted: taxpayerId ? encryptField(taxpayerId.digits, `${orgId}:${userRecord.uid}`) : null,
                taxpayerIdLast4: taxpayerId ? taxpayerId.last4 : null,
                updatedAt: new Date().toISOString(), updatedBy: actorId || null
            };
        }
        await db.collection('users').doc(userRecord.uid).set(record);
        // Start the new-hire checklist (best effort: HR can still add it later)
        try {
            await checklists.createChecklist(orgId, { id: userRecord.uid, data: record }, 'onboarding', value.startDate);
        } catch (_) {}
    } catch (error) {
        await admin.auth().deleteUser(userRecord.uid).catch(() => {});
        throw error;
    }
    return { uid: userRecord.uid, employeeId, name, email: value.email, role: value.role, temporaryPassword: password };
}

module.exports = { ALLOWED_ROLES, temporaryPassword, allocateEmployeeIds, validatePerson, emailTaken, createPerson };
