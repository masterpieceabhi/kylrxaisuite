import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const W = require('../services/webhooks.js');
const E = require('../services/events.js');

test('signature: header format, verification, tamper and replay protection', () => {
    const body = JSON.stringify({ id: 'evt_1', type: 'person.created' });
    const now = 1_800_000_000;
    const header = W.signatureHeader('whsec_abc', body, now);
    assert.match(header, /^t=1800000000,v1=[0-9a-f]{64}$/);
    assert.equal(W.verifySignature(header, body, 'whsec_abc', { nowSec: now + 10 }), true);
    assert.equal(W.verifySignature(header, body + ' ', 'whsec_abc', { nowSec: now }), false);
    assert.equal(W.verifySignature(header, body, 'whsec_other', { nowSec: now }), false);
    assert.equal(W.verifySignature(header, body, 'whsec_abc', { nowSec: now + 600 }), false); // older than 5 minutes
    assert.equal(W.verifySignature('garbage', body, 'whsec_abc'), false);
});

test('signature during secret rotation carries both secrets', () => {
    const h = W.signatureHeader(['new', 'old'], 'x', 1_800_000_000);
    assert.equal((h.match(/v1=/g) || []).length, 2);
    assert.equal(W.verifySignature(h, 'x', 'old', { nowSec: 1_800_000_000 }), true);
    assert.equal(W.verifySignature(h, 'x', 'new', { nowSec: 1_800_000_000 }), true);
});

test('backoff: 10 attempts spread over about three days, then give up', () => {
    delete process.env.WEBHOOK_BACKOFF_SCALE;
    let total = 0;
    for (let a = 1; a < W.MAX_ATTEMPTS; a++) total += W.nextDelayMs(a);
    assert.equal(W.MAX_ATTEMPTS, 10);
    assert.equal(W.nextDelayMs(W.MAX_ATTEMPTS), null);
    assert.ok(total > 2.9 * 86400e3 && total < 3.5 * 86400e3, `total ${total / 86400e3} days`);
    for (let a = 2; a < W.MAX_ATTEMPTS; a++) assert.ok(W.nextDelayMs(a) >= W.nextDelayMs(a - 1));
    process.env.WEBHOOK_BACKOFF_SCALE = '0.001';
    assert.equal(W.nextDelayMs(1), 30);
    delete process.env.WEBHOOK_BACKOFF_SCALE;
});

test('event filters', () => {
    assert.equal(E.matchesEvent(['*'], 'person.created'), true);
    assert.equal(E.matchesEvent([], 'person.created'), true);
    assert.equal(E.matchesEvent(['person.*'], 'person.created'), true);
    assert.equal(E.matchesEvent(['person.*'], 'leave.approved'), false);
    assert.equal(E.matchesEvent(['leave.approved', 'leave.denied'], 'leave.denied'), true);
    assert.equal(E.matchesEvent(['leave.approved'], 'leave.requested'), false);
    assert.equal(W.validateEventFilters(['person.*', 'leave.approved']).value.length, 2);
    assert.ok(W.validateEventFilters(['bad filter!']).error);
});

test('events: envelope shape, sensitive keys stripped', () => {
    const e = E.buildEvent('org1', 'person.updated', { person_id: 'u1', ssn: '123-45-6789', nested: { bank_account: '1', ok: 1 } });
    assert.match(e.id, /^evt_[0-9a-f]{24}$/);
    assert.equal(e.api_version, 'v1');
    assert.deepEqual(e.data, { person_id: 'u1', nested: { ok: 1 } });
});

test('emit never throws, whatever it is given', () => {
    assert.equal(E.emit(null, 'person.created', {}), null);
    assert.equal(E.emit('org1', 'NotAnEvent', {}), null);
    assert.equal(E.emit('org1', 'person.created', undefined) === null || typeof E.emit('org1', 'person.created', undefined) === 'string', true);
    const circular = {}; circular.self = circular;
    assert.doesNotThrow(() => E.emit('org1', 'person.created', circular));
    assert.doesNotThrow(() => E.emit({}, 5, 7));
});

test('every catalog event type is a valid type', () => {
    for (const t of Object.keys(E.CATALOG)) assert.match(t, E.EVENT_TYPE);
});
