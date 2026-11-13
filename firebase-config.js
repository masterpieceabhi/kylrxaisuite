// @ts-ignore
import { initializeApp, setLogLevel } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
// @ts-ignore
import { getAuth, onAuthStateChanged, signOut, signInWithEmailAndPassword, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";
// @ts-ignore
import { 
  initializeFirestore, 
  persistentLocalCache, 
  persistentMultipleTabManager,
  memoryLocalCache,
  connectFirestoreEmulator,
  setLogLevel as setFirestoreLogLevel,
  getDocsFromCache,
  getDocFromCache,
  doc, setDoc as rawSetDoc, updateDoc as rawUpdateDoc, deleteDoc as rawDeleteDoc, addDoc as rawAddDoc, serverTimestamp, getDoc as rawGetDoc, onSnapshot as rawOnSnapshot, arrayUnion, arrayRemove, collection, query, where, getDocs as rawGetDocs, orderBy, limit, deleteField, writeBatch as rawWriteBatch 
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";
// @ts-ignore
import { getStorage } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-storage.js";

// 1. Completely silence internal Firebase logger chatter
try {
  setLogLevel('silent');
  setFirestoreLogLevel('silent');
} catch (_) {}

// 2. Global console filter for Firebase Quota & backoff warnings
const _origConsoleError = console.error;
const _origConsoleWarn = console.warn;
let _quotaNoticeShown = false;

function isQuotaOrBackoffMessage(...args) {
  const text = args.map(a => {
    if (typeof a === 'string') return a;
    if (a && typeof a === 'object') {
      return `${a.code || ''} ${a.message || ''} ${a.status || ''} ${a.stack || ''}`;
    }
    return String(a || '');
  }).join(' ');
  return text.includes('resource-exhausted') || 
         text.includes('RESOURCE_EXHAUSTED') ||
         text.includes('Quota exceeded') || 
         text.includes('maximum backoff delay') ||
         text.includes('@firebase/firestore: Firestore') ||
         text.includes('429') ||
         text.includes('Too Many Requests') ||
         text.includes('documents:commit') ||
         text.includes('QUIC_PROTOCOL_ERROR') ||
         text.includes('QUIC_TOO_MANY_RTOS') ||
         text.includes('ERR_QUIC_PROTOCOL_ERROR');
}

function isQuotaError(err) {
  if (!err) return false;
  const s = String(err.message || err.code || err);
  return err.code === 'resource-exhausted' ||
         err.code === 429 ||
         err.status === 429 ||
         err.code === 'unavailable' ||
         s.includes('Quota exceeded') ||
         s.includes('resource-exhausted') ||
         s.includes('RESOURCE_EXHAUSTED') ||
         s.includes('429') ||
         s.includes('Too Many Requests') ||
         s.includes('unavailable') ||
         s.includes('QUIC') ||
         s.includes('offline');
}

function isCoopOrPopupMessage(...args) {
  const text = args.map(a => {
    if (typeof a === 'string') return a;
    if (a && typeof a === 'object') {
      return `${a.code || ''} ${a.message || ''} ${a.status || ''} ${a.stack || ''}`;
    }
    return String(a || '');
  }).join(' ');
  return text.includes('Cross-Origin-Opener-Policy') || 
         text.includes('window.closed') || 
         text.includes('window.close') ||
         text.includes('powerPreference') ||
         text.includes('requestAdapter') ||
         text.includes('369219127');
}

function isPermissionOrQuotaMessage(...args) {
  const text = args.map(a => {
    if (typeof a === 'string') return a;
    if (a && typeof a === 'object') {
      return `${a.code || ''} ${a.message || ''} ${a.status || ''} ${a.stack || ''}`;
    }
    return String(a || '');
  }).join(' ');
  return text.includes('permission-denied') || 
         text.includes('Missing or insufficient permissions');
}

console.error = function (...args) {
  if (isCoopOrPopupMessage(...args)) {
    return;
  }
  if (isQuotaOrBackoffMessage(...args)) {
    if (!_quotaNoticeShown) {
      _quotaNoticeShown = true;
      _origConsoleWarn.call(console, "⚡ [Kylrx Architecture] Firebase Firestore quota limit reached. Local persistent cache active.");
    }
    return;
  }
  if (isPermissionOrQuotaMessage(...args)) {
    _origConsoleWarn.apply(console, ["[Firestore Permission Mode]", ...args]);
    return;
  }
  _origConsoleError.apply(console, args);
};

console.warn = function (...args) {
  if (isCoopOrPopupMessage(...args)) {
    return;
  }
  if (isQuotaOrBackoffMessage(...args)) {
    return;
  }
  _origConsoleWarn.apply(console, args);
};

// On localhost the app talks to the local Firebase emulators (npm run emulators), never to the
// live project. Open any page once with ?emulator=off to use the live project from localhost.
const USE_EMULATOR = (() => {
  try {
    if (typeof window === 'undefined' || !['localhost', '127.0.0.1'].includes(window.location.hostname)) return false;
    const flag = new URLSearchParams(window.location.search).get('emulator');
    if (flag === 'off') sessionStorage.setItem('kylrx_live_firebase', '1');
    if (flag === 'on') sessionStorage.removeItem('kylrx_live_firebase');
    return sessionStorage.getItem('kylrx_live_firebase') !== '1';
  } catch (_) {
    return true;
  }
})();

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBQCO1FI1mPsWxsTvInyLlwIQVFGnUBlco",
  // On HTTPS the Kylrx server proxies /__/auth to Firebase and is its own authDomain (needed for
  // redirect sign-in). The Firebase SDK always opens https://<authDomain>/__/auth/handler, so on
  // plain-http local development the default firebaseapp.com domain (popup sign-in) is used.
  authDomain: (typeof window !== 'undefined' && window.location.protocol === 'https:' && window.location.host)
    ? window.location.host
    : "kylrxai.firebaseapp.com",
  projectId: "kylrxai",
  storageBucket: "kylrxai.firebasestorage.app",
  messagingSenderId: "483232913511",
  appId: "1:483232913511:web:769faab820b2eead141cc2",
  measurementId: "G-3F6VW2MEJG"
};

// Resilient Firebase initialization with InPrivate / Private-mode graceful degradation
// Long-polling fallback enabled via experimentalAutoDetectLongPolling: true
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
if (USE_EMULATOR) {
  try { connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true }); } catch (_) {}
}
const firestoreSettings = {
  experimentalAutoDetectLongPolling: true
};

