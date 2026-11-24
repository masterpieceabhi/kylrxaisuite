/**
 * The once-a-day housekeeping run: data that has passed its retention date is deleted, and a backup is made.
 *
 *   Retention  every installed job in services/retention-jobs.js, for every company.
 *              RETENTION_AUTO=on  -> really deletes. Anything else -> a dry run: counts what WOULD be deleted, deletes nothing.
 *   Backup     scripts/backup.js into BACKUP_DIR (a new dated folder), then backup folders older than BACKUP_KEEP_DAYS
 *              (default 35) are removed. Not set -> no backup is made here (use Google's managed backups: docs/BACKUP.md).
 *
 *   Reminders  services/email-reminders.js: open checklist tasks, unread policies, unsigned documents (REMINDERS_EMAIL=off stops them).
 *
 * It runs once per calendar day (UTC), at or after DAILY_JOBS_HOUR_UTC (default 8, about 2-3 am US Central). The day is
 * claimed in the database first, inside a transaction, so a restart does not run it twice and two copies of the server
 * do not both run it. What happened is kept in `platform_jobs/daily` and the last 60 runs in its `runs` list.
 *
 * Everything outside (database, the jobs, the backup, the disk) is passed in, so the rules here can be tested alone.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_HOUR_UTC = 8;
const DEFAULT_KEEP_DAYS = 35;
const BACKUP_FOLDER = /^backup-(\d{4})(\d{2})(\d{2})-(\d{6})Z$/; // the name scripts/backup.js gives its folders
const HISTORY = 60;

const dayOf = (now) => now.toISOString().slice(0, 10);

/** Settings read from the environment, with the reasons a part is off. */
function settings(env = process.env) {
    const hour = Number.isInteger(Number(env.DAILY_JOBS_HOUR_UTC)) && Number(env.DAILY_JOBS_HOUR_UTC) >= 0 && Number(env.DAILY_JOBS_HOUR_UTC) <= 23 ? Number(env.DAILY_JOBS_HOUR_UTC) : DEFAULT_HOUR_UTC;
    const keep = Number(env.BACKUP_KEEP_DAYS);
    return {
        off: env.DAILY_JOBS === 'off',
        hourUtc: hour,
        retentionReal: env.RETENTION_AUTO === 'on',
        backupDir: env.BACKUP_DIR ? path.resolve(env.BACKUP_DIR) : null,
        keepDays: Number.isFinite(keep) && keep >= 7 && keep <= 3650 ? Math.floor(keep) : DEFAULT_KEEP_DAYS // never fewer than a week
    };
}

/** Is a run due? Once per UTC day, not before the chosen hour. */
function isDue(lastRunDay, now, hourUtc = DEFAULT_HOUR_UTC) {
    return now.getUTCHours() >= hourUtc && lastRunDay !== dayOf(now);
}

/**
 * Which backup folders may go: only folders with the backup script's own name, older than keepDays, and never the
 * newest one (so a broken backup job cannot end with no backup at all).
 */
