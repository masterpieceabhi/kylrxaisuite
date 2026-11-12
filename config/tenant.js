/**
 * Multi-tenant isolation for the backend (Firebase Admin SDK).
 *
 * Each API request runs inside a tenant context ({ orgId }) resolved from the caller's
 * Firebase ID token (see middleware/tenantContext.js). While a context is active,
 * db.collection(<top-level collection>) is scoped to that organization:
 *   - reads (get / where / orderBy / limit / onSnapshot / count ...) get where('orgId', '==', orgId)
 *   - add() / doc().set() / batch.set() / transaction.set() stamp orgId on new data
 *   - doc().get() reports another organization's document as not found
 * Code running outside a request (startup loaders, schedulers) has no context and is unscoped.
 * The Admin SDK bypasses firestore.rules, so this is the backend's isolation boundary.
 */
const { AsyncLocalStorage } = require('async_hooks');

const tenantStorage = new AsyncLocalStorage();

// Platform-wide collections shared by every organization
const GLOBAL_COLLECTIONS = new Set(['organizations', 'system_config', 'system_configs', 'system_counters']);

// Matches nothing, so a request without an organization reads no tenant data
const NO_ORG = '__no_org__';

// Read filtering goes live with the orgId data migration (scripts/migrate-tenant-orgid.js);
// before that existing documents have no orgId. Stamping new documents is always on.
// On by default in production (set TENANT_READ_SCOPING=off only for a database not yet migrated);
// off by default elsewhere unless TENANT_READ_SCOPING=on
const READ_SCOPING = () => (process.env.NODE_ENV === 'production' ? process.env.TENANT_READ_SCOPING !== 'off' : process.env.TENANT_READ_SCOPING === 'on');

function currentTenant() {
    return tenantStorage.getStore();
}

function runWithTenant(orgId, fn) {
    return tenantStorage.run({ orgId: orgId || null }, fn);
}

function scopedOrgId() {
    const store = currentTenant();
    if (!store) return undefined; // background job: unscoped
    return store.orgId || NO_ORG;
}

function stamp(data) {
    const orgId = scopedOrgId();
    if (!orgId || orgId === NO_ORG || !data || typeof data !== 'object' || 'orgId' in data) return data;
    return { ...data, orgId };
}

function isTopLevelTenantDoc(docRef) {
    const segments = String(docRef && docRef.path || '').split('/');
    return segments.length === 2 && !GLOBAL_COLLECTIONS.has(segments[0]);
}

function otherTenantsDoc(docRef, snap) {
    const orgId = scopedOrgId();
    if (!READ_SCOPING() || !orgId || !isTopLevelTenantDoc(docRef) || !snap || !snap.exists) return false;
    const owner = snap.get('orgId');
    // Untagged documents are hidden from scoped requests too, until they are migrated
    return owner !== orgId;
}

