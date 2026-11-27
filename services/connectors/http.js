/**
 * HTTP client for connectors. All traffic goes through services/ssrf.js (https in production,
 * private addresses blocked, no redirects). Tests inject a `transport` that records requests
 * and returns canned responses, so adapters are verified without real vendor accounts.
 */
const ssrf = require('../ssrf');

class HttpError extends Error {
    constructor(message, { status = null, body = null, retryable = false } = {}) {
        super(message); this.name = 'HttpError'; this.status = status; this.body = body; this.retryable = retryable;
    }
}

const defaultTransport = (req) => ssrf.safeRequest({ url: req.url, method: req.method, headers: req.headers, body: req.body, timeoutMs: req.timeoutMs });

const qs = (q) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q || {})) if (v !== undefined && v !== null) p.append(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : '';
};

function createHttp({ transport = defaultTransport, timeoutMs = 15000 } = {}) {
    async function request({ method = 'GET', url, headers = {}, json, form, body, query, expect }) {
        const h = { Accept: 'application/json', ...headers };
        let payload = body;
        if (json !== undefined) { payload = JSON.stringify(json); h['Content-Type'] = h['Content-Type'] || 'application/json'; }
        else if (form !== undefined) { payload = new URLSearchParams(form).toString(); h['Content-Type'] = 'application/x-www-form-urlencoded'; }
        const full = `${url}${url.includes('?') && query ? qs(query).replace('?', '&') : qs(query)}`;
        let res;
        try { res = await transport({ method, url: full, headers: h, body: payload, timeoutMs }); }
        catch (e) { throw new HttpError(`network error: ${e.code || e.message}`, { retryable: e.code !== 'SSRF_BLOCKED' }); }
        const text = res.body || '';
        let parsed;
        const ct = String((res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || '');
        if (/json/i.test(ct) || /^\s*[\[{]/.test(text)) { try { parsed = JSON.parse(text); } catch (_) { /* not json */ } }
        const out = { status: res.status, ok: res.status >= 200 && res.status < 300, headers: res.headers || {}, text, json: parsed };
        if (!out.ok && expect !== false) {
            const detail = (parsed && (parsed.message || parsed.error_description || (parsed.error && (parsed.error.message || parsed.error)) || (parsed.Fault && JSON.stringify(parsed.Fault)))) || text.slice(0, 200);
            throw new HttpError(`HTTP ${res.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`, { status: res.status, body: parsed || text, retryable: res.status === 429 || res.status >= 500 });
        }
        return out;
    }
    return { request };
}

/** Mock transport for tests: records calls; `handler(call, n)` returns { status, body, headers } */
function mockTransport(handler) {
    const calls = [];
    const fn = async (req) => {
        const call = { method: req.method, url: req.url, headers: req.headers, body: req.body };
        try { call.json = req.body ? JSON.parse(req.body) : undefined; } catch (_) { /* not json */ }
        calls.push(call);
        const r = await handler(call, calls.length);
        const body = typeof r.body === 'string' || r.body === undefined ? (r.body || '') : JSON.stringify(r.body);
        return { status: r.status || 200, headers: { 'content-type': typeof r.body === 'string' && r.body.trim().startsWith('<') ? 'application/xml' : 'application/json', ...(r.headers || {}) }, body };
    };
    fn.calls = calls;
    return fn;
}

module.exports = { createHttp, HttpError, mockTransport, defaultTransport };
