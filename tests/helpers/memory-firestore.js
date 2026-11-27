/**
 * In-memory stand-in for the Firebase Admin Firestore + Auth, for tests that exercise real services and
 * routes without the emulator. Not a mock of the code under test: it is a small database with the
 * same calls the app uses (collection/doc/where/orderBy/limit/startAfter, set with merge, update with
 * dotted paths, create, delete, subcollections, transactions, batches, listCollections/listDocuments).
 *
 *   const mem = require('./helpers/memory-firestore.js');
 *   const { db, auth } = mem.install();      // must run BEFORE the first require of anything that loads config/firebase
 *   mem.reset();                             // empty database between tests
 */
const path = require('path');
const crypto = require('crypto');
const { Timestamp, GeoPoint, FieldValue, FieldPath } = require('firebase-admin/firestore');

const isPlain = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const sentinel = (v) => (v && typeof v === 'object' && !isPlain(v) && !Array.isArray(v) ? v.constructor.name : null);

/** Deep copy of plain data; class instances (Timestamp, GeoPoint, Buffer, references) are kept as they are */
function clone(v) {
    if (Array.isArray(v)) return v.map(clone);
    if (v instanceof Date) return Timestamp.fromDate(v);
    if (isPlain(v)) { const o = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = clone(x); return o; }
    return v;
}

function applyTransform(cur, v) {
    switch (sentinel(v)) {
        case 'ServerTimestampTransform': return { value: Timestamp.now() };
        case 'DeleteTransform': return { remove: true };
        case 'NumericIncrementTransform': return { value: (Number(cur) || 0) + v.operand };
        case 'ArrayUnionTransform': { const a = Array.isArray(cur) ? cur.slice() : []; for (const e of v.elements) if (!a.some((x) => JSON.stringify(x) === JSON.stringify(e))) a.push(e); return { value: a }; }
        case 'ArrayRemoveTransform': return { value: (Array.isArray(cur) ? cur : []).filter((x) => !v.elements.some((e) => JSON.stringify(x) === JSON.stringify(e))) };
        default: return null;
    }
}

/** Deep merge like set(..., { merge: true }) */
function mergeInto(target, src) {
    for (const [k, v] of Object.entries(src)) {
        if (v === undefined) continue;
        const t = applyTransform(target[k], v);
        if (t) { if (t.remove) delete target[k]; else target[k] = t.value; continue; }
        if (isPlain(v)) { if (!isPlain(target[k])) target[k] = {}; mergeInto(target[k], v); } else target[k] = clone(v);
    }
    return target;
}

function resolveWrite(v, cur) {
    const t = applyTransform(cur, v);
    if (t) return t;
    if (isPlain(v)) { const o = {}; for (const [k, x] of Object.entries(v)) { if (x === undefined) continue; const r = resolveWrite(x, undefined); if (!r.remove) o[k] = r.value; } return { value: o }; }
    return { value: clone(v) };
}

function setPath(obj, dotted, v) {
    const parts = String(dotted).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (!isPlain(cur[parts[i]])) cur[parts[i]] = {}; cur = cur[parts[i]]; }
    const last = parts[parts.length - 1];
    const r = resolveWrite(v, cur[last]);
    if (r.remove) delete cur[last]; else cur[last] = r.value;
}

const getPath = (obj, dotted) => String(dotted).split('.').reduce((c, p) => (c === undefined || c === null ? undefined : c[p]), obj);
const fieldName = (f) => (f instanceof FieldPath ? (f.isEqual(FieldPath.documentId()) ? '__name__' : f.toString()) : String(f));

function compare(a, b) {
    const n = (x) => (x instanceof Timestamp ? x.toMillis() : x);
    const x = n(a); const y = n(b);
    if (x === y) return 0;
    if (x === undefined || x === null) return -1;
    if (y === undefined || y === null) return 1;
    return x < y ? -1 : 1;
}

/** A class (not a plain object) so stored references are told apart from maps, as with the real SDK */
class MemoryDocumentReference {}

