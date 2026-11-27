/**
 * Authentication for apps: API keys and OAuth 2.0 (client credentials, authorization code + PKCE,
 * rotating refresh tokens, revocation). Secrets are shown once and stored only as SHA-256 hashes.
 *
 * Collections (all docs carry orgId, except oauth_apps owned by partners):
 *   api_keys       doc id = public prefix (8 hex); fields: hash, name, scopes, ipAllowlist, expiresAt, revokedAt, lastUsedAt ...
 *   oauth_apps     client registrations (confidential or public), redirect URIs, max scopes
 *   oauth_grants   a customer org's approval of an app and its scopes (id = `${orgId}_${clientId}`)
 *   oauth_codes    one-time authorization codes (hashed), PKCE challenge
 *   oauth_tokens   access/refresh token pairs (hashed), family id for rotation reuse detection
 */
const crypto = require('crypto');
const net = require('net');
const { rawCollection } = require('../config/firebase');

const SCOPES = {
    'people:read': 'Read people, jobs and their basic fields',
    'people:write': 'Create and update people (basic fields only)',
    'time:read': 'Read approved timesheets and daily hours',
    'time:write': 'Post time entries (also needs the company setting turned on)',
    'leave:read': 'Read time-off requests and balances',
    'org:read': 'Read org units (departments) and locations',
    'pay:read': 'Read pay fields (compensation) and pay results',
    'documents:read': 'Read document metadata (never the files)',
    'webhooks:manage': 'Create, list and delete webhook subscriptions'
};
const SCOPE_LIST = Object.keys(SCOPES);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const rand = (bytes) => crypto.randomBytes(bytes).toString('hex');
const safeEqual = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const nowIso = () => new Date().toISOString();

/** Returns { scopes } or { error }. `allowed` limits what may be granted. */
function normalizeScopes(input, allowed = SCOPE_LIST) {
    const list = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/).filter(Boolean);
    const uniq = [...new Set(list.map(String))];
    if (!uniq.length) return { error: 'at least one scope is required' };
    const bad = uniq.filter((s) => !SCOPE_LIST.includes(s));
    if (bad.length) return { error: `unknown scope: ${bad.join(', ')}` };
    const over = uniq.filter((s) => !allowed.includes(s));
    if (over.length) return { error: `scope not permitted: ${over.join(', ')}` };
    return { scopes: uniq };
}

/* --------------------------------- IP allowlist --------------------------------- */

function normalizeIp(ip) { const s = String(ip || '').trim(); return s.startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s; }
const v4int = (ip) => ip.split('.').reduce((a, o) => (a * 256) + Number(o), 0);

function ipAllowed(ip, list) {
    if (!Array.isArray(list) || list.length === 0) return true;
    const addr = normalizeIp(ip);
    return list.some((entry) => {
        const e = String(entry).trim();
        if (e.includes('/') && net.isIPv4(addr)) {
            const [base, bitsRaw] = e.split('/'); const bits = Number(bitsRaw);
            if (!net.isIPv4(base) || !(bits >= 0 && bits <= 32)) return false;
            const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
            return ((v4int(addr) & mask) >>> 0) === ((v4int(base) & mask) >>> 0);
        }
        return normalizeIp(e) === addr;
    });
}

function validateIpList(list) {
    if (list === undefined || list === null) return { value: [] };
    if (!Array.isArray(list) || list.length > 50) return { error: 'ipAllowlist must be a list of at most 50 addresses' };
    for (const e of list) {
        const s = String(e).trim(); const [base, bits] = s.split('/');
        if (!net.isIP(base) || (bits !== undefined && !(net.isIPv4(base) && /^\d+$/.test(bits) && Number(bits) <= 32))) return { error: `"${s}" is not a valid IP address or IPv4 CIDR` };
    }
    return { value: list.map((e) => String(e).trim()) };
}

/* ---------------------------------- API keys ---------------------------------- */

function generateKey() {
    const prefix = rand(4);
    const secret = rand(24);
    const key = `kylrx_${prefix}_${secret}`;
    return { key, prefix, hash: sha256(key) };
}

