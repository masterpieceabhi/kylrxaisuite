// Signing in with a PIN, and a code by email or text as the way back in (services/pin-signin.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt');
const pinSignin = require('../services/pin-signin.js');

function world({ showCode = false } = {}) {
    const people = new Map();
    const sent = [];   // emails
    const texts = [];  // text messages
    const codes = new Map();
    let n = 0; let clock = Date.parse('2026-11-17T12:00:00Z');
    const otp = {
        generateOtp({ identifier }) { n += 1; const otpId = `otp${n}`; const code = String(100000 + n); codes.set(otpId, { identifier, code, used: false }); return { otpId, code }; },
        verifyOtp({ otpId, code }) { const r = codes.get(otpId); if (!r || r.used || r.code !== code) return { success: false }; r.used = true; return { success: true }; }
    };
    const service = pinSignin.create({
        findPerson: async (email) => { const p = [...people.values()].find((x) => x.email === email); return p ? { ...p, signinDevices: [...(p.signinDevices || [])] } : null; },
        savePerson: async (uid, patch) => { Object.assign(people.get(uid), patch); },
        otp, mintToken: async (uid) => `token-for-${uid}`,
        sendCode: async (email, code) => { sent.push({ email, code }); return true; },
        sendText: async (phone, code) => { texts.push({ phone, code }); return true; },
        secret: 'test-secret', showCode, now: () => new Date(clock)
    });
    /** start, then ask for the code by email: what most people do */
    const byEmail = async (args) => { const a = await service.start(args); return a.next === 'choose' ? service.requestCode({ challenge: a.challenge, via: 'email' }) : a; };
    return {
        service, people, sent, texts, byEmail,
        advance: (minutes) => { clock += minutes * 60000; },
        async add(uid, email, pin, extra = {}) { people.set(uid, { uid, email, phone: '', pinHash: pin ? await bcrypt.hash(pin, 4) : null, pinAttempts: 0, pinLockedUntil: null, signinDevices: [], active: true, ...extra }); },
        /** signs in with an emailed code and returns the device token, as a browser that keeps the cookie would */
        async knownDevice(email, pin) { const a = await byEmail({ email, pin }); const b = await service.verifyCode({ challenge: a.challenge, code: sent.at(-1).code }); return b.deviceToken; }
    };
}
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);

test('a PIN must be 4 to 6 digits and not an obvious one', () => {
    for (const bad of ['', '123', '1234567', '12a4', '0000', '777777', '1234', '4321', '23456', '987654']) assert.ok(pinSignin.weakPin(bad), bad);
    for (const good of ['4826', '1357', '90210', '112233']) assert.equal(pinSignin.weakPin(good), null, good);
});

test('a US mobile number is read as its ten digits, however it is typed', () => {
    for (const same of ['4145550123', '(414) 555-0123', '414.555.0123', '+1 414 555 0123', '1-414-555-0123']) assert.equal(pinSignin.tenDigits(same), '4145550123', same);
    for (const bad of ['', '5550123', '414555012', '44145550123', '+44 20 7946 0958', 'call me']) assert.equal(pinSignin.tenDigits(bad), '', bad);
});

test('the right PIN on a device seen before signs in at once, and no code is sent', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826');
    const device = await w.knownDevice('ana@shop.test', '4826');
    const before = w.sent.length;
    const out = await w.service.start({ email: ' Ana@Shop.test ', pin: '4826', deviceToken: device });
    assert.deepEqual(out, { next: 'signed_in', token: 'token-for-u1' });
    assert.equal(w.sent.length, before);
});

test('nothing is sent until the person chooses where the code goes', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826', { phone: '414-555-0123' });
    const out = await w.service.start({ email: 'ana@shop.test', pin: '9999' });
    assert.equal(out.next, 'choose'); assert.equal(out.token, undefined);
    assert.equal(w.sent.length + w.texts.length, 0);
    await rejects(w.service.requestCode({ challenge: out.challenge, via: 'pigeon' }), 'bad_input');
    await rejects(w.service.requestCode({ challenge: out.challenge, via: 'phone', phone: '555' }), 'bad_input');
    await rejects(w.service.requestCode({ challenge: 'made.up.token', via: 'email' }), 'expired');
    await rejects(w.service.verifyCode({ challenge: out.challenge, code: '100001' }), 'expired'); // a choice is not a code step
});

