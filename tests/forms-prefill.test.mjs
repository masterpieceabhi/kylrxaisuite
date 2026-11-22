// "Ask less": forms start from what the system already knows or can work out (the signer's job title, the document's
// title, the work permit's end date, departments, the company address and time zone, the person's work location, their
// own EEO answers, the next pay period). Pure rules, small page functions run on their own, and the real routes on an
// in-memory database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { startServer, seedCompanies } from './helpers/permission-harness.mjs';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kylrx-prefill-test-'));
process.env.VAULT_DIR = vaultDir;
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const R = require('../services/i9-rules.js');
const compliance = require('../routes/us-compliance.js');
const forms = require('../routes/us-forms.js');

const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
/** Runs named top-level functions/consts of a page's script on their own and returns them */
function pageFns(file, names, extra = '') {
    const src = read(file);
    const pieces = names.map((n) => {
        const m = src.match(new RegExp(`^(?:const ${n} = .*|function ${n}\\([^)]*\\) \\{[\\s\\S]*?^\\})$`, 'm'));
        assert.ok(m, `${file} defines ${n}`);
        return m[0];
    });
    const ctx = {}; vm.createContext(ctx);
    vm.runInContext(`${extra}\n${pieces.join('\n')}\nthis.out = { ${names.join(', ')} };`, ctx);
    return ctx.out;
}

/* --------------------------------------- I-9 --------------------------------------- */

test('the signer job title comes from their own record, usProfile first, trimmed and capped', () => {
    assert.equal(R.signerTitleOf({ jobTitle: '  HR Manager ' }), 'HR Manager');
    assert.equal(R.signerTitleOf({ jobTitle: 'Old title', usProfile: { jobTitle: 'People Lead' } }), 'People Lead');
    assert.equal(R.signerTitleOf({}), '');
    assert.equal(R.signerTitleOf(undefined), '');
    assert.equal(R.signerTitleOf({ jobTitle: 'x'.repeat(300) }).length, 120);
});

test('Section 2 offers the work permit end date the person gave in Section 1, and nothing otherwise', () => {
    assert.deepEqual(R.section2Prefill({ citizenshipStatus: 'alien_authorized_to_work', workAuthorizationExpires: '2027-03-31' }), { expiresOn: { employment_authorization_document: '2027-03-31' } });
    assert.deepEqual(R.section2Prefill({ citizenshipStatus: 'us_citizen' }), { expiresOn: {} });
    assert.deepEqual(R.section2Prefill({ citizenshipStatus: 'alien_authorized_to_work', workAuthorizationExpires: 'soon' }), { expiresOn: {} });
    assert.deepEqual(R.section2Prefill(null), { expiresOn: {} });
});

test('the document title is optional: the server falls back to the title of the document type', () => {
    const F = require('../services/us-forms.js');
    const r = F.validateDocument({ type: 'us_passport', title: '', issuingAuthority: 'U.S. Department of State', number: 'X1234567' }, F.I9_LIST_A, 'listA');
    assert.deepEqual(r.errors, []);
    assert.equal(R.publicDocument({ type: 'us_passport', title: '' }).title, R.titleOf('us_passport'));
    const b = R.validateSupplementB({ kind: 'reverification', document: { list: 'A', type: 'employment_authorization_document', number: 'EAD1234567', expiresOn: '2028-01-01' }, examinedOn: '2026-11-01', signerName: 'Hana HR', certification: true }, { todayIso: '2026-11-21' });
    assert.deepEqual(b.errors, []);
    assert.equal(b.value.document.title, R.titleOf('employment_authorization_document'));
});

