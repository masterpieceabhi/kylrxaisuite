/**
 * ============================================================================
 * KYLRX.AI ENTERPRISE HRMS - FIREBASE CLOUD FUNCTIONS
 * ============================================================================
 * 
 * Architectural Deliverables:
 * 1. onUserCreated Trigger:
 *    - Automatically identifies initial customer signups / super admins.
 *    - Generates & assigns Firebase Auth Custom Claims (`super_admin: true`, `role: 'super_admin'`, `orgId`).
 *    - Initializes the organization document with `orgConfigured: false` to enforce setup gates.
 * 
 * 2. Employee Provisioning Engine (Transactional & Gapless):
 *    - Uses Firestore distributed counters inside `db.runTransaction`.
 *    - Strictly guarantees sequential, gapless Employee IDs (EMP001, EMP002, ...)
 *      during concurrent manual onboarding or bulk CSV uploads.
 * 
 * 3. Organization Configuration Completion Trigger / Callable:
 *    - Marks `orgConfigured: true` once company master configurations are validated.
 * 
 * @version 2.0.0
 * @author Senior Firebase Backend Architect
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');

if (admin.apps.length === 0) {
  admin.initializeApp();
}

const db = admin.firestore();
const auth = admin.auth();

// Default permissions granted to Super Admin
const SUPERADMIN_PERMISSIONS = [
  'all',
  'manage_organization',
  'manage_payroll',
  'approve_batches',
  'override_validations',
  'view_unmasked_pii',
  'configure_system'
];

/**
 * ────────────────────────────────────────────────────────────────────────────
 * 1. TRIGGER: onUserCreated (Auth & Firestore)
 * ────────────────────────────────────────────────────────────────────────────
 * Evaluates initial customer account creation, sets `super_admin` custom claims,
 * and provisions the unconfigured organization document (`orgConfigured: false`).
 */
exports.onUserCreated = functions.auth.user().onCreate(async (user) => {
  // This trigger used to make every new sign-in without a role the SUPER ADMIN of a company named after its email
  // domain (org_<domain>), whether or not that company already existed. That let anyone who could create a sign-in
  // (the web key is public) take over a company by using an address at its domain, put every gmail.com sign-up into
  // one shared company, and race the server's own signup, which sets the role a moment after creating the account.
  //
  // Nothing needs it: no page creates sign-in accounts from the browser. Companies and their owners are made by
  // POST /api/auth/register-organization, and employees by the people routes; both set the role and company
  // themselves with the Admin SDK. So a sign-in that arrives here without a role gets none: it belongs to no
  // company until the server puts it in one.
  const { uid, email } = user;
  try {
    const existing = await auth.getUser(uid);
    const hasRole = Boolean(existing.customClaims && existing.customClaims.role);
    console.log(`[onUserCreated] New sign-in ${uid} (${email ? "with" : "without"} email): ${hasRole ? "role already set by the server" : "no role yet; none is granted here"}.`);
  } catch (error) {
    console.error(`[onUserCreated] Could not read new sign-in ${uid}:`, error.message);
  }
  return null;
});

/**
 * Secondary Firestore Trigger on `/users/{userId}`:
 * Ensures when client calls setDoc during signup.js, claims are synchronized
 * and the organization document is provisioned with `orgConfigured: false`.
 */
