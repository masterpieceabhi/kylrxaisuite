#!/usr/bin/env node
/**
 * Restore: reads a backup made by scripts/backup.js into the database the current credentials point at.
 *
 *   node scripts/restore.js --from <backup folder> --project <target project id> [--dry-run] [--force]
 *                           [--only a,b | --exclude a,b] [--vault-dir <folder>] [--no-vault]
 *
 * Safety:
 *   - every file is checked against manifest.json (SHA-256 and document count) before anything is written
 *   - --project must match the project the credentials connect to
 *   - it refuses to write into a database that already has data unless --force is given
 *   - --dry-run does all the checks and reports what would be written, and writes nothing
 * It never prints a configuration value or the content of a document.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const R = require('../services/backup-rules');
const { fileFacts, walk, connect } = require('./backup');

const BATCH = 400;                 // Firestore allows 500 writes in one batch
const MAX_BATCH_BYTES = 4000000;   // and about 10 MB per request: stay well under it

function readManifest(dir) {
    const file = path.join(dir, 'manifest.json');
    if (!fs.existsSync(file)) throw new Error(`no manifest.json in ${dir}: this is not a backup folder`);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { throw new Error('manifest.json is not readable'); }
}

/** Checks the folder against its manifest. Returns { ok, problems, manifest }. */
async function verifyBackup(dir) {
    const manifest = readManifest(dir);
    const early = R.checkManifest(manifest);
    if (early.length) return { ok: false, problems: early, manifest };
    const collections = [];
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) collections.push({ file: name, ...(await fileFacts(path.join(dir, name))) });
    const vault = [];
    if (manifest.vault && manifest.vault.included) for (const rel of walk(path.join(dir, 'vault'))) { const f = await fileFacts(path.join(dir, 'vault', ...rel.split('/'))); vault.push({ path: rel, bytes: f.bytes, sha256: f.sha256 }); }
    return { ...R.verifyManifest(manifest, { collections, vault }), manifest };
}

/** Does the database hold any document at all? */
async function isEmpty(db) {
    for (const col of await db.listCollections()) {
        if (!(await col.limit(1).get()).empty) return false;
        if ((await col.listDocuments()).length) return false; // a document that holds only subcollections still means "not empty"
    }
    return true;
}

/** Writes the selected files into `db`. Returns { documents, perCollection }. `make` builds the SDK value objects. */
async function restoreDatabase(db, dir, manifest, { make, only = [], exclude = [], dryRun = false, log = () => {} } = {}) {
    const perCollection = {}; let total = 0;
    for (const c of R.selectCollections(manifest, { only, exclude })) {
        const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, c.file), 'utf8'), crlfDelay: Infinity });
        let batch = db.batch(); let pending = 0; let pendingBytes = 0; let n = 0;
        for await (const line of rl) {
            if (!line) continue;
            const doc = R.decodeLine(line, make);
            if (R.collectionKey(doc.path) !== c.key) throw new Error(`${c.file} holds a document that belongs to another collection`);
            n += 1;
            if (dryRun) continue;
            batch.set(db.doc(doc.path), doc.data);
            pendingBytes += line.length;
            if (++pending >= BATCH || pendingBytes > MAX_BATCH_BYTES) { await batch.commit(); batch = db.batch(); pending = 0; pendingBytes = 0; }
        }
        if (pending) await batch.commit();
        perCollection[c.key] = n; total += n;
        log(`${c.key}: ${n} documents${dryRun ? ' (not written)' : ''}`);
    }
    return { documents: total, perCollection };
}

/** Copies the vault files from the backup into `vaultDir`. Refuses a non-empty folder unless force. */
function restoreVault(dir, manifest, vaultDir, { force = false, dryRun = false } = {}) {
    if (!manifest.vault || !manifest.vault.included) return { files: 0, skipped: 'the backup has no vault files' };
    if (!vaultDir) return { files: 0, skipped: 'no vault folder was given' };
    const existing = fs.existsSync(vaultDir) ? walk(vaultDir).length : 0;
    if (existing && !force) return { files: 0, skipped: 'the vault folder already has files (use --force to write over files with the same name)' };
    if (dryRun) return { files: manifest.vault.files.length, skipped: null, dryRun: true };
    for (const f of manifest.vault.files) {
        if (!R.safeRelative(f.path)) throw new Error('unsafe vault file path in the manifest');
        const to = path.join(vaultDir, ...f.path.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(dir, 'vault', ...f.path.split('/')), to);
    }
    return { files: manifest.vault.files.length, skipped: null };
}

