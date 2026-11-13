import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../services/policy-rules.js');

const BODY = 'Be on time for every shift. Tell your manager two hours ahead if you cannot come in.';
const draft = (over = {}) => ({ title: 'Attendance', category: 'Attendance and time off', body: BODY, effectiveDate: null, requireAck: true, changeNote: '', ...over });
const publish = (policy, opts = {}) => { const v = P.nextVersion(policy, { at: `t${(policy.versions || []).length + 1}`, by: 'HR', ...opts }); return { ...policy, status: 'published', versions: P.addVersion(policy, v) }; };

test('a policy needs a title, a known category and real text', () => {
    assert.equal(P.validatePolicy({}).errors.length, 3);
    assert.equal(P.validatePolicy({ title: 'Attendance', category: 'Gossip', body: BODY }).errors.length, 1);
    assert.equal(P.validatePolicy({ title: 'Attendance', category: 'Safety', body: 'Too short' }).errors.length, 1);
    assert.match(P.validatePolicy({ title: 'Attendance', category: 'Safety', body: 'x'.repeat(P.BODY_MAX + 1) }).errors[0], /too long/);
    assert.equal(P.validatePolicy({ title: 'Attendance', category: 'Safety', body: BODY, effectiveDate: '2026-02-30' }).errors.length, 1);
    const ok = P.validatePolicy({ title: '  Attendance  <b>rules</b> ', category: 'Safety', body: `Line one of the policy.  \r\n\r\n  Line <i>two</i> stays on its own line.`, requireAck: 1, changeNote: ' First  version ' });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.title, 'Attendance brules/b');
    assert.equal(ok.value.body, 'Line one of the policy.\n\n  Line itwo/i stays on its own line.');
    assert.equal(ok.value.requireAck, true);
    assert.equal(ok.value.changeNote, 'First version');
    assert.deepEqual(P.validatePolicy({}, { partial: true }).errors, ['Nothing to change']);
    assert.deepEqual(P.validatePolicy({ effectiveDate: '' }, { partial: true }).value, { effectiveDate: null });
});

test('publishing makes numbered versions and keeps the old ones', () => {
    let p = { id: 'p1', status: 'draft', draft: draft(), versions: [] };
    assert.equal(P.currentVersion(p), null);
    assert.equal(P.changeError(p, 'publish'), null);
    p = publish(p);
    assert.equal(P.currentVersion(p).version, 1);
    assert.equal(P.currentVersion(p).ackFrom, 1);
    assert.equal(P.hasUnpublishedChanges(p), false);
    assert.match(P.changeError(p, 'publish'), /Nothing has changed/);
    p = { ...p, draft: draft({ body: `${BODY} Three late arrivals in a month lead to a talk with your manager.`, changeNote: 'Added the late rule' }) };
    assert.equal(P.hasUnpublishedChanges(p), true);
    p = publish(p);
    assert.deepEqual(p.versions.map((v) => v.version), [1, 2]);
    assert.equal(p.versions[0].body, BODY);
    assert.equal(P.currentVersion(p).changeNote, 'Added the late rule');
    assert.equal(P.currentVersion(p).ackFrom, 2);
});

test('a draft with too little text cannot be published; the first version cannot be a small fix', () => {
    assert.match(P.changeError({ status: 'draft', draft: { body: 'short' }, versions: [] }, 'publish'), /Write the policy text first/);
    assert.match(P.changeError({ status: 'draft', draft: draft(), versions: [] }, 'publish', { minor: true }), /first version cannot be a small fix/);
    const noAck = publish({ status: 'draft', draft: draft({ requireAck: false }), versions: [] });
    assert.match(P.changeError({ ...noAck, draft: draft({ requireAck: true }) }, 'publish', { minor: true }), /cannot be a small fix/);
});

test('a new version asks everyone again; a small fix keeps earlier acknowledgements', () => {
    let p = publish({ id: 'p1', status: 'draft', draft: draft(), versions: [] });
    assert.deepEqual(P.ackState(p, []), { needed: true, done: false, version: null });
    assert.deepEqual(P.ackState(p, [1]), { needed: false, done: true, version: 1 });
    // version 2 is a small fix: version 1 acknowledgements still count
    p = publish({ ...p, draft: draft({ body: `${BODY} (Typo fixed.)` }) }, { minor: true });
    assert.equal(P.currentVersion(p).ackFrom, 1);
    assert.equal(P.ackState(p, [1]).done, true);
    // version 3 is a real change: everyone is asked again
    p = publish({ ...p, draft: draft({ body: `${BODY} New rule about phones on the floor.` }) });
    assert.equal(P.currentVersion(p).ackFrom, 3);
    assert.deepEqual(P.ackState(p, [1, 2]), { needed: true, done: false, version: null });
    assert.equal(P.ackState(p, [1, 3]).version, 3);
    // version 4, another small fix, still counts version 3 but not 1 or 2
    p = publish({ ...p, draft: draft({ body: `${BODY} New rule about phones on the sales floor.` }) }, { minor: true });
    assert.equal(P.ackState(p, [3]).done, true);
    assert.equal(P.ackState(p, [2]).needed, true);
});

