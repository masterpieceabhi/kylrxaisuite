// The older India-era modules keep their stores per company: what one India company writes is never returned to,
// or changed by, another India company. Unit checks on the engines, plus source checks for the route-level filters.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const A = 'org_test_india_a';
const B = 'org_test_india_b';
const src = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const code = (p) => src(p).split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');

test('bulk trigger: jobs, audit trail and settings of one company are not seen by another', async () => {
    const engine = require('../services/bulk-trigger-engine.js');
    const a = engine.forOrg(A);
    const b = engine.forOrg(B);
    assert.notEqual(a, b);
    assert.equal(engine.forOrg(A), a, 'one engine per company, reused');
    assert.throws(() => engine.forOrg(null), /company is required/);

    const job = await a.executeBulkTrigger({
        action: 'CUSTOM_WORKFLOW',
        recipients: [{ id: 'p1', email: 'p1@example.com', name: 'P One' }, { id: 'p2', email: 'p2@example.com', name: 'P Two' }],
        actor: { role: 'super_admin', name: 'Admin A' },
        options: { skipDelay: true }
    });
    assert.equal(a.getJobStatus(job.jobId).jobId, job.jobId);
    assert.equal(b.getJobStatus(job.jobId), null, 'B cannot read A\'s job');
    assert.equal(b.getLatestJob(), null);
    assert.deepEqual(b.getRecentJobs(10), []);
    assert.ok(a.getAuditLogs({}).length >= 1);
    assert.deepEqual(b.getAuditLogs({}), [], 'B sees none of A\'s audit trail');
    await assert.rejects(() => b.retryFailedItems(job.jobId, { name: 'B' }), /not found/, 'B cannot retry A\'s job');

    a.updateConfig({ batchSize: 7 }, { role: 'super_admin', name: 'Admin A' });
    assert.equal(a.getConfig().batchSize, 7);
    assert.equal(b.getConfig().batchSize, 20, 'A\'s settings do not change B\'s');
    assert.equal(a.configDocId(), `${A}__bulk_trigger_config`);
    assert.notEqual(a.configDocId(), b.configDocId());
});

test('bulk trigger: recipients come only from the caller\'s own company', async () => {
    const admin = require('../config/firebase-admin.js');
    const { db } = require('../config/firebase.js');
    if (admin.apps.length) return; // only against the in-memory database, never a real one
    await db.collection('users').doc('pc_user_a').set({ orgId: A, email: 'a.person@example.com', name: 'A Person' });
    await db.collection('users').doc('pc_user_b').set({ orgId: B, email: 'b.person@example.com', name: 'B Person' });
    await db.collection('employees').doc('pc_emp_b').set({ orgId: B, email: 'b.emp@example.com', name: 'B Employee' });

    const engine = require('../services/bulk-trigger-engine.js');
    const got = await engine.forOrg(A).fetchRecipientsFromFirestore(100, 'live');
    const emails = got.recipients.map((r) => r.email);
    assert.ok(emails.includes('a.person@example.com'));
    assert.ok(!emails.includes('b.person@example.com') && !emails.includes('b.emp@example.com'), 'no people of company B');
    const none = await engine.fetchRecipientsFromFirestore(100, 'live');
    assert.equal(none.count, 0, 'an engine without a company reads no people');
});

test('document templates: versions and generated documents are per company', async () => {
    const engine = require('../services/document-template-engine.js');
    const a = engine.forOrg(A);
    const b = engine.forOrg(B);
    assert.notEqual(a, b);
    assert.throws(() => engine.forOrg(''), /company is required/);
    const tpl = a.listTemplates()[0];

    a.createTemplateVersion(tpl.key, { versionNumber: 'v9.9-a', templateBody: '<p>A only {{employee.name}}</p>', createdBy: 'A' });
    assert.ok(a.getTemplate(tpl.key).versions.some((v) => v.versionNumber === 'v9.9-a'));
    assert.ok(!b.getTemplate(tpl.key).versions.some((v) => v.versionNumber === 'v9.9-a'), 'B does not get A\'s version');

    const doc = await a.generateDocument(tpl.key, { employee: { name: 'Asha', code: 'A-1' } }, { callerModule: tpl.permittedModules[0] });
    assert.equal(a.getGeneratedDocument(doc.docId).docId, doc.docId);
    assert.throws(() => b.getGeneratedDocument(doc.docId), /not found/, 'B cannot open A\'s document');
    assert.deepEqual(b.listGeneratedDocuments({}), []);
});

