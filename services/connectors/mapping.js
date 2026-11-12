/**
 * Declarative field-mapping engine (pure).
 *
 * A mapping is a list of rules:
 *   { target: 'Vendor.DisplayName', source: 'display_name', transform: 'trim' | ['trim','upper'] | { fn: 'date', format: 'MM/DD/YYYY' },
 *     default: 'N/A', required: true, disabled: false }
 * `source` is a path in the canonical record ('job.title', 'hours.worked'); `target` is a dotted path in the output.
 * Per-connector defaults are merged with per-company overrides by `target` (an override with disabled:true removes a default).
 */

const pad = (n, w = 2) => String(n).padStart(w, '0');

function getPath(obj, path) {
    if (path === undefined || path === null || path === '') return undefined;
    let cur = obj;
    for (const part of String(path).replace(/\[(\d+)\]/g, '.$1').split('.')) {
        if (cur === undefined || cur === null) return undefined;
        cur = cur[part];
    }
    return cur;
}

function setPath(obj, path, value) {
    const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.');
    let cur = obj;
    parts.forEach((p, i) => {
        if (i === parts.length - 1) { cur[p] = value; return; }
        if (cur[p] === undefined || cur[p] === null || typeof cur[p] !== 'object') cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
        cur = cur[p];
    });
}

function formatDate(value, format = 'YYYY-MM-DD') {
    if (!value) return value;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T00:00:00Z`) : new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return format.replace('YYYY', d.getUTCFullYear()).replace('MM', pad(d.getUTCMonth() + 1)).replace('DD', pad(d.getUTCDate()));
}

const templateRe = /\{\{\s*([\w.\[\]]+)\s*\}\}/g;
const blank = (v) => v === undefined || v === null || v === '';

/** All transforms. `v` is the current value; `t` the parameters; `rec` the whole canonical record */
const TRANSFORMS = {
    trim: (v) => (v == null ? v : String(v).trim()),
    upper: (v) => (v == null ? v : String(v).toUpperCase()),
    lower: (v) => (v == null ? v : String(v).toLowerCase()),
    title: (v) => (v == null ? v : String(v).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())),
    number: (v) => (blank(v) ? v : Number(v)),
    round: (v, t) => (blank(v) ? v : Math.round(Number(v) * 10 ** (t.digits ?? 2)) / 10 ** (t.digits ?? 2)),
    abs: (v) => (v == null ? v : Math.abs(Number(v))),
    negate: (v) => (v == null ? v : -Number(v)),
    bool: (v) => (typeof v === 'string' ? /^(true|yes|1|y|active)$/i.test(v) : Boolean(v)),
    string: (v) => (v == null ? v : String(v)),
    date: (v, t) => formatDate(v, t.format),
    const: (v, t) => t.value,
    default: (v, t) => (blank(v) ? t.value : v),
    template: (v, t, rec) => String(t.value).replace(templateRe, (m, p) => { const x = getPath(rec, p); return x === undefined || x === null ? '' : String(x); }).trim(),
    join: (v, t, rec) => (t.paths || []).map((p) => getPath(rec, p)).filter((x) => !blank(x)).join(t.sep ?? ' '),
    split: (v, t) => (v == null ? v : String(v).split(t.sep ?? ' ')[t.index ?? 0]),
    substr: (v, t) => (v == null ? v : String(v).substr(t.start ?? 0, t.length)),
    truncate: (v, t) => (v == null ? v : String(v).slice(0, t.length)),
    replace: (v, t) => (v == null ? v : String(v).replace(new RegExp(t.pattern, t.flags || 'g'), t.with ?? '')),
    lookup: (v, t) => { const m = t.map || {}; const k = String(v); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : (t.default !== undefined ? t.default : v); },
    padStart: (v, t) => (v == null ? v : String(v).padStart(t.length, t.char ?? '0')),
    digits: (v) => (v == null ? v : String(v).replace(/\D/g, ''))
};

const normalizeTransform = (t) => (typeof t === 'string' ? { fn: t } : t);

function runTransforms(value, transform, rec) {
    const list = Array.isArray(transform) ? transform : (transform ? [transform] : []);
    let v = value;
    for (const raw of list) {
        const t = normalizeTransform(raw);
        const fn = TRANSFORMS[t.fn];
        if (!fn) throw new Error(`unknown transform "${t.fn}"`);
        v = fn(v, t, rec);
    }
    return v;
}

/** Applies rules to a canonical record -> { value, errors } */
function applyMapping(rules, record) {
    const out = {}; const errors = [];
    for (const rule of rules || []) {
        if (rule.disabled) continue;
        try {
            let v = rule.source ? getPath(record, rule.source) : undefined;
            if (blank(v) && rule.default !== undefined) v = rule.default;
            v = runTransforms(v, rule.transform, record);
            if (blank(v) && rule.required) { errors.push(`${rule.target}: required value is missing (source ${rule.source || 'n/a'})`); continue; }
            if (v !== undefined) setPath(out, rule.target, v);
        } catch (e) { errors.push(`${rule.target}: ${e.message}`); }
    }
    return { value: out, errors };
}

/** Defaults + company overrides, matched by target */
function mergeMappings(defaults = [], overrides = []) {
    const map = new Map(defaults.map((r) => [r.target, { ...r }]));
    for (const o of overrides || []) {
        if (!o || !o.target) continue;
        if (o.disabled) { map.delete(o.target); continue; }
        map.set(o.target, { ...(map.get(o.target) || {}), ...o });
    }
    return [...map.values()];
}

/** Structural validation for the mapping editor. Returns a list of problems (empty when fine). */
function validateMapping(rules) {
    const errors = [];
    if (!Array.isArray(rules)) return ['mapping must be a list of rules'];
    if (rules.length > 200) errors.push('too many rules (max 200)');
    const seen = new Set();
    rules.forEach((r, i) => {
        const at = `rule ${i + 1}`;
        if (!r || typeof r !== 'object') { errors.push(`${at}: must be an object`); return; }
        if (!r.target || !/^[A-Za-z0-9_.\[\]]+$/.test(String(r.target))) errors.push(`${at}: target is required (letters, digits, . _ [ ])`);
        else if (seen.has(r.target)) errors.push(`${at}: duplicate target ${r.target}`); else seen.add(r.target);
        if (r.source !== undefined && !/^[A-Za-z0-9_.\[\]]*$/.test(String(r.source))) errors.push(`${at}: source path is not valid`);
        const list = Array.isArray(r.transform) ? r.transform : (r.transform ? [r.transform] : []);
        for (const t of list) {
            const n = normalizeTransform(t);
            if (!n || !TRANSFORMS[n.fn]) errors.push(`${at}: unknown transform "${n && n.fn}"`);
            if (n && n.fn === 'replace') { try { new RegExp(n.pattern); } catch (_) { errors.push(`${at}: replace pattern is not a valid expression`); } }
        }
    });
    return errors;
}

module.exports = { getPath, setPath, formatDate, TRANSFORMS, runTransforms, applyMapping, mergeMappings, validateMapping };
