// US-H04: notice texts. Pure rules, the stored library (in-memory database), and the real routes with sign-in tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const R = require('../services/notice-template-rules.js');
const N = require('../services/notice-templates.js');
const jwt = require('jsonwebtoken');
const express = require('express');

/* --------------------------------------- rules --------------------------------------- */

test('starters: federal only, each a clearly marked starting draft, with valid fill-ins and no state law text', () => {
    assert.deepEqual(R.STARTER_KEYS, ['fmla_rights', 'cobra_general', 'marketplace_newhire']);
    const STATES = ['Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa', 'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming'];
    for (const s of R.STARTERS) {
        assert.equal(s.scope, 'federal');
        assert.deepEqual(R.validateTemplate({ title: s.title, body: s.body }).errors, [], `${s.key} passes its own validation`);
        assert.deepEqual(R.fieldsIn(s.body).unknown, []);
        assert.ok(R.fieldsIn(s.body).known.includes('company_name'), `${s.key} names the company`);
        assert.ok(R.fieldsIn(s.body).known.includes('person_name'), `${s.key} names the person`);
        assert.match(s.body, /Before use, compare this text with the current .* U\.S\. Department of Labor/);
        assert.ok(s.source.includes('U.S. Department of Labor'));
        for (const st of STATES) assert.ok(!new RegExp(`\\b${st}\\b`).test(s.body.replace(/Washington, D\.C\./g, '')), `${s.key} has no ${st}-specific text`);
        const view = R.summary(R.effective(s.key, null));
        assert.equal(view.draft, true); assert.equal(view.mark, 'STARTING DRAFT - have a US compliance advisor review before use.'); assert.equal(view.version, 0); assert.equal(view.customised, false);
        const out = R.render(R.effective(s.key, null), R.mergeValues({ companyName: 'Acme Inc', personName: 'Ada Lovelace', today: '2026-03-09', defaults: { hr_contact: 'HR, 555-0100', plan_name: 'Acme Health Plan', plan_administrator: 'Benefits Co, 555-0199' } }));
        assert.ok(out.text.startsWith(`${R.DRAFT_BANNER}\n\n`), `${s.key} is rendered with the draft mark on top`);
        assert.deepEqual(out.missing, []); assert.ok(!out.text.includes('{{'));
        assert.ok(out.text.includes('Acme Inc')); assert.ok(out.text.includes('Ada Lovelace')); assert.ok(out.text.includes('March 9, 2026'));
    }
    assert.match(R.REVIEW_NOTE, /not legal advice/);
});

test('fill-ins: only the listed ones are accepted; a missing value stays visible and is reported', () => {
    assert.deepEqual(R.fieldsIn('Dear {{ person_first_name }}, from {{company_name}} and {{company_name}} {{ssn}} {{Nope}}'), { known: ['person_first_name', 'company_name'], unknown: ['ssn', 'Nope'] });
    const v = R.mergeValues({ companyName: ' Acme\nInc ', personName: 'Ada  Lovelace', today: '2026-11-01', defaults: { hr_contact: 'Pat' }, extra: { plan_name: 'Gold Plan', hr_contact: '', company_name: 'Acme Holdings', hacked: 'x' } });
    assert.deepEqual(v, { company_name: 'Acme Holdings', person_name: 'Ada  Lovelace', person_first_name: 'Ada', date: 'November 1, 2026', hr_contact: 'Pat', plan_name: 'Gold Plan', plan_administrator: '' });
    const t = { title: 'T', body: 'Hi {{person_first_name}}. Plan: {{plan_name}}. Admin: {{plan_administrator}}. Literal {{not_a_field}}.', version: 1, reviewed: null };
    const out = R.render(t, R.mergeValues({ companyName: 'Acme', personName: '', today: '2026-11-01' }));
    assert.equal(out.text, `${R.DRAFT_BANNER}\n\nHi [Person's first name]. Plan: [Health plan name]. Admin: [Plan administrator and how to reach them]. Literal {{not_a_field}}.`);
    assert.deepEqual(out.missing, ['person_first_name', 'plan_name', 'plan_administrator']);
    assert.equal(R.longDate('2026-02-29'), 'February 29, 2026'); assert.equal(R.longDate('nope'), '');
    assert.equal(R.render({ title: 'T', body: 'x {{company_name}}', version: 1 }, { company_name: '$& $1' }).text.endsWith('x $& $1'), true, 'values are inserted literally');
});

