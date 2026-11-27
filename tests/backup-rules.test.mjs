// US-A09: backup and restore. Pure rules (value encoding, manifest, arguments), then a full round trip:
// in-memory database A -> backup folder on disk -> empty in-memory database B, compared value by value.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../services/backup-rules.js');
const mem = require('./helpers/memory-firestore.js');
const { Timestamp, GeoPoint, FieldPath } = require('firebase-admin/firestore');
const B = require('../scripts/backup.js');
const X = require('../scripts/restore.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kylrx-backup-'));
test.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/* ------------------------------------ values ------------------------------------ */

const make = (db) => ({ timestamp: (s, n) => new Timestamp(s, n), geoPoint: (a, b) => new GeoPoint(a, b), reference: (p) => db.doc(p), bytes: (b) => b, integer: (v) => Number(v) });
const roundTrip = (v, m) => R.decodeValue(JSON.parse(JSON.stringify(R.encodeValue(v))), m);

test('ordinary values pass through unchanged', () => {
    const v = { s: 'text', n: 42, f: 1.5, neg: -7, t: true, f2: false, nil: null, empty: '', list: [1, 'a', null, { x: 1 }, [2]], nested: { a: { b: { c: [] } } }, unicode: 'Ünïcödé ✓', big: Number.MAX_SAFE_INTEGER };
    assert.deepEqual(R.encodeValue(v), v);
    assert.deepEqual(roundTrip(v), v);
    assert.equal(R.encodeValue(undefined), undefined);
    assert.deepEqual(R.encodeValue({ a: 1, gone: undefined }), { a: 1 }, 'undefined fields are dropped, as Firestore does');
});

test('special values survive JSON exactly: timestamps to the nanosecond, locations, bytes, references, odd numbers', () => {
    const db = mem.createDb();
    const ts = new Timestamp(1767225600, 123456789);
    const v = { at: ts, where: new GeoPoint(43.0389, -87.9065), raw: Buffer.from([0, 1, 2, 250, 255]), link: db.doc('users/u1'), deep: db.doc('organizations/o1/audit_logs/a1'),
        nan: NaN, inf: Infinity, ninf: -Infinity, negZero: -0, list: [new Timestamp(1, 0), { at: new Timestamp(2, 5) }], zero: 0 };
    const enc = R.encodeValue(v);
    assert.deepEqual(enc.at, { __t: 'ts', s: 1767225600, n: 123456789 });
    assert.deepEqual(enc.where, { __t: 'geo', lat: 43.0389, lng: -87.9065 });
    assert.deepEqual(enc.raw, { __t: 'bytes', b64: 'AAEC+v8=' });
    assert.deepEqual(enc.link, { __t: 'ref', path: 'users/u1' });
    assert.equal(enc.zero, 0);
    assert.doesNotThrow(() => JSON.stringify(enc));
    const back = roundTrip(v, make(db));
    assert.ok(back.at instanceof Timestamp); assert.ok(back.at.isEqual(ts)); assert.equal(back.at.nanoseconds, 123456789);
    assert.ok(back.where instanceof GeoPoint); assert.ok(back.where.isEqual(v.where));
    assert.ok(Buffer.isBuffer(back.raw)); assert.deepEqual([...back.raw], [0, 1, 2, 250, 255]);
    assert.equal(back.link.path, 'users/u1'); assert.equal(back.deep.path, 'organizations/o1/audit_logs/a1'); assert.equal(typeof back.link.get, 'function');
    assert.ok(Number.isNaN(back.nan)); assert.equal(back.inf, Infinity); assert.equal(back.ninf, -Infinity); assert.ok(Object.is(back.negZero, -0)); assert.ok(Object.is(back.zero, 0));
    assert.ok(back.list[0].isEqual(new Timestamp(1, 0))); assert.ok(back.list[1].at.isEqual(new Timestamp(2, 5)));
    const plain = roundTrip(v);
    assert.deepEqual(plain.at, { seconds: 1767225600, nanoseconds: 123456789 }, 'without the SDK, plain stand-ins come back');
});

test('a JavaScript Date is stored as a timestamp, including dates before 1970', () => {
    const d = new Date('2026-03-09T10:11:12.345Z');
    assert.deepEqual(R.encodeValue(d), { __t: 'ts', s: Math.floor(d.getTime() / 1000), n: 345000000 });
    const old = new Date('1969-12-31T23:59:59.250Z');
    const e = R.encodeValue(old);
    assert.deepEqual(e, { __t: 'ts', s: -1, n: 250000000 });
    assert.equal(new Timestamp(e.s, e.n).toDate().toISOString(), old.toISOString());
});

