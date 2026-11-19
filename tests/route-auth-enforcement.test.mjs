import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import jwt from 'jsonwebtoken';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Run on the full in-memory database. Without a database the payslip download answers 503 ("not configured") before it
// looks at who is asking, so the "another employee's payslip is 403" check below could never be reached.
require('./helpers/memory-firestore.js').install();
const { app, dynamicRoutesLoaded } = require('../server.js');

const JWT_SECRET = process.env.JWT_SECRET || 'kylrx_production_jwt_secret_key_v2_2026_secured';

describe('Global Route Authentication & RBAC Enforcement Suite', () => {
    let server;
    let baseUrl;
    let allRoutes = [];

    // The explicit exempt routes according to security specification:
    // POST /api/auth/login, POST /api/auth/signup, POST /api/auth/refresh-token, GET /api/health
    // POST /api/auth/register-organization is the public "create a company" sign-up, added after this list was written
    // (routes/auth.js mounts it next to /signup, behind the same rate limiter).
    const EXEMPT_ROUTES = new Set([
        'POST /api/auth/login',
        'POST /api/auth/signup',
        'POST /api/auth/register-organization',
        'POST /api/auth/refresh-token',
        // which countries this server takes and where the others sign up: asked before anyone has an account, and it
        // holds nothing about any company or person (services/served-countries.js)
        'GET /api/auth/region',
        'GET /api/health'
    ]);

    before(async () => {
        // Ensure all dynamically loaded routers are mounted
        if (dynamicRoutesLoaded) {
            await dynamicRoutesLoaded;
        }

        // Start ephemeral HTTP server on random free port
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        // Dynamically load all module routers (both CJS and ESM)
        const recon = (await import('../routes/reconciliation.mjs')).default;
        const esic = (await import('../routes/esic.mjs')).default;
        const gratuity = (await import('../routes/gratuity.mjs')).default;
        const nps = (await import('../routes/nps.mjs')).default;
        const compliance = (await import('../routes/unified-compliance.mjs')).default;
        const pf = (await import('../routes/pf-compliance.mjs')).default;

        const mounts = [
            { prefix: '/api/auth', router: require('../routes/auth.js') },
            { prefix: '/api/data', router: require('../routes/data.js') },
            { prefix: '/api/notifications', router: require('../routes/notifications.js') },
            { prefix: '/api/admin', router: require('../routes/admin.js') },
            { prefix: '/api/messages', router: require('../routes/messages.js') },
            { prefix: '/api/ai', router: require('../routes/ai.js') },
            { prefix: '/api/payroll', router: require('../routes/payroll.js') },
            { prefix: '/api/email', router: require('../routes/email.js') },
            { prefix: '/api/automations', router: require('../routes/automation.js') },
            { prefix: '/api/assignments', router: require('../routes/assignments.js') },
            { prefix: '/api/alerts', router: require('../routes/alerts.js') },
            { prefix: '/api/analytics', router: require('../routes/analytics.js') },
            { prefix: '/api/central-dashboard', router: require('../routes/central-dashboard.js') },
            { prefix: '/api/tasks', router: require('../routes/tasks.js') },
            { prefix: '/api/notification-center', router: require('../routes/notification-center.js') },
            { prefix: '/api/document-templates', router: require('../routes/document-templates.js') },
            { prefix: '/api/workflow-builder', router: require('../routes/workflow-builder.js') },
            { prefix: '/api/integrations', router: require('../routes/integrations.js') },
            { prefix: '/api/hr-os', router: require('../routes/hr-os.js') },
            { prefix: '/api/policies', router: require('../routes/policies.js') },
            { prefix: '/api/assets', router: require('../routes/assets.js') },
            { prefix: '/api/manager-goals', router: require('../routes/manager-goals.js') },
            { prefix: '/api/employee-goals', router: require('../routes/employee-goals.js') },
            { prefix: '/api/custom-templates', router: require('../routes/custom-templates.js') },
            { prefix: '/api/bulk-trigger', router: require('../routes/bulk-trigger.js') },
            { prefix: '/api/payroll-settings', router: require('../routes/payroll-settings.js') },
            { prefix: '/api/controls-acceptance', router: require('../routes/controls-acceptance.js') },
            // US HR routers that hold people's paperwork, documents and compliance records
            { prefix: '/api/us', router: require('../routes/us-hr.js') },
            { prefix: '/api/us', router: require('../routes/us-forms.js') },
            { prefix: '/api/us', router: require('../routes/us-vault.js') },
            { prefix: '/api/us', router: require('../routes/us-compliance.js') },
            { prefix: '/api/us', router: require('../routes/us-checklists.js') },
            { prefix: '/api/us', router: require('../routes/us-offboarding.js') },
            { prefix: '/api/reconciliation', router: recon },
            { prefix: '/api/esic', router: esic },
            { prefix: '/api/gratuity', router: gratuity },
            { prefix: '/api/nps', router: nps },
            { prefix: '/api/compliance', router: compliance },
            { prefix: '/api/pf', router: pf }
        ];

        // Collect all distinct registered routes
        const seen = new Set();
        for (const m of mounts) {
            for (const layer of m.router.stack) {
                if (layer.route) {
                    const rawPaths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
                    const methods = Object.keys(layer.route.methods || {}).map((meth) => meth.toUpperCase());

                    for (const rawPath of rawPaths) {
                        for (const method of methods) {
                            const fullPath = (m.prefix + (rawPath || '')).replace(/\/+/g, '/');
                            const key = `${method} ${fullPath}`;
                            if (!seen.has(key)) {
                                seen.add(key);
                                allRoutes.push({ method, path: fullPath, key });
                            }
                        }
                    }
                }
            }
        }

        // Add top-level routes mounted directly on app
        const appRoutes = [
            { method: 'GET', path: '/api/health', key: 'GET /api/health' },
            { method: 'GET', path: '/api/firebase/status', key: 'GET /api/firebase/status' }
        ];
        for (const ar of appRoutes) {
            if (!seen.has(ar.key)) {
                seen.add(ar.key);
                allRoutes.push(ar);
            }
        }
    });

    after(async () => {
        if (server && server.close) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('discovered registered routes across all modules', () => {
        assert.ok(allRoutes.length > 50, `Expected > 50 registered routes, found ${allRoutes.length}`);
    });

    it('verifies that the explicitly exempt routes do not return 401 without token', async () => {
        for (const exemptKey of EXEMPT_ROUTES) {
            const [method, routePath] = exemptKey.split(' ');
            const res = await fetch(`${baseUrl}${routePath}`, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: method === 'POST' ? JSON.stringify({}) : undefined
            });

            assert.notEqual(
                res.status,
                401,
                `Exempt route ${exemptKey} returned 401, but it should be publicly accessible`
            );
        }
    });

    it('loops over all registered routes and asserts a request without a token returns 401', async () => {
        const failures = [];

        for (const r of allRoutes) {
            if (EXEMPT_ROUTES.has(r.key)) {
                continue; // Skip explicitly permitted public endpoints
            }

            // Replace dynamic route parameters like :id, :email, :batchId with test tokens
            const resolvedPath = r.path
                .replace(/:[a-zA-Z0-9_]+/g, 'test-param-123')
                .replace(/\/{2,}/g, '/');

            try {
                const res = await fetch(`${baseUrl}${resolvedPath}`, {
                    method: r.method,
                    headers: { 'Content-Type': 'application/json' },
                    body: ['POST', 'PUT', 'PATCH'].includes(r.method) ? JSON.stringify({}) : undefined
                });

                if (res.status !== 401) {
                    failures.push({
                        key: r.key,
                        url: resolvedPath,
                        status: res.status
                    });
                }
            } catch (err) {
                failures.push({
                    key: r.key,
                    url: resolvedPath,
                    error: err.message
                });
            }
        }

        assert.equal(
            failures.length,
            0,
            `The following ${failures.length} routes did NOT return 401 without token:\n` +
            failures.map((f) => ` - [${f.status || 'ERR'}] ${f.key} (${f.url})`).join('\n')
        );
    });

    it('protects /api/auth/unlock/:email with Admin authorization', async () => {
        // 1. Without token -> 401
        const resNoToken = await fetch(`${baseUrl}/api/auth/unlock/test@example.com`);
        assert.equal(resNoToken.status, 401, 'No token should return 401 on /unlock/:email');

        // 2. With Employee token -> 403
        const employeeToken = jwt.sign(
            { id: 'emp-user-1', email: 'emp@example.com', role: 'Employee' },
            JWT_SECRET,
            { expiresIn: '15m' }
        );
        const resEmployee = await fetch(`${baseUrl}/api/auth/unlock/test@example.com`, {
            headers: { Authorization: `Bearer ${employeeToken}` }
        });
        assert.equal(resEmployee.status, 403, 'Employee token should return 403 on /unlock/:email');

        // 3. With Admin token -> not 401 or 403 (allowed to hit handler)
        const adminToken = jwt.sign(
            { id: 'admin-user-1', email: 'admin@example.com', role: 'Admin' },
            JWT_SECRET,
            { expiresIn: '15m' }
        );
        const resAdmin = await fetch(`${baseUrl}/api/auth/unlock/nonexistent@example.com`, {
            headers: { Authorization: `Bearer ${adminToken}` }
        });
        assert.notEqual(resAdmin.status, 401);
        assert.notEqual(resAdmin.status, 403);
    });

    it('verifies that routes/messages.js requires verifyToken (optionalAuth removed)', async () => {
        const endpoints = [
            { method: 'GET', path: '/api/messages/usr_target' },
            { method: 'GET', path: '/api/messages/thread/chat_123' },
            { method: 'POST', path: '/api/messages/send' }
        ];

        for (const ep of endpoints) {
            const res = await fetch(`${baseUrl}${ep.path}`, {
                method: ep.method,
                headers: { 'Content-Type': 'application/json' },
                body: ep.method === 'POST' ? JSON.stringify({ message: 'Hello' }) : undefined
            });
            assert.equal(res.status, 401, `${ep.method} ${ep.path} must return 401 without token`);
        }
    });

    it('verifies route groups require Admin/HR roles and reject Employee role with 403', async () => {
        const employeeToken = jwt.sign(
            { id: 'emp-test-99', email: 'emp@example.com', role: 'Employee' },
            JWT_SECRET,
            { expiresIn: '15m' }
        );

        const privilegedRoutes = [
            { method: 'GET', path: '/api/policies' },
            { method: 'GET', path: '/api/workflow-builder/node-types' },
            { method: 'GET', path: '/api/custom-templates' },
            { method: 'GET', path: '/api/bulk-trigger/jobs/job-1' },
            { method: 'GET', path: '/api/payroll-settings/rules' },
            { method: 'GET', path: '/api/reconciliation/finance-ops/review-items' },
            { method: 'GET', path: '/api/pf/template' },
            { method: 'GET', path: '/api/esic/template' },
            { method: 'GET', path: '/api/nps/template' },
            { method: 'GET', path: '/api/gratuity/template' },
            { method: 'GET', path: '/api/compliance/exceptions' }
        ];

        for (const route of privilegedRoutes) {
            const res = await fetch(`${baseUrl}${route.path}`, {
                method: route.method,
                headers: {
                    Authorization: `Bearer ${employeeToken}`,
                    'Content-Type': 'application/json'
                }
            });

            assert.equal(
                res.status,
                403,
                `Route ${route.method} ${route.path} must return 403 for Employee role`
            );
        }
    });

    it('enforces that employee-facing reads are restricted to req.user.id', async () => {
        const callerId = 'EMP-1001';
        const employeeToken = jwt.sign(
            { id: callerId, email: 'caller@example.com', role: 'Employee' },
            JWT_SECRET,
            { expiresIn: '15m' }
        );

        // 1. /api/payroll-settings/account-view/:employeeId
        // Own ID -> allowed (200 OK)
        const resOwnAccount = await fetch(`${baseUrl}/api/payroll-settings/account-view/${callerId}`, {
            headers: { Authorization: `Bearer ${employeeToken}` }
        });
        assert.notEqual(resOwnAccount.status, 403, 'Employee reading own account-view should not get 403');
        assert.equal(resOwnAccount.status, 200, 'Employee reading own account-view should return 200');

        // Other ID -> 403 Forbidden
        const resOtherAccount = await fetch(`${baseUrl}/api/payroll-settings/account-view/other-employee-id`, {
            headers: { Authorization: `Bearer ${employeeToken}` }
        });
        assert.equal(resOtherAccount.status, 403, 'Employee reading other employee account-view must return 403');

        // 2. /api/payroll/documents/:docId/download-url?employeeId=...
        const resOtherDownload = await fetch(
            `${baseUrl}/api/payroll/documents/doc-123/download-url?employeeId=other-employee-id`,
            { headers: { Authorization: `Bearer ${employeeToken}` } }
        );
        assert.equal(resOtherDownload.status, 403, 'Employee downloading other employee payslip must return 403');

        // 3. /api/payroll/employee/:employeeId/documents
        const resOtherDocs = await fetch(
            `${baseUrl}/api/payroll/employee/other-employee-id/documents`,
            { headers: { Authorization: `Bearer ${employeeToken}` } }
        );
        assert.equal(resOtherDocs.status, 403, 'Employee viewing other employee documents must return 403');
    });
});
