/**
 * People read/write used by the public API v1 and the SCIM server (both act "as the integration",
 * not as a logged-in user). Basic fields only: never SSN, bank, tax forms or pay data.
 * Every query filters by orgId; callers pass the org of the authenticated key/token.
 */
const crypto = require('crypto');
const { admin, rawCollection } = require('../config/firebase');
const C = require('./canonical');
const events = require('./events');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const MAX_PEOPLE = 5000;

/** All people of the company (users first, then roster `employees` records that have no login) */
async function loadPeople(orgId, max = MAX_PEOPLE) {
    const [u, e] = await Promise.all([
        rawCollection('users').where('orgId', '==', orgId).limit(max).get(),
        rawCollection('employees').where('orgId', '==', orgId).limit(max).get().catch(() => ({ docs: [] }))
    ]);
    const out = new Map();
    for (const d of u.docs) out.set(d.id, { id: d.id, ...d.data(), _col: 'users' });
    for (const d of e.docs) if (!out.has(d.id)) out.set(d.id, { id: d.id, ...d.data(), _col: 'employees' });
    return [...out.values()];
}

/** Finds one person by document id or employee number */
async function getPersonDoc(orgId, id) {
    const key = String(id || '');
    if (!key) return null;
    for (const col of ['users', 'employees']) {
        const snap = await rawCollection(col).doc(key).get();
        if (exists(snap) && snap.data().orgId === orgId) return { id: snap.id, ref: snap.ref, data: snap.data(), col };
    }
    for (const col of ['users', 'employees']) {
        const q = await rawCollection(col).where('employeeId', '==', key).limit(5).get();
        const hit = q.docs.find((d) => d.data().orgId === orgId);
        if (hit) return { id: hit.id, ref: hit.ref, data: hit.data(), col };
    }
    return null;
}

async function findByEmail(orgId, email) {
    const q = await rawCollection('users').where('email', '==', String(email).toLowerCase()).limit(5).get();
    const hit = q.docs.find((d) => d.data().orgId === orgId);
    return hit ? { id: hit.id, ref: hit.ref, data: hit.data(), col: 'users' } : null;
}

/** Walks up the manager chain: would making `managerId` the manager of `personId` create a loop? */
async function managerCreatesCycle(orgId, personId, managerId) {
    let cur = managerId; const seen = new Set();
    for (let i = 0; i < 60 && cur; i++) {
        if (cur === personId) return true;
        if (seen.has(cur)) return true;
        seen.add(cur);
        const m = await getPersonDoc(orgId, cur);
        cur = m ? (m.data.usProfile && m.data.usProfile.managerId) || m.data.managerId || null : null;
    }
    return false;
}

async function validateManager(orgId, personId, managerId) {
    if (managerId === null || managerId === undefined || managerId === '') return null;
    const m = await getPersonDoc(orgId, managerId);
    if (!m) return 'job.manager_id does not match a person in this company';
    if (personId && (m.id === personId)) return 'a person cannot be their own manager';
    if (personId && await managerCreatesCycle(orgId, personId, m.id)) return 'that manager assignment would create a reporting loop';
    return null;
}

/** Create from canonical input. Returns { person } | { errors } | { conflict } */
async function createPersonBasic(orgId, input, actor, source) {
    const svc = require('./us-people-service');
    const { errors: patchErrors, patch } = C.personPatchFromCanonical(input);
    const errors = [...patchErrors];
    for (const f of ['first_name', 'last_name', 'work_email', 'hire_date']) if (!input || input[f] === undefined || input[f] === '') errors.push(`${f} is required`);
    if (errors.length) return { errors: [...new Set(errors)] };
    const validated = svc.validatePerson({ firstName: patch.firstName, lastName: patch.lastName, email: patch.email, phone: patch.phone, role: 'employee', startDate: patch.startDate, jobTitle: patch.jobTitle, department: patch.departmentName });
    if (validated.errors.length) return { errors: validated.errors };
    if (await svc.emailTaken(validated.value.email)) return { conflict: 'A person with that work_email already exists' };
    const mgrErr = await validateManager(orgId, null, patch.managerId);
    if (mgrErr) return { errors: [mgrErr] };
    const [employeeId] = await svc.allocateEmployeeIds(orgId, 1);
    const created = await svc.createPerson(orgId, validated, employeeId, `integration:${actor || source}`); // the temporary password is discarded on purpose
    const now = new Date().toISOString();
    const extra = { updatedAt: now, createdVia: source };
    if (patch.preferredName || patch.managerId) extra.usProfile = { ...(patch.preferredName ? { preferredName: patch.preferredName } : {}), ...(patch.managerId ? { managerId: patch.managerId } : {}), startDate: patch.startDate, updatedAt: now };
    await rawCollection('users').doc(created.uid).set(extra, { merge: true });
    const snap = await rawCollection('users').doc(created.uid).get();
    const doc = { id: snap.id, ...snap.data() };
    events.emit(orgId, 'person.created', { person_id: doc.id, employee_number: doc.employeeId, display_name: doc.name, work_email: doc.email, hire_date: C.dateOnly(patch.startDate), job_title: doc.jobTitle || null, source });
    return { person: doc };
}

