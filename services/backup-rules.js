/**
 * Backup and restore: the pure parts (no database, no files).
 *   - encodeValue / decodeValue   Firestore values <-> JSON without losing a type (Timestamp, GeoPoint, reference, bytes,
 *                                 NaN / Infinity / -0, whole numbers too big for JSON, vectors), so a restore is exact.
 *   - encodeLine / decodeLine     one document per line: {"p": "<full document path>", "d": <encoded fields>}
 *   - collectionKey / fileNameFor one file per collection; documents of a subcollection go to "<parent>__<sub>.jsonl"
 *   - buildManifest / verifyManifest   counts and SHA-256 of every file
 *   - parseArgs / restoreDecision      the command-line rules of scripts/backup.js and scripts/restore.js
 * The scripts never read or print configuration values; nothing here knows about environment variables.
 */
const crypto = require('crypto');

const FORMAT = 'kylrx-backup';
const VERSION = 1;
const TAG = '__t';

const isPlain = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** What kind of special Firestore value is this? (duck-typed so the Admin SDK is not needed here) */
function specialKind(v) {
    if (v === null || typeof v !== 'object') return null;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return 'bytes';
    if (v instanceof Date) return 'date';
    if (isPlain(v) || Array.isArray(v)) return null;
    if (typeof v.seconds === 'number' && typeof v.nanoseconds === 'number' && typeof v.toDate === 'function') return 'ts';
    if (typeof v.latitude === 'number' && typeof v.longitude === 'number') return 'geo';
    if (typeof v.path === 'string' && typeof v.id === 'string' && (typeof v.collection === 'function' || v.firestore !== undefined)) return 'ref';
    if (typeof v.toArray === 'function') return 'vec';
    return 'unknown';
}

/** Firestore value -> JSON-safe value. Throws on a value it cannot keep exactly (better than a silent loss). */
function encodeValue(v, where = '') {
    if (v === undefined) return undefined;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') {
        if (Number.isNaN(v)) return { [TAG]: 'num', v: 'NaN' };
        if (v === Infinity) return { [TAG]: 'num', v: 'Infinity' };
        if (v === -Infinity) return { [TAG]: 'num', v: '-Infinity' };
        if (Object.is(v, -0)) return { [TAG]: 'num', v: '-0' };
        return v;
    }
    if (typeof v === 'bigint') return { [TAG]: 'int', v: v.toString() };
    if (Array.isArray(v)) return v.map((x, i) => { const e = encodeValue(x, `${where}[${i}]`); return e === undefined ? null : e; });
    switch (specialKind(v)) {
        case 'ts': return { [TAG]: 'ts', s: v.seconds, n: v.nanoseconds };
        case 'date': return { [TAG]: 'ts', s: Math.floor(v.getTime() / 1000), n: (((v.getTime() % 1000) + 1000) % 1000) * 1e6 };
        case 'geo': return { [TAG]: 'geo', lat: v.latitude, lng: v.longitude };
        case 'ref': return { [TAG]: 'ref', path: v.path };
        case 'bytes': return { [TAG]: 'bytes', b64: Buffer.from(v).toString('base64') };
        case 'vec': return { [TAG]: 'vec', v: v.toArray() };
        case 'unknown': throw new Error(`cannot back up the value at ${where || '(root)'}: unsupported type ${v.constructor ? v.constructor.name : typeof v}`);
        default: {
            const out = {};
            for (const [k, x] of Object.entries(v)) { const e = encodeValue(x, where ? `${where}.${k}` : k); if (e !== undefined) out[k] = e; }
            // a real map that happens to have our tag as a key is wrapped so it is never mistaken for a special value
            return Object.prototype.hasOwnProperty.call(v, TAG) ? { [TAG]: 'map', v: out } : out;
        }
    }
}

/**
 * The reverse. `make` builds the SDK objects: { timestamp(seconds, nanos), geoPoint(lat, lng), reference(path), bytes(buffer), vector(numbers) }.
 * Without `make`, plain stand-ins are returned (used by dry runs and tests).
 */
function decodeValue(v, make = {}) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map((x) => decodeValue(x, make));
    if (!Object.prototype.hasOwnProperty.call(v, TAG)) { const out = {}; for (const [k, x] of Object.entries(v)) out[k] = decodeValue(x, make); return out; }
    switch (v[TAG]) {
        case 'ts': return make.timestamp ? make.timestamp(v.s, v.n) : { seconds: v.s, nanoseconds: v.n };
        case 'geo': return make.geoPoint ? make.geoPoint(v.lat, v.lng) : { latitude: v.lat, longitude: v.lng };
        case 'ref': return make.reference ? make.reference(v.path) : { path: v.path };
        case 'bytes': { const buf = Buffer.from(v.b64, 'base64'); return make.bytes ? make.bytes(buf) : buf; }
        case 'vec': return make.vector ? make.vector(v.v) : v.v;
        case 'int': return make.integer ? make.integer(v.v) : BigInt(v.v);
        case 'num': return v.v === 'NaN' ? NaN : v.v === 'Infinity' ? Infinity : v.v === '-Infinity' ? -Infinity : -0;
        case 'map': { const out = {}; for (const [k, x] of Object.entries(v.v)) out[k] = decodeValue(x, make); return out; }
        default: throw new Error(`backup file uses an unknown value type "${v[TAG]}" (made by a newer version?)`);
    }
}

