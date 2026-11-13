/**
 * SCIM 2.0 (RFC 7643/7644) helpers, pure: filter parser, user mapping, PATCH engine, list responses.
 * Written to cope with the quirks of Okta, Microsoft Entra ID and Google Workspace provisioning
 * (path-less PATCH values, dotted attribute keys, "True"/"False" strings, case differences in op names).
 */
const C = require('./canonical');

const SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCHEMA_ENT = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

const scimError = (status, detail, scimType) => ({ schemas: [SCHEMA_ERROR], status: String(status), ...(scimType ? { scimType } : {}), detail });

const truthy = (v) => (typeof v === 'string' ? /^true$/i.test(v) : Boolean(v));

/* --------------------------------- filter --------------------------------- */

function tokenize(s) {
    const tokens = []; const re = /\s*(\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+)/y; let m;
    re.lastIndex = 0;
    while (re.lastIndex < s.length && (m = re.exec(s))) tokens.push(m[1]);
    return tokens;
}

/** Parses a SCIM filter into an AST; throws Error('invalidFilter: ...') */
function parseFilter(input) {
    const t = tokenize(String(input || '')); let i = 0;
    const bad = (m) => { const e = new Error(m); e.scimType = 'invalidFilter'; throw e; };
    function parseOr() { let l = parseAnd(); while (t[i] && t[i].toLowerCase() === 'or') { i++; l = { op: 'or', l, r: parseAnd() }; } return l; }
    function parseAnd() { let l = parseNot(); while (t[i] && t[i].toLowerCase() === 'and') { i++; l = { op: 'and', l, r: parseNot() }; } return l; }
    function parseNot() {
        if (t[i] && t[i].toLowerCase() === 'not') { i++; return { op: 'not', e: parsePrimary() }; }
        return parsePrimary();
    }
    function parsePrimary() {
        if (t[i] === '(') { i++; const e = parseOr(); if (t[i] !== ')') bad('missing )'); i++; return e; }
        const attr = t[i++]; const op = (t[i++] || '').toLowerCase();
        if (!attr || !op) bad('incomplete filter');
        if (op === 'pr') return { op: 'pr', attr };
        if (!['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'ge', 'lt', 'le'].includes(op)) bad(`unsupported operator ${op}`);
        let v = t[i++];
        if (v === undefined) bad('missing value');
        if (v.startsWith('"')) { try { v = JSON.parse(v); } catch (_) { bad('bad string'); } }
        else if (/^(true|false)$/i.test(v)) v = v.toLowerCase() === 'true';
        else if (v.toLowerCase() === 'null') v = null;
        else if (!Number.isNaN(Number(v))) v = Number(v);
        return { op, attr, value: v };
    }
    const ast = parseOr();
    if (i < t.length) bad('unexpected token');
    return ast;
}

function attrValues(obj, path) {
    let rest = String(path); let root = obj;
    const entPrefix = `${SCHEMA_ENT}:`;
    if (rest.toLowerCase().startsWith(entPrefix.toLowerCase())) { rest = rest.slice(entPrefix.length); root = obj[SCHEMA_ENT] || {}; }
    else if (rest.toLowerCase().startsWith(`${SCHEMA_USER}:`.toLowerCase())) rest = rest.slice(SCHEMA_USER.length + 1);
    let cur = [root];
    for (const p of rest.split('.')) {
        const next = [];
        for (const c of cur) {
            if (c === undefined || c === null) continue;
            const key = Object.keys(c).find((k) => k.toLowerCase() === p.toLowerCase());
            if (key === undefined) continue;
            const v = c[key]; Array.isArray(v) ? next.push(...v) : next.push(v);
        }
        cur = next;
    }
    return cur;
}

function evalFilter(ast, obj) {
    switch (ast.op) {
        case 'and': return evalFilter(ast.l, obj) && evalFilter(ast.r, obj);
        case 'or': return evalFilter(ast.l, obj) || evalFilter(ast.r, obj);
        case 'not': return !evalFilter(ast.e, obj);
        case 'pr': return attrValues(obj, ast.attr).some((v) => v !== null && v !== '');
        default: {
            const vals = attrValues(obj, ast.attr);
            const cmp = (a) => {
                const x = typeof a === 'string' && typeof ast.value === 'string' ? a.toLowerCase() : a;
                const y = typeof ast.value === 'string' ? ast.value.toLowerCase() : ast.value;
                switch (ast.op) {
                    case 'eq': return x === y; case 'ne': return x !== y;
                    case 'co': return String(x).includes(String(y)); case 'sw': return String(x).startsWith(String(y)); case 'ew': return String(x).endsWith(String(y));
                    case 'gt': return x > y; case 'ge': return x >= y; case 'lt': return x < y; case 'le': return x <= y;
                    default: return false;
                }
            };
            if (ast.op === 'ne') return vals.every(cmp);
            return vals.some(cmp);
        }
    }
}

/* ---------------------------------- mapping ---------------------------------- */

function toScimUser(user, baseUrl) {
    const p = C.toPerson(user);
    const out = {
        schemas: [SCHEMA_USER, SCHEMA_ENT], id: p.id, externalId: user.externalId || undefined, userName: p.work_email,
        name: { givenName: p.first_name || '', familyName: p.last_name || '', formatted: p.display_name || undefined },
        displayName: p.display_name || undefined, nickName: p.preferred_name || undefined,
        emails: p.work_email ? [{ value: p.work_email, type: 'work', primary: true }] : [],
        phoneNumbers: p.phone ? [{ value: p.phone, type: 'work' }] : undefined,
        title: p.job.title || undefined, active: p.status === 'active' || p.status === 'pending',
        [SCHEMA_ENT]: { employeeNumber: p.employee_number || undefined, department: p.job.org_unit_name || undefined, ...(p.job.manager_id ? { manager: { value: p.job.manager_id } } : {}) },
        meta: { resourceType: 'User', created: p.created_at || undefined, lastModified: p.updated_at || p.created_at || undefined, location: `${baseUrl}/Users/${p.id}` }
    };
    return JSON.parse(JSON.stringify(out));
}

/** SCIM user body -> canonical person input (only fields that are present) */
function fromScimUser(b) {
    const out = {}; const job = {};
    if (b.name) { if (b.name.givenName !== undefined) out.first_name = b.name.givenName; if (b.name.familyName !== undefined) out.last_name = b.name.familyName; }
    if (b.nickName !== undefined) out.preferred_name = b.nickName;
    const emails = Array.isArray(b.emails) ? b.emails : [];
    const primary = emails.find((e) => e.primary) || emails.find((e) => e.type === 'work') || emails[0];
    out.work_email = (primary && primary.value) || (b.userName && String(b.userName).includes('@') ? b.userName : undefined);
    if (out.work_email === undefined) delete out.work_email;
    const phones = Array.isArray(b.phoneNumbers) ? b.phoneNumbers : [];
    if (phones.length) out.phone = (phones.find((x) => x.type === 'work') || phones[0]).value;
    if (b.title !== undefined) job.title = b.title;
    const ent = b[SCHEMA_ENT];
    if (ent) {
        if (ent.department !== undefined) job.org_unit_name = ent.department;
        if (ent.manager !== undefined) job.manager_id = ent.manager && ent.manager.value ? ent.manager.value : null;
    }
    if (Object.keys(job).length) out.job = job;
    if (b.active !== undefined) out.status = truthy(b.active) ? 'active' : 'inactive';
    return out;
}

/* ----------------------------------- PATCH ----------------------------------- */

const ALIAS = { username: 'userName', displayname: 'displayName', nickname: 'nickName', title: 'title', active: 'active', externalid: 'externalId' };

function setPath(user, path, value, op) {
    let p = String(path || '').trim();
    const entPrefix = new RegExp(`^${SCHEMA_ENT.replace(/[.:]/g, '\\$&')}:`, 'i');
    if (entPrefix.test(p)) {
        p = p.replace(entPrefix, '');
        const ent = (user[SCHEMA_ENT] = user[SCHEMA_ENT] || {});
        const key = p.toLowerCase();
        if (key === 'manager' || key === 'manager.value') { if (op === 'remove') delete ent.manager; else ent.manager = { value: value && typeof value === 'object' ? value.value : value }; }
        else { const k = ['employeeNumber', 'department', 'costCenter', 'organization', 'division'].find((x) => x.toLowerCase() === key); if (k) { if (op === 'remove') delete ent[k]; else ent[k] = value; } }
        return;
    }
    let m = p.match(/^(emails|phoneNumbers)(?:\[(.+?)\])?(?:\.(\w+))?$/i);
    if (m) {
        const attr = /^emails$/i.test(m[1]) ? 'emails' : 'phoneNumbers'; user[attr] = user[attr] || [];
        const f = m[2] ? parseFilter(m[2]) : null; const sub = m[3] || 'value';
        if (op === 'remove') { user[attr] = f ? user[attr].filter((e) => !evalFilter(f, e)) : []; return; }
        if (!f && value && typeof value === 'object' && !Array.isArray(value)) { user[attr] = [value]; return; }
        if (!f && Array.isArray(value)) { user[attr] = op === 'add' ? [...user[attr], ...value] : value; return; }
        const target = f ? user[attr].find((e) => evalFilter(f, e)) : user[attr][0];
        if (target) target[sub] = value; else user[attr].push({ [sub]: value, type: 'work', primary: attr === 'emails' });
        return;
    }
    m = p.match(/^name\.(\w+)$/i);
    if (m) { user.name = user.name || {}; const k = ['givenName', 'familyName', 'formatted', 'middleName'].find((x) => x.toLowerCase() === m[1].toLowerCase()) || m[1]; if (op === 'remove') delete user.name[k]; else user.name[k] = value; return; }
    const key = ALIAS[p.toLowerCase()] || p;
    if (op === 'remove') delete user[key]; else user[key] = key === 'active' ? truthy(value) : value;
}

/** Applies RFC 7644 PatchOp operations. Returns { user } or { error: {status, detail, scimType} } */
function applyPatch(current, body) {
    if (!body || !Array.isArray(body.Operations) || !body.Operations.length) return { error: { status: 400, detail: 'Operations is required', scimType: 'invalidSyntax' } };
    const user = JSON.parse(JSON.stringify(current));
    try {
        for (const o of body.Operations) {
            const op = String(o.op || '').toLowerCase();
            if (!['add', 'replace', 'remove'].includes(op)) return { error: { status: 400, detail: `unsupported op ${o.op}`, scimType: 'invalidSyntax' } };
            if (!o.path) {
                if (op === 'remove') return { error: { status: 400, detail: 'remove needs a path', scimType: 'noTarget' } };
                for (const [k, v] of Object.entries(o.value || {})) {
                    if (k === SCHEMA_ENT && v && typeof v === 'object') for (const [ek, ev] of Object.entries(v)) setPath(user, `${SCHEMA_ENT}:${ek}`, ev, op);
                    else if (k === 'name' && v && typeof v === 'object') for (const [nk, nv] of Object.entries(v)) setPath(user, `name.${nk}`, nv, op);
                    else setPath(user, k, v, op);
                }
            } else setPath(user, o.path, o.value, op);
        }
    } catch (e) { return { error: { status: 400, detail: e.message, scimType: e.scimType || 'invalidPath' } }; }
    return { user };
}

/** Canonical input containing only what differs between two SCIM user representations */
function diffToCanonical(before, after) {
    const a = fromScimUser(before); const b = fromScimUser(after);
    const out = {}; const job = {};
    for (const [k, v] of Object.entries(b)) { if (k === 'job') continue; if (JSON.stringify(a[k]) !== JSON.stringify(v)) out[k] = v; }
    for (const [k, v] of Object.entries(b.job || {})) if (JSON.stringify((a.job || {})[k]) !== JSON.stringify(v)) job[k] = v;
    for (const k of Object.keys(a.job || {})) if (!(b.job && k in b.job)) job[k] = null;
    if (Object.keys(job).length) out.job = job;
    return out;
}

function listResponse(resources, { startIndex = 1, count = 100 } = {}) {
    const start = Math.max(1, parseInt(startIndex, 10) || 1); const c = Math.min(200, Math.max(0, parseInt(count, 10) || 0));
    const page = resources.slice(start - 1, start - 1 + c);
    return { schemas: [SCHEMA_LIST], totalResults: resources.length, startIndex: start, itemsPerPage: page.length, Resources: page };
}

module.exports = { SCHEMA_USER, SCHEMA_ENT, SCHEMA_LIST, SCHEMA_ERROR, SCHEMA_PATCH, scimError, parseFilter, evalFilter, toScimUser, fromScimUser, applyPatch, diffToCanonical, listResponse, truthy };
