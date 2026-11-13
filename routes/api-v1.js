/**
 * Public REST API v1, mounted at /api/v1 (server.js).
 * Auth: API key or OAuth access token (Bearer). Tenant = the key's/token's company; nothing here
 * reads another company. See docs/API.md style notes in the OpenAPI document at /api/v1/openapi.json.
 *
 * Conventions: consistent error envelope, X-Request-Id, per-key rate limits with RateLimit-* headers,
 * cursor pagination + updated_since, ETag/If-None-Match/If-Match, Idempotency-Key on writes, ISO dates.
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { runWithTenant } = require('../config/tenant');
const logger = require('../utils/logger');
const auth = require('../services/api-auth');
const C = require('../services/canonical');
const people = require('../services/person-store');
const webhooks = require('../services/webhooks');
const events = require('../services/events');
const openapi = require('../services/openapi');
const timeRules = require('../services/time-rules');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const keyLimiter = auth.createLimiter();
const orgLimiter = auth.createLimiter();
const ORG_LIMIT = Number(process.env.API_ORG_RATE_LIMIT_PER_MINUTE) || 3000;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ------------------------------ plumbing ------------------------------ */

function requestId(req, res, next) {
    const inbound = String(req.get('X-Request-Id') || '');
    req.requestId = /^[A-Za-z0-9._-]{8,64}$/.test(inbound) ? inbound : `req_${crypto.randomBytes(10).toString('hex')}`;
    res.set('X-Request-Id', req.requestId);
    next();
}

function fail(req, res, status, code, message, details) {
    const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
    return res.status(status).json({ error: { type, code, message, ...(details ? { details } : {}), request_id: req.requestId } });
}

function accessLog(req, res, next) {
    const started = Date.now();
    res.on('finish', () => {
        if (!req.principal) return;
        rawCollection('api_access_log').add({
            orgId: req.principal.orgId, principalId: req.principal.id, principalName: req.principal.name, method: req.method, path: req.baseUrl + req.path,
            status: res.statusCode, ms: Date.now() - started, ip: req.ip, requestId: req.requestId, at: new Date().toISOString()
        }).catch(() => {});
    });
    next();
}

async function authenticate(req, res, next) {
    const h = req.get('Authorization') || '';
    const m = h.match(/^Bearer\s+(\S+)$/i);
    if (!m) { res.set('WWW-Authenticate', 'Bearer realm="kylrx-api"'); return fail(req, res, 401, 'missing_credentials', 'Send your API key or access token as "Authorization: Bearer <token>".'); }
    let result;
    try { result = await auth.authenticate(m[1], req.ip); } catch (e) { logger.error(`api auth failed: ${e.message}`); return fail(req, res, 500, 'internal_error', 'Could not check credentials'); }
    if (result.error) {
        const map = { invalid_token: [401, 'invalid_token', 'The API key or token is not valid.'], expired: [401, 'token_expired', 'The API key or token has expired.'], revoked: [401, 'token_revoked', 'The API key or token was revoked.'], ip_not_allowed: [403, 'ip_not_allowed', 'This key cannot be used from your IP address.'] };
        const [s, c, msg] = map[result.error];
        if (s === 401) res.set('WWW-Authenticate', `Bearer realm="kylrx-api", error="${c}"`);
        return fail(req, res, s, c, msg);
    }
    req.principal = result.principal; req.orgId = result.principal.orgId;
    // From here on, db.collection() calls are scoped to this company
    return runWithTenant(req.orgId, next);
}

function rateLimit(req, res, next) {
    const p = req.principal;
    const a = keyLimiter.hit(p.id, p.rateLimitPerMinute || 600);
    const b = orgLimiter.hit(`org:${p.orgId}`, ORG_LIMIT);
    const use = a.remaining <= b.remaining ? a : b;
    res.set({ 'RateLimit-Limit': String(use.limit), 'RateLimit-Remaining': String(use.remaining), 'RateLimit-Reset': String(use.resetSeconds), 'X-RateLimit-Limit': String(use.limit), 'X-RateLimit-Remaining': String(use.remaining), 'X-RateLimit-Reset': String(use.resetSeconds) });
    if (!a.allowed || !b.allowed) {
        res.set('Retry-After', String(use.resetSeconds));
        return fail(req, res, 429, 'rate_limited', `Rate limit exceeded${!b.allowed ? ' for your company' : ''}. Retry after ${use.resetSeconds} seconds.`);
    }
    return next();
}

