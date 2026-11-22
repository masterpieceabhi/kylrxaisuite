// Face clock-in: a worker can give the biometric release before the place turns the method on, so the enable guard can pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../services/clock-compliance-rules.js');

const offeredFor = (policy, state, city = '') => {
    const hypo = R.requirements({ ...policy, allowedMethods: [...(policy.allowedMethods || []), 'biometric'], biometric: { enabled: true } }, state, city);
    return hypo.methods.biometric || [];
};
const off = { allowedMethods: ['web'], biometric: { enabled: false } };

test('an Illinois worker is offered the written release while the place has face clock-in off', () => {
    assert.deepEqual(offeredFor(off, 'IL'), ['biometric_release']);
});

test('a state with no biometric rule offers nothing', () => {
    assert.deepEqual(offeredFor(off, 'FL'), []);
});

test('the enable guard fails until the worker has the release, and passes after', () => {
    const policy = { allowedMethods: ['web', 'biometric'], biometric: { enabled: true } };
    const workers = [{ userId: 'u1', workState: 'IL', city: '' }];
    const none = R.biometricGuard(policy, workers, undefined, () => 'none');
    assert.equal(none.ok, false);
    assert.deepEqual(none.missing[0].types, ['biometric_release']);
    const ok = R.biometricGuard(policy, workers, undefined, (uid, t) => (t === 'biometric_release' ? 'ok' : 'none'));
    assert.equal(ok.ok, true);
});