test('the right PIN on a device not seen before still needs the code', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826');
    const out = await w.byEmail({ email: 'ana@shop.test', pin: '4826', deviceToken: 'f'.repeat(64) });
    assert.equal(out.next, 'code'); assert.equal(out.token, undefined);
    assert.equal(w.sent.length, 1);
    const done = await w.service.verifyCode({ challenge: out.challenge, code: w.sent[0].code });
    assert.equal(done.token, 'token-for-u1'); assert.equal(done.pinWasRight, true); assert.equal(done.hasPin, true);
    assert.match(done.deviceToken, /^[a-f0-9]{64}$/);
    assert.equal(w.people.get('u1').signinDevices.length, 1);
});

test('a code by text goes only to the mobile number already on the record', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826', { phone: '(414) 555-0123' });
    const a = await w.service.start({ email: 'ana@shop.test', pin: '9999' });
    const right = await w.service.requestCode({ challenge: a.challenge, via: 'phone', phone: '+1 414 555 0123' });
    assert.deepEqual(w.texts, [{ phone: '+14145550123', code: w.texts[0].code }]);
    assert.equal(w.sent.length, 0, 'no email when a text was chosen');
    const done = await w.service.verifyCode({ challenge: right.challenge, code: w.texts[0].code });
    assert.equal(done.token, 'token-for-u1'); assert.equal(done.pinWasRight, false);

    // someone else's number: same answer, nothing sent, and no code works
    w.advance(2);
    const b = await w.service.start({ email: 'ana@shop.test', pin: '9999' });
    const other = await w.service.requestCode({ challenge: b.challenge, via: 'phone', phone: '262-555-0199' });
    assert.deepEqual(Object.keys(other).sort(), Object.keys(right).sort());
    assert.equal(other.message, right.message);
    assert.equal(w.texts.length, 1);
    await rejects(w.service.verifyCode({ challenge: other.challenge, code: '100002' }), 'wrong_code');
});

test('a person with no mobile number on record gets no text, whatever number is typed', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826');
    const a = await w.service.start({ email: 'ana@shop.test', pin: '9999' });
    const out = await w.service.requestCode({ challenge: a.challenge, via: 'phone', phone: '414-555-0123' });
    assert.equal(out.next, 'code'); assert.equal(w.texts.length, 0);
    // and they can still go back and choose email with the same choice
    const mail = await w.service.requestCode({ challenge: a.challenge, via: 'email' });
    assert.equal((await w.service.verifyCode({ challenge: mail.challenge, code: w.sent[0].code })).token, 'token-for-u1');
});

test('on the person\'s own device a wrong PIN only says try again; nothing is sent', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826');
    const device = await w.knownDevice('ana@shop.test', '4826');
    const sentBefore = w.sent.length;
    const typo = await w.service.start({ email: 'ana@shop.test', pin: '9999', deviceToken: device });
    assert.equal(typo.next, 'retry');
    assert.match(typo.message, /Try again/);
    assert.equal(w.sent.length, sentBefore, 'no code for a typo');
    assert.equal(w.people.get('u1').pinAttempts, 1, 'it still counts toward the lock');
    assert.equal((await w.service.start({ email: 'ana@shop.test', pin: '4826', deviceToken: device })).next, 'signed_in');
});

test('on a new device a wrong PIN goes to the code; the answer does not say the PIN was wrong until the code is accepted', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826');
    const wrong = await w.service.start({ email: 'ana@shop.test', pin: '9999' });
    const right = await (async () => { const x = world(); await x.add('u1', 'ana@shop.test', '4826'); return x.service.start({ email: 'ana@shop.test', pin: '4826' }); })();
    assert.deepEqual(Object.keys(wrong).sort(), Object.keys(right).sort());
    assert.equal(wrong.message, right.message);
    assert.equal(w.people.get('u1').pinAttempts, 1);
    const code = await w.service.requestCode({ challenge: wrong.challenge, via: 'email' });
    const done = await w.service.verifyCode({ challenge: code.challenge, code: w.sent.at(-1).code });
    assert.equal(done.pinWasRight, false); assert.equal(done.token, 'token-for-u1');
});

