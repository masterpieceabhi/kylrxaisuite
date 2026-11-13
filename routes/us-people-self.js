/** Custom fields, self-service profile edits, change requests and the people-data settings. Auth is applied by the parent router. */
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const { requireUsOrg, findEmployee, audit } = require('./us-hr').helpers;
const { requirePermission, requireAnyPermission, can, canonicalRole } = require('../services/permissions');
const { encryptField, decryptField } = require('../services/pii-crypto');
const CF = require('../services/custom-fields-rules');
const PC = require('../services/profile-change-rules');
const store = require('../services/people-data-store');

const now = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const isSelf = (req, emp) => emp.id === req.user.id;

/** Who is looking at this person's record: hr (people.write), reader (people.read), manager (their own report), self, or none */
function viewerOf(req, emp, { write = false } = {}) {
    if (can(req.user, 'people.write')) return 'hr';
    if (!write && can(req.user, 'people.read')) return 'hr'; // read-only roles see what HR sees; edits are refused by people.write above
    if (isSelf(req, emp)) return 'self';
    const mgr = emp.data.usProfile && emp.data.usProfile.managerId;
    if (canonicalRole(req.user.role) === 'manager' && mgr && mgr === req.user.id) return 'manager';
    return 'none';
}

// ------------------------------------------------------------- custom fields
const cfContext = (orgId, empId, key) => `${orgId}:${empId}:cf:${key}`;

router.get('/custom-fields', requireUsOrg, async (req, res) => {
    const defs = (await store.listByOrg('custom_field_defs', req.orgId)).filter((d) => d.active !== false || (req.query.all === 'true' && can(req.user, 'people.write')));
    const viewer = can(req.user, 'people.read') ? 'hr' : canonicalRole(req.user.role) === 'manager' ? 'manager' : 'self';
    res.json({ success: true, data: defs.filter((d) => CF.canView(d, viewer)).sort((a, b) => String(a.label).localeCompare(String(b.label))) });
});

router.post('/custom-fields', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const { errors, value } = CF.validateDefinition(req.body);
    if (errors.length) return invalid(res, errors);
    const defs = await store.listByOrg('custom_field_defs', req.orgId);
    if (defs.some((d) => d.key === value.key && d.entity === value.entity)) return fail(res, 409, 'A custom field with this key already exists');
    if (defs.length >= CF.MAX_FIELDS) return fail(res, 409, `At most ${CF.MAX_FIELDS} custom fields are allowed`);
    const doc = { ...value, orgId: req.orgId, createdAt: now(), createdBy: req.user.id || null };
    const ref = await rawCollection('custom_field_defs').add(doc);
    audit(req.orgId, req, 'custom_field_created', ref.id, { key: value.key, type: value.type, sensitive: value.sensitive });
    res.status(201).json({ success: true, field: { id: ref.id, ...doc } });
});

router.put('/custom-fields/:id', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('custom_field_defs', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Custom field not found');
    const b = req.body || {};
    if ((b.key && b.key !== cur.key) || (b.type && b.type !== cur.type)) return fail(res, 409, 'The key and type of a field cannot change. Add a new field instead.');
    if (b.sensitive !== undefined && Boolean(b.sensitive) !== Boolean(cur.sensitive)) return fail(res, 409, 'Sensitive cannot be switched on a field that exists. Add a new field instead.');
    const { errors, value } = CF.validateDefinition({ ...cur, ...b, key: cur.key, type: cur.type });
    if (errors.length) return invalid(res, errors);
    await cur.ref.set({ ...value, updatedAt: now() }, { merge: true });
    audit(req.orgId, req, 'custom_field_updated', cur.id, { key: cur.key, fields: Object.keys(b) });
    res.json({ success: true, field: { id: cur.id, orgId: req.orgId, ...value } });
});

/** A field that is switched off keeps its stored values; they are just no longer shown or editable */
router.delete('/custom-fields/:id', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('custom_field_defs', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Custom field not found');
    await cur.ref.set({ active: false, updatedAt: now() }, { merge: true });
    audit(req.orgId, req, 'custom_field_deactivated', cur.id, { key: cur.key });
    res.json({ success: true });
});

function renderFields(defs, values, viewer) {
    return defs.filter((d) => d.active !== false && CF.canView(d, viewer)).map((d) => {
        const raw = values[d.key];
        const has = raw !== undefined && raw !== null && raw !== '';
        return { key: d.key, label: d.label, type: d.type, options: d.options, required: d.required, visibility: d.visibility, sensitive: d.sensitive, helpText: d.helpText || '', canEdit: CF.canEdit(d, viewer),
            value: d.sensitive ? CF.maskSensitive(has ? raw : null) : (has ? raw : null), hasValue: has };
    });
}

