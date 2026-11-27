// config/firebase.js falls back to a pretend in-memory database, whose sign-in check accepts any token as a super
// admin, when it has no key. That is for local work and unit tests only. These tests load the file in a fresh
// process with different settings and check when it refuses.
// What this does NOT cover: a real key and a real project.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = "try { const f = require('./config/firebase'); console.log('LOADED ' + (typeof f.db)); } catch (e) { console.log('REFUSED ' + e.message); }";
function load(extra) {
    const env = { ...process.env, ...extra };
    for (const k of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT_PATH', 'NODE_ENV']) if (!(k in extra)) delete env[k];
    env.DOTENV_CONFIG_PATH = path.join(os.tmpdir(), 'no-such-env-file'); // the developer's own .env must not decide the result
    const r = spawnSync(process.execPath, ['-e', SCRIPT], { cwd: root, env, encoding: 'utf8' });
    return (r.stdout || '').split('\n').filter((l) => /^(LOADED|REFUSED)/.test(l)).pop() || `NO RESULT: ${r.stderr.slice(0, 300)}`;
}

test('local work and unit tests still get the pretend database', () => {
    assert.match(load({ NODE_ENV: 'test' }), /^LOADED object/);
    assert.match(load({ NODE_ENV: 'development' }), /^LOADED object/);
});

test('a production server will not start without a database', () => {
    const out = load({ NODE_ENV: 'production' });
    assert.match(out, /^REFUSED Firebase is not configured: set FIREBASE_SERVICE_ACCOUNT/);
});

test('a key that is set but broken stops the server in every mode, instead of quietly using the pretend database', () => {
    for (const NODE_ENV of ['production', 'development', 'test']) {
        assert.match(load({ NODE_ENV, FIREBASE_SERVICE_ACCOUNT: '{ "type": "service_account", broken' }), /^REFUSED Firebase is not configured: FIREBASE_SERVICE_ACCOUNT is set but is not a readable key/, NODE_ENV);
        assert.match(load({ NODE_ENV, FIREBASE_SERVICE_ACCOUNT_PATH: 'no/such/key.json' }), /^REFUSED Firebase is not configured: FIREBASE_SERVICE_ACCOUNT_PATH is set but the key file could not be loaded/, NODE_ENV);
    }
});

test('with the local emulators no key is needed, and the real emulator is used rather than the pretend database', () => {
    assert.match(load({ NODE_ENV: 'development', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), /^LOADED object/);
    // a broken key with the emulator host set: the emulator path is taken (no key is needed for it), so nothing is refused
    assert.match(load({ NODE_ENV: 'development', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080', FIREBASE_SERVICE_ACCOUNT: '{broken' }), /^LOADED object/);
});