test('validation: title, length, unknown and unclosed fill-ins', () => {
    assert.deepEqual(R.validateTemplate({ title: ' Texas pay day notice ', body: 'Pay day at {{company_name}} is every other Friday.\r\nAsk {{hr_contact}}.', changeNote: 'first' }),
        { errors: [], value: { title: 'Texas pay day notice', body: 'Pay day at {{company_name}} is every other Friday.\nAsk {{hr_contact}}.', changeNote: 'first' } });
    const e = R.validateTemplate({ title: 'x', body: 'short' }).errors;
    assert.deepEqual(e, ['title must be 3 to 120 characters', 'the text is too short (at least 20 characters)']);
    assert.match(R.validateTemplate({ title: 'Good title', body: 'This uses {{employee_ssn}} which is not allowed here.' }).errors[0], /unknown fill-in \{\{employee_ssn\}\}/);
    assert.ok(R.validateTemplate({ title: 'Good title', body: 'This one is not closed: {{company_name and goes on.' }).errors.some((x) => /not closed/.test(x)));
    assert.ok(R.validateTemplate({ title: 'Good title', body: 'x'.repeat(20001) }).errors[0].includes('too long'));
    assert.ok(R.validateTemplate({ title: 'Good title', body: 'A perfectly fine notice text.', changeNote: 'n'.repeat(201) }).errors.length === 1);
    assert.equal(R.validKey('fmla_rights'), true); assert.equal(R.validKey('Custom-Key'), false); assert.equal(R.validKey('ab'), false); assert.equal(R.validKey('../x'), false);
    assert.equal(R.keyFromTitle('Texas pay day notice!'), 'custom_texas_pay_day_notice');
    assert.equal(R.keyFromTitle('Texas pay day notice', ['custom_texas_pay_day_notice', 'custom_texas_pay_day_notice_2']), 'custom_texas_pay_day_notice_3');
    assert.equal(R.keyFromTitle('!!!'), 'custom_notice');
    assert.ok(R.validKey(R.keyFromTitle('A very long title '.repeat(10))));
});

test('versions: each real change is a new version with the old one kept; an unchanged save is not; a new version is never "reviewed"', () => {
    const ctx = { key: 'fmla_rights', orgId: 'orgA', actor: 'hr1', now: '2026-03-01T00:00:00.000Z' };
    const v1 = R.nextVersion(null, { title: 'FMLA', body: 'First text of the notice.' }, ctx);
    assert.equal(v1.changed, true); assert.equal(v1.doc.version, 1); assert.equal(v1.doc.starter, true); assert.deepEqual(v1.doc.history, []); assert.equal(v1.doc.reviewed, null);
    assert.equal(R.nextVersion(v1.doc, { title: 'FMLA', body: 'First text of the notice.' }, ctx).changed, false);
    const reviewed = { ...v1.doc, reviewed: { version: 1, reviewerName: 'J. Counsel', reviewedOn: '2026-03-02' } };
    assert.equal(R.isDraft(reviewed), false); assert.equal(R.isDraft(v1.doc), true); assert.equal(R.isDraft(null), true);
    assert.equal(R.render(reviewed, {}).draft, false); assert.ok(!R.render(reviewed, {}).text.includes(R.DRAFT_BANNER), 'a reviewed version is rendered without the draft mark');
    const v2 = R.nextVersion(reviewed, { title: 'FMLA', body: 'Second text of the notice.', changeNote: 'clearer' }, { ...ctx, now: '2026-03-05T00:00:00.000Z' });
    assert.equal(v2.doc.version, 2); assert.equal(v2.doc.reviewed, null); assert.equal(R.isDraft(v2.doc), true, 'editing a reviewed text makes it a draft again');
    assert.equal(v2.doc.createdAt, '2026-03-01T00:00:00.000Z'); assert.equal(v2.doc.updatedAt, '2026-03-05T00:00:00.000Z');
    assert.deepEqual(v2.doc.history.map((h) => [h.version, h.body, Boolean(h.reviewed)]), [[1, 'First text of the notice.', true]]);
    let doc = v2.doc;
    for (let i = 3; i <= 30; i++) doc = R.nextVersion(doc, { title: 'FMLA', body: `Text number ${i} of the notice.` }, ctx).doc;
    assert.equal(doc.version, 30); assert.equal(doc.history.length, 20, 'the last 20 older versions are kept');
    assert.equal(R.nextVersion(null, { title: 'Own', body: 'A text of our own.' }, { ...ctx, key: 'custom_own' }).doc.starter, false);
});