/** Stored map with sensitive values still encrypted; callers never send this to the browser as is */
const storedValues = (emp) => emp.data.customFields || {};

async function readCustomFields(req, emp, viewer) {
    const defs = await store.listByOrg('custom_field_defs', req.orgId);
    return renderFields(defs, storedValues(emp), viewer);
}

router.get('/employees/:id/custom-fields', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    const viewer = viewerOf(req, emp);
    if (viewer === 'none') return fail(res, 403, 'You do not have permission to do this');
    res.json({ success: true, viewer, data: await readCustomFields(req, emp, viewer) });
});

async function saveCustomFields(req, res, emp) {
    const viewer = viewerOf(req, emp, { write: true });
    if (viewer === 'none' || viewer === 'manager') return fail(res, 403, 'You do not have permission to do this');
    const defs = await store.listByOrg('custom_field_defs', req.orgId);
    const { errors, value } = CF.validateValues(defs, req.body && req.body.values, viewer);
    if (errors.length) return invalid(res, errors);
    if (!Object.keys(value).length) return invalid(res, ['send at least one value']);
    const byKey = Object.fromEntries(defs.map((d) => [d.key, d]));
    const patch = {};
    for (const [k, v] of Object.entries(value)) {
        patch[k] = v === null ? null : byKey[k].sensitive ? encryptField(String(v), cfContext(req.orgId, emp.id, k)) : v;
    }
    await emp.ref.set({ customFields: patch }, { merge: true });
    audit(req.orgId, req, 'custom_fields_updated', emp.id, { keys: Object.keys(patch), viewer });
    const fresh = { ...emp, data: { ...emp.data, customFields: { ...storedValues(emp), ...patch } } };
    res.json({ success: true, data: await readCustomFields(req, fresh, viewer) });
}

router.put('/employees/:id/custom-fields', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    return saveCustomFields(req, res, emp);
});

/** Shows one sensitive value in clear, with a stated reason; always audited */
router.post('/employees/:id/custom-fields/:key/reveal', requirePermission('pii.reveal'), requireUsOrg, async (req, res) => {
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 5) return invalid(res, ['A reason of at least 5 characters is required']);
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    const def = (await store.listByOrg('custom_field_defs', req.orgId)).find((d) => d.key === req.params.key);
    if (!def || !def.sensitive) return fail(res, 404, 'No sensitive field with that key');
    const stored = storedValues(emp)[def.key];
    if (!stored) return fail(res, 404, 'No value on file');
    let plain;
    try { plain = decryptField(stored, cfContext(req.orgId, emp.id, def.key)); } catch (_) { return fail(res, 500, 'Could not decrypt the stored value'); }
    await audit(req.orgId, req, 'custom_field_revealed', emp.id, { key: def.key, reason });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, key: def.key, value: def.type === 'number' ? Number(plain) : plain });
});

// ---------------------------------------------------------------- settings
router.get('/people-data/settings', requireAnyPermission('people.read', 'org.settings'), requireUsOrg, async (req, res) => {
    const s = await store.getSettings(req.orgId);
    res.json({ success: true, settings: { compApprovalPercent: s.compApprovalPercent, profileChange: PC.normalizeSettings(s.profileChange), autoApprovable: PC.AUTO_APPROVABLE } });
});

router.put('/people-data/settings', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const b = req.body || {}; const errors = []; const patch = {};
    if (b.compApprovalPercent !== undefined) {
        const p = Number(b.compApprovalPercent);
        if (!(p >= 0 && p <= 1000) || !Number.isFinite(p)) errors.push('compApprovalPercent must be between 0 and 1000');
        else patch.compApprovalPercent = p;
    }
    if (b.profileChange !== undefined) {
        const r = PC.validateSettings(b.profileChange);
        if (r.errors.length) errors.push(...r.errors); else patch.profileChange = r.value;
    }
    if (errors.length) return invalid(res, errors);
    if (!Object.keys(patch).length) return invalid(res, ['nothing to change']);
    const s = await store.patchSettings(req.orgId, patch);
    audit(req.orgId, req, 'people_data_settings_updated', req.orgId, patch);
    res.json({ success: true, settings: { compApprovalPercent: s.compApprovalPercent, profileChange: PC.normalizeSettings(s.profileChange) } });
});

// ------------------------------------------------------- my profile (self-service)
async function me(req, res) {
    const emp = await findEmployee(req.orgId, req.user.id);
    if (!emp) { fail(res, 404, 'Your employee record was not found'); return null; }
    return emp;
}

