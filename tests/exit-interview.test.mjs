// US-I06: exit interview. Pure rules, the stored interviews (in-memory database), and the real routes with sign-in tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const mem = require('./helpers/memory-firestore.js');
const { db } = mem.install();
const R = require('../services/exit-interview-rules.js');
const X = require('../services/exit-interviews.js');
const timeRules = require('../services/time-rules.js');
const jwt = require('jsonwebtoken');
const express = require('express');

const Q = R.DEFAULT_QUESTIONS;
const leaving = (lastDay, extra = {}) => ({ name: 'Ada Lovelace', employeeId: 'EMP0001', departmentName: 'Shop', usProfile: { managerId: 'mgr1', termination: { lastDay, type: 'resignation', reason: 'moving', ...extra } } });
const good = { reason: 'better_pay', overall: 4, manager_support: 2, liked: 'The team', recommend: true, return: false };

/* --------------------------------------- rules --------------------------------------- */

test('default questions: valid, in English and Spanish, with exactly one reason-for-leaving question', () => {
    assert.deepEqual(R.validateQuestions(Q).errors, []);
    assert.deepEqual(R.validateQuestions(Q).value, Q, 'the defaults survive their own validation unchanged');
    assert.equal(Q.filter((q) => q.type === 'reason').length, 1);
    for (const q of Q) { assert.ok(q.text.en && q.text.es, `${q.id} has both languages`); assert.notEqual(q.text.en, q.text.es); }
    for (const r of R.REASONS) assert.ok(r.label.en && r.label.es);
    assert.equal(new Set(R.REASONS.map((r) => r.value)).size, R.REASONS.length);
    assert.equal(R.textIn(Q[0].text, 'es'), '¿Cuál es la razón principal por la que se va?');
    assert.equal(R.textIn({ en: 'Only English' }, 'es'), 'Only English');
    assert.deepEqual(R.questionsFor(null), Q); assert.deepEqual(R.questionsFor({ questions: [] }), Q);
    assert.notEqual(R.questionsFor(null), Q, 'a copy is handed out, so the defaults cannot be changed by accident');
});

test('editing questions: ids are kept or made from the text, types and choices are checked, the reason question must stay', () => {
    const edited = R.validateQuestions([
        { id: 'reason', type: 'reason', text: { en: 'Why are you leaving?', es: '¿Por qué se va?' }, required: false, options: [{ value: 'pay', label: { en: 'Pay' } }, { label: { en: 'Café hours & shifts', es: 'Horario' } }] },
        { type: 'text', text: 'What would have kept you here?' },
        { type: 'text', text: { en: 'What would have kept you here?' } },
        { type: 'choice', text: { en: 'Which site?' }, options: [{ label: 'North' }, { label: 'South' }], required: true }
    ]);
    assert.deepEqual(edited.errors, []);
    assert.deepEqual(edited.value.map((q) => q.id), ['reason', 'what_would_have_kept_you_here', 'what_would_have_kept_you_here_2', 'which_site']);
    assert.equal(edited.value[0].required, true, 'the reason question is always required');
    assert.deepEqual(edited.value[0].options[1], { value: 'cafe_hours_shifts', label: { en: 'Café hours & shifts', es: 'Horario' } });
    assert.deepEqual(edited.value[3].options, [{ value: 'north', label: { en: 'North' } }, { value: 'south', label: { en: 'South' } }]);

    assert.deepEqual(R.validateQuestions('x').errors, ['questions must be a list']);
    assert.deepEqual(R.validateQuestions([]).errors, ['keep at least one question']);
    assert.ok(R.validateQuestions([{ type: 'text', text: { en: 'No reason question here' } }]).errors[0].includes('keep exactly one "reason for leaving" question'));
    assert.ok(R.validateQuestions([...Q, { ...Q[0], id: 'reason2' }]).errors.some((e) => e.includes('exactly one')));
    const bad = R.validateQuestions([Q[0], { type: 'essay', text: { en: 'Bad type' } }, { type: 'text', text: { en: 'x' } }, { id: 'Bad Id', type: 'text', text: { en: 'Bad id here' } }, { id: 'reason', type: 'text', text: { en: 'Duplicate id' } },
        { type: 'choice', text: { en: 'One choice only' }, options: [{ label: 'Only' }] }, { type: 'choice', text: { en: 'Twice' }, options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }, null]).errors;
    assert.ok(bad.some((e) => /question 2: type must be one of/.test(e)));
    assert.ok(bad.some((e) => /question 3: the English text is required/.test(e)));
    assert.ok(bad.some((e) => /question 4: id may only use/.test(e)));
    assert.ok(bad.some((e) => /question 5: the id "reason" is used twice/.test(e)));
    assert.ok(bad.some((e) => /question 6: give 2 to 20 choices/.test(e)));
    assert.ok(bad.some((e) => /question 7: the choice "a" is listed twice/.test(e)));
    assert.ok(bad.some((e) => /question 8: must be an object/.test(e)));
    assert.ok(R.validateQuestions([Q[0], ...Array.from({ length: 30 }, (_, i) => ({ type: 'text', text: { en: `Question number ${i}` } }))]).errors.some((e) => /too many questions/.test(e)));
    assert.ok(R.validateQuestions([{ ...Q[0], text: { en: 'x'.repeat(301) } }]).errors.some((e) => /too long/.test(e)));
});