test('custom templates: a company\'s templates and changes stay its own', () => {
    const engine = require('../services/custom-template-engine.js');
    const a = engine.forOrg(A);
    const b = engine.forOrg(B);
    assert.notEqual(a, b);

    const created = a.createTemplate({ name: 'A private template', module: 'goals' }, { name: 'A HR', role: 'hr_admin' });
    assert.equal(a.getTemplate(created.id).name, 'A private template');
    assert.throws(() => b.getTemplate(created.id), 'B cannot open A\'s template');
    assert.ok(!b.listTemplates({}).some((t) => t.id === created.id));

    const standard = b.listTemplates({})[0];
    a.archiveTemplate(standard.id, { name: 'A HR', role: 'super_admin' }, 'not for us');
    assert.equal(a.getTemplate(standard.id).status, 'archived');
    assert.notEqual(b.getTemplate(standard.id).status, 'archived', 'A archiving a standard template does not archive it for B');
});

test('controls and sign-off: decisions and certificates are per company', () => {
    const service = require('../services/controls-acceptance-service.js');
    const a = service.forOrg(A);
    const b = service.forOrg(B);
    assert.notEqual(a, b);
    const id = a.getAllClientDecisions()[0].id;
    a.recordClientDecision(id, { notes: 'A decided' }, { name: 'A rep' });
    assert.equal(a.getClientDecisionById(id).status, 'confirmed');
    assert.notEqual(b.getClientDecisionById(id).status, 'confirmed', 'A\'s decision does not confirm B\'s');

    a.recordClientApproval({ representativeName: 'A Rep', representativeTitle: 'Director' });
    assert.equal(a.getAllSignOffRecords().length, 1);
    assert.deepEqual(b.getAllSignOffRecords(), [], 'B sees none of A\'s sign-offs');
    assert.equal(b.getLatestSignOff(), null);
    assert.equal(a.templateEngine, require('../services/custom-template-engine.js').forOrg(A), 'checks use the company\'s own engines');
    assert.equal(a.bulkEngine, require('../services/bulk-trigger-engine.js').forOrg(A));
});

test('reconciliation: runs and exceptions are kept per company', async () => {
    const { reconciliationFor } = await import('../routes/reconciliation.mjs');
    const a = reconciliationFor(A);
    const b = reconciliationFor(B);
    assert.notEqual(a.store, b.store);
    assert.equal(reconciliationFor(A), a);
    await a.store.saveExceptionQueueEntry({ exception_id: 'EXC-A-1', batch_id: 'BATCH-1', status: 'OPEN' });
    await a.store.saveReconciliationRun({ reconciliation_run_id: 'RUN-A-1' });
    assert.ok(await a.store.getExceptionById('EXC-A-1'));
    assert.equal(await b.store.getExceptionById('EXC-A-1'), null);
    assert.deepEqual(await b.store.listAllExceptionsByBatch('BATCH-1'), []);
    assert.equal(await b.store.getReconciliationRun('RUN-A-1'), null);
    assert.throws(() => reconciliationFor(null), /company is required/);
});

test('unified compliance: one orchestrator per company, documents tagged and namespaced', async () => {
    const { orchestratorFor } = await import('../routes/unified-compliance.mjs');
    const a = orchestratorFor(A);
    const b = orchestratorFor(B);
    assert.notEqual(a, b);
    a.sharedExceptionsStore.set('EXC-A', { exception_id: 'EXC-A', scheme: 'ESIC', source_payroll_id: 'PR-1', resolved: false });
    assert.equal(b.getSharedExceptions({}, { mask: false }).total_count, 0, 'B sees none of A\'s exceptions');
    assert.equal((await b.resolveSharedException('EXC-A', {})).success, false, 'B cannot resolve A\'s exception');
    assert.equal(b.getStagingRecords('PR-1', { mask: false }).total_exceptions, 0);

    const { UnifiedStatutoryOrchestrator } = await import('../services/unified-statutory-orchestration-service.mjs');
    const writes = [];
    let listened = false;
    const fakeDb = {
        collection: (name) => ({
            where: () => ({ onSnapshot: () => { listened = true; } }),
            onSnapshot: () => { listened = true; },
            doc: (id) => ({ set: async (data) => { writes.push({ name, id, data }); } })
        })
    };
    const o = new UnifiedStatutoryOrchestrator({ orgId: A, firestoreDb: fakeDb, listen: false });
    await o.writeToFirestore('statutory_exceptions', 'EXC-1', { v: 1 });
    assert.equal(listened, false, 'a company orchestrator does not listen to every company\'s payroll runs');
    assert.deepEqual(writes[0], { name: 'statutory_exceptions', id: `${A}__EXC-1`, data: { v: 1, orgId: A } });
});

