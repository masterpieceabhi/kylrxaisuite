import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const V = require('../services/vault-rules.js');
const P = require('../services/postings-rules.js');
const E = require('../services/eeo-rules.js');
const O = require('../services/osha-rules.js');

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]);
const file = (buffer, originalname) => ({ buffer, originalname });
const meta = (o = {}) => ({ scope: 'employee', category: 'offer_letter', userId: 'u1', title: 'Offer letter', ...o });

test('vault: real PDF, image and Office files pass', () => {
    assert.deepEqual(V.validateUpload(meta(), file(PDF, 'offer.pdf')).errors, []);
    assert.deepEqual(V.validateUpload(meta({ category: 'certification' }), file(PNG, 'cert.png')).errors, []);
    const docx = V.validateUpload(meta(), file(ZIP, 'letter.docx'));
    assert.deepEqual(docx.errors, []); assert.match(docx.value.mime, /wordprocessingml/);
    assert.match(V.validateUpload(meta(), file(ZIP, 'sheet.xlsx')).value.mime, /spreadsheetml/);
    assert.equal(V.validateUpload(meta(), file(Buffer.from('plain notes here'), 'notes.txt')).errors.length, 0);
});

test('vault: executables, disguised files, empty and oversized files are refused', () => {
    assert.ok(V.validateUpload(meta(), file(EXE, 'invoice.pdf')).errors.some((e) => /not allowed/.test(e)));
    assert.ok(V.validateUpload(meta(), file(PDF, 'picture.png')).errors.some((e) => /content looks like/.test(e)));
    assert.ok(V.validateUpload(meta(), file(Buffer.alloc(0), 'a.pdf')).errors.some((e) => /required/.test(e)));
    assert.ok(V.validateUpload(meta(), file(Buffer.concat([PDF, Buffer.alloc(V.MAX_BYTES)]), 'big.pdf')).errors.some((e) => /10 MB/.test(e)));
    assert.ok(V.validateUpload(meta(), file(Buffer.from([1, 2, 3, 0, 5, 6, 7, 8]), 'blob.bin')).errors.length > 0);
});

test('vault: metadata rules (scope vs category, employee needed, expiry, confidential never shared)', () => {
    assert.ok(V.validateUpload(meta({ category: 'handbook' }), file(PDF, 'a.pdf')).errors.some((e) => /belongs to company/.test(e)));
    assert.ok(V.validateUpload(meta({ userId: null }), file(PDF, 'a.pdf')).errors.some((e) => /Choose the employee/.test(e)));
    assert.ok(V.validateUpload(meta({ expiresOn: '2026-02-30' }), file(PDF, 'a.pdf')).errors.some((e) => /expiresOn/.test(e)));
    const conf = V.validateUpload(meta({ category: 'medical_confidential', shared: true }), file(PDF, 'a.pdf')).value;
    assert.equal(conf.confidential, true); assert.equal(conf.shared, false);
    assert.equal(V.safeFileName('..\\evil/name?.pdf'), '.._evil_name_.pdf');
});

test('vault: who can see what', () => {
    const own = { scope: 'employee', userId: 'u1', shared: true };
    assert.equal(V.canView(own, { id: 'u1', role: 'employee' }), true);
    assert.equal(V.canView({ ...own, shared: false }, { id: 'u1', role: 'employee' }), false);
    assert.equal(V.canView(own, { id: 'u2', role: 'employee' }), false);
    assert.equal(V.canView({ ...own, shared: false }, { id: 'h', role: 'hr_admin' }), true);
    assert.equal(V.canView({ scope: 'company', shared: true }, { id: 'u9', role: 'manager' }), true);
    const secret = { scope: 'employee', userId: 'u1', confidential: true, shared: true };
    assert.equal(V.canView(secret, { id: 'u1', role: 'employee' }), false);
    assert.equal(V.canView(secret, { id: 'h', role: 'hrms' }), false);
    assert.equal(V.canView(secret, { id: 'h', role: 'hr_admin' }), true);
    assert.equal(V.canView({ ...own, deleted: true }, { id: 'h', role: 'super_admin' }), false);
});