test('an email nobody has gets the same answers, no code is sent and no code works', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826');
    const known = await w.service.start({ email: 'ana@shop.test', pin: '0000' });
    const unknown = await w.service.start({ email: 'nobody@shop.test', pin: '0000' });
    assert.deepEqual(Object.keys(unknown).sort(), Object.keys(known).sort());
    assert.equal(unknown.message, known.message);
    const knownCode = await w.service.requestCode({ challenge: known.challenge, via: 'email' });
    const unknownCode = await w.service.requestCode({ challenge: unknown.challenge, via: 'email' });
    assert.deepEqual(Object.keys(unknownCode).sort(), Object.keys(knownCode).sort());
    assert.equal(unknownCode.message, knownCode.message);
    assert.equal(w.sent.length, 1);
    await rejects(w.service.verifyCode({ challenge: unknownCode.challenge, code: '100001' }), 'wrong_code');
    await rejects(w.service.start({ email: 'not-an-email', pin: '4826' }), 'bad_input');
});

test('someone who has left cannot sign in, with the right PIN or with a code', async () => {
    const w = world(); await w.add('u1', 'gone@shop.test', '4826', { active: false, phone: '4145550123' });
    const out = await w.byEmail({ email: 'gone@shop.test', pin: '4826' });
    assert.equal(out.next, 'code'); assert.equal(w.sent.length, 0);
    await rejects(w.service.verifyCode({ challenge: out.challenge, code: '100001' }), 'wrong_code');
});

test('five wrong PINs lock the PIN for 15 minutes; the code still works, and the PIN works again afterwards', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826');
    const device = await w.knownDevice('ana@shop.test', '4826');
    for (let i = 0; i < 5; i += 1) { w.advance(1); await w.service.start({ email: 'ana@shop.test', pin: '9999', deviceToken: device }); }
    assert.ok(w.people.get('u1').pinLockedUntil);
    w.advance(1);
    const locked = await w.byEmail({ email: 'ana@shop.test', pin: '4826', deviceToken: device });
    assert.equal(locked.next, 'code', 'the right PIN does not sign in while the PIN is locked');
    const viaCode = await w.service.verifyCode({ challenge: locked.challenge, code: w.sent.at(-1).code });
    assert.equal(viaCode.token, 'token-for-u1');
    w.advance(16);
    assert.equal((await w.service.start({ email: 'ana@shop.test', pin: '4826', deviceToken: device })).next, 'signed_in');
});

test('a code works once, and a wrong or made-up one never does', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', null);
    const out = await w.byEmail({ email: 'ana@shop.test', pin: '' });
    await rejects(w.service.verifyCode({ challenge: out.challenge, code: '000000' }), 'wrong_code');
    await rejects(w.service.verifyCode({ challenge: out.challenge, code: 'abc' }), 'wrong_code');
    await rejects(w.service.verifyCode({ challenge: 'made.up.token', code: w.sent[0].code }), 'expired');
    assert.equal((await w.service.verifyCode({ challenge: out.challenge, code: w.sent[0].code })).hasPin, false);
    await rejects(w.service.verifyCode({ challenge: out.challenge, code: w.sent[0].code }), 'wrong_code');
});

test('a PIN can be chosen only right after a code, and a weak one is refused', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', null);
    const out = await w.byEmail({ email: 'ana@shop.test', pin: '' });
    const done = await w.service.verifyCode({ challenge: out.challenge, code: w.sent[0].code });
    await rejects(w.service.setPin({ setupToken: done.setupToken, pin: '1234' }), 'weak_pin');
    await rejects(w.service.setPin({ setupToken: out.challenge, pin: '4826' }), 'expired'); // the wrong kind of token
    await rejects(w.service.setPin({ setupToken: 'made.up.token', pin: '4826' }), 'expired');
    assert.deepEqual(await w.service.setPin({ setupToken: done.setupToken, pin: '4826' }), { saved: true });
    assert.equal((await w.service.start({ email: 'ana@shop.test', pin: '4826', deviceToken: done.deviceToken })).next, 'signed_in');
});