function createDb() {
    /** collection path -> Map(docId -> data) */
    const store = new Map();
    const colMap = (p, make) => { if (!store.has(p) && make) store.set(p, new Map()); return store.get(p); };
    let autoN = 0;
    const autoId = () => `${Date.now().toString(36)}${(++autoN).toString(36).padStart(4, '0')}${crypto.randomBytes(6).toString('hex')}`.slice(0, 20);

    const snapshot = (ref, data) => ({
        id: ref.id, ref, exists: data !== undefined,
        data: () => (data === undefined ? undefined : clone(data)),
        get: (f) => (data === undefined ? undefined : clone(getPath(data, fieldName(f)))),
        createTime: data === undefined ? undefined : Timestamp.now(), updateTime: data === undefined ? undefined : Timestamp.now()
    });

    function docRef(colPath, id) {
        const ref = Object.assign(new MemoryDocumentReference(), {
            id: String(id), path: `${colPath}/${id}`,
            firestore: null,
            async get() { const m = colMap(colPath); return snapshot(ref, m ? m.get(ref.id) : undefined); },
            async set(data, opts = {}) {
                const m = colMap(colPath, true);
                if (opts && opts.merge && m.has(ref.id)) m.set(ref.id, mergeInto(clone(m.get(ref.id)), data));
                else m.set(ref.id, mergeInto({}, data));
                return { writeTime: Timestamp.now() };
            },
            async create(data) {
                const m = colMap(colPath, true);
                if (m.has(ref.id)) { const e = new Error(`6 ALREADY_EXISTS: Document already exists: ${ref.path}`); e.code = 6; throw e; }
                m.set(ref.id, mergeInto({}, data));
                return { writeTime: Timestamp.now() };
            },
            async update(data, ...rest) {
                const m = colMap(colPath);
                if (!m || !m.has(ref.id)) { const e = new Error(`5 NOT_FOUND: No document to update: ${ref.path}`); e.code = 5; throw e; }
                const cur = clone(m.get(ref.id));
                const pairs = typeof data === 'string' || data instanceof FieldPath ? [[data, rest[0]], ...Array.from({ length: (rest.length - 1) / 2 }, (_, i) => [rest[1 + i * 2], rest[2 + i * 2]])] : Object.entries(data);
                for (const [k, v] of pairs) { if (v !== undefined) setPath(cur, fieldName(k), v); }
                m.set(ref.id, cur);
                return { writeTime: Timestamp.now() };
            },
            async delete() { const m = colMap(colPath); if (m) m.delete(ref.id); return { writeTime: Timestamp.now() }; },
            collection(name) { return collection(`${ref.path}/${name}`); },
            async listCollections() {
                const prefix = `${ref.path}/`;
                return [...store.keys()].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/') && store.get(p).size).sort().map((p) => collection(p));
            },
            isEqual(o) { return Boolean(o && o.path === ref.path); }
        });
        Object.defineProperty(ref, 'parent', { get: () => collection(colPath) });
        Object.defineProperty(ref, 'firestore', { value: db, enumerable: false });
        return ref;
    }

    function query(colPath, st) {
        const run = () => {
            const m = colMap(colPath);
            let rows = m ? [...m.entries()].map(([id, data]) => ({ id, data })) : [];
            for (const f of st.filters) {
                rows = rows.filter(({ id, data }) => {
                    const v = f.field === '__name__' ? id : getPath(data, f.field);
                    const target = f.field === '__name__' && f.val && f.val.id ? f.val.id : f.val;
                    switch (f.op) {
                        case '==': return v !== undefined && compare(v, target) === 0 && (typeof v === typeof target || v instanceof Timestamp);
                        case '!=': return v !== undefined && v !== null && compare(v, target) !== 0;
                        case '<': return v !== undefined && v !== null && compare(v, target) < 0;
                        case '<=': return v !== undefined && v !== null && compare(v, target) <= 0;
                        case '>': return v !== undefined && v !== null && compare(v, target) > 0;
                        case '>=': return v !== undefined && v !== null && compare(v, target) >= 0;
                        case 'in': return Array.isArray(target) && target.some((t) => compare(v, t) === 0);
                        case 'not-in': return v !== undefined && v !== null && Array.isArray(target) && !target.some((t) => compare(v, t) === 0);
                        case 'array-contains': return Array.isArray(v) && v.some((x) => JSON.stringify(x) === JSON.stringify(target));
                        case 'array-contains-any': return Array.isArray(v) && Array.isArray(target) && v.some((x) => target.some((t) => JSON.stringify(x) === JSON.stringify(t)));
                        default: throw new Error(`memory-firestore: unsupported operator ${f.op}`);
                    }
                });
            }
            const orders = st.orders.length ? st.orders : [{ field: '__name__', dir: 'asc' }];
            for (const o of orders) if (o.field !== '__name__') rows = rows.filter((r) => getPath(r.data, o.field) !== undefined);
            const key = (r, o) => (o.field === '__name__' ? r.id : getPath(r.data, o.field));
            rows.sort((a, b) => { for (const o of orders) { const c = compare(key(a, o), key(b, o)); if (c) return o.dir === 'desc' ? -c : c; } return compare(a.id, b.id); });
            if (st.after) {
                const vals = st.after.values;
                const cmpRow = (r) => { for (let i = 0; i < vals.length && i < orders.length; i++) { const c = compare(key(r, orders[i]), vals[i]); if (c) return orders[i].dir === 'desc' ? -c : c; } return 0; };
                rows = rows.filter((r) => (st.after.inclusive ? cmpRow(r) >= 0 : cmpRow(r) > 0));
            }
            if (st.offset) rows = rows.slice(st.offset);
            if (typeof st.limit === 'number') rows = rows.slice(0, st.limit);
            return rows;
        };
        const cursor = (args, inclusive) => {
            const first = args[0];
            const orders = st.orders.length ? st.orders : [{ field: '__name__', dir: 'asc' }];
            const values = first && typeof first === 'object' && first.ref && typeof first.data === 'function'
                ? orders.map((o) => (o.field === '__name__' ? first.id : first.get(o.field)))
                : args.map((a) => (a && a.id && a.path ? a.id : a));
            return query(colPath, { ...st, after: { values, inclusive } });
        };
        return {
            where(field, op, val) { return query(colPath, { ...st, filters: [...st.filters, { field: fieldName(field), op, val }] }); },
            orderBy(field, dir = 'asc') { return query(colPath, { ...st, orders: [...st.orders, { field: fieldName(field), dir }] }); },
            limit(n) { return query(colPath, { ...st, limit: n }); },
            offset(n) { return query(colPath, { ...st, offset: n }); },
            startAfter(...a) { return cursor(a, false); },
            startAt(...a) { return cursor(a, true); },
            select() { return this; },
            count() { return { get: async () => ({ data: () => ({ count: run().length }) }) }; },
            async get() {
                const docs = run().map((r) => snapshot(docRef(colPath, r.id), r.data));
                return { docs, empty: docs.length === 0, size: docs.length, forEach: (cb) => docs.forEach(cb) };
            }
        };
    }

    function collection(colPath) {
        const p = String(colPath).replace(/^\/+|\/+$/g, '');
        const q = query(p, { filters: [], orders: [], limit: null, offset: 0, after: null });
        return {
            ...q, id: p.split('/').pop(), path: p,
            doc(id) { return docRef(p, id === undefined ? autoId() : id); },
            async add(data) { const ref = docRef(p, autoId()); await ref.set(data); return ref; },
            async listDocuments() {
                const ids = new Set(colMap(p) ? colMap(p).keys() : []);
                const prefix = `${p}/`;
                for (const k of store.keys()) if (k.startsWith(prefix) && store.get(k).size) ids.add(k.slice(prefix.length).split('/')[0]); // parents that hold only subcollections
                return [...ids].sort().map((id) => docRef(p, id));
            }
        };
    }

    const writer = (ops) => ({
        set(ref, data, opts) { ops.push(() => ref.set(data, opts)); return this; },
        create(ref, data) { ops.push(() => ref.create(data)); return this; },
        update(ref, data, ...rest) { ops.push(() => ref.update(data, ...rest)); return this; },
        delete(ref) { ops.push(() => ref.delete()); return this; }
    });

    const db = {
        collection,
        doc(p) { const parts = String(p).split('/'); return docRef(parts.slice(0, -1).join('/'), parts[parts.length - 1]); },
        async getAll(...refs) { return Promise.all(refs.filter((r) => r && typeof r.get === 'function').map((r) => r.get())); },
        // like the real service: a top-level collection is listed when it, or anything nested under it, holds a document
        async listCollections() { return [...new Set([...store.keys()].filter((p) => store.get(p).size).map((p) => p.split('/')[0]))].sort().map((p) => collection(p)); },
        batch() { const ops = []; return { ...writer(ops), async commit() { for (const op of ops) await op(); return []; } }; },
        async runTransaction(fn) {
            const ops = [];
            const tx = { ...writer(ops), get: (refOrQuery) => refOrQuery.get(), getAll: (...refs) => Promise.all(refs.map((r) => r.get())) };
            const out = await fn(tx);
            for (const op of ops) await op();
            return out;
        },
        settings() {},
        /** test helpers */
        _store: store,
        _reset() { store.clear(); },
        _dump() { const o = {}; for (const [p, m] of [...store.entries()].sort()) if (m.size) o[p] = Object.fromEntries([...m.entries()].sort()); return o; }
    };
    return db;
}

