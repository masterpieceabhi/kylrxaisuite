// US-K12: integration alerts. Pure rules, then the real path: failing connector runs and failing webhook
// deliveries (against a local HTTP receiver) raise one alert, which can be acknowledged and resolves by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
process.env.WEBHOOK_ALLOW_LOOPBACK = 'true';
const exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kylrx-alerts-'));
process.env.CONNECTOR_EXPORT_DIR = exportDir;
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const R = require('../services/integration-alert-rules.js');
const alerts = require('../services/integration-alerts.js');
const runtime = require('../services/connectors/runtime.js');
const webhooks = require('../services/webhooks.js');
const events = require('../services/events.js');

test.after(() => { fs.rmSync(exportDir, { recursive: true, force: true }); });

/* --------------------------------------- rules --------------------------------------- */

test('settings: defaults, stored values, and what an admin may change', () => {
    assert.deepEqual(R.normalizeSettings(null), { enabled: true, syncFailures: 3, webhookFailures: 5 });
    assert.deepEqual(R.normalizeSettings({ enabled: false, syncFailures: 2, webhookFailures: 999 }), { enabled: false, syncFailures: 2, webhookFailures: 5 });
    assert.deepEqual(R.validateSettings({ syncFailures: 1 }, null), { errors: [], value: { enabled: true, syncFailures: 1, webhookFailures: 5 } });
    assert.deepEqual(R.validateSettings({ enabled: false }, { syncFailures: 4 }).value, { enabled: false, syncFailures: 4, webhookFailures: 5 });
    assert.deepEqual(R.validateSettings({ syncFailures: '7', webhookFailures: 50 }, null).value, { enabled: true, syncFailures: 7, webhookFailures: 50 });
    const bad = R.validateSettings({ enabled: 'yes', syncFailures: 0, webhookFailures: 2.5 }, null);
    assert.equal(bad.errors.length, 3);
    assert.match(bad.errors[1], /Failed sync runs in a row must be a whole number from 1 to 50/);
    assert.equal(R.validateSettings({ syncFailures: 51 }, null).errors.length, 1);
});

test('failed-runs-in-a-row counter: failed adds one, success clears, a partly successful run changes nothing', () => {
    assert.equal(R.nextSyncStreak(undefined, 'failed'), 1);
    assert.equal(R.nextSyncStreak(2, 'failed'), 3);
    assert.equal(R.nextSyncStreak(2, 'success'), 0);
    assert.equal(R.nextSyncStreak(2, 'partial'), 2);
    assert.equal(R.nextSyncStreak(0, 'partial'), 0);
    assert.equal(R.nextSyncStreak(-4, 'failed'), 1);
    assert.equal(R.nextSyncStreak('3', 'failed'), 1, 'a corrupt stored value starts again');
});

test('decide: raise at the threshold, one alert per source, resolve when it works again', () => {
    const d = (failures, active, settings, kind = 'connector_sync') => R.decide({ kind, failures, settings, active }).action;
    assert.equal(d(1, null), 'none'); assert.equal(d(2, null), 'none'); assert.equal(d(3, null), 'raise'); assert.equal(d(9, null), 'raise');
    assert.equal(d(4, { status: 'open' }), 'update'); assert.equal(d(4, { status: 'acknowledged' }), 'update', 'an acknowledged alert is not raised again while the fault lasts');
    assert.equal(d(0, { status: 'open' }), 'resolve'); assert.equal(d(0, { status: 'acknowledged' }), 'resolve'); assert.equal(d(0, null), 'none');
    assert.equal(d(4, null, null, 'webhook_endpoint'), 'none'); assert.equal(d(5, null, null, 'webhook_endpoint'), 'raise');
    assert.equal(d(1, null, { syncFailures: 1 }), 'raise');
    assert.equal(d(10, null, { enabled: false }), 'none', 'switched off: nothing new is raised');
    assert.equal(d(0, { status: 'open' }, { enabled: false }), 'resolve', 'but an existing alert still clears');
    assert.equal(R.thresholdFor('webhook_endpoint', { webhookFailures: 8 }), 8); assert.equal(R.thresholdFor('connector_sync', {}), 3);
});

