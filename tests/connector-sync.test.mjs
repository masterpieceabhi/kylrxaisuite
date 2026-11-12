// US-K06: sync engine (change tracking, retries, dead letters, cursors, conflicts, reconciliation) and the
// runtime around it (connections, encrypted credentials, stored runs, error retry, company separation).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kylrx-sync-'));
process.env.CONNECTOR_EXPORT_DIR = exportDir;
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const E = require('../services/connectors/sync-engine.js');
const { defineAdapter } = require('../services/connectors/adapters/_base.js');
const runtime = require('../services/connectors/runtime.js');

test.after(() => { fs.rmSync(exportDir, { recursive: true, force: true }); });

const noSleep = async () => {};
const people = () => [
    { id: 'p1', name: 'Ada', email: 'ada@example.com', updated_at: '2026-01-01T00:00:00.000Z' },
    { id: 'p2', name: 'Bob', email: 'bob@example.com', updated_at: '2026-01-02T00:00:00.000Z' },
    { id: 'p3', name: 'Cy', email: 'cy@example.com', updated_at: '2026-01-03T00:00:00.000Z' }
];
const sourcesOf = (rows) => ({ people: async (conn, { since, ids } = {}) => rows.filter((r) => (!since || r.updated_at >= since) && (!ids || ids.includes(r.id))) });

/** A small connector whose remote system is a Map; `fail(payload, attempt)` can make a push throw */
function remoteAdapter({ fail, batch = false } = {}) {
    const remote = new Map(); const calls = [];
    const def = {
        key: 'test', name: 'Test', category: 'test',
        entities: [{ key: 'contact', direction: 'push', source: 'people' }],
        defaultMappings: { contact: [{ target: 'Name', source: 'name', required: true }, { target: 'Email', source: 'email', transform: 'lower' }] },
        push: async (entity, payload, ctx, { remoteId }) => {
            calls.push({ payload, remoteId });
            const n = calls.filter((c) => c.payload.Email === payload.Email).length;
            if (fail) { const e = fail(payload, n); if (e) throw e; }
            const id = remoteId || `r${remote.size + 1}`;
            remote.set(id, payload);
            return { remoteId: id };
        }
    };
    if (batch) { delete def.push; def.pushBatch = async (entity, items) => { calls.push({ items }); if (fail) { const e = fail(items, calls.length); if (e) throw e; } return { file: `batch_${calls.length}.csv`, rows: items.length }; }; }
    return { adapter: defineAdapter(def), remote, calls };
}
const run = (adapter, rows, store, conn = {}, opts = {}) => E.runSync({ adapter, conn: { id: 'c1', cursors: {}, ...conn }, ctx: { conn: { id: 'c1', ...conn } }, store, sources: sourcesOf(rows), opts: { sleep: noSleep, ...opts } });

test('first run creates every record; a second run with no changes sends nothing', async () => {
    const { adapter, remote, calls } = remoteAdapter(); const store = E.memoryStore(); const rows = people();
    const first = await run(adapter, rows, store);
    assert.equal(first.status, 'success');
    assert.deepEqual(first.stats.contact, { fetched: 3, created: 3, updated: 0, skipped: 0, failed: 0, conflicts: 0 });
    assert.equal(first.cursors.contact, '2026-01-03T00:00:00.000Z');
    assert.equal(remote.size, 3);
    const second = await run(adapter, rows, store, { cursors: first.cursors });
    assert.deepEqual(second.stats.contact, { fetched: 1, created: 0, updated: 0, skipped: 1, failed: 0, conflicts: 0 }, 'only the record at the cursor is looked at, and it is unchanged');
    assert.equal(calls.length, 3, 'nothing was sent again');
});

test('a changed record is sent as an update to the same remote record', async () => {
    const { adapter, remote, calls } = remoteAdapter(); const store = E.memoryStore(); const rows = people();
    const first = await run(adapter, rows, store);
    rows[1] = { ...rows[1], name: 'Robert', updated_at: '2026-02-01T00:00:00.000Z' };
    const second = await run(adapter, rows, store, { cursors: first.cursors });
    assert.equal(second.stats.contact.updated, 1); assert.equal(second.stats.contact.created, 0);
    assert.equal(calls[calls.length - 1].remoteId, 'r2');
    assert.equal(remote.get('r2').Name, 'Robert');
    assert.equal(remote.size, 3, 'no duplicate was created');
    assert.equal(second.cursors.contact, '2026-02-01T00:00:00.000Z');
});

