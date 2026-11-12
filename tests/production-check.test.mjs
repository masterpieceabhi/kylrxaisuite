import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkProductionEnv } = require('../services/production-check.js');

const rnd = (n) => crypto.randomBytes(n).toString('hex');
const appDir = path.resolve('/srv/app');
const good = () => ({
    NODE_ENV: 'production', JWT_SECRET: rnd(24), REFRESH_SECRET: rnd(24), PII_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), AUDIT_CHAIN_KEY: rnd(24),
    FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ project_id: 'p', private_key: 'k', client_email: 'e' }), RESEND_API_KEY: 're_x', VAULT_DIR: path.resolve('/srv/vault'), LOG_DIR: path.resolve('/var/log/app'),
    MONITORING_TOKEN: rnd(16), PLATFORM_OPERATOR_TOKEN: rnd(16), SENTRY_DSN: 'https://x@sentry.example/1', GUSTO_CLIENT_ID: 'id', GUSTO_CLIENT_SECRET: 'secret', GUSTO_MODE: 'demo', BILLING_PROVIDER: 'stripe', STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'whsec_x'
});
const run = (over = {}, opts = {}) => checkProductionEnv({ ...good(), ...over }, { appDir, canWrite: () => true, ...opts });
const hasProblem = (r, re) => r.problems.some((p) => re.test(p));

test('a complete set of settings passes with nothing to fix or decide', () => {
    const r = run();
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(r.ok, true);
});

test('an empty environment lists everything that is required', () => {
    const r = checkProductionEnv({}, { appDir });
    assert.equal(r.ok, false);
    for (const re of [/NODE_ENV/, /JWT_SECRET is missing/, /REFRESH_SECRET is missing/, /PII_ENCRYPTION_KEY is missing/, /AUDIT_CHAIN_KEY is missing/, /Firebase service account/, /send email/]) assert.ok(hasProblem(r, re), String(re));
    assert.ok(r.warnings.some((w) => /VAULT_DIR/.test(w)));
});

test('weak, reused or malformed secrets are refused', () => {
    assert.ok(hasProblem(run({ JWT_SECRET: 'short' }), /JWT_SECRET is too short/));
    assert.ok(hasProblem(run({ JWT_SECRET: `changeme${'x'.repeat(40)}` }), /placeholder/));
    const same = rnd(24);
    assert.ok(hasProblem(run({ JWT_SECRET: same, REFRESH_SECRET: same }), /must be different/));
    assert.ok(hasProblem(run({ PII_ENCRYPTION_KEY: 'not-a-key' }), /32 random bytes/));
    assert.ok(hasProblem(run({ PII_ENCRYPTION_KEY: crypto.randomBytes(16).toString('base64') }), /32 random bytes/));
    assert.ok(hasProblem(run({ JWT_SECRET: same, AUDIT_CHAIN_KEY: same }), /must not be the same/));
    assert.ok(hasProblem(run({ FIREBASE_SERVICE_ACCOUNT: '{not json' }), /not valid JSON/));
    assert.ok(hasProblem(run({ FIREBASE_SERVICE_ACCOUNT: '{"type":"x"}' }), /not a service-account key/));
});

test('test-only and unsafe switches are refused', () => {
    assert.ok(hasProblem(run({ NODE_ENV: 'development' }), /NODE_ENV must be/));
    assert.ok(hasProblem(run({ ALLOW_DEV_AUTH: 'true' }), /ALLOW_DEV_AUTH/));
    assert.ok(hasProblem(run({ TENANT_READ_SCOPING: 'off' }), /TENANT_READ_SCOPING/));
    assert.ok(hasProblem(run({ FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' }), /emulators/));
    assert.ok(hasProblem(run({ GUSTO_MODE: 'mock' }), /mock/));
    assert.equal(run({ TENANT_READ_SCOPING: 'on' }).ok, true);
});

test('email, document storage and half-set providers are checked', () => {
    assert.ok(hasProblem(run({ RESEND_API_KEY: '' }), /send email/));
    assert.equal(run({ RESEND_API_KEY: '', SMTP_USER: 'a@b.c', SMTP_PASS: 'p' }).ok, true);
    assert.ok(hasProblem(run({ RESEND_API_KEY: '', SMTP_USER: 'a@b.c' }), /send email/));
    assert.ok(hasProblem(run({ VAULT_DIR: path.join(appDir, 'vault') }), /inside the app folder/));
    assert.ok(hasProblem(run({ VAULT_DIR: appDir }), /inside the app folder/));
    assert.ok(hasProblem(run({}, { canWrite: () => false }), /cannot be written/));
    assert.ok(hasProblem(run({ GUSTO_CLIENT_SECRET: '' }), /both GUSTO_CLIENT_ID and GUSTO_CLIENT_SECRET/));
    assert.ok(hasProblem(run({ STRIPE_WEBHOOK_SECRET: '' }), /STRIPE_WEBHOOK_SECRET/));
    assert.ok(run({ FIREBASE_SERVICE_ACCOUNT: '', FIREBASE_SERVICE_ACCOUNT_PATH: path.join(appDir, 'key.json') }).warnings.some((w) => /inside the app folder/.test(w)));
});

test('optional services left out are warnings, not failures, and no value is ever echoed', () => {
    const secret = `S3CRET${rnd(20)}`;
    const r = run({ JWT_SECRET: secret, GUSTO_CLIENT_ID: '', GUSTO_CLIENT_SECRET: '', BILLING_PROVIDER: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', SENTRY_DSN: '', MONITORING_TOKEN: '', LOG_DIR: '' });
    assert.equal(r.ok, true);
    assert.equal(r.warnings.length, 5);
    assert.ok(hasProblem(run({ STRIPE_SECRET_KEY: '' }), /BILLING_PROVIDER is "stripe" but STRIPE_SECRET_KEY is missing/));
    assert.ok(run({ BILLING_PROVIDER: '' }).warnings.some((w) => /still runs in practice mode/.test(w)));
    assert.ok(run({ STRIPE_SECRET_KEY: 'sk_test_abc' }).warnings.some((w) => /test key/.test(w)));
    const all = JSON.stringify(run({ JWT_SECRET: secret, PII_ENCRYPTION_KEY: 'bad', REFRESH_SECRET: secret }));
    assert.ok(!all.includes(secret) && !all.includes('S3CRET'));
});