test('a real map that uses our marker key is not mistaken for a special value', () => {
    const tricky = { __t: 'ts', s: 5, n: 6 };
    const v = { looksSpecial: tricky, nested: { __t: 'whatever', keep: [tricky] } };
    const enc = R.encodeValue(v);
    assert.equal(enc.looksSpecial.__t, 'map');
    assert.deepEqual(roundTrip(v), v);
});

test('values that cannot be kept exactly stop the backup instead of being lost quietly; unknown markers stop a restore', () => {
    class Custom { constructor() { this.x = 1; } }
    assert.throws(() => R.encodeValue({ a: { b: new Custom() } }), /cannot back up the value at a\.b: unsupported type Custom/);
    assert.throws(() => R.decodeValue({ __t: 'hologram' }), /unknown value type "hologram"/);
    assert.equal(R.decodeValue({ __t: 'int', v: '9007199254740993' }), 9007199254740993n);
    assert.equal(R.encodeValue(9007199254740993n).v, '9007199254740993');
});

test('lines: one document per line, with its full path', () => {
    const line = R.encodeLine('users/u1', { name: 'Ada', at: new Timestamp(10, 0), note: 'two\nlines' });
    assert.ok(!line.includes('\n'), 'a line never contains a line break');
    assert.deepEqual(JSON.parse(line), { p: 'users/u1', d: { name: 'Ada', at: { __t: 'ts', s: 10, n: 0 }, note: 'two\nlines' } });
    const doc = R.decodeLine(line, make(mem.createDb()));
    assert.equal(doc.path, 'users/u1'); assert.equal(doc.data.note, 'two\nlines'); assert.ok(doc.data.at.isEqual(new Timestamp(10, 0)));
    assert.throws(() => R.encodeLine('users', {}), /not a document path/);
    assert.throws(() => R.decodeLine('{oops'), /not valid JSON/);
    assert.throws(() => R.decodeLine('{"p":"users","d":{}}'), /not a document/);
    assert.throws(() => R.decodeLine('{"p":"users/u1","d":[1]}'), /not a document/);
    assert.throws(() => R.decodeLine('{"p":"users//u1","d":{}}'), /not a document/);
});

test('file naming: one file per collection, subcollections get their own file, odd names stay safe and distinct', () => {
    assert.equal(R.collectionKey('users/u1'), 'users');
    assert.equal(R.collectionKey('organizations/o1/audit_logs/a1'), 'organizations__audit_logs');
    assert.equal(R.collectionKey('a/1/b/2/c/3'), 'a__b__c');
    assert.throws(() => R.collectionKey('users'), /not a document path/);
    assert.equal(R.fileNameFor('organizations__audit_logs'), 'organizations__audit_logs.jsonl');
    assert.equal(R.fileNameFor('weird name/..'), 'weird%20name%2F%2E%2E.jsonl');
    assert.notEqual(R.fileNameFor('a.b'), R.fileNameFor('a_b'));
    assert.throws(() => R.fileNameFor('x'.repeat(200)), /cannot be used as a file name/);
    assert.equal(R.stampFor('2026-11-12T14:15:00.123Z'), 'backup-20261112-141500Z');
});

/* ------------------------------------ manifest ------------------------------------ */

const sha = (s) => R.sha256Hex(s);
const sampleManifest = () => R.buildManifest({
    createdAt: '2026-03-01T00:00:00.000Z', projectId: 'demo',
    collections: [{ key: 'users', file: 'users.jsonl', documents: 2, bytes: 40, sha256: sha('users') }, { key: 'organizations__audit_logs', file: 'organizations__audit_logs.jsonl', documents: 1, bytes: 20, sha256: sha('logs') }],
    vault: { included: true, files: [{ path: 'orgA/doc1.bin', bytes: 10, sha256: sha('doc1') }] }
});
const sampleActual = () => ({ collections: [{ file: 'users.jsonl', documents: 2, bytes: 40, sha256: sha('users') }, { file: 'organizations__audit_logs.jsonl', documents: 1, bytes: 20, sha256: sha('logs') }], vault: [{ path: 'orgA/doc1.bin', bytes: 10, sha256: sha('doc1') }] });