const needScope = (scope) => (req, res, next) => {
    if (!scope || req.principal.scopes.includes(scope)) return next();
    return fail(req, res, 403, 'insufficient_scope', `This request needs the "${scope}" scope.`, [{ required_scope: scope, granted_scopes: req.principal.scopes }]);
};

/** Idempotency-Key on writes: same key + same body replays the first response */
async function idempotency(req, res, next) {
    const key = req.get('Idempotency-Key');
    if (!key) return next();
    if (key.length > 255) return fail(req, res, 400, 'invalid_idempotency_key', 'Idempotency-Key must be at most 255 characters.');
    const ref = rawCollection('api_idempotency').doc(sha256(`${req.orgId}:${req.principal.id}:${key}`));
    const reqHash = sha256(`${req.method} ${req.baseUrl}${req.path} ${JSON.stringify(req.body || {})}`);
    try {
        await ref.create({ orgId: req.orgId, state: 'processing', reqHash, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 24 * 3600e3).toISOString() });
    } catch (_) {
        const snap = await ref.get();
        const d = exists(snap) ? snap.data() : null;
        if (!d) return fail(req, res, 409, 'request_in_progress', 'Another request with this Idempotency-Key is in progress.');
        if (d.reqHash !== reqHash) return fail(req, res, 422, 'idempotency_key_reuse', 'This Idempotency-Key was already used with a different request.');
        if (d.state !== 'done') { res.set('Retry-After', '1'); return fail(req, res, 409, 'request_in_progress', 'Another request with this Idempotency-Key is in progress.'); }
        res.set('Idempotent-Replayed', 'true');
        if (d.headers) res.set(d.headers);
        return res.status(d.status).json(d.body);
    }
    const original = res.json.bind(res);
    res.json = (body) => {
        if (res.statusCode >= 500) ref.delete().catch(() => {});
        else ref.update({ state: 'done', status: res.statusCode, body, headers: { ...(res.get('ETag') ? { ETag: res.get('ETag') } : {}), ...(res.get('Location') ? { Location: res.get('Location') } : {}) } }).catch(() => {});
        return original(body);
    };
    return next();
}

/** JSON response with a content ETag; honours If-None-Match */
function send(req, res, body, status = 200, etag) {
    const tag = etag || people.etagOf(body);
    res.set('ETag', tag);
    if (req.method === 'GET' && (req.get('If-None-Match') || '').split(',').map((s) => s.trim().replace(/^W\//, '')).includes(tag)) return res.status(304).end();
    return res.status(status).json(body);
}

const wrap = (fn) => async (req, res) => {
    try { await fn(req, res); } catch (e) {
        logger.error(`api v1 ${req.method} ${req.path}: ${e.message}`);
        if (!res.headersSent) fail(req, res, 500, 'internal_error', 'Something went wrong on our side. Quote the request id if you contact support.');
    }
};

function auditWrite(req, action, targetId, extra) {
    rawCollection('organizations').doc(req.orgId).collection('audit_logs').add({ action, targetId, actorId: req.principal.id, actorRole: 'integration', at: new Date().toISOString(), ip: req.ip, requestId: req.requestId, ...extra }).catch(() => {});
}

/* ------------------------------ pagination ------------------------------ */

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s) => { try { const o = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); return typeof o.t === 'string' && typeof o.i === 'string' ? o : null; } catch (_) { return null; } };

/** Cursor pagination ordered by (updated_at, id). `updated_since` is inclusive so nothing is ever missed. */
function paginate(items, q, tsOf) {
    const limit = Math.min(200, Math.max(1, parseInt(q.limit, 10) || 50));
    let rows = items.map((x) => ({ x, t: tsOf(x) || '', i: String(x.id) }));
    if (q.updated_since) {
        const t = new Date(q.updated_since);
        if (Number.isNaN(t.getTime())) return { error: 'updated_since must be an ISO 8601 date-time' };
        const iso = t.toISOString(); rows = rows.filter((r) => r.t >= iso);
    }
    rows.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.i < b.i ? -1 : a.i > b.i ? 1 : 0));
    if (q.cursor) {
        const c = dec(q.cursor);
        if (!c) return { error: 'cursor is not valid' };
        rows = rows.filter((r) => r.t > c.t || (r.t === c.t && r.i > c.i));
    }
    const page = rows.slice(0, limit); const hasMore = rows.length > limit;
    return { data: page.map((r) => r.x), next_cursor: hasMore ? enc({ t: page[page.length - 1].t, i: page[page.length - 1].i }) : null, has_more: hasMore };
}

function listResponse(req, res, items, tsOf) {
    const p = paginate(items, req.query, tsOf);
    if (p.error) return fail(req, res, 400, 'invalid_parameter', p.error);
    return send(req, res, p);
}

