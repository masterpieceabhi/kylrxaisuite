/**
 * Safe outbound HTTP for webhooks and connectors (SSRF protection).
 *
 *  - https only in production (http allowed elsewhere)
 *  - literal IPs and resolved addresses are checked against private/loopback/link-local/metadata ranges
 *  - resolve-then-connect: the address that was checked is the address connected to (custom `lookup`),
 *    so DNS rebinding between check and connect is not possible
 *  - redirects are never followed (a 3xx is returned to the caller as a failure)
 *  - timeout and response size caps
 *
 * Local testing: WEBHOOK_ALLOW_LOOPBACK=true lets http://127.0.0.1 / localhost through (loopback
 * only; other private ranges stay blocked). It is ignored when NODE_ENV=production.
 */
const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const isProd = () => process.env.NODE_ENV === 'production';
const loopbackAllowed = () => !isProd() && process.env.WEBHOOK_ALLOW_LOOPBACK === 'true';

function ipv4ToInt(ip) { return ip.split('.').reduce((a, o) => (a * 256) + Number(o), 0); }
const V4_BLOCKS = [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
    ['224.0.0.0', 4], ['240.0.0.0', 4]
].map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 }));

function isLoopback(ip) {
    if (net.isIPv4(ip)) return ip.startsWith('127.');
    const v = ip.toLowerCase();
    if (v === '::1') return true;
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return Boolean(m && m[1].startsWith('127.'));
}

/** True for addresses a server must never be tricked into calling */
function isPrivateIp(ip) {
    if (!net.isIP(ip)) return true; // anything unparseable is refused
    if (net.isIPv4(ip)) {
        const n = ipv4ToInt(ip);
        return V4_BLOCKS.some((b) => ((n & b.mask) >>> 0) === ((b.base & b.mask) >>> 0));
    }
    const v = ip.toLowerCase();
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    const mappedHex = v.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16); const lo = parseInt(mappedHex[2], 16);
        return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (v === '::' || v === '::1') return true;
    if (/^(fc|fd)/.test(v)) return true;               // unique local fc00::/7
    if (/^fe[89ab]/.test(v)) return true;              // link local fe80::/10
    if (/^ff/.test(v)) return true;                    // multicast
    if (/^64:ff9b:/.test(v)) return true;              // NAT64
    if (/^2001:db8/.test(v)) return true;              // documentation
    return false;
}

/** Cheap synchronous checks on the URL text. Returns { ok, error, url } */
function validateUrl(raw) {
    let url;
    try { url = new URL(String(raw)); } catch (_) { return { ok: false, error: 'url is not a valid URL' }; }
    if (url.username || url.password) return { ok: false, error: 'url must not contain credentials' };
    if (!['https:', 'http:'].includes(url.protocol)) return { ok: false, error: 'url must use https' };
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const lb = loopbackAllowed();
    if (url.protocol === 'http:' && isProd()) return { ok: false, error: 'url must use https' };
    if (net.isIP(host)) {
        if (isPrivateIp(host) && !(lb && isLoopback(host))) return { ok: false, error: 'url points to a private or reserved address' };
    } else if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host) && !(lb && (host === 'localhost' || host.endsWith('.localhost')))) {
        return { ok: false, error: 'url points to an internal host name' };
    }
    return { ok: true, url };
}

/** dns.lookup replacement that refuses private results; used as the socket's lookup */
function guardedLookup(hostname, options, callback) {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
        if (err) return cb(err);
        const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIPv6(addresses) ? 6 : 4 }];
        const lb = loopbackAllowed();
        const bad = list.find((a) => isPrivateIp(a.address) && !(lb && isLoopback(a.address)));
        if (bad || !list.length) {
            const e = new Error(`blocked: ${hostname} resolves to a private or reserved address`);
            e.code = 'SSRF_BLOCKED';
            return cb(e);
        }
        if (opts.all) return cb(null, list);
        return cb(null, list[0].address, list[0].family);
    });
}

/**
 * Sends one request. Resolves { status, headers, body, ms } or rejects with an Error (code SSRF_BLOCKED, ETIMEDOUT, ...).
 * `lookup` can be injected for tests (simulated DNS rebinding).
 */
function safeRequest({ url, method = 'POST', headers = {}, body, timeoutMs = 10000, maxBytes = 1024 * 1024, lookup }) {
    const check = validateUrl(url);
    if (!check.ok) { const e = new Error(check.error); e.code = 'SSRF_BLOCKED'; return Promise.reject(e); }
    const u = check.url;
    const lib = u.protocol === 'https:' ? https : http;
    const payload = body === undefined || body === null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const req = lib.request({
            protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: `${u.pathname}${u.search}`, method,
            headers: { ...headers, ...(payload ? { 'Content-Length': payload.length } : {}) },
            lookup: lookup || guardedLookup, agent: false, timeout: timeoutMs
        }, (res) => {
            const chunks = []; let size = 0;
            res.on('data', (c) => { if (size < maxBytes) chunks.push(c.subarray(0, maxBytes - size)); size += c.length; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started, redirected: res.statusCode >= 300 && res.statusCode < 400 }));
            res.on('error', reject);
        });
        req.on('timeout', () => { const e = new Error('request timed out'); e.code = 'ETIMEDOUT'; req.destroy(e); });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

module.exports = { isPrivateIp, isLoopback, validateUrl, guardedLookup, safeRequest, loopbackAllowed };
