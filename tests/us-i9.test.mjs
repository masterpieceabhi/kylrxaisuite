// US-C05: Form I-9 for HR. Pure rules (lists, masking, Supplement B, the list row) and the real routes with sign-in
// tokens on an in-memory database: Section 2, reverification and rehire, document copies in the vault, number reveal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, seedCompanies } from './helpers/permission-harness.mjs';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kylrx-i9-test-'));
process.env.VAULT_DIR = vaultDir;
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const F = require('../services/us-forms.js');
const R = require('../services/i9-rules.js');
const fileStore = require('../services/file-store.js');

const iso = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

/* --------------------------------------- rules --------------------------------------- */

test('the lists are exactly the ones the form rules validate against, each with a plain title', () => {
    const lists = R.documentLists();
    assert.deepEqual(lists.A.map((d) => d.key), F.I9_LIST_A); assert.deepEqual(lists.B.map((d) => d.key), F.I9_LIST_B); assert.deepEqual(lists.C.map((d) => d.key), F.I9_LIST_C);
    for (const d of [...lists.A, ...lists.B, ...lists.C]) { assert.ok(d.label && d.label !== d.key, `${d.key} has a title`); assert.ok(!/_/.test(d.label), d.label); }
    assert.deepEqual(Object.keys(R.TITLES).sort(), [...F.I9_LIST_A, ...F.I9_LIST_B, ...F.I9_LIST_C].sort(), 'no title for a document the rules do not know');
    assert.match(R.ADVISOR_NOTE, /compliance advisor/);
});

test('a document number is never shown whole in a list: short numbers keep less, very short ones nothing', () => {
    assert.equal(R.tailOf('A123456789'), '6789'); assert.equal(R.tailOf('12345678'), '5678'); assert.equal(R.tailOf('1234567'), '67'); assert.equal(R.tailOf('1234'), '34');
    assert.equal(R.tailOf('123'), ''); assert.equal(R.tailOf(''), ''); assert.equal(R.tailOf(null), '');
    assert.equal(R.maskNumber('6789'), 'ends in 6789'); assert.equal(R.maskNumber(''), 'on file');
    const pub = R.publicDocument({ type: 'us_passport', number: 'SHOULD-NOT-BE-HERE', numberEncrypted: 'v1:secret', numberLast4: '6789', expiresOn: '2030-01-01' });
    assert.deepEqual(pub, { type: 'us_passport', expiresOn: '2030-01-01', title: 'U.S. passport', numberMasked: 'ends in 6789', hasNumber: true });
    const s2 = R.publicSection2({ listA: { type: 'us_passport', numberEncrypted: 'v1:a', numberLast4: '11' }, examinedOn: '2026-01-02', supplementB: [{ id: 's1', kind: 'reverification', document: { list: 'A', type: 'employment_authorization_document', numberEncrypted: 'v1:b', numberLast4: '2222' } }] });
    assert.ok(!JSON.stringify(s2).includes('v1:'), 'no encrypted value leaves, also not inside Supplement B'); assert.equal(s2.supplementB[0].document.numberMasked, 'ends in 2222'); assert.equal(s2.listB, null);
    assert.equal(R.publicSection2(null), null);
});

