// Company data download and account closure: the rules (services/company-data-rules.js) and the daily-job step.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('../services/company-data-rules.js');
const jobs = require('../services/daily-jobs.js');

test('zip: what goes in comes back out, compressed or stored, with valid CRCs', () => {
  const zlib = require('zlib');
  const big = 'hours '.repeat(5000);
  const buf = R.zip([{ name: 'README.txt', data: 'hello' }, { name: 'data/users.json', data: big }, { name: 'files/a.bin', data: Buffer.from([0, 1, 2, 255]) }]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  assert.equal(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'ends with the central directory record');
  assert.equal(buf.readUInt16LE(buf.length - 12), 3, 'three entries');
  const out = R.unzip(buf);
  assert.deepEqual(out.map((e) => e.name), ['README.txt', 'data/users.json', 'files/a.bin']);
  assert.equal(out[1].data.toString(), big);
  assert.ok(buf.length < big.length / 10, 'repetitive JSON is compressed');
  for (const e of out) assert.equal(zlib.crc32(e.data) >>> 0, e.crc);
});

test('zip: names cannot climb out of the folder, and duplicates are renamed', () => {
  const out = R.unzip(R.zip([{ name: '../../etc/passwd', data: 'x' }, { name: 'C:\\a\\b.txt', data: 'y' }, { name: 'b.txt', data: '1' }, { name: 'b.txt', data: '2' }]));
  const names = out.map((e) => e.name);
  assert.ok(names.every((n) => !n.includes('..') && !n.startsWith('/') && !n.includes('\\')), names.join(' '));
  assert.equal(new Set(names).size, names.length);
});

test('cleanRecord: sign-in secrets go, encrypted numbers become a note, Firestore types become plain JSON', () => {
  const enc = 'v1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB==:CCCCCCCC';
  const ts = { seconds: 1795000000, nanoseconds: 0, toDate: () => new Date(1795000000 * 1000) };
  const out = R.cleanRecord({
    name: 'Mia', pinHash: 'abc', passwordHash: 'x', totp: { secret: 's' }, totpSecret: 's', apiKey: 'k', refreshToken: 't', otp: '123456',
    ssnEncrypted: enc, bank: { accountNumber: enc, routingLast4: '1234' }, zipCode: '53132', createdAt: ts, where: { latitude: 1, longitude: 2 }, list: [enc, 'ok']
  });
  assert.equal(out.name, 'Mia');
  for (const k of ['pinHash', 'passwordHash', 'totp', 'totpSecret', 'apiKey', 'refreshToken', 'otp']) assert.ok(!(k in out), `${k} removed`);
  assert.equal(out.ssnEncrypted, R.ENCRYPTED_NOTE);
  assert.equal(out.bank.accountNumber, R.ENCRYPTED_NOTE);
  assert.equal(out.bank.routingLast4, '1234');
  assert.equal(out.zipCode, '53132', 'ordinary fields named like codes stay');
  assert.equal(out.createdAt, new Date(1795000000 * 1000).toISOString());
  assert.deepEqual(out.where, { latitude: 1, longitude: 2 });
  assert.deepEqual(out.list, [R.ENCRYPTED_NOTE, 'ok']);
  assert.ok(!JSON.stringify(out).includes('v1:AAAA'));
});

test('plans: platform and secret collections stay out of the download; our invoices are exported but kept', () => {
  const exp = R.exportPlan(['users', 'some_new_collection', 'bad name!']);
  const del = R.deletePlan(['users', 'some_new_collection']);
  assert.ok(exp.includes('users') && exp.includes('some_new_collection') && exp.includes('billing_invoices'));
  assert.ok(!exp.includes('bad name!'));
  for (const n of ['organizations', 'system_config', 'billing_events', 'otp_verifications', 'oauth_tokens', 'api_keys', 'company_closures']) assert.ok(!exp.includes(n), `${n} not exported`);
  assert.ok(del.includes('users') && del.includes('otp_verifications') && del.includes('api_keys') && del.includes('some_new_collection'), 'secrets are deleted too');
  for (const n of ['organizations', 'billing_invoices', 'billing_accounts', 'billing_events', 'company_closures', 'system_config']) assert.ok(!del.includes(n), `${n} not in the per-collection delete`);
});

test('closure: typed name, 30 days, reminder 3 days before, undo only before the day', () => {
  const org = { name: 'Prompt AI Ethical Solutions USA', legalName: 'Prompt AI Ethical Solutions USA LLC' };
  assert.ok(R.nameMatches('  prompt ai ethical  solutions usa llc ', org));
  assert.ok(R.nameMatches('Prompt AI Ethical Solutions USA', org));
  assert.ok(!R.nameMatches('Prompt AI', org));
  assert.ok(!R.nameMatches('', org));
  const c = R.newClosure({ now: new Date('2026-11-24T15:00:00Z'), by: 'u1', byEmail: 'o@x.com', companyName: 'X' });
  assert.equal(c.deleteOn, '2026-12-24');
  assert.equal(c.remindOn, '2026-12-21');
  assert.ok(!R.dueForReminder(c, '2026-12-20'));
  assert.ok(R.dueForReminder(c, '2026-12-21'));
  assert.ok(!R.dueForReminder({ ...c, reminded: true }, '2026-12-22'));
  assert.ok(!R.dueForDeletion(c, '2026-12-23'));
  assert.ok(R.dueForDeletion(c, '2026-12-24'));
  assert.ok(R.canWithdraw(c, '2026-12-23'));
  assert.ok(!R.canWithdraw(c, '2026-12-24'));
  assert.ok(!R.dueForDeletion({ ...c, state: 'withdrawn' }, '2027-01-30'), 'an undone closure never deletes');
});

test('daily jobs: the closed-company step runs, is summed up, and a failure marks the run not ok', async () => {
  const base = { claimDay: async () => true, saveRun: async () => {}, retention: async () => [], ensureDir: async () => {}, listDir: async () => [], removeDir: async () => {}, backup: async () => ({ dir: 'x', documents: 0, collections: 0 }), log: () => {} };
  const ok = await jobs.create({ ...base, closures: async () => ({ reminded: 1, deleted: 2, errors: [] }) }).runOnce(new Date('2026-11-24T10:00:00Z'), {});
  assert.deepEqual({ r: ok.closures.reminded, d: ok.closures.deleted }, { r: 1, d: 2 });
  assert.match(ok.summary, /2 closed companies deleted, 1 reminded/);
  assert.equal(ok.ok, true);
  const bad = await jobs.create({ ...base, closures: async () => { throw new Error('boom'); } }).runOnce(new Date('2026-11-24T10:00:00Z'), {});
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /closed-company step failed/);
});
