// US-K07: CSV file export (local folder driver, SFTP driver interface, the file-export connector, payroll journal lines).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kylrx-export-'));
process.env.CONNECTOR_EXPORT_DIR = root;
const F = require('../services/connectors/file-drivers.js');
const J = require('../services/connectors/journal.js');
const M = require('../services/connectors/mapping.js');
const E = require('../services/connectors/sync-engine.js');
const adapter = require('../services/connectors/adapters/file-export.js');

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });

const ACCOUNTS = { wages_expense: '6000', employer_tax_expense: '6100', tax_payable: '2100', deductions_payable: '2200', net_pay_clearing: '1010' };
const ctxFor = (config = {}, extra = {}) => ({ conn: { id: 'c1', orgId: 'org_a', config: { driver: 'local', folder: 'drop', ...config }, credentials: {}, mapping: {}, ...extra }, now: () => new Date('2026-03-04T05:06:07Z') });

test('CSV cells: quoting, empty values, objects, and spreadsheet formulas are defused', () => {
    assert.equal(F.csvCell('plain'), 'plain');
    assert.equal(F.csvCell(null), ''); assert.equal(F.csvCell(undefined), '');
    assert.equal(F.csvCell(0), '0'); assert.equal(F.csvCell(false), 'false');
    assert.equal(F.csvCell('Smith, Ann'), '"Smith, Ann"');
    assert.equal(F.csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(F.csvCell('two\nlines'), '"two\nlines"');
    assert.equal(F.csvCell({ a: 1 }), '"{""a"":1}"');
    for (const evil of ['=HYPERLINK("http://x")', '+1+1', '-2+3', '@SUM(A1)', '\tx']) assert.ok(F.csvCell(evil).replace(/^"/, '').startsWith("'"), `${evil} is prefixed`);
    assert.equal(F.csvCell('-12.50'), '-12.50', 'a negative number written as text stays a number');
    assert.equal(F.csvCell(-12.5), '-12.5');
    assert.equal(F.csvCell('=x', { raw: true }), '=x');
});

test('toCsv and parseCsv round trip, with CRLF line ends and a stable column order', () => {
    const rows = [{ id: 'u1', name: 'Smith, Ann', note: 'said "ok"\nthen left', n: 3 }, { id: 'u2', name: 'Bo', extra: 'x' }];
    const csv = F.toCsv(rows);
    assert.ok(csv.endsWith('\r\n'));
    assert.equal(csv.split('\r\n')[0], 'id,name,note,n,extra');
    assert.deepEqual(F.parseCsv(csv), [{ id: 'u1', name: 'Smith, Ann', note: 'said "ok"\nthen left', n: '3', extra: '' }, { id: 'u2', name: 'Bo', note: '', n: '', extra: 'x' }]);
    assert.equal(F.toCsv(rows, ['name', 'id']).split('\r\n')[1], '"Smith, Ann",u1');
    assert.equal(F.toCsv([], ['a', 'b']), 'a,b\r\n');
    assert.deepEqual(F.parseCsv(''), []);
    assert.deepEqual(F.parseCsv('a,b\n1,2'), [{ a: '1', b: '2' }], 'plain LF and no final newline are accepted');
});

test('local folder driver: writes only inside the company\'s own folder and refuses unsafe names', async () => {
    const d = new F.LocalFolderDriver({ orgId: 'org_a', folder: 'drop' });
    assert.equal(d.dir, path.join(root, 'org_a', 'drop'));
    assert.deepEqual(await d.list(), []);
    assert.deepEqual(await d.ping(), { ok: true, detail: 'local folder is writable' });
    const out = await d.put('people_1.csv', 'a,b\r\n1,é\r\n');
    assert.equal(out.bytes, 11); assert.equal(out.path, path.join(root, 'org_a', 'drop', 'people_1.csv'));
    assert.deepEqual(await d.list(), ['people_1.csv']);
    assert.equal(await d.get('people_1.csv'), 'a,b\r\n1,é\r\n');
    for (const name of ['../escape.csv', '..\\escape.csv', 'a/b.csv', 'a\\b.csv', '..', 'x..y', '', 'with space.csv', 'x'.repeat(121)]) {
        await assert.rejects(() => d.put(name, 'x'), /unsafe file name/, `${JSON.stringify(name)} is refused`);
        await assert.rejects(() => d.get(name), /unsafe file name/);
    }
    for (const bad of [{ orgId: 'org_a', folder: '../other' }, { orgId: 'org_a', folder: 'a/b' }, { orgId: '../org_b', folder: 'drop' }, { orgId: 'org_a', folder: '' }, { orgId: 'org_a', folder: 'x'.repeat(61) }]) {
        assert.throws(() => new F.LocalFolderDriver(bad), /invalid export folder/);
    }
    assert.deepEqual(fs.readdirSync(root), ['org_a'], 'nothing was written outside the company folder');
    const other = new F.LocalFolderDriver({ orgId: 'org_b', folder: 'drop' });
    assert.deepEqual(await other.list(), [], 'another company with the same folder name sees nothing');
});

test('SFTP driver: uploads through the client it is given; without the package it explains what to do', async () => {
    const sent = [];
    const client = { put: async (buf, remote) => { sent.push({ text: buf.toString('utf8'), remote }); }, list: async (dir) => [{ name: 'b.csv' }, { name: 'a.csv' }].map((x) => ({ ...x, dir })), end: async () => { throw new Error('an injected client must not be closed'); } };
    const d = F.createFileDriver('org_a', { driver: 'sftp', sftp: { host: 'files.example.com', remoteDir: '/inbound/' } }, { sftpClient: client });
    assert.ok(d instanceof F.SftpDriver);
    const out = await d.put('people_1.csv', 'a,b\r\n');
    assert.deepEqual(out, { path: '/inbound/people_1.csv', bytes: 5 });
    assert.deepEqual(sent, [{ text: 'a,b\r\n', remote: '/inbound/people_1.csv' }]);
    assert.deepEqual(await d.list(), ['a.csv', 'b.csv']);
    assert.deepEqual(await d.ping(), { ok: true, detail: 'files.example.com' });
    await assert.rejects(() => d.put('../x.csv', 'x'), /unsafe file name/);
    const real = F.createFileDriver('org_a', { driver: 'sftp', sftp: { host: 'files.example.com' } });
    await assert.rejects(() => real.put('a.csv', 'x'), /SFTP driver is not installed/);
    assert.ok(F.createFileDriver('org_a', { folder: 'drop' }) instanceof F.LocalFolderDriver, 'local folder is the default driver');
});

test('payroll journal: pay results are grouped per pay date, in whole cents, and the entry balances', () => {
    const results = [
        { id: 'r1', pay_date: '2026-03-06', pay_period: { start: '2026-02-16', end: '2026-03-01' }, gross: 1000.10, employee_taxes: 200.05, employer_taxes: 76.51, deductions: 50, net: 750.05, department: 'Shop', updated_at: '2026-03-06T10:00:00Z' },
        { id: 'r2', pay_date: '2026-03-06', pay_period: { start: '2026-02-16', end: '2026-03-01' }, gross: 2000.20, employee_taxes: 400.10, employer_taxes: 153.02, deductions: 0, net: 1600.10, department: 'Office', updated_at: '2026-03-06T11:00:00Z' },
        { id: 'r3', pay_date: '2026-03-06', gross: 0.1, employee_taxes: 0, employer_taxes: 0, deductions: 0, net: 0.1, department: 'Shop' },
        { id: 'r4', pay_date: '2026-03-20', gross: 500, employee_taxes: 100, employer_taxes: 38.25, deductions: 0, net: 400 }
    ];
    const journals = J.aggregatePayResults(results);
    assert.equal(journals.length, 2);
    const j = journals[0];
    assert.equal(j.id, 'pj_2026-03-06'); assert.equal(j.employee_count, 3); assert.equal(j.updated_at, '2026-03-06T11:00:00Z');
    assert.deepEqual(j.totals, { gross: 3000.4, employee_taxes: 600.15, employer_taxes: 229.53, deductions: 50, net: 2350.25 });
    assert.deepEqual(j.by_department, [{ department: 'Shop', gross: 1000.2, employer_taxes: 76.51 }, { department: 'Office', gross: 2000.2, employer_taxes: 153.02 }]);
    const built = J.buildJournal(j, ACCOUNTS);
    assert.equal(built.balanced, true); assert.equal(built.debit, 3229.93); assert.equal(built.credit, 3229.93);
    assert.deepEqual(built.missingAccounts, []);
    assert.deepEqual(built.lines.map((l) => [l.account, l.side, l.amount, l.department]), [
        ['6000', 'debit', 1000.2, 'Shop'], ['6100', 'debit', 76.51, 'Shop'], ['6000', 'debit', 2000.2, 'Office'], ['6100', 'debit', 153.02, 'Office'],
        ['2100', 'credit', 829.68, null], ['2200', 'credit', 50, null], ['1010', 'credit', 2350.25, null]
    ]);
    assert.deepEqual(J.validateJournal(j, ACCOUNTS), []);
    assert.match(J.validateJournal(j, { wages_expense: '6000' })[0], /account mapping is missing: employer_tax_expense, tax_payable, deductions_payable, net_pay_clearing/);
    const off = { ...j, totals: { ...j.totals, net: 2000 } };
    assert.ok(J.validateJournal(off, ACCOUNTS).some((e) => /out of balance/.test(e)));
    assert.ok(J.validateJournal({ totals: {}, by_department: [] }, ACCOUNTS).some((e) => /no lines/.test(e)));
    assert.ok(J.validateJournal({ ...j, pay_date: null }, ACCOUNTS).includes('pay_date is missing'));
});

test('file-export connector: default mappings give the documented columns', () => {
    const person = { id: 'u1', employee_number: 'EMP0001', first_name: 'Ada', last_name: 'Lovelace', work_email: 'ada@example.com', phone: '555-0100', hire_date: '2026-01-05', status: 'active', job: { title: 'Engineer', org_unit_name: 'R&D', manager_id: 'u9', location_id: 'loc_tx' } };
    const p = adapter.map('people_csv', person, ctxFor());
    assert.deepEqual(p.errors, []);
    assert.deepEqual(p.payload, { employee_number: 'EMP0001', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', phone: '555-0100', job_title: 'Engineer', department: 'R&D', manager_id: 'u9', location: 'loc_tx', hire_date: '2026-01-05', status: 'active' });
    const week = { id: 'u1_2026-03-02', person_id: 'u1', employee_number: 'EMP0001', date: '2026-03-02', end_date: '2026-03-08', hours: { worked: 44, regular: 40, overtime: 4, double_time: 0 } };
    assert.deepEqual(adapter.map('time_csv', week, ctxFor()).payload, { person_id: 'u1', employee_number: 'EMP0001', week_start: '2026-03-02', week_end: '2026-03-08', worked_hours: 44, regular_hours: 40, overtime_hours: 4, double_time_hours: 0 });
    assert.equal(adapter.batch, true); assert.equal(adapter.eventDriven, false);
    assert.ok(adapter.credentialFields.every((f) => f.optional && f.secret), 'the local folder driver needs no credentials');
    for (const rules of Object.values(adapter.defaultMappings)) assert.deepEqual(M.validateMapping(rules), []);
});

test('file-export connector: a company can rename, drop and add columns', () => {
    const person = { id: 'u1', employee_number: 'EMP0001', first_name: 'Ada', last_name: 'Lovelace', work_email: 'ada@example.com', status: 'active', job: {} };
    const mapping = { people_csv: [{ target: 'phone', disabled: true }, { target: 'manager_id', disabled: true }, { target: 'location', disabled: true }, { target: 'job_title', disabled: true }, { target: 'department', disabled: true }, { target: 'hire_date', disabled: true },
        { target: 'status', transform: { fn: 'lookup', map: { active: 'A', terminated: 'T' } } }, { target: 'FullName', transform: { fn: 'template', value: '{{last_name}}, {{first_name}}' } }] };
    assert.deepEqual(adapter.map('people_csv', person, ctxFor({}, { mapping })).payload, { employee_number: 'EMP0001', first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', status: 'A', FullName: 'Lovelace, Ada' });
});

test('file-export connector: pushBatch writes one dated CSV file that reads back exactly', async () => {
    const ctx = ctxFor();
    const items = [{ id: 'u1', payload: { employee_number: 'EMP0001', last_name: 'O\'Neil, Jr.', email: 'a@example.com' } }, { id: 'u2', payload: { employee_number: 'EMP0002', last_name: '=cmd()', email: 'b@example.com' } }];
    const out = await adapter.pushBatch('people_csv', items, ctx);
    assert.deepEqual(out, { file: 'people_20260304050607.csv', bytes: out.bytes, rows: 2 });
    const text = fs.readFileSync(path.join(root, 'org_a', 'drop', out.file), 'utf8');
    assert.equal(out.bytes, Buffer.byteLength(text));
    assert.deepEqual(F.parseCsv(text), [{ employee_number: 'EMP0001', last_name: 'O\'Neil, Jr.', email: 'a@example.com' }, { employee_number: 'EMP0002', last_name: "'=cmd()", email: 'b@example.com' }]);
    assert.equal(await adapter.healthCheck(ctx).then((h) => h.ok), true);
    assert.equal((await adapter.healthCheck(ctxFor({ folder: '../nope' }))).ok, false, 'a bad folder is a failed health check, not a crash');
});

test('file-export connector: the journal file has one row per journal line, and a journal that does not balance is refused', async () => {
    const [journal] = J.aggregatePayResults([{ id: 'r1', pay_date: '2026-03-06', gross: 1000, employee_taxes: 200, employer_taxes: 76.5, deductions: 50, net: 750, department: 'Shop', currency: 'USD' }]);
    const ctx = ctxFor({ accounts: ACCOUNTS });
    const mapped = adapter.map('journal_csv', journal, ctx);
    assert.deepEqual(adapter.validate('journal_csv', mapped.payload, journal, ctx), []);
    assert.equal(mapped.payload.rows.length, 5);
    assert.deepEqual(mapped.payload.rows[0], { journal_id: 'pj_2026-03-06', pay_date: '03/06/2026', memo: 'Payroll for pay date 2026-03-06', currency: 'USD', line: 1, account: '6000', debit: 1000, credit: '', department: 'Shop', line_memo: 'Wages Shop' });
    const out = await adapter.pushBatch('journal_csv', [{ id: journal.id, payload: mapped.payload }], ctx);
    assert.equal(out.rows, 5); assert.match(out.file, /^journal_\d{14}\.csv$/);
    const rows = F.parseCsv(fs.readFileSync(path.join(root, 'org_a', 'drop', out.file), 'utf8'));
    const sum = (k) => rows.reduce((s, r) => s + Math.round(Number(r[k] || 0) * 100), 0);
    assert.equal(sum('debit'), sum('credit')); assert.equal(sum('debit'), 107650);
    assert.match(adapter.validate('journal_csv', mapped.payload, journal, ctxFor())[0], /account mapping is missing/);
    assert.ok(adapter.validate('journal_csv', mapped.payload, { ...journal, totals: { ...journal.totals, net: 1 } }, ctx).some((e) => /out of balance/.test(e)));
    assert.deepEqual(adapter.validate('people_csv', {}, {}, ctx), []);
});

test('file-export through the sync engine: unbalanced journals are held back with a reason while people still export', async () => {
    const people = [{ id: 'u1', employee_number: 'EMP0001', first_name: 'Ada', last_name: 'Lovelace', work_email: 'ada@example.com', status: 'active', job: {}, updated_at: '2026-03-01T00:00:00Z' }];
    const journals = J.aggregatePayResults([{ id: 'r1', pay_date: '2026-03-06', gross: 1000, employee_taxes: 200, employer_taxes: 76.5, deductions: 50, net: 700, updated_at: '2026-03-06T00:00:00Z' }]); // 50 short
    const ctx = ctxFor({ folder: 'engine', accounts: ACCOUNTS });
    const store = E.memoryStore();
    const out = await E.runSync({ adapter, conn: { ...ctx.conn, cursors: {} }, ctx, store, sources: { people: async () => people, time_weeks: async () => [], payroll_journal: async () => journals } });
    assert.equal(out.status, 'partial');
    assert.equal(out.stats.people_csv.created, 1); assert.equal(out.stats.time_csv.fetched, 0); assert.equal(out.stats.journal_csv.failed, 1);
    const [dl] = await store.listDeadLetters('c1', { status: 'open' });
    assert.equal(dl.kind, 'validation'); assert.match(dl.error, /out of balance \(debits 1076\.5, credits 1026\.5\)/);
    const files = fs.readdirSync(path.join(root, 'org_a', 'engine'));
    assert.equal(files.length, 1); assert.match(files[0], /^people_/, 'no journal file is written for a journal that does not balance');
});
