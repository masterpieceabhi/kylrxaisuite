// Adding people: phone contacts (.vcf and the phone's contact picker) and the invite emails (services/team-invite-emails.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../services/team-import-rules.js');
const M = require('../services/team-invite-emails.js');
const L = require('../services/access-link-rules.js');

const VCF = [
  'BEGIN:VCARD', 'VERSION:3.0', 'N:Lopez;Maria;;;', 'FN:Maria Lopez', 'EMAIL;TYPE=INTERNET;TYPE=HOME:maria@example.com', 'TEL;TYPE=HOME:414-555-0100', 'TEL;TYPE=CELL:414-555-0199', 'PHOTO;ENCODING=b:AAAA', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:Joe Lee', 'item1.EMAIL;type=INTERNET:joe@exa', ' mple.com', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:2.1', 'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Mu=C3=B1oz;Jos=C3=A9;;;', 'EMAIL:jose@example.com', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'TEL:555-0000', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'N:O\\;Brien;Pat;;;', 'END:VCARD'
].join('\r\n');

test('phone contacts file: names, first email, the mobile number; cards with no name or email are left out', () => {
  assert.ok(R.isVcf(`﻿${VCF}`));
  assert.ok(!R.isVcf('First,Last,Email'));
  const t = R.parseVcf(VCF);
  assert.deepEqual(t[0], ['First name', 'Last name', 'Email', 'Phone']);
  assert.deepEqual(t[1], ['Maria', 'Lopez', 'maria@example.com', '414-555-0199']);
  assert.deepEqual(t[2], ['Joe', 'Lee', 'joe@example.com', ''], 'only a full name, a folded line and an item1. group');
  assert.deepEqual(t[3], ['José', 'Muñoz', 'jose@example.com', ''], 'vCard 2.1 quoted-printable');
  assert.deepEqual(t[4], ['Pat', 'O;Brien', '', ''], 'escaped semicolon');
  assert.equal(t.length, 5, 'the card with only a phone number is left out');
});

test('a contacts table goes through the same column guessing as a sheet', () => {
  const { errors, rows } = R.cleanTable(R.parseVcf(VCF));
  assert.deepEqual(errors, []);
  const g = R.guessMapping(rows, {});
  const field = Object.fromEntries(g.columns.map((c) => [c.header, c.field]));
  assert.equal(field['First name'], 'first_name'); assert.equal(field['Last name'], 'last_name'); assert.equal(field.Email, 'email'); assert.equal(field.Phone, 'phone');
  assert.equal(g.rowCount, 4);
});

test('contacts picked on the phone become a table; junk is ignored', () => {
  const t = R.contactsToTable([{ name: ['Maria Lopez'], email: ['maria@example.com', 'm2@example.com'], tel: ['+1 414 555 0199'] }, { name: [], email: [], tel: ['1'] }, null, 'x', { name: ['Only Name'] }]);
  assert.deepEqual(t, [['Full name', 'Email', 'Phone'], ['Maria Lopez', 'maria@example.com', '+1 414 555 0199'], ['Only Name', '', '']]);
  assert.deepEqual(R.contactsToTable('nope'), [['Full name', 'Email', 'Phone']]);
});

test('set-up link email: to the person only, the app address, the end date', () => {
  const env = { APP_URL: 'https://app-staging.onnhr.com/' };
  const m = M.setupLinkEmail({ name: 'Maria Lopez', email: 'maria@example.com', url: M.setupUrl('tok123', env), expiresAt: '2026-12-01T10:00:00Z', company: 'Taco Spot' });
  assert.equal(m.to, 'maria@example.com');
  assert.match(m.subject, /^Taco Spot added you to Onn HR/);
  assert.match(m.text, /^Hi Maria,/);
  assert.ok(m.text.includes('https://app-staging.onnhr.com/join.html#s=tok123'));
  assert.match(m.text, /Tue, Dec 1/);
  assert.match(m.text, /do not forward/);
  assert.equal(M.setupLinkEmail({ name: 'x', email: '', url: 'u' }), null);
});

