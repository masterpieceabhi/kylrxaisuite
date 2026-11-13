/**
 * SCIM 2.0 server, mounted at /scim/v2 (public path: its own Bearer-token auth, one token per
 * company). Okta, Microsoft Entra ID and Google Workspace provision users here.
 * Users: list (filter, paging), get, create, replace, patch, delete (= deactivate, never a hard delete).
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { runWithTenant } = require('../config/tenant');
const logger = require('../utils/logger');
const S = require('../services/scim');
const people = require('../services/person-store');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();

router.use(express.json({ type: ['application/json', 'application/scim+json'], limit: '1mb' }));
router.use((req, res, next) => { res.type('application/scim+json'); res.set('Cache-Control', 'no-store'); next(); });

const err = (res, status, detail, scimType) => res.status(status).json(S.scimError(status, detail, scimType));

/* ---------------------------- token management ---------------------------- */

async function createToken(orgId, name, actor) {
    const token = `scim_${crypto.randomBytes(24).toString('hex')}`;
    const id = sha256(token);
    await rawCollection('scim_tokens').doc(id).create({ orgId, name: String(name || 'Identity provider').slice(0, 80), prefix: token.slice(0, 9), last4: token.slice(-4), createdAt: nowIso(), createdBy: actor || null, revokedAt: null, lastUsedAt: null });
    return { token, id, prefix: token.slice(0, 9) };
}
async function listTokens(orgId) {
    const snap = await rawCollection('scim_tokens').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, name: d.data().name, prefix: d.data().prefix, last4: d.data().last4, created_at: d.data().createdAt, last_used_at: d.data().lastUsedAt, revoked_at: d.data().revokedAt }))
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
async function revokeToken(orgId, id) {
    const ref = rawCollection('scim_tokens').doc(String(id)); const s = await ref.get();
    if (!exists(s) || s.data().orgId !== orgId) return false;
    await ref.update({ revokedAt: nowIso() });
    return true;
}

async function authenticate(req, res, next) {
    const m = (req.get('Authorization') || '').match(/^Bearer\s+(scim_[0-9a-f]{48})$/i);
    if (!m) { res.set('WWW-Authenticate', 'Bearer'); return err(res, 401, 'A SCIM bearer token is required'); }
    const ref = rawCollection('scim_tokens').doc(sha256(m[1])); const snap = await ref.get();
    if (!exists(snap) || snap.data().revokedAt) { res.set('WWW-Authenticate', 'Bearer'); return err(res, 401, 'The SCIM token is not valid'); }
    req.orgId = snap.data().orgId;
    ref.update({ lastUsedAt: nowIso() }).catch(() => {});
    return runWithTenant(req.orgId, next);
}

const base = (req) => `${req.protocol}://${req.get('host')}/scim/v2`;
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { logger.error(`scim ${req.method} ${req.path}: ${e.message}`); if (!res.headersSent) err(res, 500, 'Internal error'); });

/* ----------------------------- discovery (public) ----------------------------- */

router.get('/ServiceProviderConfig', (req, res) => res.json({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'], documentationUri: `${req.protocol}://${req.get('host')}/developer.html`,
    patch: { supported: true }, bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 }, filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false }, sort: { supported: false }, etag: { supported: false },
    authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'One long-lived token per company, created in Integrations > SCIM', primary: true }]
}));
const userType = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: S.SCHEMA_USER, schemaExtensions: [{ schema: S.SCHEMA_ENT, required: false }] };
router.get('/ResourceTypes', (req, res) => res.json(S.listResponse([{ ...userType, meta: { resourceType: 'ResourceType', location: `${base(req)}/ResourceTypes/User` } }])));
router.get('/ResourceTypes/User', (req, res) => res.json({ ...userType, meta: { resourceType: 'ResourceType', location: `${base(req)}/ResourceTypes/User` } }));
const attr = (name, type = 'string', extra = {}) => ({ name, type, multiValued: false, required: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra });
const userSchema = {
    id: S.SCHEMA_USER, name: 'User', description: 'Employee',
    attributes: [attr('userName', 'string', { required: true, uniqueness: 'server' }), attr('displayName'), attr('title'), attr('active', 'boolean'),
        attr('name', 'complex', { subAttributes: [attr('givenName'), attr('familyName'), attr('formatted')] }),
        attr('emails', 'complex', { multiValued: true, subAttributes: [attr('value'), attr('type'), attr('primary', 'boolean')] }),
        attr('phoneNumbers', 'complex', { multiValued: true, subAttributes: [attr('value'), attr('type')] })]
};
router.get('/Schemas', (req, res) => res.json(S.listResponse([{ ...userSchema, meta: { resourceType: 'Schema', location: `${base(req)}/Schemas/${S.SCHEMA_USER}` } }])));
router.get('/Schemas/:id', (req, res) => (req.params.id === S.SCHEMA_USER ? res.json(userSchema) : err(res, 404, 'Schema not found')));

/* --------------------------------- users --------------------------------- */

router.use(authenticate);

async function allScimUsers(req) { const rows = await people.loadPeople(req.orgId); return rows.map((u) => ({ raw: u, scim: S.toScimUser(u, base(req)) })); }

