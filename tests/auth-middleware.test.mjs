import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// The middleware reads JWT_SECRET from .env when it is first loaded. Settle the secret here, before any token is
// signed: reading it earlier than that (as this file used to) signed the "valid" tokens with a different secret.
require('dotenv').config({ quiet: true });
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

describe('Authentication Middleware & Secret Security Suite', () => {
    const OLD_FALLBACK_SECRET = 'super-secret-enterprise-key-hrflow-2026';
    const CURRENT_JWT_SECRET = process.env.JWT_SECRET;

    function createMockRes() {
        return {
            statusCode: null,
            body: null,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(data) {
                this.body = data;
                return this;
            }
        };
    }

    it('returns 401 when no token is present', async () => {
        const { verifyToken } = require('../middleware/authMiddleware.js');
        const req = { headers: {} };
        const res = createMockRes();
        let nextCalled = false;

        await verifyToken(req, res, () => { nextCalled = true; });

        assert.equal(res.statusCode, 401, 'Should return 401 when authorization header is missing');
        assert.equal(res.body?.success, false);
        assert.equal(nextCalled, false, 'next() should not be called');
    });

    it('returns 401 when Authorization header is malformed or empty Bearer', async () => {
        const { verifyToken } = require('../middleware/authMiddleware.js');
        
        for (const authHeader of ['', 'Bearer', 'Bearer ', 'Basic xyz', 'Bearer null', 'Bearer undefined']) {
            const req = { headers: { authorization: authHeader } };
            const res = createMockRes();
            let nextCalled = false;

            await verifyToken(req, res, () => { nextCalled = true; });

            assert.equal(res.statusCode, 401, `Should return 401 for header: "${authHeader}"`);
            assert.equal(res.body?.success, false);
            assert.equal(nextCalled, false);
        }
    });

    it('returns 401 when a garbage token is provided', async () => {
        const { verifyToken } = require('../middleware/authMiddleware.js');
        const req = { headers: { authorization: 'Bearer this-is-a-completely-garbage-token-xyz' } };
        const res = createMockRes();
        let nextCalled = false;

        await verifyToken(req, res, () => { nextCalled = true; });

        assert.equal(res.statusCode, 401, 'Should return 401 for garbage token');
        assert.equal(res.body?.success, false);
        assert.equal(res.body?.error, 'Token is invalid or expired');
        assert.equal(nextCalled, false);
    });

    it('returns 401 when a token is signed with the old fallback secret', async () => {
        const { verifyToken } = require('../middleware/authMiddleware.js');
        const oldSecretToken = jwt.sign(
            { id: 'usr-leak-test', email: 'user@example.com', role: 'Admin' },
            OLD_FALLBACK_SECRET,
            { expiresIn: '1h' }
        );

        const req = { headers: { authorization: `Bearer ${oldSecretToken}` } };
        const res = createMockRes();
        let nextCalled = false;

        await verifyToken(req, res, () => { nextCalled = true; });

        assert.equal(res.statusCode, 401, 'Token signed with old fallback secret must return 401');
        assert.equal(res.body?.success, false);
        assert.equal(res.body?.error, 'Token is invalid or expired');
        assert.equal(nextCalled, false);
    });

    it('returns 401 for demo-static-token (bypass removed)', async () => {
        const { verifyToken } = require('../middleware/authMiddleware.js');
        const req = { headers: { authorization: 'Bearer demo-static-token' } };
        const res = createMockRes();
        let nextCalled = false;

        await verifyToken(req, res, () => { nextCalled = true; });

        assert.equal(res.statusCode, 401, 'demo-static-token bypass must be removed and return 401');
        assert.equal(res.body?.success, false);
        assert.equal(nextCalled, false);
    });

    it('successfully verifies a valid JWT signed with current secret and does not leak globals', async () => {
        const { verifyToken } = require('../middleware/authMiddleware.js');
        const validToken = jwt.sign(
            { id: 'usr-valid-101', email: 'developer@example.com', role: 'Manager' },
            CURRENT_JWT_SECRET,
            { expiresIn: '15m' }
        );

        // Ensure global.decoded and global.userId do not exist beforehand
        delete global.decoded;
        delete global.userId;

        const req = { headers: { authorization: `Bearer ${validToken}` } };
        const res = createMockRes();
        let nextCalled = false;

        await verifyToken(req, res, () => { nextCalled = true; });

        assert.equal(nextCalled, true, 'next() should be called for valid token');
        assert.equal(req.user.id, 'usr-valid-101');
        assert.equal(req.user.email, 'developer@example.com');
        assert.equal(req.user.role, 'Manager');

        // Verify that decoded and userId did not leak onto global object
        assert.equal(global.decoded, undefined, 'global.decoded must not be leaked');
        assert.equal(global.userId, undefined, 'global.userId must not be leaked');
    });

    it('does not grant Admin role based on email domain or hardcoded email', async () => {
        const { verifyToken } = require('../middleware/authMiddleware.js');
        
        const testEmails = [
            'attacker@hrflow.com',
            'attacker@kylrxai.com',
            'admin@demo.com',
            'nandanb449@gmail.com',
            'info.kylrxai@gmail.com'
        ];

        for (const email of testEmails) {
            const token = jwt.sign(
                { id: `usr-${email}`, email, role: 'Employee' },
                CURRENT_JWT_SECRET,
                { expiresIn: '15m' }
            );

            const req = { headers: { authorization: `Bearer ${token}` } };
            const res = createMockRes();
            let nextCalled = false;

            await verifyToken(req, res, () => { nextCalled = true; });

            assert.equal(nextCalled, true);
            assert.equal(
                req.user.role,
                'Employee',
                `User with email ${email} must not be promoted to Admin without explicit Admin role`
            );
        }
    });

    it('rejects partial substring admin roles and strictly enforces the allow-list', async () => {
        const { verifyToken } = require('../middleware/authMiddleware.js');
        
        const nonAllowListRoles = [
            'sysadmin_assistant',
            'fake_admin_role',
            'admin_trainee',
            'custom_unauthorized_role'
        ];

        for (const role of nonAllowListRoles) {
            const token = jwt.sign(
                { id: `usr-${role}`, email: 'user@test.org', role },
                CURRENT_JWT_SECRET,
                { expiresIn: '15m' }
            );

            const req = { headers: { authorization: `Bearer ${token}` } };
            const res = createMockRes();
            let nextCalled = false;

            await verifyToken(req, res, () => { nextCalled = true; });

            assert.equal(nextCalled, true);
            assert.equal(
                req.user.role,
                'Employee',
                `Role '${role}' matching 'admin' as substring must not grant Admin role; should fallback to Employee`
            );
        }
    });

    it('throws at startup if JWT_SECRET is missing in authMiddleware', async () => {
        const { spawnSync } = await import('node:child_process');
        
        const script = `
            process.env.JWT_SECRET = '';
            try {
                require('./middleware/authMiddleware.js');
                console.log('DID_NOT_THROW');
            } catch (err) {
                console.log('THREW:' + err.message);
            }
        `;

        const result = spawnSync('node', ['-e', script], {
            cwd: process.cwd(),
            encoding: 'utf-8'
        });

        assert.match(result.stdout, /THREW:JWT_SECRET environment variable is missing/);
    });

    it('throws at startup if JWT_SECRET or REFRESH_SECRET is missing in authController', async () => {
        const { spawnSync } = await import('node:child_process');

        // Test missing JWT_SECRET
        const script1 = `
            process.env.JWT_SECRET = '';
            process.env.REFRESH_SECRET = 'some-valid-refresh-secret';
            try {
                require('./controllers/authController.js');
                console.log('DID_NOT_THROW');
            } catch (err) {
                console.log('THREW_JWT:' + err.message);
            }
        `;

        const result1 = spawnSync('node', ['-e', script1], {
            cwd: process.cwd(),
            encoding: 'utf-8'
        });

        assert.match(result1.stdout, /THREW_JWT:JWT_SECRET environment variable is missing/);

        // Test missing REFRESH_SECRET
        const script2 = `
            process.env.JWT_SECRET = 'some-valid-jwt-secret';
            process.env.REFRESH_SECRET = '';
            try {
                require('./controllers/authController.js');
                console.log('DID_NOT_THROW');
            } catch (err) {
                console.log('THREW_REFRESH:' + err.message);
            }
        `;

        const result2 = spawnSync('node', ['-e', script2], {
            cwd: process.cwd(),
            encoding: 'utf-8'
        });

        assert.match(result2.stdout, /THREW_REFRESH:REFRESH_SECRET environment variable is missing/);
    });
});