const hasPay = (req) => req.principal.scopes.includes('pay:read');
const validDay = (v) => (v === undefined || C.realDate(v) ? true : false);

/* ------------------------------- handlers ------------------------------- */

const H = {};

H.me = async (req, res) => send(req, res, { data: { org_id: req.orgId, principal: { type: req.principal.type, id: req.principal.id, name: req.principal.name, scopes: req.principal.scopes }, rate_limit_per_minute: req.principal.rateLimitPerMinute, api_version: 'v1' } });

async function personList(req) {
    const q = req.query; const pay = hasPay(req);
    let rows = await people.loadPeople(req.orgId);
    if (q.status) rows = rows.filter((u) => C.personStatus(u.status) === q.status);
    if (q.email) rows = rows.filter((u) => String(u.email || '').toLowerCase() === String(q.email).toLowerCase());
    if (q.employee_number) rows = rows.filter((u) => u.employeeId === q.employee_number);
    const out = rows.map((u) => C.toPerson(u, { includePay: pay }));
    return out.filter((p) => (!q.org_unit_id || p.job.org_unit_id === q.org_unit_id) && (!q.location_id || p.job.location_id === q.location_id) && (!q.manager_id || p.job.manager_id === q.manager_id));
}

H.peopleList = async (req, res) => listResponse(req, res, await personList(req), (p) => p.updated_at);
H.jobsList = async (req, res) => {
    let rows = await people.loadPeople(req.orgId);
    if (req.query.status) rows = rows.filter((u) => C.personStatus(u.status) === req.query.status);
    return listResponse(req, res, rows.map((u) => C.toJob(u, { includePay: hasPay(req) })), (j) => j.updated_at);
};
H.peopleGet = async (req, res) => {
    const f = await people.getPersonDoc(req.orgId, req.params.id);
    if (!f) return fail(req, res, 404, 'not_found', 'No person with that id in your company.');
    return send(req, res, { data: C.toPerson({ id: f.id, ...f.data }, { includePay: hasPay(req) }) });
};

H.peopleCreate = async (req, res) => {
    const r = await people.createPersonBasic(req.orgId, req.body || {}, req.principal.name, 'api');
    if (r.errors) return fail(req, res, 400, 'validation_failed', 'The person could not be created.', r.errors);
    if (r.conflict) return fail(req, res, 409, 'conflict', r.conflict);
    const body = { data: C.toPerson(r.person, { includePay: hasPay(req) }) };
    auditWrite(req, 'api_person_created', r.person.id, { via: req.principal.name });
    res.set('Location', `${req.baseUrl}/people/${r.person.id}`);
    return send(req, res, body, 201);
};

