// Shared by the tests/us-*-permissions.test.mjs files: runs the permission check that guards a route for a role,
// and starts a small real server (in-memory database, real sign-in tokens) for the checks made inside a handler.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const ROLES = ['super_admin', 'hr_admin', 'payroll_admin', 'manager', 'employee', 'accountant', 'auditor', 'executive'];
export const OWNER_HR = ['super_admin', 'hr_admin'];
export const OWNER_HR_AUDITOR = ['super_admin', 'hr_admin', 'auditor'];

/** allowed(method, path, role): does the first handler of the route (the permission check) let this role through? */
export function guardChecker(router, requireUsOrg) {
    return function allowed(method, path, role) {
        const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
        assert.ok(layer, `route ${method} ${path} exists`);
        const guard = layer.route.stack[0].handle;
        assert.notEqual(guard, requireUsOrg, `${method} ${path} has a permission check before the company lookup`);
        let passed = false; let status = null; let body = null;
        const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
        guard({ user: { id: 'u1', role } }, res, () => { passed = true; });
        if (!passed) { assert.equal(status, 403, `${role} ${method} ${path}`); assert.equal(body.success, false); assert.equal(typeof body.error, 'string'); }
        return passed;
    };
}

/** Every route of a router as "method path", sorted */
export const routeList = (router) => router.stack.filter((l) => l.route).map((l) => `${Object.keys(l.route.methods)[0]} ${l.route.path}`).sort();

/** The first handler of these routes is the company lookup: who may use them is decided inside the handler */
export function assertOpenRoutes(router, requireUsOrg, open) {
    for (const key of open) {
        const [method, path] = key.split(' ');
        const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
        assert.ok(layer, `route ${key} exists`);
        assert.equal(layer.route.stack[0].handle, requireUsOrg, `${key} starts with the company lookup`);
    }
}

/** A real server with the router mounted on /api/us; call(method, path, userId, body) signs in as that stored person */
export async function startServer(...routers) {
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const app = express(); app.use(express.json());
    for (const r of routers) app.use('/api/us', r);
    app.use((err, req, res, next) => { res.status(500).json({ success: false, error: err.message }); next; }); // eslint-disable-line no-unused-expressions
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: 600 });
    async function call(method, path, id, body) {
        const form = typeof FormData !== 'undefined' && body instanceof FormData;
        const res = await fetch(`${base}/api/us${path}`, {
            method, headers: { ...(id ? { Authorization: `Bearer ${tokenFor(id)}` } : {}), ...(body !== undefined && !form ? { 'Content-Type': 'application/json' } : {}) },
            body: body === undefined ? undefined : form ? body : JSON.stringify(body)
        });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        return { status: res.status, body: json, text, headers: res.headers };
    }
    // the short wait lets sockets finish closing: on Windows a forced exit (--test-force-exit) during that crashes Node
    const stop = async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 300)); };
    return { call, stop, base };
}

/** Two US companies and an India company, with one person per role in company A (ids like "hr_adminA") */
export async function seedCompanies(db, mem) {
    mem.reset();
    await db.collection('organizations').doc('orgA').set({ name: 'Acme Inc', country: 'United States', timezone: 'America/Chicago' });
    await db.collection('organizations').doc('orgB').set({ name: 'Bravo LLC', country: 'United States', timezone: 'America/Chicago' });
    await db.collection('organizations').doc('orgIN').set({ name: 'India Co', country: 'IN' });
    const person = (id, orgId, role, name, extra = {}) => db.collection('users').doc(id).set({ orgId, role, name, email: `${id}@example.com`, employeeId: id.toUpperCase(), status: 'Active', ...extra });
    for (const role of ROLES) await person(`${role}A`, 'orgA', role, `${role} of Acme`);
    await person('workerA', 'orgA', 'employee', 'Ada Lovelace');
    await person('hrB', 'orgB', 'hr_admin', 'Hugo HR'); await person('workerB', 'orgB', 'employee', 'Bo Li'); await person('saIN', 'orgIN', 'super_admin', 'India Admin');
    return { person };
}