test('alert text: plain words, no secrets, webhook address reduced to its host', () => {
    const a = R.buildAlert({ orgId: 'o', kind: 'connector_sync', sourceId: 'c1', sourceName: 'Nightly files', failures: 3, threshold: 3, detail: 'HTTP 401 token=abc123 Bearer zzz.yyy\nline two', now: '2026-03-01T00:00:00.000Z' });
    assert.equal(a.status, 'open'); assert.equal(a.raisedAt, '2026-03-01T00:00:00.000Z'); assert.equal(a.acknowledgedAt, null);
    assert.equal(a.lastError, 'HTTP 401 token=*** Bearer *** line two');
    const p = R.publicAlert('id1', a);
    assert.equal(p.title, 'Sync for "Nightly files" keeps failing'); assert.match(p.message, /3 sync runs in a row have failed/);
    assert.equal(p.orgId, undefined);
    assert.equal(R.hostOf('https://hooks.example.com/services/T000/B000/secret-part?key=1'), 'hooks.example.com');
    assert.equal(R.hostOf('not a url'), 'unknown address');
    const w = R.publicAlert('id2', R.buildAlert({ orgId: 'o', kind: 'webhook_endpoint', sourceId: 'e1', sourceName: 'hooks.example.com', failures: 5, threshold: 5 }));
    assert.equal(w.title, 'Webhook to hooks.example.com keeps failing'); assert.match(w.message, /Events are kept and retried/);
    assert.throws(() => R.buildAlert({ kind: 'other' }), /unknown alert kind/);
    assert.equal(R.safeText('x'.repeat(999)).length, 300);
});

test('acknowledge rules and ordering', () => {
    assert.deepEqual(R.canAcknowledge({ status: 'open' }), { ok: true });
    assert.equal(R.canAcknowledge({ status: 'acknowledged' }).error, 'This alert was already acknowledged');
    assert.equal(R.canAcknowledge({ status: 'resolved' }).error, 'This alert is already resolved');
    assert.deepEqual(R.validateAcknowledge({ note: '  looking into it ' }), { errors: [], value: { note: 'looking into it' } });
    assert.deepEqual(R.validateAcknowledge(undefined).value, { note: null });
    assert.equal(R.validateAcknowledge({ note: 'x'.repeat(301) }).errors.length, 1);
    const sorted = R.sortAlerts([{ id: 1, status: 'resolved', last_seen_at: '2026-03-05' }, { id: 2, status: 'open', last_seen_at: '2026-03-01' }, { id: 3, status: 'acknowledged', last_seen_at: '2026-03-04' }, { id: 4, status: 'open', last_seen_at: '2026-03-03' }]);
    assert.deepEqual(sorted.map((a) => a.id), [4, 2, 3, 1]);
});

/* ------------------------------- connector runs (stored) ------------------------------- */

const seed = async (orgId) => db.collection('users').doc(`${orgId}_u1`).set({ orgId, employeeId: 'EMP0001', name: 'Person One', email: `p1@${orgId}.example.com`, status: 'Active', updatedAt: '2026-01-01T00:00:00.000Z' });
const brokenConn = (name = 'Nightly files') => ({ connector: 'file-export', name, config: { driver: 'sftp', 'sftp.host': 'files.example.com' }, credentials: { sftpPassword: 'pw-123456' }, entities: { time_csv: false, journal_csv: false } });