test('an entity switched off for the connection is not synced', async () => {
    const { adapter, calls } = remoteAdapter();
    const out = await run(adapter, people(), E.memoryStore(), { entities: { contact: false } });
    assert.deepEqual(out.stats, {}); assert.equal(calls.length, 0); assert.equal(out.status, 'success');
});

test('retryable errors are retried with backoff and then succeed; the attempt count is kept', async () => {
    const waits = [];
    const { adapter, calls } = remoteAdapter({ fail: (p, n) => (p.Email === 'bob@example.com' && n < 3 ? Object.assign(new Error('HTTP 503'), { retryable: true }) : null) });
    const out = await run(adapter, people(), E.memoryStore(), {}, { sleep: async (ms) => { waits.push(ms); } });
    assert.equal(out.status, 'success');
    assert.equal(calls.filter((c) => c.payload.Email === 'bob@example.com').length, 3);
    assert.deepEqual(waits, [500, 1000]);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((a) => E.retryDelayMs(a)), [500, 1000, 2000, 4000, 8000, 8000]);
});

test('withRetries: gives up after the limit, never retries a non-retryable error', async () => {
    let n = 0;
    const gaveUp = await E.withRetries(async () => { n += 1; throw Object.assign(new Error('still down'), { retryable: true }); }, { maxAttempts: 4, sleep: noSleep }).catch((e) => e);
    assert.equal(n, 4); assert.equal(gaveUp.attempts, 4); assert.equal(gaveUp.message, 'still down');
    n = 0;
    const once = await E.withRetries(async () => { n += 1; throw new Error('bad request'); }, { maxAttempts: 4, sleep: noSleep }).catch((e) => e);
    assert.equal(n, 1); assert.equal(once.attempts, 1);
    assert.deepEqual(await E.withRetries(async (attempt) => `ok on ${attempt}`, { sleep: noSleep }), { value: 'ok on 1', attempts: 1 });
});

test('a record that keeps failing goes to the error list; the others still sync; a later good run clears it', async () => {
    let broken = true;
    const { adapter } = remoteAdapter({ fail: (p) => (broken && p.Email === 'bob@example.com' ? Object.assign(new Error('HTTP 500 token=abc123secret'), { retryable: true }) : null) });
    const store = E.memoryStore(); const rows = people();
    const first = await run(adapter, rows, store);
    assert.equal(first.status, 'partial');
    assert.deepEqual({ created: first.stats.contact.created, failed: first.stats.contact.failed }, { created: 2, failed: 1 });
    assert.equal(first.errors.length, 1); assert.equal(first.errors[0].entity, 'contact');
    assert.doesNotMatch(first.errors[0].message, /abc123secret/, 'secrets are removed from error text');
    const open = await store.listDeadLetters('c1', { status: 'open' });
    assert.equal(open.length, 1); assert.equal(open[0].recordId, 'p2'); assert.equal(open[0].kind, 'push'); assert.equal(open[0].attempts, 3);
    assert.doesNotMatch(open[0].error, /abc123secret/);
    assert.equal((await store.getState('c1', 'contact', 'p2')).status, 'error');
    assert.equal(first.cursors.contact, '2026-01-01T00:00:00.000Z', 'the cursor stops before the failed record so it is tried again');
    broken = false;
    const second = await run(adapter, rows, store, { cursors: first.cursors });
    assert.equal(second.status, 'success'); assert.equal(second.stats.contact.created, 1); assert.equal(second.stats.contact.skipped, 2);
    assert.equal((await store.listDeadLetters('c1', { status: 'open' })).length, 0, 'the error is resolved once the record syncs');
    assert.equal(second.cursors.contact, '2026-01-03T00:00:00.000Z');
});