test('join request notice: owner and HR only, the name but no contact details; approval email says how to sign in', () => {
  const people = [
    { id: 'a', name: 'Owner', email: 'Owner@x.com', role: 'super_admin' }, { id: 'b', name: 'Hr', email: 'hr@x.com', role: 'hr_admin' },
    { id: 'c', name: 'Mgr', email: 'm@x.com', role: 'manager' }, { id: 'd', name: 'Emp', email: 'e@x.com', role: 'employee' },
    { id: 'e', name: 'Gone', email: 'g@x.com', role: 'hr_admin', status: 'terminated' }, { id: 'f', name: 'Dup', email: 'owner@x.com', role: 'super_admin' }
  ];
  assert.deepEqual(M.reviewers(people), ['owner@x.com', 'hr@x.com']);
  const n = M.joinRequestNotice({ to: M.reviewers(people), requesterName: 'Joe\nLee', company: 'Taco Spot', env: { APP_URL: 'https://app.onnhr.com' } });
  assert.match(n.subject, /^Joe Lee asked to join Taco Spot/);
  assert.ok(n.text.includes('https://app.onnhr.com/admin-us-team-import.html#waitCard'));
  assert.equal(M.joinRequestNotice({ to: [], requesterName: 'x' }), null);
  const a = M.joinApprovedEmail({ name: 'Joe Lee', email: 'joe@x.com', company: 'Taco Spot', env: {} });
  assert.equal(a.to, 'joe@x.com');
  assert.ok(a.text.includes('https://app.onnhr.com/login.html'));
  assert.match(a.text, /press "Forgot password or PIN\?"/, 'the name of the link on the sign-in page');
  const o = M.joinApprovedEmail({ name: 'Joe Lee', email: 'joe@x.com', company: 'Taco Spot', env: {}, open: true });
  assert.match(o.subject, /^You're in: you joined Taco Spot/);
  assert.match(o.text, /If you did not do this/);
});

test('open join link rules: a few hours, a set number of people; approving many at once is capped', () => {
  const now = new Date('2026-11-24T12:00:00Z');
  const d = L.openLinkFor(undefined, undefined, now);
  assert.equal(d.hours, 2); assert.equal(d.maxPeople, 30); assert.equal(d.expiresAt, '2026-11-24T14:00:00.000Z');
  assert.equal(L.openLinkFor(24, 100, now).expiresAt, '2026-11-25T12:00:00.000Z');
  for (const [h, n] of [[0, 5], [25, 5], [1.5, 5], [2, 0], [2, 101], ['x', 5]]) assert.ok(L.openLinkFor(h, n, now).error, `${h} hours, ${n} people`);
  assert.deepEqual(L.approveIds(['abcdefghij1', 'abcdefghij1', 'abcdefghij2']).ids, ['abcdefghij1', 'abcdefghij2']);
  assert.ok(L.approveIds([]).error); assert.ok(L.approveIds('x').error); assert.ok(L.approveIds(['../x']).error);
  assert.match(L.approveIds(Array.from({ length: 51 }, (_, i) => `abcdefghij${i}`)).error, /at most 50/);
});

test('nothing tells people to press a link the sign-in page does not have', async () => {
  const fs = await import('node:fs');
  const login = fs.readFileSync(new URL('../login.html', import.meta.url), 'utf8');
  assert.ok(login.includes('Forgot password or PIN?'));
  for (const f of ['../join.html', '../admin-us-team-import.html', '../services/team-invite-emails.js']) {
    assert.ok(!fs.readFileSync(new URL(f, import.meta.url), 'utf8').includes('No PIN, or forgot it'), f);
  }
});

test('sending: each link to its own person; nothing goes out when email is off for the server or the company', async () => {
  const sent = [];
  const send = async (m) => { if (m.to === 'bad@x.com') throw new Error('mailbox full'); sent.push(m); };
  const env = { SMTP_USER: 'u', SMTP_PASS: 'p', APP_URL: 'https://app.onnhr.com' };
  const items = [{ name: 'A', email: 'a@x.com', token: 't1' }, { name: 'B', email: 'bad@x.com', token: 't2' }];
  const done = await M.sendSetupLinks('org1', items, { env, send, org: { name: 'Co' } });
  assert.deepEqual([...done], ['a@x.com'], 'a failed send is not counted');
  assert.equal(sent.length, 1); assert.ok(sent[0].text.includes('#s=t1')); assert.ok(!sent[0].text.includes('t2'));
  assert.equal((await M.sendSetupLinks('org1', items, { env: { ...env, NOTICES_EMAIL: 'off' }, send, org: {} })).size, 0);
  assert.equal((await M.sendSetupLinks('org1', items, { env: {}, send, org: {} })).size, 0);
  assert.equal((await M.sendSetupLinks('org1', items, { env, send, org: { noticesEmail: false } })).size, 0);
  assert.equal(sent.length, 1);
  const n = await M.notifyJoinRequest('org1', 'Joe Lee', { env, send, load: async () => ({ org: { name: 'Co' }, people: [{ id: 'a', email: 'o@x.com', role: 'super_admin' }] }) });
  assert.equal(n, 1); assert.deepEqual(sent[1].to, ['o@x.com']);
  assert.equal(await M.notifyJoinRequest('org1', 'Joe', { env, send, load: async () => { throw new Error('db down'); } }), 0, 'never throws');
});