function hiddenSnapshot(snap) {
    return new Proxy(snap, {
        get(target, prop) {
            if (prop === 'exists') return false;
            if (prop === 'data') return () => undefined;
            if (prop === 'get') return () => undefined;
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

const READ_METHODS = new Set([
    'get', 'where', 'orderBy', 'limit', 'limitToLast', 'offset', 'select', 'startAt', 'startAfter',
    'endAt', 'endBefore', 'onSnapshot', 'stream', 'count', 'aggregate', 'findNearest', 'listDocuments'
]);

function wrapDocRef(docRef) {
    if (!isTopLevelTenantDoc(docRef)) return docRef;
    return new Proxy(docRef, {
        get(target, prop) {
            if (prop === 'get') {
                return async (...args) => {
                    const snap = await target.get(...args);
                    return otherTenantsDoc(target, snap) ? hiddenSnapshot(snap) : snap;
                };
            }
            if (prop === 'set') return (data, options) => target.set(stamp(data), options);
            if (prop === 'create') return (data) => target.create(stamp(data));
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

function wrapCollection(colRef) {
    if (GLOBAL_COLLECTIONS.has(colRef.id) || colRef.path.includes('/')) return colRef;
    return new Proxy(colRef, {
        get(target, prop) {
            const orgId = scopedOrgId();
            if (orgId && READ_SCOPING() && READ_METHODS.has(prop)) {
                if (prop === 'listDocuments') return async () => (await target.where('orgId', '==', orgId).get()).docs.map(d => d.ref);
                const scoped = target.where('orgId', '==', orgId);
                return scoped[prop].bind(scoped);
            }
            if (prop === 'add') return (data) => target.add(stamp(data));
            if (prop === 'doc') return (...args) => wrapDocRef(target.doc(...args));
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

/**
 * Patches a Firestore (Admin SDK) instance in place. Returns rawCollection for code that must
 * deliberately read across tenants (e.g. resolving a user's own org during authentication).
 */
function installTenantScoping(db) {
    if (!db || db.__tenantScoped) return db.__rawCollection;
    const rawCollection = db.collection.bind(db);
    const rawBatch = db.batch.bind(db);
    const rawRunTransaction = db.runTransaction.bind(db);

    db.collection = (path) => wrapCollection(rawCollection(path));

    db.batch = () => {
        const batch = rawBatch();
        const set = batch.set.bind(batch);
        const create = batch.create.bind(batch);
        batch.set = (ref, data, options) => set(ref, isTopLevelTenantDoc(ref) ? stamp(data) : data, options);
        batch.create = (ref, data) => create(ref, isTopLevelTenantDoc(ref) ? stamp(data) : data);
        return batch;
    };

    db.runTransaction = (updateFn, options) => rawRunTransaction((tx) => {
        const get = tx.get.bind(tx);
        const set = tx.set.bind(tx);
        const create = tx.create.bind(tx);
        tx.get = async (refOrQuery, ...rest) => {
            const result = await get(refOrQuery, ...rest);
            if (refOrQuery && typeof refOrQuery.path === 'string' && result && typeof result.exists === 'boolean') {
                return otherTenantsDoc(refOrQuery, result) ? hiddenSnapshot(result) : result;
            }
            return result;
        };
        tx.set = (ref, data, opts) => set(ref, isTopLevelTenantDoc(ref) ? stamp(data) : data, opts);
        tx.create = (ref, data) => create(ref, isTopLevelTenantDoc(ref) ? stamp(data) : data);
        return updateFn(tx);
    }, options);

    Object.defineProperty(db, '__tenantScoped', { value: true });
    Object.defineProperty(db, '__rawCollection', { value: rawCollection });
    return rawCollection;
}

// Data created before multi-tenancy has no orgId and belongs to the original organization
const LEGACY_ORG_ID = process.env.DEV_DEFAULT_ORG_ID || 'org_kylrx_ai';

function ownerOrgId(data) {
    return (data && data.orgId) || LEGACY_ORG_ID;
}

/**
 * All documents of a top-level collection owned by orgId (plus untagged legacy documents
 * for the legacy org, until scripts/migrate-tenant-orgid.js has tagged them).
 * `collectionFn` must be an unscoped collection accessor (config/firebase rawCollection).
 */
async function orgDocs(collectionFn, name, orgId, max = 500) {
    const tagged = await collectionFn(name).where('orgId', '==', orgId).limit(max).get();
    let docs = tagged.docs;
    if (orgId === LEGACY_ORG_ID) {
        const all = await collectionFn(name).limit(max).get();
        docs = docs.concat(all.docs.filter(d => !d.get('orgId')));
    }
    return docs.map(d => ({ id: d.id, ...d.data() }));
}

module.exports = {
    LEGACY_ORG_ID,
    ownerOrgId,
    orgDocs,
    tenantStorage,
    currentTenant,
    runWithTenant,
    installTenantScoping,
    GLOBAL_COLLECTIONS
};