test('the I-9 page fills the title, the expiry and the job title, and lets people change them', () => {
    const src = read('admin-us-i9.html');
    assert.match(src, /Document title \(optional: filled in from the document\)/);
    assert.match(src, /id="\$\{p\}Title2" maxlength="120" value="\$\{esc\(list\.myJobTitle \|\| ''\)\}"/);
    assert.match(src, /if \(p !== 'bd'\) autoFill\(\$\(`\$\{p\}Exp`\), \(\(\(current && current\.section2Prefill\) \|\| \{\}\)\.expiresOn \|\| \{\}\)\[sel\.value\] \|\| ''\);/);
    // autoFill replaces only an empty box or the value it put there itself
    const { autoFill } = pageFns('admin-us-i9.html', ['autoFill']);
    const box = { value: '', dataset: {} };
    autoFill(box, 'Employment Authorization Document'); assert.equal(box.value, 'Employment Authorization Document');
    autoFill(box, 'U.S. passport'); assert.equal(box.value, 'U.S. passport', 'follows a new choice while untouched');
    box.value = 'Typed by HR'; autoFill(box, 'Something else'); assert.equal(box.value, 'Typed by HR', 'never replaces what was typed');
    const exp = { value: '', dataset: {} };
    autoFill(exp, '2027-03-31'); assert.equal(exp.value, '2027-03-31');
    autoFill(exp, ''); assert.equal(exp.value, '', 'a document without a known end date clears the offered one');
});

/* --------------------------------------- EEO self-identification --------------------------------------- */

test('own EEO answers: only a stored record owned by the caller in their own company is returned', () => {
    const { ownSelfId } = compliance.helpers;
    const rec = { sex: 'female', hispanic: 'no', races: ['asian'], veteran: 'declined', disability: 'no' };
    assert.deepEqual(ownSelfId({ orgId: 'o1', userId: 'u1', record: rec }, 'o1', 'u1'), rec);
    assert.equal(ownSelfId({ orgId: 'o1', userId: 'u2', record: rec }, 'o1', 'u1'), null);
    assert.equal(ownSelfId({ orgId: 'o2', userId: 'u1', record: rec }, 'o1', 'u1'), null);
    assert.equal(ownSelfId(null, 'o1', 'u1'), null);
    // the route reads only the caller's own document and has no way to name another person
    const route = read('routes/us-compliance.js').match(/router\.get\('\/eeo\/me'[\s\S]*?\n\}\);/)[0];
    assert.match(route, /doc\(`\$\{req\.orgId\}_\$\{req\.user\.id\}`\)/);
    assert.match(route, /ownSelfId\(snap\.data\(\), req\.orgId, req\.user\.id\)/);
    assert.doesNotMatch(route, /req\.(params|query|body)/);
});

test('the self-ID page starts from the saved answers, every race box included', () => {
    const src = read('self-id.html');
    assert.match(src, /saved = r\.answers \|\| null;/);
    const { answersToPairs } = pageFns('self-id.html', ['answersToPairs']);
    assert.deepEqual(JSON.parse(JSON.stringify(answersToPairs({ sex: 'male', hispanic: 'no', races: ['white', 'asian'], veteran: 'declined', disability: 'yes' }))),
        [['sex', 'male'], ['hispanic', 'no'], ['veteran', 'declined'], ['disability', 'yes'], ['races', 'white'], ['races', 'asian']]);
    assert.deepEqual(JSON.parse(JSON.stringify(answersToPairs(null))), []);
});

/* --------------------------------------- injuries --------------------------------------- */

test('the 300 log description carries the part of the body the person reported', () => {
    const { describeInjury } = compliance.helpers;
    assert.equal(describeInjury({ description: 'Cut on a box cutter', bodyPart: 'left hand' }), 'Cut on a box cutter (part of body: left hand)');
    assert.equal(describeInjury({ description: 'Slipped', bodyPart: '  ' }), 'Slipped');
    assert.equal(describeInjury({ description: '', bodyPart: 'back' }), 'Part of body: back');
    assert.match(read('admin-us-compliance.html'), /\$\{i\.bodyPart \? `Part of body: \$\{esc\(i\.bodyPart\)\}\. ` : ''\}/);
});