/** The whole restore. Returns a report; `written` says whether anything changed. */
async function runRestore({ db, make, from, only, exclude, force, dryRun, vaultDir, noVault, log = () => {} }) {
    const v = await verifyBackup(from);
    if (!v.ok) return { written: false, verified: false, problems: v.problems, reason: R.restoreDecision({ verified: false }).reason };
    const targetEmpty = await isEmpty(db);
    const decision = R.restoreDecision({ dryRun, targetEmpty, force, verified: true });
    if (!decision.allowed && !dryRun) return { written: false, verified: true, targetEmpty, problems: [], reason: decision.reason };
    const result = await restoreDatabase(db, from, v.manifest, { make, only, exclude, dryRun, log });
    const vault = noVault ? { files: 0, skipped: '--no-vault was given' } : restoreVault(from, v.manifest, vaultDir, { force, dryRun });
    const wouldBeRefused = dryRun && !targetEmpty && !force;
    return { written: !dryRun, verified: true, targetEmpty, problems: [], documents: result.documents, perCollection: result.perCollection, vault,
        reason: dryRun ? `Dry run: nothing was written.${wouldBeRefused ? ' A real run would be refused: the target database already has data (it needs --force).' : ''}` : decision.reason };
}

const HELP = `Restore a backup made by scripts/backup.js.

  node scripts/restore.js --from <backup folder> --project <target project id> [options]

  --from <folder>      the dated backup folder (the one that holds manifest.json)
  --project <id>       the project you mean to restore into; must match the credentials in use
  --dry-run            check everything and report, write nothing
  --force              allow writing into a database that already has data
  --only a,b           restore only these top-level collections
  --exclude a,b        leave these top-level collections out
  --vault-dir <folder> where to put the vault files (default: the app's vault folder setting)
  --no-vault           do not restore vault files

See docs/BACKUP.md for the full steps, including sign-in accounts and the encryption key.`;

async function main() {
    const { options, errors } = R.parseArgs('restore', process.argv.slice(2));
    if (options.help) { console.log(HELP); return 0; }
    if (errors.length) { console.error(errors.map((e) => `- ${e}`).join('\n')); console.error('\nRun with --help for the options.'); return 2; }
    const c = connect();
    if (!c.projectId || c.projectId !== options.project) {
        console.error(`- The credentials in use connect to project "${c.projectId || 'unknown'}", but --project says "${options.project}". Nothing was written.`);
        return 2;
    }
    const make = { timestamp: (s, n) => new c.Timestamp(s, n), geoPoint: (lat, lng) => new c.GeoPoint(lat, lng), reference: (p) => c.db.doc(p), bytes: (b) => b, integer: (v) => Number(v) };
    const vaultDir = options.noVault ? null : path.resolve(options.vaultDir || process.env.VAULT_DIR || path.join(__dirname, '..', '..', 'kylrxaisuite-vault'));
    console.log(`${options.dryRun ? 'Checking' : 'Restoring'} ${path.resolve(options.from)} into project ${c.projectId}${c.emulator ? ' (emulator)' : ''}...`);
    const r = await runRestore({ db: c.db, make, from: path.resolve(options.from), only: options.only || [], exclude: options.exclude || [], force: Boolean(options.force), dryRun: Boolean(options.dryRun), vaultDir, noVault: Boolean(options.noVault), log: (m) => console.log(`  ${m}`) });
    if (!r.verified) { console.error('The backup did not pass its checks:'); for (const p of r.problems) console.error(`- ${p}`); console.error(r.reason); return 1; }
    if (r.documents !== undefined) console.log(`${r.written ? 'Wrote' : 'Would write'} ${r.documents} documents.${r.vault ? ` Vault: ${r.vault.skipped ? `skipped (${r.vault.skipped})` : `${r.vault.files} files${r.written ? '' : ' (not written)'}`}.` : ''}`);
    console.log(r.reason);
    if (!r.written && !options.dryRun) return 1;
    if (r.written) console.log('Next: restore sign-in accounts (firebase auth:import) and make sure the app uses the same encryption key as when the backup was made.');
    return 0;
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((e) => { console.error(`Restore failed: ${e.message}`); process.exit(1); });
}

module.exports = { verifyBackup, isEmpty, restoreDatabase, restoreVault, runRestore, readManifest };