test('a record that cannot be mapped is an error that is not sent and not retried', async () => {
    const { adapter, calls } = remoteAdapter(); const store = E.memoryStore();
    const rows = [...people(), { id: 'p4', email: 'noname@example.com', updated_at: '2026-01-04T00:00:00.000Z' }];
    const out = await run(adapter, rows, store);
    assert.equal(out.status, 'partial'); assert.equal(out.stats.contact.failed, 1); assert.equal(calls.length, 3);
    const dl = await store.listDeadLetters('c1', { status: 'open' });
    assert.equal(dl[0].kind, 'validation'); assert.equal(dl[0].attempts, 0); assert.match(dl[0].error, /Name: required value is missing/);
});

test('when sign-in to the other system fails, the run fails without touching any record', async () => {
    const adapter = defineAdapter({ key: 't', name: 'T', entities: [{ key: 'contact', direction: 'push', source: 'people' }], defaultMappings: { contact: [] }, authenticate: async () => { throw new Error('invalid_client secret=hunter2'); }, push: async () => { throw new Error('must not be called'); } });
    const out = await run(adapter, people(), E.memoryStore());
    assert.equal(out.status, 'failed'); assert.deepEqual(out.stats, {}); assert.equal(out.errors[0].entity, 'auth');
    assert.doesNotMatch(out.errors[0].message, /hunter2/);
    assert.ok(out.finishedAt);
});

test('nothing went through at all -> failed; a source that throws is counted, not thrown', async () => {
    const { adapter } = remoteAdapter({ fail: () => new Error('HTTP 400') });
    assert.equal((await run(adapter, people(), E.memoryStore())).status, 'failed');
    const good = remoteAdapter().adapter;
    const out = await E.runSync({ adapter: good, conn: { id: 'c1', cursors: {} }, ctx: { conn: {} }, store: E.memoryStore(), sources: { people: async () => { throw new Error('database is down'); } }, opts: { sleep: noSleep } });
    assert.equal(out.status, 'failed'); assert.match(out.errors[0].message, /entity run failed: database is down/);
});

test('batch connector: one file per run; a failed batch puts every record on the error list', async () => {
    const ok = remoteAdapter({ batch: true }); const store = E.memoryStore(); const rows = people();
    const first = await run(ok.adapter, rows, store);
    assert.equal(first.status, 'success'); assert.equal(first.stats.contact.created, 3);
    assert.equal(ok.calls.length, 1); assert.equal(ok.calls[0].items.length, 3);
    assert.equal((await store.getState('c1', 'contact', 'p1')).remoteId, 'batch_1.csv');
    await run(ok.adapter, rows, store, { cursors: first.cursors });
    assert.equal(ok.calls.length, 1, 'an unchanged second run writes no file');

    const bad = remoteAdapter({ batch: true, fail: () => new Error('disk full') }); const store2 = E.memoryStore();
    const out = await run(bad.adapter, rows, store2);
    assert.equal(out.status, 'failed'); assert.equal(out.stats.contact.failed, 3);
    assert.equal((await store2.listDeadLetters('c1', { status: 'open' })).length, 3);
    assert.equal(out.cursors.contact, undefined, 'the cursor does not move when the batch failed');
});

test('batch connector: the cursor never moves past a record that failed, so the record is picked up again', async () => {
    const { adapter, calls } = remoteAdapter({ batch: true }); const store = E.memoryStore();
    const rows = people(); delete rows[1].name; // p2 cannot be mapped (Name is required); p1 is older, p3 is newer
    const first = await run(adapter, rows, store);
    assert.equal(first.status, 'partial'); assert.equal(first.stats.contact.failed, 1); assert.equal(first.stats.contact.created, 2);
    assert.equal(first.cursors.contact, '2026-01-01T00:00:00.000Z', 'stops at the last record before the failure');
    rows[1].name = 'Bob'; // fixed at the source without a new updated_at
    const second = await run(adapter, rows, store, { cursors: first.cursors });
    assert.equal(second.stats.contact.fetched, 3);
    assert.equal(second.stats.contact.created, 1, 'the record that failed is sent on the next run');
    assert.deepEqual(calls[1].items.map((i) => i.id), ['p2']);
    assert.equal(second.cursors.contact, '2026-01-03T00:00:00.000Z');
});

