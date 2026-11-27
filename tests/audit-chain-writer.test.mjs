import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const C = require('../services/audit-chain.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for the database: keeps a head and the stored entries per company, like appendAudit does in a transaction */
function fakeDb() {
    const orgs = new Map();
    const of = (orgId) => { if (!orgs.has(orgId)) orgs.set(orgId, { head: null, rows: [], running: 0, overlap: false, n: 0 }); return orgs.get(orgId); };
    return {
        of,
        async append(orgId, entry) {
            const o = of(orgId);
            o.running += 1; if (o.running > 1) o.overlap = true;
            const prev = o.head ? o.head.hash : C.GENESIS; const seq = o.head ? o.head.seq + 1 : 1;
            await sleep(Math.floor(Math.random() * 6)); // a slow transaction: a second writer must not sneak in
            const sealed = C.seal(entry, prev, seq);
            const id = `c${(o.n += 1)}`;
            o.rows.push(JSON.parse(JSON.stringify({ ...sealed, _id: id }))); // what the database would hand back
            o.head = { seq, hash: sealed.chain.hash };
            o.running -= 1;
            return id;
        },
        async addPlain(orgId, entry) { const o = of(orgId); const id = `p${(o.n += 1)}`; o.rows.push(JSON.parse(JSON.stringify({ ...entry, _id: id }))); return id; }
    };
}

test('every write joins the chain and the check passes, with awkward values in the entry', async () => {
    const db = fakeDb(); const logs = [];
    const deps = { append: db.append, addPlain: db.addPlain, log: (m) => logs.push(m) };
    const r1 = await C.writeAudit('org1', { action: 'a1', targetId: 't1', actorId: 'u1', ip: null, when: new Date('2026-11-12T10:00:00Z'), missing: undefined, nested: { b: 2, a: [1, undefined, { z: null }] }, ratio: 0.1 + 0.2, text: 'Zoë "quoted" \n line' }, deps);
    const r2 = await C.writeAudit('org1', { action: 'a2', targetId: null, fields: [] }, deps);
    assert.deepEqual([r1.chained, r2.chained], [true, true]);
    const o = db.of('org1');
    assert.equal(o.rows[0].when, '2026-11-12T10:00:00.000Z'); // dates are stored as text, so the hash still matches when read back
    assert.equal('missing' in o.rows[0], false);
    assert.equal(typeof o.rows[0].at, 'string');
    const report = C.verifyChain(o.rows, { head: o.head });
    assert.equal(report.valid, true); assert.equal(report.chained, 2); assert.equal(report.unchained, 0);
    assert.deepEqual(logs, []);
    // and tampering with a stored entry is caught
    o.rows[0].targetId = 'someone-else';
    assert.equal(C.verifyChain(o.rows, { head: o.head }).valid, false);
});

test('many writes at once for one company go one after another, in the order they were asked for', async () => {
    const db = fakeDb();
    const deps = { append: db.append, addPlain: db.addPlain, log: () => {} };
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => C.writeAudit(i % 4 === 0 ? 'orgB' : 'orgA', { action: 'burst', n: i }, deps)));
    assert.ok(results.every((r) => r.chained));
    for (const org of ['orgA', 'orgB']) {
        const o = db.of(org);
        assert.equal(o.overlap, false, 'two chain writes for one company ran at the same time');
        const report = C.verifyChain(o.rows, { head: o.head });
        assert.equal(report.valid, true); assert.deepEqual(report.gaps, []);
        const order = [...o.rows].sort((a, b) => a.chain.seq - b.chain.seq).map((r) => r.n);
        assert.deepEqual(order, [...order].sort((a, b) => a - b));
    }
    assert.equal(db.of('orgA').rows.length + db.of('orgB').rows.length, 40);
});

test('a chain failure never fails the write: the entry is kept without a chain and the problem is logged', async () => {
    const db = fakeDb(); const logs = []; let broken = true;
    const deps = { append: (o, e) => (broken ? Promise.reject(new Error('transaction aborted')) : db.append(o, e)), addPlain: db.addPlain, log: (m) => logs.push(m) };
    const r = await C.writeAudit('org2', { action: 'kept', targetId: 'x' }, deps);
    assert.equal(r.chained, false); assert.ok(r.id);
    assert.equal(db.of('org2').rows.length, 1); assert.equal(db.of('org2').rows[0].action, 'kept'); assert.equal(db.of('org2').rows[0].chain, undefined);
    assert.equal(logs.length, 1); assert.match(logs[0], /chain write failed.*transaction aborted/i);
    // a synchronous throw inside the chain writer is handled the same way
    const r2 = await C.writeAudit('org2', { action: 'kept2' }, { ...deps, append: () => { throw new Error('boom'); } });
    assert.equal(r2.chained, false); assert.equal(db.of('org2').rows.length, 2);
    // once the chain works again, later entries are chained and the check still passes around the unchained ones
    broken = false;
    assert.equal((await C.writeAudit('org2', { action: 'after' }, deps)).chained, true);
    const report = C.verifyChain(db.of('org2').rows, { head: db.of('org2').head });
    assert.equal(report.valid, true); assert.equal(report.chained, 1); assert.equal(report.unchained, 2);
});