exports.onUserDocCreated = functions.firestore
  .document('users/{userId}')
  .onCreate(async (snap, context) => {
    const userId = context.params.userId;
    const userData = snap.data();

    // Check if role is admin / super_admin
    const normalizedRole = (userData.role || '').toLowerCase();
    const isSuperAdminCandidate = [
      'admin', 'super_admin', 'superadmin', 'super admin', 'SUPER_ADMIN'
    ].includes(normalizedRole);

    if (!isSuperAdminCandidate) {
      return null;
    }

    const orgId = userData.orgId || `org_${(userData.company || 'default').replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()}`;
    const orgRef = db.collection('organizations').doc(orgId);
    const orgDoc = await orgRef.get();

    // Ensure Organization exists with orgConfigured: false
    if (!orgDoc.exists) {
      await orgRef.set({
        orgId,
        name: userData.company || 'Enterprise Organization',
        creatorUid: userId,
        creatorEmail: userData.email,
        orgConfigured: false, // Must complete setup before unlocking admin collections
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`[onUserDocCreated] Initialized unconfigured org: ${orgId}`);
    }

    // Set or refresh Auth custom claims
    try {
      const userAuth = await auth.getUser(userId);
      if (!userAuth.customClaims || !userAuth.customClaims.super_admin) {
        await auth.setCustomUserClaims(userId, {
          role: 'super_admin',
          super_admin: true,
          orgId,
          permissions: SUPERADMIN_PERMISSIONS
        });
        console.log(`[onUserDocCreated] Updated Auth Custom Claims for ${userId}`);
      }
    } catch (authErr) {
      console.warn(`[onUserDocCreated] Could not update Auth claims for ${userId}:`, authErr.message);
    }

    return null;
  });

/**
 * ────────────────────────────────────────────────────────────────────────────
 * 2. TRANSACTIONAL CLOUD FUNCTION: Employee Provisioning
 * ────────────────────────────────────────────────────────────────────────────
 * Guarantees sequential, gapless Employee IDs (e.g., EMP001, EMP002, ...)
 * using Firestore distributed counters inside an atomic transaction.
 * 
 * Callable from client:
 *   const provisionEmployees = httpsCallable(functions, 'provisionEmployees');
 *   const res = await provisionEmployees({ employees: [...], orgId: 'org_kylrx' });
 */
exports.provisionEmployees = functions.https.onCall(async (data, context) => {
  // 1. Authentication & Role Verification
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const token = context.auth.token;
  const isSuperAdmin = token.super_admin === true || ['super_admin', 'SUPER_ADMIN', 'admin'].includes(token.role);
  const isStaff = isSuperAdmin || ['hrms', 'hradmin', 'manager'].includes(token.role);

  if (!isStaff) {
    throw new functions.https.HttpsError('permission-denied', 'Unauthorized. Requires HR or Administrative role.');
  }

  const orgId = data.orgId || token.orgId;
  if (!orgId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing organization ID (orgId).');
  }

  // 2. Validate Input Payload
  const rawEmployees = Array.isArray(data.employees) ? data.employees : (data.employee ? [data.employee] : []);
  if (rawEmployees.length === 0) {
    throw new functions.https.HttpsError('invalid-argument', 'No employee records provided.');
  }

  const batchSize = rawEmployees.length;
  const prefix = (data.prefix || 'EMP').toUpperCase();
  const padLength = Number(data.padLength || 3); // EMP001 -> 3 digits, EMP0001 -> 4 digits

  // Reference to distributed counter doc
  const counterRef = db.collection('organizations').doc(orgId).collection('counters').doc('employees');
  const auditRef = db.collection('organizations').doc(orgId).collection('audit_logs').doc();

  try {
    const result = await db.runTransaction(async (transaction) => {
      // ── Step A: Read Counter in Transaction ──
      const counterSnap = await transaction.get(counterRef);
      let currentSeq = 0;
      let existingPrefix = prefix;
      let existingPadLength = padLength;

      if (counterSnap.exists) {
        const counterData = counterSnap.data();
        currentSeq = Number(counterData.currentSequence || 0);
        existingPrefix = counterData.prefix || prefix;
        existingPadLength = Number(counterData.padLength || padLength);
      }

      // ── Step B: Calculate Sequence Allocation ──
      const startSeq = currentSeq + 1;
      const endSeq = currentSeq + batchSize;
      const provisionedEmployees = [];

      // ── Step C: Generate Sequential Gapless IDs & Stage Writes ──
      for (let i = 0; i < batchSize; i++) {
        const assignedSeq = startSeq + i;
        const formattedId = `${existingPrefix}${String(assignedSeq).padStart(existingPadLength, '0')}`;
        const empInput = rawEmployees[i];

        // Unique document identifier (e.g. employee docId or generated UID)
        const employeeUid = empInput.uid || db.collection('users').doc().id;
        const employeeDocRef = db.collection('organizations').doc(orgId).collection('employees').doc(formattedId);
        const userDocRef = db.collection('users').doc(employeeUid);

        const employeeRecord = {
          ...empInput,
          uid: employeeUid,
          employeeId: formattedId,
          sequenceNumber: assignedSeq,
          orgId,
          status: empInput.status || 'active',
          role: empInput.role || 'employee',
          joiningDate: empInput.joiningDate || new Date().toISOString().split('T')[0],
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // Write to organization's employees subcollection
        transaction.set(employeeDocRef, employeeRecord);

        // Sync to top-level users collection
        transaction.set(userDocRef, {
          ...employeeRecord,
          isEmployee: true
        }, { merge: true });

        provisionedEmployees.push({
          employeeId: formattedId,
          sequenceNumber: assignedSeq,
          email: empInput.email || empInput['Official Email'] || '',
          name: empInput.name || empInput['Employee Name'] || ''
        });
      }

      // ── Step D: Atomically Update Distributed Counter ──
      transaction.set(counterRef, {
        currentSequence: endSeq,
        prefix: existingPrefix,
        padLength: existingPadLength,
        lastAllocatedBatchSize: batchSize,
        lastAllocatedRange: { start: startSeq, end: endSeq },
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        lastOperatorUid: context.auth.uid
      }, { merge: true });

      // ── Step E: Write Immutable Audit Trail Log ──
      transaction.set(auditRef, {
        action: 'BATCH_EMPLOYEE_PROVISIONED',
        orgId,
        operatorUid: context.auth.uid,
        count: batchSize,
        startSequence: startSeq,
        endSequence: endSeq,
        assignedIds: provisionedEmployees.map(e => e.employeeId),
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return {
        success: true,
        count: batchSize,
        startSequence: startSeq,
        endSequence: endSeq,
        employees: provisionedEmployees
      };
    });

    console.log(`[provisionEmployees] Successfully provisioned ${result.count} employees for ${orgId} (${result.startSequence} to ${result.endSequence})`);
    return result;
  } catch (err) {
    console.error(`[provisionEmployees] Transaction failed:`, err);
    throw new functions.https.HttpsError('aborted', `Sequential provisioning failed: ${err.message}`);
  }
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * 3. CALLABLE: Complete Organization Onboarding
 * ────────────────────────────────────────────────────────────────────────────
 * Allows the Super Admin to mark `orgConfigured: true` once the onboarding
 * wizard / initial company settings have been finalized.
 */
exports.completeOrganizationOnboarding = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const token = context.auth.token;
  const isSuperAdmin = token.super_admin === true || ['super_admin', 'SUPER_ADMIN'].includes(token.role);
  if (!isSuperAdmin) {
    throw new functions.https.HttpsError('permission-denied', 'Only Super Admins can finalize organization configuration.');
  }

  const orgId = data.orgId || token.orgId;
  if (!orgId) {
    throw new functions.https.HttpsError('invalid-argument', 'Missing organization ID.');
  }

  const orgRef = db.collection('organizations').doc(orgId);
  const orgSnap = await orgRef.get();

  if (!orgSnap.exists) {
    throw new functions.https.HttpsError('not-found', 'Organization document not found.');
  }

  // Atomically update orgConfigured to true
  await orgRef.update({
    orgConfigured: true,
    configuredAt: admin.firestore.FieldValue.serverTimestamp(),
    configuredBy: context.auth.uid,
    settings: {
      ...orgSnap.data().settings,
      ...(data.settings || {})
    }
  });

  console.log(`[completeOrganizationOnboarding] Organization ${orgId} is now verified & marked orgConfigured: true`);
  return { success: true, orgId, orgConfigured: true };
});

/**
 * ────────────────────────────────────────────────────────────────────────────
 * 4. FIRESTORE TRIGGER: Department Head Propagation Listener
 * ────────────────────────────────────────────────────────────────────────────
 * If a Super Admin updates the Head of a parent Department in the Department registry,
 * triggers an atomic Firestore batch to update all child Sub-Departments with
 * `inheritedFromDeptHead: true` or `sameAsDeptHead: true`.
 */
exports.onDepartmentHeadUpdated = functions.firestore
  .document('departments/{departmentId}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();

    const oldHead = before.departmentHeadEmployeeId || before.headEmployeeId;
    const newHead = after.departmentHeadEmployeeId || after.headEmployeeId;

    if (!newHead || oldHead === newHead) {
      return null;
    }

    const deptCode = (after.departmentCode || context.params.departmentId || '').toUpperCase();
    const newHeadName = after.departmentHeadName || after.headEmployeeName || `${newHead} Lead`;
    const orgId = after.orgId || 'org_kylrx';

    const subDeptQuery = await db.collection('organizations').doc(orgId).collection('sub_departments').get();
    const batch = db.batch();
    let count = 0;

    subDeptQuery.forEach(docSnap => {
      const data = docSnap.data();
      const isInherited = data.sameAsDeptHead === true || data.inheritedFromDeptHead === true;
      const matchesDept = (data.departmentCode && data.departmentCode.toUpperCase() === deptCode) ||
                          (data.subDepartmentCode && data.subDepartmentCode.toUpperCase().startsWith(deptCode + '-'));

      if (isInherited && matchesDept) {
        batch.update(docSnap.ref, {
          subDepartmentHeadEmployeeId: newHead,
          subDepartmentHeadName: newHeadName,
          headEmployeeId: newHead,
          headEmployeeName: newHeadName,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        count++;
      }
    });

    if (count > 0) {
      await batch.commit();
      console.log(`[onDepartmentHeadUpdated] Propagated new head ${newHead} (${newHeadName}) to ${count} sub-departments for dept ${deptCode}`);
    }
    return { success: true, count, deptCode, newHead };
  });

exports.onOrgDepartmentHeadUpdated = functions.firestore
  .document('organizations/{orgId}/departments/{departmentCode}')
  .onUpdate(async (change, context) => {
    const before = change.before.data();
    const after = change.after.data();
    const orgId = context.params.orgId;
    const deptCode = context.params.departmentCode.toUpperCase();

    const oldHead = before.departmentHeadEmployeeId || before.headEmployeeId;
    const newHead = after.departmentHeadEmployeeId || after.headEmployeeId;

    if (!newHead || oldHead === newHead) {
      return null;
    }

    const newHeadName = after.departmentHeadName || after.headEmployeeName || `${newHead} Lead`;
    const subDeptQuery = await db.collection('organizations').doc(orgId).collection('sub_departments').get();
    const batch = db.batch();
    let count = 0;

    subDeptQuery.forEach(docSnap => {
      const data = docSnap.data();
      const isInherited = data.sameAsDeptHead === true || data.inheritedFromDeptHead === true;
      const matchesDept = (data.departmentCode && data.departmentCode.toUpperCase() === deptCode) ||
                          (data.subDepartmentCode && data.subDepartmentCode.toUpperCase().startsWith(deptCode + '-'));

      if (isInherited && matchesDept) {
        batch.update(docSnap.ref, {
          subDepartmentHeadEmployeeId: newHead,
          subDepartmentHeadName: newHeadName,
          headEmployeeId: newHead,
          headEmployeeName: newHeadName,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        count++;
      }
    });

    if (count > 0) {
      await batch.commit();
      console.log(`[onOrgDepartmentHeadUpdated] Propagated new head ${newHead} (${newHeadName}) to ${count} sub-departments in ${orgId}`);
    }
    return { success: true, count, deptCode, newHead };
  });
