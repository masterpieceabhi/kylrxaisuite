const admin = require("firebase-admin");
require('dotenv').config();

let serviceAccount;
// Set when a key was named in the settings but could not be read. The server must then stop, never carry on without one.
let keyProblem = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Load from Host Environment Variable (Raw JSON or base64 encoded)
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
    if (raw.startsWith('{')) {
      serviceAccount = JSON.parse(raw);
    } else {
      const decoded = Buffer.from(raw, 'base64').toString('utf8');
      serviceAccount = JSON.parse(decoded);
    }
  } catch (error) {
    console.error("Failed to parse FIREBASE_SERVICE_ACCOUNT env var:", error.message);
    keyProblem = "FIREBASE_SERVICE_ACCOUNT is set but is not a readable key (JSON or base64 JSON)";
  }
} else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
  // Load from a key file path (relative paths resolve from the project root)
  try {
    const keyPath = require('path').resolve(__dirname, '..', process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    serviceAccount = require(keyPath);
  } catch (error) {
    console.error("Failed to load FIREBASE_SERVICE_ACCOUNT_PATH key file:", error.message);
    keyProblem = "FIREBASE_SERVICE_ACCOUNT_PATH is set but the key file could not be loaded";
  }
} else {
  // Check optional local file fallback if explicitly present
  try {
    serviceAccount = require("./serviceAccountKey.json");
  } catch (error) {
    // Expected when relying exclusively on host environment variables
  }
}

let db;
let messaging;
let rawCollection = null;

// Local emulator mode (npm run emulators): the Admin SDK talks to the emulators, no key needed
const useEmulator = !serviceAccount && !!process.env.FIRESTORE_EMULATOR_HOST;