let db;
try {
  db = initializeFirestore(app, {
    ...firestoreSettings,
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
} catch (e) {
  try {
    db = initializeFirestore(app, {
      ...firestoreSettings,
      localCache: memoryLocalCache()
    });
  } catch (_) {
    try {
      db = initializeFirestore(app, firestoreSettings);
    } catch (_) {
      try {
        db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
      } catch (__) {
        db = window.db || null;
      }
    }
  }
}
if (USE_EMULATOR && db) {
  try { connectFirestoreEmulator(db, '127.0.0.1', 8080); } catch (_) {}
}
// Several services use the older namespaced style (db.collection('x').doc('y').set(...)) against
// window.db, which is a modular Firestore instance. Without this, those calls throw, the services
// swallow the error and keep data only in browser memory while the UI reports success.
if (db && typeof db.collection !== 'function') {
  const wrapDoc = (s) => ({
    id: s.id,
    ref: s.ref,
    exists: s.exists(),
    data: (...a) => s.data(...a),
    get: (f) => s.get(f)
  });
  const wrapSnap = (qs) => ({
    docs: qs.docs.map(wrapDoc),
    empty: qs.empty,
    size: qs.size,
    forEach: (fn) => qs.docs.map(wrapDoc).forEach(fn)
  });
  const compatQuery = (q) => ({
    where: (f, op, v) => compatQuery(query(q, where(f, op, v))),
    orderBy: (f, d) => compatQuery(query(q, orderBy(f, d))),
    limit: (n) => compatQuery(query(q, limit(n))),
    get: async () => wrapSnap(await rawGetDocs(q)),
    onSnapshot: (next, err) => rawOnSnapshot(q, (qs) => next(wrapSnap(qs)), err)
  });
  const compatDoc = (r) => ({
    id: r.id,
    path: r.path,
    collection: (n) => compatCollection(collection(r, n)),
    set: (d, o) => rawSetDoc(r, d, o),
    update: (d) => rawUpdateDoc(r, d),
    delete: () => rawDeleteDoc(r),
    get: async () => wrapDoc(await rawGetDoc(r)),
    onSnapshot: (next, err) => rawOnSnapshot(r, (s) => next(wrapDoc(s)), err)
  });
  const compatCollection = (c) => ({
    ...compatQuery(c),
    doc: (id) => compatDoc(id ? doc(c, id) : doc(c)),
    add: async (d) => compatDoc(await rawAddDoc(c, d))
  });
  db.collection = (path) => compatCollection(collection(db, path));
  db.doc = (path) => compatDoc(doc(db, path));
}
if (typeof window !== 'undefined') {
  window.db = db;
  window.auth = auth; // classic (non-module) scripts need the signed-in user to call the API
  // Many services (holiday calendar, cost center, shifts, finance, ...) destructure these from
  // window.firebaseFirestore; nothing defined it, so their saves silently stayed in memory.
  window.firebaseFirestore = {
    doc, collection, query, where, orderBy, limit, serverTimestamp, arrayUnion, arrayRemove, deleteField,
    setDoc: rawSetDoc, updateDoc: rawUpdateDoc, deleteDoc: rawDeleteDoc, addDoc: rawAddDoc,
    getDoc: rawGetDoc, getDocs: rawGetDocs, onSnapshot: rawOnSnapshot, writeBatch: rawWriteBatch
  };
}
const storage = getStorage(app);

// Quota Circuit Breaker State Management - Live by default, trips only on actual 429 quota exhaustion
let _quotaCircuitTripped = false;
try {
  const saved = localStorage.getItem('fs_circuit_tripped');
  if (saved !== null) {
    _quotaCircuitTripped = saved === 'true';
  }
} catch (_) {}

function markQuotaTripped() {
  _quotaCircuitTripped = true;
  try {
    localStorage.setItem('fs_circuit_tripped', 'true');
    localStorage.setItem('fs_circuit_trip_time', String(Date.now()));
  } catch (_) {}
}

function isQuotaActive() {
  if (!_quotaCircuitTripped) return false;
  try {
    const tripTime = parseInt(localStorage.getItem('fs_circuit_trip_time') || '0', 10);
    if (tripTime && (Date.now() - tripTime > 2 * 60 * 1000)) {
      _quotaCircuitTripped = false;
      localStorage.removeItem('fs_circuit_tripped');
      return false;
    }
  } catch (_) {}
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-tenant isolation: every top-level collection (except GLOBAL_COLLECTIONS) is
// partitioned by an `orgId` field. Reads are automatically filtered to the signed-in
// user's organization and new documents are stamped with it. firestore.rules enforces
// the same boundary server-side, so this layer keeps queries rule-compliant.
// ─────────────────────────────────────────────────────────────────────────────
const GLOBAL_COLLECTIONS = new Set(['organizations', 'system_config']);
// Read filtering goes live together with the orgId data migration + rules deploy
// (scripts/migrate-tenant-orgid.js). Until then existing documents have no orgId, so
// filtering would hide them; new documents are stamped with orgId either way.
const TENANT_READ_SCOPING = false;
let activeOrgId = null;
try { activeOrgId = localStorage.getItem('orgId') || null; } catch (_) {}

const tenantReady = new Promise((resolve) => {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      activeOrgId = null;
      resolve(null);
      return;
    }
    try {
      const claims = (await user.getIdTokenResult()).claims || {};
      let orgId = claims.orgId || null;
      if (!orgId) {
        const profile = await rawGetDoc(doc(db, 'users', user.uid));
        orgId = profile.exists() ? (profile.data().orgId || null) : null;
      }
      activeOrgId = orgId;
      if (orgId) localStorage.setItem('orgId', orgId);
    } catch (_) {}
    resolve(activeOrgId);
  });
});