const maskAfter = (field, v) => {
    if (field !== 'bankDetails' || !v) return v;
    return { bankName: v.bankName, routingNumber: v.routingNumber, accountType: v.accountType, accountLast4: v.accountLast4, accountMasked: `••••${v.accountLast4}` };
};
const publicRequest = (r) => ({
    id: r.id, userId: r.userId, userName: r.userName || null, employeeId: r.employeeId || null, field: r.field, before: maskAfter(r.field, r.before), after: maskAfter(r.field, r.after), reason: r.reason || '',
    supportingDocument: r.supportingDocument || null, status: r.status, autoApproved: Boolean(r.autoApproved), createdAt: r.createdAt, decidedBy: r.decidedBy || null, decidedAt: r.decidedAt || null, decisionNote: r.decisionNote || ''
});

const currentFor = (emp, field) => {
    const p = emp.data.usProfile || {};
    if (field === 'legalName') return { legalFirstName: p.legalFirstName || '', legalMiddleName: p.legalMiddleName || '', legalLastName: p.legalLastName || '' };
    if (field === 'homeAddress') return p.homeAddress || null;
    const dd = (emp.data.usForms && emp.data.usForms.directDeposit) || null;
    return dd ? { bankName: dd.bankName, routingNumber: dd.routingNumber, accountType: dd.accountType, accountLast4: dd.accountLast4 } : null;
};

function emergencyOf(emp) { return ((emp.data.usProfile && emp.data.usProfile.emergencyContacts) || []).map((c) => ({ ...c })); }

router.get('/me/profile', requireUsOrg, async (req, res) => {
    const emp = await me(req, res); if (!emp) return;
    const p = emp.data.usProfile || {};
    const [requests, settings] = await Promise.all([
        store.listByOrg('profile_change_requests', req.orgId).then((l) => l.filter((r) => r.userId === emp.id)), store.getSettings(req.orgId)
    ]);
    const fields = await readCustomFields(req, emp, 'self');
    res.json({
        success: true,
        profile: {
            id: emp.id, employeeId: emp.data.employeeId || null, name: emp.data.name || null, email: emp.data.email || null,
            legalFirstName: p.legalFirstName || '', legalMiddleName: p.legalMiddleName || '', legalLastName: p.legalLastName || '',
            preferredName: p.preferredName || '', phone: p.phone || emp.data.phone || '', maritalStatus: p.maritalStatus || '',
            homeAddress: p.homeAddress || null, emergencyContacts: emergencyOf(emp), bank: currentFor(emp, 'bankDetails')
        },
        customFields: fields,
        requests: requests.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30).map(publicRequest),
        autoApprove: PC.normalizeSettings(settings.profileChange).autoApprove
    });
});

router.put('/me/profile', requireUsOrg, async (req, res) => {
    const emp = await me(req, res); if (!emp) return;
    const { errors, value } = PC.validateDirectEdit(req.body);
    if (errors.length) return invalid(res, errors);
    if (!Object.keys(value).length) return invalid(res, ['send preferredName, phone or maritalStatus']);
    await emp.ref.set({ usProfile: { ...value, updatedAt: now() }, ...(value.phone !== undefined ? { phone: value.phone } : {}) }, { merge: true });
    audit(req.orgId, req, 'self_profile_updated', emp.id, { fields: Object.keys(value) });
    res.json({ success: true, updated: value });
});

// emergency contacts: full CRUD on your own record
async function saveContacts(emp, list, req) {
    await emp.ref.set({ usProfile: { emergencyContacts: list, updatedAt: now() } }, { merge: true });
    emp.data.usProfile = { ...(emp.data.usProfile || {}), emergencyContacts: list };
    return list;
}

router.get('/me/emergency-contacts', requireUsOrg, async (req, res) => {
    const emp = await me(req, res); if (!emp) return;
    res.json({ success: true, data: emergencyOf(emp) });
});

router.post('/me/emergency-contacts', requireUsOrg, async (req, res) => {
    const emp = await me(req, res); if (!emp) return;
    const list = emergencyOf(emp);
    if (list.length >= PC.MAX_CONTACTS) return fail(res, 409, `You can keep at most ${PC.MAX_CONTACTS} emergency contacts`);
    const { errors, value } = PC.validateEmergencyContact(req.body);
    if (errors.length) return invalid(res, errors);
    const contact = { id: crypto.randomUUID(), ...value, createdAt: now() };
    const next = PC.normalizePrimary([...list, contact], value.isPrimary ? contact.id : null);
    await saveContacts(emp, next, req);
    audit(req.orgId, req, 'self_emergency_contact_added', emp.id, { contactId: contact.id });
    res.status(201).json({ success: true, data: next });
});