test('routes: every module takes the company from the signed-in user and refuses an account without one', () => {
    const routes = ['routes/bulk-trigger.js', 'routes/document-templates.js', 'routes/custom-templates.js', 'routes/alerts.js',
        'routes/assignments.js', 'routes/hr-os.js', 'routes/reconciliation.mjs', 'routes/unified-compliance.mjs', 'routes/controls-acceptance.js'];
    for (const r of routes) {
        const c = code(r);
        assert.match(c, /\(req\.user && req\.user\.orgId\) \|\| req\.tenantOrgId/, r);
        assert.match(c, /status\(403\)/, `${r} refuses an account without a company`);
        assert.doesNotMatch(c, /req\.(query|body)\??\.(orgId|organization_id)|x-org-id/, `${r} never takes the company from the request`);
    }
    // Routes call the per-company engines, never the shared default instance
    assert.doesNotMatch(code('routes/bulk-trigger.js'), /bulkTriggerEngine\.(?!forOrg)\w+\(/);
    assert.doesNotMatch(code('routes/document-templates.js'), /documentTemplateEngine\.(?!forOrg)\w+\(/);
    assert.doesNotMatch(code('routes/custom-templates.js'), /customTemplateEngine\.(?!forOrg)\w+\(/);
    assert.doesNotMatch(code('routes/controls-acceptance.js'), /controlsAcceptanceService\.(?!forOrg)\w+\(/);
    assert.doesNotMatch(code('routes/unified-compliance.mjs'), /globalUnifiedStatutoryOrchestrator/);
    assert.doesNotMatch(code('routes/reconciliation.mjs'), /^const (store|engine) = new/m);
});

test('routes: Firestore reads are filtered by the company', () => {
    const engine = code('services/bulk-trigger-engine.js');
    assert.doesNotMatch(engine, /collection\('(users|employees|bulk_trigger_jobs|bulk_trigger_audit_logs)'\)\.(limit|orderBy|get)\(/, 'no unfiltered reads');
    assert.match(engine, /orgSnap\('users'/);
    assert.match(engine, /orgSnap\('employees'/);

    const assignments = code('routes/assignments.js');
    assert.doesNotMatch(assignments, /collection\('(employee_assignments|assignment_rules)'\)\.limit\(/);
    assert.match(assignments, /orgDocs\(rawCollection, 'employee_assignments', orgId/);
    assert.match(assignments, /getMatrixRules\(\)\.filter\(r => !r\.orgId \|\| r\.orgId === orgId\)/);

    const alerts = code('routes/alerts.js');
    assert.match(alerts, /rulesCount = \(await orgDocs\(rawCollection, 'alert_rules', orgId/, 'status counts only the company\'s rules');
    assert.match(alerts, /breachesCount = \(await orgDocs\(rawCollection, 'alert_breaches', orgId/);
    assert.match(alerts, /\(await orgRules\(orgId\)\)\.filter\(r => !r\.isTemplate\)/, 'sync writes back only the company\'s own rules');
    assert.match(alerts, /filter\(l => ownsEngineLog\(orgId, l\)\)/, 'stats show only the company\'s own alert runs');
    assert.match(alerts, /automationEngine\.executeRule\(/, 'test-fire runs only the company\'s rule');
    assert.doesNotMatch(alerts, /automationEngine\.processEvent\(/);

    const dashboard = code('routes/central-dashboard.js');
    assert.doesNotMatch(dashboard, /db\.collection\(t\)\.limit\(/);
});

test('hr-os: the conversion store keeps counters and audit events per company', () => {
    const c = code('routes/hr-os.js');
    assert.match(c, /all\.orgs\[orgId\]/);
    assert.match(c, /readStore\(callerOrgOf\(req\)\)/, 'audit events come from the caller\'s own section');
    assert.doesNotMatch(c, /readStore\(\)/);
    assert.match(c, /counterDocId\(orgId, counterKey\)/);
    for (const r of ["get\\('\\/audit-events', requireOrg", "post\\('\\/generate-code', requireOrg", "post\\('\\/convert-employee', authorize\\(ADMIN_HR_ROLES\\), requireOrg"]) {
        assert.match(c, new RegExp(`router\\.${r}`), r);
    }
});

test('approving template versions and signing off controls need owner or HR', () => {
    const docs = fs.readFileSync(new URL('../routes/document-templates.js', import.meta.url), 'utf8');
    for (const p of ["'/:key/versions'", "'/:key/versions/:versionNumber/approve'"]) assert.ok(docs.includes(`router.post(${p}, authorize(ADMIN_HR_ROLES)`), p);
    const ctl = fs.readFileSync(new URL('../routes/controls-acceptance.js', import.meta.url), 'utf8');
    for (const p of ["'/decisions/:id'", "'/decisions/batch-confirm'", "'/sign-off'"]) assert.ok(ctl.includes(`router.post(${p}, authorize(ADMIN_HR_ROLES)`), p);
});
