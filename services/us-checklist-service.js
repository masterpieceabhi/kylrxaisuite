/**
 * Storage for onboarding / offboarding / rehire checklists (collection `checklists`).
 * One document per person and kind; a rehire gets its own document per rehire date.
 */
const { rawCollection } = require('../config/firebase');
const rules = require('./checklist-rules');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);

const docIdFor = (userId, kind, anchor) => (kind === 'rehire' ? `${userId}_rehire_${anchor}` : `${userId}_${kind}`);

/** What the system already knows about a person, used to complete tasks automatically */
function factsFor(data, extra = {}) {
    const forms = data.usForms || {};
    const contacts = (data.usProfile && data.usProfile.emergencyContacts) || [];
    return {
        emergency_contact: Array.isArray(contacts) && contacts.length > 0,
        handbook: extra.handbook === true,
        w4: Boolean(forms.w4 && forms.w4.current),
        i9_section1: Boolean(forms.i9 && forms.i9.section1),
        i9_section2: Boolean(forms.i9 && forms.i9.section2),
        direct_deposit: Boolean(forms.directDeposit),
        kiosk_pin: Boolean(data.pinHash),
        login_disabled: /^terminated$/i.test(String(data.status || ''))
    };
}

/**
 * Who has read the handbook. Either way a company collects it counts:
 *   - its published policies that ask for an acknowledgement, each acknowledged in its current version, or
 *   - a signed "Handbook acknowledgement" e-sign document (services/esign-rules.js, type handbook_ack).
 * Returns a function userId -> true/false (false while the company has neither).
 */
async function handbookFacts(orgId) {
    const P = require('./policy-rules');
    const [pol, acks, signs] = await Promise.all([
        rawCollection('policies').where('orgId', '==', orgId).get(),
        rawCollection('policy_acks').where('orgId', '==', orgId).get(),
        rawCollection('sign_requests').where('orgId', '==', orgId).get().catch(() => ({ docs: [] }))
    ]);
    const signed = new Set(signs.docs.map((d) => d.data()).filter((r) => r.templateType === 'handbook_ack' && r.status === 'signed' && r.userId).map((r) => r.userId));
    const asking = pol.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.status === 'published' && P.ackState(p, []).needed);
    const byUser = new Map();
    acks.docs.forEach((d) => { const a = d.data(); if (!byUser.has(a.userId)) byUser.set(a.userId, []); byUser.get(a.userId).push(a); });
    return (userId) => {
        if (signed.has(userId)) return true;
        if (!asking.length) return false;
        const mine = byUser.get(userId) || [];
        return asking.every((p) => P.ackState(p, mine.filter((a) => a.policyId === p.id).map((a) => a.version)).done);
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

module.exports = { exists, docIdFor, factsFor, handbookFacts, createChecklist, listForUser, templateSettings };
