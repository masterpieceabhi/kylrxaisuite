import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const B = require('../services/background-check-rules.js');
const P = require('../services/background-provider.js');

const NOW = '2026-03-02T10:00:00.000Z';
const merge = (c, r) => { assert.ok(!r.error, r.error); return { ...c, ...r.patch }; };
const fresh = () => B.newCheck('org', 'cand', NOW, 'hr');

function ordered() {
    let c = fresh();
    c = merge(c, B.recordDisclosure(c, { standalone: true }, NOW, 'hr'));
    c = merge(c, B.recordAuthorization(c, { authorized: true, method: 'paper' }, NOW, 'hr'));
    c = merge(c, B.recordOrder(c, { provider: 'mock', reference: 'MOCK-1' }, NOW, 'hr'));
    return c;
}
const considered = () => { const c = ordered(); return merge(c, B.recordResult(c, { status: 'consider' }, NOW)); };
const ATT = { reportCopyProvided: true, summaryOfRightsProvided: true };

test('cannot order before disclosure and authorization', () => {
    const c = fresh();
    assert.equal(B.canOrder(c).ok, false);
    assert.ok(B.recordOrder(c, { provider: 'mock', reference: 'x' }, NOW).error);
    assert.ok(B.recordAuthorization(c, { authorized: true, method: 'paper' }, NOW).error, 'authorization needs disclosure first');
    const d = merge(c, B.recordDisclosure(c, { standalone: true }, NOW));
    assert.ok(B.recordDisclosure(fresh(), { standalone: false }, NOW).error);
    assert.ok(B.recordAuthorization(d, { authorized: false, method: 'paper' }, NOW).error);
    assert.ok(B.recordAuthorization(d, { authorized: true, method: 'fax' }, NOW).error);
    assert.equal(B.statusOf(d), 'needs_authorization');
});

test('status moves through the happy path', () => {
    let c = ordered();
    assert.equal(B.statusOf(c), 'in_progress');
    assert.ok(B.recordOrder(c, { provider: 'mock', reference: 'again' }, NOW).error, 'no double order');
    c = merge(c, B.recordResult(c, { status: 'clear', reportReference: 'MOCK-1' }, NOW));
    assert.equal(B.statusOf(c), 'clear');
    assert.ok(B.preAdverse(c, ATT, '2026-03-02', null, 'hr', NOW).error, 'no adverse action on a clear result');
});

test('consider result: pre-adverse, waiting period, then final notice', () => {
    let c = considered();
    assert.equal(B.statusOf(c), 'consider_review');
    assert.ok(B.preAdverse(c, { reportCopyProvided: true }, '2026-03-02', null, 'hr', NOW).error, 'needs both attachments');
    assert.equal(B.canSendAdverse(c, '2026-03-30').ok, false, 'no final notice without the pre-adverse notice');
    c = merge(c, B.preAdverse(c, ATT, '2026-03-02', null, 'hr', NOW)); // Monday
    assert.equal(c.adverse.waitingUntil, '2026-03-09'); // 5 business days
    assert.equal(B.statusOf(c), 'waiting_period');
    assert.equal(B.canSendAdverse(c, '2026-03-06').ok, false);
    assert.ok(B.sendAdverse(c, '2026-03-06', 'hr', NOW).error);
    assert.equal(B.canSendAdverse(c, '2026-03-09').ok, true);
    c = merge(c, B.sendAdverse(c, '2026-03-09', 'hr', NOW));
    assert.equal(B.statusOf(c), 'adverse_action_final');
    assert.ok(B.sendAdverse(c, '2026-03-20', 'hr', NOW).error, 'only once');
});

test('the waiting period is editable', () => {
    const p = B.preAdverse(considered(), ATT, '2026-03-02', { waitingBusinessDays: 10 }, 'hr', NOW);
    assert.equal(p.patch.adverse.waitingUntil, '2026-03-16');
    assert.deepEqual(B.validateSettings({ waitingBusinessDays: 7 }).errors, []);
    assert.ok(B.validateSettings({ waitingBusinessDays: 0 }).errors.length); assert.ok(B.validateSettings({ waitingBusinessDays: 'x' }).errors.length);
});

test('a dispute pauses the process; a corrected result clears the adverse action', () => {
    let c = considered();
    assert.ok(B.openDispute(c, { note: 'x' }, NOW).error);
    c = merge(c, B.preAdverse(c, ATT, '2026-03-02', null, 'hr', NOW));
    c = merge(c, B.openDispute(c, { note: 'Record is not mine' }, NOW));
    assert.equal(B.statusOf(c), 'disputed');
    assert.equal(B.canSendAdverse(c, '2026-04-30').ok, false);
    assert.ok(B.openDispute(c, { note: 'again please' }, NOW).error);
    assert.ok(B.resolveDispute(c, { resolution: 'maybe' }, NOW).error);
    const fixed = merge(c, B.resolveDispute(c, { resolution: 'corrected_clear' }, NOW));
    assert.equal(B.statusOf(fixed), 'clear'); assert.equal(fixed.adverse, null);
    const upheld = merge(c, B.resolveDispute(c, { resolution: 'upheld' }, NOW));
    assert.equal(B.canSendAdverse(upheld, '2026-04-30').ok, true);
});

test('every step is timestamped in the history and no report content is kept', () => {
    const c0 = ordered();
    const c = merge(c0, B.recordResult(c0, { status: 'consider', reportReference: 'REF1', ssn: '123', raw: 'secret' }, NOW));
    assert.ok(c.history.every((h) => h.at && h.event));
    assert.deepEqual(Object.keys(c.result).sort(), ['receivedAt', 'reportReference', 'status']);
    assert.ok(!JSON.stringify(B.summarize(c, '2026-03-02')).includes('secret'));
});

test('mock provider: no vendor calls, "consider" surname triggers a consider result', async () => {
    const p = P.getProvider('mock');
    const o = await p.order({ candidate: { id: 'c1' } });
    assert.match(o.reference, /^MOCK-/);
    assert.equal((await p.fetchResult(o.reference, { lastName: 'Smith' })).result, 'clear');
    assert.equal((await p.fetchResult(o.reference, { lastName: 'Considerson' })).result, 'consider');
    assert.throws(() => P.getProvider('checkr'), /not configured/);
});