/** One document as one line of text (no trailing newline) */
function encodeLine(docPath, data) {
    if (!isDocumentPath(docPath)) throw new Error(`not a document path: ${docPath}`);
    return JSON.stringify({ p: docPath, d: encodeValue(data || {}, docPath) });
}

function decodeLine(line, make) {
    let o;
    try { o = JSON.parse(line); } catch (_) { throw new Error('a line in the backup file is not valid JSON'); }
    if (!o || typeof o.p !== 'string' || !isDocumentPath(o.p) || !isPlain(o.d)) throw new Error('a line in the backup file is not a document');
    return { path: o.p, data: decodeValue(o.d, make) };
}

const segments = (p) => String(p).split('/');
const isDocumentPath = (p) => { const s = segments(p); return s.length >= 2 && s.length % 2 === 0 && s.every((x) => x.length > 0); };

/** "organizations/org1/audit_logs/a1" -> "organizations__audit_logs" (the collection names without the document ids) */
function collectionKey(docPath) {
    if (!isDocumentPath(docPath)) throw new Error(`not a document path: ${docPath}`);
    return segments(docPath).filter((_, i) => i % 2 === 0).join('__');
}

/** A file name that is safe on every system, and different for different keys */
function fileNameFor(key) {
    const safe = String(key).replace(/[^A-Za-z0-9_-]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
    if (!safe || safe.length > 180) throw new Error(`collection name cannot be used as a file name: ${key}`);
    return `${safe}.jsonl`;
}

const sha256Hex = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** collections: [{ key, file, documents, bytes, sha256 }]; vault: { included, files: [{ path, bytes, sha256 }] } */
function buildManifest({ createdAt, projectId, collections, vault, note }) {
    const cols = [...(collections || [])].sort((a, b) => a.key.localeCompare(b.key));
    const vfiles = vault && vault.included ? [...vault.files].sort((a, b) => a.path.localeCompare(b.path)) : [];
    return {
        format: FORMAT, version: VERSION, createdAt, projectId: projectId || null,
        collections: cols.map((c) => ({ key: c.key, file: c.file, documents: c.documents, bytes: c.bytes, sha256: c.sha256 })),
        vault: { included: Boolean(vault && vault.included), files: vfiles.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })) },
        totals: { collections: cols.length, documents: cols.reduce((n, c) => n + c.documents, 0), vaultFiles: vfiles.length, bytes: cols.reduce((n, c) => n + c.bytes, 0) + vfiles.reduce((n, f) => n + f.bytes, 0) },
        notes: [
            'Firestore documents only. Sign-in accounts (Firebase Authentication) are not in this backup: export them with "firebase auth:export".',
            'Encrypted fields stay encrypted. They can only be read with the same PII_ENCRYPTION_KEY, which is never part of a backup: keep it somewhere else, safely.',
            ...(note ? [String(note)] : [])
        ]
    };
}

const HEX64 = /^[0-9a-f]{64}$/;
const safeRelative = (p) => typeof p === 'string' && p.length > 0 && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split(/[\\/]/).some((s) => s === '..' || s === '');

/** Is the manifest itself well formed? Returns a list of problems. */
function checkManifest(m) {
    const problems = [];
    if (!m || typeof m !== 'object') return ['the manifest is missing or unreadable'];
    if (m.format !== FORMAT) problems.push('this folder is not a Kylrx backup (wrong format in manifest.json)');
    if (m.version !== VERSION) problems.push(`backup version ${m.version} is not supported by this script (it reads version ${VERSION})`);
    if (!Array.isArray(m.collections)) { problems.push('the manifest has no collection list'); return problems; }
    const seen = new Set();
    for (const c of m.collections) {
        if (!c || typeof c.key !== 'string' || typeof c.file !== 'string') { problems.push('a collection entry in the manifest is incomplete'); continue; }
        if (seen.has(c.file)) problems.push(`${c.file} is listed twice`); seen.add(c.file);
        if (c.file !== fileNameFor(c.key)) problems.push(`${c.key}: unexpected file name ${c.file}`);
        if (!Number.isInteger(c.documents) || c.documents < 0) problems.push(`${c.key}: document count is not valid`);
        if (!HEX64.test(String(c.sha256))) problems.push(`${c.key}: checksum is not valid`);
    }
    for (const f of (m.vault && m.vault.files) || []) {
        if (!f || !safeRelative(f.path)) problems.push(`vault file path is not safe: ${f && f.path}`);
        else if (!HEX64.test(String(f.sha256))) problems.push(`vault file ${f.path}: checksum is not valid`);
    }
    return problems;
}

/**
 * Compares the manifest with what is really in the folder.
 *   actual = { collections: [{ file, documents, bytes, sha256 }], vault: [{ path, bytes, sha256 }] }
 * Returns { ok, problems }.
 */
