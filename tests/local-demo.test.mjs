import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../services/local-demo.js');
const guard = require('../middleware/static-guard.js');

const EMU = { NODE_ENV: 'development', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
const local = (query = {}, over = {}) => ({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:3000' }, query, ...over });

test('the helper exists only with both emulators and never in production', () => {
    assert.equal(D.enabled(EMU), true);
    assert.equal(D.enabled({ ...EMU, NODE_ENV: undefined }), true);
    assert.equal(D.enabled({ ...EMU, NODE_ENV: 'production' }), false);
    assert.equal(D.enabled({ NODE_ENV: 'development' }), false);
    assert.equal(D.enabled({ NODE_ENV: 'development', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), false);
    assert.equal(D.enabled({ NODE_ENV: 'development', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' }), false);
    assert.equal(D.enabled({ NODE_ENV: 'development', ALLOW_DEV_AUTH: 'true' }), false); // dev tokens alone do not turn it on
    assert.equal(D.enabled({}), false);
});

test('a local request gets the list of accounts, then one account at a time', () => {
    const list = D.respond(local(), EMU);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, { success: true, accounts: ['superAdmin', 'hrAdmin', 'manager', 'employee'] });
    assert.equal(JSON.stringify(list.body).includes('password'), false);
    const one = D.respond(local({ account: 'hrAdmin' }), EMU);
    assert.equal(one.status, 200); assert.equal(one.body.email, 'hr@us.demo.local'); assert.equal(typeof one.body.password, 'string'); assert.ok(one.body.password.length >= 8);
    assert.equal(D.respond(local({ account: 'hrAdmin' }), { ...EMU, SEED_PASSWORD: 'Another#Seed1' }).body.password, 'Another#Seed1');
    for (const email of Object.values(D.ACCOUNTS)) assert.match(email, /@us\.demo\.local$/); // only the throwaway seed accounts
    assert.equal(D.respond(local({ account: 'root' }), EMU).status, 400);
    assert.equal(D.respond(local({ account: 'constructor' }), EMU).status, 400);
    assert.equal(D.respond(local({ account: '__proto__' }), EMU).status, 400);
});

test('anything that is not this machine, or not the emulator setup, sees a plain 404', () => {
    const gone = (req, env = EMU) => { const r = D.respond(req, env); assert.equal(JSON.stringify(r.body).includes('password'), false); return r.status === 404; };
    assert.ok(gone(local({ account: 'hrAdmin' }), { ...EMU, NODE_ENV: 'production' }));
    assert.ok(gone(local({ account: 'hrAdmin' }), { NODE_ENV: 'development' }));
    assert.ok(gone(local({ account: 'hrAdmin' }, { socket: { remoteAddress: '203.0.113.9' } })));
    assert.ok(gone(local({ account: 'hrAdmin' }, { socket: { remoteAddress: '192.168.1.20' } })));
    assert.ok(gone(local({ account: 'hrAdmin' }, { headers: { host: 'hr.example.com' } })));
    assert.ok(gone(local({ account: 'hrAdmin' }, { headers: { host: 'localhost.evil.com:3000' } })));
    // a tunnel or proxy on this machine forwards with these headers: refused even though the peer is loopback
    assert.ok(gone(local({ account: 'hrAdmin' }, { headers: { host: 'localhost:3000', 'x-forwarded-for': '127.0.0.1' } })));
    assert.ok(gone(local({ account: 'hrAdmin' }, { headers: { host: 'localhost:3000', forwarded: 'for=127.0.0.1' } })));
    assert.ok(gone(local({ account: 'hrAdmin' }, { socket: undefined })));
    assert.ok(gone({}));
    // the forwarded address is never trusted: only the real peer counts
    assert.ok(gone({ ip: '127.0.0.1', socket: { remoteAddress: '198.51.100.7' }, headers: { host: 'localhost:3000' }, query: { account: 'hrAdmin' } }));
    assert.equal(D.respond(local({}, { socket: { remoteAddress: '::1' }, headers: { host: '127.0.0.1:3000' } }), EMU).status, 200);
    assert.equal(D.respond(local({}, { socket: { remoteAddress: '::ffff:127.0.0.1' } }), EMU).status, 200);
});

test('the handler answers with no-store', () => {
    const saved = { ...process.env };
    Object.assign(process.env, EMU);
    try {
        const out = { headers: {} };
        const res = { set(k, v) { out.headers[k] = v; return this; }, status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
        D.handler(local({ account: 'employee' }), res);
        assert.equal(out.status, 200); assert.equal(out.headers['Cache-Control'], 'no-store'); assert.equal(out.body.email, 'employee@us.demo.local');
    } finally {
        for (const k of Object.keys(EMU)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
});

test('the route is added to the auth router only in the emulator setup', () => {
    const load = (env) => {
        const saved = {}; const keys = ['NODE_ENV', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIRESTORE_EMULATOR_HOST'];
        for (const k of keys) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
        process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
        try {
            // only the decision is under test here: read the source the way node would, without opening a database connection
            const src = fs.readFileSync(new URL('../routes/auth.js', import.meta.url), 'utf8');
            assert.match(src, /if \(localDemo\.enabled\(process\.env\)\) router\.get\('\/dev-demo-login', localDemo\.handler\);/);
            return D.enabled(process.env);
        } finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
    };
    assert.equal(load(EMU), true);
    assert.equal(load({ ...EMU, NODE_ENV: 'production' }), false);
    assert.equal(load({ NODE_ENV: 'development' }), false);
});

test('the sign-in page no longer carries any demo account or password', () => {
    for (const file of ['login.js', 'login.html']) {
        const src = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        assert.equal(/LocalTest#/i.test(src), false, `${file} holds the demo password`);
        assert.equal(/LOCAL_DEMO_PASSWORD/.test(src), false, file);
        assert.equal(/@us\.demo\.local|@demo\.local/.test(src), false, `${file} holds a demo account`);
        assert.equal(/passwordInput\.value\s*=\s*['"`]/.test(src), false, `${file} fills in a fixed password`);
    }
    assert.match(fs.readFileSync(new URL('../login.js', import.meta.url), 'utf8'), /\/api\/auth\/dev-demo-login/);
    // and the server file that knows the seed password is never served to a browser
    assert.equal(guard.isBlocked('/services/local-demo.js'), true);
    assert.equal(guard.isBlocked('/routes/auth.js'), true);
    assert.equal(guard.isBlocked('/scripts/seed-emulator.js'), true);
});