test('manifest: sorted, totalled, and says plainly what is not in a backup', () => {
    const m = sampleManifest();
    assert.equal(m.format, 'kylrx-backup'); assert.equal(m.version, 1);
    assert.deepEqual(m.collections.map((c) => c.key), ['organizations__audit_logs', 'users']);
    assert.deepEqual(m.totals, { collections: 2, documents: 3, vaultFiles: 1, bytes: 70 });
    assert.ok(m.notes.some((n) => /Sign-in accounts .* are not in this backup/.test(n)));
    assert.ok(m.notes.some((n) => /PII_ENCRYPTION_KEY, which is never part of a backup/.test(n)));
    assert.deepEqual(Object.keys(m).sort(), ['collections', 'createdAt', 'format', 'notes', 'projectId', 'totals', 'vault', 'version'], 'nothing else (no settings, no environment) is written');
    assert.deepEqual(R.verifyManifest(m, sampleActual()), { ok: true, problems: [] });
});

test('verify: a changed, missing, extra or miscounted file is found and named', () => {
    const m = sampleManifest();
    const changed = sampleActual(); changed.collections[0].sha256 = sha('tampered');
    assert.deepEqual(R.verifyManifest(m, changed).problems, ['users.jsonl has changed since the backup was made (checksum differs)']);
    const missing = sampleActual(); missing.collections.pop();
    assert.deepEqual(R.verifyManifest(m, missing).problems, ['organizations__audit_logs.jsonl is missing']);
    const extra = sampleActual(); extra.collections.push({ file: 'planted.jsonl', documents: 1, bytes: 1, sha256: sha('x') });
    assert.deepEqual(R.verifyManifest(m, extra).problems, ['planted.jsonl is in the folder but not in the manifest']);
    const count = sampleActual(); count.collections[0].documents = 3;
    assert.deepEqual(R.verifyManifest(m, count).problems, ['users.jsonl has 3 documents, the manifest says 2']);
    const vault = sampleActual(); vault.vault[0].sha256 = sha('other'); vault.vault.push({ path: 'orgA/new.bin', bytes: 1, sha256: sha('n') });
    assert.deepEqual(R.verifyManifest(m, vault).problems, ['vault file orgA/doc1.bin has changed since the backup was made', 'vault file orgA/new.bin is in the folder but not in the manifest']);
    const noVault = sampleActual(); noVault.vault = [];
    assert.deepEqual(R.verifyManifest(m, noVault).problems, ['vault file orgA/doc1.bin is missing']);
    assert.equal(R.verifyManifest(m, null).ok, false);
});

test('verify: a manifest that is malformed, from another tool, a newer version, or points outside the folder is refused', () => {
    assert.deepEqual(R.checkManifest(null), ['the manifest is missing or unreadable']);
    assert.ok(R.checkManifest({ format: 'other', version: 1, collections: [] })[0].includes('not a Kylrx backup'));
    assert.ok(R.checkManifest({ ...sampleManifest(), version: 2 })[0].includes('version 2 is not supported'));
    assert.ok(R.checkManifest({ format: 'kylrx-backup', version: 1 }).includes('the manifest has no collection list'));
    const m = sampleManifest();
    m.collections[0].file = '../../etc/passwd';
    m.collections.push({ ...m.collections[1] });
    m.collections.push({ key: 'bad', file: 'bad.jsonl', documents: -1, sha256: 'nope' });
    m.vault.files.push({ path: '../outside.bin', bytes: 1, sha256: sha('x') }, { path: 'C:\\Windows\\x', bytes: 1, sha256: sha('x') }, { path: '/abs', bytes: 1, sha256: sha('x') });
    const p = R.checkManifest(m);
    assert.ok(p.some((x) => x.includes('unexpected file name ../../etc/passwd')));
    assert.ok(p.some((x) => x.includes('users.jsonl is listed twice')));
    assert.ok(p.includes('bad: document count is not valid')); assert.ok(p.includes('bad: checksum is not valid'));
    assert.equal(p.filter((x) => x.startsWith('vault file path is not safe')).length, 3);
    assert.equal(R.safeRelative('orgA/sub/file.bin'), true); assert.equal(R.safeRelative('a//b'), false); assert.equal(R.safeRelative(''), false);
});

