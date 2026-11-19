// Rules added on 2026-11-18: nobody decides their own request (unless nobody else could), sessions end when a role
// changes, a company may refuse punches saved offline, and privacy deletion covers the newer records.
// What this does NOT cover: the routes that apply these rules (run by hand and by the US end-to-end script against a
// local server with the emulators), and the manager's reach over open shifts, which lives in the route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-backend-rules';
process.env.NODE_ENV = 'test';
const require = createRequire(import.meta.url);
const own = require('../services/own-request.js');
const cutoff = require('../services/session-cutoff.js');
const timePolicy = require('../services/time-policy.js');

/* ------------------------------- deciding your own request ------------------------------- */

const P = (id, role, extra = {}) => ({ id, role, status: 'active', managerId: null, ...extra });

test('someone else could decide when another working person holds the permission, or is the person\'s manager', () => {
    const company = [P('owner', 'super_admin'), P('hr', 'hr_admin'), P('mgr', 'manager'), P('emp', 'employee', { managerId: 'mgr' })];
    assert.equal(own.someoneElseCould(company, 'owner', 'time.approve'), true, 'HR could approve the owner\'s hours');
    assert.equal(own.someoneElseCould(company, 'hr', 'leave.decide'), true, 'the owner could decide HR\'s time off');
    assert.equal(own.someoneElseCould(company, 'emp', 'time.approve'), true);
    // a sole owner: nobody else at all
    assert.equal(own.someoneElseCould([P('owner', 'super_admin')], 'owner', 'time.approve'), false);
    // an owner with only employees and a manager who cannot decide for the owner
    const small = [P('owner', 'super_admin'), P('mgr', 'manager'), P('emp', 'employee', { managerId: 'mgr' })];
    assert.equal(own.someoneElseCould(small, 'owner', 'time.approve'), false, 'a manager decides only for their own reports');
    assert.equal(own.someoneElseCould(small, 'owner', 'leave.decide'), false);
    assert.equal(own.someoneElseCould(small, 'mgr', 'time.approve'), true, 'the owner could decide the manager\'s');
    // the owner reports to someone (two founders): that person counts
    assert.equal(own.someoneElseCould([P('a', 'super_admin', { managerId: 'b' }), P('b', 'employee')], 'a', 'time.approve'), true);
    // people who have left do not count
    assert.equal(own.someoneElseCould([P('owner', 'super_admin'), P('hr', 'hr_admin', { status: 'Terminated' })], 'owner', 'time.approve'), false);
    assert.equal(own.someoneElseCould([P('owner', 'super_admin', { managerId: 'gone' }), P('gone', 'manager', { status: 'terminated' })], 'owner', 'time.approve'), false);
    assert.equal(own.someoneElseCould(null, 'owner', 'time.approve'), false);
});

test('a request that is not your own is not touched; your own is refused unless nobody else could decide it', async () => {
    const company = [P('owner', 'super_admin'), P('hr', 'hr_admin')];
    let loads = 0;
    const loadPeople = async () => { loads += 1; return company; };
    assert.deepEqual(await own.check({ orgId: 'o', user: { id: 'hr' }, targetUserId: 'emp', permission: 'time.approve', loadPeople }), { own: false });
    assert.equal(loads, 0, 'the people list is read only for an own request');
    const refused = await own.check({ orgId: 'o', user: { id: 'hr' }, targetUserId: 'hr', permission: 'time.approve', what: 'approve your own hours', loadPeople });
    assert.deepEqual([refused.own, refused.allowed, refused.error], [true, false, 'You cannot approve your own hours. Ask another person who can.']);
    const sole = await own.check({ orgId: 'o', user: { id: 'owner' }, targetUserId: 'owner', permission: 'time.approve', loadPeople: async () => [P('owner', 'super_admin'), P('emp', 'employee')] });
    assert.deepEqual(sole, { own: true, allowed: true });
    assert.deepEqual(await own.check({ orgId: 'o', user: null, targetUserId: 'x', permission: 'time.approve', loadPeople }), { own: false });
});

