/**
 * Organization structure rules (pure): locations, departments, manager hierarchy, org chart, CSV bulk assign.
 * Location document fields are shared with other modules (time geofencing, FMLA worksite):
 *   { orgId, name, address{line1,line2,city,state,zip}, state, city, county, lat, lng, radiusMeters, timeZone, active, isHeadquarters }
 */
const { validateAddress } = require('./us-validation');

function validTimeZone(tz) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (_) { return false; }
}

const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

function validateLocation(input) {
    const errors = [];
    const b = input || {};
    const name = String(b.name || '').trim();
    if (!name) errors.push('name is required');
    if (name.length > 120) errors.push('name is too long');
    const a = validateAddress(b.address);
    errors.push(...a.errors);
    const lat = num(b.lat); const lng = num(b.lng);
    if ((lat === null) !== (lng === null)) errors.push('lat and lng must be given together');
    if (lat !== null && !(Number.isFinite(lat) && lat >= -90 && lat <= 90)) errors.push('lat must be between -90 and 90');
    if (lng !== null && !(Number.isFinite(lng) && lng >= -180 && lng <= 180)) errors.push('lng must be between -180 and 180');
    let radius = num(b.radiusMeters);
    if (radius === null) radius = 150;
    if (!(Number.isFinite(radius) && radius >= 10 && radius <= 5000)) errors.push('radiusMeters must be between 10 and 5000');
    const timeZone = String(b.timeZone || 'America/Chicago').trim();
    if (!validTimeZone(timeZone)) errors.push('timeZone is not a valid time zone');
    const value = {
        name,
        address: a.value,
        state: a.value ? a.value.state : '',
        city: a.value ? a.value.city : '',
        county: String(b.county || '').trim(),
        lat, lng,
        radiusMeters: radius,
        timeZone,
        active: b.active === undefined ? true : Boolean(b.active),
        isHeadquarters: Boolean(b.isHeadquarters)
    };
    return { errors, value };
}

function validateDepartment(input) {
    const errors = [];
    const b = input || {};
    const name = String(b.name || '').trim();
    if (!name) errors.push('name is required');
    if (name.length > 120) errors.push('name is too long');
    const code = String(b.code || '').trim().toUpperCase();
    if (code && !/^[A-Z0-9_-]{1,12}$/.test(code)) errors.push('code must be 1 to 12 letters, digits, dash or underscore');
    const value = {
        name, code,
        headId: b.headId ? String(b.headId) : null,
        costCenter: String(b.costCenter || '').trim().slice(0, 40),
        parentId: b.parentId ? String(b.parentId) : null
    };
    return { errors, value };
}

/** Would making `newParentId` the parent of `id` create a loop? `parentOf` is {id: parentId|null} */
function wouldCreateCycle(parentOf, id, newParentId) {
    if (!newParentId) return false;
    if (newParentId === id) return true;
    const seen = new Set();
    let cur = newParentId;
    while (cur) {
        if (cur === id) return true;
        if (seen.has(cur)) return true; // existing loop in the data: refuse to extend it
        seen.add(cur);
        cur = parentOf[cur] || null;
    }
    return false;
}

/** people: [{id, managerId}] */
const managerMap = (people) => Object.fromEntries(people.map((p) => [p.id, p.managerId || null]));

function directReports(people, managerId) {
    return people.filter((p) => p.managerId === managerId);
}

/** Everyone below a manager, any depth, with their level (1 = direct report). Safe against loops. */
function subtree(people, managerId) {
    const byManager = new Map();
    for (const p of people) {
        if (!p.managerId) continue;
        if (!byManager.has(p.managerId)) byManager.set(p.managerId, []);
        byManager.get(p.managerId).push(p);
    }
    const out = []; const seen = new Set([managerId]);
    let level = [managerId]; let depth = 0;
    while (level.length) {
        depth += 1;
        const next = [];
        for (const id of level) {
            for (const p of byManager.get(id) || []) {
                if (seen.has(p.id)) continue;
                seen.add(p.id);
                out.push({ ...p, level: depth });
                next.push(p.id);
            }
        }
        level = next;
    }
    return out;
}

/** The chain of managers above a person: [L1 manager, L2 manager, ...] */
function managerChain(people, id) {
    const byId = new Map(people.map((p) => [p.id, p]));
    const chain = []; const seen = new Set([id]);
    let cur = byId.get(id);
    while (cur && cur.managerId && !seen.has(cur.managerId)) {
        const m = byId.get(cur.managerId);
        if (!m) break;
        chain.push(m); seen.add(m.id); cur = m;
    }
    return chain;
}

/** Org chart as nested JSON. People whose manager is missing (or in a loop) become roots. */
function buildTree(people) {
    const ids = new Set(people.map((p) => p.id));
    const children = new Map();
    const roots = [];
    for (const p of people) {
        if (p.managerId && ids.has(p.managerId) && p.managerId !== p.id) {
            if (!children.has(p.managerId)) children.set(p.managerId, []);
            children.get(p.managerId).push(p);
        } else roots.push(p);
    }
    const placed = new Set();
    const build = (p) => {
        placed.add(p.id);
        const kids = (children.get(p.id) || []).filter((k) => !placed.has(k.id)).sort((a, b) => String(a.name).localeCompare(String(b.name))).map(build);
        return { ...p, directReports: kids.length, children: kids };
    };
    const tree = roots.sort((a, b) => String(a.name).localeCompare(String(b.name))).map(build);
    // anything left over is inside a loop in bad data: surface it as a root instead of hiding it
    for (const p of people) if (!placed.has(p.id)) tree.push(build(p));
    return tree;
}

/** Plain CSV parser (quotes, doubled quotes, CRLF). Returns array of objects keyed by the lowercased header. */
function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let q = false;
    const s = String(text || '').replace(/^﻿/, '');
    for (let i = 0; i < s.length; i += 1) {
        const c = s[i];
        if (q) {
            if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i += 1; } else q = false; } else cell += c;
        } else if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') {
            if (c === '\r' && s[i + 1] === '\n') i += 1;
            row.push(cell); cell = '';
            if (row.some((x) => x.trim() !== '')) rows.push(row);
            row = [];
        } else cell += c;
    }
    row.push(cell);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

/** Normalizes a bulk-assign row: { person, managerId?, workLocation?, department? } (the last three optional) */
function normalizeAssignRow(r) {
    const row = r || {};
    const pick = (...keys) => { for (const k of keys) if (row[k] !== undefined && String(row[k]).trim() !== '') return String(row[k]).trim(); return undefined; };
    const clearWord = (v) => (v !== undefined && /^(none|clear|-)$/i.test(v) ? null : v);
    return {
        person: pick('employee_id', 'employeeid', 'person', 'id', 'email'),
        manager: clearWord(pick('manager_id', 'manager', 'manager_employee_id', 'manager_email')),
        location: clearWord(pick('location', 'location_id', 'work_location', 'work_location_id')),
        department: clearWord(pick('department', 'department_id', 'dept', 'department_code'))
    };
}

module.exports = {
    validateLocation, validateDepartment, validTimeZone, wouldCreateCycle, managerMap, directReports,
    subtree, managerChain, buildTree, parseCsv, normalizeAssignRow
};