test('who can answer and when: from the day the departure is recorded until the last day, inclusive', () => {
    assert.deepEqual(R.windowFor(leaving('2026-03-20'), '2026-03-10'), { status: 'open', lastDay: '2026-03-20', type: 'resignation' });
    assert.equal(R.windowFor(leaving('2026-03-20'), '2026-03-20').status, 'open', 'the last day itself still counts');
    assert.equal(R.windowFor(leaving('2026-03-20'), '2026-03-21').status, 'closed');
    assert.deepEqual(R.windowFor({ name: 'Staying', usProfile: {} }, '2026-03-10'), { status: 'not_leaving', lastDay: null });
    assert.equal(R.windowFor({ usProfile: { termination: null, terminationCancelled: { lastDay: '2026-03-20' } } }, '2026-03-10').status, 'not_leaving', 'a cancelled departure has no interview');
    assert.equal(R.windowFor(null, '2026-03-10').status, 'not_leaving');
});

test('who can read answers: HR and the owner only; never a manager, payroll, accountant, auditor or executive', () => {
    for (const role of ['super_admin', 'Super Admin', 'hr_admin', 'Admin', 'HRMS']) assert.equal(R.canViewAnswers({ role }), true, role);
    for (const role of ['manager', 'Manager', 'employee', 'payroll_admin', 'accountant', 'auditor', 'executive', '', undefined, 'something_new']) assert.equal(R.canViewAnswers({ role }), false, String(role));
    assert.equal(R.canViewAnswers(null), false);
});

test('answers: checked by question type; required ones must be there unless HR is noting a conversation', () => {
    assert.deepEqual(R.validateAnswers(Q, good), { errors: [], value: good });
    assert.deepEqual(R.validateAnswers(Q, { reason: 'other', overall: 5, liked: '   ', improve: null }).value, { reason: 'other', overall: 5 }, 'blank optional answers are simply left out');
    const e = R.validateAnswers(Q, { reason: 'made_up', overall: 6, manager_support: 2.5, recommend: 'yes', liked: 'x'.repeat(2001), hacker: 1 }).errors;
    assert.equal(e.length, 6);
    assert.ok(e.includes('"hacker" is not one of the questions'));
    assert.ok(e.some((x) => x.endsWith('choose one of the listed answers'))); assert.ok(e.some((x) => x.endsWith('choose a number from 1 to 5'))); assert.ok(e.some((x) => x.endsWith('answer yes or no'))); assert.ok(e.some((x) => x.includes('too long')));
    assert.deepEqual(R.validateAnswers(Q, {}).errors, ['please answer: What is the main reason you are leaving?', 'please answer: Overall, how was working here? (1 = very bad, 5 = very good)']);
    assert.deepEqual(R.validateAnswers(Q, { liked: 'said the team was great' }, { partial: true }), { errors: [], value: { liked: 'said the team was great' } });
    assert.deepEqual(R.validateAnswers(Q, [1, 2]).errors, ['answers must be an object keyed by question id']);
    assert.deepEqual(R.validateAnswers(Q, { overall: 0, reason: 'other' }).errors.length, 1, 'zero is an answer out of range, not a blank');
    assert.deepEqual(R.validateAnswers(Q, { ...good, recommend: false }).value.recommend, false, '"no" is kept, not treated as blank');
    assert.deepEqual(R.validateNotes('  spoke by phone  '), { errors: [], value: 'spoke by phone' });
    assert.equal(R.validateNotes('x'.repeat(4001)).errors.length, 1); assert.deepEqual(R.validateNotes(undefined), { errors: [], value: undefined });
});

