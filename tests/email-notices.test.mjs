// Email notices hung off the event system (services/email-notices.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const N = require('../services/email-notices.js');
const { canManage } = require('../services/permissions.js');

const people = [
    { id: 'own', name: 'Olivia Owner', email: 'owner@shop.test', role: 'super_admin' },
    { id: 'hr', name: 'Harper Hr', email: 'hr@shop.test', role: 'hr_admin' },
    { id: 'mgr', name: 'Max Manager', email: 'max@shop.test', role: 'manager' },
    { id: 'mgr2', name: 'Other Manager', email: 'other@shop.test', role: 'manager' },
    { id: 'ana', name: 'Ana Lopez', email: 'ana@shop.test', role: 'employee', usProfile: { managerId: 'mgr' } },
    { id: 'gone', name: 'Gone Person', email: 'gone@shop.test', role: 'employee', status: 'Terminated' },
    { id: 'noemail', name: 'No Email', role: 'employee' }
];
const opts = { canManage, appUrl: 'https://app.onnhr.com', company: 'Main Street Cafe' };
const to = (list) => list.map((m) => m.to).sort();

test('hours sent for approval go to the people who may approve them: company-wide approvers and the own manager only', () => {
    const out = N.build('timesheet.submitted', { person_id: 'ana', week_start: '2026-11-16' }, people, opts);
    assert.deepEqual(to(out), ['hr@shop.test', 'max@shop.test', 'owner@shop.test']);
    assert.match(out[0].subject, /Hours to approve: Ana Lopez, week of Mon, Nov 16/);
    assert.match(out[0].text, /https:\/\/app\.onnhr\.com\/admin-us-time\.html/);
    assert.match(out[0].text, /Main Street Cafe on Onn HR/);
});

test('a decision goes to the person, and never to someone who has left or has no email', () => {
    assert.deepEqual(to(N.build('timesheet.approved', { person_id: 'ana', week_start: '2026-11-16' }, people, opts)), ['ana@shop.test']);
    assert.match(N.build('timesheet.rejected', { person_id: 'ana', week_start: '2026-11-16' }, people, opts)[0].subject, /sent back/);
    assert.deepEqual(N.build('timesheet.approved', { person_id: 'gone', week_start: '2026-11-16' }, people, opts), []);
    assert.deepEqual(N.build('leave.approved', { person_id: 'noemail', start_date: '2026-12-01' }, people, opts), []);
    assert.deepEqual(N.build('timesheet.approved', { person_id: 'nobody' }, people, opts), []);
});

test('time off: deciders get the request, the person gets the answer', () => {
    const asked = N.build('leave.requested', { person_id: 'ana', start_date: '2026-12-01', end_date: '2026-12-03' }, people, opts);
    assert.deepEqual(to(asked), ['hr@shop.test', 'max@shop.test', 'owner@shop.test']);
    assert.match(asked[0].subject, /Tue, Dec 1 to Thu, Dec 3/);
    assert.match(N.build('leave.approved', { person_id: 'ana', start_date: '2026-12-01', end_date: '2026-12-01' }, people, opts)[0].subject, /^Your time off \(Tue, Dec 1\) was approved$/);
    assert.match(N.build('leave.denied', { person_id: 'ana' }, people, opts)[0].subject, /not approved/);
});

test('announcements and policies go to everyone active, except the person who published', () => {
    const news = N.build('announcement.published', { title: 'Holiday hours', published_by: 'own' }, people, opts);
    assert.deepEqual(to(news), ['ana@shop.test', 'hr@shop.test', 'max@shop.test', 'other@shop.test']);
    assert.match(news[0].subject, /^News at work: Holiday hours$/);
    const policy = N.build('policy.published', { title: 'Phone use', require_ack: true, published_by: 'hr' }, people, opts);
    assert.equal(policy.length, 4); assert.match(policy[0].subject, /^Please read: Phone use$/);
    assert.match(N.build('policy.published', { title: 'Phone use', require_ack: false }, people, opts)[0].subject, /^Updated: /);
});

test('an email holds no pay or personal details beyond a name, a date and a link', () => {
    const all = ['timesheet.submitted', 'timesheet.approved', 'leave.requested', 'leave.approved', 'announcement.published', 'policy.published']
        .flatMap((t) => N.build(t, { person_id: 'ana', week_start: '2026-11-16', start_date: '2026-12-01', title: 'x', worked_hours: 41.5, hours: 16 }, people, opts));
    assert.ok(all.length > 10);
    for (const m of all) assert.doesNotMatch(`${m.subject} ${m.text}`, /41\.5|\$|ssn|salary|rate/i);
});

test('nothing is sent unless email is set up, and never for an event that is not a notice', async () => {
    const sent = [];
    const deps = { load: async () => ({ org: { Display_Name: 'Main Street Cafe' }, people }), send: async (m) => { sent.push(m); } };
    assert.equal(await N.fromEvent('o1', 'timesheet.approved', { person_id: 'ana', week_start: '2026-11-16' }, { env: {}, ...deps }), 0);
    assert.equal(await N.fromEvent('o1', 'timesheet.approved', { person_id: 'ana' }, { env: { RESEND_API_KEY: 'k', NOTICES_EMAIL: 'off' }, ...deps }), 0);
    assert.equal(await N.fromEvent('o1', 'person.created', { person_id: 'ana' }, { env: { RESEND_API_KEY: 'k' }, ...deps }), 0);
    assert.equal(sent.length, 0);
    assert.equal(await N.fromEvent('o1', 'timesheet.approved', { person_id: 'ana', week_start: '2026-11-16' }, { env: { RESEND_API_KEY: 'k' }, ...deps }), 1);
    assert.equal(sent[0].to, 'ana@shop.test');
});

test('a company can switch the emails off, and a failed email never throws', async () => {
    const off = { load: async () => ({ org: { noticesEmail: false }, people }), send: async () => { throw new Error('should not send'); } };
    assert.equal(await N.fromEvent('o1', 'timesheet.approved', { person_id: 'ana' }, { env: { RESEND_API_KEY: 'k' }, ...off }), 0);
    const failing = { load: async () => ({ org: {}, people }), send: async () => { throw new Error('mail server down'); } };
    assert.equal(await N.fromEvent('o1', 'announcement.published', { title: 'x' }, { env: { RESEND_API_KEY: 'k' }, ...failing }), 0);
    const broken = { load: async () => { throw new Error('database down'); } };
    assert.equal(await N.fromEvent('o1', 'timesheet.approved', { person_id: 'ana' }, { env: { RESEND_API_KEY: 'k' }, ...broken }), 0);
});
