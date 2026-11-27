#!/usr/bin/env node
/**
 * Backup: writes every Firestore collection to JSON-lines files (one per collection, subcollections included),
 * copies the document vault folder, and writes manifest.json with the count and SHA-256 of every file.
 *
 *   node scripts/backup.js --out <folder> [--page-size 300] [--exclude a,b | --only a,b] [--no-vault]
 *
 * It connects the same way the app does (see docs/BACKUP.md). It never copies .env, keys or service-account
 * files, and never prints a configuration value. For a large database use Google's managed export instead.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('../services/backup-rules');

const DEFAULT_PAGE = 300;

/** Appends lines to a file while keeping a running SHA-256, so a file is read only once */
function lineWriter(file) {
    const fd = fs.openSync(file, 'w'); const hash = crypto.createHash('sha256'); let bytes = 0; let lines = 0;
    return {
        write(line) { const buf = Buffer.from(`${line}\n`, 'utf8'); fs.writeSync(fd, buf); hash.update(buf); bytes += buf.length; lines += 1; },
        close() { fs.closeSync(fd); return { bytes, documents: lines, sha256: hash.digest('hex') }; }
    };
}

/** SHA-256, size and line count of a file, read as a stream */
function fileFacts(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256'); let bytes = 0; let lines = 0;
        fs.createReadStream(file).on('data', (chunk) => { hash.update(chunk); bytes += chunk.length; for (const b of chunk) if (b === 10) lines += 1; })
            .on('error', reject).on('end', () => resolve({ bytes, documents: lines, sha256: hash.digest('hex') }));
    });
}

/** Every file under a folder, as paths relative to it with forward slashes */
function walk(dir, prefix = '') {
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), rel));
        else if (e.isFile()) out.push(rel);
    }
    return out;
}

/**
 * Reads the whole database into `outDir`.
 *   db: a Firestore instance (Admin SDK, or the in-memory one used by the tests)
 *   documentId: the "order by document id" field (FieldPath.documentId())
 * Returns the collection entries for the manifest.
 */
async function backupDatabase(db, outDir, { pageSize = DEFAULT_PAGE, only = [], exclude = [], documentId, log = () => {} } = {}) {
    fs.mkdirSync(outDir, { recursive: true });
    const writers = new Map();
    const writerFor = (key) => { if (!writers.has(key)) writers.set(key, lineWriter(path.join(outDir, R.fileNameFor(key)))); return writers.get(key); };

    async function dumpCollection(col) {
        const seen = new Set(); let last = null;
        for (;;) {
            let q = col.orderBy(documentId).limit(pageSize);
            if (last) q = q.startAfter(last);
            const page = await q.get();
            for (const doc of page.docs) {
                writerFor(R.collectionKey(doc.ref.path)).write(R.encodeLine(doc.ref.path, doc.data()));
                seen.add(doc.id);
                for (const sub of await doc.ref.listCollections()) await dumpCollection(sub);
            }
            if (page.docs.length < pageSize) break;
            last = page.docs[page.docs.length - 1];
        }
        // documents that hold only subcollections (no fields of their own) do not come back from a query
        for (const ref of await col.listDocuments()) if (!seen.has(ref.id)) for (const sub of await ref.listCollections()) await dumpCollection(sub);
        return seen.size;
    }

    for (const col of await db.listCollections()) {
        if ((only.length && !only.includes(col.id)) || exclude.includes(col.id)) { log(`skipped ${col.id}`); continue; }
        const n = await dumpCollection(col);
        log(`${col.id}: ${n} documents`);
    }
    return [...writers.entries()].map(([key, w]) => ({ key, file: R.fileNameFor(key), ...w.close() }));
}

/** Copies the vault folder into <outDir>/vault and returns its file list with checksums */
async function copyVault(vaultDir, outDir) {
    if (!vaultDir || !fs.existsSync(vaultDir)) return { included: false, files: [] };
    const target = path.join(outDir, 'vault'); const files = [];
    for (const rel of walk(vaultDir)) {
        const to = path.join(target, ...rel.split('/'));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(path.join(vaultDir, ...rel.split('/')), to);
        const f = await fileFacts(to);
        files.push({ path: rel, bytes: f.bytes, sha256: f.sha256 });
    }
    return { included: true, files };
}