test('review record: who and when, not in the future', () => {
    assert.deepEqual(R.validateReview({ reviewerName: ' J. Counsel, Esq. ', reviewedOn: '2026-03-02', note: 'ok for TX' }, '2026-03-09'), { errors: [], value: { reviewerName: 'J. Counsel, Esq.', reviewedOn: '2026-03-02', note: 'ok for TX' } });
    assert.equal(R.validateReview({ reviewerName: 'J. Counsel' }, '2026-03-09').value.reviewedOn, '2026-03-09');
    assert.deepEqual(R.validateReview({}, '2026-03-09').errors, ['reviewerName is required (who reviewed it)']);
    assert.deepEqual(R.validateReview({ reviewerName: 'JC', reviewedOn: '2026-03-10' }, '2026-03-09').errors, ['reviewedOn cannot be in the future']);
    assert.deepEqual(R.validateReview({ reviewerName: 'JC', reviewedOn: '03/02/2026' }, '2026-03-09').errors, ['reviewedOn must be a real date (YYYY-MM-DD)']);
    assert.deepEqual(R.validateReview({ reviewerName: 'JC', reviewedOn: '2026-02-30' }, '2026-03-09').errors, ['reviewedOn must be a real date (YYYY-MM-DD)'], 'February 30 is not a date');
    assert.deepEqual(R.validateDefaults({ hr_contact: ' Pat\nSmith ', plan_name: null, other: 'x' }), { errors: [], value: { hr_contact: 'Pat Smith', plan_name: '' } });
    assert.equal(R.validateDefaults({ hr_contact: 'x'.repeat(301) }).errors.length, 1);
});

/* ------------------------------------ stored library ------------------------------------ */

test('library: starters show for every company; an edit makes that company\'s own copy and leaves others on the starter', async () => {
    mem.reset();
    const lib = await N.list('orgA');
    assert.deepEqual(lib.data.map((t) => [t.key, t.version, t.draft, t.customised]), [['fmla_rights', 0, true, false], ['cobra_general', 0, true, false], ['marketplace_newhire', 0, true, false]]);
    assert.deepEqual(lib.attachments, {}); assert.deepEqual(lib.defaults, { hr_contact: '', plan_name: '', plan_administrator: '' });
    const saved = await N.save('orgA', 'fmla_rights', { title: 'FMLA at Acme', body: 'Acme text for {{person_name}} about family and medical leave.', changeNote: 'our wording' }, 'hr1');
    assert.equal(saved.changed, true); assert.equal(saved.template.version, 1); assert.equal(saved.template.draft, true);
    assert.equal(saved.template.starterText.title, R.starter('fmla_rights').title, 'the original starting draft stays available to compare');
    assert.equal((await N.save('orgA', 'fmla_rights', { title: 'FMLA at Acme', body: 'Acme text for {{person_name}} about family and medical leave.' }, 'hr1')).changed, false);
    assert.equal((await N.get('orgB', 'fmla_rights')).version, 0);
    assert.equal((await N.get('orgB', 'fmla_rights')).title, R.starter('fmla_rights').title);
    assert.equal((await N.list('orgB')).data.find((t) => t.key === 'fmla_rights').customised, false);
    assert.equal((await N.save('orgA', 'fmla_rights', { title: 'x', body: 'y' }, 'hr1')).errors.length, 2);
    assert.deepEqual(await N.save('orgA', 'no_such_starter', { title: 'Some title', body: 'Some body text that is long enough.' }, 'hr1'), { notFound: true });
    assert.equal((await N.save('orgA', '../etc', { title: 'Some title', body: 'Some body text that is long enough.' }, 'hr1')).errors[0], 'the template key is not valid');
    assert.equal(await N.get('orgA', 'custom_missing'), null);
});

