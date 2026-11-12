// US-K10: SCIM 2.0 server. Pure helpers (filter, PATCH, mapping) and the real router over HTTP against an
// in-memory database: tokens, users list / get / create / patch / replace / deactivate, paging, and company separation.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const mem = require('./helpers/memory-firestore.js');
const { db, auth } = mem.install();
const S = require('../services/scim.js');
const express = require('express');
const scimRouter = require('../routes/scim.js');

const ENT = S.SCHEMA_ENT;

/* ------------------------------------ pure: filters ------------------------------------ */

const ada = {
    id: 'u1', userName: 'ada@example.com', externalId: 'ext-1', active: true, title: 'Engineer', displayName: 'Ada Lovelace',
    name: { givenName: 'Ada', familyName: 'Lovelace' }, emails: [{ value: 'ada@example.com', type: 'work', primary: true }, { value: 'ada@home.example', type: 'home' }],
    [ENT]: { employeeNumber: 'EMP0001', department: 'R&D', manager: { value: 'u9' } }, meta: { lastModified: '2026-03-01T00:00:00.000Z' }
};
const match = (f, obj = ada) => S.evalFilter(S.parseFilter(f), obj);

test('filter: the forms identity providers send', () => {
    assert.equal(match('userName eq "ada@example.com"'), true);
    assert.equal(match('userName eq "ADA@EXAMPLE.COM"'), true, 'text comparison ignores case');
    assert.equal(match('username EQ "ada@example.com"'), true, 'attribute and operator names ignore case');
    assert.equal(match('userName eq "bob@example.com"'), false);
    assert.equal(match('externalId eq "ext-1"'), true);
    assert.equal(match('active eq true'), true); assert.equal(match('active eq false'), false);
    assert.equal(match('emails.value eq "ada@home.example"'), true, 'any value of a multi-valued attribute can match');
    assert.equal(match('name.familyName sw "love"'), true);
    assert.equal(match('userName co "@example"'), true); assert.equal(match('userName ew ".org"'), false);
    assert.equal(match(`${ENT}:employeeNumber eq "EMP0001"`), true);
    assert.equal(match(`${ENT}:manager.value eq "u9"`), true);
    assert.equal(match(`${S.SCHEMA_USER}:userName eq "ada@example.com"`), true);
    assert.equal(match('meta.lastModified gt "2026-01-01T00:00:00Z"'), true);
    assert.equal(match('meta.lastModified le "2026-01-01T00:00:00Z"'), false);
    assert.equal(match('title pr'), true); assert.equal(match('nickName pr'), false);
    assert.equal(match('title ne "Manager"'), true); assert.equal(match('emails.value ne "ada@home.example"'), false);
});

test('filter: and / or / not / brackets, and quoted values with spaces and escapes', () => {
    assert.equal(match('active eq true and title eq "Engineer"'), true);
    assert.equal(match('active eq false or title eq "Engineer"'), true);
    assert.equal(match('active eq false and title eq "Engineer" or userName sw "ada"'), true, '"and" binds tighter than "or"');
    assert.equal(match('active eq false and (title eq "Engineer" or userName sw "ada")'), false);
    assert.equal(match('not (title eq "Engineer")'), false);
    assert.equal(match('displayName eq "Ada Lovelace"'), true);
    assert.equal(match('displayName eq "Ada \\"The Countess\\" Lovelace"', { displayName: 'Ada "The Countess" Lovelace' }), true);
    assert.equal(match('title eq "and"', { title: 'and' }), true, 'a keyword inside quotes is a value');
    assert.equal(match('count gt 5', { count: 7 }), true); assert.equal(match('count eq null', { count: null }), true);
});

test('filter: anything malformed is an invalidFilter error, never a crash or a match-everything', () => {
    for (const bad of ['', 'userName', 'userName eq', 'userName is "x"', '(userName eq "x"', 'userName eq "x" extra', 'userName eq "x" and', 'emails[type eq "work"].value eq "x"', 'userName eq "unterminated']) {
        assert.throws(() => S.parseFilter(bad), (e) => e.scimType === 'invalidFilter', `${JSON.stringify(bad)} is rejected`);
    }
});