/** Full backup into a new folder. Returns { dir, manifest }. */
async function runBackup({ db, documentId, outRoot, vaultDir, projectId, pageSize, only, exclude, noVault, now = new Date(), log = () => {} }) {
    const createdAt = now.toISOString();
    const dir = path.join(outRoot, R.stampFor(createdAt));
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`the folder ${dir} already exists and is not empty`);
    const collections = await backupDatabase(db, dir, { pageSize, only, exclude, documentId, log });
    const vault = noVault ? { included: false, files: [] } : await copyVault(vaultDir, dir);
    const manifest = R.buildManifest({ createdAt, projectId, collections, vault, note: (only && only.length) || (exclude && exclude.length) ? 'Partial backup: some collections were left out on request.' : null });
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { dir, manifest };
}

const HELP = `Backup of the Firestore database and the document vault.

  node scripts/backup.js --out <folder> [options]

  --out <folder>       where to put the backup (a new dated folder is made inside it)
  --page-size <n>      documents read per request, 1-1000 (default ${DEFAULT_PAGE})
  --only a,b           back up only these top-level collections
  --exclude a,b        leave these top-level collections out
  --no-vault           do not copy the document vault folder

Sign-in accounts are not part of this backup, and neither are any keys or settings. See docs/BACKUP.md.`;

/** Connects like the app does; refuses to run without a real database or the emulator */
function connect() {
    const { admin } = require('../config/firebase');
    if (!admin.apps || !admin.apps.length) throw new Error('No database connection. Set the same Firebase credentials the app uses (or the emulator address) before running this.');
    const { FieldPath, Timestamp, GeoPoint } = require('firebase-admin/firestore');
    const app = admin.app();
    const projectId = (app.options && (app.options.projectId || (app.options.credential && app.options.credential.projectId))) || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || null;
    return { db: admin.firestore(), projectId, FieldPath, Timestamp, GeoPoint, emulator: Boolean(process.env.FIRESTORE_EMULATOR_HOST) };
}

async function main() {
    const { options, errors } = R.parseArgs('backup', process.argv.slice(2));
    if (options.help) { console.log(HELP); return 0; }
    if (errors.length) { console.error(errors.map((e) => `- ${e}`).join('\n')); console.error('\nRun with --help for the options.'); return 2; }
    const c = connect();
    const vaultDir = options.noVault ? null : path.resolve(process.env.VAULT_DIR || path.join(__dirname, '..', '..', 'kylrxaisuite-vault'));
    const outRoot = path.resolve(options.out);
    if (vaultDir && (outRoot === vaultDir || outRoot.startsWith(vaultDir + path.sep))) { console.error('- --out cannot be inside the vault folder'); return 2; }
    console.log(`Backing up project ${c.projectId || '(unknown)'}${c.emulator ? ' (emulator)' : ''}...`);
    const { dir, manifest } = await runBackup({ db: c.db, documentId: c.FieldPath.documentId(), outRoot, vaultDir, projectId: c.projectId, pageSize: options.pageSize, only: options.only || [], exclude: options.exclude || [], noVault: Boolean(options.noVault), log: (m) => console.log(`  ${m}`) });
    console.log(`Done: ${manifest.totals.documents} documents in ${manifest.totals.collections} files${manifest.vault.included ? `, ${manifest.totals.vaultFiles} vault files` : ', vault not included'}.`);
    console.log(`Folder: ${dir}`);
    console.log('Reminder: sign-in accounts and the encryption key are not in this backup (see docs/BACKUP.md).');
    return 0;
}

if (require.main === module) {
    main().then((code) => process.exit(code)).catch((e) => { console.error(`Backup failed: ${e.message}`); process.exit(1); });
}

module.exports = { backupDatabase, copyVault, runBackup, fileFacts, walk, connect, DEFAULT_PAGE };
