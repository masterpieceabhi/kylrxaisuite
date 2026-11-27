import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const S = require('../services/sso.js');

const ok = { enabled: true, providerId: 'oidc.entra', allowedDomains: ['Example.com', '@corp.example.org'], enforce: false, breakGlassEmails: ['owner@example.com'] };

test('valid SSO settings are normalized', () => {
    const r = S.validateSettings(ok);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.value.allowedDomains, ['example.com', 'corp.example.org']);
    assert.equal(r.value.providerId, 'oidc.entra');
});

test('provider id must be a Firebase oidc.* or saml.* id', () => {
    for (const id of ['entra', 'google.com', 'oidc.', 'OIDC.bad id', 'saml.', '']) {
        assert.ok(S.validateSettings({ ...ok, providerId: id }).errors.some((e) => /providerId/.test(e)), id);
    }
    assert.deepEqual(S.validateSettings({ ...ok, providerId: 'saml.okta' }).errors, []);
});

test('domains and break-glass emails are checked', () => {
    assert.ok(S.validateSettings({ ...ok, allowedDomains: ['not a domain'] }).errors.some((e) => /domain/.test(e)));
    assert.ok(S.validateSettings({ ...ok, allowedDomains: [] }).errors.some((e) => /at least one/.test(e)));
    assert.ok(S.validateSettings({ ...ok, breakGlassEmails: ['nope'] }).errors.some((e) => /breakGlassEmails/.test(e)));
});

test('enforcing SSO needs SSO on and a break-glass account', () => {
    assert.ok(S.validateSettings({ ...ok, enabled: false, enforce: true }).errors.some((e) => /Turn single sign-on on/.test(e)));
    assert.ok(S.validateSettings({ ...ok, enforce: true, breakGlassEmails: [] }).errors.some((e) => /break-glass/.test(e)));
    assert.deepEqual(S.validateSettings({ ...ok, enforce: true }).errors, []);
});

test('an email maps to its domain', () => {
    assert.equal(S.domainOf('Jamie@Example.COM'), 'example.com');
    assert.equal(S.domainOf('no-at-sign'), null);
});
