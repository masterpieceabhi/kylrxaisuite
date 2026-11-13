/**
 * Self-service profile edit rules (pure).
 *  direct edits (no approval):  preferredName, phone, maritalStatus, emergency contacts
 *  change requests:             legalName, homeAddress, bankDetails
 *  HR can allow low-risk request types to apply without review (settings.autoApprove); bank details never can.
 */
const { validateAddress, validateDirectDeposit } = require('./us-validation');

const MARITAL = ['single', 'married', 'married_separate', 'head_of_household', 'divorced', 'widowed', 'domestic_partner', 'prefer_not_to_say'];
const REQUEST_FIELDS = ['legalName', 'homeAddress', 'bankDetails'];
const AUTO_APPROVABLE = ['homeAddress', 'legalName'];
const MAX_CONTACTS = 5;

const digits = (v) => String(v || '').replace(/\D/g, '');

function validatePhone(v) {
    const d = digits(v);
    const n = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
    if (n.length !== 10 || n[0] === '0' || n[0] === '1') return { error: 'phone must be a 10 digit US number' };
    return { value: `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}` };
}

const cleanName = (v) => String(v || '').replace(/\s+/g, ' ').trim();

/** Direct edits: returns { errors, value } with only the fields that were sent */
function validateDirectEdit(input) {
    const errors = []; const value = {}; const b = input || {};
    if (b.preferredName !== undefined) {
        const n = cleanName(b.preferredName);
        if (n.length > 60) errors.push('preferredName is too long'); else value.preferredName = n;
    }
    if (b.phone !== undefined) {
        if (b.phone === '' || b.phone === null) value.phone = '';
        else { const r = validatePhone(b.phone); if (r.error) errors.push(r.error); else value.phone = r.value; }
    }
    if (b.maritalStatus !== undefined) {
        if (b.maritalStatus === '' || b.maritalStatus === null) value.maritalStatus = '';
        else if (!MARITAL.includes(b.maritalStatus)) errors.push(`maritalStatus must be one of: ${MARITAL.join(', ')}`);
        else value.maritalStatus = b.maritalStatus;
    }
    return { errors, value };
}

function validateEmergencyContact(input) {
    const errors = []; const b = input || {};
    const name = cleanName(b.name);
    if (!name) errors.push('name is required'); else if (name.length > 80) errors.push('name is too long');
    const relationship = cleanName(b.relationship);
    if (!relationship) errors.push('relationship is required');
    const ph = validatePhone(b.phone);
    if (ph.error) errors.push(ph.error);
    const email = String(b.email || '').trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('email is not valid');
    return { errors, value: { name, relationship: relationship.slice(0, 40), phone: ph.value || '', email, isPrimary: Boolean(b.isPrimary) } };
}

/** Keeps exactly one primary contact when there is any contact */
function normalizePrimary(list, preferredId) {
    if (!list.length) return list;
    let primary = preferredId && list.find((c) => c.id === preferredId && c.isPrimary) ? preferredId : (list.find((c) => c.isPrimary) || list[0]).id;
    return list.map((c) => ({ ...c, isPrimary: c.id === primary }));
}

/** Request payloads for the three guarded fields. Returns { errors, value } where value is the "after" data. */
function validateChange(field, input) {
    const b = input || {};
    if (field === 'legalName') {
        const errors = [];
        const first = cleanName(b.legalFirstName); const last = cleanName(b.legalLastName); const middle = cleanName(b.legalMiddleName);
        if (!first) errors.push('legalFirstName is required');
        if (!last) errors.push('legalLastName is required');
        if (first.length > 60 || last.length > 60 || middle.length > 60) errors.push('names are too long');
        return { errors, value: { legalFirstName: first, legalMiddleName: middle, legalLastName: last } };
    }
    if (field === 'homeAddress') {
        const r = validateAddress(b.homeAddress || b.address || b);
        return { errors: r.errors.map((e) => e.replace('address.', 'homeAddress.')), value: r.value };
    }
    if (field === 'bankDetails') {
        return validateDirectDeposit({ ...b, authorization: b.authorization });
    }
    return { errors: [`field must be one of: ${REQUEST_FIELDS.join(', ')}`], value: null };
}

/** Default settings, overridden by the company's */
function normalizeSettings(s) {
    const input = (s && s.autoApprove) || [];
    return { autoApprove: input.filter((f) => AUTO_APPROVABLE.includes(f)) };
}

function validateSettings(input) {
    const errors = [];
    const list = Array.isArray(input && input.autoApprove) ? input.autoApprove : [];
    for (const f of list) if (!AUTO_APPROVABLE.includes(f)) errors.push(`${f} cannot be auto-approved (allowed: ${AUTO_APPROVABLE.join(', ')}); bank details always need review`);
    return { errors, value: { autoApprove: list.filter((f) => AUTO_APPROVABLE.includes(f)) } };
}

const stable = (v) => (v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}` : JSON.stringify(v));
/** Same data regardless of key order (stored documents do not keep the order we wrote) */
const same = (a, b) => stable(a) === stable(b);

module.exports = {
    MARITAL, REQUEST_FIELDS, AUTO_APPROVABLE, MAX_CONTACTS, validatePhone, validateDirectEdit, validateEmergencyContact,
    normalizePrimary, validateChange, normalizeSettings, validateSettings, same
};