test('restore decisions: checks first, dry run never writes, a database with data needs --force', () => {
    assert.equal(R.restoreDecision({ verified: false, targetEmpty: true, force: true }).allowed, false);
    assert.equal(R.restoreDecision({ verified: true, dryRun: true, targetEmpty: true }).allowed, false);
    assert.equal(R.restoreDecision({ verified: true, dryRun: true, targetEmpty: false, force: true }).allowed, false);
    assert.deepEqual(R.restoreDecision({ verified: true, targetEmpty: true }), { allowed: true, reason: 'The target database is empty.' });
    const refused = R.restoreDecision({ verified: true, targetEmpty: false });
    assert.equal(refused.allowed, false); assert.match(refused.reason, /already has data\. Nothing was written/);
    const forced = R.restoreDecision({ verified: true, targetEmpty: false, force: true });
    assert.equal(forced.allowed, true); assert.match(forced.reason, /other documents are left alone/);
    const m = sampleManifest();
    assert.deepEqual(R.selectCollections(m, { only: ['organizations'] }).map((c) => c.key), ['organizations__audit_logs']);
    assert.deepEqual(R.selectCollections(m, { exclude: ['organizations'] }).map((c) => c.key), ['users']);
    assert.equal(R.selectCollections(m).length, 2);
});

test('command line: required options, lists, and typos are errors rather than silent defaults', () => {
    assert.deepEqual(R.parseArgs('backup', ['--out', 'D:\\backups']), { options: { out: 'D:\\backups' }, errors: [] });
    assert.deepEqual(R.parseArgs('backup', ['--out=x', '--page-size', '50', '--exclude', 'a,b', '--exclude', 'c', '--no-vault']).options, { out: 'x', pageSize: 50, exclude: ['a', 'b', 'c'], noVault: true });
    assert.deepEqual(R.parseArgs('backup', []).errors, ['--out <folder> is required']);
    assert.deepEqual(R.parseArgs('backup', ['--out', 'x', '--page-size', '0']).errors, ['--page-size must be a whole number from 1 to 1000']);
    assert.deepEqual(R.parseArgs('backup', ['--out', 'x', '--only', 'a', '--exclude', 'b']).errors, ['use --only or --exclude, not both']);
    assert.deepEqual(R.parseArgs('backup', ['--out', 'x', '--force']).errors, ['unknown option --force'], '--force belongs to restore only');
    assert.deepEqual(R.parseArgs('backup', ['--out', '--no-vault']).errors, ['--out needs a value', '--out <folder> is required']);
    assert.deepEqual(R.parseArgs('backup', ['--help']).errors, []);
    const r = R.parseArgs('restore', ['--from', 'b', '--project', 'demo', '--dry-run', '--force', '--vault-dir', 'v']);
    assert.deepEqual(r, { options: { from: 'b', project: 'demo', dryRun: true, force: true, vaultDir: 'v' }, errors: [] });
    const missing = R.parseArgs('restore', ['--dryrun']).errors;
    assert.equal(missing.length, 3); assert.equal(missing[0], 'unknown option --dryrun'); assert.match(missing[2], /--project <target project id> is required/);
    assert.deepEqual(R.parseArgs('restore', ['--from', 'b', '--project', 'p', '--force=yes']).errors, ['--force takes no value']);
    assert.throws(() => R.parseArgs('nope', []), /unknown command/);
});

/* ------------------------------ round trip on real files ------------------------------ */