function parseKey(token) {
    const m = String(token || '').match(/^kylrx_([0-9a-f]{8})_([0-9a-f]{48})$/);
    return m ? { prefix: m[1] } : null;
}

const publicKey = (id, k) => ({
    id, name: k.name, prefix: `kylrx_${id}`, scopes: k.scopes, ip_allowlist: k.ipAllowlist || [], rate_limit_per_minute: k.rateLimitPerMinute,
    expires_at: k.expiresAt || null, revoked_at: k.revokedAt || null, last_used_at: k.lastUsedAt || null, last_used_ip: k.lastUsedIp || null,
    created_at: k.createdAt, created_by: k.createdBy || null,
    status: k.revokedAt ? 'revoked' : (k.expiresAt && new Date(k.expiresAt).getTime() < Date.now() ? 'expired' : 'active')
});

async function createKey(orgId, body, actor) {
    const errors = [];
    const name = String(body.name || '').trim();
    if (!name) errors.push('name is required');
    const sc = normalizeScopes(body.scopes); if (sc.error) errors.push(sc.error);
    const ips = validateIpList(body.ipAllowlist); if (ips.error) errors.push(ips.error);
    let expiresAt = null;
    if (body.expiresAt) {
        const t = new Date(body.expiresAt);
        if (Number.isNaN(t.getTime()) || t.getTime() <= Date.now()) errors.push('expiresAt must be a future date'); else expiresAt = t.toISOString();
    }
    let limit = 600;
    if (body.rateLimitPerMinute !== undefined) {
        limit = Number(body.rateLimitPerMinute);
        if (!Number.isInteger(limit) || limit < 1 || limit > 6000) errors.push('rateLimitPerMinute must be 1 to 6000');
    }
    if (errors.length) return { errors };
    const { key, prefix, hash } = generateKey();
    const doc = { orgId, name: name.slice(0, 80), hash, scopes: sc.scopes, ipAllowlist: ips.value, expiresAt, rateLimitPerMinute: limit, revokedAt: null, lastUsedAt: null, createdAt: nowIso(), createdBy: actor || null };
    await rawCollection('api_keys').doc(prefix).create(doc);
    return { key, record: publicKey(prefix, doc) };
}

async function listKeys(orgId) {
    const snap = await rawCollection('api_keys').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => publicKey(d.id, d.data())).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function loadKey(orgId, id) {
    const snap = await rawCollection('api_keys').doc(String(id)).get();
    if (!exists(snap) || snap.data().orgId !== orgId) return null;
    return { id: snap.id, ref: snap.ref, data: snap.data() };
}

const cache = new Map(); // token hash -> { principal, until }
const CACHE_MS = 3000;
const clearCache = () => cache.clear();

async function revokeKey(orgId, id) {
    const k = await loadKey(orgId, id);
    if (!k) return null;
    await k.ref.update({ revokedAt: k.data.revokedAt || nowIso() });
    clearCache();
    return publicKey(id, { ...k.data, revokedAt: k.data.revokedAt || nowIso() });
}

async function updateKey(orgId, id, body) {
    const k = await loadKey(orgId, id);
    if (!k) return { notFound: true };
    const patch = {}; const errors = [];
    if (body.name !== undefined) { const n = String(body.name).trim(); if (!n) errors.push('name cannot be empty'); else patch.name = n.slice(0, 80); }
    if (body.ipAllowlist !== undefined) { const r = validateIpList(body.ipAllowlist); if (r.error) errors.push(r.error); else patch.ipAllowlist = r.value; }
    if (body.rateLimitPerMinute !== undefined) { const n = Number(body.rateLimitPerMinute); if (!Number.isInteger(n) || n < 1 || n > 6000) errors.push('rateLimitPerMinute must be 1 to 6000'); else patch.rateLimitPerMinute = n; }
    if (errors.length) return { errors };
    await k.ref.update(patch); clearCache();
    return { record: publicKey(id, { ...k.data, ...patch }) };
}

const lastTouch = new Map();
function touch(ref, ip, id) {
    const last = lastTouch.get(id) || 0;
    if (Date.now() - last < 30000) return;
    lastTouch.set(id, Date.now());
    ref.update({ lastUsedAt: nowIso(), lastUsedIp: normalizeIp(ip) }).catch(() => {});
}