test('vault: retention and deletion', () => {
    assert.equal(V.retainUntil('osha_filing', '2026-11-10T10:00:00Z'), '2031-11-10');
    assert.equal(V.retainUntil('handbook', '2026-11-10'), null);
    assert.equal(V.deletionCheck({ retainUntil: '2030-01-01' }, '2026-11-10').ok, false);
    assert.equal(V.deletionCheck({ retainUntil: '2025-01-01' }, '2026-11-10').ok, true);
    assert.equal(V.deletionCheck({ retainUntil: null }, '2026-11-10').ok, true);
    assert.equal(V.deletionCheck({ retainUntil: '2025-01-01', legalHold: true }, '2026-11-10').ok, false);
    assert.equal(V.daysUntil('2026-12-10', '2026-11-10'), 30);
});

test('postings: status from posted date, review window, headcount and states', () => {
    const today = '2026-11-10';
    const flsa = P.FEDERAL.find((f) => f.key === 'flsa'); const fmla = P.FEDERAL.find((f) => f.key === 'fmla');
    assert.equal(P.statusOf(flsa, null, 10, today), 'not_posted');
    assert.equal(P.statusOf(flsa, { postedOn: '2026-06-01' }, 10, today), 'posted');
    assert.equal(P.statusOf(flsa, { postedOn: '2025-10-20' }, 10, today), 'review_due'); // a year old
    assert.equal(P.statusOf(flsa, { postedOn: '2026-06-01', nextReviewOn: '2026-11-25' }, 10, today), 'review_due');
    assert.equal(P.statusOf(fmla, null, 12, today), 'not_applicable');
    assert.equal(P.statusOf(fmla, null, 60, today), 'not_posted');
    const t = P.buildTracker({ flsa: { postedOn: '2026-06-01' } }, 12, ['TX', 'TX', 'CA'], today);
    assert.deepEqual(t.items.filter((i) => i.scope !== 'federal').map((i) => i.key), ['state_CA', 'state_TX']);
    assert.equal(t.counts.posted, 1);
    assert.ok(P.validateEntry({ postedOn: 'x', location: '' }).errors.length === 2);
    assert.deepEqual(P.validateEntry({ postedOn: '2026-06-01', location: 'Break room' }).errors, []);
});

test('EEO self-ID: voluntary notice required; every answer is a valid choice', () => {
    const ok = { voluntaryNoticeAccepted: true, sex: 'female', hispanic: 'no', races: ['white', 'asian'], veteran: 'declined', disability: 'declined' };
    assert.deepEqual(E.validateSelfId(ok).errors, []);
    assert.ok(E.validateSelfId({ ...ok, voluntaryNoticeAccepted: false }).errors.length > 0);
    assert.ok(E.validateSelfId({ ...ok, sex: 'x' }).errors.length > 0);
    assert.ok(E.validateSelfId({ ...ok, races: ['alien'] }).errors.length > 0);
    assert.ok(E.validateSelfId({ voluntaryNoticeAccepted: true }).errors.length >= 4);
    assert.equal(E.raceColumn({ hispanic: 'yes', races: ['white'] }), 'hispanic');
    assert.equal(E.raceColumn({ hispanic: 'no', races: ['white', 'black'] }), 'two_or_more');
    assert.equal(E.raceColumn({ hispanic: 'no', races: ['asian'] }), 'asian');
    assert.equal(E.raceColumn({ hispanic: 'declined', races: [] }), null);
});

test('EEO-1 counts by job category, race/ethnicity and sex, with unreported people kept out', () => {
    const id = (sex, hispanic, races) => ({ sex, hispanic, races, veteran: 'declined', disability: 'declined' });
    const r = E.eeoReport([
        { jobCategory: 'service', selfId: id('female', 'yes', []) },
        { jobCategory: 'service', selfId: id('male', 'no', ['black']) },
        { jobCategory: 'service', selfId: id('female', 'no', ['white', 'asian']) },
        { jobCategory: 'mid_manager', selfId: id('male', 'no', ['white']) },
        { jobCategory: 'service', selfId: id('non_binary', 'no', ['white']) },
        { jobCategory: 'service', selfId: null },
        { jobCategory: null, selfId: id('male', 'no', ['white']) },
        { jobCategory: 'service', selfId: id('male', 'declined', []) }
    ]);
    const service = r.rows.find((x) => x.key === 'service');
    assert.equal(service.total, 3);
    assert.equal(service.cells.hispanic_female, 1); assert.equal(service.cells.black_male, 1); assert.equal(service.cells.two_or_more_female, 1);
    assert.equal(r.rows.find((x) => x.key === 'mid_manager').cells.white_male, 1);
    assert.equal(r.grandTotal, 4); assert.equal(r.totals.hispanic_female, 1);
    assert.deepEqual(r.notReported, { noJobCategory: 1, noSelfId: 1, sexNotMaleFemale: 1, noRaceOrEthnicity: 1 });
    assert.equal(r.completenessPercent, 50);
});