test('two people who share a device keep one device token between them', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826'); await w.add('u2', 'ben@shop.test', '1357');
    const device = await w.knownDevice('ana@shop.test', '4826');
    const b = await w.byEmail({ email: 'ben@shop.test', pin: '1357', deviceToken: device });
    assert.equal(b.next, 'code', 'the device is known for Ana, not for Ben');
    const done = await w.service.verifyCode({ challenge: b.challenge, code: w.sent.at(-1).code, deviceToken: device });
    assert.equal(done.deviceToken, device);
    assert.equal((await w.service.start({ email: 'ana@shop.test', pin: '4826', deviceToken: device })).next, 'signed_in');
    assert.equal((await w.service.start({ email: 'ben@shop.test', pin: '1357', deviceToken: device })).next, 'signed_in');
    assert.equal((await w.service.start({ email: 'ben@shop.test', pin: '4826', deviceToken: device })).next, 'retry', "Ana's PIN does not open Ben's account");
});

test('the code is shown to the page only on a development server', async () => {
    const prod = world(); await prod.add('u1', 'ana@shop.test', null);
    assert.equal((await prod.byEmail({ email: 'ana@shop.test', pin: '' })).devCode, undefined);
    const dev = world({ showCode: true }); await dev.add('u1', 'ana@shop.test', null);
    const out = await dev.byEmail({ email: 'ana@shop.test', pin: '' });
    assert.equal(out.devCode, dev.sent[0].code);
});

test('a device grant from sign-up or a set-up link adds this device without pushing out the people already on it', async () => {
    const w = world(); await w.add('u1', 'ana@shop.test', '4826'); await w.add('u2', 'ben@shop.test', '1357');
    const shared = await w.knownDevice('ana@shop.test', '4826');
    const grant = pinSignin.deviceGrant('test-secret', 'u2', 'Ben@Shop.test');
    const out = await w.service.rememberDevice({ grant, deviceToken: shared });
    assert.equal(out.deviceToken, shared, 'the shared device keeps its one token');
    assert.equal((await w.service.start({ email: 'ana@shop.test', pin: '4826', deviceToken: shared })).next, 'signed_in');
    assert.equal((await w.service.start({ email: 'ben@shop.test', pin: '1357', deviceToken: shared })).next, 'signed_in');
    const fresh = await w.service.rememberDevice({ grant, deviceToken: '' });
    assert.match(fresh.deviceToken, /^[a-f0-9]{64}$/);
    await rejects(w.service.rememberDevice({ grant: 'made.up.token' }), 'expired');
    await rejects(w.service.rememberDevice({ grant: pinSignin.deviceGrant('other-secret', 'u2', 'ben@shop.test') }), 'expired');
    await rejects(w.service.rememberDevice({ grant: pinSignin.deviceGrant('test-secret', 'u1', 'ben@shop.test') }), 'expired'); // the grant names someone else
});

