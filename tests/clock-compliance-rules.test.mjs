import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../services/clock-compliance-rules.js');
const bio = require('../services/biometric-adapter.js');

const pol = (over = {}) => R.validatePolicy({ allowedMethods: ['web'], ...over }).value;

test('every seeded jurisdiction row is marked verify and carries the counsel note', () => {
    assert.ok(R.DEFAULT_JURISDICTIONS.length >= 8);
    for (const r of R.DEFAULT_JURISDICTIONS) { assert.equal(r.verify, true); assert.match(r.note, /counsel/); }
});

test('no policy: nothing is required and nothing is blocked (one-tap path)', () => {
    const ev = R.evaluatePunch({ policy: null, type: 'in' });
    assert.equal(ev.decision, 'allow');
    assert.deepEqual(R.requirements(null, 'IL', null).types, []);
});

test('requirements: IL biometric needs a written release; TX and WA need consent; NYC needs the city notice', () => {
    const p = pol({ biometric: { enabled: true } });
    assert.deepEqual(R.requirements(p, 'IL', 'Chicago').methods.biometric, ['biometric_release']);
    assert.deepEqual(R.requirements(p, 'TX', 'Austin').methods.biometric, ['biometric_consent']);
    assert.deepEqual(R.requirements(p, 'WA', 'Seattle').methods.biometric, ['biometric_consent']);
    assert.ok(R.requirements(p, 'NY', 'New York').methods.biometric.includes('nyc_biometric_notice'));
    assert.ok(!R.requirements(p, 'NY', 'Buffalo').methods.biometric.includes('nyc_biometric_notice'));
    assert.deepEqual(R.requirements(p, 'FL', null).methods.biometric, []);
});

test('requirements: selfie in NY/CT/DE needs the monitoring notice, in CA the CPRA notice, in TX nothing', () => {
    const p = pol({ selfie: 'required' });
    assert.deepEqual(R.requirements(p, 'NY', null).methods.selfie_photo, ['monitoring_notice']);
    assert.deepEqual(R.requirements(p, 'CT', null).methods.selfie_photo, ['monitoring_notice']);
    assert.deepEqual(R.requirements(p, 'DE', null).methods.selfie_photo, ['monitoring_notice']);
    assert.deepEqual(R.requirements(p, 'CA', null).methods.selfie_photo, ['cpra_notice']);
    assert.deepEqual(R.requirements(p, 'TX', null).methods.selfie_photo, []);
    assert.deepEqual(R.requirements(pol({ selfie: 'required', requireNotice: true }), 'TX', null).methods.selfie_photo, ['photo_notice']);
});

test('web and kiosk PIN never need a consent by default', () => {
    assert.deepEqual(R.requirements(pol(), 'NY', 'New York').types, []);
});

test('policy validation and most-specific resolution', () => {
    assert.ok(R.validatePolicy({ selfie: 'maybe' }).errors.length);
    assert.ok(R.validatePolicy({ geofence: { mode: 'block', accuracyMeters: 1 } }).errors.length);
    assert.ok(R.validatePolicy({ photoRetentionDays: 0 }).errors.length);
    assert.equal(R.validatePolicy({}).value.photoRetentionDays, 30);
    const list = [{ scope: 'org', id: 'o' }, { scope: 'state', state: 'TX', id: 's' }, { scope: 'location', locationId: 'L1', id: 'l' }];
    assert.equal(R.resolvePolicy(list, { state: 'TX', locationId: 'L1' }).id, 'l');
    assert.equal(R.resolvePolicy(list, { state: 'TX' }).id, 's');
    assert.equal(R.resolvePolicy(list, { state: 'OH' }).id, 'o');
});