test('OSHA: a report needs a real past date, description and place', () => {
    assert.deepEqual(O.validateReport({ dateOfIncident: '2026-11-09', description: 'Slipped on wet floor', location: 'Kitchen' }, '2026-11-10').errors, []);
    assert.ok(O.validateReport({ dateOfIncident: '2027-01-01', description: 'x', location: '' }, '2026-11-10').errors.length === 3);
});

test('OSHA: classification rules', () => {
    const ok = O.validateClassification({ classification: 'days_away', injuryType: 'injury', daysAway: 5 });
    assert.deepEqual(ok.errors, []); assert.equal(ok.value.daysAway, 5);
    assert.ok(O.validateClassification({ classification: 'days_away', injuryType: 'injury', daysAway: 0 }).errors.some((e) => /at least 1 day/.test(e)));
    assert.ok(O.validateClassification({ classification: 'other_recordable' }).errors.some((e) => /injuryType/.test(e)));
    assert.deepEqual(O.validateClassification({ classification: 'not_recordable' }).errors, []);
    assert.ok(O.validateClassification({ classification: 'death', injuryType: 'injury' }).errors.some((e) => /date of death/.test(e)));
    assert.equal(O.validateClassification({ classification: 'days_away', injuryType: 'injury', daysAway: 300 }).value.daysAway, 180); // counting stops at 180
    assert.ok(O.validateClassification({ classification: 'weird' }).errors.length > 0);
});

test('OSHA 300 log and 300A summary with incidence rates', () => {
    const inc = [
        { classification: 'days_away', injuryType: 'injury', dateOfIncident: '2026-03-02', employeeName: 'Ana Cruz', location: 'Kitchen', description: 'Cut', daysAway: 4, daysRestricted: 2 },
        { classification: 'other_recordable', injuryType: 'skin_disorder', dateOfIncident: '2026-01-15', employeeName: 'Tom Baker', location: 'Laundry', description: 'Rash', privacyCase: true },
        { classification: 'restricted_or_transfer', injuryType: 'injury', dateOfIncident: '2026-06-20', employeeName: 'Lee Park', location: 'Dock', description: 'Strain', daysRestricted: 10 },
        { classification: 'not_recordable', dateOfIncident: '2026-04-01', employeeName: 'X', location: 'Y', description: 'First aid only' },
        { classification: 'days_away', injuryType: 'injury', dateOfIncident: '2025-12-30', employeeName: 'Old', location: 'Z', description: 'Last year', daysAway: 3 }
    ];
    const rows = O.logRows(inc, 2026);
    assert.deepEqual(rows.map((r) => r.caseNumber), [1, 2, 3]);
    assert.equal(rows[0].employeeName, 'Privacy Case'); assert.equal(rows[0].dateOfIncident, '2026-01-15');
    const s = O.summary(inc, 2026, 100000, 25);
    assert.equal(s.totalRecordable, 3); assert.equal(s.daysAwayCases, 1); assert.equal(s.restrictedCases, 1); assert.equal(s.otherRecordable, 1);
    assert.equal(s.totalDaysAway, 4); assert.equal(s.totalDaysRestricted, 12);
    assert.equal(s.tcir, 6); // 3 x 200000 / 100000
    assert.equal(s.dartRate, 4); // 2 x 200000 / 100000
    assert.equal(s.byInjuryType.find((t) => t.type === 'skin_disorder').count, 1);
    assert.equal(O.summary(inc, 2026, 0, 25).tcir, null);
});