/**
 * Resolves a bearer token to a principal or an error code:
 *   { principal: { type, id, orgId, scopes, name, rateLimitPerMinute } } | { error: 'invalid_token'|'expired'|'revoked'|'ip_not_allowed' }
 */
async function authenticate(token, ip) {
    const t = String(token || '');
    const hash = sha256(t);
    const hit = cache.get(hash);
    if (hit && hit.until > Date.now()) {
        if (hit.principal.ipAllowlist && !ipAllowed(ip, hit.principal.ipAllowlist)) return { error: 'ip_not_allowed' };
        return { principal: hit.principal };
    }
    let principal;
    const parsed = parseKey(t);
    if (parsed) {
        const snap = await rawCollection('api_keys').doc(parsed.prefix).get();
        if (!exists(snap) || !safeEqual(snap.data().hash, hash)) return { error: 'invalid_token' };
        const k = snap.data();
        if (k.revokedAt) return { error: 'revoked' };
        if (k.expiresAt && new Date(k.expiresAt).getTime() < Date.now()) return { error: 'expired' };
        principal = { type: 'api_key', id: `key:${parsed.prefix}`, keyId: parsed.prefix, orgId: k.orgId, scopes: k.scopes, name: k.name, rateLimitPerMinute: k.rateLimitPerMinute || 600, ipAllowlist: k.ipAllowlist || [] };
        if (!ipAllowed(ip, principal.ipAllowlist)) return { error: 'ip_not_allowed' };
        touch(snap.ref, ip, parsed.prefix);
    } else if (/^kxat_[0-9a-f]{48}$/.test(t)) {
        const snap = await rawCollection('oauth_tokens').doc(hash).get();
        if (!exists(snap)) return { error: 'invalid_token' };
        const o = snap.data();
        if (o.revokedAt) return { error: 'revoked' };
        if (new Date(o.accessExpiresAt).getTime() < Date.now()) return { error: 'expired' };
        principal = { type: 'oauth', id: `oauth:${o.clientId}:${o.orgId}`, clientId: o.clientId, orgId: o.orgId, scopes: o.scopes, name: o.clientName || o.clientId, rateLimitPerMinute: 600 };
    } else {
        return { error: 'invalid_token' };
    }
    cache.set(hash, { principal, until: Date.now() + CACHE_MS });
    return { principal };
}

/* ------------------------------- rate limiting ------------------------------- */

/** Sliding-window-ish counter (fixed one-minute buckets) kept in memory per process */
function createLimiter(windowMs = 60000) {
    const buckets = new Map();
    return {
        hit(id, limit, now = Date.now()) {
            const start = now - (now % windowMs);
            let b = buckets.get(id);
            if (!b || b.start !== start) { b = { start, count: 0 }; buckets.set(id, b); }
            b.count += 1;
            if (buckets.size > 5000) for (const [k, v] of buckets) if (v.start !== start) buckets.delete(k);
            const reset = Math.ceil((start + windowMs - now) / 1000);
            return { allowed: b.count <= limit, limit, remaining: Math.max(0, limit - b.count), resetSeconds: reset };
        },
        reset() { buckets.clear(); }
    };
}

/* ----------------------------------- OAuth ----------------------------------- */

const TTL = { code: 10 * 60e3, access: 60 * 60e3, refresh: 30 * 24 * 3600e3 };

function pkceChallenge(verifier) { return crypto.createHash('sha256').update(String(verifier)).digest('base64url'); }
function verifyPkce(verifier, challenge, method = 'S256') {
    if (method !== 'S256' || !verifier || !/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
    return safeEqual(pkceChallenge(verifier), challenge);
}

function validateRedirectUri(uri, isProd = process.env.NODE_ENV === 'production') {
    let u;
    try { u = new URL(String(uri)); } catch (_) { return 'redirect URI is not a valid URL'; }
    if (u.hash) return 'redirect URI must not contain a fragment';
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && !isProd)) return 'redirect URI must use https';
    return null;
}