test('Supplement B: a reverification needs a List A or List C document; a rehire needs its date; the certification is required', () => {
    const doc = { list: 'A', type: 'employment_authorization_document', number: 'EAD1234567', expiresOn: '2028-05-01' };
    const base = { kind: 'reverification', document: doc, examinedOn: '2026-11-10', signerName: 'Hana HR', certification: true };
    const ok = R.validateSupplementB(base, { todayIso: '2026-11-12' });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value, { kind: 'reverification', document: { list: 'A', type: 'employment_authorization_document', title: 'Employment Authorization Document (Form I-766)', issuingAuthority: null, number: 'EAD1234567', expiresOn: '2028-05-01' }, examinedOn: '2026-11-10', examinationMethod: 'in_person', signerName: 'Hana HR' });
    const err = (patch, re) => { const r = R.validateSupplementB({ ...base, ...patch }, { todayIso: '2026-11-12' }); assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(patch)} -> ${r.errors.join('; ')}`); assert.equal(r.value, null); };
    err({ kind: 'renewal' }, /kind must be/);
    err({ document: undefined }, /needs the new document/);
    err({ document: { ...doc, list: 'B', type: 'drivers_license' } }, /list must be A or C/);
    err({ document: { ...doc, type: 'drivers_license' } }, /document\.type/);
    err({ document: { ...doc, list: 'C' } }, /document\.type/);
    err({ document: { ...doc, number: ' ' } }, /document\.number is required/);
    err({ document: { ...doc, expiresOn: '05/01/2028' } }, /expiresOn/);
    err({ examinedOn: '2026-11-13' }, /future/);
    err({ examinedOn: 'soon' }, /examinedOn/);
    err({ examinationMethod: 'by_phone' }, /examinationMethod/);
    err({ signerName: '' }, /signerName/);
    err({ certification: 'yes' }, /certification/);
    err({ kind: 'rehire', document: undefined }, /rehireDate/);
    err({ kind: 'name_change', document: undefined }, /newName/);
    const rehire = R.validateSupplementB({ kind: 'rehire', rehireDate: '2026-11-09', examinedOn: '2026-11-10', signerName: 'Hana HR', signerTitle: 'HR lead', certification: true, examinationMethod: 'alternative_procedure' }, { todayIso: '2026-11-12' });
    assert.deepEqual(rehire.value, { kind: 'rehire', rehireDate: '2026-11-09', examinedOn: '2026-11-10', examinationMethod: 'alternative_procedure', signerName: 'Hana HR', signerTitle: 'HR lead' });
    const cDoc = R.validateSupplementB({ ...base, document: { list: 'C', type: 'employment_authorization_dhs', number: 'I94-00112233' } }, { todayIso: '2026-11-12' });
    assert.equal(cDoc.value.document.expiresOn, null); assert.equal(cDoc.value.document.title, 'Employment authorization document issued by DHS');
    assert.equal(R.validateSupplementB(null).errors.length > 3, true);
});

test('reverification date: a newer Supplement B document replaces the earlier dates; citizens and green cards are never reverified', () => {
    const s1 = { citizenshipStatus: 'alien_authorized_to_work', workAuthorizationExpires: '2027-01-10' };
    const s2 = { listA: { type: 'employment_authorization_document', expiresOn: '2027-01-10' } };
    assert.equal(F.reverificationDate(s1, s2), '2027-01-10');
    const sup = (expiresOn) => ({ kind: 'reverification', document: { list: 'A', type: 'employment_authorization_document', expiresOn } });
    assert.equal(F.reverificationDate(s1, { ...s2, supplementB: [sup('2028-06-30')] }), '2028-06-30');
    assert.equal(F.reverificationDate(s1, { ...s2, supplementB: [sup('2028-06-30'), { kind: 'name_change', newName: 'New Name' }] }), '2028-06-30', 'an entry without a document changes nothing');
    assert.equal(F.reverificationDate(s1, { ...s2, supplementB: [sup('2028-06-30'), sup('2030-01-01')] }), '2030-01-01', 'the newest document counts');
    assert.equal(F.reverificationDate(s1, { ...s2, supplementB: [sup(null)] }), null, 'a document that does not expire ends reverification');
    for (const status of ['us_citizen', 'noncitizen_national']) assert.equal(F.reverificationDate({ citizenshipStatus: status }, { listA: { type: 'us_passport', expiresOn: '2026-12-01' } }), null, status);
    assert.equal(F.reverificationDate({ citizenshipStatus: 'lawful_permanent_resident' }, { listA: { type: 'permanent_resident_card', expiresOn: '2026-12-01' } }), null);
    assert.equal(F.reverificationDate({ citizenshipStatus: 'lawful_permanent_resident' }, { listA: { type: 'foreign_passport_with_i551', expiresOn: '2026-12-01' } }), '2026-12-01');
    assert.equal(F.onboardingStatus({ firstDay: '2026-11-02', w4: { current: {} }, i9: { section1: { citizenshipStatus: 'us_citizen' }, section2: { listA: { type: 'us_passport', expiresOn: '2026-11-20' } } }, todayIso: '2026-11-10' }).flags.length, 0);
});

test('the list row: state, the Section 2 deadline (3 business days after the first day), masked documents and what to do next', () => {
    const person = (usForms, extra = {}) => ({ id: 'u1', data: { employeeId: 'E1', name: 'Ada Lovelace', usForms, ...extra } });
    // first day Monday 2026-11-02 -> Section 2 due Thursday 2026-11-05
    let r = R.listRow(person(undefined), '2026-11-02', '2026-11-03');
    assert.deepEqual({ state: r.i9State, due: r.section2Due, left: r.section2DaysLeft, next: r.next, over: r.section1Overdue }, { state: 'not_started', due: '2026-11-05', left: 2, next: 'waiting_section1', over: true });
    const s1 = { citizenshipStatus: 'alien_authorized_to_work', workAuthorizationExpires: '2027-01-10', signedAt: '2026-11-02T15:00:00.000Z', authorizationNumberEncrypted: 'v1:x' };
    r = R.listRow(person({ i9: { section1: s1 } }), '2026-11-02', '2026-11-06');
    assert.deepEqual({ state: r.i9State, left: r.section2DaysLeft, over: r.section2Overdue, next: r.next, signed: r.section1SignedOn }, { state: 'section1_done', left: -1, over: true, next: 'section2', signed: '2026-11-02' });
    assert.equal(R.listRow(person({ i9: { section1: s1 } }), '2026-11-27', '2026-11-27', { skipFederalHolidays: true }).section2Due, '2026-12-02');
    const s2 = { listA: { type: 'employment_authorization_document', numberEncrypted: 'v1:y', numberLast4: '4567', expiresOn: '2027-01-10' }, examinedOn: '2026-11-09' };
    r = R.listRow(person({ i9: { section1: s1, section2: s2 } }), '2026-11-02', '2026-11-10');
    assert.deepEqual(r.documents, [{ list: 'A', title: 'Employment Authorization Document (Form I-766)', numberMasked: 'ends in 4567', expiresOn: '2027-01-10' }]);
    assert.deepEqual({ state: r.i9State, late: r.section2Late, on: r.reverifyOn, left: r.reverifyDaysLeft, next: r.next }, { state: 'complete', late: true, on: '2027-01-10', left: 61, next: 'reverify' });
    assert.ok(!JSON.stringify(r).includes('v1:'), 'nothing encrypted in the row');
    r = R.listRow(person({ i9: { section1: s1, section2: { ...s2, supplementB: [{ id: 's1', kind: 'reverification', examinedOn: '2026-11-10', document: { list: 'A', type: 'employment_authorization_document', numberLast4: '9999', expiresOn: '2029-01-01' } }] } } }), '2026-11-02', '2026-11-10');
    assert.deepEqual({ on: r.reverifyOn, next: r.next, n: r.supplements, latest: r.latestDocument.numberMasked }, { on: '2029-01-01', next: 'none', n: 1, latest: 'ends in 9999' });
    r = R.listRow(person({ i9: { section1: s1, section2: s2, rehire: { action: 'update_section_3', startDate: '2026-11-09' } } }), '2026-11-09', '2026-11-10');
    assert.equal(r.next, 'rehire'); assert.equal(r.rehire.startDate, '2026-11-09');
    assert.equal(R.listRow(person({ i9: { section1: s1, section2: s2, rehire: { action: 'new_i9' } } }), '2026-11-09', '2026-11-10').next, 'new_form');
});

test('upcoming expiries: soonest first, overdue included, only inside the window; totals', () => {
    const row = (id, left, state = 'complete') => ({ id, name: id, employeeId: id, i9State: state, reverifyOn: left === null ? null : '2027-01-01', reverifyDaysLeft: left, reverifyOverdue: left !== null && left < 0, section2Overdue: false });
    const rows = [row('far', 200), row('soon', 30), row('late', -5), row('none', null), row('edge', 90)];
    assert.deepEqual(R.upcomingExpiries(rows, 90).map((r) => [r.id, r.daysLeft, r.overdue]), [['late', -5, true], ['soon', 30, false], ['edge', 90, false]]);
    assert.deepEqual(R.upcomingExpiries(rows, 365).map((r) => r.id), ['late', 'soon', 'edge', 'far']);
    const s = R.summarize([...rows, row('todo', null, 'section1_done'), row('new', null, 'not_started')]);
    assert.deepEqual({ total: s.total, complete: s.complete, todo: s.section2ToDo, waiting: s.waitingSection1, soon: s.reverifySoon, overdue: s.reverifyOverdue }, { total: 7, complete: 5, todo: 1, waiting: 1, soon: 2, overdue: 1 });
});

test('which stored number a reveal points at; copy details', () => {
    const i9 = { section1: { authorizationNumberEncrypted: 'S1' }, section2: { listB: { numberEncrypted: 'B' }, listC: { numberEncrypted: 'C' }, supplementB: [{ id: 'x1', document: { numberEncrypted: 'SUP' } }, { id: 'x2' }] } };
    assert.deepEqual(R.findNumber(i9, 'section1'), { stored: 'S1' }); assert.deepEqual(R.findNumber(i9, 'listB'), { stored: 'B' }); assert.deepEqual(R.findNumber(i9, 'listA'), { stored: null });
    assert.deepEqual(R.findNumber(i9, 'supplement', 'x1'), { stored: 'SUP' }); assert.deepEqual(R.findNumber(i9, 'supplement', 'x2'), { stored: null }); assert.deepEqual(R.findNumber(i9, 'supplement', 'nope'), { stored: null });
    assert.ok(R.findNumber(i9, 'ssn').error); assert.deepEqual(R.findNumber({}, 'listA'), { stored: null });
    assert.deepEqual(R.validateCopyMeta({ list: 'B' }).value, { part: 'section2', list: 'B', supplementId: null, title: null });
    assert.deepEqual(R.validateCopyMeta({ part: 'supplement', list: 'A', supplementId: 'x1', title: ' Work permit ' }).value, { part: 'supplement', list: 'A', supplementId: 'x1', title: 'Work permit' });
    assert.equal(R.validateCopyMeta({ part: 'supplement', list: 'A' }).errors.length, 1); assert.equal(R.validateCopyMeta({ part: 'other', list: 'D' }).errors.length, 2);
});

/* ------------------------------------- the routes ------------------------------------- */

let srv;
test.before(async () => { srv = await startServer(require('../routes/us-forms.js'), require('../routes/us-vault.js')); });
test.after(async () => { await srv.stop(); fs.rmSync(vaultDir, { recursive: true, force: true }); });

const others = ['payroll_adminA', 'managerA', 'employeeA', 'accountantA', 'executiveA'];
const i9Of = async (id) => (await db.collection('users').doc(id).get()).data().usForms.i9;
const audits = async () => { await new Promise((r) => setTimeout(r, 40)); return (await db.collection('organizations/orgA/audit_logs').get()).docs.map((d) => d.data()); };
const pdf = () => new Blob(['%PDF-1.4\ncopy of the work permit\n%%EOF'], { type: 'application/pdf' });
function copyForm(fields, blob = pdf(), name = 'permit.pdf') { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.append(k, v); f.append('file', blob, name); return f; }

async function seed() {
    const { person } = await seedCompanies(db, mem);
    await person('newA', 'orgA', 'employee', 'Nia New', { usProfile: { startDate: iso(-2) } });
    return person;
}
const section1 = { citizenshipStatus: 'alien_authorized_to_work', authorizationNumber: 'A123456789', workAuthorizationExpires: iso(40), attestation: true, signedName: 'Nia New' };
const docB = { type: 'drivers_license', title: 'Texas driver license', issuingAuthority: 'Texas DPS', number: 'TX-DL-11223344', expiresOn: iso(900) };
const docC = { type: 'employment_authorization_dhs', issuingAuthority: 'DHS', number: 'I94-55667788', expiresOn: iso(40) };
const docA = { type: 'employment_authorization_document', issuingAuthority: 'USCIS', number: 'EAD-0099887766', expiresOn: iso(40) };
const sec2 = (docs) => ({ ...docs, examinedOn: iso(-1), examinationMethod: 'in_person', signerName: 'Hana HR', signerTitle: 'HR admin', certification: true });

test('routes: Section 2 from the list - who gets in, the deadline, masked numbers, and a corrected form replaces the earlier documents', async () => {
    await seed(); const { call } = srv;
    const opt = await call('GET', '/i9/options', 'auditorA');
    assert.equal(opt.status, 200); assert.equal(opt.body.lists.A.length, F.I9_LIST_A.length); assert.match(opt.body.note, /compliance advisor/);

    let list = await call('GET', '/i9', 'hr_adminA');
    assert.equal(list.status, 200, list.text);
    let row = list.body.data.find((r) => r.id === 'newA');
    assert.deepEqual({ state: row.i9State, next: row.next, due: row.section2Due }, { state: 'not_started', next: 'waiting_section1', due: F.addBusinessDays(iso(-2), 3) });
    assert.deepEqual({ manage: list.body.canManage, reveal: list.body.canReveal, copies: list.body.canStoreCopies }, { manage: true, reveal: true, copies: true });
    const aud = await call('GET', '/i9', 'auditorA');
    assert.equal(aud.status, 200); assert.deepEqual({ manage: aud.body.canManage, reveal: aud.body.canReveal, copies: aud.body.canStoreCopies }, { manage: false, reveal: false, copies: false });
    for (const who of others) { assert.equal((await call('GET', '/i9', who)).status, 403, who); assert.equal((await call('GET', '/employees/newA/i9', who)).status, 403, who); }
    assert.equal((await call('GET', '/i9', 'saIN')).status, 409); assert.equal((await call('GET', '/i9', null)).status, 401);
    assert.ok(!(await call('GET', '/i9', 'hrB')).body.data.some((r) => r.id === 'newA'), 'another company does not see the person');

    assert.equal((await call('PUT', '/employees/newA/i9/section2', 'hr_adminA', sec2({ listB: docB, listC: docC }))).status, 409, 'Section 1 comes first');
    assert.equal((await call('PUT', '/employees/newA/i9/section1', 'newA', section1)).status, 200);
    for (const who of ['auditorA', ...others, 'newA']) assert.equal((await call('PUT', '/employees/newA/i9/section2', who, sec2({ listB: docB, listC: docC }))).status, 403, `${who} cannot complete Section 2`);
    assert.equal((await call('PUT', '/employees/newA/i9/section2', 'hrB', sec2({ listA: docA }))).status, 404);
    const bad = await call('PUT', '/employees/newA/i9/section2', 'hr_adminA', sec2({ listB: docB }));
    assert.equal(bad.status, 400); assert.ok(bad.body.errors.some((e) => /List B and one List C/.test(e)));
    assert.equal((await call('PUT', '/employees/newA/i9/section2', 'hr_adminA', sec2({ listA: docA, listB: docB }))).status, 400);

    const done = await call('PUT', '/employees/newA/i9/section2', 'hr_adminA', sec2({ listB: docB, listC: docC }));
    assert.equal(done.status, 200, done.text);
    for (const secret of ['TX-DL-11223344', 'I94-55667788', 'numberEncrypted', 'A123456789']) assert.ok(!done.text.includes(secret), `${secret} is not in the answer`);
    let stored = await i9Of('newA');
    assert.ok(stored.section2.listB.numberEncrypted.startsWith('v1') && !('number' in stored.section2.listB)); assert.equal(stored.section2.listB.numberLast4, '3344'); assert.equal(stored.section2.listC.title, 'Employment authorization document issued by DHS');

    list = await call('GET', '/i9', 'auditorA');
    row = list.body.data.find((r) => r.id === 'newA');
    assert.deepEqual(row.documents.map((d) => [d.list, d.title, d.numberMasked]), [['B', 'Texas driver license', 'ends in 3344'], ['C', 'Employment authorization document issued by DHS', 'ends in 7788']]);
    assert.deepEqual({ state: row.i9State, on: row.reverifyOn, left: row.reverifyDaysLeft, next: row.next }, { state: 'complete', on: iso(40), left: R.daysBetween(list.body.today, iso(40)), next: 'reverify' }); // the company's day can be a day behind UTC
    assert.ok(!list.text.includes('11223344') && !list.text.includes('numberEncrypted'), 'the list never carries a number');
    assert.deepEqual(list.body.expiring.map((e) => [e.id, e.daysLeft, e.overdue]), [['newA', R.daysBetween(list.body.today, iso(40)), false]]);
    assert.deepEqual((await call('GET', '/i9?days=30', 'hr_adminA')).body.expiring, [], 'outside a 30-day window');

    // HR corrects the form: one List A document instead. The List B and C documents must be gone, not merged in.
    assert.equal((await call('PUT', '/employees/newA/i9/section2', 'hr_adminA', sec2({ listA: docA }))).status, 200);
    stored = await i9Of('newA');
    assert.deepEqual(Object.keys(stored.section2).filter((k) => k.startsWith('list')), ['listA']);
    const one = await call('GET', '/employees/newA/i9', 'auditorA');
    assert.equal(one.status, 200); assert.equal(one.headers.get('cache-control'), 'no-store');
    assert.equal(one.body.section2.listA.numberMasked, 'ends in 7766'); assert.equal(one.body.section1.authorizationNumberLast4, '6789'); assert.ok(!one.text.includes('Encrypted'));
    assert.equal((await call('GET', '/employees/newA/i9', 'hrB')).status, 404);

    const log = await audits();
    assert.ok(log.some((a) => a.action === 'us_i9_section2_completed' && a.actorId === 'hr_adminA' && a.corrected === true));
    assert.ok(!JSON.stringify(log).includes('11223344') && !JSON.stringify(log).includes('0099887766'), 'no document number in the audit log');
});

test('routes: a full document number is shown only to people who may reveal it, with a reason, and each reveal is logged', async () => {
    await seed(); const { call } = srv;
    await call('PUT', '/employees/newA/i9/section1', 'newA', section1);
    await call('PUT', '/employees/newA/i9/section2', 'hr_adminA', sec2({ listB: docB, listC: docC }));
    const url = '/employees/newA/i9/document-number/reveal';
    for (const who of ['auditorA', ...others, 'newA']) assert.equal((await call('POST', url, who, { which: 'listB', reason: 'checking the record' })).status, 403, `${who} cannot reveal`);
    assert.equal((await call('POST', url, 'hr_adminA', { which: 'listB', reason: 'why' })).status, 400, 'a reason is required');
    assert.equal((await call('POST', url, 'hr_adminA', { which: 'ssn', reason: 'checking the record' })).status, 400);
    assert.equal((await call('POST', url, 'hr_adminA', { which: 'listA', reason: 'checking the record' })).status, 404, 'no List A document on this form');
    assert.equal((await call('POST', url, 'hrB', { which: 'listB', reason: 'checking the record' })).status, 404, 'another company');
    const shown = await call('POST', url, 'hr_adminA', { which: 'listB', reason: 'E-Verify case needs the number' });
    assert.equal(shown.status, 200); assert.equal(shown.body.number, 'TX-DL-11223344'); assert.equal(shown.headers.get('cache-control'), 'no-store');
    assert.equal((await call('POST', url, 'super_adminA', { which: 'section1', reason: 'E-Verify case needs the number' })).body.number, 'A123456789');
    const log = await audits();
    const entry = log.find((a) => a.action === 'us_i9_document_number_revealed' && a.which === 'listB');
    assert.ok(entry && entry.actorId === 'hr_adminA' && entry.targetId === 'newA' && entry.reason === 'E-Verify case needs the number');
    assert.ok(!JSON.stringify(log).includes('11223344') && !JSON.stringify(log).includes('A123456789'), 'the number itself is never logged');
});

test('routes: reverification and rehire on Supplement B - a new document moves the expiry and clears the warning', async () => {
    const person = await seed(); const { call } = srv;
    await call('PUT', '/employees/newA/i9/section1', 'newA', section1);
    const url = '/employees/newA/i9/reverification';
    const body = { kind: 'reverification', document: { list: 'A', type: 'employment_authorization_document', number: 'EAD-NEW-44556677', expiresOn: iso(700) }, examinedOn: iso(-1), signerName: 'Hana HR', certification: true };
    assert.equal((await call('POST', url, 'hr_adminA', body)).status, 409, 'not before Section 2');
    await call('PUT', '/employees/newA/i9/section2', 'hr_adminA', sec2({ listA: docA }));
    for (const who of ['auditorA', ...others, 'newA']) assert.equal((await call('POST', url, who, body)).status, 403, `${who} cannot record Supplement B`);
    assert.equal((await call('POST', url, 'hrB', body)).status, 404); assert.equal((await call('POST', url, 'saIN', body)).status, 409);
    const bad = await call('POST', url, 'hr_adminA', { ...body, document: { ...body.document, list: 'B', type: 'drivers_license' }, certification: false });
    assert.equal(bad.status, 400); assert.equal(bad.body.errors.length, 2);

    const ok = await call('POST', url, 'hr_adminA', body);
    assert.equal(ok.status, 201, ok.text); assert.equal(ok.body.reverifyOn, iso(700)); assert.equal(ok.body.supplement.document.numberMasked, 'ends in 6677'); assert.ok(!ok.text.includes('EAD-NEW-44556677') && !ok.text.includes('Encrypted'));
    const list = await call('GET', '/i9', 'auditorA');
    const row = list.body.data.find((r) => r.id === 'newA');
    assert.deepEqual({ on: row.reverifyOn, next: row.next, n: row.supplements, latest: row.latestDocument.numberMasked }, { on: iso(700), next: 'none', n: 1, latest: 'ends in 6677' });
    assert.deepEqual(list.body.expiring, []); assert.ok(!list.text.includes('44556677'));
    const one = await call('GET', '/employees/newA/i9', 'hr_adminA');
    assert.equal(one.body.section2.supplementB.length, 1); assert.equal(one.body.section2.supplementB[0].recordedById, 'hr_adminA');
    assert.equal((await call('POST', '/employees/newA/i9/document-number/reveal', 'hr_adminA', { which: 'supplement', supplementId: ok.body.supplement.id, reason: 'checking the new permit' })).body.number, 'EAD-NEW-44556677');
    // a corrected Section 2 keeps the Supplement B entries; the paperwork list no longer warns
    assert.equal((await call('PUT', '/employees/newA/i9/section2', 'hr_adminA', sec2({ listA: { ...docA, number: 'EAD-0099887700' } }))).status, 200);
    assert.equal((await i9Of('newA')).section2.supplementB.length, 1);
    assert.deepEqual((await call('GET', '/compliance/onboarding', 'hr_adminA')).body.data.find((r) => r.name === 'Nia New').flags.filter((f) => /reverif/.test(f)), []);
    assert.equal((await call('POST', '/employees/hr_adminA/i9/reverification', 'hr_adminA', body)).status, 403, 'not for your own form');

    // rehire: the earlier form is recent, so HR records the rehire date; an old form needs a new I-9 instead
    await db.collection('users').doc('newA').update({ 'usForms.i9.rehire': { action: 'update_section_3', startDate: iso(-1) } });
    assert.equal((await call('GET', '/i9', 'hr_adminA')).body.data.find((r) => r.id === 'newA').next, 'rehire');
    assert.equal((await call('POST', url, 'hr_adminA', { kind: 'rehire', examinedOn: iso(-1), signerName: 'Hana HR', certification: true })).status, 400, 'the rehire date is required');
    const re = await call('POST', url, 'hr_adminA', { kind: 'rehire', rehireDate: iso(-1), examinedOn: iso(-1), signerName: 'Hana HR', certification: true });
    assert.equal(re.status, 201); assert.equal(re.body.reverifyOn, iso(700), 'a rehire without a document keeps the expiry');
    const after = await i9Of('newA');
    assert.equal(after.rehire, null); assert.equal(after.section2.supplementB.length, 2);
    await person('oldA', 'orgA', 'employee', 'Olu Old', { usProfile: { startDate: iso(-1) }, usForms: { i9: { section1: { citizenshipStatus: 'us_citizen', signedAt: '2019-01-02T00:00:00.000Z' }, section2: { examinedOn: '2019-01-03' }, rehire: { action: 'new_i9', startDate: iso(-1) } } } });
    assert.equal((await call('GET', '/i9', 'hr_adminA')).body.data.find((r) => r.id === 'oldA').next, 'new_form');
    assert.equal((await call('POST', '/employees/oldA/i9/reverification', 'hr_adminA', { kind: 'rehire', rehireDate: iso(-1), examinedOn: iso(-1), signerName: 'Hana HR', certification: true })).status, 409);
    // the person fills in a new Section 1: the earlier Section 2 is cleared (asking to keep it is HR's call only) and the note is settled
    assert.equal((await call('PUT', '/employees/oldA/i9/section1', 'oldA', { citizenshipStatus: 'us_citizen', attestation: true, signedName: 'Olu Old', keepSection2: true })).status, 200);
    const fresh = await i9Of('oldA');
    assert.equal(fresh.section2, null); assert.equal(fresh.rehire, null); assert.equal(fresh.section1.workAuthorizationExpires, undefined);

    const log = await audits();
    assert.equal(log.filter((a) => a.action === 'us_i9_supplement_b_recorded' && a.targetId === 'newA').length, 2);
    assert.ok(!JSON.stringify(log).includes('44556677'));
});

test('routes: a changed Section 1 does not keep fields of the earlier answer', async () => {
    await seed(); const { call } = srv;
    await call('PUT', '/employees/newA/i9/section1', 'newA', section1);
    assert.equal((await i9Of('newA')).section1.workAuthorizationExpires, iso(40));
    assert.equal((await call('PUT', '/employees/newA/i9/section1', 'newA', { citizenshipStatus: 'us_citizen', attestation: true, signedName: 'Nia New' })).status, 200);
    const s1 = (await i9Of('newA')).section1;
    assert.equal(s1.citizenshipStatus, 'us_citizen'); assert.equal(s1.workAuthorizationExpires, undefined); assert.equal(s1.authorizationNumberEncrypted, undefined);
});

test('routes: document copies go into the vault as confidential files - HR stores and opens them, the auditor only learns that they exist', async () => {
    await seed(); const { call } = srv;
    const url = '/employees/newA/i9/documents';
    assert.equal((await call('POST', url, 'hr_adminA', copyForm({ list: 'A' }))).status, 409, 'Section 1 comes first');
    await call('PUT', '/employees/newA/i9/section1', 'newA', section1);
    await call('PUT', '/employees/newA/i9/section2', 'hr_adminA', sec2({ listA: docA }));
    for (const who of ['auditorA', ...others, 'newA']) assert.equal((await call('POST', url, who, copyForm({ list: 'A' }))).status, 403, `${who} cannot store a copy`);
    assert.equal((await call('POST', url, 'hrB', copyForm({ list: 'A' }))).status, 404);
    assert.equal((await call('POST', url, 'hr_adminA', copyForm({ list: 'D' }))).status, 400);
    assert.equal((await call('POST', url, 'hr_adminA', copyForm({ list: 'A' }, new Blob(['MZ\u0090\u0000 not a document']), 'permit.pdf'))).status, 400, 'a program dressed up as a PDF is refused');
    assert.equal((await call('POST', url, 'hr_adminA', copyForm({ list: 'A', part: 'supplement', supplementId: 'nope' }))).status, 404);

    const up = await call('POST', url, 'hr_adminA', copyForm({ list: 'A', title: 'Work permit, front' }));
    assert.equal(up.status, 201, up.text);
    assert.deepEqual({ title: up.body.document.title, list: up.body.document.list, part: up.body.document.part, file: up.body.document.fileName }, { title: 'Work permit, front', list: 'A', part: 'section2', file: 'permit.pdf' });
    const id = up.body.document.id;
    const stored = (await db.collection('vault_documents').doc(id).get()).data();
    assert.deepEqual({ org: stored.orgId, cat: stored.category, conf: stored.confidential, shared: stored.shared, user: stored.userId, keep: stored.retainUntil }, { org: 'orgA', cat: 'i9_document', conf: true, shared: false, user: 'newA', keep: F.retainUntil(iso(-2), null) });
    const onDisk = fs.readFileSync(path.join(vaultDir, 'orgA', `${id}.bin`));
    assert.ok(!onDisk.includes('work permit'), 'the file is encrypted on disk'); assert.match((await fileStore.readFile('orgA', id)).toString(), /copy of the work permit/);

    const hrView = await call('GET', '/employees/newA/i9', 'hr_adminA');
    assert.deepEqual(hrView.body.copies.map((c) => c.id), [id]); assert.equal(hrView.body.copiesHidden, false);
    const audView = await call('GET', '/employees/newA/i9', 'auditorA');
    assert.deepEqual({ copies: audView.body.copies, n: audView.body.copyCount, hidden: audView.body.copiesHidden }, { copies: [], n: 1, hidden: true });
    // the vault's own routes agree
    assert.equal((await call('GET', `/vault/documents/${id}/download`, 'hr_adminA')).status, 200);
    assert.equal((await call('GET', `/vault/documents/${id}/download`, 'auditorA')).status, 403);
    assert.equal((await call('GET', `/vault/documents/${id}/download`, 'newA')).status, 403);
    assert.ok(!(await call('GET', '/vault/documents', 'auditorA')).body.data.some((d) => d.id === id));
    assert.equal((await call('GET', '/vault/documents?category=i9_document', 'hr_adminA')).body.data[0].categoryLabel, 'Form I-9 document copy');
    assert.equal((await call('DELETE', `/vault/documents/${id}`, 'hr_adminA')).status, 409, 'kept as long as the form');
    assert.ok((await audits()).some((a) => a.action === 'us_i9_document_copy_stored' && a.documentId === id && a.targetId === 'newA'));
});