test('no acknowledgement is asked for a draft, an archived policy, or one that does not ask', () => {
    const quiet = publish({ status: 'draft', draft: draft({ requireAck: false }), versions: [] });
    assert.deepEqual(P.ackState(quiet, []), { needed: false, done: false, version: null });
    assert.match(P.changeError(quiet, 'acknowledge'), /does not ask/);
    const p = publish({ status: 'draft', draft: draft(), versions: [] });
    assert.equal(P.changeError(p, 'acknowledge'), null);
    assert.equal(P.ackState({ ...p, status: 'archived' }, []).needed, false);
    assert.match(P.changeError({ ...p, status: 'archived' }, 'acknowledge'), /not published/);
    assert.match(P.changeError({ status: 'draft', draft: draft(), versions: [] }, 'acknowledge'), /not published/);
});

test('archive, restore and delete follow the state of the policy', () => {
    const never = { status: 'draft', draft: draft(), versions: [] };
    const live = publish(never);
    assert.equal(P.changeError(never, 'delete'), null);
    assert.match(P.changeError(live, 'delete'), /cannot be deleted/);
    assert.match(P.changeError(never, 'archive'), /deleted instead/);
    assert.equal(P.changeError(live, 'archive'), null);
    assert.match(P.changeError(live, 'restore'), /Only an archived/);
    assert.equal(P.changeError({ ...live, status: 'archived' }, 'restore'), null);
    assert.match(P.changeError({ ...live, status: 'archived' }, 'edit'), /Bring this policy back/);
    assert.match(P.changeError({ ...live, status: 'archived' }, 'publish'), /Bring this policy back/);
    assert.match(P.changeError(live, 'shred'), /Unknown action/);
});

test('the report lists who is still waiting first and ignores acknowledgements that no longer count', () => {
    let p = publish({ status: 'draft', draft: draft(), versions: [] });
    p = publish({ ...p, draft: draft({ body: `${BODY} A real change to the rules.` }) });
    const people = [{ id: 'u1', name: 'Ana', employeeId: 'E1' }, { id: 'u2', name: 'Ben' }, { id: 'u3', name: 'Cy' }];
    const acks = [{ userId: 'u1', version: 1, at: 'a' }, { userId: 'u1', version: 2, at: 'b' }, { userId: 'u2', version: 1, at: 'c' }, { userId: 'gone', version: 2, at: 'd' }];
    const r = P.ackReport(p, people, acks);
    assert.deepEqual([r.asked, r.total, r.done, r.waiting], [true, 3, 1, 2]);
    assert.deepEqual(r.rows.map((x) => x.name), ['Ben', 'Cy', 'Ana']);
    assert.deepEqual(r.rows[2], { userId: 'u1', name: 'Ana', employeeId: 'E1', done: true, version: 2, at: 'b' });
    assert.equal(P.ackReport(publish({ status: 'draft', draft: draft({ requireAck: false }), versions: [] }), people, []).asked, false);
});

test('an employee reads only the published version, never the draft', () => {
    assert.equal(P.employeeView({ id: 'p1', status: 'draft', draft: draft(), versions: [] }), null);
    let p = publish({ id: 'p1', status: 'draft', draft: draft({ changeNote: 'First' }), versions: [] });
    p = { ...p, draft: draft({ body: 'SECRET DRAFT TEXT that nobody should see yet.' }) };
    const v = P.employeeView(p);
    assert.equal(v.body, BODY);
    assert.equal(v.version, 1);
    assert.equal(v.changeNote, '');
    assert.equal(v.draft, undefined);
    assert.ok(!JSON.stringify(v).includes('SECRET'));
    assert.equal(P.employeeView(p, { withBody: false }).body, undefined);
    assert.equal(P.employeeView({ ...p, status: 'archived' }), null);
});
