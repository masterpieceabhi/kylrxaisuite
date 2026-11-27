import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../services/privacy-rules.js');
const C = require('../services/audit-chain.js');
const M = require('../services/metrics.js');

test('deadlines: 45 days, one 45-day extension, SLA states', () => {
    const d = P.deadlines('2026-01-10T00:00:00.000Z');
    assert.equal(d.originalDueAt.slice(0, 10), '2026-02-24');
    assert.equal(P.deadlines('2026-01-10T00:00:00.000Z', {}, 1).dueAt.slice(0, 10), '2026-04-10');
    const req = { status: 'received', dueAt: d.dueAt, extensionsUsed: 0 };
    assert.equal(P.slaStatus(req, '2026-01-20T00:00:00.000Z').state, 'on_track');
    assert.equal(P.slaStatus(req, '2026-02-20T00:00:00.000Z').state, 'due_soon');
    assert.equal(P.slaStatus(req, '2026-03-01T00:00:00.000Z').state, 'overdue');
    assert.equal(P.slaStatus({ ...req, status: 'completed' }, '2026-03-01T00:00:00.000Z').state, 'closed');
    assert.equal(P.canExtend(req, '2026-02-01T00:00:00.000Z').ok, true);
    assert.equal(P.canExtend({ ...req, extensionsUsed: 1 }, '2026-02-01T00:00:00.000Z').ok, false);
    assert.equal(P.canExtend(req, '2026-03-01T00:00:00.000Z').ok, false);
    assert.equal(P.businessDaysAfter('2026-01-09', 10), '2026-01-23');
});

test('settings are editable and validated', () => {
    assert.equal(P.validateSettings({ responseDays: 30 }).value.responseDays, 30);
    assert.ok(P.validateSettings({ responseDays: 0 }).errors.length);
    const r = P.validateSettings({ retention: [{ key: 'time_punches', years: 5 }] });
    assert.equal(r.value.retention.find((x) => x.key === 'time_punches').years, 5);
    assert.ok(P.validateSettings({ retention: [{ key: 'time_punches', years: -1 }] }).errors.length);
});

test('request validation', () => {
    assert.ok(P.validateNewRequest({ type: 'nope' }).errors.length);
    assert.ok(P.validateNewRequest({ type: 'correct' }).errors.length);
    assert.deepEqual(P.validateNewRequest({ type: 'access' }).errors, []);
    assert.ok(P.validateNewRequest({ type: 'access' }, { onBehalf: true }).errors.length);
    assert.deepEqual(P.validateNewRequest({ type: 'access', onBehalfOf: 'u1', verification: { method: 'in_person', note: 'Saw photo ID' } }, { onBehalf: true }).errors, []);
});

const base = (over = {}) => ({ terminationDate: null, hireDate: '2024-02-01', counts: { optionalProfileFields: 3, consents: 1, eeo: 1, payrollForms: 2, i9: 1 }, punches: [{ id: 'p1', date: '2020-01-01' }, { id: 'p2', date: '2026-01-01' }], leave: [], osha: [], vault: [], audit: [{ date: '2026-02-01' }], privacyRequests: [], ...over });
const row = (plan, k) => plan.rows.find((r) => r.key === k);

test('deletion plan for a current employee keeps legal records and removes optional data', () => {
    const plan = P.planDeletion(base(), P.DEFAULT_RETENTION, '2026-06-01');
    assert.equal(plan.employmentActive, true);
    assert.equal(row(plan, 'profile_optional').action, 'delete');
    assert.equal(row(plan, 'consents').action, 'delete');
    assert.equal(row(plan, 'payroll_forms').action, 'retain');
    assert.equal(row(plan, 'i9').action, 'retain');
    assert.equal(row(plan, 'time_punches').action, 'partial');
    assert.deepEqual(row(plan, 'time_punches').deleteIds, ['p1']);
    assert.equal(row(plan, 'account').action, 'retain');
    assert.equal(row(plan, 'audit_logs').action, 'retain');
});