test('a connector that fails three runs in a row raises one alert; more failures update it; a good run resolves it', async () => {
    mem.reset(); await seed('orgA');
    const { id } = await runtime.createConnection('orgA', brokenConn());
    assert.equal((await runtime.runConnection('orgA', id)).alert.action, 'none');
    assert.equal((await runtime.runConnection('orgA', id)).alert.action, 'none');
    assert.deepEqual(await alerts.list('orgA'), []);
    const third = await runtime.runConnection('orgA', id);
    assert.equal(third.failureStreak, 3); assert.equal(third.alert.action, 'raise');
    let list = await alerts.list('orgA');
    assert.equal(list.length, 1);
    assert.deepEqual({ kind: list[0].kind, source: list[0].source_id, name: list[0].source_name, status: list[0].status, failures: list[0].failures, threshold: list[0].threshold },
        { kind: 'connector_sync', source: id, name: 'Nightly files', status: 'open', failures: 3, threshold: 3 });
    assert.match(list[0].last_error, /SFTP driver is not installed/);
    assert.ok(!JSON.stringify(list).includes('pw-123456'));
    assert.ok((await runtime.listLogs('orgA', id)).some((l) => /Alert raised: 3 sync runs in a row have failed/.test(l.message)));
    const fourth = await runtime.runConnection('orgA', id);
    assert.equal(fourth.alert.action, 'update'); assert.equal(fourth.alert.id, third.alert.id);
    list = await alerts.list('orgA');
    assert.equal(list.length, 1, 'still one alert'); assert.equal(list[0].failures, 4);
    await runtime.updateConnection('orgA', id, { config: { driver: 'local', folder: 'ok' } });
    const good = await runtime.runConnection('orgA', id);
    assert.equal(good.run.status, 'success'); assert.equal(good.alert.action, 'resolve');
    assert.deepEqual(await alerts.list('orgA'), [], 'the default list shows only alerts that still need attention');
    const all = await alerts.list('orgA', { status: 'all' });
    assert.equal(all[0].status, 'resolved'); assert.ok(all[0].resolved_at);
});

test('acknowledge: once, by the owning company only; an acknowledged alert stays quiet and still resolves', async () => {
    mem.reset(); await seed('orgA'); await seed('orgB');
    const { id } = await runtime.createConnection('orgA', brokenConn());
    for (let i = 0; i < 3; i++) await runtime.runConnection('orgA', id);
    const [alert] = await alerts.list('orgA');
    assert.deepEqual(await alerts.list('orgB'), [], 'another company sees nothing');
    assert.deepEqual(await alerts.acknowledge('orgB', alert.id, 'intruder', {}), { notFound: true });
    assert.deepEqual(await alerts.acknowledge('orgA', 'missing', 'admin1', {}), { notFound: true });
    assert.equal((await alerts.acknowledge('orgA', alert.id, 'admin1', { note: 'x'.repeat(400) })).errors.length, 1);
    const ack = await alerts.acknowledge('orgA', alert.id, 'admin1', { note: 'Vendor is replacing the server' });
    assert.equal(ack.alert.status, 'acknowledged'); assert.equal(ack.alert.acknowledged_by, 'admin1'); assert.equal(ack.alert.acknowledge_note, 'Vendor is replacing the server'); assert.ok(ack.alert.acknowledged_at);
    assert.deepEqual(await alerts.acknowledge('orgA', alert.id, 'admin1', {}), { conflict: 'This alert was already acknowledged' });
    assert.equal((await alerts.list('orgA', { status: 'open' })).length, 0);
    assert.equal((await alerts.list('orgA', { status: 'active' })).length, 1);
    const more = await runtime.runConnection('orgA', id);
    assert.equal(more.alert.action, 'update');
    const [same] = await alerts.list('orgA', { status: 'all' });
    assert.equal(same.status, 'acknowledged', 'it is not reopened'); assert.equal(same.failures, 4);
    await runtime.updateConnection('orgA', id, { config: { driver: 'local', folder: 'ok2' } });
    await runtime.runConnection('orgA', id);
    const [done] = await alerts.list('orgA', { status: 'all' });
    assert.equal(done.status, 'resolved'); assert.equal(done.acknowledge_note, 'Vendor is replacing the server');
    assert.deepEqual(await alerts.acknowledge('orgA', alert.id, 'admin1', {}), { conflict: 'This alert is already resolved' });
});