test('the injury page starts "where" from the work location and never replaces what was typed', () => {
    const src = read('report-injury.html');
    assert.match(src, /myLocation = r\.myLocation \|\| '';/);
    assert.match(src, /if \(myLocation && !\$\('f'\)\.location\.value\.trim\(\)\) \$\('f'\)\.location\.value = myLocation;/);
    assert.match(src, /\$\{esc\(i\.location\)\}/, 'the place is escaped in "My reports"');
});

/* --------------------------------------- other pages --------------------------------------- */

test('the add-employee department is a list of the company departments, free text when there is none', () => {
    const src = read('admin-us-people.html');
    assert.match(src, /async function loadDepartmentPick\(\)/);
    assert.match(src, /catch \(_\) \{ return; \}/);
    assert.match(src, /if \(!rows\.length\) return;/);
    assert.match(src, /sel\.name = 'department';/, 'still sends the department name the add API saves');
    assert.match(src, /await loadDepartmentPick\(\);/);
});

test('the first location starts from the company address and the company time zone', () => {
    const src = read('admin-us-org.html');
    assert.match(src, /if \(locEdit \|\| locations\.length \|\| !companyAddress\) return;/);
    assert.match(src, /const p = c\.profile \|\| c\.suggested; companyAddress = \(p && p\.businessAddress\) \|\| null;/);
    assert.match(src, /companyTz = knownTz\(me\.company && me\.company\.timeZone\) \|\| companyTz;/);
    assert.match(src, /\$\('tzPick'\)\.value = companyTz;/);
    assert.doesNotMatch(src, /\$\('tzPick'\)\.value = 'America\/Chicago'/);
});

test('a pay change starts on the first day of the next pay period, or today', () => {
    const { nextPeriodStart } = pageFns('admin-us-pay.html', ['plusDay', 'nextPeriodStart']);
    assert.equal(nextPeriodStart({ containing: { start: '2026-11-15', end: '2026-11-28' }, next: [] }, '2026-11-21'), '2026-11-29');
    assert.equal(nextPeriodStart({ containing: { start: '2026-12-16', end: '2026-12-31' } }, '2026-12-20'), '2027-01-01');
    assert.equal(nextPeriodStart({ containing: null, next: [{ start: '2026-11-01', end: '2026-11-14' }, { start: '2026-11-29', end: '2026-12-12' }] }, '2026-11-21'), '2026-11-29');
    assert.equal(nextPeriodStart(null, '2026-11-21'), null);
    const src = read('admin-us-pay.html');
    assert.match(src, /if \(!el\.dataset\.typed\) el\.value = start \|\| today;/);
    assert.match(src, /\/pay-schedules\/\$\{encodeURIComponent\(sid\)\}\/preview/);
});

test('my profile no longer asks for marital status (the server still accepts it from older pages)', () => {
    assert.doesNotMatch(read('my-profile.html'), /marital/i);
    const PC = require('../services/profile-change-rules.js');
    assert.deepEqual(PC.validateDirectEdit({ maritalStatus: 'married' }).errors, []);
});

/* --------------------------------------- the real routes --------------------------------------- */

let srv;
test.before(async () => { srv = await startServer(compliance, forms); });
test.after(async () => { await srv.stop(); fs.rmSync(vaultDir, { recursive: true, force: true }); });

const ANSWERS = { voluntaryNoticeAccepted: true, sex: 'female', hispanic: 'no', races: ['black', 'white'], veteran: 'not_protected_veteran', disability: 'declined' };