test('a chain write that hangs is given up on, the entry is still kept, and the next write is not stuck behind it', async () => {
    const db = fakeDb(); const logs = [];
    const started = Date.now();
    const slow = C.writeAudit('org3', { action: 'slow' }, { append: () => new Promise(() => {}), addPlain: db.addPlain, log: (m) => logs.push(m), timeoutMs: 40 });
    const next = C.writeAudit('org3', { action: 'next' }, { append: db.append, addPlain: db.addPlain, log: (m) => logs.push(m) });
    const [a, b] = await Promise.all([slow, next]);
    assert.equal(a.chained, false); assert.equal(b.chained, true);
    assert.ok(Date.now() - started < 2000);
    assert.match(logs[0], /took longer than 40 ms/);
    assert.deepEqual(db.of('org3').rows.map((r) => r.action), ['slow', 'next']);
});

test('when nothing can be written the caller still gets an answer, never an exception', async () => {
    const logs = [];
    const r = await C.writeAudit('org4', { action: 'lost' }, { append: () => Promise.reject(new Error('db down')), addPlain: () => Promise.reject(new Error('db down too')), log: (m) => logs.push(m) });
    assert.deepEqual(r, { id: null, chained: false, error: 'db down too' });
    assert.equal(logs.length, 2); assert.match(logs[1], /Audit write failed: db down too/);
    // an entry that cannot be turned into plain data (it points at itself) falls back as well
    const loop = { action: 'loop' }; loop.self = loop;
    const kept = [];
    const r2 = await C.writeAudit('org4', loop, { append: () => { throw new Error('should not be called'); }, addPlain: async (o, e) => { kept.push(e); return 'p1'; }, log: (m) => logs.push(m) });
    assert.equal(r2.chained, false); assert.equal(kept.length, 1);
});

test('without an integrity key in production the entries are written without a chain (logged once)', async () => {
    const saved = { env: process.env.NODE_ENV, key: process.env.AUDIT_CHAIN_KEY };
    process.env.NODE_ENV = 'production'; delete process.env.AUDIT_CHAIN_KEY;
    try {
        const db = fakeDb(); const logs = []; let appended = 0;
        const deps = { append: (o, e) => { appended += 1; return db.append(o, e); }, addPlain: db.addPlain, log: (m) => logs.push(m) };
        const a = await C.writeAudit('org5', { action: 'one' }, deps);
        const b = await C.writeAudit('org5', { action: 'two' }, deps);
        assert.deepEqual([a.chained, b.chained, appended], [false, false, 0]);
        assert.equal(db.of('org5').rows.length, 2);
        assert.ok(logs.length <= 1); // said once, not on every write
    } finally {
        if (saved.env === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.env;
        if (saved.key !== undefined) process.env.AUDIT_CHAIN_KEY = saved.key;
    }
});

test('checking only the newest part of a very long log', () => {
    const key = 'k'.repeat(32);
    const all = []; let prev = C.GENESIS;
    for (let i = 1; i <= 8; i += 1) { const e = C.seal({ at: `2026-01-0${i}T00:00:00Z`, action: `a${i}` }, prev, i, key); prev = e.chain.hash; all.push({ ...e, _id: `d${i}` }); }
    const head = { seq: 8, hash: all[7].chain.hash };
    const newest = all.slice(3);
    assert.equal(C.verifyChain(newest, { key, head }).valid, false); // without the flag the missing start looks like a gap
    const r = C.verifyChain(newest, { key, head, partial: true });
    assert.equal(r.valid, true); assert.equal(r.partialFromSeq, 4); assert.equal(r.checkedThroughSeq, 8);
    const edited = newest.map((e) => ({ ...e })); edited[2] = { ...edited[2], action: 'changed' };
    assert.equal(C.verifyChain(edited, { key, head, partial: true }).valid, false);
    assert.equal(C.verifyChain(newest.filter((e) => e.chain.seq !== 6), { key, head, partial: true }).valid, false);
    assert.equal(C.verifyChain(newest.slice(0, 3), { key, head, partial: true }).headMismatch, true); // newest entries removed
    assert.equal(C.verifyChain(all, { key, head, partial: true }).partialFromSeq, undefined); // the whole log: nothing special
});

test('the audit() helper used by the US routes never throws and never rejects', async () => {
    const { audit } = require('../routes/us-hr.js').helpers;
    const req = { user: { id: 'u1', role: 'hr_admin' }, ip: '127.0.0.1' };
    const p = audit('org_unit_test_only', req, 'unit_test_action', undefined, { note: 'x' });
    assert.equal(typeof p.then, 'function');
    await assert.doesNotReject(p);
    assert.doesNotThrow(() => audit('org_unit_test_only', { user: {} }, 'unit_test_action', 't'));
});