test('a code by WhatsApp goes only to the mobile number on record, and the server log says why when nothing is sent', async () => {
    const notes = []; const wa = [];
    const people = new Map([['u1', { uid: 'u1', email: 'ana@shop.test', phone: '414-555-0123', pinHash: null, pinAttempts: 0, signinDevices: [], active: true }],
        ['u2', { uid: 'u2', email: 'ben@shop.test', phone: '', pinHash: null, pinAttempts: 0, signinDevices: [], active: true }]]);
    let n = 0;
    const service = pinSignin.create({
        findPerson: async (email) => [...people.values()].find((p) => p.email === email) || null,
        savePerson: async () => {},
        otp: { generateOtp: () => { n += 1; return { otpId: `o${n}`, code: String(200000 + n) }; }, verifyOtp: () => ({ success: true }) },
        mintToken: async (uid) => `t-${uid}`, sendCode: async () => true, sendText: async () => true,
        sendWhatsApp: async (phone, code) => { wa.push({ phone, code }); return true; },
        note: (reason, d) => notes.push({ reason, via: d.via }),
        secret: 's', showCode: false
    });
    const ask = async (email, phone) => { const a = await service.start({ email, pin: '' }); return service.requestCode({ challenge: a.challenge, via: 'whatsapp', phone }); };

    const ok = await ask('ana@shop.test', '(414) 555-0123');
    assert.match(ok.message, /by WhatsApp/);
    assert.deepEqual(wa, [{ phone: '+14145550123', code: '200001' }]);

    await ask('ana@shop.test', '414-555-9999');
    assert.equal(wa.length, 1, 'another number gets nothing');
    assert.deepEqual(notes.at(-1), { reason: 'number_does_not_match_record', via: 'whatsapp' });

    await ask('ben@shop.test', '414-555-0123');
    assert.deepEqual(notes.at(-1), { reason: 'no_mobile_on_record', via: 'whatsapp' });

    await ask('nobody@shop.test', '414-555-0123');
    assert.deepEqual(notes.at(-1), { reason: 'no_such_person', via: 'whatsapp' });

    await assert.rejects(ask('ana@shop.test', ''), (e) => e.code === 'bad_input');
});

test('when the provider does not take the message, the log says so', async () => {
    const notes = [];
    const service = pinSignin.create({
        findPerson: async () => ({ uid: 'u1', email: 'ana@shop.test', phone: '4145550123', signinDevices: [], active: true }),
        savePerson: async () => {}, otp: { generateOtp: () => ({ otpId: 'o1', code: '123456' }), verifyOtp: () => ({ success: true }) },
        mintToken: async () => 't', sendCode: async () => true, sendText: async () => false,
        note: (reason, d) => notes.push({ reason, via: d.via }), secret: 's'
    });
    const a = await service.start({ email: 'ana@shop.test', pin: '' });
    await service.requestCode({ challenge: a.challenge, via: 'phone', phone: '4145550123' });
    assert.deepEqual(notes, [{ reason: 'provider_did_not_take_it', via: 'phone' }]);
});

test('sign in with a mobile number instead of an email, and a password instead of a PIN', async () => {
    const people = new Map([
        ['u1', { uid: 'u1', email: 'ana@shop.test', phone: '(414) 213-4642', pinHash: await bcrypt.hash('4826', 4), pinAttempts: 0, signinDevices: [], active: true }],
        ['u2', { uid: 'u2', email: 'ben@shop.test', phone: '', pinHash: null, pinAttempts: 0, signinDevices: [], active: true }]
    ]);
    const saved = [];
    const service = pinSignin.create({
        findPerson: async (email) => { const p = [...people.values()].find((x) => x.email === email); return p ? { ...p } : null; },
        findPersonByPhone: async (ten) => { const hits = [...people.values()].filter((x) => pinSignin.tenDigits(x.phone) === ten); return hits.length === 1 ? { ...hits[0] } : null; },
        checkPassword: async (email, pw) => email === 'ben@shop.test' && pw === 'correct horse battery',
        savePerson: async (uid, patch) => { saved.push({ uid, ...patch }); Object.assign(people.get(uid), patch); },
        otp: { generateOtp: () => ({ otpId: 'o1', code: '111111' }), verifyOtp: () => ({ success: true }) },
        mintToken: async (uid) => `t-${uid}`, sendCode: async () => true, sendText: async () => true, secret: 's'
    });

    // a right password signs in at once, on any device, by email or by mobile number
    assert.deepEqual(await service.start({ login: 'BEN@shop.test', pin: 'correct horse battery' }), { next: 'signed_in', token: 't-u2' });
    // a wrong password asks where to send a code, and counts like a wrong PIN
    const wrongPw = await service.start({ login: 'ben@shop.test', pin: 'wrong password' });
    assert.equal(wrongPw.next, 'choose');
    assert.equal(people.get('u2').pinAttempts, 1);

    // a mobile number finds the person; a right PIN on a new device still asks for a code once
    const byPhone = await service.start({ login: '414-213-4642', pin: '4826' });
    assert.equal(byPhone.next, 'choose');
    const code = await service.requestCode({ challenge: byPhone.challenge, via: 'email' });
    assert.match(code.message, /email on it/);
    const done = await service.verifyCode({ challenge: code.challenge, code: '111111' });
    assert.equal(done.token, 't-u1');
    // on that device the mobile number and PIN now sign in straight away
    assert.deepEqual(await service.start({ login: '+1 (414) 213 4642', pin: '4826', deviceToken: done.deviceToken }), { next: 'signed_in', token: 't-u1' });

    // a number nobody has, or junk, gets the same answer as an unknown email: nothing is revealed
    assert.equal((await service.start({ login: '414-555-0000', pin: '4826' })).next, 'choose');
    await assert.rejects(service.start({ login: 'not a login', pin: '4826' }), (e) => e.code === 'bad_input');
});