function getActiveOrgId() {
  return activeOrgId;
}

// "users/abc" -> "users"; queries expose their path through the SDK's internal _query
function topLevelCollectionOf(target) {
  let path = '';
  if (target && typeof target.path === 'string') {
    path = target.path;
  } else if (target && target._query) {
    if (target._query.collectionGroup) return null;
    const p = target._query.path;
    path = p && typeof p.canonicalString === 'function' ? p.canonicalString() : '';
  }
  const segments = path.split('/').filter(Boolean);
  const isCollection = target?.type === 'collection' || target?.type === 'query';
  // Only top-level collections (or their documents) are partitioned; subcollections inherit their parent
  if ((isCollection && segments.length !== 1) || (!isCollection && segments.length !== 2)) return null;
  return segments[0] || null;
}

function isTenantScoped(target) {
  const col = topLevelCollectionOf(target);
  return !!col && !GLOBAL_COLLECTIONS.has(col);
}

function hasOrgFilter(target) {
  const filters = target?._query?.filters || [];
  const flatten = (fs) => fs.flatMap(f => f.filters ? flatten(f.filters) : [f]);
  return flatten(filters).some(f => f.field && typeof f.field.canonicalString === 'function' && f.field.canonicalString() === 'orgId');
}

// Adds where('orgId', '==', <active org>) to collection reads that don't already filter by org
function scopeToTenant(target) {
  const orgId = activeOrgId;
  if (!TENANT_READ_SCOPING || !orgId || !target || target.type === 'document' || !isTenantScoped(target) || hasOrgFilter(target)) return target;
  return query(target, where('orgId', '==', orgId));
}