test('retrying one record does not move the cursor', async () => {
    const { adapter } = remoteAdapter(); const store = E.memoryStore();
    const out = await run(adapter, people(), store, { cursors: { contact: '2025-12-31T00:00:00.000Z' } }, { onlyRecordIds: ['p3'] });
    assert.equal(out.stats.contact.fetched, 1); assert.equal(out.stats.contact.created, 1);
    assert.equal(out.cursors.contact, '2025-12-31T00:00:00.000Z');
});

test('conflicts: who wins per field (ours, theirs, newest) and blanks are always filled', () => {
    const local = { title: 'Engineer', phone: '', department: 'R&D', email: 'a@x.com' };
    const remote = { title: 'Senior Engineer', phone: '555-0100', department: 'Research', email: 'a@x.com' };
    const ours = E.resolveConflicts({ local, remote, policy: { default: 'ours' } });
    assert.deepEqual(ours.patch, { phone: '555-0100' });
    assert.deepEqual(ours.skipped.map((s) => s.field), ['title', 'department']);
    assert.deepEqual(E.resolveConflicts({ local, remote, policy: { default: 'theirs' } }).patch, { title: 'Senior Engineer', phone: '555-0100', department: 'Research' });
    const mixed = E.resolveConflicts({ local, remote, policy: { default: 'ours', fields: { title: 'theirs' } } });
    assert.deepEqual(mixed.patch, { title: 'Senior Engineer', phone: '555-0100' });
    const newerRemote = E.resolveConflicts({ local, remote, policy: { default: 'newest' }, localUpdatedAt: '2026-01-01', remoteUpdatedAt: '2026-02-01' });
    assert.equal(newerRemote.patch.title, 'Senior Engineer');
    const newerLocal = E.resolveConflicts({ local, remote, policy: { default: 'newest' }, localUpdatedAt: '2026-03-01', remoteUpdatedAt: '2026-02-01' });
    assert.deepEqual(newerLocal.patch, { phone: '555-0100' }); assert.equal(newerLocal.skipped[0].reason, 'local value is newer');
    assert.deepEqual(E.resolveConflicts({ local: null, remote: { a: 1, b: '' } }).patch, { a: 1 }, 'a new record takes every non-empty value');
    assert.deepEqual(E.resolveConflicts({ local, remote: { ...local } }), { patch: {}, skipped: [] });
});

test('pull: remote records are created or updated locally through the conflict rules; a bad record does not stop the rest', async () => {
    const localDb = new Map([['L1', { id: 'L1', updated_at: '2026-01-01', fields: { email: 'ada@example.com', title: 'Engineer', phone: '' } }]]);
    const adapter = defineAdapter({
        key: 'dir', name: 'Directory', entities: [{ key: 'user', direction: 'pull' }], defaultMappings: {},
        pull: async (entity, ctx, { cursor }) => ({ cursor: 'page-2', records: cursor ? [] : [
            { id: 'R1', email: 'ada@example.com', title: 'Staff Engineer', phone: '555-0100', updated_at: '2026-02-01' },
            { id: 'R2', email: 'new@example.com', title: 'Analyst', updated_at: '2026-02-01' },
            { id: 'R3', email: '', updated_at: '2026-02-01' }
        ] }),
        mapInbound: (entity, r) => (r.email ? { value: { email: r.email, title: r.title, phone: r.phone }, errors: [] } : { value: {}, errors: ['email is missing'] })
    });
    const applied = [];
    const inbound = {
        find: async (entity, mapped) => [...localDb.values()].find((l) => l.fields.email === mapped.email) || null,
        apply: async (entity, localId, patch, meta) => { applied.push({ localId, patch, meta }); }
    };
    const store = E.memoryStore();
    const out = await E.runSync({ adapter, conn: { id: 'c1', cursors: {}, conflictPolicy: { default: 'ours', fields: { title: 'theirs' } } }, ctx: { conn: {} }, store, inbound, opts: { sleep: noSleep } });
    assert.equal(out.status, 'partial');
    assert.deepEqual(out.stats.user, { fetched: 3, created: 1, updated: 1, skipped: 0, failed: 1, conflicts: 0 });
    assert.deepEqual(applied[0], { localId: 'L1', patch: { title: 'Staff Engineer', phone: '555-0100' }, meta: { remoteId: 'R1', source: 'dir' } });
    assert.equal(applied[1].localId, null); assert.equal(applied[1].patch.email, 'new@example.com');
    assert.equal(out.cursors.user, 'page-2');
    assert.equal((await store.listDeadLetters('c1', { status: 'open' }))[0].kind, 'inbound');
    const noHandler = await E.runSync({ adapter, conn: { id: 'c1', cursors: {} }, ctx: { conn: {} }, store: E.memoryStore(), opts: { sleep: noSleep } });
    assert.equal(noHandler.status, 'failed'); assert.match(noHandler.errors[0].message, /no inbound handler/);
});