test('consent status: none, ok, stale after a new notice version, declined after revocation', () => {
    assert.equal(R.consentStatus([], 'cpra_notice', 1), 'none');
    const c = { type: 'cpra_notice', version: 1, decision: 'accepted', signedAt: '2026-01-01T00:00:00Z' };
    assert.equal(R.consentStatus([c], 'cpra_notice', 1), 'ok');
    assert.equal(R.consentStatus([c], 'cpra_notice', 2), 'stale');
    assert.equal(R.consentStatus([{ ...c, revokedAt: '2026-02-01' }], 'cpra_notice', 1), 'declined');
});

const base = (policy, over = {}) => ({ policy, rules: R.DEFAULT_JURISDICTIONS, workState: 'TX', city: null, type: 'in', source: 'web', hasPhoto: false, location: null, statuses: {}, sites: [], nowIso: '2026-11-09T14:00:00Z', tz: 'America/Chicago', userId: 'u1', recent: [], ...over });

test('required selfie missing blocks; supplied photo is used', () => {
    const p = pol({ selfie: 'required' });
    assert.equal(R.evaluatePunch(base(p)).decision, 'block');
    assert.equal(R.evaluatePunch(base(p)).reasons[0].code, 'selfie_required');
    const ok = R.evaluatePunch(base(p, { hasPhoto: true }));
    assert.equal(ok.decision, 'allow'); assert.equal(ok.usePhoto, true);
    assert.equal(R.evaluatePunch(base(pol({ selfie: 'optional' }))).decision, 'allow');
});

test('consent missing blocks a required selfie in NY; declined falls back with a flag', () => {
    const p = pol({ selfie: 'required' });
    const ny = (statuses) => R.evaluatePunch(base(p, { workState: 'NY', hasPhoto: true, statuses }));
    assert.equal(ny({}).reasons[0].code, 'consent_required');
    assert.deepEqual(ny({}).pendingTypes, ['monitoring_notice']);
    assert.equal(ny({ monitoring_notice: 'stale' }).decision, 'block');
    assert.equal(ny({ monitoring_notice: 'ok' }).decision, 'allow');
    const declined = ny({ monitoring_notice: 'declined' });
    assert.equal(declined.decision, 'flag'); assert.equal(declined.usePhoto, false);
});

test('optional selfie without consent is simply off, not blocking', () => {
    const ev = R.evaluatePunch(base(pol({ selfie: 'optional' }), { workState: 'CA', hasPhoto: true }));
    assert.equal(ev.decision, 'allow'); assert.equal(ev.usePhoto, false);
});

const site = { id: 's1', name: 'Hotel', lat: 30.2672, lng: -97.7431, radiusMeters: 150, active: true };
test('geofence modes: off / record / flag / block', () => {
    const near = { lat: 30.2673, lng: -97.7431, accuracy: 20 };
    const far = { lat: 30.30, lng: -97.70, accuracy: 20 };
    const g = (mode, location, extra = {}) => R.evaluatePunch(base(pol({ allowedMethods: ['web', 'geofence'], geofence: { mode, accuracyMeters: 100 } }), { location, sites: [site], ...extra }));
    assert.equal(g('off', far).storeLocation, false);
    const rec = g('record', far); assert.equal(rec.decision, 'allow'); assert.equal(rec.storeLocation, true); assert.ok(rec.distanceMeters > 1000);
    assert.equal(g('flag', far).decision, 'flag');
    assert.equal(g('flag', near).decision, 'allow');
    assert.equal(g('block', far).decision, 'block');
    assert.equal(g('block', far).reasons[0].code, 'outside_geofence');
    assert.equal(g('block', { ...near, accuracy: 900 }).reasons[0].code, 'low_accuracy');
    assert.equal(g('block', null).reasons[0].code, 'location_required');
    assert.equal(g('flag', null).decision, 'flag');
});