H.peopleUpdate = async (req, res) => {
    const f = await people.getPersonDoc(req.orgId, req.params.id);
    if (!f) return fail(req, res, 404, 'not_found', 'No person with that id in your company.');
    const im = req.get('If-Match');
    if (im && im !== '*') {
        const current = people.etagOf({ data: C.toPerson({ id: f.id, ...f.data }, { includePay: hasPay(req) }) });
        if (!im.split(',').map((s) => s.trim().replace(/^W\//, '')).includes(current)) return fail(req, res, 412, 'precondition_failed', 'The record changed since you read it. GET it again and retry.');
    }
    const r = await people.updatePersonBasic(req.orgId, f, req.body || {}, req.principal.name, 'api');
    if (r.readOnly) return fail(req, res, 409, 'read_only_record', 'This person record comes from a roster import and cannot be edited through the API.');
    if (r.errors) return fail(req, res, 400, 'validation_failed', 'The update was not valid.', r.errors);
    if (r.conflict) return fail(req, res, 409, 'conflict', r.conflict);
    auditWrite(req, 'api_person_updated', f.id, { fields: r.changed });
    return send(req, res, { data: C.toPerson(r.person, { includePay: hasPay(req) }) });
};

async function orgData(req) {
    const [deps, locs, org, users] = await Promise.all([
        rawCollection('departments').where('orgId', '==', req.orgId).get().catch(() => ({ docs: [] })),
        rawCollection('locations').where('orgId', '==', req.orgId).get().catch(() => ({ docs: [] })),
        rawCollection('organizations').doc(req.orgId).get(),
        people.loadPeople(req.orgId)
    ]);
    return { deps: deps.docs.map((d) => ({ id: d.id, ...d.data() })), locs: locs.docs.map((d) => ({ id: d.id, ...d.data() })), org: exists(org) ? org.data() : {}, users };
}
H.orgUnits = async (req, res) => { const d = await orgData(req); return listResponse(req, res, C.buildOrgUnits(d.deps, d.users), (x) => x.updated_at); };
H.orgUnitGet = async (req, res) => { const d = await orgData(req); const u = C.buildOrgUnits(d.deps, d.users).find((x) => x.id === req.params.id); return u ? send(req, res, { data: u }) : fail(req, res, 404, 'not_found', 'No org unit with that id.'); };
H.locations = async (req, res) => { const d = await orgData(req); return listResponse(req, res, C.buildLocations(d.locs, d.users, d.org), (x) => x.updated_at); };
H.locationGet = async (req, res) => { const d = await orgData(req); const u = C.buildLocations(d.locs, d.users, d.org).find((x) => x.id === req.params.id); return u ? send(req, res, { data: u }) : fail(req, res, 404, 'not_found', 'No location with that id.'); };

H.timeList = async (req, res) => {
    const q = req.query;
    if (!validDay(q.from) || !validDay(q.to)) return fail(req, res, 400, 'invalid_parameter', 'from and to must be dates (YYYY-MM-DD).');
    const period = q.period || 'week';
    if (!['week', 'day'].includes(period)) return fail(req, res, 400, 'invalid_parameter', 'period must be week or day.');
    const snap = await rawCollection('timesheet_weeks').where('orgId', '==', req.orgId).get();
    let weeks = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((w) => w.status === 'approved');
    if (q.person_id) weeks = weeks.filter((w) => w.userId === q.person_id || String(w.id).startsWith(`${q.person_id}_`));
    if (period === 'week') {
        if (q.from) weeks = weeks.filter((w) => w.weekStart >= q.from);
        if (q.to) weeks = weeks.filter((w) => w.weekStart <= q.to);
        const entries = weeks.map((w) => C.toWeeklyTimeEntry(w, w));
        return listResponse(req, res, entries, (e) => e.updated_at);
    }
    if (!q.person_id || !q.from || !q.to) return fail(req, res, 400, 'invalid_parameter', 'Daily entries need person_id, from and to.');
    if ((new Date(`${q.to}T00:00:00Z`) - new Date(`${q.from}T00:00:00Z`)) / 86400000 > 62) return fail(req, res, 400, 'invalid_parameter', 'The date range is limited to 62 days.');
    const person = await people.getPersonDoc(req.orgId, q.person_id);
    if (!person) return fail(req, res, 404, 'not_found', 'No person with that id in your company.');
    const approvedStarts = new Set(weeks.map((w) => w.weekStart));
    const { punchesSince } = require('./time').helpers;
    const punches = (await punchesSince(req.orgId, person.id, new Date(`${q.from}T00:00:00Z`).toISOString())).filter((p) => p.localDate >= q.from && p.localDate <= q.to);
    const days = C.dailyFromPunches(punches).filter((d) => approvedStarts.has(timeRules.weekStart(d.date)));
    return send(req, res, { data: days.map((d) => C.toDailyTimeEntry(person.id, person.data.employeeId, d)), next_cursor: null, has_more: false });
};

H.timePost = async (req, res) => {
    const orgSnap = await rawCollection('organizations').doc(req.orgId).get();
    const allowed = exists(orgSnap) && orgSnap.data().integrationSettings && orgSnap.data().integrationSettings.allowTimeWrite === true;
    if (!allowed) return fail(req, res, 403, 'feature_disabled', 'Posting time entries through the API is turned off for this company. An admin can enable it in Integrations > Settings.');
    const b = req.body || {};
    if (!['in', 'out', 'break_start', 'break_end'].includes(b.type)) return fail(req, res, 400, 'validation_failed', 'type must be in, out, break_start or break_end.');
    const f = await people.getPersonDoc(req.orgId, b.person_id);
    if (!f || f.col !== 'users') return fail(req, res, 404, 'not_found', 'No person with that id in your company.');
    const at = b.at ? new Date(b.at) : new Date();
    if (Number.isNaN(at.getTime())) return fail(req, res, 400, 'validation_failed', 'at must be an ISO 8601 date-time.');
    if (at.getTime() > Date.now() + 5 * 60000) return fail(req, res, 400, 'validation_failed', 'at cannot be in the future.');
    const { orgInfo, punchesSince, weekIsLocked } = require('./time').helpers;
    const info = await orgInfo(req.orgId); const atIso = at.toISOString(); const localDate = timeRules.localDate(atIso, info.tz);
    if (await weekIsLocked(f.id, localDate)) return fail(req, res, 409, 'week_locked', 'That week is already approved.');
    const prior = (await punchesSince(req.orgId, f.id, new Date(at.getTime() - 8 * 86400000).toISOString())).filter((p) => p.at <= atIso);
    const code = timeRules.checkPunch(timeRules.stateOf(prior), b.type);
    if (code) return fail(req, res, 409, 'punch_not_allowed', `This punch is not allowed right now (${code}).`);
    const ref = await rawCollection('time_punches').add({ orgId: req.orgId, userId: f.id, employeeId: f.data.employeeId || null, type: b.type, at: atIso, localDate, tz: info.tz, source: 'api', deviceId: null, location: null, note: null, addedBy: `api:${req.principal.id}` });
    auditWrite(req, 'api_time_punch_posted', f.id, { type: b.type });
    return send(req, res, { data: { id: ref.id, person_id: f.id, type: b.type, at: atIso, local_date: localDate } }, 201);
};

H.leaveRequests = async (req, res) => {
    const q = req.query;
    const snap = await rawCollection('leave_requests').where('orgId', '==', req.orgId).get();
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (q.person_id) rows = rows.filter((r) => r.userId === q.person_id);
    if (q.status) rows = rows.filter((r) => r.status === q.status);
    if (q.from) rows = rows.filter((r) => String(r.endDate) >= q.from);
    if (q.to) rows = rows.filter((r) => String(r.startDate) <= q.to);
    return listResponse(req, res, rows.map(C.toLeaveRequest), (r) => r.updated_at);
};

H.leaveBalances = async (req, res) => {
    if (!req.query.person_id) return fail(req, res, 400, 'invalid_parameter', 'person_id is required.');
    const f = await people.getPersonDoc(req.orgId, req.query.person_id);
    if (!f) return fail(req, res, 404, 'not_found', 'No person with that id in your company.');
    const { balanceFor, loadPolicies } = require('./us-leave').helpers; const { orgInfo } = require('./time').helpers;
    const L = require('../services/leave-rules');
    const info = await orgInfo(req.orgId); const emp = { id: f.id, data: f.data };
    const policies = (await loadPolicies(req.orgId)).filter((p) => L.appliesTo(p, f.data.usProfile));
    const data = [];
    for (const p of policies) { const r = await balanceFor(req.orgId, emp, p, info); if (!r.error) data.push(C.toLeaveBalance({ id: f.id, employeeId: f.data.employeeId }, p, r.balance, r.asOf)); }
    return send(req, res, { data, next_cursor: null, has_more: false });
};

H.payResults = async (req, res) => {
    const q = req.query;
    const snap = await rawCollection('pay_results').where('orgId', '==', req.orgId).get().catch(() => ({ docs: [] }));
    let rows = snap.docs.map((d) => C.toPayResult({ id: d.id, ...d.data() }));
    if (q.person_id) rows = rows.filter((r) => r.person_id === q.person_id);
    if (q.from) rows = rows.filter((r) => (r.pay_date || '') >= q.from);
    if (q.to) rows = rows.filter((r) => (r.pay_date || '') <= q.to);
    return listResponse(req, res, rows, (r) => r.updated_at);
};

H.documents = async (req, res) => {
    const q = req.query;
    const snap = await rawCollection('vault_documents').where('orgId', '==', req.orgId).get();
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter(C.isDocumentVisible);
    if (q.person_id) rows = rows.filter((r) => r.userId === q.person_id);
    if (q.category) rows = rows.filter((r) => r.category === q.category);
    return listResponse(req, res, rows.map(C.toDocumentMeta), (r) => r.updated_at);
};

H.webhookList = async (req, res) => send(req, res, { data: (await webhooks.listEndpoints(req.orgId)).filter((w) => w.source === 'api' || w.source === 'zapier') });
H.webhookCreate = async (req, res) => {
    const r = await webhooks.createEndpoint(req.orgId, { url: (req.body || {}).url, description: (req.body || {}).description, events: (req.body || {}).events, source: 'api' }, `api:${req.principal.id}`);
    if (r.errors) return fail(req, res, 400, 'validation_failed', 'The webhook could not be created.', r.errors);
    auditWrite(req, 'api_webhook_created', r.id, { url_host: new URL(r.endpoint.url).host });
    return res.status(201).json({ data: { ...r.endpoint, secret: r.secret }, note: 'The signing secret is shown only once.' });
};
H.webhookDelete = async (req, res) => {
    const ep = await webhooks.loadEndpoint(req.orgId, req.params.id);
    if (!ep || !['api', 'zapier'].includes(ep.data.source)) return fail(req, res, 404, 'not_found', 'No webhook with that id.');
    await webhooks.deleteEndpoint(req.orgId, req.params.id);
    auditWrite(req, 'api_webhook_deleted', req.params.id, {});
    return res.status(204).end();
};

/* ------------------------- Zapier / Make triggers ------------------------- */

const TRIGGERS = {
    new_person: { label: 'New person', scope: 'people:read', event: 'person.created', load: async (req) => (await personList(req)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))), sample: { object: 'person', id: 'sample_person_1', employee_number: 'EMP0042', status: 'active', first_name: 'Sam', last_name: 'Sample', work_email: 'sam@example.com', hire_date: '2026-01-05', job: { title: 'Analyst' } } },
    person_updated: { label: 'Person updated', scope: 'people:read', event: 'person.updated', load: async (req) => (await personList(req)).sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))).map((p) => ({ ...p, record_id: p.id, id: `${p.id}:${p.updated_at}` })), sample: { id: 'sample_person_1:2026-01-06T10:00:00.000Z', record_id: 'sample_person_1', object: 'person', status: 'active', work_email: 'sam@example.com' } },
    person_terminated: { label: 'Person terminated', scope: 'people:read', event: 'person.terminated', load: async (req) => (await personList(req)).filter((p) => p.status === 'terminated').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))), sample: { object: 'person', id: 'sample_person_2', status: 'terminated', termination_date: '2026-02-01' } },
    leave_requested: { label: 'Time off requested', scope: 'leave:read', event: 'leave.requested', load: async (req) => (await leaveRows(req)).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))), sample: { object: 'leave_request', id: 'sample_leave_1', person_id: 'sample_person_1', leave_type: 'pto', start_date: '2026-03-02', end_date: '2026-03-03', hours: 16, status: 'pending' } },
    leave_approved: { label: 'Time off approved', scope: 'leave:read', event: 'leave.approved', load: async (req) => (await leaveRows(req)).filter((r) => r.status === 'approved').sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at))), sample: { object: 'leave_request', id: 'sample_leave_1', person_id: 'sample_person_1', status: 'approved', hours: 16 } },
    timesheet_approved: { label: 'Timesheet approved', scope: 'time:read', event: 'timesheet.approved', load: async (req) => { const s = await rawCollection('timesheet_weeks').where('orgId', '==', req.orgId).get(); return s.docs.map((d) => C.toWeeklyTimeEntry({ id: d.id, ...d.data() }, d.data())).filter((e) => e.status === 'approved').sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at))); }, sample: { object: 'time_entry', id: 'sample_person_1_2026-02-02', period: 'week', hours: { worked: 41.5, regular: 40, overtime: 1.5, double_time: 0 }, status: 'approved' } }
};
async function leaveRows(req) { const s = await rawCollection('leave_requests').where('orgId', '==', req.orgId).get(); return s.docs.map((d) => C.toLeaveRequest({ id: d.id, ...d.data() })); }