test('library: own templates, review, version history, bring back a version, remove', async () => {
    mem.reset();
    const made = await N.create('orgA', { title: 'Pay day notice', body: 'Pay day at {{company_name}} is every other Friday.' }, 'hr1');
    assert.equal(made.key, 'custom_pay_day_notice'); assert.equal(made.template.scope, 'company'); assert.equal(made.template.starter, false);
    assert.equal((await N.create('orgA', { title: 'Pay day notice', body: 'A second one with the same title is fine.' }, 'hr1')).key, 'custom_pay_day_notice_2');
    assert.equal((await N.create('orgB', { title: 'Pay day notice', body: 'Another company can use the same title.' }, 'hr9')).key, 'custom_pay_day_notice');
    assert.equal((await N.get('orgA', 'custom_pay_day_notice')).body, 'Pay day at {{company_name}} is every other Friday.');
    assert.equal((await N.get('orgB', 'custom_pay_day_notice')).body, 'Another company can use the same title.', 'same key, separate companies, separate texts');
    assert.equal((await N.create('orgA', { title: 'Bad', body: 'Uses {{salary}} which is not a fill-in we offer.' }, 'hr1')).errors.length, 1);

    assert.deepEqual(await N.markReviewed('orgA', 'cobra_general', { reviewerName: 'J. Counsel' }, 'hr1', '2026-03-09'), { conflict: 'Save your own copy of this starting draft first. Then record the review of that copy.' });
    assert.deepEqual(await N.markReviewed('orgB', 'custom_pay_day_notice_2', { reviewerName: 'J. Counsel' }, 'hr9', '2026-03-09'), { notFound: true });
    assert.equal((await N.markReviewed('orgA', 'custom_pay_day_notice', {}, 'hr1', '2026-03-09')).errors.length, 1);
    const rev = await N.markReviewed('orgA', 'custom_pay_day_notice', { reviewerName: 'J. Counsel', reviewedOn: '2026-03-08' }, 'hr1', '2026-03-09');
    assert.equal(rev.template.draft, false); assert.equal(rev.template.mark, null); assert.equal(rev.template.reviewed.reviewerName, 'J. Counsel');
    assert.equal((await N.get('orgB', 'custom_pay_day_notice')).draft, true, 'a review in one company says nothing about another');

    const v2 = await N.save('orgA', 'custom_pay_day_notice', { title: 'Pay day notice', body: 'Pay day at {{company_name}} is the 1st and the 15th.', changeNote: 'new schedule' }, 'hr2');
    assert.equal(v2.template.version, 2); assert.equal(v2.template.draft, true, 'the new version needs its own review');
    assert.deepEqual(v2.template.versions.map((v) => [v.version, v.reviewed, Boolean(v.current)]), [[2, false, true], [1, true, false]]);
    const back = await N.restoreVersion('orgA', 'custom_pay_day_notice', 1, 'hr2');
    assert.equal(back.template.version, 3); assert.equal(back.template.body, 'Pay day at {{company_name}} is every other Friday.'); assert.equal(back.template.draft, true); assert.equal(back.template.changeNote, 'Back to version 1');
    assert.equal((await N.restoreVersion('orgA', 'custom_pay_day_notice', 9, 'hr2')).errors.length, 1);
    assert.deepEqual(await N.restoreVersion('orgB', 'custom_pay_day_notice_2', 1, 'hr9'), { notFound: true });

    await N.save('orgA', 'fmla_rights', { title: 'FMLA at Acme', body: 'Acme text for {{person_name}} about family and medical leave.' }, 'hr1');
    assert.deepEqual(await N.remove('orgA', 'fmla_rights'), { ok: true, revertedToStarter: true });
    assert.equal((await N.get('orgA', 'fmla_rights')).version, 0, 'removing the copy of a starter brings the starting draft back');
    assert.deepEqual(await N.remove('orgA', 'fmla_rights'), { notFound: true });
    assert.deepEqual(await N.remove('orgB', 'custom_pay_day_notice_2'), { notFound: true }, 'one company cannot remove another company\'s text');
    assert.deepEqual(await N.remove('orgA', 'custom_pay_day_notice_2'), { ok: true, revertedToStarter: false });
    assert.equal(await N.get('orgA', 'custom_pay_day_notice_2'), null);
});