/* ------------------------------------ pure: mapping ------------------------------------ */

const stored = { id: 'u1', orgId: 'orgA', employeeId: 'EMP0001', name: 'Ada Lovelace', email: 'ada@example.com', phone: '555-0100', status: 'Active', jobTitle: 'Engineer', departmentName: 'R&D', externalId: 'ext-1', createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z', password: '$2b$10$hash', usProfile: { managerId: 'u9', preferredName: 'Addie', taxpayerIdEncrypted: 'v1:xxxx', taxpayerIdLast4: '6789' } };

test('user record -> SCIM user: the right fields, and never pay, SSN or password data', () => {
    const u = S.toScimUser(stored, 'https://hr.example.com/scim/v2');
    assert.deepEqual(u.schemas, [S.SCHEMA_USER, ENT]);
    assert.equal(u.id, 'u1'); assert.equal(u.userName, 'ada@example.com'); assert.equal(u.externalId, 'ext-1'); assert.equal(u.active, true);
    assert.deepEqual(u.name, { givenName: 'Ada', familyName: 'Lovelace', formatted: 'Ada Lovelace' });
    assert.deepEqual(u.emails, [{ value: 'ada@example.com', type: 'work', primary: true }]);
    assert.deepEqual(u.phoneNumbers, [{ value: '555-0100', type: 'work' }]);
    assert.equal(u.title, 'Engineer'); assert.equal(u.nickName, 'Addie');
    assert.deepEqual(u[ENT], { employeeNumber: 'EMP0001', department: 'R&D', manager: { value: 'u9' } });
    assert.deepEqual(u.meta, { resourceType: 'User', created: '2026-01-05T00:00:00.000Z', lastModified: '2026-02-01T00:00:00.000Z', location: 'https://hr.example.com/scim/v2/Users/u1' });
    const text = JSON.stringify(u);
    for (const secret of ['$2b$10$hash', 'v1:xxxx', '6789', 'taxpayer', 'password', 'orgA']) assert.ok(!text.includes(secret), `${secret} is not exposed`);
    assert.equal(S.toScimUser({ ...stored, status: 'Terminated' }, 'x').active, false);
    assert.equal(S.toScimUser({ ...stored, status: 'Inactive' }, 'x').active, false);
});

test('SCIM user -> our fields: primary e-mail, userName fallback, manager, active as text', () => {
    assert.deepEqual(S.fromScimUser({ userName: 'x', name: { givenName: 'Bo', familyName: 'Li' }, emails: [{ value: 'home@x.com', type: 'home' }, { value: 'work@x.com', type: 'work' }, { value: 'main@x.com', primary: true }], title: 'Clerk', active: 'False', [ENT]: { department: 'Ops', manager: { value: 'u2' } }, phoneNumbers: [{ value: '1', type: 'mobile' }, { value: '2', type: 'work' }] }),
        { first_name: 'Bo', last_name: 'Li', work_email: 'main@x.com', phone: '2', job: { title: 'Clerk', org_unit_name: 'Ops', manager_id: 'u2' }, status: 'inactive' });
    assert.deepEqual(S.fromScimUser({ userName: 'bo@x.com' }), { work_email: 'bo@x.com' });
    assert.deepEqual(S.fromScimUser({ userName: 'bo' }), {}, 'a userName that is not an e-mail address is not used as one');
    assert.deepEqual(S.fromScimUser({ [ENT]: { manager: null }, active: true }), { job: { manager_id: null }, status: 'active' });
    assert.equal(S.truthy('TRUE'), true); assert.equal(S.truthy('no'), false); assert.equal(S.truthy(false), false);
});

/* ------------------------------------- pure: PATCH ------------------------------------- */

const patched = (ops, from = ada) => S.applyPatch(from, { schemas: [S.SCHEMA_PATCH], Operations: ops });

test('PATCH: Okta style (no path, values in an object) and Entra ID style (paths, "False" as text, capitalised ops)', () => {
    assert.equal(patched([{ op: 'replace', value: { active: false } }]).user.active, false);
    assert.equal(patched([{ op: 'Replace', path: 'active', value: 'False' }]).user.active, false);
    assert.equal(patched([{ op: 'Add', path: 'active', value: 'True' }], { ...ada, active: false }).user.active, true);
    const many = patched([{ op: 'replace', value: { title: 'Lead', name: { familyName: 'Byron' }, [ENT]: { department: 'Math' }, displayName: 'Ada Byron' } }]).user;
    assert.equal(many.title, 'Lead'); assert.deepEqual(many.name, { givenName: 'Ada', familyName: 'Byron' }); assert.equal(many[ENT].department, 'Math'); assert.equal(many[ENT].employeeNumber, 'EMP0001');
    const paths = patched([{ op: 'replace', path: 'name.givenName', value: 'Augusta' }, { op: 'replace', path: `${ENT}:department`, value: 'Analysis' }, { op: 'replace', path: `${ENT}:manager`, value: 'u5' }, { op: 'add', path: 'emails[type eq "work"].value', value: 'ada@new.example' }, { op: 'replace', path: 'userName', value: 'ada@new.example' }]).user;
    assert.equal(paths.name.givenName, 'Augusta'); assert.equal(paths[ENT].department, 'Analysis'); assert.deepEqual(paths[ENT].manager, { value: 'u5' });
    assert.equal(paths.emails[0].value, 'ada@new.example'); assert.equal(paths.emails[1].value, 'ada@home.example'); assert.equal(paths.userName, 'ada@new.example');
    assert.deepEqual(patched([{ op: 'replace', path: `${ENT}:manager`, value: { value: 'u7' } }]).user[ENT].manager, { value: 'u7' });
});

test('PATCH: remove, multi-valued attributes, and the original is never changed', () => {
    const before = JSON.stringify(ada);
    assert.equal(patched([{ op: 'remove', path: 'title' }]).user.title, undefined);
    assert.equal(patched([{ op: 'remove', path: `${ENT}:manager` }]).user[ENT].manager, undefined);
    assert.deepEqual(patched([{ op: 'remove', path: 'emails[type eq "home"]' }]).user.emails.map((e) => e.value), ['ada@example.com']);
    assert.deepEqual(patched([{ op: 'remove', path: 'emails' }]).user.emails, []);
    assert.deepEqual(patched([{ op: 'add', path: 'emails', value: [{ value: 'third@example.com', type: 'other' }] }]).user.emails.length, 3);
    assert.deepEqual(patched([{ op: 'replace', path: 'emails', value: [{ value: 'only@example.com', type: 'work', primary: true }] }]).user.emails, [{ value: 'only@example.com', type: 'work', primary: true }]);
    assert.deepEqual(patched([{ op: 'add', path: 'phoneNumbers[type eq "work"].value', value: '555-0111' }]).user.phoneNumbers, [{ value: '555-0111', type: 'work', primary: false }]);
    assert.equal(JSON.stringify(ada), before);
});

test('PATCH: bad requests are refused with the SCIM error type', () => {
    assert.equal(S.applyPatch(ada, {}).error.scimType, 'invalidSyntax');
    assert.equal(S.applyPatch(ada, { Operations: [] }).error.status, 400);
    assert.equal(patched([{ op: 'move', path: 'title', value: 'x' }]).error.scimType, 'invalidSyntax');
    assert.equal(patched([{ op: 'remove' }]).error.scimType, 'noTarget');
    assert.equal(patched([{ op: 'replace', path: 'emails[type zz "work"].value', value: 'x' }]).error.scimType, 'invalidFilter');
    const stillOk = patched([{ op: 'replace', path: 'title', value: 'A' }, { op: 'remove' }]);
    assert.ok(stillOk.error, 'one bad operation rejects the whole request');
});

test('diff: only what changed is written back; a removed manager becomes null', () => {
    const next = patched([{ op: 'replace', value: { title: 'Lead', active: false } }, { op: 'remove', path: `${ENT}:manager` }]).user;
    assert.deepEqual(S.diffToCanonical(ada, next), { status: 'inactive', job: { title: 'Lead', manager_id: null } });
    assert.deepEqual(S.diffToCanonical(ada, JSON.parse(JSON.stringify(ada))), {});
});

test('list response: paging numbers follow the SCIM rules', () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ id: `u${i + 1}` }));
    assert.deepEqual(S.listResponse(all, { startIndex: 2, count: 2 }), { schemas: [S.SCHEMA_LIST], totalResults: 5, startIndex: 2, itemsPerPage: 2, Resources: [{ id: 'u2' }, { id: 'u3' }] });
    assert.equal(S.listResponse(all, { startIndex: 0, count: 100 }).startIndex, 1);
    assert.equal(S.listResponse(all, { startIndex: 9, count: 2 }).Resources.length, 0);
    assert.equal(S.listResponse(all, { count: 0 }).totalResults, 5, 'count=0 asks only for the total');
    assert.equal(S.listResponse(Array.from({ length: 500 }, () => ({})), { count: 9999 }).itemsPerPage, 200, 'a page is capped at 200');
    assert.deepEqual(S.scimError(404, 'nope'), { schemas: [S.SCHEMA_ERROR], status: '404', detail: 'nope' });
});

