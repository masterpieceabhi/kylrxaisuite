// The once-a-day housekeeping run: retention and backup (services/daily-jobs.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../services/daily-jobs.js');

const at = (iso) => new Date(iso);

function world({ retentionRows = [], folders = [], backupFails = false, retentionFails = false } = {}) {
    const calls = { retention: [], backup: [], removed: [], saved: [], logs: [] };
    let claimed = null;
    const dirs = [...folders];
    const jobs = D.create({
        claimDay: async (day) => { if (claimed === day) return false; claimed = day; return true; },
        saveRun: async (run) => { calls.saved.push(run); },
        retention: async (opts) => { calls.retention.push(opts); if (retentionFails) throw new Error('database unavailable'); return retentionRows; },
        backup: async ({ outRoot, now }) => {
            calls.backup.push(outRoot);
            if (backupFails) throw new Error('disk full');
            const name = `backup-${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}Z`;
            dirs.push(name);
            return { dir: path.join(outRoot, name), documents: 120, collections: 9 };
        },
        ensureDir: async () => {},
        listDir: async () => [...dirs],
        removeDir: async (dir) => { calls.removed.push(path.basename(dir)); dirs.splice(dirs.indexOf(path.basename(dir)), 1); },
        log: (level, message) => calls.logs.push([level, message])
    });
    return { jobs, calls, dirs };
}

test('settings: safe defaults, and odd values are ignored', () => {
    assert.deepEqual(D.settings({}), { off: false, hourUtc: 8, retentionReal: false, backupDir: null, keepDays: 35 });
    const s = D.settings({ DAILY_JOBS: 'off', DAILY_JOBS_HOUR_UTC: '3', RETENTION_AUTO: 'on', BACKUP_DIR: 'backups', BACKUP_KEEP_DAYS: '90' });
    assert.equal(s.off, true); assert.equal(s.hourUtc, 3); assert.equal(s.retentionReal, true); assert.equal(s.keepDays, 90);
    assert.equal(path.isAbsolute(s.backupDir), true);
    assert.equal(D.settings({ RETENTION_AUTO: 'yes' }).retentionReal, false, 'only the exact word turns deleting on');
    assert.equal(D.settings({ BACKUP_KEEP_DAYS: '1' }).keepDays, 35, 'never fewer than a week of backups');
    assert.equal(D.settings({ DAILY_JOBS_HOUR_UTC: '25' }).hourUtc, 8);
});

test('a run is due once a day, and not before the chosen hour', () => {
    assert.equal(D.isDue(null, at('2026-11-18T07:59:00Z'), 8), false);
    assert.equal(D.isDue(null, at('2026-11-18T08:00:00Z'), 8), true);
    assert.equal(D.isDue('2026-11-18', at('2026-11-18T20:00:00Z'), 8), false);
    assert.equal(D.isDue('2026-11-17', at('2026-11-18T08:05:00Z'), 8), true);
});

test('only old backup folders go, never the newest and never a folder that is not a backup', () => {
    const now = at('2026-11-18T08:00:00Z');
    const names = ['backup-20261118-080000Z', 'backup-20261101-080000Z', 'backup-20261010-080000Z', 'backup-20260901-080000Z', 'photos', 'backup-notes', 'backup-20261340-990000Z'];
    assert.deepEqual(D.foldersToPrune(names, now, 35), ['backup-20261010-080000Z', 'backup-20260901-080000Z']);
    assert.deepEqual(D.foldersToPrune(['backup-20250101-080000Z'], now, 35), [], 'the only backup is kept however old it is');
    assert.deepEqual(D.foldersToPrune(['backup-20250101-080000Z', 'backup-20250201-080000Z'], now, 35), ['backup-20250101-080000Z'], 'the newest is kept even when it is old too');
    assert.deepEqual(D.foldersToPrune([], now, 35), []);
});