const publicApp = (id, a) => ({
    client_id: id, name: a.name, description: a.description || '', type: a.type, redirect_uris: a.redirectUris, scopes: a.scopes,
    owner_org_id: a.ownerOrgId || null, active: a.active !== false, created_at: a.createdAt, secret_last4: a.secretLast4 || null
});

async function createApp(orgId, body, actor) {
    const errors = [];
    const name = String(body.name || '').trim(); if (!name) errors.push('name is required');
    const type = body.type === 'public' ? 'public' : 'confidential';
    const sc = normalizeScopes(body.scopes); if (sc.error) errors.push(sc.error);
    const uris = Array.isArray(body.redirectUris) ? body.redirectUris : [];
    if (!uris.length && body.grantClientCredentialsOnly !== true) errors.push('at least one redirect URI is required');
    for (const u of uris) { const e = validateRedirectUri(u); if (e) errors.push(`${u}: ${e}`); }
    if (errors.length) return { errors };
    const clientId = `kxc_${rand(10)}`;
    const secret = type === 'confidential' ? `kxs_${rand(24)}` : null;
    const doc = { name: name.slice(0, 80), description: String(body.description || '').slice(0, 300), type, redirectUris: uris, scopes: sc.scopes, ownerOrgId: orgId, active: true, secretHash: secret ? sha256(secret) : null, secretLast4: secret ? secret.slice(-4) : null, createdAt: nowIso(), createdBy: actor || null, orgId };
    await rawCollection('oauth_apps').doc(clientId).create(doc);
    return { app: publicApp(clientId, doc), clientSecret: secret };
}

async function loadApp(clientId) {
    const snap = await rawCollection('oauth_apps').doc(String(clientId || '_')).get();
    return exists(snap) ? { id: snap.id, ref: snap.ref, data: snap.data() } : null;
}