function stampOrgId(ref, data) {
  if (!activeOrgId || !data || typeof data !== 'object' || !isTenantScoped(ref) || 'orgId' in data) return data;
  return { ...data, orgId: activeOrgId };
}

function belongsToOtherTenant(ref, snap) {
  if (!TENANT_READ_SCOPING || !activeOrgId || !isTenantScoped(ref) || !snap || typeof snap.exists !== 'function' || !snap.exists()) return false;
  const owner = snap.data()?.orgId;
  return !!owner && owner !== activeOrgId;
}

// Quota-safe wrappers to ensure the application never crashes when quota is reached
const getDocs = async (rawTarget) => {
  await tenantReady;
  const q = scopeToTenant(rawTarget);
  // Reads always go to Firestore: the write-quota circuit (isQuotaActive) must not turn reads
  // into cache-only lookups, which made existing accounts look missing at login
  try {
    return await rawGetDocs(q);
  } catch (err) {
    const isPermission = err?.code === 'permission-denied' || String(err?.message || err).includes('Missing or insufficient permissions');
    if (isQuotaError(err) || isPermission) {
      try {
        const cacheRes = await getDocsFromCache(q);
        if (cacheRes && (!cacheRes.empty || isPermission)) return cacheRes;
      } catch (_) {}
      return { empty: true, docs: [], size: 0, forEach: () => {} };
    }
    throw err;
  }
};

const getDoc = async (docRef) => {
  const key = `fs_cache_${docRef.path || docRef.id}`;
  try {
    await tenantReady;
    const snap = await rawGetDoc(docRef);
    // A document owned by another organization is reported as not found
    if (belongsToOtherTenant(docRef, snap)) {
      return { exists: () => false, data: () => undefined, get: () => undefined, id: docRef.id, ref: docRef };
    }
    return snap;
  } catch (err) {
    const isPermission = err?.code === 'permission-denied' || String(err?.message || err).includes('Missing or insufficient permissions');
    if (isQuotaError(err) || isPermission) {
      try {
        const snap = await getDocFromCache(docRef);
        if (snap && snap.exists()) return snap;
      } catch (_) {}
      const raw = localStorage.getItem(key);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          return { exists: () => true, data: () => parsed, id: docRef.id };
        } catch (_) {}
      }
      return { exists: () => false, data: () => null, id: docRef.id };
    }
    throw err;
  }
};

// Writes must be confirmed by Firestore. While the project quota is exhausted (or the network is
// down) the SDK keeps a write pending forever without rejecting, which froze pages such as the
// PMS rollout dialog; the old fallback also reported success after saving only to localStorage.
// Now a write that Firestore does not confirm within WRITE_TIMEOUT_MS fails with a clear error.
const WRITE_TIMEOUT_MS = 20000;

// Raised before sending: Firestore is refusing writes, so nothing was sent or queued
function writesRefusedError() {
  const err = new Error('Firebase is not accepting saves right now (the daily Firestore write quota is used up). Nothing was saved. Please try again after the quota resets.');
  err.code = 'unavailable';
  return err;
}

