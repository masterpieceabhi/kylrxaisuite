/**
 * Seeds the local Firebase emulators with two demo organizations (India and United States)
 * and one account per role in each. Local testing only: it talks to the emulators, never to the
 * live project.
 *
 *   npm run emulators        (in one terminal)
 *   npm run seed:local       (in another)
 */
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';

const admin = require('firebase-admin');
const bcrypt = require('bcrypt');

const PASSWORD = process.env.SEED_PASSWORD || 'LocalTest#2026';

const ORGS = [
    {
        orgId: 'org_demo_in',
        domain: 'demo.local',
        profile: { name: 'Demo Industries Pvt Ltd', country: 'IN', currency: 'INR' }
    },
    {
        orgId: 'org_demo_us',
        domain: 'us.demo.local',
        profile: {
            name: 'Demo Industries Inc',
            country: 'United States',
            currency: 'USD',
            EIN: '12-3456789',
            state: 'TX',
            timezone: 'America/Chicago'
        }
    }
];

const ROLES = [
    { prefix: 'superadmin', name: 'Super Admin', role: 'super_admin', claims: { super_admin: true } },
    { prefix: 'hr', name: 'HR Admin', role: 'hr_admin', claims: {} },
    { prefix: 'manager', name: 'Manager', role: 'manager', claims: {} },
    { prefix: 'employee', name: 'Employee', role: 'employee', claims: {} },
    { prefix: 'payroll', name: 'Payroll Admin', role: 'payroll_admin', claims: {} },
    { prefix: 'accountant', name: 'Accountant', role: 'accountant', claims: {} },
    { prefix: 'auditor', name: 'Auditor', role: 'auditor', claims: {} }
];

(async () => {
    admin.initializeApp({ projectId: 'kylrxai' });
    const db = admin.firestore();
    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    for (const org of ORGS) {
        await db.collection('organizations').doc(org.orgId).set({
            orgId: org.orgId,
            ...org.profile,
            orgConfigured: true,
            createdAt: new Date().toISOString()
        }, { merge: true });

        for (const r of ROLES) {
            const email = `${r.prefix}@${org.domain}`;
            const displayName = `Demo ${r.name} (${org.profile.country})`;
            let uid;
            try {
                uid = (await admin.auth().getUserByEmail(email)).uid;
                await admin.auth().updateUser(uid, { password: PASSWORD });
            } catch (_) {
                uid = (await admin.auth().createUser({ email, password: PASSWORD, displayName, emailVerified: true })).uid;
            }
            await admin.auth().setCustomUserClaims(uid, { role: r.role, orgId: org.orgId, ...r.claims });
            await db.collection('users').doc(uid).set({
                id: uid,
                uid,
                email,
                name: displayName,
                role: r.role,
                orgId: org.orgId,
                status: 'Active',
                password: passwordHash,
                createdAt: new Date().toISOString()
            }, { merge: true });
            console.log(`seeded ${org.orgId.padEnd(12)} ${r.role.padEnd(12)} ${email}`);
        }
    }
    console.log(`\nPassword for all demo accounts: ${PASSWORD}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
