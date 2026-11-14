// The built-in stand-in database (config/firebase.js, used when no Firebase key and no emulator is set) applies
// FieldValue markers the way the real database does, and the password migration really removes tempPassword
// (scripts/migrate-plaintext-passwords.js) or reports an error: it never leaves it behind silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// make sure this process gets the stand-in store, whatever the shell has set
for (const k of ['FIREBASE_SERVICE_ACCOUNT', 'FIREBASE_SERVICE_ACCOUNT_PATH', 'FIRESTORE_EMULATOR_HOST']) process.env[k] = '';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { db, admin } = require('../config/firebase.js');
const { migratePlaintextPasswords } = require('../scripts/migrate-plaintext-passwords.js');

const fakeBcrypt = { hash: async (raw) => `$2b$fake$${Buffer.from(String(raw)).toString('hex')}` };
const read = async (col, id) => (await db.collection(col).doc(id).get()).data();
let n = 0; const fresh = () => `t_${Date.now()}_${++n}`;

test('this is the stand-in store (no Firebase app)', () => {
    assert.equal(admin.apps.length, 0);
    assert.equal(typeof db.collection('x').doc('y').update, 'function');
});

test('update(): delete removes the field; the other markers are applied, not stored as objects', async () => {
    const id = fresh();
    await db.collection('standin_t').doc(id).set({ name: 'Ada', tempPassword: 'Secret#1', count: 2, tags: ['a'], nested: { keep: 1, drop: 2 } });
    await db.collection('standin_t').doc(id).update({ tempPassword: FieldValue.delete(), count: FieldValue.increment(3), tags: FieldValue.arrayUnion('b', 'a'), seenAt: FieldValue.serverTimestamp(), 'nested.drop': FieldValue.delete(), 'nested.added': FieldValue.increment(1) });
    const d = await read('standin_t', id);
    assert.equal('tempPassword' in d, false, 'the field is gone, not set to an object');
    assert.equal(d.count, 5); assert.deepEqual(d.tags, ['a', 'b']);
    assert.ok(d.seenAt instanceof Timestamp, 'a real timestamp'); assert.ok(Math.abs(d.seenAt.toMillis() - Date.now()) < 60000);
    assert.deepEqual(d.nested, { keep: 1, added: 1 });
    assert.equal(d.name, 'Ada'); assert.equal(d.id, id);
    await db.collection('standin_t').doc(id).update({ tags: FieldValue.arrayRemove('a'), missing: FieldValue.delete(), 'no.such.path': FieldValue.delete() });
    const e = await read('standin_t', id);
    assert.deepEqual(e.tags, ['b']); assert.equal('missing' in e, false); assert.equal('no' in e, false, 'deleting a path that is not there creates nothing');
    assert.equal(JSON.stringify(e).includes('Transform'), false);
});

test('set() and add(): markers are applied too', async () => {
    const id = fresh();
    await db.collection('standin_t').doc(id).set({ a: 1, gone: FieldValue.delete(), at: FieldValue.serverTimestamp(), n: FieldValue.increment(2), inner: { x: FieldValue.delete(), y: 1 } });
    let d = await read('standin_t', id);
    assert.deepEqual(Object.keys(d).sort(), ['a', 'at', 'id', 'inner', 'n']); assert.equal(d.n, 2); assert.deepEqual(d.inner, { y: 1 }); assert.ok(d.at instanceof Timestamp);
    await db.collection('standin_t').doc(id).set({ a: FieldValue.delete(), n: FieldValue.increment(5), list: FieldValue.arrayUnion({ k: 1 }) }, { merge: true });
    d = await read('standin_t', id);
    assert.equal('a' in d, false); assert.equal(d.n, 7); assert.deepEqual(d.list, [{ k: 1 }]);
    const added = await db.collection('standin_t').add({ createdAt: FieldValue.serverTimestamp(), temp: FieldValue.delete(), v: 1 });
    d = await read('standin_t', added.id);
    assert.ok(d.createdAt instanceof Timestamp); assert.equal('temp' in d, false); assert.equal(d.v, 1);
});

test('data without markers is stored exactly as before', async () => {
    const id = fresh();
    const inner = { a: 1 };
    await db.collection('standin_t').doc(id).set({ inner, when: '2026-11-12', 'dotted.key': 1 });
    await db.collection('standin_t').doc(id).update({ 'other.key': 2, plain: { b: 2 } });
    const d = await read('standin_t', id);
    assert.deepEqual(d, { inner: { a: 1 }, when: '2026-11-12', 'dotted.key': 1, 'other.key': 2, plain: { b: 2 }, id });
    await db.collection('standin_t').doc(id).set({ only: true });
    assert.deepEqual(await read('standin_t', id), { only: true, id });
});