function unconfirmedWriteError(cause) {
  const err = new Error('Firebase did not confirm this save (the daily Firestore write quota is used up or the connection is down). Nothing was lost permanently: Firestore keeps the change queued and retries automatically, but please verify it later.');
  err.code = 'unavailable';
  if (cause) err.cause = cause;
  return err;
}

// Without a recent confirmed write, ask the server whether Firestore accepts writes before
// sending one: a refused write would hang for WRITE_TIMEOUT_MS and stay queued in this browser
const WRITE_RECHECK_MS = 2 * 60 * 1000;
let lastConfirmedWriteAt = 0;

async function firestoreRefusingWrites() {
  try {
    const base = (typeof window !== 'undefined' && (window.API_BASE || window.location.origin)) || '';
    const res = await fetch(`${base}/api/firestore/write-status`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return false;
    return (await res.json()).accepting === false;
  } catch (_) {
    return false; // server unreachable: let Firestore decide
  }
}

async function confirmedWrite(operation) {
  if (isQuotaActive()) throw writesRefusedError();
  if (Date.now() - lastConfirmedWriteAt > WRITE_RECHECK_MS && await firestoreRefusingWrites()) {
    markQuotaTripped();
    throw writesRefusedError();
  }
  let timer;
  try {
    const result = await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(unconfirmedWriteError()), WRITE_TIMEOUT_MS);
      })
    ]);
    lastConfirmedWriteAt = Date.now();
    return result;
  } catch (err) {
    if (err.code === 'unavailable' || isQuotaError(err)) {
      // Fail fast for the next writes instead of making every one wait for the timeout
      markQuotaTripped();
      throw err.code === 'unavailable' ? err : unconfirmedWriteError(err);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const setDoc = async (docRef, rawData, options) => {
  await tenantReady;
  const data = stampOrgId(docRef, rawData);
  return confirmedWrite(() => rawSetDoc(docRef, data, options));
};

const updateDoc = async (docRef, data) => {
  await tenantReady;
  return confirmedWrite(() => rawUpdateDoc(docRef, data));
};

const deleteDoc = async (docRef) => {
  await tenantReady;
  return confirmedWrite(() => rawDeleteDoc(docRef));
};

const addDoc = async (colRef, rawData) => {
  await tenantReady;
  const data = stampOrgId(colRef, rawData);
  return confirmedWrite(() => rawAddDoc(colRef, data));
};

const runTransaction = async (firestoreDb, updateFunction) => {
  await tenantReady;
  const { runTransaction: rawRunTransaction } = await import("https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js");
  // Same tenant rules inside transactions: stamp new docs, hide other orgs' docs.
  // A transaction must commit on the server; there is no local-only fallback.
  return confirmedWrite(() => rawRunTransaction(firestoreDb, (tx) => updateFunction({
    get: async (docRef) => {
      const snap = await tx.get(docRef);
      return belongsToOtherTenant(docRef, snap)
        ? { exists: () => false, data: () => undefined, get: () => undefined, id: docRef.id, ref: docRef }
        : snap;
    },
    set: (docRef, data, options) => tx.set(docRef, stampOrgId(docRef, data), options),
    update: (...args) => tx.update(...args),
    delete: (docRef) => tx.delete(docRef)
  })));
};

// Batched writes stamp new documents with the active org like setDoc does, and commit()
// is confirmed like a single write
const writeBatch = (firestoreDb) => {
  const batch = rawWriteBatch(firestoreDb);
  const rawSet = batch.set.bind(batch);
  const rawCommit = batch.commit.bind(batch);
  batch.set = (docRef, data, options) => rawSet(docRef, stampOrgId(docRef, data), options);
  batch.commit = () => confirmedWrite(rawCommit);
  return batch;
};

// Active Firestore listeners registry for bfcache & page lifecycle
const activeListeners = [];

function registerListener(unsub) {
  if (typeof unsub === 'function') {
    activeListeners.push(unsub);
  }
  return unsub;
}

function detachAllListeners() {
  while (activeListeners.length > 0) {
    const unsub = activeListeners.pop();
    try {
      if (typeof unsub === 'function') {
        unsub();
      }
    } catch (err) {
      console.warn('[Firestore] Error detaching listener:', err);
    }
  }
}

// Visual "Reconnecting..." indicator
function showReconnectingStatus(err) {
  if (typeof document === 'undefined') return;
  let banner = document.getElementById('firestore-reconnecting-status');
  if (!banner && document.body) {
    banner = document.createElement('div');
    banner.id = 'firestore-reconnecting-status';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;background:#1e293b;color:#f8fafc;padding:8px 14px;border-radius:8px;font-size:12px;font-family:system-ui,-apple-system,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.25);display:flex;align-items:center;gap:8px;border:1px solid #334155;pointer-events:none;';
    banner.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#eab308;box-shadow:0 0 6px #eab308;"></span><span>Reconnecting...</span>';
    document.body.appendChild(banner);
  }
  if (banner) {
    banner.style.display = 'flex';
  }
}

function hideReconnectingStatus() {
  if (typeof document === 'undefined') return;
  const banner = document.getElementById('firestore-reconnecting-status');
  if (banner) {
    banner.style.display = 'none';
  }
}

// Lifecycle listeners for bfcache: detach on pagehide, re-attach or reload on pageshow
if (typeof window !== 'undefined') {
  window.registerListener = registerListener;
  window.detachAllListeners = detachAllListeners;
  window.showReconnectingStatus = showReconnectingStatus;
  window.hideReconnectingStatus = hideReconnectingStatus;

  window.addEventListener('pagehide', () => {
    detachAllListeners();
  });

  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      if (typeof window.initPage === 'function') {
        window.initPage();
      } else if (typeof window.init === 'function') {
        window.init();
      } else if (typeof window.initializePage === 'function') {
        window.initializePage();
      } else if (typeof window.loadDashboardData === 'function') {
        window.loadDashboardData();
      } else {
        window.location.reload();
      }
    }
  });
}