test('stored record: keeps the reason with its label, who answered, and the first submission time', () => {
    const first = R.buildRecord({ orgId: 'orgA', userId: 'u1', person: leaving('2026-03-20'), lastDay: '2026-03-20', terminationType: 'resignation', questions: Q, answers: good, source: 'self', actor: 'u1', now: '2026-03-10T10:00:00.000Z' });
    assert.deepEqual({ reason: first.reason, label: first.reasonLabel, source: first.source, submittedAt: first.submittedAt, notes: first.hrNotes, dept: first.department, mgr: first.managerId },
        { reason: 'better_pay', label: 'Better pay somewhere else', source: 'self', submittedAt: '2026-03-10T10:00:00.000Z', notes: '', dept: 'Shop', mgr: 'mgr1' });
    assert.equal(first.questionSnapshot.length, Q.length);
    const again = R.buildRecord({ orgId: 'orgA', userId: 'u1', person: leaving('2026-03-20'), lastDay: '2026-03-20', questions: Q, answers: { ...good, reason: 'manager' }, source: 'self', actor: 'u1', now: '2026-03-12T10:00:00.000Z', existing: { ...first, hrNotes: 'called' } });
    assert.deepEqual({ reason: again.reason, source: again.source, submittedAt: again.submittedAt, updatedAt: again.updatedAt, notes: again.hrNotes }, { reason: 'manager', source: 'self', submittedAt: '2026-03-10T10:00:00.000Z', updatedAt: '2026-03-12T10:00:00.000Z', notes: 'called' });
    assert.equal(R.buildRecord({ orgId: 'orgA', userId: 'u1', lastDay: '2026-03-20', questions: Q, answers: good, source: 'hr', now: 'n', existing: first }).source, 'self_and_hr');
    assert.equal(R.buildRecord({ orgId: 'orgA', userId: 'u1', lastDay: '2026-03-20', questions: Q, answers: good, source: 'self', now: 'n', existing: { ...first, source: 'self_and_hr' } }).source, 'self_and_hr');
    assert.equal(R.reasonOf(Q, {}), null);
});

test('date range: defaults to the last 12 months, and bad dates are refused', () => {
    assert.deepEqual(R.validateRange({}, '2026-03-10'), { errors: [], from: '2025-03-11', to: '2026-03-10' });
    assert.deepEqual(R.validateRange({ from: '2026-01-01', to: '2026-01-31' }, '2026-03-10'), { errors: [], from: '2026-01-01', to: '2026-01-31' });
    assert.deepEqual(R.validateRange({ from: '2026-02-01', to: '2026-01-31' }, '2026-03-10').errors, ['from must be on or before to']);
    assert.deepEqual(R.validateRange({ from: '01/01/2026', to: '2026-02-30x' }, '2026-03-10').errors, ['from must be a real date (YYYY-MM-DD)', 'to must be a real date (YYYY-MM-DD)']);
    assert.deepEqual(R.validateRange({ from: '2026-02-30' }, '2026-03-10').errors, ['from must be a real date (YYYY-MM-DD)'], 'February 30 is not a date');
});

test('summary of reasons: counted by last day in the range, largest first, with response rate, averages and a CSV', () => {
    const rec = (userId, lastDay, answers) => ({ userId, lastDay, answers, reason: answers.reason || null, reasonLabel: answers.reason || null });
    const leavers = [{ userId: 'u1', lastDay: '2026-01-10', type: 'resignation' }, { userId: 'u2', lastDay: '2026-01-20', type: 'resignation' }, { userId: 'u3', lastDay: '2026-02-01', type: 'layoff' }, { userId: 'u4', lastDay: '2026-02-15', type: 'resignation' }, { userId: 'u5', lastDay: '2026-03-31', type: 'retirement' }, { userId: 'u6', lastDay: '2025-12-31', type: 'resignation' }];
    const responses = [rec('u1', '2026-01-10', { reason: 'better_pay', overall: 4, recommend: true }), rec('u2', '2026-01-20', { reason: 'better_pay', overall: 2, manager_support: 1, recommend: false }), rec('u3', '2026-02-01', { reason: 'manager', overall: 3 }),
        rec('u4', '2026-02-15', {}), rec('u6', '2025-12-31', { reason: 'health', overall: 5 }), rec('u5', '2026-03-31', { reason: 'retirement', overall: 5, recommend: true })];
    const s = R.summarize({ questions: Q, leavers, responses, from: '2026-01-01', to: '2026-02-28' });
    assert.deepEqual({ leavers: s.leavers, responses: s.responses, rate: s.responseRate, without: s.withoutAnswer }, { leavers: 4, responses: 3, rate: 75, without: 1 });
    assert.deepEqual(s.reasons, [{ reason: 'better_pay', label: 'Better pay somewhere else', count: 2, percent: 66.7 }, { reason: 'manager', label: 'My manager or supervisor', count: 1, percent: 33.3 }]);
    assert.deepEqual(s.ratings.map((r) => [r.id, r.answers, r.average]), [['overall', 3, 3], ['manager_support', 1, 1]]);
    assert.deepEqual(s.yesNo.map((y) => [y.id, y.yes, y.no]), [['recommend', 1, 1], ['return', 0, 0]]);
    assert.deepEqual(s.byType, { resignation: 3, layoff: 1 });
    const empty = R.summarize({ questions: Q, leavers: [], responses: [], from: '2026-01-01', to: '2026-02-28' });
    assert.deepEqual({ leavers: empty.leavers, rate: empty.responseRate, reasons: empty.reasons }, { leavers: 0, rate: null, reasons: [] });
    const rows = R.summaryCsvRows(s);
    assert.deepEqual(rows[0], { section: 'Reason for leaving', item: 'Better pay somewhere else', count: 2, share: '66.7%' });
    assert.ok(rows.some((r) => r.item === 'People who left in this period' && r.count === 4));
    assert.ok(rows.some((r) => r.item === 'Exit interviews answered' && r.share === '75%'));
    const evil = R.summarize({ questions: [{ ...Q[0], options: [{ value: 'x', label: { en: '=HYPERLINK("http://bad")' } }, { value: 'y', label: { en: 'Fine' } }] }], leavers: [{ userId: 'u1', lastDay: '2026-01-10' }], responses: [rec('u1', '2026-01-10', { reason: 'x' })], from: '2026-01-01', to: '2026-02-28' });
    assert.equal(R.summaryCsvRows(evil)[0].item, '\'=HYPERLINK("http://bad")', 'a label that looks like a formula cannot run when the file is opened');
    assert.ok(!JSON.stringify(rows).includes('u1'), 'the summary names nobody');
});

