/**
 * Storage for onboarding / offboarding / rehire checklists (collection `checklists`).
 * One document per person and kind; a rehire gets its own document per rehire date.
 */
const { rawCollection } = require('../config/firebase');
const rules = require('./checklist-rules');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);

const docIdFor = (userId, kind, anchor) => (kind === 'rehire' ? `${userId}_rehire_${anchor}` : `${userId}_${kind}`);

/** What the system already knows about a person, used to complete tasks automatically */
function factsFor(data) {
    const forms = data.usForms || {};
    return {
        w4: Boolean(forms.w4 && forms.w4.current),
        i9_section1: Boolean(forms.i9 && forms.i9.section1),
        i9_section2: Boolean(forms.i9 && forms.i9.section2),
        direct_deposit: Boolean(forms.directDeposit),
        kiosk_pin: Boolean(data.pinHash),
        login_disabled: /^terminated$/i.test(String(data.status || ''))
    };
}

/** The company's changes to the built-in lists (empty when it has made none) */
async function templateSettings(orgId) {
    try { const s = await rawCollection('checklist_templates').doc(orgId).get(); return exists(s) ? (s.data().settings || {}) : {}; } catch (_) { return {}; }
}

/** Creates the checklist unless it already exists. Returns the stored document. */
async function createChecklist(orgId, emp, kind, anchorDate, options = {}) {
    const id = docIdFor(emp.id, kind, anchorDate);
    const ref = rawCollection('checklists').doc(id);
    const snap = await ref.get();
    if (exists(snap)) {
        const old = snap.data();
        // An offboarding list belongs to one exit. One that was cancelled, or that was made for another last day, is
        // from an earlier exit: it is kept under its own name (still readable, no longer listed) and a new one is made.
        const stale = kind === 'offboarding' && old.orgId === orgId && (old.cancelled === true || (old.anchorDate && old.anchorDate !== anchorDate));
        if (!stale) return { id, ...old };
        await rawCollection('checklists').doc(`${id}_was_${String(old.anchorDate || 'unknown')}_${Date.now()}`).set({ ...old, cancelled: true, supersededAt: new Date().toISOString(), supersededBy: id });
    }
    const doc = {
        orgId, userId: emp.id, employeeId: emp.data.employeeId || null, name: emp.data.name || null, kind, anchorDate,
        tasks: rules.buildChecklist(kind, anchorDate, { ...options, custom: await templateSettings(orgId) }), createdAt: new Date().toISOString(), cancelled: false
    };
    await ref.set(doc);
    return { id, ...doc };
}

async function listForUser(orgId, userId) {
    const snap = await rawCollection('checklists').where('userId', '==', userId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => c.orgId === orgId && !c.cancelled)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

module.exports = { exists, docIdFor, factsFor, createChecklist, listForUser, templateSettings };
