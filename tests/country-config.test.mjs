import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveCountryCode, getCountryConfig, isPageHidden, INDIA_ONLY_PAGES } = require('../country-config.js');

test('country names and codes resolve, unknown or missing falls back to India', () => {
    assert.equal(resolveCountryCode('US'), 'US');
    assert.equal(resolveCountryCode('United States'), 'US');
    assert.equal(resolveCountryCode(' usa '), 'US');
    assert.equal(resolveCountryCode('Canada'), 'CA');
    assert.equal(resolveCountryCode('India'), 'IN');
    assert.equal(resolveCountryCode(undefined), 'IN');
    assert.equal(resolveCountryCode('Atlantis'), 'IN');
});

test('India keeps every page and uses INR', () => {
    const cfg = getCountryConfig('India');
    assert.equal(cfg.currency, 'INR');
    assert.deepEqual(cfg.hiddenPages, []);
    assert.equal(isPageHidden('IN', 'admin-statutory-compliance.html'), false);
});

test('US uses USD, EIN and SSN, and hides every India-only page', () => {
    const cfg = getCountryConfig('United States');
    assert.equal(cfg.currency, 'USD');
    assert.equal(cfg.taxIdLabel, 'EIN');
    assert.equal(cfg.personalIdLabel, 'SSN');
    assert.equal(cfg.payrollProvider, 'gusto-embedded');
    for (const page of INDIA_ONLY_PAGES) {
        assert.equal(isPageHidden('US', page), true, page);
    }
    assert.equal(isPageHidden('US', '/app/admin-statutory-compliance.html?x=1#top'), true);
    assert.equal(isPageHidden('US', 'admin-dashboard.html'), false);
});

test('Canada uses CAD, BN and SIN and hides India-only pages', () => {
    const cfg = getCountryConfig('CA');
    assert.equal(cfg.currency, 'CAD');
    assert.equal(cfg.taxIdLabel, 'BN');
    assert.equal(cfg.personalIdLabel, 'SIN');
    assert.equal(isPageHidden('CA', 'payroll-disbursement.html'), true);
});

test('every country defines the fields the app relies on', () => {
    for (const code of ['IN', 'US', 'CA']) {
        const cfg = getCountryConfig(code);
        for (const key of ['code', 'name', 'currency', 'locale', 'dateFormat', 'timeZones', 'taxIdLabel', 'personalIdLabel', 'payrollProvider', 'hiddenPages', 'modules']) {
            assert.ok(cfg[key] !== undefined, `${code}.${key}`);
        }
        assert.ok(cfg.timeZones.length > 0, `${code} time zones`);
    }
});