if (serviceAccount || useEmulator) {
  if (!admin.apps.length) {
    admin.initializeApp({
      ...(serviceAccount ? { credential: admin.credential.cert(serviceAccount) } : { projectId: process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || 'kylrxai' } /* emulator only: which pretend project to use */),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "kylrxai.firebasestorage.app"
    });
    console.log("Firebase Admin SDK initialized successfully!");
  }
  db = admin.firestore();
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch (_) {}
  // Scope db.collection() to the requesting organization (see config/tenant.js)
  rawCollection = require('./tenant').installTenantScoping(db);
  messaging = admin.messaging();
} else {
  // What follows is a pretend database held in memory, with a pretend sign-in check that accepts ANY token as a
  // super admin. It exists for local work and unit tests. It must never serve real requests, so the server refuses
  // to start with it when a key was configured but is broken (a typo in the setting must not open the door), and
  // whenever this is a production server.
  if (keyProblem) throw new Error(`Firebase is not configured: ${keyProblem}. Fix the key; the server will not start without it.`);
  if (process.env.NODE_ENV === 'production') throw new Error('Firebase is not configured: set FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_PATH. A production server will not start without a database.');
  console.log("Firebase Backend: Active in local connected development mode (kylrxai).");
  
  const _firestoreStore = new Map();

  // FieldValue markers (delete, serverTimestamp, increment, arrayUnion, arrayRemove) are applied as the real database
  // applies them, instead of being stored as objects. Data without any marker is stored exactly as before.
  const markerOf = (v) => (v && typeof v === 'object' && v.constructor && /Transform$/.test(v.constructor.name) ? v.constructor.name : null);
  const isPlainObject = (v) => v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const hasMarker = (v) => Boolean(markerOf(v)) || (isPlainObject(v) && Object.values(v).some(hasMarker));
  const REMOVE = Symbol('remove');
  function applyMarkers(v, cur) {
    switch (markerOf(v)) {
      case 'DeleteTransform': return REMOVE;
      case 'ServerTimestampTransform': return require('firebase-admin/firestore').Timestamp.now();
      case 'NumericIncrementTransform': return (Number(cur) || 0) + Number(v.operand);
      case 'ArrayUnionTransform': { const a = Array.isArray(cur) ? cur.slice() : []; for (const e of v.elements) if (!a.some((x) => sameValue(x, e))) a.push(e); return a; }
      case 'ArrayRemoveTransform': return (Array.isArray(cur) ? cur : []).filter((x) => !v.elements.some((e) => sameValue(x, e)));
      default: break;
    }
    if (isPlainObject(v) && hasMarker(v)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) { const r = applyMarkers(x, isPlainObject(cur) ? cur[k] : undefined); if (r !== REMOVE) out[k] = r; }
      return out;
    }
    return v;
  }
  /** `data` laid over `existing` (as { ...existing, ...data }), with any markers in it applied. dotted: "a.b" keys of update() reach into nested maps for markers. */
  function overlay(existing, data, dotted = false) {
    if (!hasMarker(data)) return { ...existing, ...data };
    const out = { ...existing };
    for (const [k, v] of Object.entries(data || {})) {
      let holder = out; let key = k;
      if (dotted && markerOf(v) && k.includes('.') && !(k in out)) {
        const parts = k.split('.'); key = parts.pop();
        for (const part of parts) {
          if (!isPlainObject(holder[part])) { if (markerOf(v) === 'DeleteTransform') { holder = null; break; } holder[part] = {}; } else holder[part] = { ...holder[part] };
          holder = holder[part];
        }
        if (!holder) continue;
      }
      const r = applyMarkers(v, holder[key]);
      if (r === REMOVE) delete holder[key]; else holder[key] = r;
    }
    return out;
  }

  function getCollectionData(name) {
    if (!_firestoreStore.has(name)) {
      const colMap = new Map();
      _firestoreStore.set(name, colMap);
      
      if (name === 'employees') {
        const departments = ['Engineering', 'Product', 'Sales', 'Customer Success', 'Operations', 'Finance', 'People Ops'];
        const bus = ['Technology', 'Sales & Marketing', 'Operations', 'Finance & HR'];
        const roles = ['Software Engineer', 'Senior Engineer', 'Lead Architect', 'Product Manager', 'Account Executive', 'Operations Lead', 'Financial Analyst', 'HRBP'];
        for (let i = 1; i <= 950; i++) {
          const id = `EMP-${String(i).padStart(4, '0')}`;
          const dept = departments[i % departments.length];
          const bu = dept.includes('Eng') || dept.includes('Prod') ? 'Technology' : (dept.includes('Sales') || dept.includes('Cust') ? 'Sales & Marketing' : (dept.includes('Ops') ? 'Operations' : 'Finance & HR'));
          colMap.set(id, {
            id,
            employeeId: id,
            name: `Employee ${i}`,
            department: dept,
            bu,
            role: roles[i % roles.length],
            status: 'Active',
            headcount: 1,
            hiring: i > 808 ? 1 : 0,
            employeeType: i % 10 === 0 ? 'Contractor' : 'Full Time',
            createdAt: new Date(Date.now() - (950 - i) * 86400000).toISOString()
          });
        }
      } else if (name === 'users') {
        const users = [
          { id: 'usr_superadmin', email: 'superadmin@kylrx.ai', name: 'Rajesh Subramanian', role: 'super_admin', status: 'Active' },
          { id: 'usr_hr_admin', email: 'hr.admin@kylrx.ai', name: 'Swati Khandelwal', role: 'hr_admin', status: 'Active' },
          { id: 'usr_manager', email: 'manager@kylrx.ai', name: 'Kavita Krishnan', role: 'manager', status: 'Active' },
          { id: 'usr_payroll', email: 'payroll@kylrx.ai', name: 'Naveen Jindal', role: 'payroll_admin', status: 'Active' }
        ];
        users.forEach(u => colMap.set(u.id, u));
      } else if (name === 'alerts') {
        const alerts = [
          { id: 'ALT-ATT-301', module: 'Attendance', severity: 'critical', title: '3 Consecutive Absences Breach', employee: 'Priya Sharma (EMP-882)', department: 'Engineering', message: '3 unexcused absences recorded. Escalated to Manager & HR Operations.', timestamp: '15 mins ago' },
          { id: 'ALT-PAY-911', module: 'Payroll', severity: 'critical', title: 'Variance > 10% Anomaly Alert', employee: 'Batch SEP-FINAL', department: 'Finance', message: 'MoM Gross Variance calculated at 12.4% (Threshold: 10%). Pre-disbursement hold applied.', timestamp: '1 hour ago' },
          { id: 'ALT-EXIT-408', module: 'Exit', severity: 'critical', title: 'Exit Clearance Delayed > 48 Hours', employee: 'Ananya Rao (EMP-771)', department: 'Finance & Accounts', message: 'Department clearance inactive for 52 hours. Escalated to Head of HR.', timestamp: '2 hours ago' }
        ];
        alerts.forEach(a => colMap.set(a.id, a));
      } else if (name === 'pending_approvals') {
        const approvals = [
          { id: 'APP-EXIT-801', type: 'Exit Department Clearance', entityId: 'EMP-771', requester: 'Ananya Rao', department: 'Finance & Accounts', submittedAt: '2026-09-09T10:15:00Z', slaHoursRemaining: 18, priority: 'high', description: 'Finance departmental clearance sign-off for asset handover & loan balance closure.' },
          { id: 'APP-LEAVE-902', type: 'Extended Medical Leave Request', entityId: 'EMP-304', requester: 'Vikramaditya Sen', department: 'Engineering', submittedAt: '2026-09-10T14:30:00Z', slaHoursRemaining: 36, priority: 'medium', description: '14 days medical leave request requiring HR Business Partner exception sign-off.' },
          { id: 'APP-SALARY-410', type: 'Off-Cycle Mid-Year Adjustment', entityId: 'EMP-119', requester: 'Pooja Iyer', department: 'Product', submittedAt: '2026-09-11T08:00:00Z', slaHoursRemaining: 24, priority: 'high', description: 'Grade promotion adjustment from L2 Senior to L3 Lead Engineer.' }
        ];
        approvals.forEach(a => colMap.set(a.id, a));
      }
    }
    return _firestoreStore.get(name);
  }

  function createQuery(collectionName, filters = [], limitCount = null) {
    return {
      where: function(field, op, val) {
        return createQuery(collectionName, [...filters, { field, op, val }], limitCount);
      },
      orderBy: function() {
        return this;
      },
      limit: function(n) {
        return createQuery(collectionName, filters, n);
      },
      get: async function() {
        const colMap = getCollectionData(collectionName);
        let items = Array.from(colMap.values());
        for (const f of filters) {
          items = items.filter(doc => {
            if (f.op === '==' || f.op === '===') return doc[f.field] === f.val;
            if (f.op === 'in') return Array.isArray(f.val) && f.val.includes(doc[f.field]);
            return true;
          });
        }
        if (typeof limitCount === 'number') {
          items = items.slice(0, limitCount);
        }
        const docs = items.map(d => ({
          id: d.id,
          exists: true,
          data: () => d
        }));
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
          forEach: (cb) => docs.forEach(cb)
        };
      },
      doc: function(docId) {
        return {
          get: async function() {
            const colMap = getCollectionData(collectionName);
            const data = colMap.get(docId);
            return {
              id: docId,
              exists: Boolean(data),
              data: () => data || null
            };
          },
          set: async function(data, opts = {}) {
            const colMap = getCollectionData(collectionName);
            const existing = colMap.get(docId) || {};
            const merged = opts.merge ? { ...overlay(existing, data), id: docId } : { ...overlay({}, data), id: docId };
            colMap.set(docId, merged);
            return { id: docId };
          },
          update: async function(data) {
            const colMap = getCollectionData(collectionName);
            const existing = colMap.get(docId) || { id: docId };
            colMap.set(docId, overlay(existing, data, true));
            return { id: docId };
          },
          delete: async function() {
            const colMap = getCollectionData(collectionName);
            colMap.delete(docId);
            return true;
          }
        };
      },
      add: async function(data) {
        const colMap = getCollectionData(collectionName);
        const id = data.id || `doc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        colMap.set(id, { ...overlay({}, data), id });
        return { id };
      }
    };
  }

  db = {
    collection: function(name) {
      return createQuery(name);
    }
  };

  admin.firestore = function() {
    return db;
  };

  admin.auth = function() {
    return {
      verifyIdToken: async function(token) {
        return {
          uid: 'superadmin_dev',
          email: 'superadmin@kylrx.ai',
          role: 'super_admin'
        };
      }
    };
  };

  messaging = {
    send: async () => ({ success: true })
  };
}

// rawCollection(name) bypasses tenant scoping; only for authentication-time lookups
module.exports = { admin, db, messaging, rawCollection: rawCollection || ((name) => db.collection(name)) };