test('what the leaver gets back: questions in both languages, their own answers, never HR notes', () => {
    const record = { answers: good, source: 'self', submittedAt: 's', updatedAt: 'u', hrNotes: 'PRIVATE HR NOTE', managerId: 'mgr1' };
    const v = R.selfView({ window: { status: 'open', lastDay: '2026-03-20' }, questions: [Q[0], { id: 'x', type: 'text', required: false, text: { en: 'English only' } }], record });
    assert.equal(v.questions[1].text.es, 'English only');
    assert.equal(v.questions[0].options[0].label.es, 'Mejor pago en otro lugar');
    assert.deepEqual(v.answers, good); assert.equal(v.submittedAt, 's');
    assert.ok(!JSON.stringify(v).includes('PRIVATE HR NOTE')); assert.ok(!JSON.stringify(v).includes('mgr1'));
    assert.deepEqual(R.selfView({ window: { status: 'not_leaving', lastDay: null }, questions: Q, record: null }), { status: 'not_leaving', lastDay: null, questions: [], answers: {}, submittedAt: null, updatedAt: null });
    assert.equal(R.selfView({ window: { status: 'open', lastDay: 'd' }, questions: Q, record: { ...record, source: 'hr' } }).submittedAt, null, 'answers HR typed in are not shown as "you sent this"');
});

/* ------------------------------------ stored interviews ------------------------------------ */

const today = timeRules.localDate(new Date().toISOString(), 'America/Chicago');
const shift = (days) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

async function seed() {
    mem.reset();
    await db.collection('organizations').doc('orgA').set({ name: 'Acme Inc', country: 'United States', timezone: 'America/Chicago' });
    await db.collection('organizations').doc('orgB').set({ name: 'Bravo LLC', country: 'United States', timezone: 'America/Chicago' });
    await db.collection('organizations').doc('orgIN').set({ name: 'India Co', country: 'IN' });
    const person = (id, orgId, role, name, extra = {}) => db.collection('users').doc(id).set({ orgId, role, name, email: `${id}@example.com`, employeeId: id.toUpperCase(), status: 'Active', ...extra });
    await person('hrA', 'orgA', 'hr_admin', 'Hana HR'); await person('ownerA', 'orgA', 'super_admin', 'Olga Owner'); await person('mgrA', 'orgA', 'manager', 'Manny Manager'); await person('payA', 'orgA', 'payroll_admin', 'Pia Payroll');
    await person('stayA', 'orgA', 'employee', 'Stan Staying', { usProfile: { managerId: 'mgrA' } });
    await person('leaveA', 'orgA', 'employee', 'Lena Leaving', { status: 'Terminating', terminationStatus: 'scheduled', usProfile: { managerId: 'mgrA', termination: { lastDay: shift(5), type: 'resignation', reason: 'moving' } } });
    await person('lastDayA', 'orgA', 'employee', 'Tova Today', { status: 'Terminating', terminationStatus: 'scheduled', usProfile: { managerId: 'mgrA', termination: { lastDay: today, type: 'resignation', reason: 'school' } } });
    await person('goneA', 'orgA', 'employee', 'Gus Gone', { status: 'Terminating', usProfile: { managerId: 'mgrA', termination: { lastDay: shift(-3), type: 'layoff', reason: 'site closed' } } }); // last day passed; access not cut yet in this test
    await person('hrB', 'orgB', 'hr_admin', 'Hugo HR'); await person('leaveB', 'orgB', 'employee', 'Bo Leaving', { status: 'Terminating', usProfile: { termination: { lastDay: shift(2), type: 'resignation', reason: 'pay' } } });
    await person('saIN', 'orgIN', 'super_admin', 'India Admin');
}
const personOf = async (id) => (await db.collection('users').doc(id).get()).data();

