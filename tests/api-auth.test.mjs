import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const A = require('../services/api-auth.js');
const openapi = require('../services/openapi.js');
const api = require('../routes/api-v1.js');

test('API keys: format, parse, hash, uniqueness', () => {
    const k = A.generateKey();
    assert.match(k.key, /^kylrx_[0-9a-f]{8}_[0-9a-f]{48}$/);
    assert.equal(A.parseKey(k.key).prefix, k.prefix);
    assert.equal(k.hash, A.sha256(k.key));
    assert.equal(A.parseKey('kylrx_short'), null);
    assert.notEqual(A.generateKey().key, k.key);
});

test('scopes: validation and least privilege', () => {
    assert.deepEqual(A.normalizeScopes(['people:read', 'people:read']).scopes, ['people:read']);
    assert.ok(A.normalizeScopes(['people:read', 'god:mode']).error);
    assert.ok(A.normalizeScopes([]).error);
    assert.ok(A.normalizeScopes('pay:read', ['people:read']).error);
    assert.deepEqual(A.normalizeScopes('people:read leave:read').scopes, ['people:read', 'leave:read']);
});

test('IP allowlist: exact, CIDR, IPv4-mapped IPv6, empty list', () => {
    assert.equal(A.ipAllowed('1.2.3.4', []), true);
    assert.equal(A.ipAllowed('1.2.3.4', ['1.2.3.4']), true);
    assert.equal(A.ipAllowed('::ffff:1.2.3.4', ['1.2.3.4']), true);
    assert.equal(A.ipAllowed('10.1.2.3', ['10.1.0.0/16']), true);
    assert.equal(A.ipAllowed('10.2.2.3', ['10.1.0.0/16']), false);
    assert.equal(A.ipAllowed('9.9.9.9', ['1.2.3.4', '10.0.0.0/8']), false);
    assert.ok(A.validateIpList(['not-an-ip']).error);
    assert.ok(A.validateIpList(['10.0.0.0/33']).error);
    assert.deepEqual(A.validateIpList(['10.0.0.0/8']).value, ['10.0.0.0/8']);
});

test('rate limiter: counts per window, headers math, resets', () => {
    const l = A.createLimiter(60000);
    const t = 1_000_000;
    assert.equal(l.hit('k', 2, t).remaining, 1);
    assert.equal(l.hit('k', 2, t + 1000).remaining, 0);
    const third = l.hit('k', 2, t + 2000);
    assert.equal(third.allowed, false);
    assert.ok(third.resetSeconds > 0 && third.resetSeconds <= 60);
    assert.equal(l.hit('other', 2, t).allowed, true);
    assert.equal(l.hit('k', 2, t + 60000).allowed, true); // next window
});

test('PKCE: S256 only, verifier length enforced', () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = A.pkceChallenge(verifier);
    assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'); // RFC 7636 appendix B
    assert.equal(A.verifyPkce(verifier, challenge), true);
    assert.equal(A.verifyPkce('x'.repeat(43), challenge), false);
    assert.equal(A.verifyPkce(verifier, challenge, 'plain'), false);
    assert.equal(A.verifyPkce('short', challenge), false);
});

test('redirect URI rules', () => {
    assert.equal(A.validateRedirectUri('https://app.example.com/cb', true), null);
    assert.ok(A.validateRedirectUri('http://app.example.com/cb', true));
    assert.equal(A.validateRedirectUri('http://localhost:3000/cb', false), null);
    assert.ok(A.validateRedirectUri('http://localhost:3000/cb', true));
    assert.ok(A.validateRedirectUri('https://app.example.com/cb#frag', true));
    assert.ok(A.validateRedirectUri('not a url', true));
});

test('OpenAPI document covers every route, with scopes and unique operation ids', () => {
    const doc = openapi.build(api.routes, { baseUrl: 'http://x' });
    assert.equal(doc.openapi, '3.0.3');
    const ids = new Set(); let ops = 0;
    for (const [p, methods] of Object.entries(doc.paths)) {
        for (const [m, op] of Object.entries(methods)) {
            ops += 1;
            assert.ok(!ids.has(op.operationId), `duplicate ${op.operationId}`); ids.add(op.operationId);
            assert.ok(op.responses && Object.keys(op.responses).length, `${m} ${p} has responses`);
        }
    }
    assert.equal(ops, api.routes.length);
    assert.ok(doc.paths['/people'].get['x-required-scope'] === 'people:read');
    assert.ok(doc.paths['/pay-results'].get['x-required-scope'] === 'pay:read');
    assert.ok(doc.paths['/people'].post.parameters.some((p) => p.$ref && p.$ref.endsWith('/idem')));
    assert.ok(doc.paths['/people/{id}'].patch.parameters.some((p) => p.$ref && p.$ref.endsWith('/ifMatch')));
    assert.ok(doc.components.schemas.Person.properties.compensation.description.includes('pay:read'));
    for (const r of api.routes) assert.ok(r.scope === null || Object.keys(A.SCOPES).includes(r.scope), r.id);
});

test('pagination: cursor walks every record once, updated_since inclusive', () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `id${i}`, ts: `2026-01-0${(i % 3) + 1}T00:00:00.000Z` }));
    const seen = []; let cursor;
    for (let guard = 0; guard < 10; guard++) {
        const p = api.helpers.paginate(items, { limit: 3, cursor }, (x) => x.ts);
        seen.push(...p.data.map((x) => x.id));
        if (!p.has_more) break;
        cursor = p.next_cursor;
    }
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);
    const since = api.helpers.paginate(items, { updated_since: '2026-01-02T00:00:00Z' }, (x) => x.ts);
    assert.ok(since.data.every((x) => x.ts >= '2026-01-02'));
    assert.ok(api.helpers.paginate(items, { updated_since: 'nope' }, (x) => x.ts).error);
    assert.ok(api.helpers.paginate(items, { cursor: '!!' }, (x) => x.ts).error);
});