test('prepare a notice: company and person names, company fill-ins, draft mark until reviewed', async () => {
    mem.reset();
    assert.deepEqual((await N.saveDefaults('orgA', { hr_contact: 'Pat in HR, 555-0100', plan_name: 'Acme Health Plan' }, 'hr1')).defaults, { hr_contact: 'Pat in HR, 555-0100', plan_name: 'Acme Health Plan', plan_administrator: '' });
    assert.deepEqual((await N.saveDefaults('orgA', { plan_administrator: 'Benefits Co' }, 'hr1')).defaults, { hr_contact: 'Pat in HR, 555-0100', plan_name: 'Acme Health Plan', plan_administrator: 'Benefits Co' }, 'saving one fill-in keeps the others');
    assert.deepEqual(await N.getDefaults('orgB'), { hr_contact: '', plan_name: '', plan_administrator: '' });
    assert.equal((await N.list('orgA')).data.length, 3, 'the saved fill-ins are not listed as a template');
    const out = await N.renderFor('orgA', 'cobra_general', { companyName: 'Acme Inc', person: { name: 'Ada Lovelace' }, today: '2026-03-09' });
    assert.equal(out.draft, true); assert.equal(out.version, 0); assert.deepEqual(out.missing, []);
    assert.ok(out.text.startsWith(R.DRAFT_BANNER)); assert.ok(out.text.includes('To: Ada Lovelace')); assert.ok(out.text.includes('Plan: Acme Health Plan')); assert.ok(out.text.includes('Benefits Co'));
    const other = await N.renderFor('orgB', 'cobra_general', { companyName: 'Bravo LLC', person: null, today: '2026-03-09' });
    assert.deepEqual(other.missing, ['person_name', 'plan_name', 'plan_administrator', 'hr_contact']);
    assert.ok(!other.text.includes('Acme'), 'another company\'s fill-ins never leak');
    const once = await N.renderFor('orgA', 'cobra_general', { companyName: 'Acme Inc', person: { name: 'Bo Li' }, today: '2026-03-09', extra: { plan_name: 'Silver Plan' } });
    assert.ok(once.text.includes('Plan: Silver Plan'));
    assert.deepEqual(await N.renderFor('orgA', 'custom_nope', {}), { notFound: true });
    await N.save('orgA', 'cobra_general', { title: 'COBRA at Acme', body: 'Reviewed text for {{person_name}} from {{company_name}}.' }, 'hr1');
    await N.markReviewed('orgA', 'cobra_general', { reviewerName: 'J. Counsel' }, 'hr1', '2026-03-09');
    const final = await N.renderFor('orgA', 'cobra_general', { companyName: 'Acme Inc', person: { name: 'Ada Lovelace' }, today: '2026-03-09' });
    assert.deepEqual({ draft: final.draft, text: final.text, version: final.version }, { draft: false, text: 'Reviewed text for Ada Lovelace from Acme Inc.', version: 1 });
});

