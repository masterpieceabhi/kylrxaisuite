import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { app, dynamicRoutesLoaded } = require('../server.js');
const { db } = require('../config/firebase.js');

const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
const projectId = 'kylrxai';
const JWT_SECRET = process.env.JWT_SECRET || 'kylrx_production_jwt_secret_key_v2_2026_secured';

// Helper to generate mock auth tokens for Firestore emulator REST API
function makeEmulatorToken({ uid, role = 'Employee', orgId = 'org_test_1', super_admin = false }) {
    return jwt.sign(
        {
            sub: uid,
            user_id: uid,
            email: `${uid}@kylrxai.com`,
            role,
            orgId,
            super_admin
        },
        'emulator_signing_secret'
    );
}

// These checks talk to the running Firestore emulator (the security rules live there, not in the app). They are
// skipped when no emulator answers. The two documents they create are removed before and after, so the suite can be
// run again and leaves nothing behind in the emulator's users collection.
const emulatorUp = await fetch(`http://${host}/`, { signal: AbortSignal.timeout(1500) }).then(() => true).catch(() => false);
const removeRuleTestDocs = async () => {
    for (const id of ['usr_emp_rule_test_01', 'usr_another_target_003']) {
        await fetch(`http://${host}/v1/projects/${projectId}/databases/(default)/documents/users/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner' } }).catch(() => {});
    }
};

describe('authController.register Role Protection & Firestore Security Rules Suite', () => {
    let server;
    let baseUrl;

    before(async () => {
        if (dynamicRoutesLoaded) {
            await dynamicRoutesLoaded;
        }
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        if (server && server.close) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    describe('authController.register - Always Enforces Employee Role', () => {
        it('ignores role: "Super Admin" in signup req.body and persists role as "Employee"', async () => {
            const email = `attacker_superadmin_${Date.now()}@example.com`;
            const res = await fetch(`${baseUrl}/api/auth/signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Super Admin Escalator',
                    email,
                    password: 'SecurePassword123!@#',
                    role: 'Super Admin',
                    department: 'Executive'
                })
            });

            assert.equal(res.status, 201, `Signup must succeed with 201, got ${res.status}`);
            const data = await res.json();
            assert.equal(data.success, true);

            // Fetch created user document from Firestore to verify role is Employee
            const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
            assert.equal(userSnap.empty, false, 'User must exist in Firestore');
            const savedUser = userSnap.docs[0].data();
            assert.equal(savedUser.role, 'Employee', 'Role in Firestore MUST be "Employee" regardless of req.body.role');
            assert.notEqual(savedUser.role, 'Super Admin', 'Privileged role must not be granted');
        });

        it('ignores role when role is Admin, Manager, HRMS or hr_payroll', async () => {
            const forbiddenRoles = ['Admin', 'Manager', 'HRMS', 'hr_payroll'];

            for (const attemptedRole of forbiddenRoles) {
                const email = `esc_${attemptedRole.toLowerCase()}_${Date.now()}@example.com`;
                const res = await fetch(`${baseUrl}/api/auth/signup`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        name: 'Role Escalator',
                        email,
                        password: 'SecurePassword123!@#',
                        role: attemptedRole,
                        department: 'General'
                    })
                });

                assert.equal(res.status, 201);
                const userSnap = await db.collection('users').where('email', '==', email).limit(1).get();
                assert.equal(userSnap.empty, false);
                const savedUser = userSnap.docs[0].data();
                assert.equal(savedUser.role, 'Employee', `Attempt to register as ${attemptedRole} must be overridden to Employee`);
            }
        });
    });

    describe('Admin Privileged User Creation Gate', () => {
        it('rejects unauthenticated requests to create-employee with 401', async () => {
            const res = await fetch(`${baseUrl}/api/admin/create-employee`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Privileged', email: 'priv@test.com', role: 'manager' })
            });
            assert.equal(res.status, 401, 'Unauthenticated user creation must return 401');
        });

        it('rejects Employee token requests to create-employee with 403', async () => {
            const employeeToken = jwt.sign(
                { id: 'emp-1', email: 'emp@test.com', role: 'Employee' },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const res = await fetch(`${baseUrl}/api/admin/create-employee`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${employeeToken}`
                },
                body: JSON.stringify({ name: 'Privileged', email: 'priv@test.com', role: 'manager' })
            });
            assert.equal(res.status, 403, 'Employee attempting to create users must return 403');
        });

        it('allows Admin token requests through authorization gate', async () => {
            const adminToken = jwt.sign(
                { id: 'admin-1', email: 'admin@test.com', role: 'Admin' },
                JWT_SECRET,
                { expiresIn: '15m' }
            );

            const res = await fetch(`${baseUrl}/api/admin/create-employee`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${adminToken}`
                },
                body: JSON.stringify({
                    name: 'Privileged Staff',
                    email: `admin_created_${Date.now()}@kylrxai.com`,
                    role: 'manager',
                    departmentId: 'Engineering'
                })
            });
            // The request must pass the auth/RBAC gate (not 401 or 403)
            assert.notEqual(res.status, 401, 'Admin should not be rejected with 401');
            assert.notEqual(res.status, 403, 'Admin should not be rejected with 403');
        });
    });

    describe('Firestore Security Rules under Emulator', { skip: emulatorUp ? false : 'the Firestore emulator is not running' }, () => {
        const empUid = 'usr_emp_rule_test_01';
        const empToken = makeEmulatorToken({ uid: empUid, role: 'Employee' });

        before(removeRuleTestDocs);
        after(removeRuleTestDocs);

        it('allows a user to create their document with role: Employee', async () => {
            const res = await fetch(
                `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users?documentId=${empUid}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${empToken}`
                    },
                    body: JSON.stringify({
                        fields: {
                            name: { stringValue: 'Valid Employee' },
                            email: { stringValue: 'employee@kylrxai.com' },
                            role: { stringValue: 'Employee' }
                        }
                    })
                }
            );
            assert.equal(res.status, 200, `Creating user with role: Employee should succeed (status 200), got ${res.status}`);
        });

        it('rejects a user creating document with role above Employee (Admin / Manager)', async () => {
            const badRoles = ['Admin', 'Super Admin', 'manager', 'HRMS'];

            for (const badRole of badRoles) {
                const targetId = `usr_attacker_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                const attackerToken = makeEmulatorToken({ uid: targetId, role: 'Employee' });

                const res = await fetch(
                    `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users?documentId=${targetId}`,
                    {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${attackerToken}`
                        },
                        body: JSON.stringify({
                            fields: {
                                name: { stringValue: 'Escalation Attempt' },
                                role: { stringValue: badRole }
                            }
                        })
                    }
                );
                assert.equal(res.status, 403, `Creating user with role '${badRole}' must be rejected with 403 PERMISSION_DENIED`);
            }
        });

        it('rejects a user creating document with super_admin: true', async () => {
            const targetId = `usr_attacker_sa_${Date.now()}`;
            const attackerToken = makeEmulatorToken({ uid: targetId, role: 'Employee' });

            const res = await fetch(
                `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users?documentId=${targetId}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${attackerToken}`
                    },
                    body: JSON.stringify({
                        fields: {
                            name: { stringValue: 'SuperAdmin Attempt' },
                            role: { stringValue: 'Employee' },
                            super_admin: { booleanValue: true }
                        }
                    })
                }
            );
            assert.equal(res.status, 403, 'Creating user with super_admin: true must be rejected with 403');
        });

        it('denies a user creating document with another users ID', async () => {
            const otherUid = 'usr_another_person_id';
            const res = await fetch(
                `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users?documentId=${otherUid}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${empToken}` // Token is for empUid, not otherUid
                    },
                    body: JSON.stringify({
                        fields: {
                            name: { stringValue: 'Impostor' },
                            role: { stringValue: 'Employee' }
                        }
                    })
                }
            );
            assert.equal(res.status, 403, 'Creating doc for other user ID must be denied with 403');
        });

        it('allows a user to update unprivileged fields (e.g. name, department) on own document', async () => {
            const res = await fetch(
                `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users/${empUid}?updateMask.fieldPaths=department&updateMask.fieldPaths=name`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${empToken}`
                    },
                    body: JSON.stringify({
                        fields: {
                            name: { stringValue: 'Updated Name' },
                            department: { stringValue: 'Engineering' }
                        }
                    })
                }
            );
            assert.equal(res.status, 200, `Updating name and department should succeed with 200, got ${res.status}`);
        });

        it('denies user update that modifies role (deny-list)', async () => {
            const res = await fetch(
                `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users/${empUid}?updateMask.fieldPaths=role`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${empToken}`
                    },
                    body: JSON.stringify({
                        fields: {
                            role: { stringValue: 'Admin' }
                        }
                    })
                }
            );
            assert.equal(res.status, 403, 'User updating role must be denied with 403');
        });

        it('denies user update that modifies orgId (deny-list)', async () => {
            const res = await fetch(
                `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users/${empUid}?updateMask.fieldPaths=orgId`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${empToken}`
                    },
                    body: JSON.stringify({
                        fields: {
                            orgId: { stringValue: 'different_tenant_org' }
                        }
                    })
                }
            );
            assert.equal(res.status, 403, 'User updating orgId must be denied with 403');
        });

        it('denies user update that modifies linkedAuthUid (deny-list)', async () => {
            const res = await fetch(
                `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users/${empUid}?updateMask.fieldPaths=linkedAuthUid`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${empToken}`
                    },
                    body: JSON.stringify({
                        fields: {
                            linkedAuthUid: { stringValue: 'other_auth_uid' }
                        }
                    })
                }
            );
            assert.equal(res.status, 403, 'User updating linkedAuthUid must be denied with 403');
        });

        it('denies user update that modifies super_admin (deny-list)', async () => {
            const res = await fetch(
                `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users/${empUid}?updateMask.fieldPaths=super_admin`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${empToken}`
                    },
                    body: JSON.stringify({
                        fields: {
                            super_admin: { booleanValue: true }
                        }
                    })
                }
            );
            assert.equal(res.status, 403, 'User updating super_admin must be denied with 403');
        });

        it('denies a user updating another users existing document', async () => {
            // First create another user's document with that other user's token
            const otherUid = 'usr_another_target_003';
            const otherToken = makeEmulatorToken({ uid: otherUid, role: 'Employee' });

            const createRes = await fetch(
                `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users?documentId=${otherUid}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${otherToken}`
                    },
                    body: JSON.stringify({
                        fields: {
                            name: { stringValue: 'Other User' },
                            role: { stringValue: 'Employee' }
                        }
                    })
                }
            );
            assert.equal(createRes.status, 200, 'Creation of target user doc must succeed');

            // Now empToken attempts to update otherUid's document
            const updateRes = await fetch(
                `http://${host}/v1/projects/${projectId}/databases/(default)/documents/users/${otherUid}?updateMask.fieldPaths=name`,
                {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${empToken}` // Token is for empUid, not otherUid
                    },
                    body: JSON.stringify({
                        fields: {
                            name: { stringValue: 'Hacked Name' }
                        }
                    })
                }
            );
            assert.equal(updateRes.status, 403, 'Cross-user update must be denied with 403');
        });
    });
});