test('reconciliation: in sync, never sent, changed since, failed, and removed locally', async () => {
    let broken = true;
    const { adapter } = remoteAdapter({ fail: (p) => (broken && p.Email === 'cy@example.com' ? new Error('HTTP 400 rejected') : null) });
    const store = E.memoryStore(); const rows = people();
    await run(adapter, rows, store);
    rows[0] = { ...rows[0], name: 'Ada L.' };                                                  // changed after the sync
    rows.push({ id: 'p4', name: 'Dee', email: 'dee@example.com', updated_at: '2026-01-04' });   // never sent
    const withoutBob = rows.filter((r) => r.id !== 'p2');                                       // p2 is gone locally
    const report = await E.reconcile({ adapter, conn: { id: 'c1' }, ctx: { conn: {} }, store, sources: sourcesOf(withoutBob) });
    const r = report.entities.contact;
    assert.deepEqual({ local_total: r.local_total, in_sync: r.in_sync, pending: r.pending, changed: r.changed, errored: r.errored, orphaned: r.orphaned, dead_letters_open: r.dead_letters_open },
        { local_total: 3, in_sync: 0, pending: 1, changed: 1, errored: 1, orphaned: 1, dead_letters_open: 1 });
    assert.deepEqual(r.samples.pending, ['p4']); assert.deepEqual(r.samples.changed, ['p1']); assert.deepEqual(r.samples.orphaned, ['p2']);
    assert.equal(r.samples.errored[0].id, 'p3');
    broken = false;
    await run(adapter, withoutBob, store);
    const after = (await E.reconcile({ adapter, conn: { id: 'c1' }, ctx: { conn: {} }, store, sources: sourcesOf(withoutBob) })).entities.contact;
    assert.deepEqual({ in_sync: after.in_sync, pending: after.pending, changed: after.changed, errored: after.errored }, { in_sync: 3, pending: 0, changed: 0, errored: 0 });
});

test('redact removes bearer tokens and secrets and keeps messages short', () => {
    assert.equal(E.redact('failed with Bearer abc.def-123 at step 2'), 'failed with Bearer *** at step 2');
    assert.equal(E.redact('password=hunter2 rejected'), 'password=*** rejected');
    assert.equal(E.redact('{"client_secret":"s3cr3t","x":1}'), '{"client_secret":"***","x":1}');
    assert.equal(E.redact('x'.repeat(900)).length, 400);
});

/* ------------------------------ runtime (stored in the database) ------------------------------ */

const seedPeople = async (orgId, n) => {
    for (let i = 1; i <= n; i++) await db.collection('users').doc(`${orgId}_u${i}`).set({ orgId, employeeId: `EMP000${i}`, name: `Person ${i}`, email: `p${i}@${orgId}.example.com`, status: 'Active', jobTitle: 'Clerk', joiningDate: '2026-01-05', updatedAt: `2026-01-0${i}T00:00:00.000Z`, createdAt: '2026-01-01T00:00:00.000Z' });
};
const fileConn = (extra = {}) => ({ connector: 'file-export', name: 'Nightly files', config: { driver: 'local', folder: 'nightly' }, entities: { time_csv: false, journal_csv: false }, ...extra });