test('the route guard answers 403 itself, and marks an allowed own decision for the audit log', async () => {
    const stub = (rel, exports) => { const id = require.resolve(rel); const old = require.cache[id]; require.cache[id] = { id, filename: id, loaded: true, exports, children: [], paths: [] }; return () => { if (old) require.cache[id] = old; else delete require.cache[id]; }; };
    let rows = [];
    const undo = stub('../services/people-data-store.js', { listByOrg: async () => rows });
    try {
        const res = () => { const r = { code: 0, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
        rows = [{ id: 'hr', role: 'hr_admin' }, { id: 'owner', role: 'super_admin' }];
        const a = res();
        assert.equal(await own.guard({ orgId: 'o', user: { id: 'hr', role: 'hr_admin' } }, a, 'hr', 'leave.decide', 'decide your own time off'), null);
        assert.deepEqual([a.code, a.body.code, a.body.success], [403, 'own_request', false]);
        const b = res();
        assert.deepEqual(await own.guard({ orgId: 'o', user: { id: 'hr' } }, b, 'someone', 'leave.decide'), {});
        assert.equal(b.code, 0);
        rows = [{ id: 'owner', role: 'super_admin' }, { id: 'e', role: 'employee', usProfile: { managerId: 'owner' } }];
        const c = res();
        assert.deepEqual(await own.guard({ orgId: 'o', user: { id: 'owner' } }, c, 'owner', 'leave.decide'), { selfDecision: true });
        assert.equal(c.code, 0);
    } finally { undo(); }
});

/* ------------------------------- sessions end when access changes ------------------------------- */

test('a token made before the cutoff is refused; one made after it, or with no cutoff set, is fine', () => {
    const cut = '2026-11-18T15:00:00.000Z';
    const at = (iso) => ({ iat: Math.floor(Date.parse(iso) / 1000) });
    assert.equal(cutoff.tokenTooOld(at('2026-11-18T14:10:00Z'), { sessionsValidAfter: cut }), true, 'an ID token from before the role change, still not expired');
    assert.equal(cutoff.tokenTooOld(at('2026-11-18T15:00:30Z'), { sessionsValidAfter: cut }), false, 'signed in again');
    assert.equal(cutoff.tokenTooOld(at('2026-11-18T14:59:57Z'), { sessionsValidAfter: cut }), false, 'within the few seconds two clocks may differ');
    assert.equal(cutoff.tokenTooOld(at('2026-11-18T14:59:50Z'), { sessionsValidAfter: cut }), true);
    assert.equal(cutoff.tokenTooOld(at('2020-01-01T00:00:00Z'), {}), false, 'no cutoff on the record');
    assert.equal(cutoff.tokenTooOld(at('2020-01-01T00:00:00Z'), { sessionsValidAfter: 'not a date' }), false);
    assert.equal(cutoff.tokenTooOld({}, { sessionsValidAfter: cut }), true, 'a token that cannot say when it was made, when a cutoff is set');
    assert.equal(cutoff.tokenTooOld(null, { sessionsValidAfter: cut }), true);
    assert.equal(cutoff.tokenTooOld(null, null), false);
    assert.deepEqual(cutoff.stamp(new Date(cut)), { sessionsValidAfter: cut });
});

/* ------------------------------- punches saved offline ------------------------------- */

test('a company may refuse punches saved offline; the choice is kept when other time settings are saved', () => {
    assert.equal(timePolicy.DEFAULT_RULES.offlinePunches, 'allow', 'as before unless the company chooses');
    const set = timePolicy.validateTimeRules({ offlinePunches: 'refuse' }, timePolicy.DEFAULT_RULES, '2026-11-18');
    assert.deepEqual(set.errors, []); assert.equal(set.value.offlinePunches, 'refuse');
    const kept = timePolicy.validateTimeRules({ overtimeWeeklyHours: 40 }, { ...timePolicy.DEFAULT_RULES, offlinePunches: 'refuse' }, '2026-11-18');
    assert.equal(kept.value.offlinePunches, 'refuse', 'not sent: stays as it was');
    const back = timePolicy.validateTimeRules({ offlinePunches: 'allow' }, { ...timePolicy.DEFAULT_RULES, offlinePunches: 'refuse' }, '2026-11-18');
    assert.equal(back.value.offlinePunches, 'allow');
    const bad = timePolicy.validateTimeRules({ offlinePunches: 'sometimes' }, timePolicy.DEFAULT_RULES, '2026-11-18');
    assert.ok(bad.errors.some((e) => /offlinePunches must be allow or refuse/.test(e)));
});

/* ------------------------------- privacy deletion covers the newer records ------------------------------- */

test('timesheet weeks, punch fixes, shifts, Gusto copies and pay history are planned under the category they belong to', () => {
    const svc = require('../services/privacy-service.js');
    const rules = require('../services/privacy-rules.js');
    const g = {
        user: { id: 'u1', status: 'Terminated', usProfile: { startDate: '2020-01-06', termination: { lastDay: '2021-06-30' } }, usForms: { w4: { x: 1 } } },
        punches: [{ id: 'p1', localDate: '2021-06-01' }], leave: [{ id: 'l1', endDate: '2021-05-10' }], docs: [], consents: [], osha: [], requests: [], photos: [], eeo: null, audit: [],
        more: {
            weeks: [{ id: 'u1_2021-05-31', weekStart: '2021-05-31', weekEnd: '2021-06-06' }, { id: 'u1_2026-11-09', weekStart: '2026-11-09', weekEnd: '2026-11-15' }],
            corrections: [{ id: 'c1', localDate: '2021-06-02' }], shifts: [{ id: 's1', date: '2021-06-03' }], gustoSheets: [{ id: 'g1', date: '2026-11-10' }],
            adjustments: [{ id: 'a1', date: '2021-03-01' }], payResults: [{ id: 'pr1' }, { id: 'pr2' }], compHistory: [{ id: 'ch1' }], notices: [], gustoLinks: [], qrLinks: []
        }
    };
    const facts = svc.planningFacts(g);
    assert.deepEqual(facts.punches.map((x) => x.id), ['p1', 'timesheet_weeks/u1_2021-05-31', 'timesheet_weeks/u1_2026-11-09', 'punch_corrections/c1', 'schedule_shifts/s1', 'gusto_time_sheets/g1']);
    assert.deepEqual(facts.leave.map((x) => x.id), ['l1', 'leave_adjustments/a1']);
    assert.equal(facts.counts.payrollForms, 4, 'one pay form, two pay results, one pay change');

    const plan = rules.planDeletion(facts, rules.DEFAULT_RETENTION, '2026-11-18');
    const time = plan.rows.find((r) => r.key === 'time_punches');
    assert.equal(time.action, 'partial', 'the 2021 records are past three years; this month\'s are kept');
    assert.deepEqual(time.deleteIds.sort(), ['p1', 'punch_corrections/c1', 'schedule_shifts/s1', 'timesheet_weeks/u1_2021-05-31']);
    assert.equal(time.retainCount, 2);
    assert.deepEqual(plan.rows.find((r) => r.key === 'leave_requests').deleteIds.sort(), ['l1', 'leave_adjustments/a1']);
    assert.equal(plan.rows.find((r) => r.key === 'payroll_forms').action, 'delete', 'four years after the last day have passed');

    // someone still employed: pay records are kept, and old time records still go by their own date
    const working = svc.planningFacts({ ...g, user: { ...g.user, status: 'Active', usProfile: { startDate: '2020-01-06' } } });
    assert.equal(rules.planDeletion(working, rules.DEFAULT_RETENTION, '2026-11-18').rows.find((r) => r.key === 'payroll_forms').action, 'retain');
    // a record gathered the old way (no newer lists) still plans as before
    const old = svc.planningFacts({ ...g, more: undefined });
    assert.deepEqual(old.punches.map((x) => x.id), ['p1']);
    assert.equal(old.counts.payrollForms, 1);
});

/* ------------------------------- found by the end-to-end run on 2026-11-18 ------------------------------- */

test('the public discovery address gets past the file guard; every other dot-name is still refused', () => {
    const guard = require('../middleware/static-guard.js');
    assert.equal(guard.isBlocked('/oauth/.well-known/oauth-authorization-server'), false);
    for (const p of ['/.env', '/.git/config', '/x/.claude/launch.json', '/.well-known/../.env', '/oauth/.well-known/../../.env', '/.well-known/..%2f.env', '/.WELL-KNOWN/../server.js'])
        assert.equal(guard.isBlocked(p), true, `${p} should be refused`);
});

test('an invoice is billed to the customer by the name they registered, and names the product', () => {
    const billing = require('../services/billing-service.js');
    const inv = { number: 'INV-2026-00001', issuedAt: '2026-11-18T00:00:00Z', status: 'open', orgId: 'org_lone_star', lines: [], period: { start: '2026-11-01', end: '2026-11-30' }, planName: 'Standard', interval: 'month', headcount: { billable: 3 }, subtotalCents: 0, taxCents: 0, totalCents: 0 };
    const html = (org) => billing.renderInvoiceHtml(inv, org);
    assert.match(html({ displayName: 'Lone Star Market', legalName: 'Lone Star Market LLC' }), /Billed to:<\/strong> Lone Star Market</);
    assert.match(html({ Legal_Name: 'Harbor Motel LLC' }), /Billed to:<\/strong> Harbor Motel LLC</);
    assert.match(html({ usProfile: { legalName: 'Bay Cafe Inc' } }), /Billed to:<\/strong> Bay Cafe Inc</);
    assert.match(html({}), /Billed to:<\/strong> org_lone_star</, 'the id only when no name is on record');
    assert.match(html({ displayName: '<b>Bold & Co</b>' }), /&lt;b&gt;Bold &amp; Co&lt;\/b&gt;/, 'the name is escaped');
    assert.match(html({ displayName: 'X' }), /Onn HR by Prompt AI USA/);
});

test('exit interview answers follow a last day that was changed, but not an old plan that never happened', async () => {
    const { rawCollection } = require('../config/firebase.js'); // the in-memory database used in tests
    const xi = require('../services/exit-interviews.js');
    const ORG = `org_xi_${Date.now()}`;
    const put = (userId, lastDay, extra = {}) => rawCollection('exit_interviews').doc(`${userId}_${lastDay}`).set({ orgId: ORG, userId, lastDay, answers: { why: 'the morning crew' }, ...extra });
    const recent = new Date(Date.now() - 2 * 86400000).toISOString(); const longAgo = new Date(Date.now() - 400 * 86400000).toISOString();

    await put('u1', '2026-12-01');
    assert.equal(await xi.carryOver(ORG, 'u1', { lastDay: '2026-12-01', cancelledAt: recent }, '2026-11-17'), true);
    const moved = await xi.getRecord(ORG, 'u1', '2026-11-17');
    assert.deepEqual([moved.lastDay, moved.movedFromLastDay, moved.answers.why], ['2026-11-17', '2026-12-01', 'the morning crew']);
    assert.equal(await xi.getRecord(ORG, 'u1', '2026-12-01'), null, 'not left behind under the old date');
    assert.equal(await xi.carryOver(ORG, 'u1', { lastDay: '2026-12-01', cancelledAt: recent }, '2026-11-17'), false, 'nothing to move the second time');

    await put('u2', '2025-09-01');
    assert.equal(await xi.carryOver(ORG, 'u2', { lastDay: '2025-09-01', cancelledAt: longAgo }, '2026-11-17'), false, 'an exit taken back long ago is another departure');
    await put('u3', '2026-12-01'); await put('u3', '2026-11-17', { answers: { why: 'newer' } });
    assert.equal(await xi.carryOver(ORG, 'u3', { lastDay: '2026-12-01', cancelledAt: recent }, '2026-11-17'), false, 'never over answers already given for the new date');
    assert.equal((await xi.getRecord(ORG, 'u3', '2026-11-17')).answers.why, 'newer');
    assert.equal(await xi.carryOver(ORG, 'u4', { lastDay: '2026-12-01', cancelledAt: recent }, '2026-12-01'), false, 'the same day is not a change');
    assert.equal(await xi.carryOver(ORG, 'u4', null, '2026-12-01'), false);
    assert.equal(await xi.carryOver(`${ORG}_other`, 'u3', { lastDay: '2026-12-01', cancelledAt: recent }, '2026-11-20'), false, 'never across companies');
});

test('a second exit gets a fresh checklist; an exit still in progress keeps the one it has', async () => {
    const { rawCollection } = require('../config/firebase.js');
    const lists = require('../services/us-checklist-service.js');
    const ORG = `org_cl_${Date.now()}`;
    const emp = { id: `u_${Date.now()}`, data: { employeeId: 'EMP0001', name: 'Lena Park' } };
    const first = await lists.createChecklist(ORG, emp, 'offboarding', '2026-12-01');
    assert.equal(first.cancelled, false); assert.ok(first.tasks.length > 0);
    // ticking something off, then asking again for the same exit: the same list, with the tick
    await rawCollection('checklists').doc(first.id).update({ marker: 'worked on' });
    assert.equal((await lists.createChecklist(ORG, emp, 'offboarding', '2026-12-01')).marker, 'worked on');
    // the exit is taken back, then recorded again for another day
    await rawCollection('checklists').doc(first.id).update({ cancelled: true });
    assert.deepEqual((await lists.listForUser(ORG, emp.id)).map((l) => l.kind), [], 'a cancelled list is not shown');
    const second = await lists.createChecklist(ORG, emp, 'offboarding', '2026-11-17');
    assert.deepEqual([second.cancelled, second.anchorDate, second.marker], [false, '2026-11-17', undefined]);
    assert.deepEqual((await lists.listForUser(ORG, emp.id)).map((l) => [l.kind, l.anchorDate]), [['offboarding', '2026-11-17']]);
    // a rehire, then leaving again on another day: the old finished list is not handed back
    const third = await lists.createChecklist(ORG, emp, 'offboarding', '2027-03-31');
    assert.equal(third.anchorDate, '2027-03-31');
    assert.equal((await lists.listForUser(ORG, emp.id)).length, 1, 'only the current exit is listed');
    // onboarding lists are untouched by this rule
    const on1 = await lists.createChecklist(ORG, emp, 'onboarding', '2026-01-05');
    await rawCollection('checklists').doc(on1.id).update({ marker: 'kept' });
    assert.equal((await lists.createChecklist(ORG, emp, 'onboarding', '2026-02-01')).marker, 'kept');
});

test('the container build file is not handed out, and the page helper for country addresses is', () => {
    const guard = require('../middleware/static-guard.js');
    for (const p of ['/Dockerfile', '/dockerfile', '/DOCKERFILE.', '/.dockerignore']) assert.equal(guard.isBlocked(p), true, `${p} should be refused`);
    assert.equal(guard.isBlocked('/region.js'), false);
});

/* ------------------------------- one copy of the server runs each background job ------------------------------- */

test('two copies of the server: one holds a job\'s lease and runs it, the other skips; the lease passes on when the holder stops', async () => {
    const lock = require('../services/job-lock.js');
    const docs = new Map(); let writes = 0; let clock = 1_000_000;
    const store = { transact: async (name, fn) => { const out = fn(docs.get(name) || null); if (out.write) { docs.set(name, out.write); writes += 1; } return out.result; } };
    const copy = (holder) => ({ store, now: () => clock, holder, memory: new Map(), env: {} });
    const A = copy('A'); const B = copy('B');
    const HOUR = 3600000;

    assert.equal(await lock.acquire('report_copies', HOUR, A), true, 'the first to ask gets it');
    assert.equal(await lock.acquire('report_copies', HOUR, B), false, 'the other copy skips');
    assert.equal(await lock.acquire('exits', HOUR, B), true, 'each job has its own lease');
    assert.equal(lock.leaseFor(HOUR), 5400000, 'a lease lasts one and a half intervals');
    assert.equal(lock.leaseFor(5000), 30000, 'and never less than half a minute');

    // the holder keeps it tick after tick; the other keeps skipping
    for (let i = 0; i < 5; i += 1) { clock += HOUR; assert.equal(await lock.acquire('report_copies', HOUR, A), true); assert.equal(await lock.acquire('report_copies', HOUR, B), false); }
    // the holder stops: once its lease has run out the other copy takes over
    clock += 5400001;
    assert.equal(await lock.acquire('report_copies', HOUR, B), true);
    assert.equal(await lock.acquire('report_copies', HOUR, A), false, 'and the old holder, back again, now skips');

    // a frequent job does not write to the database on every tick
    writes = 0;
    for (let i = 0; i < 12; i += 1) { clock += 5000; assert.equal(await lock.acquire('webhook_delivery', 5000, A), true); }
    assert.ok(writes <= 4, `one minute of five-second ticks renewed the lease ${writes} times`);
    assert.equal(await lock.acquire('webhook_delivery', 5000, B), false);
});

test('a lease that cannot be checked does not stop the jobs, and the switch turns leases off', async () => {
    const lock = require('../services/job-lock.js');
    const said = [];
    const broken = { store: { transact: async () => { throw new Error('database is down'); } }, now: () => 5, holder: 'A', memory: new Map(), env: {}, log: (m) => said.push(m) };
    lock._reset();
    assert.equal(await lock.acquire('x', 1000, broken), true, 'a single server must keep working');
    assert.equal(await lock.acquire('x', 1000, broken), true);
    assert.equal(said.length, 1, 'said once, not on every tick');
    const never = { store: { transact: async () => { throw new Error('should not be called'); } }, now: () => 5, holder: 'A', memory: new Map(), env: { JOB_LOCKS: 'off' } };
    assert.equal(await lock.acquire('x', 1000, never), true);
    lock._reset();

    // guard(): the job runs with its arguments on the holder, and is skipped (undefined) elsewhere
    const docs = new Map();
    const store = { transact: async (name, fn) => { const out = fn(docs.get(name) || null); if (out.write) docs.set(name, out.write); return out.result; } };
    const ran = [];
    const onA = lock.guard('job', 60000, async (v) => { ran.push(`A${v}`); return 'done'; }, { store, now: () => 10, holder: 'A', memory: new Map(), env: {} });
    const onB = lock.guard('job', 60000, async (v) => { ran.push(`B${v}`); return 'done'; }, { store, now: () => 10, holder: 'B', memory: new Map(), env: {} });
    assert.equal(await onA(1), 'done'); assert.equal(await onB(1), undefined); assert.equal(await onA(2), 'done');
    assert.deepEqual(ran, ['A1', 'A2']);
});