test('anomaly helpers: impossible travel, shared device, schedule, repeated times', () => {
    const a = { lat: 30.27, lng: -97.74 }; const b = { lat: 40.71, lng: -74.0 };
    assert.ok(R.impossibleTravel({ at: '2026-11-09T13:00:00Z', location: a }, { at: '2026-11-09T14:00:00Z', location: b }));
    assert.equal(R.impossibleTravel({ at: '2026-11-09T06:00:00Z', location: a }, { at: '2026-11-09T14:00:00Z', location: { lat: 30.28, lng: -97.74 } }), null);
    const dev = { users: { u2: '2026-11-09T13:30:00Z', u3: '2026-11-09T13:40:00Z', old: '2026-11-08T10:00:00Z' } };
    assert.deepEqual(R.sharedDevice(dev, 'u1', '2026-11-09T14:00:00Z', 120, 1), { others: 2 });
    assert.equal(R.sharedDevice({ users: { u1: '2026-11-09T13:30:00Z' } }, 'u1', '2026-11-09T14:00:00Z', 120, 1), null);
    assert.ok(R.outsideSchedule([{ startAt: '2026-11-09T21:00:00Z', endAt: '2026-11-10T01:00:00Z' }], 'in', '2026-11-09T14:00:00Z'));
    assert.equal(R.outsideSchedule([], 'in', '2026-11-09T14:00:00Z'), null);
    const rec = ['2026-11-04', '2026-11-05', '2026-11-06'].map((d) => ({ type: 'in', at: `${d}T14:00:30Z` }));
    assert.equal(R.repeatedTimes(rec, 'in', 'America/Chicago', '2026-11-09T14:00:10Z'), true);
    assert.equal(R.repeatedTimes(rec, 'in', 'America/Chicago', '2026-11-09T15:30:10Z'), false);
});

test('anomalies are flags, never blocks; kiosks are exempt from shared-device flags', () => {
    const p = pol({ allowedMethods: ['web'] });
    const dev = { users: { u2: '2026-11-09T13:30:00Z' } };
    const web = R.evaluatePunch(base(p, { deviceHash: 'h', deviceDoc: dev }));
    assert.equal(web.decision, 'flag'); assert.equal(web.reasons[0].code, 'shared_device');
    assert.equal(R.evaluatePunch(base(p, { deviceHash: 'h', deviceDoc: dev, source: 'kiosk' })).decision, 'allow');
});

test('biometric guard: cannot enable where consent is required until every worker has it', () => {
    const p = pol({ biometric: { enabled: true } });
    const workers = [{ userId: 'a', workState: 'IL' }, { userId: 'b', workState: 'FL' }];
    const g1 = R.biometricGuard(p, workers, R.DEFAULT_JURISDICTIONS, () => 'none');
    assert.equal(g1.ok, false); assert.deepEqual(g1.missing.map((m) => m.userId), ['a']);
    assert.equal(R.biometricGuard(p, workers, R.DEFAULT_JURISDICTIONS, () => 'ok').ok, true);
});

test('biometric adapter is an unavailable stub until a full adapter is registered', async () => {
    assert.equal(bio.isAvailable(), false);
    await assert.rejects(() => bio.verify({}), /not implemented/);
    assert.throws(() => bio.register({ enroll() {} }), /missing/);
});

test('photo upload validation: JPEG only, max about 300 KB', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 1)]);
    assert.equal(R.parsePhoto(`data:image/jpeg;base64,${jpeg.toString('base64')}`).ok, true);
    assert.equal(R.parsePhoto(Buffer.alloc(500, 1).toString('base64')).error, 'not_jpeg');
    assert.equal(R.parsePhoto(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(310 * 1024)]).toString('base64')).error, 'too_large');
    assert.equal(R.parsePhoto('').ok, false);
});

test('notice text hash changes with the text', () => {
    const n = R.DEFAULT_NOTICES.cpra_notice;
    assert.notEqual(R.textHashOf(n), R.textHashOf({ ...n, body_en: `${n.body_en}!` }));
    for (const t of R.CONSENT_TYPES) assert.ok(R.DEFAULT_NOTICES[t].body_es.length > 20, t);
});