test('attach to a tracked workplace notice: federal or state line, existing text only, per company; an attached own text cannot be removed', async () => {
    mem.reset();
    assert.equal(N.isPostingKey('fmla'), true); assert.equal(N.isPostingKey('state_TX'), true); assert.equal(N.isPostingKey('state_tx'), false); assert.equal(N.isPostingKey('made_up'), false);
    assert.deepEqual(await N.attach('orgA', 'made_up', 'fmla_rights', 'hr1'), { notFound: 'posting' });
    assert.deepEqual(await N.attach('orgA', 'fmla', 'custom_missing', 'hr1'), { notFound: 'template' });
    assert.deepEqual(await N.attach('orgA', 'fmla', 'fmla_rights', 'hr1'), { ok: true, attached: 'fmla_rights' });
    const own = await N.create('orgA', { title: 'State notice text', body: 'Our own text for the state notice board.' }, 'hr1');
    await N.attach('orgA', 'state_TX', own.key, 'hr1');
    const lib = await N.list('orgA');
    assert.deepEqual(Object.fromEntries(Object.entries(lib.attachments).map(([k, v]) => [k, v.templateKey])), { fmla: 'fmla_rights', state_TX: own.key });
    assert.deepEqual(lib.data.find((t) => t.key === 'fmla_rights').attachedTo, ['fmla']);
    assert.deepEqual((await N.list('orgB')).attachments, {});
    assert.deepEqual(await N.attach('orgB', 'state_TX', own.key, 'hr9'), { notFound: 'template' }, 'another company cannot attach this company\'s text');
    assert.deepEqual(await N.remove('orgA', own.key), { conflict: 'This text is attached to a workplace notice. Detach it first.' });
    assert.deepEqual(await N.attach('orgA', 'state_TX', null, 'hr1'), { ok: true, attached: null });
    assert.deepEqual(await N.remove('orgA', own.key), { ok: true, revertedToStarter: false });
    await N.attach('orgA', 'fmla', 'cobra_general', 'hr1');
    assert.equal((await N.list('orgA')).attachments.fmla.templateKey, 'cobra_general', 'attaching again replaces the earlier choice');
});

/* ------------------------------------- the routes ------------------------------------- */

