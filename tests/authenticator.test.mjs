// Signing in with a code from an authenticator app: services/totp.js (the codes), services/authenticator.js (setting
// an app up) and the "app" choice of services/pin-signin.js, with people held in memory.
// What this does NOT cover: the routes (run by hand against a local server with the emulators on 2026-11-19), a real
// authenticator app on a real phone, and the sign-in page, which does not offer the choice yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-authenticator';
process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);
const totp = require('../services/totp.js');
const authenticator = require('../services/authenticator.js');
const pinSignin = require('../services/pin-signin.js');

const T0 = Date.parse('2026-11-19T15:00:10Z');
const codeAt = (secret, ms) => totp.codeFor(secret, totp.counterAt(ms));

/* ------------------------------- the codes ------------------------------- */

test('the codes are the standard ones: the published test values of RFC 6238 come out right', () => {
    const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    // the RFC lists 8-digit codes; a 6-digit code is the same number's last six digits
    for (const [seconds, eight] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
        assert.equal(totp.codeFor(secret, totp.counterAt(seconds * 1000)), eight.slice(2), `at ${seconds}`);
    }
    assert.equal(totp.base32Decode(secret).toString(), '12345678901234567890');
    assert.equal(totp.base32Decode('not base32!'), null);
    assert.equal(totp.codeFor('!!!', 1), null);
});

test('a new secret is 32 letters and digits, different every time, and the app link carries it', () => {
    const a = totp.newSecret(); const b = totp.newSecret();
    assert.match(a, /^[A-Z2-7]{32}$/); assert.notEqual(a, b);
    const url = totp.otpauthUrl({ account: 'ann+hr@example.test', secret: a });
    assert.equal(url, `otpauth://totp/Onn%20HR:ann%2Bhr%40example.test?secret=${a}&issuer=Onn%20HR&algorithm=SHA1&digits=6&period=30`);
});

test('a code works now and half a minute either side, never twice, and never when it is not six digits', () => {
    const s = totp.newSecret();
    assert.equal(totp.verify(s, codeAt(s, T0), T0).ok, true);
    assert.equal(totp.verify(s, codeAt(s, T0 - 30000), T0).ok, true, 'the phone clock is half a minute slow');
    assert.equal(totp.verify(s, codeAt(s, T0 + 30000), T0).ok, true, 'or fast');
    assert.equal(totp.verify(s, codeAt(s, T0 - 90000), T0).ok, false, 'an old code');
    assert.equal(totp.verify(s, codeAt(s, T0 + 90000), T0).ok, false);
    const first = totp.verify(s, codeAt(s, T0), T0);
    assert.equal(totp.verify(s, codeAt(s, T0), T0, { lastCounter: first.counter }).ok, false, 'the same code a second time');
    assert.equal(totp.verify(s, codeAt(s, T0 - 30000), T0, { lastCounter: first.counter }).ok, false, 'nor an earlier one');
    assert.equal(totp.verify(s, codeAt(s, T0 + 30000), T0 + 30000, { lastCounter: first.counter }).ok, true, 'the next one is fine');
    for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined, '12 34 5']) assert.equal(totp.verify(s, bad, T0).ok, false, String(bad));
    assert.equal(totp.verify(s, ` ${codeAt(s, T0).slice(0, 3)} ${codeAt(s, T0).slice(3)} `, T0).ok, true, 'typed with a space, as apps show it');
    assert.equal(totp.verify(totp.newSecret(), codeAt(s, T0), T0).ok, false, 'someone else’s code');
});

/* ------------------------------- setting an app up ------------------------------- */

function world() {
    const people = new Map([['u1', { uid: 'u1', email: 'ann@example.test' }]]);
    let clock = T0;
    const setPath = (obj, key, value) => { const parts = key.split('.'); let o = obj; while (parts.length > 1) { const p = parts.shift(); o[p] = o[p] && typeof o[p] === 'object' ? o[p] : {}; o = o[p]; } if (value === null && key === 'totp') delete obj.totp; else o[parts[0]] = value; };
    const svc = authenticator.create({
        encrypt: (plain, c) => `enc(${c})${Buffer.from(plain).toString('base64')}`,
        decrypt: (payload, c) => { const m = new RegExp(`^enc\\(${c}\\)(.+)$`).exec(payload); if (!m) throw new Error('wrong key or context'); return Buffer.from(m[1], 'base64').toString(); },
        save: async (uid, patch) => { for (const [k, v] of Object.entries(patch)) setPath(people.get(uid), k, v); },
        now: () => new Date(clock)
    });
    return { people, svc, me: () => people.get('u1'), tick: (ms) => { clock += ms; }, now: () => clock };
}

