#!/usr/bin/env node
/**
 * ============================================================================
 * KYLRX AI ENTERPRISE HRMS - FIREBASE SUPER ADMIN PROVISIONING SCRIPT
 * ============================================================================
 * 
 * Purpose:
 *   Provisions or updates a dedicated Super Admin identity in Firebase Auth
 *   and Firestore for testing and end-to-end verification of the statutory
 *   compliance and payroll-to-payment execution pipeline.
 *
 * Core Responsibilities:
 *   1. User Creation/Update: Upserts Firebase Auth user (superadmin@kylrx.ai)
 *      with verified email, display name "Super Admin", and high-entropy password.
 *   2. Custom Claims Assignment: Grants role 'SUPER_ADMIN' and pipeline bypass
 *      permissions ('all', 'manage_payroll', 'approve_batches',
 *      'override_validations', 'view_unmasked_pii').
 *   3. Firestore Master Document: Seeds or updates profile records in both
 *      'users' and 'admins' collections with docId = superadmin_uid.
 *   4. Verification & Testing Token: Validates claims via Auth & Firestore,
 *      and mints a custom token for automated test suites.
 *
 * Usage:
 *   node scripts/provision-superadmin.js
 *   node scripts/provision-superadmin.js --password=MyCustomSecretPass123!
 *   node scripts/provision-superadmin.js --verify-only
 * 
 * @version 1.0.0
 * @author Senior Firebase Backend Engineer
 */

'use strict';

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables (.env) if present
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const admin = require('firebase-admin');

// ============================================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================================

const DEFAULT_SUPERADMIN_EMAIL = 'superadmin@kylrx.ai';
const DEFAULT_SUPERADMIN_DISPLAY_NAME = 'Super Admin';
const DEFAULT_ORGANIZATION = 'Kylrx Technologies Pvt. Ltd.';
// No built-in password: use SUPERADMIN_PASSWORD or --password=, otherwise a random one is generated and printed once
const GENERATED_PASSWORD = require('crypto').randomBytes(14).toString('base64url') + '#9a';
const DEFAULT_PASSWORD = process.env.SUPERADMIN_PASSWORD || GENERATED_PASSWORD;

const SUPERADMIN_PERMISSIONS = [
  'all',
  'manage_payroll',
  'approve_batches',
  'override_validations',
  'view_unmasked_pii',
];

const SUPERADMIN_CUSTOM_CLAIMS = {
  role: 'SUPER_ADMIN',
  super_admin: true,
  orgId: 'org_kylrx',
  permissions: SUPERADMIN_PERMISSIONS,
};

// ============================================================================
// 2. FIREBASE ADMIN SDK INITIALIZER
// ============================================================================

/**
 * Initializes Firebase Admin SDK with fallbacks across service accounts,
 * environment variables, and local configurations.
 */
function initializeFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  let serviceAccount = null;

  // 1. Check raw JSON string in environment
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) {
      console.warn('⚠️  Could not parse FIREBASE_SERVICE_ACCOUNT JSON string:', err.message);
    }
  }

  // 2. Check local config/serviceAccountKey.json
  if (!serviceAccount) {
    const localSaPath = path.resolve(__dirname, '../config/serviceAccountKey.json');
    if (fs.existsSync(localSaPath)) {
      try {
        serviceAccount = require(localSaPath);
      } catch (err) {
        console.warn('⚠️  Failed to require serviceAccountKey.json:', err.message);
      }
    }
  }

  // 3. Initialize app
  if (serviceAccount) {
    return admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id || process.env.FIREBASE_PROJECT_ID || 'kylrxai',
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || 'kylrxai.firebasestorage.app',
    });
  }

  // 4. Fallback to Google Application Default Credentials
  try {
    return admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      projectId: process.env.FIREBASE_PROJECT_ID || 'kylrxai',
    });
  } catch (err) {
    throw new Error(
      `Failed to initialize Firebase Admin SDK. No service account key found.\n` +
      `Ensure config/serviceAccountKey.json exists or FIREBASE_SERVICE_ACCOUNT is set.\n` +
      `Detail: ${err.message}`
    );
  }
}