let server; let base;
const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: 600 });
async function call(method, path, id, body) {
    const res = await fetch(`${base}/api/us${path}`, { method, headers: { Authorization: `Bearer ${tokenFor(id)}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
}
async function seedPeople() {
    mem.reset();
    await db.collection('organizations').doc('orgA').set({ name: 'Acme Inc', country: 'United States', timezone: 'America/Chicago' });
    await db.collection('organizations').doc('orgB').set({ name: 'Bravo LLC', country: 'United States', timezone: 'America/Chicago' });
    await db.collection('organizations').doc('orgIN').set({ name: 'India Co', country: 'IN' });
    const person = (id, orgId, role, name) => db.collection('users').doc(id).set({ orgId, role, name, email: `${id}@example.com`, employeeId: id.toUpperCase(), status: 'Active' });
    await person('hrA', 'orgA', 'hr_admin', 'Hana HR'); await person('mgrA', 'orgA', 'manager', 'Manny Manager'); await person('empA', 'orgA', 'employee', 'Ada Lovelace');
    await person('hrB', 'orgB', 'hr_admin', 'Hugo HR'); await person('empB', 'orgB', 'employee', 'Bo Li'); await person('saIN', 'orgIN', 'super_admin', 'India Admin');
}

test.before(async () => {
    const app = express(); app.use(express.json());
    app.use('/api/us', require('../routes/us-compliance.js'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
// the short wait lets sockets finish closing: on Windows a forced exit (--test-force-exit) during that crashes Node
test.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 300)); });

test('routes: HR can read, edit, review, prepare and attach; every write lands in the audit log', async () => {
    await seedPeople();
    const list = await call('GET', '/notice-templates', 'hrA');
    assert.equal(list.status, 200); assert.equal(list.body.data.length, 3); assert.equal(list.body.mark, R.DRAFT_BANNER); assert.match(list.body.note, /not legal advice/); assert.equal(list.body.fields.length, 7);
    const one = await call('GET', '/notice-templates/fmla_rights', 'hrA');
    assert.equal(one.body.template.version, 0); assert.ok(one.body.template.body.includes('{{company_name}}'));
    assert.equal((await call('GET', '/notice-templates/custom_nope', 'hrA')).status, 404);

    const bad = await call('PUT', '/notice-templates/fmla_rights', 'hrA', { title: 'x', body: 'y' });
    assert.equal(bad.status, 400); assert.equal(bad.body.errors.length, 2);
    const saved = await call('PUT', '/notice-templates/fmla_rights', 'hrA', { title: 'FMLA at Acme', body: 'Hello {{person_name}}, this is the leave notice of {{company_name}}. Ask {{hr_contact}}.' });
    assert.equal(saved.status, 200); assert.equal(saved.body.changed, true); assert.equal(saved.body.template.version, 1);
    assert.equal((await call('POST', '/notice-templates/cobra_general/reviewed', 'hrA', { reviewerName: 'J. Counsel' })).status, 409);
    assert.equal((await call('POST', '/notice-templates/fmla_rights/reviewed', 'hrA', {})).status, 400);
    const made = await call('POST', '/notice-templates', 'hrA', { title: 'Pay day notice', body: 'Pay day at {{company_name}} is every other Friday.' });
    assert.equal(made.status, 201); assert.equal(made.body.template.key, 'custom_pay_day_notice');
    assert.equal((await call('PUT', '/notice-defaults', 'hrA', { hr_contact: 'Hana, 555-0100' })).body.defaults.hr_contact, 'Hana, 555-0100');

    const draft = await call('POST', '/notice-templates/fmla_rights/render', 'hrA', { userId: 'empA' });
    assert.equal(draft.status, 200); assert.equal(draft.body.draft, true); assert.equal(draft.body.mark, R.DRAFT_BANNER);
    assert.equal(draft.body.text, `${R.DRAFT_BANNER}\n\nHello Ada Lovelace, this is the leave notice of Acme Inc. Ask Hana, 555-0100.`);
    assert.equal((await call('POST', '/notice-templates/fmla_rights/render', 'hrA', { userId: 'EMPA' })).body.text.includes('Ada Lovelace'), true, 'an employee number works too');
    assert.equal((await call('POST', '/notice-templates/fmla_rights/render', 'hrA', { userId: 'empB' })).status, 404, 'a person from another company cannot be named');
    const nobody = await call('POST', '/notice-templates/fmla_rights/render', 'hrA', {});
    assert.deepEqual(nobody.body.missing, ['person_name']);

    const rev = await call('POST', '/notice-templates/fmla_rights/reviewed', 'hrA', { reviewerName: 'J. Counsel', note: 'fine' });
    assert.equal(rev.status, 200); assert.equal(rev.body.template.draft, false);
    const final = await call('POST', '/notice-templates/fmla_rights/render', 'hrA', { userId: 'empA' });
    assert.equal(final.body.draft, false); assert.equal(final.body.mark, null); assert.ok(!final.body.text.includes('STARTING DRAFT'));

    assert.equal((await call('PUT', '/postings/fmla/template', 'hrA', { templateKey: 'fmla_rights' })).body.attached, 'fmla_rights');
    assert.equal((await call('PUT', '/postings/state_TX/template', 'hrA', { templateKey: 'custom_pay_day_notice' })).status, 200);
    assert.equal((await call('PUT', '/postings/nope/template', 'hrA', { templateKey: 'fmla_rights' })).status, 404);
    assert.equal((await call('PUT', '/postings/fmla/template', 'hrA', { templateKey: 'custom_nope' })).status, 404);
    assert.equal((await call('PUT', '/postings/fmla/template', 'hrA', {})).status, 400);
    assert.equal((await call('DELETE', '/notice-templates/custom_pay_day_notice', 'hrA')).status, 409);
    assert.equal((await call('PUT', '/postings/state_TX/template', 'hrA', { templateKey: null })).body.attached, null);
    assert.equal((await call('DELETE', '/notice-templates/custom_pay_day_notice', 'hrA')).status, 200);
    assert.equal((await call('DELETE', '/notice-templates/custom_pay_day_notice', 'hrA')).status, 404);
    await call('PUT', '/notice-templates/fmla_rights', 'hrA', { title: 'FMLA at Acme', body: 'Second wording for {{person_name}} at {{company_name}}, please read.' });
    const restored = await call('POST', '/notice-templates/fmla_rights/restore', 'hrA', { version: 1 });
    assert.equal(restored.body.template.version, 3); assert.equal(restored.body.template.draft, true);
    assert.equal((await call('POST', '/notice-templates/fmla_rights/restore', 'hrA', { version: 77 })).status, 400);

    const after = await call('GET', '/notice-templates', 'hrA');
    assert.deepEqual(after.body.data.find((t) => t.key === 'fmla_rights').attachedTo, ['fmla']);
    await new Promise((r) => setTimeout(r, 30));
    const audit = (await db.collection('organizations/orgA/audit_logs').get()).docs.map((d) => d.data());
    for (const action of ['notice_template_saved', 'notice_template_created', 'notice_defaults_updated', 'notice_prepared', 'notice_template_reviewed', 'notice_template_attached', 'notice_template_detached', 'notice_template_removed', 'notice_template_version_restored']) assert.ok(audit.some((a) => a.action === action && a.actorId === 'hrA'), `${action} is in the audit log`);
    assert.ok(!JSON.stringify(audit).includes('Ada Lovelace'), 'the audit log names the person by id, not by the text of the notice');
});

test('routes: employees and managers are refused, an India company gets 409, and companies never see each other\'s texts', async () => {
    await seedPeople();
    await call('PUT', '/notice-templates/fmla_rights', 'hrA', { title: 'FMLA at Acme', body: 'Acme-only wording for {{person_name}}, kept private.' });
    await call('POST', '/notice-templates', 'hrA', { title: 'Acme private text', body: 'Only Acme should ever read this text.' });
    for (const who of ['empA', 'mgrA']) {
        assert.equal((await call('GET', '/notice-templates', who)).status, 403);
        assert.equal((await call('GET', '/notice-templates/fmla_rights', who)).status, 403);
        assert.equal((await call('PUT', '/notice-templates/fmla_rights', who, { title: 'Hacked title', body: 'Hacked body that is long enough.' })).status, 403);
        assert.equal((await call('POST', '/notice-templates', who, { title: 'Hacked title', body: 'Hacked body that is long enough.' })).status, 403);
        assert.equal((await call('POST', '/notice-templates/fmla_rights/render', who, {})).status, 403);
        assert.equal((await call('PUT', '/postings/fmla/template', who, { templateKey: 'fmla_rights' })).status, 403);
        assert.equal((await call('DELETE', '/notice-templates/fmla_rights', who)).status, 403);
        assert.equal((await call('PUT', '/notice-defaults', who, { hr_contact: 'x' })).status, 403);
    }
    assert.equal((await call('GET', '/notice-templates', 'saIN')).status, 409);
    assert.equal((await call('PUT', '/notice-templates/fmla_rights', 'saIN', { title: 'Some title', body: 'Some body text that is long enough.' })).status, 409);
    const b = await call('GET', '/notice-templates', 'hrB');
    assert.deepEqual(b.body.data.map((t) => [t.key, t.version]), [['fmla_rights', 0], ['cobra_general', 0], ['marketplace_newhire', 0]]);
    assert.equal((await call('GET', '/notice-templates/custom_acme_private_text', 'hrB')).status, 404);
    assert.equal((await call('GET', '/notice-templates/fmla_rights', 'hrB')).body.template.title, R.starter('fmla_rights').title);
    assert.equal((await call('DELETE', '/notice-templates/custom_acme_private_text', 'hrB')).status, 404);
    assert.equal((await call('POST', '/notice-templates/custom_acme_private_text/render', 'hrB', {})).status, 404);
    assert.equal((await call('PUT', '/postings/fmla/template', 'hrB', { templateKey: 'custom_acme_private_text' })).status, 404);
    assert.equal((await call('GET', '/notice-templates/custom_acme_private_text', 'hrA')).status, 200);
    const res = await fetch(`${base}/api/us/notice-templates`);
    assert.equal(res.status, 401);
});