/* --------------------------------- the router over HTTP --------------------------------- */

let server; let base; let tokenA; let tokenB;
const app = express();
app.use('/scim/v2', scimRouter);

async function call(method, path, { token = tokenA, body, headers = {} } = {}) {
    const res = await fetch(`${base}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/scim+json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const newUser = (email, extra = {}) => ({ schemas: [S.SCHEMA_USER, ENT], userName: email, name: { givenName: 'Test', familyName: 'Person' }, emails: [{ value: email, type: 'work', primary: true }], active: true, ...extra });

test.before(async () => {
    mem.reset();
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/scim/v2`;
    tokenA = (await scimRouter.tokens.createToken('orgA', 'Okta', 'admin1')).token;
    tokenB = (await scimRouter.tokens.createToken('orgB', 'Entra', 'admin2')).token;
    await db.collection('users').doc('b_existing').set({ orgId: 'orgB', employeeId: 'EMP0001', name: 'Other Company', email: 'person@orgb.example', status: 'Active', createdAt: '2026-01-01T00:00:00.000Z' });
    await db.collection('employees').doc('a_roster').set({ orgId: 'orgA', employeeId: 'R-77', name: 'Roster Only', email: 'roster@orga.example', status: 'Active' });
});
// the short wait lets sockets finish closing: on Windows a forced exit (--test-force-exit) during that crashes Node
test.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 300)); });