test('service: the leaver saves and changes answers until the last day; after it, or when not leaving, it is refused', async () => {
    await seed();
    const view = await X.selfView('orgA', 'leaveA', await personOf('leaveA'), today);
    assert.equal(view.status, 'open'); assert.equal(view.questions.length, Q.length); assert.deepEqual(view.answers, {});
    assert.equal((await X.saveSelf('orgA', 'leaveA', await personOf('leaveA'), { overall: 9 }, today)).errors.length, 2);
    const saved = await X.saveSelf('orgA', 'leaveA', await personOf('leaveA'), good, today);
    assert.deepEqual(saved.view.answers, good); assert.ok(saved.view.submittedAt);
    const changed = await X.saveSelf('orgA', 'leaveA', await personOf('leaveA'), { ...good, reason: 'commute_relocation' }, today);
    assert.equal(changed.view.answers.reason, 'commute_relocation'); assert.equal(changed.view.submittedAt, saved.view.submittedAt);
    assert.equal((await db.collection('exit_interviews').get()).size, 1, 'changing answers updates the same record');
    assert.equal((await X.saveSelf('orgA', 'lastDayA', await personOf('lastDayA'), good, today)).view.status, 'open');
    assert.deepEqual(await X.saveSelf('orgA', 'goneA', await personOf('goneA'), good, today), { conflict: 'The exit interview closed on your last day.' });
    assert.deepEqual(await X.saveSelf('orgA', 'stayA', await personOf('stayA'), good, today), { conflict: 'There is no exit interview for you to fill in.' });
    assert.equal((await X.selfView('orgA', 'stayA', await personOf('stayA'), today)).status, 'not_leaving');
    assert.equal((await X.selfView('orgA', 'goneA', await personOf('goneA'), today)).status, 'closed');
});

test('service: HR questions are per company; HR can note a conversation any time; list and summary cover one company only', async () => {
    await seed();
    assert.equal((await X.getQuestions('orgA')).customised, false);
    const own = [{ id: 'reason', type: 'reason', text: { en: 'Why are you leaving us?' }, options: [{ value: 'pay', label: { en: 'Pay' } }, { value: 'other', label: { en: 'Other' } }] }, { id: 'tools', type: 'rating', text: { en: 'Did you have the tools you needed?' } }];
    assert.equal((await X.saveQuestions('orgB', [{ type: 'text', text: { en: 'No reason question' } }], 'hrB')).errors.length, 1);
    assert.equal((await X.saveQuestions('orgB', own, 'hrB')).questions.length, 2);
    assert.equal((await X.getQuestions('orgB')).customised, true);
    assert.equal((await X.getQuestions('orgA')).questions.length, Q.length, 'another company keeps the defaults');
    assert.deepEqual((await X.saveSelf('orgB', 'leaveB', await personOf('leaveB'), { reason: 'better_pay', overall: 4 }, today)).errors.length, 2, 'answers are checked against that company\'s own questions');
    assert.equal((await X.saveSelf('orgB', 'leaveB', await personOf('leaveB'), { reason: 'pay', tools: 2 }, today)).view.answers.tools, 2);

    await X.saveSelf('orgA', 'leaveA', await personOf('leaveA'), good, today);
    const noted = await X.saveByHr('orgA', 'leaveA', await personOf('leaveA'), { hrNotes: 'Wants a reference letter.' }, 'hrA');
    assert.equal(noted.record.hrNotes, 'Wants a reference letter.'); assert.deepEqual(noted.record.answers, good); assert.equal(noted.record.source, 'self', 'adding a note does not change who answered');
    const late = await X.saveByHr('orgA', 'goneA', await personOf('goneA'), { answers: { reason: 'other', liked: 'the crew' }, hrNotes: 'Phone call after the last day.' }, 'hrA');
    assert.equal(late.record.source, 'hr'); assert.equal(late.record.reasonLabel, 'Something else');
    assert.equal((await X.saveByHr('orgA', 'goneA', await personOf('goneA'), {}, 'hrA')).errors[0], 'send answers, hrNotes, or both');
    assert.equal((await X.saveByHr('orgA', 'goneA', await personOf('goneA'), { answers: { overall: 11 } }, 'hrA')).errors.length, 1);
    assert.equal((await X.saveByHr('orgA', 'stayA', await personOf('stayA'), { hrNotes: 'x' }, 'hrA')).conflict.startsWith('No termination is recorded'), true);
    const mine = await X.selfView('orgA', 'leaveA', await personOf('leaveA'), today);
    assert.ok(!JSON.stringify(mine).includes('reference letter'), 'the leaver never sees HR\'s notes');

    const list = await X.list('orgA', shift(-30), shift(30));
    assert.deepEqual(list.map((r) => [r.userId, r.answered, r.source, r.reason, r.hasNotes]), [['leaveA', true, 'self', 'Better pay somewhere else', true], ['lastDayA', false, null, null, false], ['goneA', true, 'hr', 'Something else', true]]);
    assert.deepEqual((await X.list('orgA', shift(-30), shift(-1))).map((r) => r.userId), ['goneA']);
    assert.deepEqual((await X.list('orgB', shift(-30), shift(30))).map((r) => r.userId), ['leaveB']);
    const s = await X.summary('orgA', shift(-30), shift(30));
    assert.deepEqual({ leavers: s.leavers, responses: s.responses, reasons: s.reasons.map((r) => [r.reason, r.count]) }, { leavers: 3, responses: 2, reasons: [['better_pay', 1], ['other', 1]] });
    const sb = await X.summary('orgB', shift(-30), shift(30));
    assert.deepEqual(sb.reasons, [{ reason: 'pay', label: 'Pay', count: 1, percent: 100 }]);
    const d = await X.detail('orgA', 'leaveA', await personOf('leaveA'));
    assert.equal(d.hrNotes, 'Wants a reference letter.'); assert.equal(d.reason, 'Better pay somewhere else'); assert.equal(d.questions.length, Q.length);
    assert.equal(await X.detail('orgA', 'stayA', await personOf('stayA')), null);
    assert.equal(await X.getRecord('orgB', 'leaveA', shift(5)), null, 'another company cannot read the record even with the right id');
    assert.deepEqual((await X.resetQuestions('orgB')).questions, Q);
});