function verifyManifest(manifest, actual) {
    const problems = checkManifest(manifest);
    if (problems.length) return { ok: false, problems };
    const have = new Map(((actual && actual.collections) || []).map((f) => [f.file, f]));
    for (const c of manifest.collections) {
        const f = have.get(c.file);
        if (!f) { problems.push(`${c.file} is missing`); continue; }
        if (f.sha256 !== c.sha256) problems.push(`${c.file} has changed since the backup was made (checksum differs)`);
        else if (f.documents !== c.documents) problems.push(`${c.file} has ${f.documents} documents, the manifest says ${c.documents}`);
        have.delete(c.file);
    }
    for (const extra of have.keys()) problems.push(`${extra} is in the folder but not in the manifest`);
    if (manifest.vault && manifest.vault.included) {
        const vault = new Map(((actual && actual.vault) || []).map((f) => [f.path, f]));
        for (const f of manifest.vault.files) {
            const a = vault.get(f.path);
            if (!a) problems.push(`vault file ${f.path} is missing`);
            else if (a.sha256 !== f.sha256) problems.push(`vault file ${f.path} has changed since the backup was made`);
            vault.delete(f.path);
        }
        for (const extra of vault.keys()) problems.push(`vault file ${extra} is in the folder but not in the manifest`);
    }
    return { ok: problems.length === 0, problems };
}

/** Which collection files a restore will read, after --only / --exclude (matched on the top-level collection name) */
function selectCollections(manifest, { only = [], exclude = [] } = {}) {
    const root = (key) => key.split('__')[0];
    return manifest.collections.filter((c) => (!only.length || only.includes(root(c.key))) && !exclude.includes(root(c.key)));
}

/** May the restore write? { allowed, reason } */
function restoreDecision({ dryRun, targetEmpty, force, verified }) {
    if (!verified) return { allowed: false, reason: 'The backup did not pass its checks, so nothing was written.' };
    if (dryRun) return { allowed: false, reason: 'Dry run: nothing was written.' };
    if (!targetEmpty && !force) return { allowed: false, reason: 'The target database already has data. Nothing was written. Use --force only if you mean to write over it.' };
    return { allowed: true, reason: targetEmpty ? 'The target database is empty.' : 'The target database has data and --force was given: documents in the backup replace documents with the same path; other documents are left alone.' };
}

const FLAGS = {
    backup: { '--out': 'value', '--page-size': 'value', '--exclude': 'list', '--only': 'list', '--no-vault': 'flag', '--help': 'flag' },
    restore: { '--from': 'value', '--project': 'value', '--only': 'list', '--exclude': 'list', '--vault-dir': 'value', '--no-vault': 'flag', '--force': 'flag', '--dry-run': 'flag', '--help': 'flag' }
};

/** Command-line arguments -> { options, errors }. Unknown flags are errors, so a typo never becomes a default. */
function parseArgs(kind, argv) {
    const spec = FLAGS[kind]; const options = {}; const errors = [];
    if (!spec) throw new Error(`unknown command ${kind}`);
    const name = (flag) => flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    for (let i = 0; i < argv.length; i++) {
        const [flag, inline] = String(argv[i]).split(/=(.*)/s);
        const type = spec[flag];
        if (!type) { errors.push(`unknown option ${argv[i]}`); continue; }
        if (type === 'flag') { if (inline !== undefined) errors.push(`${flag} takes no value`); options[name(flag)] = true; continue; }
        const value = inline !== undefined ? inline : argv[++i];
        if (value === undefined || value === '' || String(value).startsWith('--')) { errors.push(`${flag} needs a value`); if (value !== undefined && inline === undefined) i--; continue; }
        if (type === 'list') options[name(flag)] = [...(options[name(flag)] || []), ...String(value).split(',').map((s) => s.trim()).filter(Boolean)];
        else options[name(flag)] = String(value);
    }
    if (options.help) return { options, errors: [] };
    if (kind === 'backup') {
        if (!options.out) errors.push('--out <folder> is required');
        if (options.pageSize !== undefined) { const n = Number(options.pageSize); if (!Number.isInteger(n) || n < 1 || n > 1000) errors.push('--page-size must be a whole number from 1 to 1000'); else options.pageSize = n; }
    } else {
        if (!options.from) errors.push('--from <backup folder> is required');
        if (!options.project) errors.push('--project <target project id> is required, so a restore never goes to the wrong project by accident');
    }
    if (options.only && options.exclude) errors.push('use --only or --exclude, not both');
    return { options, errors };
}

/** Folder name for a new backup: backup-20261112-141500Z */
const stampFor = (iso) => `backup-${String(iso).slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}Z`;

module.exports = {
    FORMAT, VERSION, TAG, specialKind, encodeValue, decodeValue, encodeLine, decodeLine, isDocumentPath, collectionKey, fileNameFor, sha256Hex,
    buildManifest, checkManifest, verifyManifest, selectCollections, restoreDecision, parseArgs, stampFor, safeRelative
};