router.put('/me/emergency-contacts/:cid', requireUsOrg, async (req, res) => {
    const emp = await me(req, res); if (!emp) return;
    const list = emergencyOf(emp);
    const cur = list.find((c) => c.id === req.params.cid);
    if (!cur) return fail(res, 404, 'Contact not found');
    const { errors, value } = PC.validateEmergencyContact({ ...cur, ...req.body });
    if (errors.length) return invalid(res, errors);
    const next = PC.normalizePrimary(list.map((c) => (c.id === cur.id ? { ...c, ...value, updatedAt: now() } : c)), value.isPrimary ? cur.id : null);
    await saveContacts(emp, next, req);
    audit(req.orgId, req, 'self_emergency_contact_updated', emp.id, { contactId: cur.id });
    res.json({ success: true, data: next });
});

router.delete('/me/emergency-contacts/:cid', requireUsOrg, async (req, res) => {
    const emp = await me(req, res); if (!emp) return;
    const list = emergencyOf(emp);
    if (!list.some((c) => c.id === req.params.cid)) return fail(res, 404, 'Contact not found');
    const next = PC.normalizePrimary(list.filter((c) => c.id !== req.params.cid));
    await saveContacts(emp, next, req);
    audit(req.orgId, req, 'self_emergency_contact_deleted', emp.id, { contactId: req.params.cid });
    res.json({ success: true, data: next });
});

/** HR can read a person's emergency contacts (for a safety event) */
router.get('/employees/:id/emergency-contacts', requirePermission('people.read'), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    audit(req.orgId, req, 'emergency_contacts_viewed', emp.id, {});
    res.json({ success: true, data: emergencyOf(emp) });
});

// ----------------------------------------------------------- change requests
/** Writes an approved change to the person inside the same transaction that marks the request approved */
function applyChange(tx, personRef, personData, request) {
    const patch = {};
    if (request.field === 'legalName') {
        const a = request.after;
        patch.usProfile = { legalFirstName: a.legalFirstName, legalMiddleName: a.legalMiddleName, legalLastName: a.legalLastName, updatedAt: now() };
        patch.name = `${a.legalFirstName} ${a.legalLastName}`.trim();
    } else if (request.field === 'homeAddress') {
        patch.usProfile = { homeAddress: request.after, updatedAt: now() };
    } else if (request.field === 'bankDetails') {
        const a = request.after;
        patch.usForms = {
            directDeposit: {
                bankName: a.bankName, routingNumber: a.routingNumber, accountType: a.accountType, accountNumberEncrypted: a.accountNumberEncrypted, accountLast4: a.accountLast4,
                updatedAt: now(), updatedBy: request.userId, authorizedAt: request.createdAt, change: 'approved_request'
            },
            directDepositSplits: null // a changed bank account replaces any earlier split setup
        };
    }
    tx.set(personRef, patch, { merge: true });
}

async function decide(req, res, status) {
    const note = String((req.body && req.body.note) || '').trim();
    if (status === 'rejected' && note.length < 3) return invalid(res, ['A reason for rejecting is required']);
    const ref = rawCollection('profile_change_requests').doc(req.params.id);
    try {
        const out = await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            if (!store.exists(snap) || snap.data().orgId !== req.orgId) return { code: 404, error: 'Request not found' };
            const r = { id: snap.id, ...snap.data() };
            if (r.status !== 'pending') return { code: 409, error: `This request is already ${r.status}` };
            if (r.userId === req.user.id) return { code: 409, error: 'You cannot decide your own request. Another HR admin must.' };
            const personRef = rawCollection('users').doc(r.userId);
            const person = await tx.get(personRef);
            if (!store.exists(person) || person.data().orgId !== req.orgId) return { code: 409, error: 'The employee record no longer exists' };
            if (status === 'approved') applyChange(tx, personRef, person.data(), r);
            tx.set(ref, { status, decidedBy: req.user.id || null, decidedAt: now(), decisionNote: note }, { merge: true });
            return { request: { ...r, status, decidedBy: req.user.id, decidedAt: now(), decisionNote: note } };
        });
        if (out.error) return fail(res, out.code, out.error);
        audit(req.orgId, req, status === 'approved' ? 'profile_change_approved' : 'profile_change_rejected', out.request.userId, { requestId: req.params.id, field: out.request.field });
        res.json({ success: true, request: publicRequest(out.request) });
    } catch (e) { return fail(res, 500, 'Could not complete the decision. Nothing was changed.'); }
}