test('runtime: create validates input, stores credentials encrypted and shows only the last 4 characters', async () => {
    mem.reset();
    assert.deepEqual(await runtime.createConnection('orgA', { connector: 'nope' }), { errors: ['unknown connector'] });
    const bad = await runtime.createConnection('orgA', fileConn({ schedule: { enabled: true, intervalMinutes: 0 }, conflictPolicy: { default: 'sometimes' }, mapping: { people_csv: [{ source: 'x' }] } }));
    assert.equal(bad.errors.length, 3);
    const r = await runtime.createConnection('orgA', fileConn({ credentials: { sftpPassword: 'correct-horse-battery' }, schedule: { enabled: true, intervalMinutes: 30 } }), 'admin1');
    assert.equal(r.connection.status, 'active'); assert.equal(r.connection.credentials.sftpPassword, '••••tery'); assert.equal(r.connection.credentials.sftpPrivateKey, null);
    assert.ok(r.connection.next_run_at);
    const stored = (await db.collection('connector_connections').doc(r.id).get()).data();
    assert.doesNotMatch(JSON.stringify(stored), /correct-horse-battery/, 'the secret is not stored in the clear');
    assert.doesNotMatch(JSON.stringify(r.connection), /correct-horse-battery/);
    assert.doesNotMatch(JSON.stringify(await runtime.listConnections('orgA')), /correct-horse-battery/);
    const logs = await runtime.listLogs('orgA', r.id);
    assert.doesNotMatch(JSON.stringify(logs), /correct-horse-battery/);
    const ctx = runtime.buildCtx('orgA', await runtime.loadRaw('orgA', r.id));
    assert.equal(ctx.conn.credentials.sftpPassword, 'correct-horse-battery', 'the adapter still gets the real value');
});

test('runtime: update merges config, keeps other credentials, validates and can pause', async () => {
    mem.reset();
    const { id } = await runtime.createConnection('orgA', fileConn({ credentials: { sftpPassword: 'first-password-1111' } }));
    assert.deepEqual(await runtime.updateConnection('orgA', 'missing', {}), { notFound: true });
    assert.deepEqual((await runtime.updateConnection('orgA', id, { status: 'deleted' })).errors, ['status must be active or paused']);
    const u = await runtime.updateConnection('orgA', id, { name: 'Renamed', status: 'paused', config: { 'sftp.host': 'files.example.com', 'accounts.wages_expense': '6000' }, credentials: { sftpPrivateKey: 'KEYDATA-2222' }, mapping: { people_csv: [{ target: 'email', disabled: true }] } });
    assert.equal(u.connection.name, 'Renamed'); assert.equal(u.connection.status, 'paused');
    assert.deepEqual(u.connection.config, { driver: 'local', folder: 'nightly', sftp: { host: 'files.example.com' }, accounts: { wages_expense: '6000' } });
    assert.deepEqual(u.connection.credentials, { sftpPassword: '••••1111', sftpPrivateKey: '••••2222' });
    const polluted = await runtime.updateConnection('orgA', id, { config: { '__proto__.polluted': 'yes', 'constructor.prototype.polluted': 'yes', 'prototype.polluted': 'yes' } });
    assert.equal(polluted.errors, undefined); assert.equal({}.polluted, undefined, 'config keys cannot reach the object prototype');
    assert.ok((await runtime.updateConnection('orgA', id, { mapping: { people_csv: [{ target: '__proto__.polluted', source: 'id' }] } })).errors[0].includes('not allowed'));
});

test('runtime: a sync run writes the file, stores the run, moves the cursor, and the next run is quiet', async () => {
    mem.reset(); await seedPeople('orgA', 3); await seedPeople('orgB', 2);
    const { id } = await runtime.createConnection('orgA', fileConn());
    const first = await runtime.runConnection('orgA', id, { trigger: 'manual' });
    assert.equal(first.run.status, 'success'); assert.equal(first.run.stats.people_csv.created, 3);
    assert.equal(first.failureStreak, 0);
    const files = fs.readdirSync(path.join(exportDir, 'orgA', 'nightly'));
    assert.equal(files.length, 1); assert.match(files[0], /^people_\d{14}\.csv$/);
    const csv = fs.readFileSync(path.join(exportDir, 'orgA', 'nightly', files[0]), 'utf8');
    assert.equal(csv.trim().split('\r\n').length, 4);
    assert.match(csv, /p1@orgA\.example\.com/); assert.doesNotMatch(csv, /orgB/, 'another company\'s people are never exported');
    const conn = (await runtime.listConnections('orgA'))[0];
    assert.equal(conn.last_status, 'success'); assert.ok(conn.last_run_at); assert.equal(conn.failed_runs_in_a_row, 0);
    const runs = await runtime.listRuns('orgA', id);
    assert.equal(runs.length, 1); assert.equal(runs[0].trigger, 'manual'); assert.equal(runs[0].status, 'success');
    const second = await runtime.runConnection('orgA', id, { trigger: 'manual' });
    assert.equal(second.run.stats.people_csv.created, 0); assert.equal(second.run.stats.people_csv.skipped, 1);
    assert.equal(fs.readdirSync(path.join(exportDir, 'orgA', 'nightly')).length, 1, 'no second file when nothing changed');
    const rec = await runtime.reconcileConnection('orgA', id);
    assert.equal(rec.report.entities.people_csv.in_sync, 3); assert.equal(rec.report.entities.people_csv.pending, 0);
});