router.get('/Users', wrap(async (req, res) => {
    let rows = await allScimUsers(req);
    if (req.query.filter) {
        let ast; try { ast = S.parseFilter(req.query.filter); } catch (e) { return err(res, 400, `Invalid filter: ${e.message}`, 'invalidFilter'); }
        rows = rows.filter((r) => S.evalFilter(ast, r.scim));
    }
    rows.sort((a, b) => String(a.scim.userName).localeCompare(String(b.scim.userName)));
    res.json(S.listResponse(rows.map((r) => r.scim), { startIndex: req.query.startIndex, count: req.query.count === undefined ? 100 : req.query.count }));
}));

router.get('/Users/:id', wrap(async (req, res) => {
    const f = await people.getPersonDoc(req.orgId, req.params.id);
    if (!f) return err(res, 404, `User ${req.params.id} not found`);
    res.json(S.toScimUser({ id: f.id, ...f.data }, base(req)));
}));

function canonicalFromBody(b) {
    const input = S.fromScimUser(b);
    if (!input.work_email && b.userName && String(b.userName).includes('@')) input.work_email = b.userName;
    return input;
}

router.post('/Users', wrap(async (req, res) => {
    const b = req.body || {};
    if (!Array.isArray(b.schemas) || !b.schemas.includes(S.SCHEMA_USER)) return err(res, 400, 'schemas must include the core User schema', 'invalidSyntax');
    if (!b.userName) return err(res, 400, 'userName is required', 'invalidValue');
    const input = canonicalFromBody(b);
    if (!input.hire_date) input.hire_date = nowIso().slice(0, 10);
    if (!input.first_name || !input.last_name) { const n = String(b.displayName || '').split(/\s+/); input.first_name = input.first_name || n[0]; input.last_name = input.last_name || n.slice(1).join(' ') || n[0]; }
    const active = b.active === undefined ? true : S.truthy(b.active);
    delete input.status;
    const r = await people.createPersonBasic(req.orgId, input, 'scim', 'scim');
    if (r.conflict) return err(res, 409, 'A user with that userName already exists', 'uniqueness');
    if (r.errors) return err(res, 400, r.errors.join('; '), 'invalidValue');
    let doc = r.person;
    if (b.externalId) await rawCollection('users').doc(doc.id).set({ externalId: String(b.externalId) }, { merge: true });
    if (!active) { const u = await people.updatePersonBasic(req.orgId, await people.getPersonDoc(req.orgId, doc.id), { status: 'inactive' }, 'scim', 'scim'); if (u.person) doc = u.person; }
    const full = (await people.getPersonDoc(req.orgId, doc.id));
    const out = S.toScimUser({ id: full.id, ...full.data }, base(req));
    res.status(201).set('Location', out.meta.location).json(out);
}));

async function applyChange(req, res, nextScim) {
    const f = await people.getPersonDoc(req.orgId, req.params.id);
    if (!f) return err(res, 404, `User ${req.params.id} not found`);
    const before = S.toScimUser({ id: f.id, ...f.data }, base(req));
    let next;
    try { next = nextScim(before); } catch (e) { if (e.scimFailure) return err(res, e.scimFailure.status, e.scimFailure.detail, e.scimFailure.scimType); throw e; }
    const input = S.diffToCanonical(before, next);
    if (Object.keys(input).length) {
        const r = await people.updatePersonBasic(req.orgId, f, input, 'scim', 'scim');
        if (r.readOnly) return err(res, 400, 'This record comes from a roster import and is read-only', 'mutability');
        if (r.conflict) return err(res, 409, r.conflict, 'uniqueness');
        if (r.errors) return err(res, 400, r.errors.join('; '), 'invalidValue');
    }
    const after = await people.getPersonDoc(req.orgId, f.id);
    return res.json(S.toScimUser({ id: after.id, ...after.data }, base(req)));
}

router.patch('/Users/:id', wrap(async (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.schemas) || !body.schemas.includes(S.SCHEMA_PATCH)) return err(res, 400, 'schemas must include the PatchOp message schema', 'invalidSyntax');
    return applyChange(req, res, (before) => { const p = S.applyPatch(before, body); if (p.error) throw Object.assign(new Error(p.error.detail), { scimFailure: p.error }); return p.user; });
}));

router.put('/Users/:id', wrap(async (req, res) => {
    const b = req.body || {};
    if (!b.userName) return err(res, 400, 'userName is required', 'invalidValue');
    return applyChange(req, res, (before) => ({ ...before, ...b, name: { ...(before.name || {}), ...(b.name || {}) }, [S.SCHEMA_ENT]: { ...(before[S.SCHEMA_ENT] || {}), ...(b[S.SCHEMA_ENT] || {}) } }));
}));

/** DELETE deactivates (reversible); a hard delete of HR records is never done through SCIM */
router.delete('/Users/:id', wrap(async (req, res) => {
    const f = await people.getPersonDoc(req.orgId, req.params.id);
    if (!f) return err(res, 404, `User ${req.params.id} not found`);
    const r = await people.updatePersonBasic(req.orgId, f, { status: 'inactive' }, 'scim', 'scim');
    if (r.readOnly) return err(res, 400, 'This record is read-only', 'mutability');
    return res.status(204).end();
}));

router.get('/Groups', (req, res) => res.json(S.listResponse([])));
router.post('/Groups', (req, res) => err(res, 501, 'Groups are not supported; departments come from HR'));

router.use((req, res) => err(res, 404, 'Not found'));

router.tokens = { createToken, listTokens, revokeToken };
module.exports = router;
