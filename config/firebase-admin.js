// The Firebase Admin SDK as one object in the older "admin.firestore()" shape, built on the modular entry points.
//
// firebase-admin 14 dropped that shape (require('firebase-admin') now holds only initializeApp, getApp, cert and a
// few more). About 170 places in this code use it, so instead of rewriting each one, every file that used to
// require('firebase-admin') requires this file. It is one shared, writable object, as the SDK's own module was:
// the in-memory database in config/firebase.js replaces firestore() and auth() on it, and every holder sees that.
//
// `apps` is a plain list of the apps made through initializeApp() here. A test empties it and fills it again to
// play a server with no database, which a fresh copy from getApps() would not allow.

const appApi = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp, FieldPath, GeoPoint, Firestore } = require('firebase-admin/firestore');
const { getAuth, Auth, UserRecord } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
const { getMessaging } = require('firebase-admin/messaging');

function firestore(app) { return getFirestore(app); }
Object.assign(firestore, { FieldValue, Timestamp, FieldPath, GeoPoint, Firestore });

function auth(app) { return getAuth(app); }
Object.assign(auth, { Auth, UserRecord });

const admin = {
  apps: [],
  initializeApp(options, name) {
    const app = appApi.initializeApp(options, name);
    admin.apps.push(app);
    return app;
  },
  app(name) { return appApi.getApp(name); },
  credential: { cert: appApi.cert, applicationDefault: appApi.applicationDefault, refreshToken: appApi.refreshToken },
  firestore,
  auth,
  storage(app) { return getStorage(app); },
  messaging(app) { return getMessaging(app); },
  SDK_VERSION: appApi.SDK_VERSION,
};

module.exports = admin;
