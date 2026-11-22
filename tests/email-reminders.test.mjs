// New email notices (survey, review, review round, equipment), signing-link emails and the daily reminders
// (services/email-notices.js, services/email-reminders.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const N = require('../services/email-notices.js');
const R = require('../services/email-reminders.js');
const { can, canManage } = require('../services/permissions.js');
const events = require('../services/events.js');

const people = [
    { id: 'own', name: 'Olivia Owner', email: 'owner@shop.test', role: 'super_admin' },
    { id: 'hr', name: 'Harper Hr', email: 'hr@shop.test', role: 'hr_admin' },
    { id: 'mgr', name: 'Max Manager', email: 'max@shop.test', role: 'manager' },
    { id: 'ana', name: 'Ana Lopez', email: 'ana@shop.test', role: 'employee', usProfile: { managerId: 'mgr' } },
    { id: 'ben', name: 'Ben Ray', email: 'ben@shop.test', role: 'employee', usProfile: { managerId: 'mgr' } },
    { id: 'gone', name: 'Gone Person', email: 'gone@shop.test', role: 'employee', status: 'Terminated' }
];
const opts = { canManage, appUrl: 'https://app.onnhr.com', company: 'Main Street Cafe' };
const to = (list) => list.map((m) => m.to).sort();
const base = { today: '2026-11-22', people, appUrl: 'https://app.onnhr.com', company: 'Main Street Cafe', can, canManage };

test('the new event emails go to the right people and carry no personal details', () => {
    const survey = N.build('survey.opened', { survey_id: 's1', title: 'How is work?', opened_by: 'hr' }, people, opts);
    assert.deepEqual(to(survey), ['ana@shop.test', 'ben@shop.test', 'max@shop.test', 'owner@shop.test']);
    assert.match(survey[0].text, /my-surveys\.html/);
    assert.deepEqual(to(N.build('review.shared', { review_id: 'r1', person_id: 'ana' }, people, opts)), ['ana@shop.test']);
    assert.deepEqual(N.build('review.shared', { review_id: 'r1', person_id: 'gone' }, people, opts), []);
    assert.deepEqual(to(N.build('review_cycle.opened', { cycle_id: 'c1', name: 'Fall 2026', person_ids: ['ana', 'gone', 'ben'] }, people, opts)), ['ana@shop.test', 'ben@shop.test']);
    const asset = N.build('asset.assigned', { asset_id: 'a1', asset_name: 'Store keys', person_id: 'ben', due_back: '2026-12-31' }, people, opts);
    assert.deepEqual(to(asset), ['ben@shop.test']);
    assert.match(asset[0].text, /Store keys, to give back by Thu, Dec 31/);
    for (const t of ['survey.opened', 'review.shared', 'review_cycle.opened', 'asset.assigned']) { assert.ok(N.TYPES.has(t), t); assert.ok(events.CATALOG[t], t); }
});

test('the signing email goes only to the signer, with the full link and the end date', () => {
    const m = N.signingEmail({ name: 'Ana Lopez', email: 'ana@shop.test', docName: 'Offer letter', url: 'https://app.onnhr.com/sign.html?t=abc', expiresAt: '2026-12-06T00:00:00Z', company: 'Main Street Cafe' });
    assert.equal(m.to, 'ana@shop.test');
    assert.equal(m.subject, 'Please sign: Offer letter');
    assert.match(m.text, /https:\/\/app\.onnhr\.com\/sign\.html\?t=abc/);
    assert.match(m.text, /until Sun, Dec 6/);
    assert.match(m.text, /do not forward/);
    assert.match(N.signingEmail({ email: 'a@b.test', url: 'https://x/sign.html?t=1', reminder: true }).subject, /^Reminder: /);
    assert.equal(N.signingEmail({ email: '', url: 'https://x' }), null);
});

test('sendNow respects the off switches and keeps going when one email fails', async () => {
    const env = { RESEND_API_KEY: 'x' };
    const sent = [];
    const send = async (m) => { if (m.to === 'bad@x.test') throw new Error('nope'); sent.push(m.to); };
    const msgs = [{ to: 'a@x.test', subject: 's', text: 't' }, { to: 'bad@x.test', subject: 's', text: 't' }, null];
    assert.equal(await N.sendNow('o1', msgs, { env, send, org: {} }), 1);
    assert.deepEqual(sent, ['a@x.test']);
    assert.equal(await N.sendNow('o1', msgs, { env: {}, send, org: {} }), 0, 'no email set up');
    assert.equal(await N.sendNow('o1', msgs, { env: { ...env, NOTICES_EMAIL: 'off' }, send, org: {} }), 0);
    assert.equal(await N.sendNow('o1', msgs, { env, send, org: { noticesEmail: false } }), 0);
});