test('runtime: a failed run marks the connection, counts the streak, and one good run clears both', async () => {
    mem.reset(); await seedPeople('orgA', 2);
    const { id } = await runtime.createConnection('orgA', fileConn({ config: { driver: 'sftp', 'sftp.host': 'files.example.com' } }));
    const f1 = await runtime.runConnection('orgA', id);
    assert.equal(f1.run.status, 'failed'); assert.equal(f1.failureStreak, 1);
    assert.match(f1.run.errors[0].message, /batch export failed: SFTP driver is not installed/);
    let c = (await runtime.listConnections('orgA'))[0];
    assert.equal(c.status, 'error'); assert.equal(c.last_status, 'failed'); assert.equal(c.failed_runs_in_a_row, 1);
    const open = await runtime.listDeadLetters('orgA', id, 'open');
    assert.equal(open.length, 2);
    assert.equal((await runtime.runConnection('orgA', id)).failureStreak, 2);
    await runtime.updateConnection('orgA', id, { config: { driver: 'local' } });
    const ok = await runtime.runConnection('orgA', id);
    assert.equal(ok.run.status, 'success'); assert.equal(ok.failureStreak, 0);
    c = (await runtime.listConnections('orgA'))[0];
    assert.equal(c.status, 'active'); assert.equal(c.failed_runs_in_a_row, 0);
    assert.equal((await runtime.listDeadLetters('orgA', id, 'open')).length, 0, 'errors are resolved when the records go through');
    assert.equal((await runtime.listRuns('orgA', id)).length, 3);
});

test('runtime: retrying one error re-sends only that record and leaves the streak alone', async () => {
    mem.reset(); await seedPeople('orgA', 2);
    const { id } = await runtime.createConnection('orgA', fileConn({ config: { driver: 'sftp' } }));
    await runtime.runConnection('orgA', id);
    const [dl] = await runtime.listDeadLetters('orgA', id, 'open');
    const still = await runtime.retryDeadLetter('orgA', id, dl.id);
    assert.equal(still.ok, false); assert.equal(still.run.status, 'failed');
    assert.equal((await runtime.listConnections('orgA'))[0].failed_runs_in_a_row, 1, 'a retry of one record is not counted as a failed run');
    await runtime.updateConnection('orgA', id, { config: { driver: 'local' } });
    const [again] = (await runtime.listDeadLetters('orgA', id, 'open')).filter((d) => d.recordId === dl.recordId);
    const fixed = await runtime.retryDeadLetter('orgA', id, again.id);
    assert.equal(fixed.ok, true); assert.equal(fixed.run.stats.people_csv.fetched, 1);
    assert.deepEqual((await runtime.listDeadLetters('orgA', id, 'open')).map((d) => d.recordId), [dl.recordId === 'orgA_u1' ? 'orgA_u2' : 'orgA_u1'], 'the other record is still waiting');
    assert.deepEqual(await runtime.retryDeadLetter('orgA', id, 'missing'), { notFound: true });
});