async function seed(db) {
    await db.collection('organizations').doc('orgA').set({ name: 'Acme Inc', country: 'US', createdAt: new Timestamp(1767225600, 5), settings: { tz: 'America/Chicago', flags: [true, false, null] } });
    await db.collection('organizations').doc('orgA').collection('audit_logs').doc('log1').set({ action: 'person_created', at: '2026-01-01T00:00:00.000Z', actor: db.doc('users/u1') });
    await db.collection('organizations').doc('orgA').collection('counters').doc('employees').set({ currentSequence: 12, padLength: 4 });
    await db.collection('organizations').doc('orgGhost').collection('audit_logs').doc('log9').set({ action: 'orphan_log', n: -0 }); // parent document has no fields of its own
    for (let i = 1; i <= 7; i++) await db.collection('users').doc(`u${i}`).set({ orgId: i < 6 ? 'orgA' : 'orgB', name: `Person ${i}`, email: `p${i}@example.com`, status: 'Active', hours: i * 1.5, updatedAt: new Timestamp(1767225600 + i, i * 1000), usProfile: { managerId: i > 1 ? 'u1' : null, taxpayerIdEncrypted: `v1:cipher${i}` } });
    await db.collection('users').doc('u1').collection('notes').doc('n1').set({ text: 'line one\nline two', pinned: true });
    await db.collection('users').doc('u1').collection('notes').doc('n1').collection('edits').doc('e1').set({ at: new Timestamp(5, 0) });
    await db.collection('sites').doc('hq').set({ location: new GeoPoint(43.0389, -87.9065), photo: Buffer.from('not really a jpeg'), owner: db.doc('organizations/orgA'), ratio: NaN, limit: Infinity, tags: ['a', 'b'], '__t': 'a field that looks like our marker' });
    await db.collection('weird name').doc('doc with spaces & symbols').set({ ok: true, empty: {}, emptyList: [] });
    await db.collection('empty_docs').doc('e1').set({});
}

/** Everything in a database as { path: comparable data } */
async function snapshot(db) {
    const out = {};
    const norm = (v) => JSON.stringify(R.encodeValue(v));
    for (const [colPath, docs] of Object.entries(db._dump())) for (const [id, data] of Object.entries(docs)) out[`${colPath}/${id}`] = norm(data);
    return out;
}

test('round trip: back up database A to disk, restore into empty database B, and every document is identical', async () => {
    const a = mem.createDb(); await seed(a);
    const vaultSrc = path.join(tmp, 'vault-src');
    fs.mkdirSync(path.join(vaultSrc, 'orgA', 'u1'), { recursive: true });
    fs.writeFileSync(path.join(vaultSrc, 'orgA', 'u1', 'w4.pdf.enc'), Buffer.from([1, 2, 3, 4, 5, 250]));
    fs.writeFileSync(path.join(vaultSrc, 'orgA', 'handbook.enc'), 'encrypted handbook bytes');
    const logs = [];
    const { dir, manifest } = await B.runBackup({ db: a, documentId: FieldPath.documentId(), outRoot: path.join(tmp, 'out'), vaultDir: vaultSrc, projectId: 'demo-a', pageSize: 3, now: new Date('2026-03-01T04:05:06Z'), log: (m) => logs.push(m) });
    assert.equal(path.basename(dir), 'backup-20260301-040506Z');
    assert.deepEqual(manifest.collections.map((c) => [c.key, c.documents]), [['empty_docs', 1], ['organizations', 1], ['organizations__audit_logs', 2], ['organizations__counters', 1], ['sites', 1], ['users', 7], ['users__notes', 1], ['users__notes__edits', 1], ['weird name', 1]]);
    assert.equal(manifest.totals.documents, 16); assert.equal(manifest.totals.vaultFiles, 2); assert.equal(manifest.projectId, 'demo-a');
    assert.ok(logs.includes('users: 7 documents'), 'seven users were read in pages of three');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['empty_docs.jsonl', 'manifest.json', 'organizations.jsonl', 'organizations__audit_logs.jsonl', 'organizations__counters.jsonl', 'sites.jsonl', 'users.jsonl', 'users__notes.jsonl', 'users__notes__edits.jsonl', 'vault', 'weird%20name.jsonl']);
    const usersFile = fs.readFileSync(path.join(dir, 'users.jsonl'), 'utf8');
    assert.equal(usersFile.trim().split('\n').length, 7);
    assert.equal(R.sha256Hex(fs.readFileSync(path.join(dir, 'users.jsonl'))), manifest.collections.find((c) => c.key === 'users').sha256);

    const check = await X.verifyBackup(dir);
    assert.deepEqual({ ok: check.ok, problems: check.problems }, { ok: true, problems: [] });

    const b = mem.createDb();
    assert.equal(await X.isEmpty(b), true);
    const vaultDst = path.join(tmp, 'vault-dst');
    const dry = await X.runRestore({ db: b, make: make(b), from: dir, dryRun: true, vaultDir: vaultDst });
    assert.equal(dry.written, false); assert.equal(dry.documents, 16); assert.equal(dry.reason, 'Dry run: nothing was written.');
    assert.equal(await X.isEmpty(b), true, 'a dry run leaves the database empty'); assert.equal(fs.existsSync(vaultDst), false, 'and writes no vault files');

    const done = await X.runRestore({ db: b, make: make(b), from: dir, vaultDir: vaultDst });
    assert.equal(done.written, true); assert.equal(done.documents, 16); assert.equal(done.vault.files, 2);
    assert.deepEqual(await snapshot(b), await snapshot(a), 'every document path and value matches');

    const site = (await b.collection('sites').doc('hq').get()).data();
    assert.ok(site.location instanceof GeoPoint); assert.ok(Buffer.isBuffer(site.photo)); assert.equal(site.photo.toString(), 'not really a jpeg');
    assert.equal(site.owner.path, 'organizations/orgA'); assert.ok(Number.isNaN(site.ratio)); assert.equal(site.limit, Infinity); assert.equal(site.__t, 'a field that looks like our marker');
    const u3 = (await b.collection('users').doc('u3').get()).data();
    assert.ok(u3.updatedAt instanceof Timestamp); assert.ok(u3.updatedAt.isEqual(new Timestamp(1767225603, 3000))); assert.equal(u3.usProfile.taxpayerIdEncrypted, 'v1:cipher3', 'encrypted fields are copied as they are');
    assert.ok(Object.is((await b.doc('organizations/orgGhost/audit_logs/log9').get()).data().n, -0));
    assert.equal((await b.doc('organizations/orgGhost').get()).exists, false, 'a parent that had no fields is not invented');
    assert.equal((await b.doc('users/u1/notes/n1/edits/e1').get()).exists, true);
    assert.deepEqual((await b.doc('empty_docs/e1').get()).data(), {});
    assert.deepEqual([...fs.readFileSync(path.join(vaultDst, 'orgA', 'u1', 'w4.pdf.enc'))], [1, 2, 3, 4, 5, 250]);
    assert.equal(fs.readFileSync(path.join(vaultDst, 'orgA', 'handbook.enc'), 'utf8'), 'encrypted handbook bytes');

    // a second backup, made from the restored copy, has exactly the same files
    const again = await B.runBackup({ db: b, documentId: FieldPath.documentId(), outRoot: path.join(tmp, 'out2'), vaultDir: vaultDst, projectId: 'demo-b', now: new Date('2026-03-02T00:00:00Z') });
    assert.deepEqual(again.manifest.collections, manifest.collections, 'same documents, byte for byte');
    assert.deepEqual(again.manifest.vault, manifest.vault);
});