/* ------------------------------------------- the migration ------------------------------------------- */

/** A tiny users store whose update() can be told to ignore the delete marker, as the stand-in used to */
function fakeUsers(rows, { honourDelete }) {
    const store = new Map(Object.entries(rows).map(([id, d]) => [id, { ...d }]));
    const ref = (id) => ({
        async update(patch) {
            const cur = store.get(id);
            for (const [k, v] of Object.entries(patch)) {
                if (v && typeof v === 'object' && v.constructor && v.constructor.name === 'DeleteTransform') { if (honourDelete) delete cur[k]; else cur[k] = { marker: 'kept by mistake' }; } else cur[k] = v;
            }
        },
        async get() { return { data: () => ({ ...store.get(id) }) }; }
    });
    return { store, db: { collection: () => ({ async get() { const docs = [...store.entries()].map(([id, d]) => ({ id, data: () => ({ ...d }), ref: ref(id) })); return { size: docs.length, docs }; }, doc: ref }) } };
}
const USERS = () => ({
    plain: { email: 'p@x.test', password: 'Plain#123' },
    temp: { email: 't@x.test', tempPassword: 'Temp#12345' },
    stale: { email: 's@x.test', password: '$2b$10$alreadyhashedalreadyhashedalready', tempPassword: '' }, // an emptied leftover field: only cleaned up
    done: { email: 'd@x.test', password: '$2b$10$alreadyhashedalreadyhashedalready' }
});

test('migration: tempPassword is removed even when the admin object gives no FieldValue', async () => {
    for (const adminLike of [{}, { firestore: () => ({}) }, null, { firestore: { FieldValue } }]) {
        const f = fakeUsers(USERS(), { honourDelete: true });
        const out = await migratePlaintextPasswords({ db: f.db, admin: adminLike, bcrypt: fakeBcrypt, saltRounds: 4 });
        assert.equal(out.success, true, JSON.stringify(out.errors)); assert.equal(out.migratedCount, 3); assert.equal(out.alreadyHashedCount, 1);
        for (const [id, d] of f.store) assert.equal('tempPassword' in d, false, `${id} still has tempPassword`);
        assert.ok(f.store.get('temp').password.startsWith('$2')); assert.equal(f.store.get('temp').mustResetPassword, true);
        assert.ok(f.store.get('plain').password.startsWith('$2'));
        assert.equal(f.store.get('stale').password, USERS().stale.password, 'an already hashed password is left alone');
        assert.equal(JSON.stringify([...f.store.values()]).includes('Temp#12345'), false, 'no plaintext left anywhere');
    }
});

test('migration: a database that does not remove the field is reported as an error, not counted as done', async () => {
    const f = fakeUsers(USERS(), { honourDelete: false });
    const out = await migratePlaintextPasswords({ db: f.db, admin: { firestore: { FieldValue } }, bcrypt: fakeBcrypt, saltRounds: 4 });
    assert.equal(out.success, false);
    assert.deepEqual(out.errors.map((e) => e.id).sort(), ['stale', 'temp']);
    assert.match(out.errors[0].error, /tempPassword is still stored/);
    assert.equal(out.migratedCount, 1, 'only the user without a tempPassword counts as migrated');
});

test('migration on the stand-in store: the plaintext temporary password is gone afterwards', async () => {
    const a = fresh(); const b = fresh();
    await db.collection('users').doc(a).set({ email: `${a}@x.test`, tempPassword: 'Temp#12345' });
    await db.collection('users').doc(b).set({ email: `${b}@x.test`, password: '$2b$10$alreadyhashedalreadyhashedalready', tempPassword: '' });
    const out = await migratePlaintextPasswords({ db, admin, bcrypt: fakeBcrypt, saltRounds: 4 });
    assert.deepEqual(out.errors, []); assert.equal(out.success, true);
    for (const id of [a, b]) { const d = await read('users', id); assert.equal('tempPassword' in d, false, id); assert.ok(d.password.startsWith('$2')); }
    assert.equal((await read('users', a)).mustResetPassword, true);
    const all = (await db.collection('users').get()).docs.map((d) => d.data());
    assert.equal(all.some((u) => 'tempPassword' in u), false);
});
