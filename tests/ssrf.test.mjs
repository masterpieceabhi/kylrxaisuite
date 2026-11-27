import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../services/ssrf.js');

test('private and reserved addresses are recognised', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', 'not-an-ip']) {
        assert.equal(S.isPrivateIp(ip), true, ip);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
        assert.equal(S.isPrivateIp(ip), false, ip);
    }
});

test('validateUrl rejects bad schemes, credentials, private hosts', () => {
    delete process.env.WEBHOOK_ALLOW_LOOPBACK;
    assert.equal(S.validateUrl('ftp://example.com/x').ok, false);
    assert.equal(S.validateUrl('https://user:pw@example.com/').ok, false);
    assert.equal(S.validateUrl('https://169.254.169.254/latest/meta-data').ok, false);
    assert.equal(S.validateUrl('https://[::1]/').ok, false);
    assert.equal(S.validateUrl('https://localhost/').ok, false);
    assert.equal(S.validateUrl('https://service.internal/').ok, false);
    assert.equal(S.validateUrl('https://example.com/hook').ok, true);
    assert.equal(S.validateUrl('nonsense').ok, false);
});

test('loopback flag allows only loopback, and never in production', () => {
    process.env.WEBHOOK_ALLOW_LOOPBACK = 'true';
    assert.equal(S.validateUrl('http://127.0.0.1:9000/h').ok, true);
    assert.equal(S.validateUrl('http://localhost:9000/h').ok, true);
    assert.equal(S.validateUrl('http://10.0.0.5/h').ok, false);
    assert.equal(S.validateUrl('http://169.254.169.254/').ok, false);
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    assert.equal(S.validateUrl('http://127.0.0.1:9000/h').ok, false);
    assert.equal(S.validateUrl('http://example.com/h').ok, false);
    process.env.NODE_ENV = prev;
    delete process.env.WEBHOOK_ALLOW_LOOPBACK;
});

test('resolve-then-connect: a hostname that resolves to a private address is refused', async () => {
    const lookup = (host, opts, cb) => { const done = typeof opts === 'function' ? opts : cb; done(null, [{ address: '10.0.0.8', family: 4 }]); };
    // injected lookup bypasses the guard on purpose here; test the guard itself with a fake dns
    const dns = require('node:dns');
    const orig = dns.lookup;
    dns.lookup = (h, o, cb) => cb(null, [{ address: '192.168.0.9', family: 4 }]);
    try {
        await assert.rejects(S.safeRequest({ url: 'https://rebind.example.com/x', method: 'POST', body: '{}' }), (e) => e.code === 'SSRF_BLOCKED');
    } finally { dns.lookup = orig; }
    assert.ok(lookup);
});

test('redirects are reported, not followed; responses are capped', async () => {
    process.env.WEBHOOK_ALLOW_LOOPBACK = 'true';
    let hits = 0;
    const server = http.createServer((req, res) => {
        hits += 1;
        if (req.url === '/r') { res.writeHead(302, { Location: 'http://127.0.0.1:1/x' }); return res.end(); }
        res.end('x'.repeat(5000));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await S.safeRequest({ url: `${base}/r`, method: 'GET' });
    assert.equal(r.status, 302);
    assert.equal(r.redirected, true);
    assert.equal(hits, 1);
    const big = await S.safeRequest({ url: `${base}/big`, method: 'GET', maxBytes: 100 });
    assert.equal(big.body.length, 100);
    await new Promise((r2) => server.close(r2));
    delete process.env.WEBHOOK_ALLOW_LOOPBACK;
});
