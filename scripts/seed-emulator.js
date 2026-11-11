/**
 * Seeds the local Firebase emulators with a demo organization (India rules) and one account per role.
 * Local testing only: refuses to run unless the emulator environment variables are set.
 *
 *   npm run emulators        (in one terminal)
 *   npm run seed:local       (in another)
 */
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const admin = require('firebase-admin');
const bcrypt = require('bcrypt');

const ORG_ID = 'org_demo_in';
const PASSWORD = process.env.SEED_PASSWORD || 'LocalTest#2026';

const ACCOUNTS = [
    { email: 'superadmin@demo.local', name: 'Demo Super Admin', role: 'super_admin', claims: { super_admin: true } },
    { email: 'hr@demo.local', name: 'Demo HR Admin', role: 'hr_admin', claims: {} },
    { email: 'manager@demo.local', name: 'Demo Manager', role: 'manager', claims: {} },
    { email: 'employee@demo.local', name: 'Demo Employee', role: 'employee', claims: {} }
];

(async () => {
    admin.initializeApp({ projectId: 'kylrxai' });
    const db = admin.firestore();
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    await db.collection('organizations').doc(ORG_ID).set({
        orgId: ORG_ID,
        name: 'Demo Industries Pvt Ltd',
        country: 'IN',
        currency: 'INR',
        orgConfigured: true,
        createdAt: new Date().toISOString()
    }, { merge: true });

    for (const a of ACCOUNTS) {
        let uid;
        try {
            uid = (await admin.auth().getUserByEmail(a.email)).uid;
            await admin.auth().updateUser(uid, { password: PASSWORD });
        } catch (_) {
            uid = (await admin.auth().createUser({ email: a.email, password: PASSWORD, displayName: a.name, emailVerified: true })).uid;
        }
        await admin.auth().setCustomUserClaims(uid, { role: a.role, orgId: ORG_ID, ...a.claims });
        await db.collection('users').doc(uid).set({
            id: uid,
            uid,
            email: a.email,
            name: a.name,
            role: a.role,
            orgId: ORG_ID,
            status: 'Active',
            password: passwordHash,
            createdAt: new Date().toISOString()
        }, { merge: true });
        console.log(`seeded ${a.role.padEnd(12)} ${a.email}`);
    }
    console.log(`\nPassword for all demo accounts: ${PASSWORD}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
