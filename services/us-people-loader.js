/** Shared read helpers for the benefits, leave-case, wage and tip routers (I/O, no business rules). */
const { rawCollection } = require('../config/firebase');
const { parseIsoDate } = require('./us-forms');

const INACTIVE = ['inactive', 'terminated', 'offboarded', 'separated'];

const hireDateOf = (data) => {
    const raw = (data.usProfile && data.usProfile.startDate) || data.startDate || data.joiningDate || '';
    const d = String(raw).slice(0, 10);
    return parseIsoDate(d) ? d : null;
};

/** One flat person record from a stored people document (never includes taxpayer ID data) */
function toPerson(id, data) {
    const p = data.usProfile || {};
    return {
        id, employeeId: data.employeeId || '', name: data.name || [p.legalFirstName, p.legalLastName].filter(Boolean).join(' ') || data.email || id,
        email: data.email || '', role: data.role || 'employee', active: !INACTIVE.includes(String(data.status || '').toLowerCase()),
        classification: p.classification || null, employmentType: p.employmentType || null, hireDate: hireDateOf(data),
        payType: p.payType || null, payRate: p.payRate || null, payFrequency: p.payFrequency || null, flsaStatus: p.flsaStatus || null,
        workState: p.workState || null, workCity: p.workCity || null, workCounty: p.workCounty || null, tipped: p.tipped === true,
        managerId: p.managerId || null, locationId: p.locationId || data.locationId || null,
        weeklyHours: Number(p.scheduledWeeklyHours) > 0 ? Number(p.scheduledWeeklyHours) : null, ssnLast4: p.taxpayerIdLast4 || ''
    };
}

async function loadPeople(orgId) {
    const snap = await rawCollection('users').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => toPerson(d.id, d.data()));
}

async function loadPerson(orgId, id) {
    const snap = await rawCollection('users').doc(String(id)).get();
    const ok = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
    if (!ok || snap.data().orgId !== orgId) return null;
    return toPerson(snap.id, snap.data());
}

async function loadWeeks(orgId, userId) {
    const snap = await rawCollection('timesheet_weeks').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => d.data()).filter((w) => (!userId || w.userId === userId));
}

const byUser = (rows) => { const m = {}; for (const r of rows) (m[r.userId] = m[r.userId] || []).push(r); return m; };

module.exports = { loadPeople, loadPerson, loadWeeks, toPerson, hireDateOf, byUser };