test('restore refuses a database that already has data unless forced, and a forced restore leaves other documents alone', async () => {
    const a = mem.createDb(); await seed(a);
    const { dir } = await B.runBackup({ db: a, documentId: FieldPath.documentId(), outRoot: path.join(tmp, 'out3'), vaultDir: null, noVault: true, now: new Date('2026-03-03T00:00:00Z') });
    const b = mem.createDb();
    await b.collection('users').doc('u1').set({ name: 'Somebody Else', extra: 'will be replaced' });
    await b.collection('keep').doc('k1').set({ untouched: true });
    const before = JSON.stringify(b._dump());
    const refused = await X.runRestore({ db: b, make: make(b), from: dir });
    assert.equal(refused.written, false); assert.equal(refused.targetEmpty, false); assert.match(refused.reason, /already has data/);
    assert.equal(JSON.stringify(b._dump()), before, 'nothing changed');
    const dry = await X.runRestore({ db: b, make: make(b), from: dir, dryRun: true });
    assert.match(dry.reason, /A real run would be refused/);
    assert.equal(JSON.stringify(b._dump()), before);
    const forced = await X.runRestore({ db: b, make: make(b), from: dir, force: true });
    assert.equal(forced.written, true);
    assert.deepEqual((await b.doc('users/u1').get()).data().name, 'Person 1');
    assert.equal((await b.doc('users/u1').get()).data().extra, undefined, 'a restored document replaces the old one completely');
    assert.deepEqual((await b.doc('keep/k1').get()).data(), { untouched: true });
    const onlyGhost = mem.createDb(); await onlyGhost.doc('organizations/x/audit_logs/y').set({ a: 1 }); await onlyGhost.doc('organizations/x/audit_logs/y').delete();
    assert.equal(await X.isEmpty(onlyGhost), true);
    const sub = mem.createDb(); await sub.doc('organizations/x/audit_logs/y').set({ a: 1 });
    assert.equal(await X.isEmpty(sub), false, 'a database with only nested documents is not empty');
});