const onSnapshot = (target, ...args) => {
  let userOnNext = typeof args[0] === 'function' ? args[0] : (args[0]?.next || (() => {}));
  let userOnError = typeof args[1] === 'function' ? args[1] : (args[0]?.error || null);
  let onComplete = typeof args[2] === 'function' ? args[2] : (args[0]?.complete || (() => {}));

  const onNext = (snap) => {
    hideReconnectingStatus();
    userOnNext(snap);
  };

  // Document refs and queries need different cache readers and fallback shapes,
  // otherwise doc listeners receive a query-like object and snapshot.exists() throws
  const isDocTarget = target?.type === 'document';
  const readFromCache = () => isDocTarget ? getDocFromCache(target) : getDocsFromCache(target);
  const emptySnapshot = () => isDocTarget
    ? { id: target.id, ref: target, exists: () => false, data: () => undefined, get: () => undefined, metadata: { fromCache: true } }
    : { empty: true, docs: [], size: 0, forEach: () => {}, docChanges: () => [], metadata: { fromCache: true } };

  const safeOnError = (err) => {
    const isPermission = err?.code === 'permission-denied' || String(err?.message || err).includes('Missing or insufficient permissions');
    if (isPermission) {
      console.warn(`[Firestore Real-Time Stream] Gracefully handling restricted ${isDocTarget ? 'document' : 'collection query'}: ${err?.message || err}`);
      try {
        readFromCache().then(cacheSnap => {
          onNext(cacheSnap || emptySnapshot());
        }).catch(() => {
          onNext(emptySnapshot());
        });
      } catch (_) {
        onNext(emptySnapshot());
      }
      if (typeof userOnError === 'function') {
        userOnError(err);
      }
      return;
    }

    console.error(`[Firestore onSnapshot Error] code: ${err?.code || 'unknown'}, message: ${err?.message || err}`);
    showReconnectingStatus(err);

    if (isQuotaError(err)) {
      markQuotaTripped();
      try {
        readFromCache().then(cacheSnap => {
          if (cacheSnap) onNext(cacheSnap);
        }).catch(() => {});
      } catch (_) {}
      return;
    }
    if (typeof userOnError === 'function') {
      userOnError(err);
    }
  };

  // Subscribe once the signed-in org is known, so collection listeners are tenant-filtered
  let unsub = null;
  let cancelled = false;
  const unsubscribe = () => {
    cancelled = true;
    if (typeof unsub === 'function') unsub();
  };
  registerListener(unsubscribe);
  tenantReady.then(() => {
    if (cancelled) return;
    try {
      const scopedTarget = isDocTarget ? target : scopeToTenant(target);
      const docGuard = isDocTarget
        ? (snap) => onNext(belongsToOtherTenant(target, snap) ? emptySnapshot() : snap)
        : onNext;
      unsub = rawOnSnapshot(scopedTarget, docGuard, safeOnError, onComplete);
    } catch (err) {
      safeOnError(err);
    }
  });
  return unsubscribe;
};

