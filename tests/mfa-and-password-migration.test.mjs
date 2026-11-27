process.env.NODE_ENV = 'test';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Run on the full in-memory database (same calls as Firestore). The small stand-in inside config/firebase.js does not
// understand FieldValue.delete(), so the migration's "remove tempPassword" step could not be checked against it.
require('./helpers/memory-firestore.js').install();
const { app, dynamicRoutesLoaded } = require('../server.js');
const { db, admin } = require('../config/firebase.js');
const { migratePlaintextPasswords } = require('../scripts/migrate-plaintext-passwords.js');
const otpVerificationService = require('../services/otp-verification-service.js');

const JWT_SECRET = process.env.JWT_SECRET || 'kylrx_production_jwt_secret_key_v2_2026_secured';

describe('Real MFA Enforcement & Plaintext Password Migration Suite', () => {
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

    describe('1. Removal of Plaintext Password Comparisons in authController.login', () => {
        it('rejects login for users with plaintext password stored in database (no bcrypt hash)', async () => {
            const email = `plaintext_user_${Date.now()}@test.com`;
            const plaintextPassword = 'ValidPassword123!@#';

            // Seed user directly with plaintext password
            await db.collection('users').doc(`usr_pt_${Date.now()}`).set({
                name: 'Plaintext User',
                email,
                password: plaintextPassword, // Stored as plaintext, not $2...
                role: 'Employee'
            });

            const res = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password: plaintextPassword })
            });

            assert.equal(res.status, 401, 'Login with plaintext password stored in DB must return 401 (plaintext comparison removed)');
            const data = await res.json();
            assert.equal(data.success, false);
            assert.equal(data.error, 'Invalid credentials');
        });

        it('rejects login for users with only tempPassword stored in database', async () => {
            const email = `temppw_user_${Date.now()}@test.com`;
            const tempPassword = 'TemporaryPass123!@#';

            // Seed user directly with legacy tempPassword
            await db.collection('users').doc(`usr_temp_${Date.now()}`).set({
                name: 'Temp Password User',
                email,
                tempPassword, // Plaintext temp password fallback
                role: 'Employee'
            });

            const res = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password: tempPassword })
            });

            assert.equal(res.status, 401, 'Login using tempPassword fallback must return 401');
            const data = await res.json();
            assert.equal(data.success, false);
        });

        it('accepts login for users with valid bcrypt hashed password and proceeds to MFA', async () => {
            const email = `hashed_user_${Date.now()}@test.com`;
            const rawPassword = 'ValidPassword123!@#';
            const hashedPassword = await bcrypt.hash(rawPassword, 10);

            await db.collection('users').doc(`usr_hashed_${Date.now()}`).set({
                name: 'Hashed User',
                email,
                password: hashedPassword,
                role: 'Employee'
            });

            const res = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password: rawPassword })
            });

            assert.equal(res.status, 200, 'Login with bcrypt hashed password should succeed with 200');
            const data = await res.json();
            assert.equal(data.success, true);
            assert.equal(data.requiresMfa, true, 'Must indicate MFA is required');
        });
    });

    describe('2. Plaintext Password Migration Script', () => {
        it('migrates plaintext passwords and tempPasswords to bcrypt hashes and sets mustResetPassword', async () => {
            const user1DocId = `migrate_user_1_${Date.now()}`;
            const user2DocId = `migrate_user_2_${Date.now()}`;
            const userAlreadyHashedId = `migrate_user_3_${Date.now()}`;

            const pw1 = 'PlaintextPassword123!@#';
            const pw2 = 'TempSecretPassword123!@#';
            const securePw = 'AlreadySecure123!@#';
            const existingHash = await bcrypt.hash(securePw, 10);

            // Seed 3 users:
            // 1) User with plaintext password
            await db.collection('users').doc(user1DocId).set({
                email: `mig1_${Date.now()}@test.com`,
                password: pw1,
                role: 'Employee'
            });

            // 2) User with legacy tempPassword
            await db.collection('users').doc(user2DocId).set({
                email: `mig2_${Date.now()}@test.com`,
                tempPassword: pw2,
                role: 'Employee'
            });

            // 3) User with already valid bcrypt hash
            await db.collection('users').doc(userAlreadyHashedId).set({
                email: `mig3_${Date.now()}@test.com`,
                password: existingHash,
                role: 'Employee'
            });

            // Run migration script
            const result = await migratePlaintextPasswords({ db, admin, bcrypt, saltRounds: 10 });
            assert.equal(result.success, true);
            assert.ok(result.migratedCount >= 2, 'At least 2 users should have been migrated');

            // Verify User 1: password is now bcrypt hash and mustResetPassword is true
            const user1Doc = await db.collection('users').doc(user1DocId).get();
            const user1Data = user1Doc.data();
            assert.ok(user1Data.password.startsWith('$2'), 'Password must now be a bcrypt hash starting with $2');
            assert.equal(user1Data.mustResetPassword, true, 'mustResetPassword must be set to true');
            const match1 = await bcrypt.compare(pw1, user1Data.password);
            assert.equal(match1, true, 'New bcrypt hash must match original plaintext password');

            // Verify User 2: tempPassword deleted, password is now bcrypt hash, mustResetPassword is true
            const user2Doc = await db.collection('users').doc(user2DocId).get();
            const user2Data = user2Doc.data();
            assert.ok(user2Data.password.startsWith('$2'));
            assert.equal(user2Data.tempPassword, undefined, 'tempPassword field must be removed');
            assert.equal(user2Data.mustResetPassword, true);
            const match2 = await bcrypt.compare(pw2, user2Data.password);
            assert.equal(match2, true);

            // Verify User 3: existing hash was not corrupted or modified
            const user3Doc = await db.collection('users').doc(userAlreadyHashedId).get();
            const user3Data = user3Doc.data();
            assert.equal(user3Data.password, existingHash, 'Already-hashed password must remain untouched');

            // Verify User 1 can now login with their password (which was migrated to bcrypt)
            const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: user1Data.email, password: pw1 })
            });
            assert.equal(loginRes.status, 200, 'Migrated user must be able to log in with their password');
        });
    });

    describe('3. Real Multi-Factor Authentication (MFA) Flow', () => {
        let testEmail;
        let testPassword = 'SecurePassword123!@#';
        let testUserId;
        let mfaPendingToken;
        let issuedOtpCode;
        let otpId;

        before(async () => {
            testEmail = `mfa_flow_${Date.now()}@test.com`;
            testUserId = `usr_mfa_${Date.now()}`;
            const hashedPassword = await bcrypt.hash(testPassword, 10);

            await db.collection('users').doc(testUserId).set({
                name: 'MFA Flow User',
                email: testEmail,
                password: hashedPassword,
                role: 'Employee',
                department: 'Customer Success'
            });
        });

        it('login returns a short-lived mfa_pending token only, with NO access or refresh tokens', async () => {
            const res = await fetch(`${baseUrl}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: testEmail, password: testPassword })
            });

            assert.equal(res.status, 200);
            const data = await res.json();

            // Crucial assertions: full tokens must NOT be issued upon login
            assert.equal(data.accessToken, undefined, 'Full accessToken must NOT be issued on login');
            assert.equal(data.refreshToken, undefined, 'refreshToken must NOT be issued on login');
            assert.equal(data.requiresMfa, true, 'requiresMfa must be true');
            assert.ok(data.mfaToken, 'mfaToken must be returned');
            assert.ok(data.otpId, 'otpId must be returned');

            mfaPendingToken = data.mfaToken;
            otpId = data.otpId;
            issuedOtpCode = data.code || otpVerificationService.otps.get(otpId)?.rawCode || otpVerificationService.otps.get(otpId)?.code;
            assert.ok(issuedOtpCode, 'issuedOtpCode must be resolved for verification');

            // Verify the mfaToken is decoded as type: 'mfa_pending'
            const decoded = jwt.verify(mfaPendingToken, JWT_SECRET);
            assert.equal(decoded.type, 'mfa_pending');
            assert.equal(decoded.email, testEmail);
        });

        it('rejects mfa_pending token when used to access protected endpoints', async () => {
            // Attempt to call protected endpoint GET /api/data/attendance with the mfa_pending token
            const res = await fetch(`${baseUrl}/api/data/attendance`, {
                headers: { Authorization: `Bearer ${mfaPendingToken}` }
            });

            assert.equal(res.status, 401, 'mfa_pending token must be rejected with 401 on protected endpoints');
            const data = await res.json();
            assert.equal(data.mfaRequired, true);
        });

        it('rejects MFA verification when OTP code is incorrect', async () => {
            const res = await fetch(`${baseUrl}/api/auth/verify-mfa`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mfaToken: mfaPendingToken,
                    otpId,
                    code: '000000' // Deliberately wrong code
                })
            });

            assert.equal(res.status, 401, 'Incorrect OTP code must return 401');
            const data = await res.json();
            assert.equal(data.success, false);
            assert.equal(data.reason, 'INVALID_CODE');
        });

        it('rejects MFA verification when mfaToken is missing', async () => {
            const res = await fetch(`${baseUrl}/api/auth/verify-mfa`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: '123456' })
            });
            assert.equal(res.status, 401, 'Missing mfaToken must return 401');
        });

        it('issues full accessToken and refreshToken after successful OTP verification', async () => {
            // Provide valid OTP code obtained during login
            const res = await fetch(`${baseUrl}/api/auth/verify-mfa`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mfaToken: mfaPendingToken,
                    otpId,
                    code: issuedOtpCode
                })
            });

            assert.equal(res.status, 200, 'Valid OTP must return 200');
            const data = await res.json();
            assert.equal(data.success, true);
            assert.ok(data.accessToken, 'Full accessToken must now be issued');
            assert.ok(data.refreshToken, 'Full refreshToken must now be issued');
            assert.equal(data.user.email, testEmail);

            // Verify full access token works on protected endpoints
            const protectedRes = await fetch(`${baseUrl}/api/data/attendance`, {
                headers: { Authorization: `Bearer ${data.accessToken}` }
            });
            assert.notEqual(protectedRes.status, 401, 'Full access token must be accepted on protected endpoints');
        });

        it('enforces single-use policy: reusing the same OTP code is denied', async () => {
            const res = await fetch(`${baseUrl}/api/auth/verify-mfa`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mfaToken: mfaPendingToken,
                    otpId,
                    code: issuedOtpCode
                })
            });

            assert.equal(res.status, 401, 'Reused OTP must return 401');
            const data = await res.json();
            assert.equal(data.reason, 'OTP_ALREADY_USED', 'Reason must be OTP_ALREADY_USED');
        });
    });
});
