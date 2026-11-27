// Error reports never carry SSNs, account numbers or email addresses (services/error-reporter.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scrub } = require('../services/error-reporter.js');

test('an error text loses anything that looks like an SSN, an account number or an email address', () => {
    assert.equal(scrub('SSN 123-45-6789 failed'), 'SSN [hidden] failed');
    assert.equal(scrub('account 000981234567 refused'), 'account [hidden] refused');
    assert.equal(scrub('routing 021000021'), 'routing [hidden]');
    assert.equal(scrub('no user jay@promptaiusa.com'), 'no user [email]');
    assert.equal(scrub('order 42 in week 2026-11-16 at 10:30'), 'order 42 in week 2026-11-16 at 10:30', 'ordinary numbers and dates stay');
    assert.equal(scrub(null), '');
});
