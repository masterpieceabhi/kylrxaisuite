import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../services/survey-rules.js');

const survey = (over = {}) => ({ status: 'open', minResponses: 3, closesOn: null, questions: [
    { id: 'q1', type: 'scale', text: 'I know what is expected of me', required: true },
    { id: 'q2', type: 'enps', text: 'How likely are you to recommend us?', required: true },
    { id: 'q3', type: 'yesno', text: 'Do you have the tools you need?', required: false },
    { id: 'q4', type: 'text', text: 'Anything else?', required: false }
], ...over });

test('a survey needs a title and real questions; ids are kept or made', () => {
    assert.equal(S.validateSurvey({ title: 'x', questions: [] }).errors.length, 2);
    assert.equal(S.validateSurvey({ title: 'Pulse', questions: [{ type: 'stars', text: 'How are things?' }] }).errors.length, 1);
    assert.equal(S.validateSurvey({ title: 'Pulse', questions: [{ type: 'scale', text: 'Hm' }] }).errors.length, 1);
    assert.deepEqual(S.validateSurvey({ title: 'Pulse', questions: [{ type: 'text', text: 'Tell us more' }] }).errors, ['Add at least one question that is not a comment box']);
    assert.equal(S.validateSurvey({ title: 'Pulse', minResponses: 2, questions: [{ type: 'scale', text: 'Work is going well' }] }).errors.length, 1);
    assert.equal(S.validateSurvey({ title: 'Pulse', closesOn: '2026-02-30', questions: [{ type: 'scale', text: 'Work is going well' }] }).errors.length, 1);
    const ok = S.validateSurvey({ title: ' Team  <b>pulse</b> ', questions: [{ id: 'q2', type: 'scale', text: 'Work is going well' }, { type: 'text', text: 'Tell us more' }, { id: 'q2', type: 'yesno', text: 'Is the schedule fair?' }] });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.title, 'Team bpulse/b');
    assert.equal(ok.value.minResponses, 5);
    assert.equal(ok.value.closesOn, null);
    assert.deepEqual(ok.value.questions.map((q) => q.id), ['q2', 'q1', 'q3']);
    assert.deepEqual(ok.value.questions.map((q) => q.required), [true, false, true]);
    assert.equal(S.validateSurvey({ title: 'Too long', questions: Array.from({ length: 21 }, () => ({ type: 'scale', text: 'Work is going well' })) }).errors.length, 1);
});

test('the built-in templates are valid surveys', () => {
    for (const t of Object.values(S.TEMPLATES)) assert.deepEqual(S.validateSurvey(t).errors, []);
});

test('answers are checked by question type; required ones must be there', () => {
    assert.equal(S.validateAnswers(survey(), {}).errors.length, 2);
    assert.equal(S.validateAnswers(survey(), { q1: 6, q2: 11, q3: 'maybe' }).errors.length, 3);
    assert.equal(S.validateAnswers(survey(), { q1: 4.5, q2: 9 }).errors.length, 1);
    const ok = S.validateAnswers(survey(), { q1: '4', q2: 0, q3: 'no', q4: '  More <i>fans</i>  ', q9: 'ignored' });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value, { q1: 4, q2: 0, q3: 'no', q4: 'More ifans/i' });
    assert.deepEqual(S.validateAnswers(survey(), { q1: 3, q2: 7, q4: '   ' }).value, { q1: 3, q2: 7 });
    const optional = survey({ questions: [{ id: 'q1', type: 'scale', text: 'Optional one', required: false }] });
    assert.deepEqual(S.validateAnswers(optional, {}).errors, ['Answer at least one question']);
});

test('a survey moves draft to open to closed, and takes answers only while open', () => {
    assert.equal(S.surveyChangeError({ status: 'draft' }, 'edit'), null);
    assert.match(S.surveyChangeError({ status: 'open' }, 'edit'), /cannot be changed/);
    assert.equal(S.surveyChangeError({ status: 'draft', closesOn: '2026-11-30' }, 'open', '2026-11-11'), null);
    assert.match(S.surveyChangeError({ status: 'draft', closesOn: '2026-11-01' }, 'open', '2026-11-11'), /already passed/);
    assert.match(S.surveyChangeError({ status: 'closed' }, 'open', '2026-11-11'), /cannot be opened again/);
    assert.match(S.surveyChangeError({ status: 'draft' }, 'close'), /Only an open survey/);
    assert.match(S.surveyChangeError({ status: 'open' }, 'delete'), /Only a draft/);
    assert.equal(S.surveyChangeError({ status: 'open', closesOn: '2026-11-11' }, 'answer', '2026-11-11'), null);
    assert.equal(S.surveyChangeError({ status: 'open', closesOn: '2026-11-10' }, 'answer', '2026-11-11'), 'This survey is closed');
    assert.equal(S.surveyChangeError({ status: 'draft' }, 'answer', '2026-11-11'), 'This survey is not open yet');
    assert.equal(S.isAcceptingAnswers({ status: 'closed' }, '2026-11-11'), false);
});

