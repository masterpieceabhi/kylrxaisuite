/**
 * Gusto configuration. Environment first, then stored per-company settings (gusto_connections/{orgId}).
 *
 * Modes:
 *   mock        our own mock server (scripts/mock-gusto.js), for development and tests
 *   demo        https://api.gusto-demo.com  (needs partner demo credentials)
 *   production  https://api.gusto.com       (needs approval; also needs GUSTO_ALLOW_PRODUCTION=true)
 */
const MODES = ['mock', 'demo', 'production'];

const BASE_URLS = {
    demo: 'https://api.gusto-demo.com',
    production: 'https://api.gusto.com'
};

// Pinned API version (a date). Gusto ships dated versions; change deliberately and re-run the sandbox checks.
const DEFAULT_API_VERSION = '2025-06-15';

function env(name, fallback) {
    const v = process.env[name];
    return v === undefined || v === '' ? fallback : v;
}

function num(name, fallback) {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && process.env[name] !== '' ? n : fallback;
}

function baseUrlFor(mode) {
    const override = env('GUSTO_BASE_URL', null);
    if (override) return override.replace(/\/+$/, '');
    if (mode === 'mock') return env('GUSTO_MOCK_URL', 'http://127.0.0.1:4010').replace(/\/+$/, '');
    return BASE_URLS[mode] || null;
}

/** Defaults for the mock so local setups need no secrets; real modes demand real credentials. */
function credentialsFor(mode, stored = {}) {
    const clientId = env('GUSTO_CLIENT_ID', stored.clientId || (mode === 'mock' ? 'mock-client-id' : null));
    const clientSecret = env('GUSTO_CLIENT_SECRET', stored.clientSecret || (mode === 'mock' ? 'mock-client-secret' : null));
    return { clientId, clientSecret };
}

/**
 * Runtime options for the HTTP client.
 * `stored` is the (decrypted-where-needed) connection document; may be empty.
 */
function resolve(stored = {}) {
    const mode = MODES.includes(stored.mode) ? stored.mode : MODES.includes(env('GUSTO_MODE')) ? env('GUSTO_MODE') : 'mock';
    const { clientId, clientSecret } = credentialsFor(mode, stored);
    return {
        mode,
        baseUrl: baseUrlFor(mode),
        clientId,
        clientSecret,
        apiVersion: env('GUSTO_API_VERSION', DEFAULT_API_VERSION),
        idempotencyHeader: env('GUSTO_IDEMPOTENCY_HEADER', 'Idempotency-Key'), // unconfirmed name: see docs/GUSTO.md
        timeoutMs: num('GUSTO_TIMEOUT_MS', 20000),
        maxRetries: num('GUSTO_MAX_RETRIES', 4),
        backoffBaseMs: num('GUSTO_BACKOFF_BASE_MS', 400),
        rateLimitPerMinute: num('GUSTO_RATE_LIMIT_PER_MINUTE', 170), // Gusto allows 200 per app+user; keep headroom
        rateWindowMs: num('GUSTO_RATE_WINDOW_MS', 60000),
        tokenSkewSec: num('GUSTO_TOKEN_SKEW_SEC', 120), // refresh this long before expiry
        lockLeaseMs: num('GUSTO_LOCK_LEASE_MS', 20000),
        pageSize: num('GUSTO_PAGE_SIZE', 100),
        achBusinessDays: num('GUSTO_ACH_BUSINESS_DAYS', 4),
        sendSsn: env('GUSTO_SEND_SSN', 'true') !== 'false',
        publicBaseUrl: env('PUBLIC_BASE_URL', null)
    };
}

function validateForMode(opts) {
    const errors = [];
    if (!MODES.includes(opts.mode)) errors.push(`mode must be one of: ${MODES.join(', ')}`);
    if (!opts.baseUrl) errors.push('no base URL for this mode');
    if (opts.mode !== 'mock' && (!opts.clientId || !opts.clientSecret)) errors.push(`GUSTO_CLIENT_ID and GUSTO_CLIENT_SECRET are required in ${opts.mode} mode`);
    if (opts.mode === 'production' && env('GUSTO_ALLOW_PRODUCTION', 'false') !== 'true') errors.push('production mode is switched off: set GUSTO_ALLOW_PRODUCTION=true after Gusto approves the application');
    if (opts.mode === 'mock' && process.env.NODE_ENV === 'production') errors.push('mock mode is not allowed when NODE_ENV=production');
    return errors;
}

module.exports = { MODES, BASE_URLS, DEFAULT_API_VERSION, resolve, validateForMode, baseUrlFor };
