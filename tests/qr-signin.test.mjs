// Sign-in by scanning a personal, one-time QR: services/qr-signin.js with storage, people and tokens held in memory.
// What this does NOT cover: the routes (who may make a QR for whom, the cookie, the audit entries) and Firestore's
// own transaction; those were run by hand against a local server with the emulators on 2026-11-17. Nor the page
// that shows the QR and the page that is opened by scanning it, which are not built here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-qr-signin';
const require = createRequire(import.meta.url);
const qr = require('../services/qr-signin.js');
const pinSignin = require('../services/pin-signin.js');
const bcrypt = require('bcrypt');

const SECRET = 'a-signing-secret-used-only-in-this-test-file';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
let people; let store; let clock; let svc; let minted;

function setUp() {
    clock = new Date('2026-11-17T15:00:00Z');
    minted = [];
    people = new Map([
        ['u1', { uid: 'u1', orgId: 'o1', name: 'Carlos Diaz', email: 'carlos@example.test', active: true, pinHash: null, signinDevices: [], companyName: 'Lone Star Market' }],
        ['u2', { uid: 'u2', orgId: 'o1', name: 'Sofia Nguyen', email: 'sofia@example.test', active: true, pinHash: null, signinDevices: [], companyName: 'Lone Star Market' }],
        ['gone', { uid: 'gone', orgId: 'o1', name: 'Lee Former', email: 'lee@example.test', active: false, pinHash: null, signinDevices: [] }],
        ['nomail', { uid: 'nomail', orgId: 'o1', name: 'Pat Paper', email: null, active: true, signinDevices: [] }]
    ]);
    store = new Map();
    const links = {
        put: async (id, doc) => { store.set(id, { ...doc }); },
        get: async (id) => (store.has(id) ? { ...store.get(id) } : null),
        use: async (id, patch) => { const l = store.get(id); if (!l || l.usedAt || l.cancelledAt) return false; Object.assign(l, patch); return true; },
        cancelOpen: async (uid, patch) => { let n = 0; for (const l of store.values()) if (l.uid === uid && !l.usedAt && !l.cancelledAt) { Object.assign(l, patch); n += 1; } return n; }
    };
    svc = qr.create({
        links, secret: SECRET, now: () => new Date(clock),
        loadPerson: async (uid) => (people.has(uid) ? { ...people.get(uid) } : null),
        savePerson: async (uid, patch) => { Object.assign(people.get(uid), patch); },
        mintToken: async (uid) => { minted.push(uid); return `custom-token-for-${uid}`; }
    });
}
test.beforeEach(setUp);
const gone = (e) => e.status === 404 && e.code === 'qr_not_valid';
const later = (hours) => { clock = new Date(clock.getTime() + hours * 3600000); };

