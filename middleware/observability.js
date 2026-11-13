/**
 * Request ids, structured JSON request logs and request metrics.
 *   - X-Request-Id: reuse a safe incoming id, else generate one; echoed on the response and stored on req.id
 *   - one JSON line per finished request on stdout: { ts, level, msg:'request', requestId, method, route, path, status, ms, userId, orgId, ip }
 *   - metrics: kylrx_http_requests_total{method,route,status_class}, kylrx_http_request_duration_seconds{method,route}, kylrx_http_errors_total
 *   - keeps the raw request body for the payment webhook (signature checks need the exact bytes)
 * Query strings and bodies are never logged (they can hold tokens and personal data).
 */
const crypto = require('crypto');
const metrics = require('../services/metrics');
const reporter = require('../services/error-reporter');

reporter.installProcessHooks();

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;
const RAW_BODY_PATHS = [/^\/api\/billing\/webhook/, /^\/api\/webhooks\/gusto\//];
const QUIET = process.env.REQUEST_LOG === 'off';

function routeLabel(req) {
    if (req.route && req.route.path !== undefined) {
        const p = typeof req.route.path === 'string' ? req.route.path : String(req.route.path);
        return `${req.baseUrl || ''}${p === '/' ? '' : p}` || '/';
    }
    const url = req.originalUrl.split('?')[0];
    if (/^\/api\//.test(url)) return 'api_unmatched';
    return /\.[a-z0-9]+$/i.test(url) ? 'static' : 'page';
}

function observability(req, res, next) {
    const incoming = req.headers['x-request-id'];
    req.id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    const start = process.hrtime.bigint();

    res.on('finish', () => {
        const seconds = Number(process.hrtime.bigint() - start) / 1e9;
        const route = routeLabel(req);
        const status = res.statusCode;
        const cls = `${Math.floor(status / 100)}xx`;
        metrics.counter('kylrx_http_requests_total', 'HTTP requests', { method: req.method, route, status_class: cls });
        metrics.observe('kylrx_http_request_duration_seconds', 'HTTP request duration in seconds', { method: req.method, route }, seconds);
        if (status >= 500) metrics.counter('kylrx_http_errors_total', 'HTTP 5xx responses', { route });
        if (QUIET) return;
        const line = {
            ts: new Date().toISOString(), level: status >= 500 ? 'error' : (status >= 400 ? 'warn' : 'info'), msg: 'request', requestId: req.id,
            method: req.method, route, path: req.originalUrl.split('?')[0].slice(0, 200), status, ms: Math.round(seconds * 1000 * 10) / 10,
            userId: (req.user && req.user.id) || null, orgId: req.orgId || (req.user && req.user.orgId) || null, ip: req.ip
        };
        try { process.stdout.write(JSON.stringify(line) + '\n'); } catch (_) {}
        if (status >= 500) reporter.captureMessage(`HTTP ${status} ${req.method} ${route}`, 'error', { requestId: req.id, userId: line.userId, orgId: line.orgId });
    });
    if (req.method === 'POST' && RAW_BODY_PATHS.some((re) => re.test(req.originalUrl))) return readRawBody(req, res, next);
    next();
}

/** Reads the exact bytes (signature checks need them), then hands a parsed copy to the normal pipeline (body-parser skips when req._body is set) */
function readRawBody(req, res, next) {
    const chunks = []; let size = 0; let dead = false;
    req.on('data', (c) => {
        size += c.length;
        if (size > 1024 * 1024 && !dead) { dead = true; res.status(413).json({ success: false, error: 'Payload too large' }); req.destroy(); return; }
        if (!dead) chunks.push(c);
    });
    req.on('end', () => {
        if (dead) return;
        req.rawBody = Buffer.concat(chunks).toString('utf8');
        try { req.body = JSON.parse(req.rawBody); } catch (_) { req.body = {}; }
        req._body = true;
        next();
    });
    req.on('error', next);
}

module.exports = observability;
module.exports.routeLabel = routeLabel;
