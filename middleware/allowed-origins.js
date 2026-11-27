/**
 * Which web addresses may call the API from a browser (CORS).
 *
 *   - no Origin header (a phone app, a server, curl): allowed; those callers are held by sign-in, not by CORS
 *   - localhost and 127.0.0.1 on any port: allowed outside production only
 *   - the product's own addresses: always
 *   - anything named in ALLOWED_ORIGINS: a comma-separated list of exact origins, for a client app served from
 *     its own address, for example  ALLOWED_ORIGINS=https://app.onnhr.com,https://staging.onnhr.com
 *
 * Every match is exact (scheme, host and port). A pattern that only looks at the end of the name would also let
 * in "evil-app.onnhr.com.example" or another project whose name merely ends the same way.
 */
const BUILT_IN = ['https://kylrxai.web.app', 'https://kylrxai.firebaseapp.com', 'https://app.kylrxai.com'];
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/** One entry of ALLOWED_ORIGINS as an exact origin, or null when it is not one (a path, a wildcard, plain http on a real host) */
function cleanOrigin(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.includes('*')) return null;
    let u;
    try { u = new URL(raw); } catch (_) { return null; }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOCAL.test(u.origin))) return null;
    if (u.username || u.password || (u.pathname && u.pathname !== '/') || u.search || u.hash) return null;
    return u.origin;
}

/** { origins: the usable entries, rejected: the entries that were ignored } */
function configured(env = process.env) {
    const origins = []; const rejected = [];
    for (const part of String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)) {
        const o = cleanOrigin(part);
        if (o) { if (!origins.includes(o)) origins.push(o); } else rejected.push(part.slice(0, 100));
    }
    return { origins, rejected };
}

function isAllowedOrigin(origin, env = process.env) {
    if (!origin) return true;
    const o = String(origin);
    if (LOCAL.test(o)) return env.NODE_ENV !== 'production';
    return BUILT_IN.includes(o) || configured(env).origins.includes(o);
}

module.exports = { isAllowedOrigin, configured, cleanOrigin, BUILT_IN };