test('an app is switched on only after a code from it was typed, and the secret is stored encrypted', async () => {
    const w = world();
    assert.deepEqual(w.svc.statusOf(w.me()), { enabled: false, since: null, lastUsedAt: null });
    const started = await w.svc.begin(w.me());
    assert.match(started.secret, /^[A-Z2-7]{32}$/); assert.ok(started.otpauthUrl.includes(started.secret));
    assert.equal(w.svc.statusOf(w.me()).enabled, false, 'starting does not switch it on');
    assert.ok(!JSON.stringify(w.me()).includes(started.secret), 'the secret is not stored as it is');

    await assert.rejects(() => w.svc.confirm(w.me(), '000000'), (e) => e.code === 'wrong_code');
    assert.equal(w.svc.statusOf(w.me()).enabled, false);
    assert.deepEqual(await w.svc.confirm(w.me(), codeAt(started.secret, w.now())), { enabled: true });
    assert.equal(w.svc.statusOf(w.me()).enabled, true);
    assert.equal(w.me().totp.pendingEnc, undefined, 'the unfinished set-up is gone');
    assert.ok(!JSON.stringify(w.me()).includes(started.secret));
    await assert.rejects(() => w.svc.begin(w.me()), (e) => e.code === 'already_on');
    await assert.rejects(() => w.svc.confirm(w.me(), '123456'), (e) => e.code === 'already_on');
});

test('a set-up left unfinished for 15 minutes has to be started again, and starting again makes a new secret', async () => {
    const w = world();
    const first = await w.svc.begin(w.me());
    w.tick(16 * 60000);
    await assert.rejects(() => w.svc.confirm(w.me(), codeAt(first.secret, w.now())), (e) => e.code === 'start_again');
    const second = await w.svc.begin(w.me());
    assert.notEqual(second.secret, first.secret);
    await assert.rejects(() => w.svc.confirm(w.me(), codeAt(first.secret, w.now())), (e) => e.code === 'wrong_code', 'the old secret no longer counts');
    assert.equal((await w.svc.confirm(w.me(), codeAt(second.secret, w.now()))).enabled, true);
});

test('removing it takes a current code; five wrong codes lock it for a while; someone who manages the person can remove it without one', async () => {
    const w = world();
    const { secret } = await w.svc.begin(w.me());
    await w.svc.confirm(w.me(), codeAt(secret, w.now()));
    w.tick(60000);
    for (let i = 0; i < 5; i += 1) await assert.rejects(() => w.svc.remove(w.me(), '000000'), (e) => e.code === 'wrong_code');
    await assert.rejects(() => w.svc.remove(w.me(), codeAt(secret, w.now())), (e) => e.code === 'locked', 'even the right code waits out the lock');
    w.tick(16 * 60000);
    assert.deepEqual(await w.svc.remove(w.me(), codeAt(secret, w.now())), { enabled: false });
    assert.equal(w.me().totp, undefined);
    assert.deepEqual(await w.svc.remove(w.me(), ''), { enabled: false }, 'nothing to remove is not an error');

    const again = await w.svc.begin(w.me());
    await w.svc.confirm(w.me(), codeAt(again.secret, w.now()));
    assert.deepEqual(await w.svc.removeFor(w.me()), { enabled: false, wasEnabled: true });
    assert.equal(w.svc.statusOf(w.me()).enabled, false);
});

/* ------------------------------- signing in with it ------------------------------- */

function signin(person) {
    let clock = T0 + 5 * 60000;
    const saved = [];
    const svc = pinSignin.create({
        findPerson: async (email) => (person && email === person.email ? { ...person, totp: person.totp ? { ...person.totp } : null } : null),
        savePerson: async (uid, patch) => { saved.push(patch); for (const [k, v] of Object.entries(patch)) { if (k.startsWith('totp.')) person.totp[k.slice(5)] = v; else person[k] = v; } },
        otp: { generateOtp: () => { throw new Error('no code should be made for the app choice'); }, verifyOtp: () => ({ success: false }) },
        sendCode: async () => { throw new Error('nothing should be emailed'); }, sendText: async () => { throw new Error('nothing should be texted'); },
        mintToken: async (uid) => `token-for-${uid}`, totp, secret: 'signing-secret-for-this-test', showCode: false, now: () => new Date(clock)
    });
    return { svc, saved, now: () => clock, tick: (ms) => { clock += ms; } };
}
const someone = (extra = {}) => ({ uid: 'u1', email: 'ann@example.test', phone: '', pinHash: null, pinAttempts: 0, pinLockedUntil: null, signinDevices: [], active: true, ...extra });