test('runtime: one company can never read, run, change or delete another company\'s connection', async () => {
    mem.reset(); await seedPeople('orgA', 1); await seedPeople('orgB', 1);
    const { id } = await runtime.createConnection('orgA', fileConn());
    await runtime.createConnection('orgA', fileConn({ config: { driver: 'sftp', folder: 'x' } })).then((r) => runtime.runConnection('orgA', r.id));
    await runtime.runConnection('orgA', id);
    assert.equal(await runtime.loadRaw('orgB', id), null);
    assert.deepEqual(await runtime.listConnections('orgB'), []);
    assert.deepEqual(await runtime.runConnection('orgB', id), { notFound: true });
    assert.deepEqual(await runtime.updateConnection('orgB', id, { name: 'mine now' }), { notFound: true });
    assert.deepEqual(await runtime.healthCheck('orgB', id), { notFound: true });
    assert.deepEqual(await runtime.reconcileConnection('orgB', id), { notFound: true });
    assert.deepEqual(await runtime.listRuns('orgB', id), []);
    assert.deepEqual(await runtime.listLogs('orgB', id), []);
    assert.deepEqual(await runtime.listDeadLetters('orgB', id), []);
    const failing = (await runtime.listConnections('orgA')).find((c) => c.id !== id);
    const [dl] = await runtime.listDeadLetters('orgA', failing.id, 'open');
    assert.deepEqual(await runtime.retryDeadLetter('orgB', failing.id, dl.id), { notFound: true });
    assert.deepEqual(await runtime.retryDeadLetter('orgA', id, dl.id), { notFound: true }, 'an error record belongs to one connection');
    assert.equal(await runtime.deleteConnection('orgB', id), false);
    assert.equal((await runtime.listConnections('orgA')).length, 2);
    assert.equal(await runtime.deleteConnection('orgA', failing.id), true);
    assert.equal((await db.collection('connector_dead_letters').get()).size, 0, 'deleting a connection removes its error records');
});

test('runtime: health check stores the result; the scheduler runs what is due, including after a failure, but not when paused', async () => {
    mem.reset(); await seedPeople('orgA', 1);
    const { id } = await runtime.createConnection('orgA', fileConn({ schedule: { enabled: true, intervalMinutes: 15 } }));
    const h = await runtime.healthCheck('orgA', id);
    assert.equal(h.health.ok, true); assert.equal(h.health.detail, 'local folder is writable');
    assert.equal((await runtime.listConnections('orgA'))[0].health.ok, true);
    await runtime.tick();
    assert.equal((await runtime.listRuns('orgA', id)).length, 0, 'not due yet');
    const ref = db.collection('connector_connections').doc(id);
    await ref.update({ nextRunAt: new Date(Date.now() - 1000).toISOString() });
    await runtime.tick();
    let runs = await runtime.listRuns('orgA', id);
    assert.equal(runs.length, 1); assert.equal(runs[0].trigger, 'schedule');
    assert.ok(new Date((await ref.get()).data().nextRunAt).getTime() > Date.now() + 14 * 60000, 'the next run is one interval away');
    await ref.update({ nextRunAt: new Date(Date.now() - 1000).toISOString(), status: 'error' });
    await runtime.tick();
    assert.equal((await runtime.listRuns('orgA', id)).length, 2, 'a connection in the error state keeps its schedule so it can recover');
    assert.equal((await ref.get()).data().status, 'active');
    await ref.update({ nextRunAt: new Date(Date.now() - 1000).toISOString(), status: 'paused' });
    await runtime.tick();
    assert.equal((await runtime.listRuns('orgA', id)).length, 2, 'paused connections are skipped');
});

test('runtime: mapping preview shows defaults merged with the rules being edited, without saving anything', () => {
    const sample = { id: 'u1', employee_number: 'EMP0001', first_name: 'Ada', last_name: 'Lovelace', work_email: 'ADA@EXAMPLE.COM', status: 'active', job: { title: 'Engineer' } };
    const base = runtime.previewMapping('file-export', 'people_csv', sample);
    assert.equal(base.output.email, 'ADA@EXAMPLE.COM'); assert.equal(base.output.job_title, 'Engineer'); assert.deepEqual(base.errors, []);
    const edited = runtime.previewMapping('file-export', 'people_csv', sample, [{ target: 'email', transform: 'lower' }, { target: 'phone', disabled: true }, { target: 'full_name', transform: { fn: 'template', value: '{{last_name}}, {{first_name}}' } }]);
    assert.equal(edited.output.email, 'ada@example.com'); assert.equal(edited.output.full_name, 'Lovelace, Ada');
    assert.ok(!edited.rules.some((r) => r.target === 'phone'));
    assert.deepEqual(runtime.previewMapping('nope', 'x', sample), { errors: ['unknown connector'] });
});