H.triggerCatalog = async (req, res) => res.json(Object.entries(TRIGGERS).map(([key, t]) => ({ key, label: t.label, required_scope: t.scope, rest_hook_event: t.event, poll_url: `${req.baseUrl}/triggers/${key}`, sample_url: `${req.baseUrl}/triggers/${key}?sample=true` })));
H.triggerPoll = async (req, res) => {
    const t = TRIGGERS[req.params.name];
    if (!t) return fail(req, res, 404, 'not_found', 'Unknown trigger.');
    if (!req.principal.scopes.includes(t.scope)) return fail(req, res, 403, 'insufficient_scope', `This trigger needs the "${t.scope}" scope.`, [{ required_scope: t.scope }]);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    if (req.query.sample === 'true') return res.json([t.sample]);
    const rows = (await t.load(req)).slice(0, limit);
    return res.json(rows.length ? rows : [t.sample]); // Zapier/Make need at least one item to map fields while building a zap
};
H.hookSubscribe = async (req, res) => {
    const b = req.body || {}; const name = String(b.trigger || b.event || '');
    const t = TRIGGERS[name]; const eventType = t ? t.event : name;
    if (!t && !/^[a-z]+\.[a-z_.*]+$/.test(eventType)) return fail(req, res, 400, 'validation_failed', 'trigger must be one of the trigger keys or an event type.');
    const r = await webhooks.createEndpoint(req.orgId, { url: b.target_url || b.url, description: `REST hook: ${name}`, events: [eventType], source: 'zapier' }, `api:${req.principal.id}`);
    if (r.errors) return fail(req, res, 400, 'validation_failed', 'The hook could not be created.', r.errors);
    return res.status(201).json({ id: r.id, secret: r.secret, event: eventType });
};
H.hookUnsubscribe = H.webhookDelete;
H.actionCatalog = async (req, res) => res.json([
    { key: 'create_person', label: 'Create person', required_scope: 'people:write', method: 'POST', url: `${req.baseUrl}/actions/create_person` },
    { key: 'update_person', label: 'Update person', required_scope: 'people:write', method: 'POST', url: `${req.baseUrl}/actions/update_person`, note: 'Body: person_id plus the fields to change' }
]);
H.actionUpdatePerson = async (req, res) => { req.params.id = String((req.body || {}).person_id || ''); const { person_id, ...rest } = req.body || {}; req.body = rest; return H.peopleUpdate(req, res); };