test('deletion plan after termination: dates, I-9 rule, hold and anonymization', () => {
    const t = base({ terminationDate: '2025-01-31', vault: [], punches: [] });
    const plan = P.planDeletion(t, P.DEFAULT_RETENTION, '2026-06-01');
    assert.equal(row(plan, 'payroll_forms').retainUntil, '2029-01-31');
    assert.equal(row(plan, 'i9').retainUntil, '2027-02-01'); // hire 2024-02-01 + 3y beats term + 1y
    assert.equal(row(plan, 'account').action, 'retain');
    const old = base({ terminationDate: '2015-01-31', hireDate: '2012-01-01', punches: [{ id: 'a', date: '2015-01-01' }], counts: { optionalProfileFields: 0, consents: 0, eeo: 1, payrollForms: 1, i9: 1 }, audit: [] });
    const p2 = P.planDeletion(old, P.DEFAULT_RETENTION, '2026-06-01');
    assert.equal(row(p2, 'payroll_forms').action, 'delete');
    assert.equal(row(p2, 'account').action, 'anonymize');
    const held = P.planDeletion({ ...old, vault: [{ id: 'v1', retainUntil: null, legalHold: true }] }, P.DEFAULT_RETENTION, '2026-06-01');
    assert.equal(row(held, 'vault_documents').action, 'retain');
    assert.equal(row(held, 'account').action, 'retain');
    assert.equal(held.legalHold, true);
});

test('access bundle never contains full SSN, bank numbers, secrets or EEO answers', () => {
    const b = P.buildAccessBundle({
        now: '2026-06-01T00:00:00Z',
        user: { id: 'u1', name: 'Ana Ruiz', employeeId: 'E1', password: 'x', passwordHash: 'y', usProfile: { legalFirstName: 'Ana', taxpayerIdEncrypted: 'v1:abc', taxpayerIdLast4: '6789' }, usForms: { directDeposit: { bankName: 'B', routingNumber: '111000025', accountNumberEncrypted: 'v1:zzz', accountLast4: '4321' }, i9: { section2: { listA: { number: 'A12345678', numberEncrypted: 'v1:q' } } } } },
        eeo: { sex: 'female', races: ['asian'], hispanic: 'no' }, punches: [], leave: [], documents: [{ title: 'Secret', confidential: true }], consents: [], audit: [], requests: []
    });
    const json = JSON.stringify(b);
    assert.ok(!json.includes('v1:'));
    assert.ok(!json.includes('111000025'));
    assert.ok(!json.includes('A12345678'));
    assert.ok(!/female|asian/.test(json));
    assert.ok(!json.includes('passwordHash'));
    assert.equal(b.profile.taxpayerId.masked, '***-**-6789');
    assert.equal(b.documents[0].title, '(confidential document)');
    assert.match(P.renderBundleHtml(b, 'es'), /Sus datos personales/);
});

test('audit chain detects edits, deletions and truncation', () => {
    const key = 'k'.repeat(32);
    const mk = (n) => { const out = []; let prev = C.GENESIS; for (let i = 1; i <= n; i++) { const e = C.seal({ at: `2026-01-0${i}T00:00:00Z`, action: `a${i}`, targetId: 't' }, prev, i, key); prev = e.chain.hash; out.push({ ...e, _id: `d${i}` }); } return out; };
    const ok = mk(5);
    assert.equal(C.verifyChain(ok, { key }).valid, true);
    const edited = ok.map((e) => ({ ...e })); edited[2].action = 'changed';
    const r1 = C.verifyChain(edited, { key });
    assert.equal(r1.valid, false); assert.equal(r1.firstBreak.seq, 3);
    const removed = ok.filter((e) => e.chain.seq !== 3);
    assert.equal(C.verifyChain(removed, { key }).valid, false);
    const head = { seq: 5, hash: ok[4].chain.hash };
    assert.equal(C.verifyChain(ok.slice(0, 4), { key, head }).headMismatch, true);
    assert.equal(C.verifyChain(ok, { key, head }).valid, true);
    assert.equal(C.verifyChain([{ action: 'x' }], { key }).chained, 0);
});

test('metrics registry renders Prometheus text with custom gauges', async () => {
    M.reset();
    M.counter('t_requests_total', 'help', { route: '/a"b' }); M.counter('t_requests_total', 'help', { route: '/a"b' });
    M.observe('t_seconds', 'h', { r: 'x' }, 0.03);
    M.registerGauge('t_queue', 'queue', () => 7);
    const out = await M.render();
    assert.match(out, /t_requests_total\{route="\/a\\"b"\} 2/);
    assert.match(out, /t_seconds_bucket\{r="x",le="0.05"\} 1/);
    assert.match(out, /t_queue 7/);
    assert.match(out, /# TYPE process_uptime_seconds gauge/);
});
