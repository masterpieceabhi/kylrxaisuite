// The older India-era API modules are closed to US/CA companies and on servers that do not serve India, and the worst
// holes found in the 2026-11-20 audit stay closed for India companies too.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// A stand-in organizations collection, put in place before the gate loads it
const ORGS = { org_in: { country: 'India' }, org_us: { country: 'United States' }, org_ca: { Country: 'Canada' }, org_old: {} };
const fb = require('../config/firebase.js');
fb.rawCollection = (name) => ({
    doc: (id) => ({ get: async () => ({ exists: name === 'organizations' && id in ORGS, data: () => ORGS[id] }) })
});
const { indiaOnlyCheck } = require('../middleware/india-only-modules.js');

async function run(orgId) {
    let passed = false; let status = null; let body = null;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    await indiaOnlyCheck({ user: { id: 'u', orgId } }, res, () => { passed = true; });
    return { passed, status, body };
}

test('on a server for every country: India companies pass, US and Canada companies are refused', async () => {
    const saved = process.env.SERVED_COUNTRIES;
    delete process.env.SERVED_COUNTRIES;
    try {
        assert.equal((await run('org_in')).passed, true);
        assert.equal((await run('org_old')).passed, true, 'a company without a country is treated as India, as everywhere else');
        for (const org of ['org_us', 'org_ca']) {
            const r = await run(org);
            assert.equal(r.passed, false, org);
            assert.equal(r.status, 403);
            assert.equal(r.body.code, 'not_for_this_country');
        }
        assert.equal((await run(null)).passed, false, 'no company, no entry');
        assert.equal((await run('org_missing')).passed, true, 'an unknown company record counts as India (same default as the rest of the app)');
    } finally { if (saved === undefined) delete process.env.SERVED_COUNTRIES; else process.env.SERVED_COUNTRIES = saved; }
});

test('a server that does not serve India refuses these modules for everyone', async () => {
    const saved = process.env.SERVED_COUNTRIES;
    process.env.SERVED_COUNTRIES = 'US';
    try {
        for (const org of ['org_in', 'org_us', 'org_old']) assert.equal((await run(org)).status, 403, org);
        process.env.SERVED_COUNTRIES = 'IN,US';
        assert.equal((await run('org_in')).passed, true);
    } finally { if (saved === undefined) delete process.env.SERVED_COUNTRIES; else process.env.SERVED_COUNTRIES = saved; }
});

test('every older module is mounted behind the gate', () => {
    const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    for (const p of ['/api/admin', '/api/email', '/api/assignments', '/api/alerts', '/api/central-dashboard', '/api/document-templates', '/api/hr-os', '/api/custom-templates', '/api/bulk-trigger', '/api/controls-acceptance', '/api/reconciliation', '/api/v1/compliance']) {
        assert.match(server, new RegExp(`use\\(["']${p.replace(/\//g, '\\/')}["'], indiaOnly, `), p);
    }
});

test('changing a person\'s role and pay needs owner or HR, and a person of the caller\'s own company', () => {
    const src = fs.readFileSync(new URL('../routes/hr-os.js', import.meta.url), 'utf8');
    assert.match(src, /router\.post\('\/convert-employee', authorize\(ADMIN_HR_ROLES\), /);
    assert.match(src, /target\.data\(\)\.orgId !== callerOrg/);
});

test('free-form and test email need owner or HR', () => {
    const src = fs.readFileSync(new URL('../routes/email.js', import.meta.url), 'utf8');
    for (const p of ['send', 'test', 'run-reminder-check']) assert.match(src, new RegExp(`router\\.post\\('\\/${p}', authorize\\(ADMIN_HR_ROLES\\), `), p);
});

test('the admin controller never takes the company from the request', () => {
    const src = fs.readFileSync(new URL('../controllers/adminController.js', import.meta.url), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /req\.(query|body)\.orgId|x-org-id|'org_kylrx'/);
});