test('after an alert is resolved, a new run of failures raises a new one; deleting the connection clears its alert', async () => {
    mem.reset(); await seed('orgA');
    const { id } = await runtime.createConnection('orgA', brokenConn());
    for (let i = 0; i < 3; i++) await runtime.runConnection('orgA', id);
    await runtime.updateConnection('orgA', id, { config: { driver: 'local', folder: 'ok3' } });
    await runtime.runConnection('orgA', id);
    await runtime.updateConnection('orgA', id, { config: { driver: 'sftp' } });
    await db.collection('users').doc('orgA_u1').update({ name: 'Person Renamed', updatedAt: '2026-02-01T00:00:00.000Z' }); // something new to send, so the run has work that fails
    for (let i = 0; i < 3; i++) await runtime.runConnection('orgA', id);
    const all = await alerts.list('orgA', { status: 'all' });
    assert.deepEqual(all.map((a) => a.status), ['open', 'resolved']);
    assert.equal(await runtime.deleteConnection('orgA', id), true);
    assert.deepEqual((await alerts.list('orgA', { status: 'all' })).map((a) => a.status), ['resolved', 'resolved']);
});

test('company settings: a lower threshold raises sooner, switching alerts off raises nothing; saved per company', async () => {
    mem.reset(); await seed('orgA'); await seed('orgB');
    assert.deepEqual(await alerts.getSettings('orgA'), { enabled: true, syncFailures: 3, webhookFailures: 5 });
    assert.equal((await alerts.saveSettings('orgA', { syncFailures: 0 }, 'admin1')).errors.length, 1);
    await db.collection('organizations').doc('orgA').set({ name: 'A', integrationSettings: { allowTimeWrite: true } });
    assert.deepEqual((await alerts.saveSettings('orgA', { syncFailures: 1 }, 'admin1')).settings, { enabled: true, syncFailures: 1, webhookFailures: 5 });
    assert.equal((await db.collection('organizations').doc('orgA').get()).data().integrationSettings.allowTimeWrite, true, 'other integration settings are kept');
    assert.equal((await alerts.getSettings('orgB')).syncFailures, 3);
    const a = await runtime.createConnection('orgA', brokenConn());
    assert.equal((await runtime.runConnection('orgA', a.id)).alert.action, 'raise');
    await alerts.saveSettings('orgB', { enabled: false }, 'admin2');
    const b = await runtime.createConnection('orgB', brokenConn());
    for (let i = 0; i < 5; i++) assert.equal((await runtime.runConnection('orgB', b.id)).alert.action, 'none');
    assert.deepEqual(await alerts.list('orgB', { status: 'all' }), []);
});

test('a retry of one failed record never raises or clears an alert', async () => {
    mem.reset(); await seed('orgA');
    const { id } = await runtime.createConnection('orgA', brokenConn());
    await runtime.runConnection('orgA', id); await runtime.runConnection('orgA', id);
    const [dl] = await runtime.listDeadLetters('orgA', id, 'open');
    const r = await runtime.retryDeadLetter('orgA', id, dl.id);
    assert.equal(r.ok, false);
    assert.deepEqual(await alerts.list('orgA', { status: 'all' }), [], 'two failed runs plus a failed retry is still below three runs');
    assert.equal((await runtime.listConnections('orgA'))[0].failed_runs_in_a_row, 2);
});

test('a scheduled run that crashes counts as a failed run', async () => {
    mem.reset(); await seed('orgA');
    await alerts.saveSettings('orgA', { syncFailures: 2 }, 'admin1');
    const { id } = await runtime.createConnection('orgA', { ...brokenConn(), schedule: { enabled: true, intervalMinutes: 5 } });
    const ref = db.collection('connector_connections').doc(id);
    for (let i = 0; i < 2; i++) {
        await ref.update({ nextRunAt: new Date(Date.now() - 1000).toISOString(), credentialsEnc: 'not-a-valid-ciphertext' }); // unreadable credentials make the run throw before it starts
        await runtime.tick();
    }
    const c = (await ref.get()).data();
    assert.equal(c.failureStreak, 2); assert.equal(c.status, 'error'); assert.equal(c.lastStatus, 'failed');
    assert.ok(new Date(c.nextRunAt).getTime() > Date.now(), 'it is moved to its next slot instead of being retried every tick');
    const [a] = await alerts.list('orgA');
    assert.equal(a.failures, 2); assert.equal(a.status, 'open');
});

/* -------------------------------- webhook deliveries (real HTTP) -------------------------------- */

