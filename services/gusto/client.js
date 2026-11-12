/**
 * Gusto HTTP client.
 *  - system token (POST /oauth/token grant_type=system_access, 2h) cached per application
 *  - company tokens (2h access, ROTATING refresh token) stored encrypted; refresh is serialised per company:
 *    in-process by a promise map, across processes by a lease lock in the store (Firestore transaction)
 *  - X-Gusto-API-Version pinned from config
 *  - sliding-window rate limiter (+ pause on 429 using Retry-After / X-RateLimit-* headers)
 *  - retries with backoff on network errors and 5xx; POSTs always carry an idempotency key reused across retries
 *  - 409 (stale `version`) surfaced as code 'version_conflict'; putVersioned() re-reads and retries
 *  - structured logging with secrets redacted
 */
const crypto = require('crypto');
const rules = require('./rules');

const SECRET_KEY = /secret|token|password|passwd|ssn|taxpayer|account_number|routing_number|authorization|verification|signature|api[-_]?key/i;

/** Deep copy with secret-looking keys masked. Strings that look like bearer tokens are masked too. */
function redact(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 6) return '[deep]';
    if (typeof value === 'string') return value.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
        return out;
    }
    return value;
}

class GustoError extends Error {
    constructor(message, { status = 0, code = 'gusto_error', details = null, retryable = false, retryAfterMs = null } = {}) {
        super(message);
        this.name = 'GustoError';
        this.status = status;
        this.code = code;
        this.details = details ? redact(details) : null;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
    }
}

function errorMessageOf(body, status) {
    try {
        if (body && Array.isArray(body.errors) && body.errors.length) {
            return body.errors.slice(0, 5).map((e) => [e.message || e.error_key, e.metadata && e.metadata.key ? `(${e.metadata.key})` : ''].filter(Boolean).join(' ')).join('; ').slice(0, 500);
        }
        if (body && (body.error_description || body.error || body.message)) return String(body.error_description || body.message || body.error).slice(0, 300);
    } catch (_) {}
    return `Gusto returned HTTP ${status}`;
}

// Shared per application (base URL + client id): the limit is per application and user, and the system token is shared.
const appState = new Map();
function stateFor(opts) {
    const key = `${opts.baseUrl}|${opts.clientId}`;
    if (!appState.has(key)) appState.set(key, { limiter: rules.createRateWindow({ max: opts.rateLimitPerMinute, windowMs: opts.rateWindowMs }), system: null, systemPromise: null, stats: { requests: 0, throttled: 0, retries: 0, refreshes: 0, conflicts: 0 } });
    return appState.get(key);
}
function resetAppState() { appState.clear(); }

const refreshingByStore = new WeakMap(); // store -> Map(orgId -> promise): in-process serialisation (a second process is covered by the store lock)
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} p
 * @param {string} p.orgId
 * @param {object} p.opts    from config.resolve()
 * @param {object} p.store   from store.js
 * @param {object} [p.log]   { info, warn, error }
 */
