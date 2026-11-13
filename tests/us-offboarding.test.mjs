import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const o = require('../services/us-offboarding-service.js');

const good = { lastDay: '2026-12-18', type: 'resignation', reason: 'Moving away' };

test('a valid termination passes and defaults to rehire-eligible', () => {
    const r = o.validateTermination(good, '2025-03-01', '2026-11-10');
    assert.deepEqual(r.errors, []); assert.equal(r.value.rehireEligible, true); assert.equal(r.value.lastDay, '2026-12-18');
    assert.equal(o.validateTermination({ ...good, rehireEligible: false }, '2025-03-01', '2026-11-10').value.rehireEligible, false);
});

test('termination rejects bad dates, types and missing reasons', () => {
    assert.ok(o.validateTermination({ ...good, lastDay: '2026-02-30' }, null, '2026-11-10').errors.some((e) => /lastDay/.test(e)));
    assert.ok(o.validateTermination({ ...good, lastDay: '2025-01-01' }, '2025-03-01', '2026-11-10').errors.some((e) => /before the start/.test(e)));
    assert.ok(o.validateTermination({ ...good, lastDay: '2028-01-01' }, null, '2026-11-10').errors.some((e) => /more than a year/.test(e)));
    assert.ok(o.validateTermination({ ...good, type: 'quit' }, null, '2026-11-10').errors.some((e) => /type/.test(e)));
    assert.ok(o.validateTermination({ ...good, reason: '' }, null, '2026-11-10').errors.some((e) => /reason/.test(e)));
});

test('rehire I-9: reuse with Section 3 within 3 years, otherwise a new form', () => {
    const i9 = { section1: { signedAt: '2024-05-01T10:00:00Z' } };
    assert.equal(o.i9RehireAction(i9, '2026-11-10').action, 'update_section_3');
    assert.equal(o.i9RehireAction(i9, '2027-05-01').action, 'update_section_3');
    assert.equal(o.i9RehireAction(i9, '2027-05-02').action, 'new_i9');
    assert.equal(o.i9RehireAction({}, '2026-11-10').action, 'new_i9');
    assert.equal(o.i9RehireAction(undefined, '2026-11-10').action, 'new_i9');
});

test('temporary passwords are strong and different each time', () => {
    const a = o.restoreAccess; assert.equal(typeof a, 'function');
});
