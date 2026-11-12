/**
 * Shared Firestore helpers for the people-data modules (org structure, comp history, contractors, holidays).
 * Every query filters by orgId itself.
 */
const { rawCollection } = require('../config/firebase');
const { localDate } = require('./time-rules');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);

async function listByOrg(name, orgId) {
    const snap = await rawCollection(name).where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => d.orgId === orgId);
}

async function getOwned(name, orgId, id) {
    if (!id) return null;
    const snap = await rawCollection(name).doc(String(id)).get();
    if (!exists(snap)) return null;
    const data = snap.data();
    return data.orgId === orgId ? { id: snap.id, ref: snap.ref, ...data } : null;
}

/** Today's date in the organization's time zone */
async function todayFor(orgId) {
    const snap = await rawCollection('organizations').doc(orgId).get();
    const data = exists(snap) ? snap.data() : {};
    const tz = (data.usProfile && data.usProfile.timezone) || data.timezone || 'America/Chicago';
    try { return localDate(new Date().toISOString(), tz); } catch (_) { return new Date().toISOString().slice(0, 10); }
}

const SETTINGS_DEFAULTS = {
    compApprovalPercent: 10,
    profileChange: { autoApprove: [] },
    contractors: { necThreshold: 600, backupWithholdingRate: 24 }
};

async function getSettings(orgId) {
    const snap = await rawCollection('people_data_settings').doc(orgId).get();
    const d = exists(snap) ? snap.data() : {};
    return {
        compApprovalPercent: d.compApprovalPercent === undefined ? SETTINGS_DEFAULTS.compApprovalPercent : d.compApprovalPercent,
        profileChange: { ...SETTINGS_DEFAULTS.profileChange, ...(d.profileChange || {}) },
        contractors: { ...SETTINGS_DEFAULTS.contractors, ...(d.contractors || {}) }
    };
}

async function patchSettings(orgId, patch) {
    await rawCollection('people_data_settings').doc(orgId).set({ orgId, ...patch, updatedAt: new Date().toISOString() }, { merge: true });
    return getSettings(orgId);
}

const isActivePerson = (p) => !/^(terminated|inactive|exited)$/i.test(String(p.status || ''));

/** People of the organization as flat rows (users first; roster `employees` rows only when no user has the same employeeId) */
async function loadPeople(orgId, { includeInactive = false } = {}) {
    const [users, roster] = await Promise.all([listByOrg('users', orgId), listByOrg('employees', orgId)]);
    const seen = new Set(users.map((u) => u.employeeId).filter(Boolean));
    const rows = [...users, ...roster.filter((r) => !r.employeeId || !seen.has(r.employeeId))];
    return rows.filter((p) => p.employeeId || p.usProfile).filter((p) => includeInactive || isActivePerson(p)).map((p) => {
        const up = p.usProfile || {};
        return {
            id: p.id, employeeId: p.employeeId || null, name: p.name || [up.legalFirstName, up.legalLastName].filter(Boolean).join(' ') || p.email || p.id,
            email: p.email || null, role: p.role || null, status: p.status || 'active', jobTitle: up.jobTitle || p.jobTitle || null,
            managerId: up.managerId || null, departmentId: up.departmentId || null, workLocationId: up.workLocationId || null,
            payScheduleId: up.payScheduleId || null, payFrequency: up.payFrequency || null, workState: up.workState || null
        };
    });
}

module.exports = { exists, listByOrg, getOwned, todayFor, getSettings, patchSettings, loadPeople, isActivePerson, SETTINGS_DEFAULTS };
