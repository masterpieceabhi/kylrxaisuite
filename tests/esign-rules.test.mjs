import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../services/esign-rules.js');

// a tiny valid-looking PNG (signature + padding); validateSignature checks the magic bytes and size
const pngData = () => 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200, 1)]).toString('base64');
const BIG = 400 * 1024;

test('rendering escapes HTML in values and in the template', () => {
    const r = E.renderTemplate('Hi {{first_name}} <script>alert(1)</script>', { first_name: '<b>Eve</b>' });
    assert.ok(!r.html.includes('<script>')); assert.ok(r.html.includes('&lt;b&gt;Eve&lt;/b&gt;')); assert.deepEqual(r.unknown, []); assert.deepEqual(r.missing, []);
});

test('unknown and missing fields are flagged', () => {
    const r = E.renderTemplate('{{first_name}} {{nope}} {{job_title}}', { first_name: 'A' });
    assert.deepEqual(r.unknown, ['nope']); assert.deepEqual(r.missing, ['job_title']); assert.ok(r.html.includes('<mark>'));
});

test('line breaks become <br> and fields tolerate spaces', () => {
    const r = E.renderTemplate('{{ first_name }}\nBye', { first_name: 'Z' });
    assert.ok(r.html.includes('Z<br>')); assert.equal(r.text, 'Z\nBye');
});

test('template validation and warnings', () => {
    assert.deepEqual(E.validateTemplate({ name: 'N', type: 'nda', body: 'x'.repeat(30) }).errors, []);
    assert.equal(E.validateTemplate({ name: '', type: 'zzz', body: 'short' }).errors.length, 3);
    assert.equal(E.validateTemplate({ name: 'N', type: 'nda', body: 'Hello {{bogus}} world and more text' }).warnings.length, 1);
});

test('every starter template uses only known merge fields', () => {
    for (const t of E.DEFAULT_TEMPLATES) {
        assert.deepEqual(E.validateTemplate(t).errors, [], t.name);
        assert.deepEqual(E.extractFields(t.body).filter((f) => !E.MERGE_FIELDS.includes(f)), [], t.name);
    }
});

test('tokens are random, shaped, and only the hash is derivable', () => {
    const a = E.generateToken(); const b = E.generateToken();
    assert.notEqual(a.token, b.token); assert.ok(E.isTokenShape(a.token)); assert.equal(a.hash, E.sha256(a.token)); assert.notEqual(a.hash, a.token);
    assert.equal(E.isTokenShape('sg_short'), false); assert.equal(E.isTokenShape(a.token + 'x'), false); assert.equal(E.isTokenShape(undefined), false);
});

test('expiry is clamped and computed', () => {
    assert.equal(E.clampExpiryDays(500), 90); assert.equal(E.clampExpiryDays(0), 1); assert.equal(E.clampExpiryDays('x'), 14);
    assert.equal(E.expiresAtFor('2026-01-01T00:00:00.000Z', 2), '2026-01-03T00:00:00.000Z');
    assert.equal(E.clampAttempts(99), 10); assert.equal(E.clampAttempts(undefined), 5);
});

test('canSign handles every state', () => {
    const now = '2026-01-10T00:00:00Z';
    const open = { status: 'pending', expiresAt: '2026-01-20T00:00:00Z', attempts: 0, maxAttempts: 3 };
    assert.equal(E.canSign(open, now).ok, true);
    assert.equal(E.canSign({ ...open, expiresAt: '2026-01-09T00:00:00Z' }, now).code, 'expired');
    assert.equal(E.canSign({ ...open, status: 'signed' }, now).code, 'signed');
    assert.equal(E.canSign({ ...open, status: 'declined' }, now).code, 'declined');
    assert.equal(E.canSign({ ...open, status: 'voided' }, now).code, 'voided');
    assert.equal(E.canSign({ ...open, attempts: 3 }, now).code, 'locked');
    assert.equal(E.effectiveStatus({ ...open, status: 'signed', expiresAt: '2020-01-01T00:00:00Z' }, now), 'signed');
});

test('signature needs consent, a matching typed name and a real PNG', () => {
    const ok = E.validateSignature({ consent: true, typedName: ' Jane  Doe ', signatureData: pngData() }, 'jane doe');
    assert.deepEqual(ok.errors, []); assert.equal(ok.value.typedName, 'Jane Doe');
    assert.ok(E.validateSignature({ consent: false, typedName: 'Jane Doe', signatureData: pngData() }, 'Jane Doe').errors.some((e) => /agree/.test(e)));
    assert.ok(E.validateSignature({ consent: true, typedName: 'Someone Else', signatureData: pngData() }, 'Jane Doe').errors.some((e) => /match/.test(e)));
    assert.ok(E.validateSignature({ consent: true, typedName: 'Jane Doe', signatureData: 'data:image/png;base64,AAAA' }, 'Jane Doe').errors.length);
    assert.ok(E.validateSignature({ consent: true, typedName: 'Jane Doe', signatureData: 'data:text/html;base64,AAAA' }, 'Jane Doe').errors.length);
    assert.ok(E.validateSignature({ consent: true, typedName: 'Jane Doe', signatureData: 'data:image/png;base64,' + Buffer.alloc(BIG).toString('base64') }, 'Jane Doe').errors.length);
});

test('reminders list stale and soon-to-expire requests only', () => {
    const now = '2026-01-10T00:00:00Z';
    const reqs = [
        { id: 'a', status: 'pending', sentAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-30T00:00:00Z', reminders: [] },
        { id: 'b', status: 'pending', sentAt: '2026-01-09T00:00:00Z', expiresAt: '2026-01-30T00:00:00Z', reminders: [] },
        { id: 'c', status: 'pending', sentAt: '2026-01-09T00:00:00Z', expiresAt: '2026-01-11T00:00:00Z', reminders: [] },
        { id: 'd', status: 'signed', sentAt: '2026-01-01T00:00:00Z', expiresAt: '2026-01-30T00:00:00Z' }
    ];
    assert.deepEqual(E.remindersDue(reqs, now).map((r) => r.id).sort(), ['a', 'c']);
});

test('certificate contains the hash, audit trail and escapes names', () => {
    const html = E.buildCertificate({ templateName: 'NDA', signerName: '<i>X</i>', signedAt: 't', documentHash: 'abc123', requestId: 'r1', consentText: 'c', typedName: 'X', signatureData: pngData(), renderedHtml: '<p>doc</p>', history: [{ at: '1', event: 'signed', ip: '1.2.3.4' }] });
    assert.ok(html.includes('abc123')); assert.ok(html.includes('&lt;i&gt;X&lt;/i&gt;')); assert.ok(html.includes('1.2.3.4')); assert.ok(html.includes('<p>doc</p>'));
});