test('without RETENTION_AUTO the run only counts; with it, it deletes', async () => {
    const rows = [{ key: 'vault_expired_docs', orgId: 'a', eligible: 3, affected: 0 }, { key: 'webhook_logs', orgId: 'b', eligible: 2, affected: 0 }];
    const dry = world({ retentionRows: rows });
    const run = await dry.jobs.runOnce(at('2026-11-18T08:00:00Z'), {});
    assert.deepEqual(dry.calls.retention, [{ dryRun: true }]);
    assert.equal(run.retention.real, false); assert.equal(run.retention.eligible, 5);
    assert.match(run.summary, /would delete 5 expired records/);
    assert.match(run.summary, /no backup \(BACKUP_DIR is not set\)/);
    assert.equal(run.ok, true);

    const real = world({ retentionRows: [{ key: 'vault_expired_docs', orgId: 'a', eligible: 3, affected: 3 }] });
    const run2 = await real.jobs.runOnce(at('2026-11-18T08:00:00Z'), { RETENTION_AUTO: 'on' });
    assert.deepEqual(real.calls.retention, [{ dryRun: false }]);
    assert.match(run2.summary, /^deleted 3 expired records/);
    assert.deepEqual(run2.retention.jobs, { vault_expired_docs: 3 });
});

test('a backup is made first, and old ones are removed only after it exists', async () => {
    const w = world({ folders: ['backup-20261001-080000Z', 'backup-20261117-080000Z', 'keep-me'] });
    const run = await w.jobs.runOnce(at('2026-11-18T08:00:00Z'), { BACKUP_DIR: 'backups' });
    assert.equal(w.calls.backup.length, 1);
    assert.deepEqual(w.calls.removed, ['backup-20261001-080000Z']);
    assert.deepEqual(w.dirs.sort(), ['backup-20261117-080000Z', 'backup-20261118-080000Z', 'keep-me']);
    assert.equal(run.backup.documents, 120); assert.equal(run.backup.pruned, 1); assert.equal(run.ok, true);
    assert.match(run.summary, /backup of 120 documents made, 1 old backup removed/);
});

test('when the backup fails nothing old is removed, the run is marked failed, and retention still ran', async () => {
    const w = world({ folders: ['backup-20260901-080000Z', 'backup-20261001-080000Z'], backupFails: true });
    const run = await w.jobs.runOnce(at('2026-11-18T08:00:00Z'), { BACKUP_DIR: 'backups' });
    assert.deepEqual(w.calls.removed, []);
    assert.equal(run.ok, false); assert.equal(run.backup.error, 'disk full');
    assert.equal(w.calls.retention.length, 1);
    assert.equal(w.calls.saved.length, 1, 'a failed run is recorded too');
    assert.equal(w.calls.logs.at(-1)[0], 'error');
});

test('when retention fails the backup is still made', async () => {
    const w = world({ retentionFails: true });
    const run = await w.jobs.runOnce(at('2026-11-18T08:00:00Z'), { BACKUP_DIR: 'backups' });
    assert.equal(run.retention.error, 'database unavailable');
    assert.equal(w.calls.backup.length, 1); assert.equal(run.ok, false);
});

test('a job that could not handle some records marks the run as not ok', async () => {
    const w = world({ retentionRows: [{ key: 'vault_expired_docs', orgId: 'a', eligible: 2, affected: 1, errors: [{ id: 'd1', error: 'file locked' }] }] });
    const run = await w.jobs.runOnce(at('2026-11-18T08:00:00Z'), { RETENTION_AUTO: 'on' });
    assert.equal(run.ok, false); assert.equal(run.retention.failed, 1);
});

test('the check runs the work once a day, not before the hour, and not at all when switched off', async () => {
    const w = world();
    assert.equal(await w.jobs.tick(at('2026-11-18T07:30:00Z'), {}), null, 'too early');
    assert.ok(await w.jobs.tick(at('2026-11-18T08:10:00Z'), {}));
    assert.equal(await w.jobs.tick(at('2026-11-18T08:25:00Z'), {}), null, 'already done today');
    assert.equal(await w.jobs.tick(at('2026-11-18T23:55:00Z'), {}), null);
    assert.ok(await w.jobs.tick(at('2026-11-19T08:00:00Z'), {}), 'the next day it runs again');
    assert.equal(w.calls.saved.length, 2);
    const off = world();
    assert.equal(await off.jobs.tick(at('2026-11-18T12:00:00Z'), { DAILY_JOBS: 'off' }), null);
    assert.equal(off.calls.retention.length, 0);
});
