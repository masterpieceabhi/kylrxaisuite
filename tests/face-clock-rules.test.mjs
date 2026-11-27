// Face clock-in on the phone: the server takes only the outcome { matched, liveness } and turns it into flags.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../services/clock-compliance-rules.js');

const policy = { allowedMethods: ['web', 'biometric'], biometric: { enabled: true }, selfie: 'off', geofence: { mode: 'off', accuracyMeters: 100 }, anomaly: { sharedDevice: false, impossibleTravel: false, outsideSchedule: false, repeatedTimestamps: false, newDevice: false }, network: { mode: 'off', allowed: [] }, punchTypes: ['in', 'out'] };
const statuses = { biometric_release: 'ok' };
const base = (faceCheck) => ({ policy, rules: undefined, workState: 'IL', city: '', type: 'in', source: 'web', hasPhoto: false, location: null, statuses, sites: [], deviceHash: null, deviceDoc: null, userDeviceHashes: [], prev: null, recent: [], shifts: [], nowIso: '2026-11-22T14:00:00.000Z', tz: 'America/Chicago', userId: 'u1', ip: '127.0.0.1', faceCheck: R.parseFaceCheck(faceCheck) });
const codes = (ev) => ev.reasons.map((r) => r.code);

test('parseFaceCheck keeps only the two booleans and drops anything else', () => {
    assert.equal(R.parseFaceCheck(null), null);
    assert.equal(R.parseFaceCheck('yes'), null);
    assert.deepEqual(R.parseFaceCheck({ matched: true, liveness: true, descriptor: [1, 2, 3], photo: 'x' }), { matched: true, liveness: true });
    assert.deepEqual(R.parseFaceCheck({ matched: 'true', liveness: 1 }), { matched: false, liveness: false });
});

test('a matched face with a blink passes with no flag', () => {
    const ev = R.evaluatePunch(base({ matched: true, liveness: true }));
    assert.equal(ev.faceCheck, 'matched');
    assert.equal(codes(ev).includes('face_check_missing') || codes(ev).includes('face_not_matched'), false);
});

test('a face that does not match is flagged for review, not blocked', () => {
    const ev = R.evaluatePunch(base({ matched: false, liveness: true }));
    assert.equal(ev.faceCheck, 'not_matched');
    assert.ok(codes(ev).includes('face_not_matched'));
    assert.notEqual(ev.decision, 'block');
});

test('no face check at all is flagged, and the punch still goes through', () => {
    const ev = R.evaluatePunch(base(undefined));
    assert.equal(ev.faceCheck, 'none');
    assert.ok(codes(ev).includes('face_check_missing'));
    assert.notEqual(ev.decision, 'block');
});

test('a match without a blink is not a pass (liveness is required)', () => {
    const ev = R.evaluatePunch(base({ matched: true, liveness: false }));
    assert.equal(ev.faceCheck, 'not_matched');
});

test('when the place has face clock-in off, the face check is not asked for and no flag is raised', () => {
    const off = { ...policy, biometric: { enabled: false }, allowedMethods: ['web'] };
    const ev = R.evaluatePunch({ ...base(undefined), policy: off });
    assert.equal(ev.faceCheck, undefined);
    assert.equal(codes(ev).includes('face_check_missing'), false);
});
