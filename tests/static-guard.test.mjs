import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guard = require('../middleware/static-guard.js');
const { pagesAndAssets } = require('../scripts/static-audit.js');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('server code, settings, rules, scripts, data and logs are never served', () => {
    for (const p of ['/server.js', '/package.json', '/package-lock.json', '/firebase.json', '/firestore.rules', '/storage.rules', '/firestore.indexes.json', '/ids.json', '/README.md', '/firebase-debug.log',
        '/logs/errors.jsonl', '/logs/run-session.txt', '/config/firebase.js', '/config/tenant.js', '/routes/us-hr.js', '/middleware/authMiddleware.js', '/scripts/seed-emulator.js', '/tests/permissions.test.mjs',
        '/docs/SECURITY.md', '/data/messages_store.json', '/functions/index.js', '/node_modules/express/package.json', '/services/pii-crypto.js', '/services/gusto/client.js', '/services/permissions.js',
        '/utils/reminder-scheduler.js', '/kylrx_ai_engine.py', '/test.mjs', '/test_email_nandan.js', '/test_onboarding_manifest.csv', '/check_hashes.js', '/trigger.js', '/seed_intelligence.js', '/scan_db.js',
        '/.env', '/.env.example', '/.git/config', '/.gitignore', '/.claude/settings.json', '/Sprint_Status_Report.doc', '/requirements.txt']) {
        assert.equal(guard.isBlocked(p), true, `${p} should be refused`);
    }
});

test('tricks with case, slashes, escapes and trailing dots do not get around it', () => {
    for (const p of ['/SERVER.JS', '/Logs/errors.jsonl', '/LOGS/ERRORS.JSONL', '/services/PII-crypto.js', '/config%2Ffirebase.js', '/%2e%2e/server.js', '/assets/../server.js', '/assets/..%2fconfig/firebase.js',
        '/services\\pii-crypto.js', '/logs%5Cerrors.jsonl', '//logs//errors.jsonl', '/./server.js', '/server.js.', '/server.js%20', '/package.json.', '/%2Eenv', '/services/gusto/../pii-crypto.js',
        '/services/employee-type-parser.js/../pii-crypto.js', '/%E0%A4%A', '/server.js%00.html']) {
        assert.equal(guard.isBlocked(p), true, `${p} should be refused`);
    }
});

test('pages, their scripts and styles, and the API are served', () => {
    for (const p of ['/', '/index.html', '/login.html', '/login.js', '/style-landing.css', '/logo.jpg', '/firebase-config.js', '/admin-us-policies.html', '/my-surveys.html', '/punch-fab.js', '/lucide.min.js', '/notification.mp3',
        '/assets/Templates.xlsx', '/public/js/admin-payroll-console.js', '/utils/xlsx.full.min.js', '/utils/Sortable.min.js', '/services/employee-type-parser.js', '/services/rbac-ui-controller.js',
        '/api/health', '/api/us/policies/mine', '/api/us/report-builder/options', '/api/logs/anything', '/reset-browser-data', '/oauth/authorize', '/scim/v2/Users']) {
        assert.equal(guard.isBlocked(p), false, `${p} should be served`);
    }
});

test('nothing that a page loads is blocked (add new browser files to ALLOWED in middleware/static-guard.js)', () => {
    const { pages, used } = pagesAndAssets(root);
    assert.ok(pages.length > 100, 'the pages were found');
    const blocked = used.filter((u) => guard.isBlocked(`/${u}`));
    assert.deepEqual(blocked, [], `These files are loaded by a page but the guard refuses them: ${blocked.join(', ')}`);
});

test('no page loads anything from a folder the guard refuses outright', () => {
    const { used } = pagesAndAssets(root);
    const from = [...new Set(used.filter((u) => u.includes('/')).map((u) => u.split('/')[0]))];
    assert.deepEqual(from.filter((f) => guard.DENIED_FOLDERS.has(f)), []);
});

test('the guard only acts on GET and HEAD, and passes everything else on', () => {
    const run = (method, p) => { let status = null; let passed = false; const res = { status(c) { status = c; return this; }, type() { return this; }, send() { return this; } }; guard({ method, path: p }, res, () => { passed = true; }); return { status, passed }; };
    assert.deepEqual(run('GET', '/server.js'), { status: 404, passed: false });
    assert.deepEqual(run('HEAD', '/logs/errors.jsonl'), { status: 404, passed: false });
    assert.deepEqual(run('GET', '/login.html'), { status: null, passed: true });
    assert.deepEqual(run('POST', '/api/auth/login'), { status: null, passed: true });
});