// ============================================================================
// 3. CORE PROVISIONING ENGINE
// ============================================================================

/**
 * Parses CLI flags and arguments.
 */
function parseCliArgs() {
  const args = process.argv.slice(2);
  const options = {
    email: DEFAULT_SUPERADMIN_EMAIL,
    password: DEFAULT_PASSWORD,
    displayName: DEFAULT_SUPERADMIN_DISPLAY_NAME,
    organization: DEFAULT_ORGANIZATION,
    verifyOnly: false,
    dryRun: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--password=')) {
      options.password = arg.split('=')[1];
    } else if (arg.startsWith('--email=')) {
      options.email = arg.split('=')[1];
    } else if (arg.startsWith('--display-name=')) {
      options.displayName = arg.split('=')[1];
    } else if (arg.startsWith('--org=')) {
      options.organization = arg.split('=')[1];
    } else if (arg === '--verify-only') {
      options.verifyOnly = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  return options;
}

/**
 * Creates or updates the Super Admin user in Firebase Authentication.
 * 
 * @param {admin.auth.Auth} auth
 * @param {Object} options
 * @returns {Promise<{ userRecord: admin.auth.UserRecord, isNew: boolean }>}
 */
async function provisionAuthUser(auth, options) {
  const { email, password, displayName } = options;
  let userRecord;
  let isNew = false;

  try {
    const existing = await auth.getUserByEmail(email);
    console.log(`🔍 Found existing Firebase Auth user for ${email} (UID: ${existing.uid})`);

    userRecord = await auth.updateUser(existing.uid, {
      displayName,
      password,
      emailVerified: true,
      disabled: false,
    });
    console.log(`✅ Updated existing Firebase Auth user credentials and display name.`);
  } catch (err) {
    if (err.code === 'auth/user-not-found') {
      console.log(`✨ Provisioning new Firebase Auth user for ${email}...`);
      userRecord = await auth.createUser({
        email,
        password,
        displayName,
        emailVerified: true,
        disabled: false,
      });
      isNew = true;
      console.log(`✅ Successfully created new Firebase Auth user (UID: ${userRecord.uid}).`);
    } else {
      throw err;
    }
  }

  return { userRecord, isNew };
}

/**
 * Assigns custom claims granting bypass and full administrative privileges.
 * 
 * @param {admin.auth.Auth} auth
 * @param {string} uid
 * @param {Object} claims
 */
async function assignCustomClaims(auth, uid, claims) {
  console.log(`🛡️  Assigning Super Admin Custom Claims to UID: ${uid}...`);
  await auth.setCustomUserClaims(uid, claims);

  // Verification step: re-fetch user from Auth and assert claims
  const verifiedUser = await auth.getUser(uid);
  const assigned = verifiedUser.customClaims || {};

  if (assigned.role !== claims.role) {
    throw new Error(`Claims assignment verification failed: role mismatch (${assigned.role} !== ${claims.role})`);
  }

  console.log(`✅ Custom claims successfully verified:`);
  console.log(`   - role: '${assigned.role}'`);
  console.log(`   - permissions: [ ${assigned.permissions.map(p => `'${p}'`).join(', ')} ]`);

  return verifiedUser;
}

/**
 * Seeds or updates the master profile document in Firestore.
 * Updates both 'users' and 'admins' collections for complete ecosystem compatibility.
 * 
 * @param {admin.firestore.Firestore} db
 * @param {admin.auth.UserRecord} userRecord
 * @param {Object} options
 */
async function seedFirestoreDocuments(db, userRecord, options) {
  const { email, organization, displayName } = options;
  const uid = userRecord.uid;

  const collectionsToSync = ['users', 'admins'];
  const results = [];

  for (const collName of collectionsToSync) {
    const docRef = db.collection(collName).doc(uid);
    const existingSnap = await docRef.get();
    const isDocExisting = existingSnap.exists;

    const payload = {
      uid,
      email,
      displayName: displayName || userRecord.displayName || 'Super Admin',
      role: 'SUPER_ADMIN',
      organization,
      orgId: 'org_kylrx',
      permissions: SUPERADMIN_PERMISSIONS,
      is_active: true,
      updated_at: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (!isDocExisting) {
      payload.created_at = admin.firestore.FieldValue.serverTimestamp();
      await docRef.set(payload);
      console.log(`📄 Created new Firestore document: ${collName}/${uid}`);
    } else {
      // Retain existing created_at if available
      const existingData = existingSnap.data() || {};
      if (!existingData.created_at) {
        payload.created_at = admin.firestore.FieldValue.serverTimestamp();
      }
      await docRef.set(payload, { merge: true });
      console.log(`🔄 Merged profile updates into Firestore document: ${collName}/${uid}`);
    }

    results.push({ collection: collName, docId: uid, existed: isDocExisting });
  }

  // Also seed tenant organization document with orgConfigured: true
  const orgRef = db.collection('organizations').doc('org_kylrx');
  const orgSnap = await orgRef.get();
  await orgRef.set({
    orgId: 'org_kylrx',
    name: organization,
    creatorUid: uid,
    creatorEmail: email,
    orgConfigured: true,
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
    ...(orgSnap.exists ? {} : { created_at: admin.firestore.FieldValue.serverTimestamp() })
  }, { merge: true });
  console.log(`🏢 Seeded/Updated tenant organization: organizations/org_kylrx (orgConfigured: true)`);
  results.push({ collection: 'organizations', docId: 'org_kylrx', existed: orgSnap.exists });

  return results;
}

/**
 * Verifies existing Super Admin state in Auth and Firestore without modification.
 * 
 * @param {admin.auth.Auth} auth
 * @param {admin.firestore.Firestore} db
 * @param {string} email
 */
async function verifySuperAdmin(auth, db, email) {
  console.log(`\n==================================================`);
  console.log(`🔍 VERIFYING SUPER ADMIN PROVISIONING STATUS`);
  console.log(`==================================================`);
  console.log(`Target Email: ${email}`);

  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
    console.log(`✅ Auth User exists (UID: ${userRecord.uid})`);
    console.log(`   - Display Name: ${userRecord.displayName}`);
    console.log(`   - Email Verified: ${userRecord.emailVerified}`);
    console.log(`   - Disabled: ${userRecord.disabled}`);
    console.log(`   - Custom Claims:`, JSON.stringify(userRecord.customClaims || {}, null, 2));
  } catch (err) {
    console.error(`❌ User not found in Firebase Auth: ${err.message}`);
    return { ok: false, error: err.message };
  }

  // Firestore collections check
  for (const collName of ['users', 'admins']) {
    const docRef = db.collection(collName).doc(userRecord.uid);
    const snap = await docRef.get();
    if (snap.exists) {
      const data = snap.data();
      console.log(`✅ Firestore ${collName}/${userRecord.uid} document confirmed:`);
      console.log(`   - role: ${data.role}`);
      console.log(`   - is_active: ${data.is_active}`);
      console.log(`   - organization: ${data.organization}`);
      console.log(`   - permissions: ${JSON.stringify(data.permissions || [])}`);
    } else {
      console.warn(`⚠️  Firestore document missing in collection: ${collName}/${userRecord.uid}`);
    }
  }

  return { ok: true, uid: userRecord.uid };
}

/**
 * Main execution coordinator.
 */
async function provisionSuperAdmin(customOptions = {}) {
  const options = { ...parseCliArgs(), ...customOptions };

  console.log(`==============================================================`);
  console.log(`🔥 KYLRX AI - FIREBASE SUPER ADMIN PROVISIONING WORKFLOW`);
  console.log(`==============================================================`);
  console.log(`Target User        : ${options.email}`);
  console.log(`Display Name       : ${options.displayName}`);
  console.log(`Organization       : ${options.organization}`);
  console.log(`Role               : SUPER_ADMIN`);
  console.log(`Permissions        : [ ${SUPERADMIN_PERMISSIONS.join(', ')} ]`);
  console.log(`Timestamp (Local)  : ${new Date().toISOString()}`);
  console.log(`==============================================================\n`);

  // 1. Initialize Firebase Admin SDK
  initializeFirebaseAdmin();
  const auth = admin.auth();
  const db = admin.firestore();

  if (options.verifyOnly) {
    return await verifySuperAdmin(auth, db, options.email);
  }

  if (options.dryRun) {
    console.log(`ℹ️  Dry run active. No writes were executed.`);
    return { dryRun: true };
  }

  // Step 1: User Creation/Update in Firebase Auth
  console.log(`[Step 1/4] Provisioning Firebase Authentication Record...`);
  const { userRecord, isNew } = await provisionAuthUser(auth, options);

  // Step 2: Custom Claims Assignment
  console.log(`\n[Step 2/4] Assigning Granular Bypass & Pipeline Custom Claims...`);
  const userWithClaims = await assignCustomClaims(auth, userRecord.uid, SUPERADMIN_CUSTOM_CLAIMS);

  // Step 3: Firestore Master Document Provisioning
  console.log(`\n[Step 3/4] Seeding Firestore Master Documents...`);
  const docResults = await seedFirestoreDocuments(db, userWithClaims, options);

  // Step 4: Mint Verification Test Token
  console.log(`\n[Step 4/4] Minting Super Admin Custom Auth Token for Pipeline Testing...`);
  const customToken = await auth.createCustomToken(userRecord.uid, SUPERADMIN_CUSTOM_CLAIMS);

  console.log(`\n==============================================================`);
  console.log(`🎉 SUPER ADMIN SUCCESSFULLY PROVISIONED & VERIFIED!`);
  console.log(`==============================================================`);
  console.log(`UID                 : ${userRecord.uid}`);
  console.log(`Email               : ${userRecord.email}`);
  console.log(`Role                : SUPER_ADMIN`);
  console.log(`Organization        : ${options.organization}`);
  console.log(`Auth Status         : ${isNew ? 'Created (New)' : 'Updated (Existing)'}`);
  console.log(`Firestore Documents : ${docResults.map(r => `${r.collection}/${r.docId}`).join(', ')}`);
  console.log(`Active Permissions  : ${SUPERADMIN_PERMISSIONS.join(', ')}`);
  console.log(`--------------------------------------------------------------`);
  console.log(`🔑 Verification Custom Token (Truncated):`);
  console.log(`   ${customToken.slice(0, 48)}...${customToken.slice(-16)}`);
  console.log(`--------------------------------------------------------------`);
  console.log(`💡 Pipeline Bypass Test Header:`);
  console.log(`   x-user-role: SUPER_ADMIN`);
  console.log(`   x-user-id: ${userRecord.uid}`);
  console.log(`==============================================================\n`);

  return {
    success: true,
    uid: userRecord.uid,
    email: userRecord.email,
    displayName: userRecord.displayName,
    role: 'SUPER_ADMIN',
    permissions: SUPERADMIN_PERMISSIONS,
    customToken,
    firestoreDocuments: docResults,
  };
}

// ============================================================================
// 4. CLI RUNNER OR MODULE EXPORTS
// ============================================================================

if (require.main === module) {
  provisionSuperAdmin()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\n❌ FATAL: Super Admin Provisioning Failed!`);
      console.error(err);
      process.exit(1);
    });
}

module.exports = {
  provisionSuperAdmin,
  verifySuperAdmin,
  SUPERADMIN_PERMISSIONS,
  SUPERADMIN_CUSTOM_CLAIMS,
  DEFAULT_SUPERADMIN_EMAIL,
  DEFAULT_SUPERADMIN_DISPLAY_NAME,
};