test('with an app set up, a person on a new device signs in with the app code: nothing is emailed or texted', async () => {
    const secret = totp.newSecret();
    const person = someone({ totp: { secret, lastCounter: null, attempts: 0, lockedUntil: null } });
    const s = signin(person);
    const first = await s.svc.start({ email: person.email, pin: '', deviceToken: '' });
    assert.equal(first.next, 'choose');
    const chosen = await s.svc.requestCode({ challenge: first.challenge, via: 'app' });
    assert.deepEqual([chosen.next, chosen.via, chosen.devCode], ['code', 'app', undefined]);
    await assert.rejects(() => s.svc.verifyCode({ challenge: chosen.challenge, code: '000000', deviceToken: '' }), (e) => e.code === 'wrong_code');
    const done = await s.svc.verifyCode({ challenge: chosen.challenge, code: codeAt(secret, s.now()), deviceToken: '' });
    assert.deepEqual([done.next, done.token], ['signed_in', 'token-for-u1']);
    assert.match(done.deviceToken, /^[a-f0-9]{64}$/); assert.ok(done.setupToken, 'and may now choose a PIN');
    assert.equal(person.signinDevices.length, 1, 'the device is now a known device, so the PIN works on it next time');
    assert.equal(person.totp.attempts, 0);
    // the same code cannot be used again, even with a fresh challenge
    const again = await s.svc.requestCode({ challenge: (await s.svc.start({ email: person.email, pin: '', deviceToken: '' })).challenge, via: 'app' });
    await assert.rejects(() => s.svc.verifyCode({ challenge: again.challenge, code: codeAt(secret, s.now()), deviceToken: '' }), (e) => e.code === 'wrong_code');
    s.tick(30000);
    assert.equal((await s.svc.verifyCode({ challenge: again.challenge, code: codeAt(secret, s.now()), deviceToken: '' })).next, 'signed_in', 'the next code is fine');
});

test('the answers do not say who has an app: no app, an unknown email and a wrong code all look the same', async () => {
    const withApp = signin(someone({ totp: { secret: totp.newSecret(), lastCounter: null, attempts: 0, lockedUntil: null } }));
    const noApp = signin(someone({ totp: null }));
    const nobody = signin(null);
    const answers = [];
    for (const s of [withApp, noApp, nobody]) {
        const c = await s.svc.requestCode({ challenge: (await s.svc.start({ email: 'ann@example.test', pin: '', deviceToken: '' })).challenge, via: 'app' });
        answers.push([c.next, c.via, c.message, typeof c.challenge]);
        await assert.rejects(() => s.svc.verifyCode({ challenge: c.challenge, code: '123456', deviceToken: '' }), (e) => e.status === 401 && e.code === 'wrong_code' && e.message === 'That code is not right, or it has run out.');
    }
    assert.deepEqual(answers[0], answers[1]); assert.deepEqual(answers[1], answers[2]);
});

test('five wrong app codes lock the app for a while, and the email and text choices still work as before', async () => {
    const secret = totp.newSecret();
    const person = someone({ totp: { secret, lastCounter: null, attempts: 0, lockedUntil: null } });
    const s = signin(person);
    const c = await s.svc.requestCode({ challenge: (await s.svc.start({ email: person.email, pin: '', deviceToken: '' })).challenge, via: 'app' });
    for (let i = 0; i < 5; i += 1) await assert.rejects(() => s.svc.verifyCode({ challenge: c.challenge, code: '000000', deviceToken: '' }), (e) => e.code === 'wrong_code');
    assert.ok(person.totp.lockedUntil, 'locked');
    await assert.rejects(() => s.svc.verifyCode({ challenge: c.challenge, code: codeAt(secret, s.now()), deviceToken: '' }), (e) => e.code === 'wrong_code', 'the right code waits out the lock, with the same answer');
    await assert.rejects(() => s.svc.requestCode({ challenge: c.challenge, via: 'pigeon' }), (e) => e.status === 401 || e.status === 400);
});