test('reminder days: the day before, the day, then every 3 days late for up to 30 days', () => {
    const t = '2026-11-22';
    assert.equal(R.remindDay('2026-11-23', t), true);
    assert.equal(R.remindDay('2026-11-22', t), true);
    assert.equal(R.remindDay('2026-11-24', t), false);
    assert.equal(R.remindDay('2026-11-21', t), false);
    assert.equal(R.remindDay('2026-11-19', t), true);
    assert.equal(R.remindDay('2026-10-23', t), true, '30 days late');
    assert.equal(R.remindDay('2026-10-20', t), false, 'past 30 days: stop');
    assert.equal(R.remindDay(null, t), false);
});

test('checklist reminders: one email per person, employee tasks to the person, HR tasks to HR, manager tasks to the manager', () => {
    const tasks = [
        { userId: 'ana', name: 'Ana Lopez', assignee: 'employee', title: 'Fill in your tax form (W-4)', dueDate: '2026-11-22' },
        { userId: 'ana', name: 'Ana Lopez', assignee: 'employee', title: 'Add your bank account', dueDate: '2026-11-25' },
        { userId: 'ana', name: 'Ana Lopez', assignee: 'hr', title: 'Add the person to payroll', dueDate: '2026-11-19' },
        { userId: 'ben', name: 'Ben Ray', assignee: 'manager', title: 'Hand over current work', dueDate: '2026-11-23' },
        { userId: 'gone', name: 'Gone Person', assignee: 'employee', title: 'Something', dueDate: '2026-11-22' }
    ];
    const out = R.plan({ ...base, tasks });
    assert.deepEqual(to(out), ['ana@shop.test', 'hr@shop.test', 'max@shop.test', 'owner@shop.test']);
    const ana = out.find((m) => m.to === 'ana@shop.test');
    assert.match(ana.text, /W-4/);
    assert.doesNotMatch(ana.text, /bank account/, 'not near yet, so not listed');
    assert.match(ana.text, /us-onboarding\.html/);
    const hr = out.find((m) => m.to === 'hr@shop.test');
    assert.match(hr.subject, /1 task is overdue/);
    assert.match(hr.text, /Add the person to payroll \(Ana Lopez\): was due Thu, Nov 19/);
    assert.match(hr.text, /admin-us-checklists\.html/);
    assert.match(out.find((m) => m.to === 'max@shop.test').text, /Hand over current work \(Ben Ray\)/);
});

test('no checklist email on a day that is not a reminder day', () => {
    const tasks = [{ userId: 'ana', name: 'Ana Lopez', assignee: 'employee', title: 'W-4', dueDate: '2026-11-21' }];
    assert.deepEqual(R.plan({ ...base, tasks }), []);
});

test('policy reminders: 3, 7 and 14 days after publishing, only to people who still have to confirm', () => {
    const pol = (publishedAt) => [{ id: 'p1', title: 'Employee handbook', publishedAt, needs: new Set(['ana', 'gone']) }];
    for (const [day, n] of [['2026-11-19', 1], ['2026-11-15', 1], ['2026-11-08', 1], ['2026-11-20', 0], ['2026-11-01', 0]]) {
        const out = R.plan({ ...base, policies: pol(`${day}T15:00:00Z`) });
        assert.equal(out.length, n, day);
        if (n) { assert.equal(out[0].to, 'ana@shop.test'); assert.match(out[0].subject, /please read Employee handbook/); assert.match(out[0].text, /my-policies\.html/); }
    }
});

test('signing reminders: only open requests that are due, with an email, at most 3 automatic ones', () => {
    const now = '2026-11-22T12:00:00Z';
    const r = (id, extra) => ({ id, status: 'pending', signerEmail: `${id}@x.test`, sentAt: '2026-11-18T12:00:00Z', expiresAt: '2026-12-10T00:00:00Z', reminders: [], ...extra });
    const due = R.signingDue([
        r('due'),
        r('fresh', { sentAt: '2026-11-21T12:00:00Z' }),
        r('signed', { status: 'signed' }),
        r('noemail', { signerEmail: '' }),
        r('enough', { reminders: [1, 2, 3].map(() => ({ at: '2026-11-10T00:00:00Z', by: 'daily-job' })) })
    ], now);
    assert.deepEqual(due.map((x) => x.id), ['due']);
});

test('the daily run records reminders and still finishes when they fail', async () => {
    const D = require('../services/daily-jobs.js');
    const base = { claimDay: async () => true, saveRun: async () => {}, retention: async () => [], backup: async () => ({}), listDir: async () => [], removeDir: async () => {}, ensureDir: async () => {}, log: () => {} };
    const ok = await D.create({ ...base, reminders: async () => ({ emails: 4, companies: 2, errors: [] }) }).runOnce(new Date('2026-11-22T09:00:00Z'), {});
    assert.equal(ok.reminders.emails, 4);
    assert.match(ok.summary, /4 reminder emails sent/);
    const bad = await D.create({ ...base, reminders: async () => { throw new Error('mail down'); } }).runOnce(new Date('2026-11-22T09:00:00Z'), {});
    assert.match(bad.summary, /reminders failed \(mail down\)/);
    assert.ok(bad.finishedAt);
});
