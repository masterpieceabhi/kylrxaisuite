/**
 * Tags on people (pure). A company keeps one short list of tags (HR edits it); each person carries tag ids.
 * Tags are plain labels for sorting and filtering ("Bilingual", "Keyholder", "Night shift"). They are not for
 * protected or sensitive facts (health, immigration status, union membership): custom fields with visibility exist for that.
 */

const MAX_TAGS = 50;            // per company
const MAX_TAGS_PER_PERSON = 20;
const MAX_NAME_LENGTH = 24;
const COLORS = ['grey', 'blue', 'green', 'amber', 'red', 'purple'];

/** Same tag whatever the capitals or spacing: "Night  Shift" and "night shift" are one tag */
const nameKey = (name) => String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();

function validateTag(input) {
    const errors = [];
    const b = input || {};
    const name = String(b.name === undefined || b.name === null ? '' : b.name).trim().replace(/\s+/g, ' ');
    if (!name) errors.push('name is required');
    else if (name.length > MAX_NAME_LENGTH) errors.push(`name is too long (${MAX_NAME_LENGTH} characters at most)`);
    else if (!/^[\p{L}\p{N}][\p{L}\p{N} &/+.'#-]*$/u.test(name)) errors.push('name can use letters, numbers, spaces and & / + . \' # - and must start with a letter or number');
    const color = b.color === undefined || b.color === null || b.color === '' ? 'grey' : String(b.color);
    if (!COLORS.includes(color)) errors.push(`color must be one of: ${COLORS.join(', ')}`);
    return { errors, value: { name, color, key: nameKey(name) } };
}

/**
 * Can this tag be added to (or renamed within) the company list?
 * `existing` = [{ id, name }]; `selfId` = the tag being renamed, if any. Returns an error string or null.
 */
function listConflict(existing, value, selfId = null) {
    const rows = existing || [];
    if (rows.some((t) => t.id !== selfId && nameKey(t.name) === value.key)) return 'A tag with this name already exists';
    if (!selfId && rows.length >= MAX_TAGS) return `At most ${MAX_TAGS} tags are allowed. Remove one you no longer use first.`;
    return null;
}

/** The tag ids on a person that still exist in the company list, in a stable order, no repeats */
function cleanTagIds(personTagIds, companyTags) {
    const known = new Set((companyTags || []).map((t) => t.id));
    const out = [];
    for (const id of Array.isArray(personTagIds) ? personTagIds : []) {
        const s = String(id);
        if (known.has(s) && !out.includes(s)) out.push(s);
    }
    return out;
}

/**
 * Applies add/remove to a person's tag ids. Returns { errors, value, added, removed }.
 * Unknown ids in `add` are errors; removing a tag the person does not have is not an error (nothing happens).
 */
function applyChange(personTagIds, companyTags, { add = [], remove = [] } = {}) {
    const errors = [];
    const known = new Set((companyTags || []).map((t) => t.id));
    const toList = (v) => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]).map(String);
    const adds = [...new Set(toList(add))]; const removes = new Set(toList(remove));
    if (!adds.length && !removes.size) errors.push('send add and/or remove with at least one tag id');
    const unknown = adds.filter((id) => !known.has(id));
    if (unknown.length) errors.push(`not a tag of this company: ${unknown.join(', ')}`);
    if (adds.some((id) => removes.has(id))) errors.push('the same tag cannot be added and removed at once');
    const current = cleanTagIds(personTagIds, companyTags);
    const next = current.filter((id) => !removes.has(id));
    const added = [];
    for (const id of adds) { if (known.has(id) && !next.includes(id)) { next.push(id); added.push(id); } }
    if (next.length > MAX_TAGS_PER_PERSON) errors.push(`a person can have at most ${MAX_TAGS_PER_PERSON} tags`);
    return { errors, value: errors.length ? current : next, added: errors.length ? [] : added, removed: errors.length ? [] : current.filter((id) => removes.has(id)) };
}

/**
 * Filters people rows ({ tags: [ids] }) by tag ids. mode 'any' = has at least one, 'all' = has every one.
 * An empty filter returns everyone.
 */
function filterByTags(people, tagIds, mode = 'any') {
    const want = [...new Set((Array.isArray(tagIds) ? tagIds : [tagIds]).filter(Boolean).map(String))];
    if (!want.length) return people;
    return people.filter((p) => {
        const has = new Set(Array.isArray(p.tags) ? p.tags.map(String) : []);
        return mode === 'all' ? want.every((id) => has.has(id)) : want.some((id) => has.has(id));
    });
}

/** Turns "?tag=a,b" or "?tag=a&tag=b" into ids; names are accepted too (matched without caring about capitals) */
function resolveFilter(raw, companyTags) {
    const parts = (Array.isArray(raw) ? raw : [raw]).flatMap((v) => String(v === undefined || v === null ? '' : v).split(',')).map((s) => s.trim()).filter(Boolean);
    const ids = []; const unknown = [];
    for (const p of parts) {
        const t = (companyTags || []).find((x) => x.id === p) || (companyTags || []).find((x) => nameKey(x.name) === nameKey(p));
        if (t) { if (!ids.includes(t.id)) ids.push(t.id); } else unknown.push(p);
    }
    return { ids, unknown };
}

/** How many people carry each tag: { tagId: count } */
function countByTag(people, companyTags) {
    const out = Object.fromEntries((companyTags || []).map((t) => [t.id, 0]));
    for (const p of people || []) for (const id of cleanTagIds(p.tags, companyTags)) out[id] += 1;
    return out;
}

const sortTags = (tags) => [...(tags || [])].sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));

module.exports = { MAX_TAGS, MAX_TAGS_PER_PERSON, MAX_NAME_LENGTH, COLORS, nameKey, validateTag, listConflict, cleanTagIds, applyChange, filterByTags, resolveFilter, countByTag, sortTags };