function createAuth() {
    const users = new Map(); let n = 0;
    const notFound = () => { const e = new Error('There is no user record corresponding to the provided identifier.'); e.code = 'auth/user-not-found'; return e; };
    return {
        _users: users,
        _reset() { users.clear(); },
        async createUser(p) {
            const email = String(p.email || '').toLowerCase();
            if (email && [...users.values()].some((u) => u.email === email)) { const e = new Error('The email address is already in use by another account.'); e.code = 'auth/email-already-exists'; throw e; }
            const uid = p.uid || `uid_${++n}_${crypto.randomBytes(4).toString('hex')}`;
            const rec = { uid, email, displayName: p.displayName || null, disabled: Boolean(p.disabled), customClaims: {} };
            users.set(uid, rec);
            return { ...rec };
        },
        async getUser(uid) { if (!users.has(uid)) throw notFound(); return { ...users.get(uid) }; },
        async getUserByEmail(email) { const u = [...users.values()].find((x) => x.email === String(email).toLowerCase()); if (!u) throw notFound(); return { ...u }; },
        async updateUser(uid, patch) { if (!users.has(uid)) throw notFound(); const u = users.get(uid); for (const k of ['email', 'displayName', 'disabled']) if (patch[k] !== undefined) u[k] = k === 'email' ? String(patch[k]).toLowerCase() : patch[k]; return { ...u }; },
        async setCustomUserClaims(uid, claims) { if (!users.has(uid)) throw notFound(); users.get(uid).customClaims = claims || {}; },
        async deleteUser(uid) { users.delete(uid); },
        async revokeRefreshTokens() {},
        async verifyIdToken() { const e = new Error('memory-firestore: no ID tokens in tests'); e.code = 'auth/argument-error'; throw e; }
    };
}

let installed = null;

/** Replaces config/firebase in the require cache with the in-memory database. Call before loading app code. */
function install() {
    if (installed) return installed;
    const db = createDb(); const auth = createAuth();
    const firestoreFn = Object.assign(() => db, { Timestamp, GeoPoint, FieldValue, FieldPath });
    const admin = { apps: [{}], firestore: firestoreFn, auth: () => auth, messaging: () => ({ send: async () => ({}) }) };
    const file = require.resolve(path.join(__dirname, '..', '..', 'config', 'firebase.js'));
    const exportsObj = { admin, db, messaging: { send: async () => ({}) }, rawCollection: (name) => db.collection(name) };
    require.cache[file] = { id: file, filename: file, loaded: true, exports: exportsObj, children: [], paths: [] };
    installed = { db, auth, admin, reset() { db._reset(); auth._reset(); } };
    return installed;
}

module.exports = { install, createDb, createAuth, clone, MemoryDocumentReference, Timestamp, GeoPoint, FieldValue, FieldPath, reset: () => installed && installed.reset() };