function foldersToPrune(names, now, keepDays = DEFAULT_KEEP_DAYS) {
    const dated = names.map((name) => {
        const m = BACKUP_FOLDER.exec(name);
        if (!m) return null;
        const at = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4].slice(0, 2)}:${m[4].slice(2, 4)}:${m[4].slice(4, 6)}Z`);
        return Number.isFinite(at) ? { name, at } : null;
    }).filter(Boolean).sort((a, b) => b.at - a.at);
    const cutoff = now.getTime() - keepDays * 86400000;
    return dated.slice(1).filter((f) => f.at < cutoff).map((f) => f.name);
}

/** One line a person can read about a run. */
function summary(run) {
    const r = run.retention; const b = run.backup;
    const parts = [];
    if (r) parts.push(r.error ? `retention failed (${r.error})` : `${r.real ? 'deleted' : 'would delete'} ${r.real ? r.affected : r.eligible} expired ${(r.real ? r.affected : r.eligible) === 1 ? 'record' : 'records'}${r.failed ? `, ${r.failed} could not be handled` : ''}`);
    if (b) parts.push(b.skipped ? `no backup (${b.skipped})` : b.error ? `backup failed (${b.error})` : `backup of ${b.documents} documents made, ${b.pruned} old ${b.pruned === 1 ? 'backup' : 'backups'} removed`);
    const m = run.reminders;
    if (m) parts.push(m.skipped ? `no reminders (${m.skipped})` : m.error ? `reminders failed (${m.error})` : `${m.emails} reminder ${m.emails === 1 ? 'email' : 'emails'} sent${m.errors && m.errors.length ? `, ${m.errors.length} ${m.errors.length === 1 ? 'company' : 'companies'} failed` : ''}`);
    const c = run.closures;
    if (c && (c.error || c.deleted || c.reminded || (c.errors && c.errors.length) || c.skipped)) parts.push(c.error ? `closed-company step failed (${c.error})` : `${c.deleted} closed ${c.deleted === 1 ? 'company' : 'companies'} deleted, ${c.reminded} reminded${c.skipped ? ` (${c.skipped})` : ''}${c.errors && c.errors.length ? `, ${c.errors.length} failed` : ''}`);
    return parts.join('; ');
}

/**
 * deps:
 *   claimDay(day)          -> true when this process got today's run (false: already done or taken by another copy)
 *   saveRun(run)           -> stores the result
 *   retention({ dryRun })  -> the list services/retention-jobs.js runAllOrgs returns
 *   backup({ outRoot, now }) -> { documents, collections, dir }
 *   listDir(dir), removeDir(dir), ensureDir(dir)
 *   log(level, message)
 */
function create(deps) {
    async function runOnce(now = new Date(), env = process.env) {
        const s = settings(env);
        const run = { day: dayOf(now), startedAt: now.toISOString(), retention: null, backup: null };

        try {
            const rows = await deps.retention({ dryRun: !s.retentionReal });
            run.retention = {
                real: s.retentionReal,
                eligible: rows.reduce((n, r) => n + (r.eligible || 0), 0),
                affected: rows.reduce((n, r) => n + (r.affected || 0), 0),
                failed: rows.filter((r) => r.error || (r.errors && r.errors.length)).length,
                jobs: rows.filter((r) => r.key).reduce((m, r) => { m[r.key] = (m[r.key] || 0) + (s.retentionReal ? r.affected || 0 : r.eligible || 0); return m; }, {})
            };
        } catch (e) { run.retention = { real: s.retentionReal, error: String((e && e.message) || e).slice(0, 200) }; }

        if (!s.backupDir) run.backup = { skipped: 'BACKUP_DIR is not set' };
        else {
            try {
                await deps.ensureDir(s.backupDir);
                const made = await deps.backup({ outRoot: s.backupDir, now });
                // old folders go only after today's backup exists
                const prune = foldersToPrune(await deps.listDir(s.backupDir), now, s.keepDays);
                let pruned = 0;
                for (const name of prune) { try { await deps.removeDir(path.join(s.backupDir, name)); pruned += 1; } catch (e) { deps.log('warn', `[DailyJobs] could not remove old backup ${name}: ${e.message}`); } }
                run.backup = { documents: made.documents, collections: made.collections, folder: path.basename(made.dir), pruned, keepDays: s.keepDays };
            } catch (e) { run.backup = { error: String((e && e.message) || e).slice(0, 200) }; }
        }

        // reminder emails (services/email-reminders.js); their failure is reported but never blocks the rest
        if (deps.reminders) {
            try { const m = await deps.reminders(); run.reminders = { emails: m.emails || 0, companies: m.companies || 0, errors: (m.errors || []).slice(0, 10), ...(m.skipped ? { skipped: m.skipped } : {}) }; } catch (e) { run.reminders = { error: String((e && e.message) || e).slice(0, 200) }; }
        }

        // closed companies: the reminder 3 days before, then deletion and the written confirmation (services/company-data.js)
        if (deps.closures) {
            try { const c = await deps.closures(); run.closures = { reminded: c.reminded || 0, deleted: c.deleted || 0, errors: (c.errors || []).slice(0, 10), ...(c.skipped ? { skipped: c.skipped } : {}) }; } catch (e) { run.closures = { error: String((e && e.message) || e).slice(0, 200) }; }
        }

        run.finishedAt = new Date().toISOString();
        run.ok = !(run.retention && run.retention.error) && !(run.backup && run.backup.error) && !(run.retention && run.retention.failed) && !(run.closures && (run.closures.error || (run.closures.errors && run.closures.errors.length)));
        run.summary = summary(run);
        deps.log(run.ok ? 'info' : 'error', `[DailyJobs] ${run.day}: ${run.summary}`);
        try { await deps.saveRun(run); } catch (e) { deps.log('error', `[DailyJobs] could not record the run: ${e.message}`); }
        return run;
    }

    /** Called every few minutes: runs today's housekeeping when it is due and nobody else has taken it. */
    async function tick(now = new Date(), env = process.env) {
        const s = settings(env);
        if (s.off || now.getUTCHours() < s.hourUtc) return null;
        if (!(await deps.claimDay(dayOf(now)))) return null;
        return runOnce(now, env);
    }

    return { runOnce, tick };
}

/* --------------------------------- the real thing --------------------------------- */

const STATE = () => require('../config/firebase').rawCollection('platform_jobs').doc('daily');

function realDeps() {
    const logger = require('../utils/logger');
    return {
        async claimDay(day) {
            const { db } = require('../config/firebase');
            const ref = STATE();
            return db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                const had = (typeof snap.exists === 'function' ? snap.exists() : snap.exists) ? snap.data() : {};
                if (had.claimedDay === day) return false;
                tx.set(ref, { claimedDay: day, claimedAt: new Date().toISOString() }, { merge: true });
                return true;
            });
        },
        async saveRun(run) {
            const ref = STATE();
            const snap = await ref.get();
            const had = (typeof snap.exists === 'function' ? snap.exists() : snap.exists) ? snap.data() : {};
            const runs = [{ day: run.day, ok: run.ok, summary: run.summary, finishedAt: run.finishedAt }, ...(Array.isArray(had.runs) ? had.runs : [])].slice(0, HISTORY);
            await ref.set({ last: run, runs }, { merge: true });
        },
        retention: ({ dryRun }) => require('./retention-jobs').runAllOrgs({ dryRun, actor: 'daily-job' }),
        reminders: () => require('./email-reminders').runAll(),
        closures: () => require('./company-data').runDue(),
        async backup({ outRoot, now }) {
            const B = require('../scripts/backup');
            const c = B.connect();
            const vaultDir = path.resolve(process.env.VAULT_DIR || path.join(__dirname, '..', '..', 'kylrxaisuite-vault'));
            if (outRoot === vaultDir || outRoot.startsWith(vaultDir + path.sep)) throw new Error('BACKUP_DIR cannot be inside the vault folder');
            const { dir, manifest } = await B.runBackup({ db: c.db, documentId: c.FieldPath.documentId(), outRoot, vaultDir, projectId: c.projectId, now });
            return { dir, documents: manifest.totals.documents, collections: manifest.totals.collections };
        },
        ensureDir: async (dir) => { fs.mkdirSync(dir, { recursive: true }); },
        listDir: async (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name),
        removeDir: async (dir) => { fs.rmSync(dir, { recursive: true, force: true }); },
        log: (level, message) => (logger[level] || logger.info).call(logger, message)
    };
}

/** What the last runs did, for the owner's retention page and for monitoring. */
async function status(env = process.env) {
    const s = settings(env);
    const snap = await STATE().get();
    const had = (typeof snap.exists === 'function' ? snap.exists() : snap.exists) ? snap.data() : {};
    return {
        on: !s.off, hourUtc: s.hourUtc, deletesForReal: s.retentionReal, backupOn: Boolean(s.backupDir), keepDays: s.keepDays,
        last: had.last ? { day: had.last.day, ok: had.last.ok, summary: had.last.summary, finishedAt: had.last.finishedAt } : null,
        runs: Array.isArray(had.runs) ? had.runs.slice(0, 14) : []
    };
}

let timer = null;
function startJobs() {
    if (timer || settings().off) return false;
    const jobs = create(realDeps());
    const tick = () => jobs.tick().catch((e) => require('../utils/logger').error(`[DailyJobs] check failed: ${e.message}`));
    setTimeout(tick, 2 * 60 * 1000).unref();
    timer = setInterval(tick, 15 * 60 * 1000); timer.unref();
    return true;
}

module.exports = { create, settings, isDue, foldersToPrune, summary, status, startJobs, realDeps, DEFAULT_KEEP_DAYS, DEFAULT_HOUR_UTC };