test('GET /eeo/me gives the person their own answers and nobody else gets them', async () => {
    await seedCompanies(db, mem);
    assert.equal((await srv.call('PUT', '/eeo/me', 'workerA', ANSWERS)).status, 200);
    const own = await srv.call('GET', '/eeo/me', 'workerA');
    assert.equal(own.status, 200);
    assert.equal(own.body.answered, true);
    assert.deepEqual(own.body.answers, { sex: 'female', hispanic: 'no', races: ['black', 'white'], veteran: 'not_protected_veteran', disability: 'declined' });
    assert.match(own.headers.get('cache-control') || '', /no-store/);
    for (const who of ['hr_adminA', 'super_adminA', 'managerA', 'workerB']) {
        const r = await srv.call('GET', '/eeo/me', who);
        assert.equal(r.status, 200, who);
        assert.equal(r.body.answers, null, `${who} sees no one's answers`);
        assert.equal(r.body.answered, false, who);
    }
    // a record stored for someone else under the caller's key is not handed out
    await db.collection('eeo_selfid').doc('orgA_managerA').set({ orgId: 'orgA', userId: 'workerA', record: { sex: 'male' }, updatedAt: '2026-11-01T00:00:00Z' });
    assert.equal((await srv.call('GET', '/eeo/me', 'managerA')).body.answers, null);
});

test('GET /osha/incidents names the caller\'s own work location; the 300 log CSV carries the body part', async () => {
    const { person } = await seedCompanies(db, mem);
    await db.collection('locations').doc('locA').set({ orgId: 'orgA', name: 'Main Street store', active: true });
    await db.collection('locations').doc('locB').set({ orgId: 'orgB', name: 'Bravo depot', active: true });
    await person('floorA', 'orgA', 'employee', 'Flo Floor', { usProfile: { workLocationId: 'locA' } });
    await person('strayA', 'orgA', 'employee', 'Stray', { usProfile: { workLocationId: 'locB' } });
    assert.equal((await srv.call('GET', '/osha/incidents', 'floorA')).body.myLocation, 'Main Street store');
    assert.equal((await srv.call('GET', '/osha/incidents', 'strayA')).body.myLocation, null, 'another company\'s location is never named');
    assert.equal((await srv.call('GET', '/osha/incidents', 'workerA')).body.myLocation, null);

    const year = new Date().getFullYear();
    await db.collection('osha_incidents').doc('inc1').set({ orgId: 'orgA', userId: 'floorA', employeeName: 'Flo Floor', dateOfIncident: `${year}-01-15`, location: 'Main Street store', description: 'Cut while opening a box', bodyPart: 'left hand', status: 'classified', classification: 'other_recordable', injuryType: 'injury', reportedAt: `${year}-01-15T10:00:00Z` });
    const log = await srv.call('GET', `/osha/log?year=${year}&format=csv`, 'hr_adminA');
    assert.equal(log.status, 200);
    assert.match(log.text, /Cut while opening a box \(part of body: left hand\)/);
    const staff = await srv.call('GET', '/osha/incidents', 'hr_adminA');
    assert.equal(staff.body.data.find((i) => i.id === 'inc1').bodyPart, 'left hand', 'HR sees the body part in the incident view');
});

test('GET /i9 returns the signer\'s own job title; one person\'s I-9 offers the work permit end date', async () => {
    const { person } = await seedCompanies(db, mem);
    await person('hrTitled', 'orgA', 'hr_admin', 'Hana HR', { jobTitle: 'Old title', usProfile: { jobTitle: 'People Operations Lead' } });
    await person('newHire', 'orgA', 'employee', 'Nia New', {
        usForms: { i9: { section1: { citizenshipStatus: 'alien_authorized_to_work', workAuthorizationExpires: '2027-06-30', signedName: 'Nia New', signedAt: '2026-11-01T00:00:00Z' } } }
    });
    const list = await srv.call('GET', '/i9', 'hrTitled');
    assert.equal(list.status, 200);
    assert.equal(list.body.myJobTitle, 'People Operations Lead');
    assert.equal((await srv.call('GET', '/i9', 'hr_adminA')).body.myJobTitle, null);
    const one = await srv.call('GET', '/employees/newHire/i9', 'hrTitled');
    assert.equal(one.status, 200);
    assert.deepEqual(one.body.section2Prefill, { expiresOn: { employment_authorization_document: '2027-06-30' } });
});