/* ------------------------------- route table ------------------------------- */

const LIST_Q = ['limit', 'cursor', 'updated_since'];
const ROUTES = [
    { id: 'whoami', method: 'GET', path: '/me', tag: 'Account', summary: 'Who am I? Returns the company, scopes and rate limit of the credential', scope: null, h: H.me, rawResponse: { type: 'object', properties: { data: { type: 'object' } } } },
    { id: 'listPeople', method: 'GET', path: '/people', tag: 'People', scope: 'people:read', summary: 'List people', list: true, response: 'Person', query: [...LIST_Q, 'status', 'email', 'employee_number', 'org_unit_id', 'location_id', 'manager_id'], h: H.peopleList },
    { id: 'getPerson', method: 'GET', path: '/people/:id', tag: 'People', scope: 'people:read', summary: 'Get a person by id or employee number', response: 'Person', h: H.peopleGet },
    { id: 'createPerson', method: 'POST', path: '/people', tag: 'People', scope: 'people:write', summary: 'Create a person (basic fields; no pay, tax or ID data)', write: true, body: 'PersonInput', response: 'Person', status: 201, h: H.peopleCreate },
    { id: 'updatePerson', method: 'PATCH', path: '/people/:id', tag: 'People', scope: 'people:write', summary: 'Update basic fields, or terminate / reactivate with status', write: true, ifMatch: true, body: 'PersonInput', response: 'Person', h: H.peopleUpdate },
    { id: 'listJobs', method: 'GET', path: '/jobs', tag: 'People', scope: 'people:read', summary: 'List primary jobs (position, manager, classification)', list: true, response: 'Job', query: [...LIST_Q, 'status'], h: H.jobsList },
    { id: 'listOrgUnits', method: 'GET', path: '/org-units', tag: 'Organization', scope: 'org:read', summary: 'List org units (departments)', list: true, response: 'OrgUnit', query: LIST_Q, h: H.orgUnits },
    { id: 'getOrgUnit', method: 'GET', path: '/org-units/:id', tag: 'Organization', scope: 'org:read', summary: 'Get an org unit', response: 'OrgUnit', h: H.orgUnitGet },
    { id: 'listLocations', method: 'GET', path: '/locations', tag: 'Organization', scope: 'org:read', summary: 'List locations', list: true, response: 'Location', query: LIST_Q, h: H.locations },
    { id: 'getLocation', method: 'GET', path: '/locations/:id', tag: 'Organization', scope: 'org:read', summary: 'Get a location', response: 'Location', h: H.locationGet },
    { id: 'listTimeEntries', method: 'GET', path: '/time-entries', tag: 'Time', scope: 'time:read', summary: 'Approved weekly hours (period=week) or daily hours of one person (period=day)', list: true, response: 'TimeEntry', query: [...LIST_Q, { name: 'period', in: 'query', schema: { type: 'string', enum: ['week', 'day'] } }, { name: 'person_id', in: 'query', schema: { type: 'string' } }, { name: 'from', in: 'query', schema: { type: 'string', format: 'date' } }, { name: 'to', in: 'query', schema: { type: 'string', format: 'date' } }], h: H.timeList },
    { id: 'postTimeEntry', method: 'POST', path: '/time-entries', tag: 'Time', scope: 'time:write', summary: 'Post a clock punch (off by default; a company admin must enable it)', write: true, body: 'TimeEntryInput', rawResponse: { type: 'object', properties: { data: { type: 'object' } } }, status: 201, h: H.timePost },
    { id: 'listLeaveRequests', method: 'GET', path: '/leave/requests', tag: 'Leave', scope: 'leave:read', summary: 'List time-off requests', list: true, response: 'LeaveRequest', query: [...LIST_Q, 'person_id', 'status', 'from', 'to'], h: H.leaveRequests },
    { id: 'listLeaveBalances', method: 'GET', path: '/leave/balances', tag: 'Leave', scope: 'leave:read', summary: 'Time-off balances of one person', list: true, response: 'LeaveBalance', query: [{ name: 'person_id', in: 'query', required: true, schema: { type: 'string' } }], h: H.leaveBalances },
    { id: 'listPayResults', method: 'GET', path: '/pay-results', tag: 'Pay', scope: 'pay:read', summary: 'Pay results from the payroll provider (empty until the provider module is connected)', list: true, response: 'PayResult', query: [...LIST_Q, 'person_id', 'from', 'to'], h: H.payResults },
    { id: 'listDocuments', method: 'GET', path: '/documents', tag: 'Documents', scope: 'documents:read', summary: 'Document metadata (never the file)', list: true, response: 'Document', query: [...LIST_Q, 'person_id', 'category'], h: H.documents },
    { id: 'listWebhooks', method: 'GET', path: '/webhooks', tag: 'Webhooks', scope: 'webhooks:manage', summary: 'List webhooks created through the API', response: 'Webhook', rawResponse: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Webhook' } } } }, h: H.webhookList },
    { id: 'createWebhook', method: 'POST', path: '/webhooks', tag: 'Webhooks', scope: 'webhooks:manage', summary: 'Subscribe to events; the signing secret is returned once', write: true, body: 'WebhookInput', response: 'Webhook', status: 201, h: H.webhookCreate },
    { id: 'deleteWebhook', method: 'DELETE', path: '/webhooks/:id', tag: 'Webhooks', scope: 'webhooks:manage', summary: 'Delete a webhook', status: 204, h: H.webhookDelete },
    { id: 'listTriggers', method: 'GET', path: '/triggers', tag: 'Automation (Zapier / Make)', scope: 'people:read', summary: 'Trigger catalog', h: H.triggerCatalog, rawResponse: { type: 'array', items: { type: 'object' } }, noScope: true },
    { id: 'pollTrigger', method: 'GET', path: '/triggers/:name', tag: 'Automation (Zapier / Make)', scope: null, summary: 'Polling trigger: newest first, bare array, sample data when empty (?sample=true forces it)', query: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }, { name: 'sample', in: 'query', schema: { type: 'boolean' } }], h: H.triggerPoll, rawResponse: { type: 'array', items: { type: 'object' } } },
    { id: 'subscribeHook', method: 'POST', path: '/hooks/subscribe', tag: 'Automation (Zapier / Make)', scope: 'webhooks:manage', summary: 'REST hook subscribe (body: trigger, target_url)', write: true, status: 201, h: H.hookSubscribe, rawResponse: { type: 'object' } },
    { id: 'unsubscribeHook', method: 'DELETE', path: '/hooks/:id', tag: 'Automation (Zapier / Make)', scope: 'webhooks:manage', summary: 'REST hook unsubscribe', status: 204, h: H.hookUnsubscribe },
    { id: 'listActions', method: 'GET', path: '/actions', tag: 'Automation (Zapier / Make)', scope: 'people:write', summary: 'Action catalog', h: H.actionCatalog, rawResponse: { type: 'array', items: { type: 'object' } } },
    { id: 'actionCreatePerson', method: 'POST', path: '/actions/create_person', tag: 'Automation (Zapier / Make)', scope: 'people:write', summary: 'Action: create a person (same as POST /people)', write: true, body: 'PersonInput', response: 'Person', status: 201, h: H.peopleCreate },
    { id: 'actionUpdatePerson', method: 'POST', path: '/actions/update_person', tag: 'Automation (Zapier / Make)', scope: 'people:write', summary: 'Action: update a person (body: person_id + fields)', write: true, body: 'PersonInput', response: 'Person', h: H.actionUpdatePerson }
];

for (const r of ROUTES) {
    const chain = [requestId, authenticate, accessLog, rateLimit];
    // pollTrigger/listTriggers do their own scope check (the scope depends on the trigger)
    if (r.scope && !r.noScope) chain.push(needScope(r.scope));
    if (r.write) chain.push(idempotency);
    router[r.method.toLowerCase()](`${r.path}`, ...chain, wrap(r.h));
}

router.get('/openapi.json', requestId, (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    res.set('Cache-Control', 'public, max-age=60');
    res.json(openapi.build(ROUTES, { baseUrl: base }));
});

router.routes = ROUTES;
router.helpers = { paginate, fail, requestId, authenticate, rateLimit, TRIGGERS };
module.exports = router;