test('service: a person who was rehired and leaves again gets a new interview; the earlier one still counts in its period', async () => {
    await seed();
    await X.saveByHr('orgA', 'goneA', await personOf('goneA'), { answers: { reason: 'health' } }, 'hrA');
    await db.collection('users').doc('goneA').update({ 'usProfile.termination': { lastDay: shift(10), type: 'resignation', reason: 'second time' } });
    const view = await X.selfView('orgA', 'goneA', await personOf('goneA'), today);
    assert.equal(view.status, 'open'); assert.deepEqual(view.answers, {}, 'the new departure starts with a blank form');
    await X.saveSelf('orgA', 'goneA', await personOf('goneA'), { reason: 'school', overall: 3 }, today);
    const list = await X.list('orgA', shift(-30), shift(30));
    assert.deepEqual(list.filter((r) => r.userId === 'goneA').map((r) => [r.lastDay, r.reason]), [[shift(10), 'Going to school'], [shift(-3), 'Health']]);
    const s = await X.summary('orgA', shift(-30), shift(-1));
    assert.deepEqual({ leavers: s.leavers, responses: s.responses, reasons: s.reasons.map((r) => r.reason) }, { leavers: 1, responses: 1, reasons: ['health'] });
});

/* ------------------------------------- the routes ------------------------------------- */

