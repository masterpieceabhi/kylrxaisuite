// NetSuite client assertion (RS256 / PS256 / ES256) and the SFTP driver (host key pinning, read and write).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.NODE_ENV = 'test';
const NS = require('../services/connectors/adapters/netsuite.js');
const F = require('../services/connectors/file-drivers.js');

const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = (k) => k.privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = (k) => k.publicKey;
const claims = { clientId: 'client-1', certificateId: 'cert-1', audience: 'https://1234567.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token' };

function verify(token, publicKey, alg) {
    const [h, b, s] = token.split('.');
    const data = Buffer.from(`${h}.${b}`);
    const sig = Buffer.from(s, 'base64url');
    let ok;
    if (alg === 'RS256') ok = crypto.verify('sha256', data, publicKey, sig);
    if (alg === 'PS256') ok = crypto.verify('sha256', data, { key: publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
    if (alg === 'ES256') ok = crypto.verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, sig);
    return { ok, header: JSON.parse(Buffer.from(h, 'base64url').toString()), payload: JSON.parse(Buffer.from(b, 'base64url').toString()) };
}

test('NetSuite: an RSA key signs RS256 by default and the signature verifies', () => {
    const t = NS.clientAssertion({ ...claims, privateKey: pem(rsa), now: 1000 });
    const r = verify(t, pub(rsa), 'RS256');
    assert.ok(r.ok);
    assert.equal(r.header.alg, 'RS256');
    assert.equal(r.header.kid, 'cert-1');
    assert.deepEqual(r.payload, { iss: 'client-1', scope: ['rest_webservices'], aud: claims.audience, iat: 1000, exp: 4000 });
});

test('NetSuite: an EC key signs ES256 by default (raw r||s signature, as JWT needs)', () => {
    const t = NS.clientAssertion({ ...claims, privateKey: pem(ec), now: 1000 });
    const r = verify(t, pub(ec), 'ES256');
    assert.ok(r.ok);
    assert.equal(r.header.alg, 'ES256');
    assert.equal(Buffer.from(t.split('.')[2], 'base64url').length, 64);
});

test('NetSuite: PS256 is used on request with an RSA key and verifies with PSS padding', () => {
    const t = NS.clientAssertion({ ...claims, privateKey: pem(rsa), algorithm: 'ps256', now: 1000 });
    const r = verify(t, pub(rsa), 'PS256');
    assert.ok(r.ok);
    assert.equal(r.header.alg, 'PS256');
});

test('NetSuite: a requested algorithm that does not fit the key is refused before anything is sent', () => {
    assert.throws(() => NS.clientAssertion({ ...claims, privateKey: pem(ec), algorithm: 'RS256' }), /RS256 cannot be used with a ec key/);
    assert.throws(() => NS.clientAssertion({ ...claims, privateKey: pem(rsa), algorithm: 'ES256' }), /ES256 cannot be used with a rsa key/);
    assert.throws(() => NS.clientAssertion({ ...claims, privateKey: pem(rsa), algorithm: 'HS256' }), /must be auto, RS256, PS256 or ES256/);
});

test('NetSuite: the algorithm is read from the adapter config (jwtAlgorithm) and defaults to auto', () => {
    const fields = NS.configFields.map((f) => f.key);
    assert.ok(fields.includes('jwtAlgorithm'));
    assert.match(NS.needsVerification.join(' '), /certificate type/);
});

test('fingerprints: OpenSSH SHA256 form and hex form both normalise to the same value; junk is rejected', () => {
    const digest = crypto.createHash('sha256').update('host-key').digest();
    const hex = digest.toString('hex');
    const openssh = 'SHA256:' + digest.toString('base64').replace(/=+$/, '');
    assert.equal(F.normaliseFingerprint(openssh), hex);
    assert.equal(F.normaliseFingerprint(hex.toUpperCase().match(/../g).join(':')), hex);
    assert.equal(F.normaliseFingerprint(''), null);
    assert.equal(F.normaliseFingerprint('abc'), null);
});

// A stand-in for ssh2-sftp-client that records what the driver asks for.
function fakeLib({ fileText = 'hello', listing = [{ name: 'b.csv' }, { name: 'a.csv' }] } = {}) {
    const calls = { connect: null, put: [], get: [], ended: 0 };
    class Client {
        async connect(opts) { calls.connect = opts; }
        async put(buf, remote) { calls.put.push({ text: buf.toString('utf8'), remote }); }
        async get(remote) { calls.get.push(remote); return Buffer.from(fileText); }
        async list() { return listing; }
        async end() { calls.ended += 1; }
    }
    return { calls, load: () => Client };
}

const goodDigestHex = crypto.createHash('sha256').update('host-key').digest('hex');

test('SFTP: refuses to connect when no host key fingerprint is set', async () => {
    const lib = fakeLib();
    const d = new F.SftpDriver({ host: 'files.example.com', username: 'u', password: 'p' }, null, lib.load);
    await assert.rejects(() => d.put('a.csv', 'x'), /server fingerprint is not set/);
    assert.equal(lib.calls.connect, null, 'nothing was connected');
});

test('SFTP: connects with sha256 host verification and accepts only the pinned key', async () => {
    const lib = fakeLib();
    const d = new F.SftpDriver({ host: 'files.example.com', username: 'u', password: 'p', remoteDir: '/in/', hostFingerprint: goodDigestHex }, null, lib.load);
    const out = await d.put('people.csv', 'a,b');
    assert.deepEqual(out, { path: '/in/people.csv', bytes: 3 });
    assert.equal(lib.calls.connect.hostHash, 'sha256');
    assert.equal(lib.calls.connect.host, 'files.example.com');
    assert.equal(lib.calls.connect.readyTimeout, 15000);
    assert.equal(lib.calls.connect.hostVerifier(goodDigestHex), true, 'the pinned key is accepted');
    assert.equal(lib.calls.connect.hostVerifier('00'.repeat(32)), false, 'any other key is refused');
    assert.equal(lib.calls.ended, 1, 'a connection the driver opened is closed afterwards');
});

test('SFTP: a wrong key is refused by the verifier, and a failed upload still closes the connection', async () => {
    const lib = fakeLib();
    const d = new F.SftpDriver({ host: 'h', username: 'u', password: 'p', hostFingerprint: goodDigestHex }, null, lib.load);
    await d.put('ok.csv', 'x');
    class Failing { async connect(o) { lib.calls.connect = o; } async put() { throw new Error('disk full'); } async end() { lib.calls.ended += 1; } }
    const d2 = new F.SftpDriver({ host: 'h', username: 'u', password: 'p', hostFingerprint: goodDigestHex }, null, () => Failing);
    await assert.rejects(() => d2.put('bad.csv', 'x'), /disk full/);
    assert.equal(lib.calls.ended, 2);
});

test('SFTP: reads a file back and lists the folder', async () => {
    const lib = fakeLib({ fileText: 'x,y\r\n1,2' });
    const d = new F.SftpDriver({ host: 'h', username: 'u', password: 'p', remoteDir: '/out', hostFingerprint: goodDigestHex }, null, lib.load);
    assert.equal(await d.get('report.csv'), 'x,y\r\n1,2');
    assert.deepEqual(lib.calls.get, ['/out/report.csv']);
    assert.deepEqual(await d.list(), ['a.csv', 'b.csv']);
    await assert.rejects(() => d.get('../secret'), /unsafe file name/);
});

test('SFTP: without the library installed, the message says what to do', async () => {
    const d = new F.SftpDriver({ host: 'h', hostFingerprint: goodDigestHex }, null, () => { throw new Error('no module'); });
    await assert.rejects(() => d.put('a.csv', 'x'), /SFTP driver is not installed/);
});
