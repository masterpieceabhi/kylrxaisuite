/**
 * Custom employee fields (pure). Definitions are per organization and entity (employee).
 * Visibility levels, from most to least restricted:
 *   hr_only        HR and the owner only
 *   manager        HR + the person's manager can see; only HR edits
 *   employee_view  the person can see their own value too; only HR edits
 *   employee_edit  the person can see and edit their own value
 * Sensitive values are encrypted at rest and never returned in clear except through an audited reveal.
 */
const { parseIsoDate } = require('./us-forms');

const TYPES = ['text', 'number', 'date', 'select', 'boolean'];
const VISIBILITY = ['hr_only', 'manager', 'employee_view', 'employee_edit'];
const ENTITIES = ['employee'];
const MAX_FIELDS = 60;

function validateDefinition(input) {
    const errors = [];
    const b = input || {};
    const key = String(b.key || '').trim();
    if (!/^[a-z][a-z0-9_]{1,39}$/.test(key)) errors.push('key must be 2 to 40 characters: lowercase letters, digits and underscores, starting with a letter');
    const label = String(b.label || '').trim();
    if (!label) errors.push('label is required');
    if (label.length > 80) errors.push('label is too long');
    const entity = b.entity || 'employee';
    if (!ENTITIES.includes(entity)) errors.push(`entity must be one of: ${ENTITIES.join(', ')}`);
    if (!TYPES.includes(b.type)) errors.push(`type must be one of: ${TYPES.join(', ')}`);
    let options = [];
    if (b.type === 'select') {
        options = Array.isArray(b.options) ? b.options.map((o) => String(o).trim()).filter(Boolean) : [];
        if (options.length < 2) errors.push('a select field needs at least 2 options');
        if (new Set(options).size !== options.length) errors.push('select options must be different from each other');
        if (options.length > 50) errors.push('a select field can have at most 50 options');
    }
    const visibility = b.visibility || 'hr_only';
    if (!VISIBILITY.includes(visibility)) errors.push(`visibility must be one of: ${VISIBILITY.join(', ')}`);
    const sensitive = Boolean(b.sensitive);
    if (sensitive && visibility === 'employee_edit' && b.type !== 'text' && b.type !== 'number') errors.push('a sensitive field must be text or number');
    return {
        errors,
        value: { entity, key, label, type: b.type, options, required: Boolean(b.required), visibility, sensitive, active: b.active === undefined ? true : Boolean(b.active), helpText: String(b.helpText || '').trim().slice(0, 200) }
    };
}

const rank = (v) => VISIBILITY.indexOf(v);

/** viewer: 'hr' | 'manager' | 'self' | 'none' */
function canView(def, viewer) {
    if (viewer === 'hr') return true;
    if (viewer === 'manager') return rank(def.visibility) >= rank('manager');
    if (viewer === 'self') return rank(def.visibility) >= rank('employee_view');
    return false;
}

function canEdit(def, viewer) {
    if (viewer === 'hr') return true;
    return viewer === 'self' && def.visibility === 'employee_edit';
}

/** Checks one raw value against its definition. Returns { error } or { value } (null = cleared) */
function validateValue(def, raw) {
    if (raw === undefined || raw === null || raw === '') {
        return def.required ? { error: `${def.label} is required` } : { value: null };
    }
    switch (def.type) {
        case 'text': {
            const s = String(raw).trim();
            if (s.length > 500) return { error: `${def.label} is too long (500 characters at most)` };
            return { value: s };
        }
        case 'number': {
            const n = Number(raw);
            if (!Number.isFinite(n)) return { error: `${def.label} must be a number` };
            return { value: n };
        }
        case 'date':
            if (!parseIsoDate(String(raw))) return { error: `${def.label} must be a date (YYYY-MM-DD)` };
            return { value: String(raw) };
        case 'select':
            if (!def.options.includes(String(raw))) return { error: `${def.label} must be one of: ${def.options.join(', ')}` };
            return { value: String(raw) };
        case 'boolean':
            if (raw === true || raw === 'true') return { value: true };
            if (raw === false || raw === 'false') return { value: false };
            return { error: `${def.label} must be true or false` };
        default:
            return { error: `${def.label} has an unknown type` };
    }
}

/**
 * Validates submitted values {key: raw}. Unknown or inactive keys, or keys the viewer may not edit, are errors.
 * `requireAll` (HR creating a full record) also enforces required fields that were not sent.
 */
function validateValues(defs, input, viewer, { requireAll = false } = {}) {
    const errors = [];
    const out = {};
    const byKey = new Map(defs.filter((d) => d.active !== false).map((d) => [d.key, d]));
    for (const [key, raw] of Object.entries(input || {})) {
        const def = byKey.get(key);
        if (!def) { errors.push(`${key} is not a known custom field`); continue; }
        if (!canEdit(def, viewer)) { errors.push(`You cannot edit ${def.label}`); continue; }
        const r = validateValue(def, raw);
        if (r.error) errors.push(r.error); else out[key] = r.value;
    }
    if (requireAll) {
        for (const def of byKey.values()) {
            if (def.required && canEdit(def, viewer) && !(def.key in (input || {}))) errors.push(`${def.label} is required`);
        }
    }
    return { errors, value: out };
}

const maskSensitive = (v) => (v === null || v === undefined || v === '' ? null : '••••');

module.exports = { TYPES, VISIBILITY, MAX_FIELDS, validateDefinition, canView, canEdit, validateValue, validateValues, maskSensitive };