function createClient({ orgId, opts, store, log, fetchImpl, sleep = defaultSleep, now = () => Date.now() }) {
    const app = stateFor(opts);
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    const logger = log || { info() {}, warn() {}, error() {} };
    const emit = (level, event, fields) => { try { logger[level](`gusto ${event}`, redact({ orgId, ...fields })); } catch (_) {} };

    async function throttle() {
        for (;;) {
            const wait = app.limiter.waitMs(now());
            if (wait <= 0) break;
            app.stats.throttled += 1;
            await sleep(Math.min(wait, 5000));
        }
        app.limiter.begin();
    }

    async function rawFetch(method, path, { query, body, headers = {}, token, idempotencyKey } = {}) {
        let url = `${opts.baseUrl}${path}`;
        if (query) {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.append(k, String(v));
            const s = qs.toString();
            if (s) url += `?${s}`;
        }
        const h = { Accept: 'application/json', 'X-Gusto-API-Version': opts.apiVersion, ...headers };
        if (token) h.Authorization = `Bearer ${token}`;
        if (body !== undefined) h['Content-Type'] = 'application/json';
        if (idempotencyKey) h[opts.idempotencyHeader] = idempotencyKey;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
        try {
            const res = await doFetch(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
            const text = await res.text();
            let data = null;
            if (text) { try { data = JSON.parse(text); } catch (_) { data = { raw: text.slice(0, 300) }; } }
            return { status: res.status, data, headers: res.headers };
        } finally { clearTimeout(timer); }
    }

    /* ---------------- tokens ---------------- */

    async function oauth(body) {
        const r = await rawFetch('POST', '/oauth/token', { body: { client_id: opts.clientId, client_secret: opts.clientSecret, ...body } });
        if (r.status >= 400 || !r.data || !r.data.access_token) {
            const code = r.status === 400 || r.status === 401 ? 'auth_failed' : 'gusto_error';
            throw new GustoError(`Gusto token request failed: ${errorMessageOf(r.data, r.status)}`, { status: r.status, code, details: r.data });
        }
        return r.data;
    }

    const expiryOf = (d) => now() + (Number(d.expires_in) || 7200) * 1000;

    async function systemToken(force = false) {
        const fresh = () => app.system && app.system.expiresAt - opts.tokenSkewSec * 1000 > now();
        if (!force && fresh()) return app.system.token;
        if (app.systemPromise) return app.systemPromise;
        app.systemPromise = (async () => {
            try {
                const d = await oauth({ grant_type: 'system_access' });
                app.system = { token: d.access_token, expiresAt: expiryOf(d) };
                emit('info', 'system_token_issued', { expiresInSec: d.expires_in });
                return app.system.token;
            } finally { app.systemPromise = null; }
        })();
        return app.systemPromise;
    }

    const tokenUsable = (t) => t && t.accessToken && t.expiresAt - opts.tokenSkewSec * 1000 > now();

    /** Refresh the company's tokens once, no matter how many callers ask at the same time (in this process or another). */
    function refreshCompany(staleAccessToken) {
        if (!refreshingByStore.has(store)) refreshingByStore.set(store, new Map());
        const refreshing = refreshingByStore.get(store);
        if (refreshing.has(orgId)) return refreshing.get(orgId);
        const p = (async () => {
            const holder = crypto.randomBytes(8).toString('hex');
            const deadline = now() + opts.lockLeaseMs * 2;
            try {
                for (;;) {
                    const got = await store.acquireLock(orgId, holder, opts.lockLeaseMs);
                    if (got) break;
                    // someone else (another process) is refreshing: wait, then use what they stored
                    await sleep(60);
                    const t = await store.getCompanyTokens(orgId);
                    if (tokenUsable(t) && t.accessToken !== staleAccessToken) return t;
                    if (now() > deadline) throw new GustoError('Timed out waiting for another process to refresh the Gusto token', { code: 'refresh_lock_timeout', retryable: true });
                }
                try {
                    const current = await store.getCompanyTokens(orgId);
                    if (!current || !current.refreshToken) throw new GustoError('This company is not connected to Gusto', { status: 409, code: 'not_connected' });
                    if (tokenUsable(current) && current.accessToken !== staleAccessToken) return current; // refreshed meanwhile
                    app.stats.refreshes += 1;
                    let d;
                    try {
                        d = await oauth({ grant_type: 'refresh_token', refresh_token: current.refreshToken });
                    } catch (e) {
                        if (e.code === 'auth_failed') {
                            await store.saveConnection(orgId, { status: 'reauth_required', statusNote: 'Gusto rejected the refresh token. Reconnect the company.' });
                            throw new GustoError('Gusto rejected the stored refresh token; the company must be reconnected', { status: e.status, code: 'reauth_required' });
                        }
                        throw e;
                    }
                    const next = { accessToken: d.access_token, refreshToken: d.refresh_token || current.refreshToken, expiresAt: expiryOf(d) };
                    await store.saveCompanyTokens(orgId, next); // the new refresh token replaces the old one before anyone else can use the old one
                    emit('info', 'company_token_refreshed', { expiresInSec: d.expires_in });
                    return next;
                } finally { await store.releaseLock(orgId, holder); }
            } finally { refreshing.delete(orgId); }
        })();
        refreshing.set(orgId, p);
        return p;
    }

    async function companyToken(force = false, staleToken = null) {
        const t = await store.getCompanyTokens(orgId);
        if (!t) throw new GustoError('This company is not connected to Gusto', { status: 409, code: 'not_connected' });
        if (!force && tokenUsable(t)) return t.accessToken;
        const fresh = await refreshCompany(force ? (staleToken || t.accessToken) : t.accessToken);
        return fresh.accessToken;
    }

    /* ---------------- requests ---------------- */

    /**
     * @param {string} method
     * @param {string} path             e.g. /v1/companies/{uuid}/locations
     * @param {object} [o]  { query, body, as: 'company'|'system'|'none', idempotencyKey, full, headers }
     */
    async function request(method, path, o = {}) {
        const as = o.as || 'company';
        const isWrite = method !== 'GET';
        const idem = o.idempotencyKey || (method === 'POST' ? crypto.randomUUID() : undefined);
        let attempt = 0;
        let authRetried = false;
        let tooMany = 0;
        for (;;) {
            attempt += 1;
            let token = null;
            let used = null;
            if (as === 'company') { token = await companyToken(); used = token; } else if (as === 'system') { token = await systemToken(); used = token; }
            await throttle();
            app.stats.requests += 1;
            const t0 = now();
            let r;
            try {
                try {
                    r = await rawFetch(method, path, { query: o.query, body: o.body, headers: o.headers, token, idempotencyKey: idem });
                } finally { app.limiter.end(now()); }
            } catch (e) {
                const retryable = e.name === 'AbortError' || e.name === 'TypeError' || /fetch|network|ECONN|socket/i.test(e.message);
                if (retryable && attempt <= opts.maxRetries && (!isWrite || idem)) {
                    app.stats.retries += 1;
                    const wait = rules.backoffMs(attempt, opts.backoffBaseMs);
                    emit('warn', 'network_retry', { method, path, attempt, waitMs: wait, error: e.name });
                    await sleep(wait);
                    continue;
                }
                throw new GustoError(`Could not reach Gusto (${e.name === 'AbortError' ? 'timed out' : e.message})`, { code: 'network', retryable: true });
            }
            emit('info', 'request', { method, path, status: r.status, ms: now() - t0, attempt });
            if (r.status >= 200 && r.status < 300) return o.full ? r : r.data;
            if (r.status === 401 && as !== 'none' && !authRetried) {
                authRetried = true;
                if (as === 'company') await companyToken(true, used); else await systemToken(true);
                continue;
            }
            if (r.status === 429) {
                const wait = rules.retryAfterMs(r.headers, now(), 1000);
                app.limiter.pauseUntil(now() + wait);
                tooMany += 1;
                emit('warn', 'rate_limited', { method, path, waitMs: wait, attempt: tooMany });
                if (tooMany <= opts.maxRetries + 4) { await sleep(wait); continue; }
                throw new GustoError('Gusto is rate limiting us (429); gave up after several waits', { status: 429, code: 'rate_limited', retryable: true, retryAfterMs: wait });
            }
            if (r.status >= 500 && attempt <= opts.maxRetries && (!isWrite || idem)) {
                app.stats.retries += 1;
                const wait = rules.backoffMs(attempt, opts.backoffBaseMs);
                emit('warn', 'server_retry', { method, path, status: r.status, attempt, waitMs: wait });
                await sleep(wait);
                continue;
            }
            if (r.status === 409) app.stats.conflicts += 1;
            const code = r.status === 409 ? 'version_conflict' : r.status === 401 ? 'unauthorized' : r.status === 403 ? 'forbidden' : r.status === 404 ? 'not_found' : r.status === 422 ? 'validation' : r.status >= 500 ? 'gusto_unavailable' : 'gusto_error';
            throw new GustoError(errorMessageOf(r.data, r.status), { status: r.status, code, details: r.data, retryable: r.status >= 500 });
        }
    }

    const get = (path, o) => request('GET', path, o);
    const post = (path, body, o) => request('POST', path, { ...o, body });
    const put = (path, body, o) => request('PUT', path, { ...o, body });
    const del = (path, o) => request('DELETE', path, o);

    /** Walk page/per pagination. The list may be a bare array or { <key>: [...] }. */
    async function paginate(path, o = {}) {
        const per = o.per || opts.pageSize;
        const all = [];
        for (let page = 1; page <= (o.maxPages || 200); page += 1) {
            const r = await request('GET', path, { ...o, query: { ...(o.query || {}), page, per }, full: true });
            let rows = r.data;
            if (rows && !Array.isArray(rows)) rows = rows[o.key] || Object.values(rows).find(Array.isArray) || [];
            rows = rows || [];
            all.push(...rows);
            const total = Number(r.headers.get('x-total-pages'));
            if (rows.length < per || (Number.isFinite(total) && total > 0 && page >= total)) break;
        }
        return all;
    }

    /**
     * Delta update that needs the object's current `version`: read, build the change, PUT with version.
     * On 409 (somebody changed it) re-read and rebuild, up to `tries` times. `build(current)` returns the
     * body fields to send, or null when nothing needs to change.
     */
    async function putVersioned(getPath, putPath, build, o = {}) {
        const tries = o.tries || 4;
        let lastErr = null;
        for (let i = 0; i < tries; i += 1) {
            const current = await get(getPath, o);
            const fields = build(current);
            if (!fields) return { changed: false, data: current };
            try {
                const data = await put(putPath, { ...fields, version: current.version }, o);
                return { changed: true, data };
            } catch (e) {
                if (e.code !== 'version_conflict') throw e;
                lastErr = e;
                emit('warn', 'version_conflict', { putPath, attempt: i + 1 });
                await sleep(rules.backoffMs(i + 1, 50, 500));
            }
        }
        throw lastErr || new GustoError('Version conflict that did not resolve', { status: 409, code: 'version_conflict' });
    }

    return {
        orgId, opts, request, get, post, put, del, paginate, putVersioned, systemToken, companyToken,
        stats: () => ({ ...app.stats, windowSize: app.limiter.size })
    };
}

module.exports = { createClient, GustoError, redact, resetAppState, errorMessageOf };