router.post('/me/change-requests', requireUsOrg, async (req, res) => {
    const emp = await me(req, res); if (!emp) return;
    const b = req.body || {};
    const field = b.field;
    if (!PC.REQUEST_FIELDS.includes(field)) return invalid(res, [`field must be one of: ${PC.REQUEST_FIELDS.join(', ')}`]);
    const { errors, value } = PC.validateChange(field, b);
    const reason = String(b.reason || '').trim().slice(0, 500);
    if (!errors.length && reason.length < 3) errors.push('A short reason is required');
    if (errors.length) return invalid(res, errors);
    const existing = (await store.listByOrg('profile_change_requests', req.orgId)).filter((r) => r.userId === emp.id && r.field === field && r.status === 'pending');
    if (existing.length) return fail(res, 409, 'You already have a request of this kind waiting for review. Cancel it first to send a new one.');
    const before = currentFor(emp, field);
    let after = value;
    if (field === 'bankDetails') {
        after = { bankName: value.bankName, routingNumber: value.routingNumber, accountType: value.accountType, accountLast4: value.accountLast4, accountNumberEncrypted: encryptField(value.accountNumber, `${req.orgId}:${emp.id}:bank`) };
    } else if (PC.same(before, after)) return invalid(res, ['This is the same as what is on file']);
    const doc = {
        orgId: req.orgId, userId: emp.id, userName: emp.data.name || null, employeeId: emp.data.employeeId || null, field, before, after, reason,
        supportingDocument: b.supportingDocument && typeof b.supportingDocument === 'object' ? { name: String(b.supportingDocument.name || '').slice(0, 120), note: String(b.supportingDocument.note || '').slice(0, 300), vaultDocId: b.supportingDocument.vaultDocId ? String(b.supportingDocument.vaultDocId).slice(0, 80) : null } : null,
        status: 'pending', autoApproved: false, createdAt: now(), requestedBy: req.user.id || null
    };
    const settings = PC.normalizeSettings((await store.getSettings(req.orgId)).profileChange);
    const ref = await rawCollection('profile_change_requests').add(doc);
    if (settings.autoApprove.includes(field)) {
        try {
            await db.runTransaction(async (tx) => {
                const personRef = rawCollection('users').doc(emp.id);
                applyChange(tx, personRef, emp.data, { ...doc, id: ref.id });
                tx.set(ref, { status: 'approved', autoApproved: true, decidedBy: 'auto', decidedAt: now(), decisionNote: 'Low-risk change approved automatically by company setting' }, { merge: true });
            });
            audit(req.orgId, req, 'profile_change_auto_approved', emp.id, { requestId: ref.id, field });
            return res.status(201).json({ success: true, request: publicRequest({ id: ref.id, ...doc, status: 'approved', autoApproved: true, decidedBy: 'auto', decidedAt: now() }), applied: true });
        } catch (e) {
            await ref.set({ status: 'pending' }, { merge: true });
        }
    }
    audit(req.orgId, req, 'profile_change_requested', emp.id, { requestId: ref.id, field });
    res.status(201).json({ success: true, request: publicRequest({ id: ref.id, ...doc }), applied: false });
});

router.get('/me/change-requests', requireUsOrg, async (req, res) => {
    const rows = (await store.listByOrg('profile_change_requests', req.orgId)).filter((r) => r.userId === req.user.id);
    res.json({ success: true, data: rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map(publicRequest) });
});

router.delete('/me/change-requests/:id', requireUsOrg, async (req, res) => {
    const r = await store.getOwned('profile_change_requests', req.orgId, req.params.id);
    if (!r || r.userId !== req.user.id) return fail(res, 404, 'Request not found');
    if (r.status !== 'pending') return fail(res, 409, `This request is already ${r.status}`);
    await r.ref.set({ status: 'cancelled', decidedAt: now(), decidedBy: req.user.id }, { merge: true });
    audit(req.orgId, req, 'profile_change_cancelled', r.userId, { requestId: r.id });
    res.json({ success: true });
});

// HR queue
router.get('/change-requests', requirePermission('people.read'), requireUsOrg, async (req, res) => {
    const status = req.query.status ? String(req.query.status) : null;
    const rows = (await store.listByOrg('profile_change_requests', req.orgId)).filter((r) => !status || r.status === status);
    res.json({ success: true, count: rows.length, data: rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 300).map(publicRequest) });
});
router.post('/change-requests/:id/approve', requirePermission('people.write'), requireUsOrg, (req, res) => decide(req, res, 'approved'));
router.post('/change-requests/:id/reject', requirePermission('people.write'), requireUsOrg, (req, res) => decide(req, res, 'rejected'));

module.exports = router;