test('tokens: stored as a hash, listed without the secret, revocable only by the owning company', async () => {
    assert.match(tokenA, /^scim_[0-9a-f]{48}$/);
    const docs = (await db.collection('scim_tokens').get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    assert.equal(docs.length, 2);
    assert.ok(!JSON.stringify(docs).includes(tokenA), 'the token itself is never stored');
    const list = await scimRouter.tokens.listTokens('orgA');
    assert.equal(list.length, 1); assert.equal(list[0].name, 'Okta'); assert.equal(list[0].last4, tokenA.slice(-4)); assert.equal(list[0].revoked_at, null);
    assert.equal(await scimRouter.tokens.revokeToken('orgB', list[0].id), false, 'another company cannot revoke it');
    assert.equal((await call('GET', '/Users')).status, 200);
});

test('authentication: no token, a wrong token and a revoked token are all refused; discovery is open', async () => {
    for (const token of [null, 'scim_' + '0'.repeat(48), 'not-a-scim-token', tokenA.slice(0, -1)]) {
        const r = await call('GET', '/Users', { token });
        assert.equal(r.status, 401); assert.deepEqual(r.body.schemas, [S.SCHEMA_ERROR]); assert.equal(r.headers.get('www-authenticate'), 'Bearer');
    }
    const extra = await scimRouter.tokens.createToken('orgA', 'Temp');
    assert.equal((await call('GET', '/Users', { token: extra.token })).status, 200);
    assert.equal(await scimRouter.tokens.revokeToken('orgA', extra.id), true);
    assert.equal((await call('GET', '/Users', { token: extra.token })).status, 401);
    const cfg = await call('GET', '/ServiceProviderConfig', { token: null });
    assert.equal(cfg.status, 200); assert.equal(cfg.body.patch.supported, true); assert.equal(cfg.body.bulk.supported, false);
    assert.match(cfg.headers.get('content-type'), /application\/scim\+json/); assert.equal(cfg.headers.get('cache-control'), 'no-store');
    assert.equal((await call('GET', '/ResourceTypes', { token: null })).body.Resources[0].id, 'User');
    assert.equal((await call('GET', `/Schemas/${S.SCHEMA_USER}`, { token: null })).body.name, 'User');
    assert.equal((await call('GET', '/Schemas/urn:nope', { token: null })).status, 404);
});

let adaId;

test('create: makes the person and their login, returns 201 with a Location, and does not leak a password', async () => {
    const r = await call('POST', '/Users', { body: newUser('Ada@OrgA.example', { name: { givenName: 'Ada', familyName: 'Lovelace' }, externalId: 'okta-001', title: 'Engineer', [ENT]: { department: 'R&D' }, phoneNumbers: [{ value: '555-0100', type: 'work' }] }) });
    assert.equal(r.status, 201);
    adaId = r.body.id;
    assert.equal(r.headers.get('location'), `${base}/Users/${adaId}`);
    assert.equal(r.body.userName, 'ada@orga.example'); assert.equal(r.body.active, true); assert.equal(r.body.externalId, 'okta-001');
    assert.equal(r.body.title, 'Engineer'); assert.equal(r.body[ENT].department, 'R&D'); assert.match(r.body[ENT].employeeNumber, /^EMP\d{4}$/);
    assert.ok(!/password|temporary/i.test(JSON.stringify(r.body)));
    const doc = (await db.collection('users').doc(adaId).get()).data();
    assert.equal(doc.orgId, 'orgA'); assert.equal(doc.role, 'employee'); assert.equal(doc.createdVia, 'scim'); assert.equal(doc.must_change_password, true);
    assert.equal((await auth.getUser(adaId)).customClaims.orgId, 'orgA');
});

test('create: validation, duplicates (409 uniqueness) and creating someone already switched off', async () => {
    assert.equal((await call('POST', '/Users', { body: { userName: 'x@orga.example' } })).body.scimType, 'invalidSyntax');
    assert.equal((await call('POST', '/Users', { body: { schemas: [S.SCHEMA_USER] } })).body.scimType, 'invalidValue');
    const noEmail = await call('POST', '/Users', { body: { schemas: [S.SCHEMA_USER], userName: 'not-an-email', name: { givenName: 'A', familyName: 'B' } } });
    assert.equal(noEmail.status, 400); assert.equal(noEmail.body.scimType, 'invalidValue');
    const dup = await call('POST', '/Users', { body: newUser('ada@orga.example') });
    assert.equal(dup.status, 409); assert.equal(dup.body.scimType, 'uniqueness');
    const other = await call('POST', '/Users', { body: newUser('person@orgb.example') });
    assert.equal(other.status, 409, 'an address used by another company cannot be taken over');
    const fromDisplay = await call('POST', '/Users', { body: { schemas: [S.SCHEMA_USER], userName: 'grace@orga.example', displayName: 'Grace Brewster Hopper', active: false } });
    assert.equal(fromDisplay.status, 201); assert.equal(fromDisplay.body.active, false);
    assert.deepEqual([fromDisplay.body.name.givenName, fromDisplay.body.name.familyName], ['Grace', 'Brewster Hopper']);
    assert.equal((await auth.getUser(fromDisplay.body.id)).disabled, true, 'the login is switched off too');
});

test('get and list: only this company\'s people, with filter and paging', async () => {
    const one = await call('GET', `/Users/${adaId}`);
    assert.equal(one.status, 200); assert.equal(one.body.userName, 'ada@orga.example');
    const all = await call('GET', '/Users');
    assert.equal(all.body.totalResults, 3);
    assert.deepEqual(all.body.Resources.map((u) => u.userName), ['ada@orga.example', 'grace@orga.example', 'roster@orga.example'], 'sorted by userName, and nobody from the other company');
    const byName = await call('GET', `/Users?filter=${encodeURIComponent('userName eq "ADA@orga.example"')}`);
    assert.equal(byName.body.totalResults, 1); assert.equal(byName.body.Resources[0].id, adaId);
    assert.equal((await call('GET', `/Users?filter=${encodeURIComponent('externalId eq "okta-001"')}`)).body.Resources[0].id, adaId);
    assert.equal((await call('GET', `/Users?filter=${encodeURIComponent('userName eq "person@orgb.example"')}`)).body.totalResults, 0, 'a filter cannot reach another company');
    assert.deepEqual((await call('GET', `/Users?filter=${encodeURIComponent('active eq false')}`)).body.Resources.map((u) => u.userName), ['grace@orga.example']);
    const bad = await call('GET', `/Users?filter=${encodeURIComponent('userName zz "x"')}`);
    assert.equal(bad.status, 400); assert.equal(bad.body.scimType, 'invalidFilter');
    const page = await call('GET', '/Users?startIndex=2&count=1');
    assert.deepEqual({ total: page.body.totalResults, start: page.body.startIndex, per: page.body.itemsPerPage, who: page.body.Resources[0].userName }, { total: 3, start: 2, per: 1, who: 'grace@orga.example' });
    assert.equal((await call('GET', '/Users?count=0')).body.Resources.length, 0);
    assert.equal((await call('GET', '/Users/nobody')).status, 404);
    assert.equal((await call('GET', '/Groups')).body.totalResults, 0);
    assert.equal((await call('POST', '/Groups', { body: {} })).status, 501);
    assert.equal((await call('GET', '/Nope')).status, 404);
});

test('patch: changes only the named fields and stores them on the person', async () => {
    const noSchema = await call('PATCH', `/Users/${adaId}`, { body: { Operations: [{ op: 'replace', value: { title: 'x' } }] } });
    assert.equal(noSchema.status, 400);
    const r = await call('PATCH', `/Users/${adaId}`, { body: { schemas: [S.SCHEMA_PATCH], Operations: [{ op: 'replace', value: { title: 'Lead Engineer' } }, { op: 'Replace', path: `${ENT}:department`, value: 'Analysis' }, { op: 'replace', path: 'name.familyName', value: 'Byron' }] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.title, 'Lead Engineer'); assert.equal(r.body[ENT].department, 'Analysis'); assert.equal(r.body.name.familyName, 'Byron'); assert.equal(r.body.userName, 'ada@orga.example');
    const doc = (await db.collection('users').doc(adaId).get()).data();
    assert.equal(doc.jobTitle, 'Lead Engineer'); assert.equal(doc.departmentName, 'Analysis'); assert.equal(doc.name, 'Ada Byron'); assert.equal(doc.updatedVia, 'scim');
    const bad = await call('PATCH', `/Users/${adaId}`, { body: { schemas: [S.SCHEMA_PATCH], Operations: [{ op: 'remove' }] } });
    assert.equal(bad.status, 400); assert.equal(bad.body.scimType, 'noTarget');
    const mgr = await call('PATCH', `/Users/${adaId}`, { body: { schemas: [S.SCHEMA_PATCH], Operations: [{ op: 'replace', path: `${ENT}:manager`, value: 'b_existing' }] } });
    assert.equal(mgr.status, 400, 'a manager from another company is not accepted');
    const self = await call('PATCH', `/Users/${adaId}`, { body: { schemas: [S.SCHEMA_PATCH], Operations: [{ op: 'replace', path: `${ENT}:manager`, value: adaId }] } });
    assert.equal(self.status, 400);
    const roster = await call('PATCH', '/Users/a_roster', { body: { schemas: [S.SCHEMA_PATCH], Operations: [{ op: 'replace', value: { title: 'x' } }] } });
    assert.equal(roster.status, 400); assert.equal(roster.body.scimType, 'mutability');
});

test('deactivate and reactivate by PATCH (Entra ID sends active as the text "False")', async () => {
    const off = await call('PATCH', `/Users/${adaId}`, { body: { schemas: [S.SCHEMA_PATCH], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] } });
    assert.equal(off.status, 200); assert.equal(off.body.active, false);
    assert.equal((await db.collection('users').doc(adaId).get()).data().status, 'Inactive');
    assert.equal((await auth.getUser(adaId)).disabled, true);
    const on = await call('PATCH', `/Users/${adaId}`, { body: { schemas: [S.SCHEMA_PATCH], Operations: [{ op: 'replace', value: { active: true } }] } });
    assert.equal(on.body.active, true); assert.equal((await auth.getUser(adaId)).disabled, false);
});

test('replace (PUT) keeps what the request leaves out; DELETE switches the person off but never deletes the record', async () => {
    const put = await call('PUT', `/Users/${adaId}`, { body: { schemas: [S.SCHEMA_USER], userName: 'ada@orga.example', title: 'Principal Engineer', name: { givenName: 'Ada' } } });
    assert.equal(put.status, 200); assert.equal(put.body.title, 'Principal Engineer'); assert.equal(put.body.name.familyName, 'Byron'); assert.equal(put.body[ENT].department, 'Analysis');
    assert.equal((await call('PUT', `/Users/${adaId}`, { body: { title: 'x' } })).status, 400);
    const del = await call('DELETE', `/Users/${adaId}`);
    assert.equal(del.status, 204); assert.equal(del.body, null);
    const doc = await db.collection('users').doc(adaId).get();
    assert.equal(doc.exists, true); assert.equal(doc.data().status, 'Inactive'); assert.equal(doc.data().jobTitle, 'Principal Engineer');
    assert.equal((await call('GET', `/Users/${adaId}`)).body.active, false);
    assert.equal((await call('DELETE', '/Users/nobody')).status, 404);
});

test('company separation: a token only ever sees and changes its own company', async () => {
    const listB = await call('GET', '/Users', { token: tokenB });
    assert.deepEqual(listB.body.Resources.map((u) => u.userName), ['person@orgb.example']);
    assert.equal((await call('GET', `/Users/${adaId}`, { token: tokenB })).status, 404);
    assert.equal((await call('GET', '/Users/EMP0001', { token: tokenB })).body.id, 'b_existing', 'an employee number resolves inside the caller\'s company only');
    const before = JSON.stringify((await db.collection('users').doc(adaId).get()).data());
    assert.equal((await call('PATCH', `/Users/${adaId}`, { token: tokenB, body: { schemas: [S.SCHEMA_PATCH], Operations: [{ op: 'replace', value: { title: 'Hacked' } }] } })).status, 404);
    assert.equal((await call('PUT', `/Users/${adaId}`, { token: tokenB, body: { userName: 'ada@orga.example', title: 'Hacked' } })).status, 404);
    assert.equal((await call('DELETE', `/Users/${adaId}`, { token: tokenB })).status, 404);
    assert.equal(JSON.stringify((await db.collection('users').doc(adaId).get()).data()), before, 'nothing changed');
    const made = await call('POST', '/Users', { token: tokenB, body: newUser('new@orgb.example') });
    assert.equal(made.status, 201);
    assert.equal((await db.collection('users').doc(made.body.id).get()).data().orgId, 'orgB');
    assert.equal((await call('GET', `/Users/${made.body.id}`)).status, 404, 'and the first company cannot see the new person');
    assert.equal((await call('GET', '/Users')).body.totalResults, 3);
});