test('eNPS is the share of promoters minus the share of detractors', () => {
    assert.deepEqual(S.enps([10, 9, 8, 7, 6, 0]), { count: 6, promoters: 2, passives: 2, detractors: 2, score: 0 });
    assert.equal(S.enps([10, 10, 9, 3]).score, 50);
    assert.equal(S.enps([1, 2, 3]).score, -100);
    assert.equal(S.enps([]).score, null);
});

test('results stay hidden until enough people answered, for the survey and for each question', () => {
    const two = [{ answers: { q1: 5, q2: 10 } }, { answers: { q1: 4, q2: 9 } }];
    const hidden = S.summarize(survey(), two, { audience: 10 });
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.needed, 1);
    assert.equal(hidden.rate, 20);
    assert.deepEqual(hidden.questions, []);

    const four = [
        { answers: { q1: 5, q2: 10, q3: 'yes', q4: 'Zebra crossing outside' } },
        { answers: { q1: 4, q2: 9, q3: 'yes', q4: 'A better schedule' } },
        { answers: { q1: 2, q2: 3, q3: 'no' } },
        { answers: { q1: 3, q2: 8 } }
    ];
    const r = S.summarize(survey(), four, { audience: 8 });
    assert.equal(r.hidden, false);
    assert.equal(r.rate, 50);
    const [q1, q2, q3, q4] = r.questions;
    assert.deepEqual(q1.counts, { 1: 0, 2: 1, 3: 1, 4: 1, 5: 1 });
    assert.equal(q1.average, 3.5);
    assert.equal(q1.favorable, 50);
    assert.equal(q2.score, 25);
    assert.equal(q2.counts[10], 1);
    assert.deepEqual([q3.yes, q3.no, q3.yesPercent], [2, 1, 67]);
    // only two people wrote a comment: fewer than the minimum of 3, so the comments stay hidden
    assert.equal(q4.hidden, true);
    assert.equal(q4.comments, undefined);

    const five = [...four, { answers: { q1: 5, q2: 10, q4: 'More training' } }];
    const comments = S.summarize(survey(), five).questions[3].comments;
    assert.deepEqual(comments, ['A better schedule', 'More training', 'Zebra crossing outside']);
});

test('while people can still answer, only the count is given', () => {
    const five = Array.from({ length: 5 }, () => ({ answers: { q1: 5, q2: 10 } }));
    const open = S.summarize(survey(), five, { audience: 10, accepting: true });
    assert.equal(open.hidden, true);
    assert.equal(open.stillOpen, true);
    assert.equal(open.responses, 5);
    assert.equal(open.needed, 0);
    assert.deepEqual(open.questions, []);
    assert.equal(S.summarize(survey(), five, { audience: 10, accepting: false }).hidden, false);
});

test('the minimum can never be set below 3, even by bad stored data', () => {
    assert.equal(S.summarize(survey({ minResponses: 1 }), [{ answers: { q1: 5 } }, { answers: { q1: 4 } }]).hidden, true);
    assert.equal(S.summarize(survey({ minResponses: undefined }), Array.from({ length: 4 }, () => ({ answers: { q1: 5 } }))).hidden, true);
});

test('the answered marker is stable for one person and differs between people and surveys', () => {
    assert.equal(S.responderKey('s1', 'u1'), S.responderKey('s1', 'u1'));
    assert.notEqual(S.responderKey('s1', 'u1'), S.responderKey('s1', 'u2'));
    assert.notEqual(S.responderKey('s1', 'u1'), S.responderKey('s2', 'u1'));
    assert.ok(!S.responderKey('s1', 'user-123').includes('user-123'));
});