async function listApps(orgId) {
    const snap = await rawCollection('oauth_apps').where('ownerOrgId', '==', orgId).get();
    return snap.docs.map((d) => publicApp(d.id, d.data())).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

async function rotateAppSecret(orgId, clientId) {
    const app = await loadApp(clientId);
    if (!app || app.data.ownerOrgId !== orgId || app.data.type !== 'confidential') return null;
    const secret = `kxs_${rand(24)}`;
    await app.ref.update({ secretHash: sha256(secret), secretLast4: secret.slice(-4) });
    return secret;
}

async function setAppActive(orgId, clientId, active) {
    const app = await loadApp(clientId);
    if (!app || app.data.ownerOrgId !== orgId) return false;
    await app.ref.update({ active });
    if (!active) await revokeAllForClient(clientId);
    return true;
}

function clientAuthOk(app, secret) {
    if (app.data.type === 'public') return true;
    return Boolean(secret && app.data.secretHash && safeEqual(sha256(secret), app.data.secretHash));
}

/** Validates an authorization request and returns what the consent page should show */
async function describeAuthorization(q) {
    const app = await loadApp(q.client_id);
    if (!app || app.data.active === false) return { error: 'invalid_client' };
    if (!(app.data.redirectUris || []).includes(q.redirect_uri)) return { error: 'invalid_redirect_uri' };
    if (q.response_type !== 'code') return { error: 'unsupported_response_type', redirect: true };
    const sc = normalizeScopes(q.scope, app.data.scopes);
    if (sc.error) return { error: 'invalid_scope', description: sc.error, redirect: true };
    if (q.code_challenge) {
        if ((q.code_challenge_method || 'plain') !== 'S256') return { error: 'invalid_request', description: 'code_challenge_method must be S256', redirect: true };
        if (!/^[A-Za-z0-9\-_]{43}$/.test(q.code_challenge)) return { error: 'invalid_request', description: 'code_challenge is not a valid S256 challenge', redirect: true };
    } else if (app.data.type === 'public') {
        return { error: 'invalid_request', description: 'PKCE (code_challenge) is required for public clients', redirect: true };
    }
    return { app: publicApp(app.id, app.data), scopes: sc.scopes, scopeDescriptions: Object.fromEntries(sc.scopes.map((s) => [s, SCOPES[s]])) };
}

/** Called after an admin approved: stores the grant and returns the one-time code */
async function approveAuthorization(orgId, adminId, q) {
    const desc = await describeAuthorization(q);
    if (desc.error) return desc;
    const code = `kxac_${rand(24)}`;
    await rawCollection('oauth_codes').doc(sha256(code)).create({
        orgId, clientId: q.client_id, scopes: desc.scopes, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge || null, approvedBy: adminId,
        expiresAt: new Date(Date.now() + TTL.code).toISOString(), usedAt: null, createdAt: nowIso()
    });
    await rawCollection('oauth_grants').doc(`${orgId}_${q.client_id}`).set({ orgId, clientId: q.client_id, clientName: desc.app.name, scopes: desc.scopes, approvedBy: adminId, approvedAt: nowIso(), revokedAt: null });
    return { code };
}

async function issueTokens({ orgId, clientId, clientName, scopes, familyId, withRefresh = true }) {
    const access = `kxat_${rand(24)}`; const refresh = withRefresh ? `kxrt_${rand(24)}` : null;
    const doc = {
        orgId, clientId, clientName: clientName || clientId, scopes, familyId: familyId || rand(8), accessExpiresAt: new Date(Date.now() + TTL.access).toISOString(),
        refreshHash: refresh ? sha256(refresh) : null, refreshExpiresAt: refresh ? new Date(Date.now() + TTL.refresh).toISOString() : null,
        refreshUsedAt: null, revokedAt: null, createdAt: nowIso()
    };
    await rawCollection('oauth_tokens').doc(sha256(access)).create(doc);
    return { access_token: access, token_type: 'Bearer', expires_in: TTL.access / 1000, scope: scopes.join(' '), ...(refresh ? { refresh_token: refresh } : {}) };
}

async function revokeFamily(familyId) {
    const snap = await rawCollection('oauth_tokens').where('familyId', '==', familyId).get();
    await Promise.all(snap.docs.map((d) => d.ref.update({ revokedAt: d.data().revokedAt || nowIso() })));
    clearCache();
}
async function revokeAllForClient(clientId, orgId) {
    const snap = await rawCollection('oauth_tokens').where('clientId', '==', clientId).get();
    await Promise.all(snap.docs.filter((d) => !orgId || d.data().orgId === orgId).map((d) => d.ref.update({ revokedAt: d.data().revokedAt || nowIso() })));
    clearCache();
}

/** OAuth token endpoint logic. Returns { status, body } */
async function tokenEndpoint(params, basic) {
    const err = (status, error, description) => ({ status, body: { error, ...(description ? { error_description: description } : {}) } });
    const clientId = (basic && basic.id) || params.client_id;
    const clientSecret = (basic && basic.secret) || params.client_secret;
    const app = await loadApp(clientId);
    if (!app || app.data.active === false || !clientAuthOk(app, clientSecret)) return err(401, 'invalid_client', 'client authentication failed');
    const grant = params.grant_type;

    if (grant === 'client_credentials') {
        if (app.data.type !== 'confidential') return err(400, 'unauthorized_client', 'public clients cannot use client_credentials');
        const sc = normalizeScopes(params.scope || app.data.scopes, app.data.scopes);
        if (sc.error) return err(400, 'invalid_scope', sc.error);
        return { status: 200, body: await issueTokens({ orgId: app.data.ownerOrgId, clientId: app.id, clientName: app.data.name, scopes: sc.scopes, withRefresh: false }) };
    }

    if (grant === 'authorization_code') {
        const codeRef = rawCollection('oauth_codes').doc(sha256(params.code || '_'));
        const snap = await codeRef.get();
        if (!exists(snap)) return err(400, 'invalid_grant', 'code is invalid');
        const c = snap.data();
        if (c.usedAt) { await revokeAllForClient(c.clientId, c.orgId); return err(400, 'invalid_grant', 'code was already used'); }
        if (new Date(c.expiresAt).getTime() < Date.now()) return err(400, 'invalid_grant', 'code expired');
        if (c.clientId !== app.id || c.redirectUri !== params.redirect_uri) return err(400, 'invalid_grant', 'client or redirect_uri does not match');
        if (c.codeChallenge) { if (!verifyPkce(params.code_verifier, c.codeChallenge)) return err(400, 'invalid_grant', 'PKCE verification failed'); }
        else if (app.data.type === 'public') return err(400, 'invalid_grant', 'PKCE is required');
        await codeRef.update({ usedAt: nowIso() });
        const gSnap = await rawCollection('oauth_grants').doc(`${c.orgId}_${c.clientId}`).get();
        if (!exists(gSnap) || gSnap.data().revokedAt) return err(400, 'invalid_grant', 'the app is no longer approved');
        return { status: 200, body: await issueTokens({ orgId: c.orgId, clientId: app.id, clientName: app.data.name, scopes: c.scopes }) };
    }

    if (grant === 'refresh_token') {
        const rt = String(params.refresh_token || '');
        const q = await rawCollection('oauth_tokens').where('refreshHash', '==', sha256(rt)).limit(1).get();
        if (q.empty) return err(400, 'invalid_grant', 'refresh token is invalid');
        const doc = q.docs[0]; const t = doc.data();
        if (t.clientId !== app.id) return err(400, 'invalid_grant', 'refresh token was issued to another client');
        if (t.refreshUsedAt) { await revokeFamily(t.familyId); return err(400, 'invalid_grant', 'refresh token was already used; the session was revoked'); }
        if (t.revokedAt) return err(400, 'invalid_grant', 'token was revoked');
        if (new Date(t.refreshExpiresAt).getTime() < Date.now()) return err(400, 'invalid_grant', 'refresh token expired');
        let scopes = t.scopes;
        if (params.scope) { const sc = normalizeScopes(params.scope, t.scopes); if (sc.error) return err(400, 'invalid_scope', sc.error); scopes = sc.scopes; }
        const gSnap = await rawCollection('oauth_grants').doc(`${t.orgId}_${t.clientId}`).get();
        if (exists(gSnap) && gSnap.data().revokedAt) return err(400, 'invalid_grant', 'the app is no longer approved');
        await doc.ref.update({ refreshUsedAt: nowIso() });
        return { status: 200, body: await issueTokens({ orgId: t.orgId, clientId: app.id, clientName: app.data.name, scopes, familyId: t.familyId }) };
    }
    return err(400, 'unsupported_grant_type');
}

/** RFC 7009: always succeeds from the caller's point of view */
async function revokeToken(token, app) {
    const t = String(token || '');
    if (t.startsWith('kxat_')) {
        const ref = rawCollection('oauth_tokens').doc(sha256(t)); const s = await ref.get();
        if (exists(s) && s.data().clientId === app.id) { await ref.update({ revokedAt: nowIso() }); clearCache(); }
    } else if (t.startsWith('kxrt_')) {
        const q = await rawCollection('oauth_tokens').where('refreshHash', '==', sha256(t)).limit(1).get();
        if (!q.empty && q.docs[0].data().clientId === app.id) await revokeFamily(q.docs[0].data().familyId);
    }
}

async function listGrants(orgId) {
    const snap = await rawCollection('oauth_grants').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, client_id: d.data().clientId, app_name: d.data().clientName, scopes: d.data().scopes, approved_at: d.data().approvedAt, approved_by: d.data().approvedBy, revoked_at: d.data().revokedAt || null }))
        .sort((a, b) => String(b.approved_at).localeCompare(String(a.approved_at)));
}

async function revokeGrant(orgId, grantId) {
    const ref = rawCollection('oauth_grants').doc(String(grantId)); const s = await ref.get();
    if (!exists(s) || s.data().orgId !== orgId) return false;
    await ref.update({ revokedAt: nowIso() });
    await revokeAllForClient(s.data().clientId, orgId);
    return true;
}

module.exports = {
    SCOPES, SCOPE_LIST, normalizeScopes, ipAllowed, validateIpList, generateKey, parseKey, sha256, publicKey,
    createKey, listKeys, revokeKey, updateKey, authenticate, clearCache, createLimiter,
    pkceChallenge, verifyPkce, validateRedirectUri, createApp, listApps, rotateAppSecret, setAppActive, loadApp,
    describeAuthorization, approveAuthorization, tokenEndpoint, revokeToken, listGrants, revokeGrant, issueTokens, TTL
};