let server; let base;
const tokenFor = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: 600 });
async function call(method, path, id, body) {
    const res = await fetch(`${base}/api/us${path}`, { method, headers: { ...(id ? { Authorization: `Bearer ${tokenFor(id)}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (_) { /* csv */ }
    return { status: res.status, body: json, text, headers: res.headers };
}

test.before(async () => {
    const app = express(); app.use(express.json());
    app.use('/api/us', require('../routes/us-offboarding.js'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
// the short wait lets sockets finish closing: on Windows a forced exit (--test-force-exit) during that crashes Node
test.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await new Promise((r) => setTimeout(r, 300)); });

test('routes: the leaver fills the form from their own page; the audit log records that it was sent, not what it says', async () => {
    await seed();
    const me = await call('GET', '/exit-interview/me', 'leaveA');
    assert.equal(me.status, 200); assert.equal(me.body.status, 'open'); assert.equal(me.body.lastDay, shift(5)); assert.equal(me.body.questions.length, Q.length);
    assert.equal(me.body.note, 'Only HR reads your answers. Your manager does not see them.'); assert.equal(me.headers.get('cache-control'), 'no-store');
    assert.equal((await call('GET', '/exit-interview/me', 'stayA')).body.status, 'not_leaving');
    assert.deepEqual((await call('GET', '/exit-interview/me', 'stayA')).body.questions, []);
    const bad = await call('PUT', '/exit-interview/me', 'leaveA', { answers: { overall: 4 } });
    assert.equal(bad.status, 400); assert.deepEqual(bad.body.errors, ['please answer: What is the main reason you are leaving?']);
    assert.equal((await call('PUT', '/exit-interview/me', 'leaveA', {})).status, 400);
    const ok = await call('PUT', '/exit-interview/me', 'leaveA', { answers: { ...good, improve: 'SECRET-FEEDBACK about my manager' } });
    assert.equal(ok.status, 200); assert.equal(ok.body.answers.improve, 'SECRET-FEEDBACK about my manager'); assert.ok(ok.body.submittedAt);
    assert.equal((await call('GET', '/exit-interview/me', 'leaveA')).body.answers.reason, 'better_pay');
    assert.equal((await call('PUT', '/exit-interview/me', 'lastDayA', { answers: good })).status, 200, 'the last day itself is still open');
    assert.equal((await call('PUT', '/exit-interview/me', 'goneA', { answers: good })).status, 409);
    assert.equal((await call('PUT', '/exit-interview/me', 'stayA', { answers: good })).status, 409);
    assert.equal((await call('GET', '/exit-interview/me')).status, 401);
    await new Promise((r) => setTimeout(r, 30));
    const audit = (await db.collection('organizations/orgA/audit_logs').get()).docs.map((d) => d.data());
    assert.ok(audit.some((a) => a.action === 'exit_interview_submitted' && a.targetId === 'leaveA'));
    assert.ok(!JSON.stringify(audit).includes('SECRET-FEEDBACK'), 'answers never reach the audit log');
});

test('routes: only HR and the owner read answers; the manager, payroll and the leaver\'s colleagues are refused everywhere', async () => {
    await seed();
    await call('PUT', '/exit-interview/me', 'leaveA', { answers: { ...good, improve: 'SECRET-FEEDBACK about my manager' } });
    for (const who of ['mgrA', 'payA', 'stayA', 'leaveA']) {
        for (const [method, path, body] of [['GET', '/exit-interviews'], ['GET', '/exit-interviews/summary'], ['GET', '/exit-interviews/summary?format=csv'], ['GET', '/exit-interviews/questions'], ['GET', '/exit-interviews/leaveA'], ['GET', '/exit-interviews/LEAVEA'],
            ['PUT', '/exit-interviews/leaveA', { hrNotes: 'x' }], ['PUT', '/exit-interviews/questions', { questions: Q }], ['POST', '/exit-interviews/questions/reset', {}]]) {
            const r = await call(method, path, who, body);
            assert.equal(r.status, 403, `${who} ${method} ${path}`);
            assert.ok(!r.text.includes('SECRET-FEEDBACK'));
        }
    }
    for (const who of ['hrA', 'ownerA']) {
        const d = await call('GET', '/exit-interviews/leaveA', who);
        assert.equal(d.status, 200); assert.equal(d.body.interview.answers.improve, 'SECRET-FEEDBACK about my manager'); assert.equal(d.body.interview.reason, 'Better pay somewhere else');
    }
    assert.equal((await call('GET', '/exit-interviews/LEAVEA', 'hrA')).body.interview.userId, 'leaveA', 'the employee number works too');
    assert.equal((await call('GET', '/exit-interviews/stayA', 'hrA')).status, 409);
    assert.equal((await call('GET', '/exit-interviews/nobody', 'hrA')).status, 404);
    await new Promise((r) => setTimeout(r, 30));
    const audit = (await db.collection('organizations/orgA/audit_logs').get()).docs.map((d) => d.data());
    assert.equal(audit.filter((a) => a.action === 'exit_interview_viewed' && a.targetId === 'leaveA').length, 3, 'every time HR opens an interview is logged');
});

test('routes: HR edits the questions, records a conversation, lists a date range and downloads the reasons as CSV', async () => {
    await seed();
    await call('PUT', '/exit-interview/me', 'leaveA', { answers: good });
    const q = await call('GET', '/exit-interviews/questions', 'hrA');
    assert.equal(q.body.customised, false); assert.equal(q.body.questions.length, Q.length); assert.deepEqual(q.body.types, R.TYPES);
    assert.equal((await call('PUT', '/exit-interviews/questions', 'hrA', { questions: [{ type: 'text', text: { en: 'Only this one' } }] })).status, 400);
    const mine = [...Q, { type: 'yesno', text: { en: 'Did you get the training you needed?', es: '¿Recibió la capacitación que necesitaba?' } }];
    const saved = await call('PUT', '/exit-interviews/questions', 'hrA', { questions: mine });
    assert.equal(saved.status, 200); assert.equal(saved.body.questions.length, Q.length + 1); assert.equal(saved.body.questions.at(-1).id, 'did_you_get_the_training_you_needed');
    assert.equal((await call('GET', '/exit-interview/me', 'leaveA')).body.questions.at(-1).text.es, '¿Recibió la capacitación que necesitaba?', 'the leaver sees the new question at once');
    assert.equal((await call('GET', '/exit-interview/me', 'leaveA')).body.answers.reason, 'better_pay', 'answers already given are kept');

    const hr = await call('PUT', '/exit-interviews/goneA', 'hrA', { answers: { reason: 'manager', overall: 2 }, hrNotes: 'Spoke by phone.' });
    assert.equal(hr.status, 200); assert.equal(hr.body.interview.source, 'hr'); assert.equal(hr.body.interview.hrNotes, 'Spoke by phone.');
    assert.equal((await call('PUT', '/exit-interviews/goneA', 'hrA', { answers: { overall: 99 } })).status, 400);
    assert.equal((await call('PUT', '/exit-interviews/goneA', 'hrA', {})).status, 400);
    assert.equal((await call('PUT', '/exit-interviews/stayA', 'hrA', { hrNotes: 'x' })).status, 409);

    const list = await call('GET', `/exit-interviews?from=${shift(-30)}&to=${shift(30)}`, 'hrA');
    assert.equal(list.body.count, 3);
    assert.deepEqual(list.body.data.map((r) => [r.userId, r.answered]), [['leaveA', true], ['lastDayA', false], ['goneA', true]]);
    assert.equal((await call('GET', '/exit-interviews?from=nope', 'hrA')).status, 400);
    assert.equal((await call('GET', `/exit-interviews?from=${shift(3)}&to=${shift(1)}`, 'hrA')).status, 400);
    assert.equal((await call('GET', '/exit-interviews', 'hrA')).body.count, 2, 'the default range is the last 12 months up to today, so a last day in the future is not in it yet');
});

test('routes: summary and CSV, India company refused, and one company never sees another\'s interviews', async () => {
    await seed();
    await call('PUT', '/exit-interview/me', 'leaveA', { answers: good });
    await call('PUT', '/exit-interviews/goneA', 'hrA', { answers: { reason: 'better_pay', overall: 2 } });
    await call('PUT', '/exit-interview/me', 'leaveB', { answers: { reason: 'health', overall: 5 } });
    const range = `from=${shift(-30)}&to=${shift(30)}`;
    const s = await call('GET', `/exit-interviews/summary?${range}`, 'hrA');
    assert.equal(s.status, 200);
    assert.deepEqual({ leavers: s.body.leavers, responses: s.body.responses, rate: s.body.responseRate, reasons: s.body.reasons }, { leavers: 3, responses: 2, rate: 66.7, reasons: [{ reason: 'better_pay', label: 'Better pay somewhere else', count: 2, percent: 100 }] });
    assert.deepEqual(s.body.ratings.find((r) => r.id === 'overall'), { id: 'overall', text: Q[1].text.en, answers: 2, average: 3 });
    const csv = await call('GET', `/exit-interviews/summary?${range}&format=csv`, 'hrA');
    assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.headers.get('content-disposition'), /attachment; filename="reasons-for-leaving-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = csv.text.trim().split('\n');
    assert.equal(lines[0], 'Section,Item,Count,Share or average');
    assert.equal(lines[1], 'Reason for leaving,Better pay somewhere else,2,100%');
    assert.ok(lines.includes('Totals,People who left in this period,3,'));
    assert.ok(!csv.text.includes('Lena'), 'the CSV has totals only, no names');
    assert.equal((await call('GET', '/exit-interviews/summary?from=2026-02-30', 'hrA')).status, 400);

    const b = await call('GET', `/exit-interviews/summary?${range}`, 'hrB');
    assert.deepEqual(b.body.reasons.map((r) => [r.reason, r.count]), [['health', 1]]);
    assert.deepEqual((await call('GET', `/exit-interviews?${range}`, 'hrB')).body.data.map((r) => r.userId), ['leaveB']);
    assert.equal((await call('GET', '/exit-interviews/leaveA', 'hrB')).status, 404);
    assert.equal((await call('PUT', '/exit-interviews/leaveA', 'hrB', { hrNotes: 'not mine' })).status, 404);
    assert.equal((await call('GET', '/exit-interviews/leaveA', 'hrA')).body.interview.hrNotes, '');
    for (const [method, path, body] of [['GET', '/exit-interviews'], ['GET', '/exit-interviews/summary'], ['GET', '/exit-interviews/questions'], ['GET', '/exit-interview/me'], ['PUT', '/exit-interview/me', { answers: good }]]) assert.equal((await call(method, path, 'saIN', body)).status, 409, `India company ${method} ${path}`);
    assert.equal((await call('POST', '/exit-interviews/questions/reset', 'hrA', {})).body.customised, false);
});

/* -------------------------------------- the pages -------------------------------------- */

test('pages: the employee page is bilingual with the shared language key; neither page has inline handlers', () => {
    const mine = fs.readFileSync(new URL('../my-exit-interview.html', import.meta.url), 'utf8');
    assert.match(mine, /localStorage\.getItem\('kylrx_lang'\)/); assert.match(mine, /localStorage\.setItem\('kylrx_lang'/);
    assert.match(mine, /name="viewport"/); assert.match(mine, /es:\s*\{/); assert.match(mine, /\/api\/us\/exit-interview\/me/);
    const hr = fs.readFileSync(new URL('../admin-us-exit-interviews.html', import.meta.url), 'utf8');
    for (const page of [mine, hr]) assert.ok(!/\son[a-z]+\s*=\s*["']/.test(page), 'no inline event handlers');
    assert.match(hr, /exit-interviews\/summary/); assert.match(hr, /format=csv/);
});