test('a QR is made for one person, lasts a day unless told otherwise, and only its hash is kept', async () => {
    const out = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    assert.match(out.secret, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual([out.hours, out.expiresAt, out.person.id, out.person.emailHint], [24, '2026-11-18T15:00:00.000Z', 'u1', 'ca•••@example.test']);
    assert.equal(store.size, 1);
    const [id, link] = [...store.entries()][0];
    assert.equal(id, sha(out.secret));
    assert.ok(!JSON.stringify(link).includes(out.secret), 'the secret itself is not stored');
    assert.deepEqual([link.uid, link.orgId, link.createdBy, link.forSelf, link.usedAt], ['u1', 'o1', 'hr1', false, null]);
    assert.equal((await svc.createLink({ uid: 'u2', actorId: 'hr1', hours: 72 })).expiresAt, '2026-11-20T15:00:00.000Z');
    for (const hours of [0, 73, -1, 'soon']) await assert.rejects(() => svc.createLink({ uid: 'u2', actorId: 'hr1', hours }), (e) => e.status === 400, String(hours));
});

test('nobody is given a QR who has left, has no sign-in, or does not exist', async () => {
    await assert.rejects(() => svc.createLink({ uid: 'gone', actorId: 'hr1' }), (e) => e.code === 'inactive');
    await assert.rejects(() => svc.createLink({ uid: 'nomail', actorId: 'hr1' }), (e) => e.code === 'no_signin');
    await assert.rejects(() => svc.createLink({ uid: 'nobody', actorId: 'hr1' }), (e) => e.code === 'not_found');
    assert.equal(store.size, 0);
});

test('opening shows who it is for without using it up; confirming signs in, once', async () => {
    const { secret } = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    const seen = await svc.open({ secret });
    assert.deepEqual(seen, { name: 'Carlos', emailHint: 'ca•••@example.test', company: 'Lone Star Market', expiresAt: '2026-11-18T15:00:00.000Z', hasPin: false });
    assert.deepEqual(await svc.open({ secret }), seen, 'looking twice changes nothing');
    assert.deepEqual(minted, [], 'looking signs nobody in');

    const done = await svc.confirm({ secret, deviceToken: '' });
    assert.deepEqual([done.next, done.token, done.uid, done.hasPin], ['signed_in', 'custom-token-for-u1', 'u1', false]);
    assert.match(done.deviceToken, /^[a-f0-9]{64}$/);
    assert.deepEqual(people.get('u1').signinDevices.map((d) => d.h), [sha(done.deviceToken)], 'this device is now a known device');
    assert.ok(done.setupToken);

    await assert.rejects(() => svc.confirm({ secret, deviceToken: '' }), gone, 'a second confirm');
    await assert.rejects(() => svc.open({ secret }), gone, 'a second look after use');
    assert.deepEqual(minted, ['u1'], 'exactly one sign-in came out of it');
});

test('a QR that is wrong, run out, replaced or cancelled gives the same answer and signs nobody in', async () => {
    for (const secret of ['', 'short', 'x'.repeat(43), '../../etc/passwd', null]) await assert.rejects(() => svc.confirm({ secret }), gone, String(secret));

    const old = await svc.createLink({ uid: 'u1', actorId: 'hr1', hours: 2 });
    later(2.01);
    await assert.rejects(() => svc.open({ secret: old.secret }), gone, 'after it ran out');
    await assert.rejects(() => svc.confirm({ secret: old.secret }), gone);

    const first = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    const second = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    await assert.rejects(() => svc.confirm({ secret: first.secret }), gone, 'a newer QR replaces the older one');
    assert.equal((await svc.open({ secret: second.secret })).name, 'Carlos');

    assert.deepEqual(await svc.cancel({ uid: 'u1', actorId: 'hr1' }), { cancelled: 1 });
    await assert.rejects(() => svc.confirm({ secret: second.secret }), gone, 'cancelled');
    assert.deepEqual(await svc.cancel({ uid: 'u1', actorId: 'hr1' }), { cancelled: 0 });
    assert.deepEqual(minted, []);
});

test('a QR stops working the moment the person leaves, or is moved to another company', async () => {
    const a = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    people.get('u1').active = false;
    await assert.rejects(() => svc.confirm({ secret: a.secret }), gone);
    people.get('u1').active = true;
    people.get('u1').orgId = 'o2';
    await assert.rejects(() => svc.confirm({ secret: a.secret }), gone);
    assert.deepEqual(minted, []);
});

test('one person\'s QR never cancels or opens another person\'s', async () => {
    const a = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    const b = await svc.createLink({ uid: 'u2', actorId: 'hr1' });
    assert.equal((await svc.confirm({ secret: b.secret })).uid, 'u2');
    assert.equal((await svc.confirm({ secret: a.secret })).uid, 'u1');
});

test('a device that already holds a device token keeps it, and old devices fall off after ten', async () => {
    const held = 'ab'.repeat(32);
    const one = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    assert.equal((await svc.confirm({ secret: one.secret, deviceToken: held })).deviceToken, held, 'two people sharing a screen do not push each other out');
    const again = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    await svc.confirm({ secret: again.secret, deviceToken: held });
    assert.equal(people.get('u1').signinDevices.length, 1, 'the same device is listed once');
    for (let i = 0; i < 12; i += 1) { const l = await svc.createLink({ uid: 'u1', actorId: 'hr1' }); await svc.confirm({ secret: l.secret, deviceToken: '' }); }
    assert.equal(people.get('u1').signinDevices.length, 10);
});

test('after a QR sign-in the person chooses a PIN, and that PIN then signs them in on that device through the PIN sign-in', async () => {
    const { secret } = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    const done = await svc.confirm({ secret, deviceToken: '' });
    await assert.rejects(() => svc.setPin({ setupToken: done.setupToken, pin: '1234' }), (e) => e.code === 'weak_pin', 'the same PIN rules as everywhere');
    await assert.rejects(() => svc.setPin({ setupToken: 'not-a-token', pin: '4821' }), (e) => e.code === 'expired');
    assert.equal((await svc.setPin({ setupToken: done.setupToken, pin: '4821' })).saved, true);
    assert.ok(await bcrypt.compare('4821', people.get('u1').pinHash));

    // the PIN sign-in itself (the other way in), reading the same person record
    const pin = pinSignin.create({
        findPerson: async (email) => { const p = [...people.values()].find((x) => x.email === email); return p ? { ...p } : null; },
        savePerson: async (uid, patch) => { Object.assign(people.get(uid), patch); },
        otp: { generateOtp: () => ({ otpId: 'o', code: '111111' }), verifyOtp: () => ({ success: false }) },
        mintToken: async (uid) => `custom-token-for-${uid}`, sendCode: async () => true, secret: SECRET, showCode: false, now: () => new Date(clock)
    });
    const express = await pin.start({ email: 'carlos@example.test', pin: '4821', deviceToken: done.deviceToken });
    assert.deepEqual([express.next, express.token], ['signed_in', 'custom-token-for-u1'], 'the PIN is the quick way in after a QR sign-in');
    assert.equal((await pin.start({ email: 'carlos@example.test', pin: '4821', deviceToken: 'cd'.repeat(32) })).next, 'choose', 'not on a device that never proved who they are');
    assert.equal((await pin.start({ email: 'carlos@example.test', pin: '9999', deviceToken: done.deviceToken })).next, 'retry', 'not with a wrong PIN (on their own device it only says try again)');
});

test('the PIN set-up token from a QR sign-in cannot be swapped for another kind of token, and dies in ten minutes', async () => {
    const { secret } = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    const done = await svc.confirm({ secret });
    const jwt = require('jsonwebtoken');
    const other = jwt.sign({ type: 'signin_code', uid: 'u2' }, SECRET, { expiresIn: 600 });
    await assert.rejects(() => svc.setPin({ setupToken: other, pin: '4821' }), (e) => e.code === 'expired');
    const forged = jwt.sign({ type: 'qr_pin_setup', uid: 'u2' }, 'a-different-secret', { expiresIn: 600 });
    await assert.rejects(() => svc.setPin({ setupToken: forged, pin: '4821' }), (e) => e.code === 'expired');
    people.get('u1').active = false;
    await assert.rejects(() => svc.setPin({ setupToken: done.setupToken, pin: '4821' }), (e) => e.code === 'expired', 'the person left in the meantime');
    assert.equal(people.get('u2').pinHash, null);
});

test('a used QR says who made it, so the person can be told', async () => {
    const byHr = await svc.createLink({ uid: 'u1', actorId: 'hr1' });
    const a = await svc.confirm({ secret: byHr.secret });
    assert.deepEqual([a.madeBy, a.forSelf], ['hr1', false]);
    const mine = await svc.createLink({ uid: 'u2', actorId: 'u2', hours: 1 });
    const b = await svc.confirm({ secret: mine.secret });
    assert.deepEqual([b.madeBy, b.forSelf], ['u2', true]);
});

test('records of QRs that ran out more than 30 days ago are removed, a batch at a time, at most once an hour', async () => {
    const calls = [];
    const links = {
        put: async (id, doc) => { store.set(id, { ...doc }); }, get: async (id) => store.get(id) || null, use: async () => true, cancelOpen: async () => 0,
        removeExpiredBefore: async (iso, max) => { calls.push([iso, max]); let n = 0; for (const [id, l] of store) if (l.expiresAt < iso && n < max) { store.delete(id); n += 1; } return n; }
    };
    const s2 = qr.create({ links, secret: SECRET, now: () => new Date(clock), loadPerson: async (uid) => ({ ...people.get(uid) }), savePerson: async () => {}, mintToken: async () => 't' });
    store.set('old-used', { uid: 'u1', expiresAt: '2026-10-01T00:00:00.000Z', usedAt: '2026-09-30T10:00:00.000Z' });
    store.set('old-cancelled', { uid: 'u2', expiresAt: '2026-10-17T14:59:59.000Z', cancelledAt: '2026-10-15T10:00:00.000Z' });
    store.set('recent-used', { uid: 'u2', expiresAt: '2026-11-10T00:00:00.000Z', usedAt: '2026-11-09T10:00:00.000Z' });

    await s2.createLink({ uid: 'u1', actorId: 'hr1' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [['2026-10-18T15:00:00.000Z', 200]], '30 days before now, 200 at most');
    assert.deepEqual([store.has('old-used'), store.has('old-cancelled'), store.has('recent-used'), store.size], [false, false, true, 2], 'only what ran out long ago goes; the new link stays');

    await s2.createLink({ uid: 'u2', actorId: 'hr1' });
    later(0.5); await s2.createLink({ uid: 'u2', actorId: 'hr1' });
    assert.equal(calls.length, 1, 'not again within the hour');
    later(0.6); await s2.createLink({ uid: 'u2', actorId: 'hr1' });
    assert.equal(calls.length, 2, 'again after an hour');
});

test('a tidy-up that fails, or a store that cannot do it, never fails making a QR', async () => {
    const base = { put: async (id, doc) => { store.set(id, { ...doc }); }, get: async (id) => store.get(id) || null, use: async () => true, cancelOpen: async () => 0 };
    const deps = { secret: SECRET, now: () => new Date(clock), loadPerson: async (uid) => ({ ...people.get(uid) }), savePerson: async () => {}, mintToken: async () => 't' };
    const broken = qr.create({ ...deps, links: { ...base, removeExpiredBefore: async () => { throw new Error('database is down'); } } });
    assert.ok((await broken.createLink({ uid: 'u1', actorId: 'hr1' })).secret);
    assert.equal(await broken._tidy(), null, 'already tried this hour');
    const without = qr.create({ ...deps, links: base });
    assert.ok((await without.createLink({ uid: 'u1', actorId: 'hr1' })).secret);
    await new Promise((r) => setImmediate(r));
});

test('the email shown is masked', () => {
    assert.equal(qr.maskEmail('carlos@example.test'), 'ca•••@example.test');
    assert.equal(qr.maskEmail('al@example.test'), 'a•••@example.test');
    assert.equal(qr.maskEmail('a@example.test'), 'a•••@example.test');
    assert.equal(qr.maskEmail(''), '');
    assert.equal(qr.maskEmail('not-an-email'), '');
});