test('a code is sent at once, the person\'s way, and the answer never says which way', async () => {
    const people = new Map([
        ['u1', { uid: 'u1', email: 'ana@shop.test', phone: '(414) 213-4642', pinHash: null, pinAttempts: 0, signinDevices: [], active: true, codeVia: '' }],
        ['u2', { uid: 'u2', email: 'ben@shop.test', phone: '(414) 555-0142', pinHash: null, pinAttempts: 0, signinDevices: [], active: true, codeVia: 'whatsapp' }],
        ['u3', { uid: 'u3', email: 'cy@shop.test', phone: '', pinHash: null, pinAttempts: 0, signinDevices: [], active: true, codeVia: 'phone' }]
    ]);
    const out = []; let n = 0;
    const service = pinSignin.create({
        findPerson: async (email) => { const p = [...people.values()].find((x) => x.email === email); return p ? { ...p } : null; },
        findPersonByPhone: async (ten) => { const h = [...people.values()].filter((x) => pinSignin.tenDigits(x.phone) === ten); return h.length === 1 ? { ...h[0] } : null; },
        savePerson: async () => {}, otp: { generateOtp: () => { n += 1; return { otpId: `o${n}`, code: String(300000 + n) }; }, verifyOtp: () => ({ success: true }) },
        mintToken: async (uid) => `t-${uid}`,
        sendCode: async (to) => { out.push(['email', to]); return true; },
        sendText: async (to) => { out.push(['text', to]); return true; },
        sendWhatsApp: async (to) => { out.push(['whatsapp', to]); return true; },
        autoSend: true, ways: () => ({ text: true, whatsapp: true }), secret: 's'
    });
    const go = async (login, extra = {}) => { out.length = 0; const r = await service.start({ login, pin: '', ...extra }); return { r, sent: out.slice() }; };

    const a = await go('ana@shop.test');
    assert.equal(a.r.next, 'code'); assert.deepEqual(a.sent, [['email', 'ana@shop.test']], 'typed an email: email');
    assert.ok(a.r.choice, 'the other ways stay one tap away');
    assert.deepEqual((await go('414-213-4642')).sent, [['text', '+14142134642']], 'typed a mobile number: text');
    assert.deepEqual((await go('414-213-4642', { prefer: 'whatsapp' })).sent, [['whatsapp', '+14142134642']], 'used WhatsApp last on this device');
    assert.deepEqual((await go('ben@shop.test')).sent, [['whatsapp', '+14145550142']], 'chose WhatsApp in My details: even when signing in by email');
    assert.deepEqual((await go('cy@shop.test')).sent, [['email', 'cy@shop.test']], 'chose text but has no mobile on record: email');

    const nobody = await go('nobody@shop.test');
    assert.equal(nobody.r.next, 'code'); assert.deepEqual(nobody.sent, [], 'nobody: nothing is sent');
    assert.equal(nobody.r.message, a.r.message, 'the same words for everyone');
    assert.deepEqual(Object.keys(nobody.r).sort(), Object.keys(a.r).sort());
});