let receiver; let receiverUrl; let answer = 500; const received = [];
test.before(async () => {
    receiver = http.createServer((req, res) => { let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { received.push({ headers: req.headers, body }); res.statusCode = answer; res.end('ok'); }); });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook/secret-path-token`;
});
// the short wait lets sockets finish closing: on Windows a forced exit (--test-force-exit) during that crashes Node
test.after(async () => { receiver.closeAllConnections(); await new Promise((r) => receiver.close(r)); await new Promise((r) => setTimeout(r, 300)); });

const deliver = async (orgId, endpointId) => webhooks.attempt(await webhooks.enqueue(orgId, endpointId, events.buildEvent(orgId, 'person.created', { person_id: 'u1' })));

test('a webhook endpoint that fails five attempts in a row raises one alert; a delivered message resolves it', async () => {
    mem.reset(); answer = 500; received.length = 0;
    const made = await webhooks.createEndpoint('orgA', { url: receiverUrl, events: ['*'] }, 'admin1');
    assert.equal(made.errors, undefined);
    for (let i = 1; i <= 4; i++) { const d = await deliver('orgA', made.id); assert.equal(d.lastError, 'HTTP 500'); }
    assert.deepEqual(await alerts.list('orgA'), []);
    await deliver('orgA', made.id);
    assert.equal(received.length, 5, 'the receiver really was called');
    assert.match(received[0].headers['x-kylrx-signature'], /^t=\d+,v1=[0-9a-f]{64}$/);
    let [a] = await alerts.list('orgA');
    assert.deepEqual({ kind: a.kind, source: a.source_id, status: a.status, failures: a.failures, threshold: a.threshold, last_error: a.last_error }, { kind: 'webhook_endpoint', source: made.id, status: 'open', failures: 5, threshold: 5, last_error: 'HTTP 500' });
    assert.equal(a.source_name, new URL(receiverUrl).host);
    assert.ok(!JSON.stringify(a).includes('secret-path-token'), 'the path of the address is not copied into the alert');
    assert.equal((await webhooks.listEndpoints('orgA'))[0].consecutive_failures, 5);
    await deliver('orgA', made.id);
    assert.equal((await alerts.list('orgA')).length, 1); assert.equal((await alerts.list('orgA'))[0].failures, 6);
    answer = 204;
    const ok = await deliver('orgA', made.id);
    assert.equal(ok.status, 'delivered');
    assert.deepEqual(await alerts.list('orgA'), []);
    [a] = await alerts.list('orgA', { status: 'resolved' });
    assert.equal(a.status, 'resolved');
    assert.equal((await webhooks.listEndpoints('orgA'))[0].consecutive_failures, 0);
});

test('a paused endpoint does not raise an alert; deleting an endpoint clears its alert; companies stay separate', async () => {
    mem.reset(); answer = 500;
    await alerts.saveSettings('orgA', { webhookFailures: 2 }, 'admin1');
    const paused = await webhooks.createEndpoint('orgA', { url: receiverUrl, events: ['*'] }, 'admin1');
    await webhooks.updateEndpoint('orgA', paused.id, { active: false });
    for (let i = 0; i < 4; i++) assert.equal((await deliver('orgA', paused.id)).lastError, 'endpoint is disabled');
    assert.deepEqual(await alerts.list('orgA', { status: 'all' }), []);
    const live = await webhooks.createEndpoint('orgA', { url: receiverUrl, events: ['*'] }, 'admin1');
    await deliver('orgA', live.id); await deliver('orgA', live.id);
    assert.equal((await alerts.list('orgA')).length, 1);
    assert.deepEqual(await alerts.list('orgB'), []);
    const other = await webhooks.createEndpoint('orgB', { url: receiverUrl, events: ['*'] }, 'admin2');
    await deliver('orgB', other.id); await deliver('orgB', other.id);
    assert.deepEqual(await alerts.list('orgB'), [], 'orgB still has the default threshold of five');
    assert.equal(await webhooks.deleteEndpoint('orgA', live.id), true);
    assert.deepEqual((await alerts.list('orgA', { status: 'all' })).map((x) => x.status), ['resolved']);
});