test('restore writes nothing when a backup file was changed, is missing, or the manifest is not ours', async () => {
    const a = mem.createDb(); await seed(a);
    const { dir } = await B.runBackup({ db: a, documentId: FieldPath.documentId(), outRoot: path.join(tmp, 'out4'), noVault: true, now: new Date('2026-03-04T00:00:00Z') });
    const users = path.join(dir, 'users.jsonl'); const original = fs.readFileSync(users, 'utf8');
    fs.writeFileSync(users, original.replace('Person 2', 'Person X'));
    const b = mem.createDb();
    const tampered = await X.runRestore({ db: b, make: make(b), from: dir });
    assert.equal(tampered.written, false); assert.equal(tampered.verified, false);
    assert.deepEqual(tampered.problems, ['users.jsonl has changed since the backup was made (checksum differs)']);
    assert.equal(await X.isEmpty(b), true);
    fs.writeFileSync(users, original);
    fs.renameSync(path.join(dir, 'sites.jsonl'), path.join(dir, 'sites.moved'));
    assert.deepEqual((await X.verifyBackup(dir)).problems, ['sites.jsonl is missing']);
    fs.renameSync(path.join(dir, 'sites.moved'), path.join(dir, 'sites.jsonl'));
    fs.writeFileSync(path.join(dir, 'planted.jsonl'), '{"p":"users/evil","d":{"role":"super_admin"}}\n');
    assert.deepEqual((await X.verifyBackup(dir)).problems, ['planted.jsonl is in the folder but not in the manifest']);
    fs.rmSync(path.join(dir, 'planted.jsonl'));
    assert.equal((await X.verifyBackup(dir)).ok, true);
    await assert.rejects(() => X.verifyBackup(tmp), /no manifest\.json/);
});

test('partial backup and restore: --only / --exclude work on top-level collections and their subcollections', async () => {
    const a = mem.createDb(); await seed(a);
    const part = await B.runBackup({ db: a, documentId: FieldPath.documentId(), outRoot: path.join(tmp, 'out5'), noVault: true, exclude: ['users', 'weird name'], now: new Date('2026-03-05T00:00:00Z') });
    assert.deepEqual(part.manifest.collections.map((c) => c.key), ['empty_docs', 'organizations', 'organizations__audit_logs', 'organizations__counters', 'sites']);
    assert.ok(part.manifest.notes.some((n) => /Partial backup/.test(n)));
    const full = await B.runBackup({ db: a, documentId: FieldPath.documentId(), outRoot: path.join(tmp, 'out6'), noVault: true, now: new Date('2026-03-06T00:00:00Z') });
    const b = mem.createDb();
    const r = await X.runRestore({ db: b, make: make(b), from: full.dir, only: ['users'] });
    assert.deepEqual(r.perCollection, { users: 7, users__notes: 1, users__notes__edits: 1 });
    assert.deepEqual(Object.keys(b._dump()), ['users', 'users/u1/notes', 'users/u1/notes/n1/edits']);
});

test('the backup never contains settings or keys, and the scripts never print values', async () => {
    const a = mem.createDb(); await seed(a);
    process.env.BACKUP_TEST_SECRET = 'super-secret-value-123';
    const { dir } = await B.runBackup({ db: a, documentId: FieldPath.documentId(), outRoot: path.join(tmp, 'out7'), noVault: true, now: new Date('2026-03-07T00:00:00Z') });
    for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('super-secret-value-123'), `${f} holds no environment value`);
    delete process.env.BACKUP_TEST_SECRET;
    assert.ok(!fs.readdirSync(dir).some((f) => /env|serviceAccount|\.pem|\.key/i.test(f)));
    for (const script of ['backup.js', 'restore.js']) {
        const src = fs.readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8');
        const printed = [...src.matchAll(/console\.(log|error)\(([^;]*)\);/g)].map((m) => m[2]).join('\n');
        assert.ok(!/process\.env|doc\.data|\.data\(\)|JSON\.stringify\((doc|data|line)/.test(printed), `${script} prints no configuration value and no document content`);
        assert.ok(!/PII_ENCRYPTION_KEY\s*[=\]]|JWT_SECRET|FIREBASE_SERVICE_ACCOUNT/.test(src), `${script} does not read secrets`);
    }
});