/** Apply a canonical patch to a `users` record. Returns { person, changed } | { errors } | { conflict } | { readOnly } */
async function updatePersonBasic(orgId, found, input, actor, source) {
    if (found.col !== 'users') return { readOnly: true };
    const { errors, patch } = C.personPatchFromCanonical(input);
    if (errors.length) return { errors };
    const cur = found.data; const p = cur.usProfile || {};
    const upd = { updatedAt: new Date().toISOString(), updatedVia: source };
    const prof = {}; const changed = [];
    const nm = C.splitName(cur.name);
    if (patch.firstName !== undefined || patch.lastName !== undefined) {
        const first = patch.firstName !== undefined ? patch.firstName : (p.legalFirstName || nm.first || '');
        const last = patch.lastName !== undefined ? patch.lastName : (p.legalLastName || nm.last || '');
        upd.name = `${first} ${last}`.trim();
        if (p.legalFirstName !== undefined || p.legalLastName !== undefined) { prof.legalFirstName = first; prof.legalLastName = last; }
        changed.push(...[patch.firstName !== undefined && 'first_name', patch.lastName !== undefined && 'last_name'].filter(Boolean));
    }
    if (patch.preferredName !== undefined) { prof.preferredName = patch.preferredName; changed.push('preferred_name'); }
    if (patch.phone !== undefined) { upd.phone = patch.phone; changed.push('phone'); }
    if (patch.jobTitle !== undefined) { upd.jobTitle = patch.jobTitle; changed.push('job.title'); }
    if (patch.departmentName !== undefined) { upd.departmentName = patch.departmentName; changed.push('job.org_unit_name'); }
    if (patch.startDate !== undefined) { upd.joiningDate = patch.startDate; prof.startDate = patch.startDate; changed.push('hire_date'); }
    if (patch.managerId !== undefined) {
        const e = await validateManager(orgId, found.id, patch.managerId);
        if (e) return { errors: [e] };
        prof.managerId = patch.managerId; changed.push('job.manager_id');
    }
    if (patch.email !== undefined && patch.email !== cur.email) {
        const svc = require('./us-people-service');
        if (await svc.emailTaken(patch.email)) return { conflict: 'A person with that work_email already exists' };
        upd.email = patch.email; changed.push('work_email');
        try { await admin.auth().updateUser(found.id, { email: patch.email }); } catch (_) { /* record without a login */ }
    }
    let statusChange = null;
    if (patch.status !== undefined) {
        const now = C.personStatus(cur.status);
        if (patch.status !== now) {
            statusChange = patch.status;
            upd.status = patch.status === 'terminated' ? 'Terminated' : patch.status === 'inactive' ? 'Inactive' : 'Active';
            changed.push('status');
            if (patch.status === 'terminated') { upd.terminationDate = patch.terminationDate || new Date().toISOString().slice(0, 10); upd.terminatedAt = new Date().toISOString(); }
            if (patch.status === 'active') { upd.terminationDate = null; upd.terminatedAt = null; }
        }
    }
    if (patch.terminationDate !== undefined && statusChange === null) { upd.terminationDate = patch.terminationDate; changed.push('termination_date'); }
    if (Object.keys(prof).length) { prof.updatedAt = upd.updatedAt; upd.usProfile = prof; }
    await found.ref.set(upd, { merge: true });
    if (statusChange) { try { await admin.auth().updateUser(found.id, { disabled: statusChange !== 'active' }); } catch (_) { /* no login */ } }
    const snap = await found.ref.get();
    const doc = { id: snap.id, ...snap.data() };
    if (changed.length) events.emit(orgId, 'person.updated', { person_id: doc.id, changed_fields: [...new Set(changed)], source });
    if (statusChange === 'terminated') events.emit(orgId, 'person.terminated', { person_id: doc.id, termination_date: C.dateOnly(doc.terminationDate), source });
    if (statusChange === 'active') events.emit(orgId, 'person.reactivated', { person_id: doc.id, source });
    return { person: doc, changed };
}

/** Stable hash of a representation for ETag / If-Match */
const etagOf = (obj) => `"${crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 32)}"`;

module.exports = { loadPeople, getPersonDoc, findByEmail, createPersonBasic, updatePersonBasic, validateManager, etagOf, MAX_PEOPLE };