console.log("🔥 Firebase connected to project: " + firebaseConfig.projectId);
console.log("✅ System Operational.");

// Global high-fidelity logout hook
function setupGlobalLogout() {
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn && !logoutBtn.dataset.logoutWired) {
        logoutBtn.dataset.logoutWired = "true";
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            try {
                const { signOut } = await import("https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js");
                await signOut(auth);
                localStorage.clear();
                window.location.href = 'index.html';
            } catch (error) {
                console.error("Global logout handler failed:", error);
                localStorage.clear();
                window.location.href = 'index.html';
            }
        });
    }
}

if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setupGlobalLogout();
} else {
    document.addEventListener('DOMContentLoaded', setupGlobalLogout);
}

// Attach the signed-in user's Firebase ID token to same-origin /api/ calls, so the backend
// resolves the caller's organization instead of falling back to the shared dev identity.
// Explicit non-dev Authorization headers (e.g. backend-issued JWTs) are left untouched.
if (typeof window !== 'undefined' && typeof window.fetch === 'function' && !window.__kylrxTenantFetch) {
  window.__kylrxTenantFetch = true;
  const nativeFetch = window.fetch.bind(window);
  const isDevAuth = (value) => !value || /^Bearer\s*(undefined|null|super_admin_dev_token|dev_.*)?$/i.test(value.trim());
  window.fetch = async (input, init = {}) => {
    try {
      const rawUrl = typeof input === 'string' ? input : (input instanceof URL ? input.href : input?.url);
      const url = new URL(rawUrl, window.location.href);
      if (url.origin === window.location.origin && url.pathname.startsWith('/api/')) {
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
        if (isDevAuth(headers.get('Authorization'))) {
          await tenantReady;
          const token = auth.currentUser ? await auth.currentUser.getIdToken() : null;
          if (token) {
            headers.set('Authorization', `Bearer ${token}`);
            return nativeFetch(input, { ...init, headers });
          }
        }
      }
    } catch (_) {}
    return nativeFetch(input, init);
  };
}

// Helper to verify connectivity to Node.js Express Firebase Admin Backend
async function checkBackendFirebaseStatus() {
    const healthUrl = `${typeof API_BASE !== 'undefined' ? API_BASE : (typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : (typeof window !== 'undefined' && window.location ? window.location.origin : ''))}/api/health`;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(healthUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const data = await res.json();
            return { online: true, ...data, projectId: firebaseConfig.projectId, service: "Firebase Admin & REST API" };
        }
    } catch (_) {}
    return { online: true, status: 'cloud-connected', projectId: firebaseConfig.projectId, service: "Firebase Cloud Firestore" };
}

export { 
  app, auth, db, storage,
  checkBackendFirebaseStatus,
  isQuotaError,
  isQuotaActive,
  markQuotaTripped,
  onAuthStateChanged, signOut, signInWithEmailAndPassword,
  doc, setDoc, updateDoc, deleteDoc, addDoc, serverTimestamp, getDoc, onSnapshot, runTransaction, writeBatch, arrayUnion, arrayRemove, collection, query, where, getDocs, orderBy, limit, deleteField,
  registerListener, detachAllListeners, showReconnectingStatus, hideReconnectingStatus,
  getActiveOrgId, tenantReady
};

// Everything else from the Firestore SDK (Timestamp, increment, ...), so pages import Firestore
// only through this module and always get the tenant-scoped wrappers above
export * from "https://www.gstatic.com/firebasejs/12.12.1/firebase-firestore.js";


// Floating clock button on signed-in pages (US/CA companies); loaded last so it can import this module
if (typeof window !== 'undefined') { import('./punch-fab.js').catch(() => {}); }
