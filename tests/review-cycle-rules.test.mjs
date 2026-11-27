import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../services/review-cycle-rules.js');

const input = (over = {}) => ({ name: 'Year-end review 2026', periodStart: '2026-01-01', periodEnd: '2026-12-31', dueDate: '2027-01-15', ...over });
const cycle = (over = {}) => ({ id: 'c1', status: 'open', ...R.validateCycle(input({ peerFeedback: true })).value, ...over });
const PEOPLE = [{ id: 'u1', name: 'Ana', managerId: 'm1' }, { id: 'u2', name: 'Ben', managerId: 'm1' }, { id: 'u3', name: 'Cy', managerId: 'm2' }, { id: 'm1', name: 'Mia', managerId: null }, { id: 'm2', name: 'Max', managerId: null }, { id: 'u4', name: 'Di', managerId: 'm2' }];
const GOOD_REVIEW = { status: 'draft', overall: 4, ratings: [], strengths: 'Reliable and careful with customers.', improvements: 'Ask for help sooner when stuck.', nextSteps: '' };

test('a cycle needs a name, a real period and a finish-by date', () => {
    assert.equal(R.validateCycle({}).errors.length, 3);
    assert.match(R.validateCycle(input({ periodEnd: '2025-12-31' })).errors[0], /cannot end before/);
    assert.match(R.validateCycle(input({ periodStart: '2026-02-30' })).errors[0], /real start and end/);
    assert.match(R.validateCycle(input({ dueDate: '2025-06-01' })).errors[0], /before the period starts/);
    const ok = R.validateCycle(input({ name: '  Year-end <b>review</b> ' }));
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.name, 'Year-end breview/b');
    assert.equal(ok.value.audience, 'everyone');
    assert.deepEqual(ok.value.peopleIds, []);
    assert.deepEqual([ok.value.selfReview, ok.value.managerReview, ok.value.peerFeedback, ok.value.sharePeerFeedback], [true, true, false, false]);
    assert.equal(ok.value.peerMinAnswers, 3);
    assert.equal(ok.value.peerSuggested, 3);
    assert.deepEqual(ok.value.selfQuestions.map((q) => q.id), ['s1', 's2', 's3']);
    assert.deepEqual(ok.value.peerQuestions.map((q) => q.text), R.DEFAULT_PEER_QUESTIONS);
});

test('who is included: everyone, or chosen people', () => {
    assert.match(R.validateCycle(input({ audience: 'team' })).errors[0], /audience must be/);
    assert.match(R.validateCycle(input({ audience: 'chosen' })).errors[0], /Choose at least one person/);
    const chosen = R.validateCycle(input({ audience: 'chosen', peopleIds: ['u1', 'u1', ' u3 ', ''] })).value;
    assert.deepEqual(chosen.peopleIds, ['u1', 'u3']);
    assert.deepEqual(R.audienceFor(chosen, PEOPLE).map((p) => p.id), ['u1', 'u3']);
    assert.equal(R.audienceFor({ audience: 'everyone' }, PEOPLE).length, PEOPLE.length);
    // ids are dropped when everyone is included, and people who left are reported
    assert.deepEqual(R.validateCycle(input({ audience: 'everyone', peopleIds: ['u1'] })).value.peopleIds, []);
    assert.deepEqual(R.unknownPeople(['u1', 'gone'], PEOPLE), ['gone']);
});

test('parts of a cycle: at least one, and sharing coworker feedback only when it is asked for', () => {
    assert.match(R.validateCycle(input({ selfReview: false, managerReview: false, peerFeedback: false })).errors[0], /at least one part/);
    assert.equal(R.validateCycle(input({ peerFeedback: false, sharePeerFeedback: true })).value.sharePeerFeedback, false);
    assert.equal(R.validateCycle(input({ peerFeedback: true, sharePeerFeedback: true })).value.sharePeerFeedback, true);
    assert.equal(R.validateCycle(input({ selfReview: 'false', managerReview: false, peerFeedback: 'on' })).value.selfReview, false);
});

test('the fewest coworker answers can be raised but never set below 3', () => {
    assert.match(R.validateCycle(input({ peerMinAnswers: 2 })).errors[0], /from 3 to 10/);
    assert.match(R.validateCycle(input({ peerMinAnswers: 1.5 })).errors[0], /whole number/);
    assert.match(R.validateCycle(input({ peerMinAnswers: 11 })).errors[0], /from 3 to 10/);
    assert.match(R.validateCycle(input({ peerMinAnswers: 5, peerSuggested: 4 })).errors[0], /from 5 to 10/);
    const v = R.validateCycle(input({ peerMinAnswers: 4 })).value;
    assert.deepEqual([v.peerMinAnswers, v.peerSuggested], [4, 4]);
    assert.equal(R.validateCycle(input({ peerMinAnswers: 3, peerSuggested: 6 })).value.peerSuggested, 6);
    // a stored record that was tampered with still cannot go below the floor
    assert.equal(R.minAnswers({ peerMinAnswers: 1 }), 3);
    assert.equal(R.minAnswers({ peerMinAnswers: 0 }), 3);
    assert.equal(R.minAnswers({}), 3);
    assert.equal(R.minAnswers({ peerMinAnswers: 5 }), 5);
});

test('questions can be typed one per line', () => {
    const v = R.validateCycle(input({ peerQuestions: 'What should they keep doing?\n\n  What should they stop doing?  ', selfQuestions: ['What are you proud of?'] })).value;
    assert.deepEqual(v.peerQuestions, [{ id: 'p1', text: 'What should they keep doing?' }, { id: 'p2', text: 'What should they stop doing?' }]);
    assert.deepEqual(v.selfQuestions, [{ id: 's1', text: 'What are you proud of?' }]);
    assert.match(R.validateCycle(input({ peerQuestions: ['Why?'] })).errors[0], /at least 5 characters/);
    assert.match(R.validateCycle(input({ peerQuestions: [] })).errors[0], /1 to 6 questions/);
    assert.match(R.validateCycle(input({ selfQuestions: Array.from({ length: 7 }, (_, i) => `Question number ${i}`) })).errors[0], /1 to 6 questions/);
    assert.match(R.validateCycle(input({ selfQuestions: ['Same question', 'same question'] })).errors[0], /twice/);
});

test('draft, open, closed: what may be done when', () => {
    const d = cycle({ status: 'draft' }); const o = cycle(); const c = cycle({ status: 'closed' });
    assert.equal(R.cycleChangeError(d, 'edit'), null);
    assert.match(R.cycleChangeError(o, 'edit'), /cannot be changed/);
    assert.equal(R.cycleChangeError(d, 'delete'), null);
    assert.match(R.cycleChangeError(c, 'delete'), /Only a draft/);
    assert.equal(R.cycleChangeError(d, 'open', '2027-01-15'), null);
    assert.match(R.cycleChangeError(d, 'open', '2027-01-16'), /already passed/);
    assert.match(R.cycleChangeError(o, 'open', '2026-06-01'), /already open/);
    assert.match(R.cycleChangeError(c, 'open', '2026-06-01'), /cannot be opened again/);
    assert.equal(R.cycleChangeError(o, 'close'), null);
    assert.match(R.cycleChangeError(d, 'close'), /Only an open review/);
    assert.match(R.cycleChangeError(c, 'close'), /already closed/);
    for (const action of ['self', 'manager_review', 'peers', 'peer_answer']) {
        assert.equal(R.cycleChangeError(o, action), null, action);
        assert.match(R.cycleChangeError(d, action), /not open yet/, action);
        assert.match(R.cycleChangeError(c, action), /is closed/, action);
    }
    assert.match(R.cycleChangeError(cycle({ selfReview: false }), 'self'), /does not ask for a self review/);
    assert.match(R.cycleChangeError(cycle({ managerReview: false }), 'manager_review'), /does not ask for a manager review/);
    assert.match(R.cycleChangeError(cycle({ peerFeedback: false }), 'peers'), /does not ask coworkers/);
    assert.match(R.cycleChangeError(cycle({ peerFeedback: false }), 'peer_answer'), /does not ask coworkers/);
    assert.equal(R.isLate(o, '2027-01-16'), true);
    assert.equal(R.isLate(o, '2027-01-15'), false);
    assert.equal(R.isLate(c, '2028-01-01'), false);
});

test('opening makes one empty record per person', () => {
    const m = R.newMember('c1', 'org1', { id: 'u1', name: 'Ana', employeeId: 'E1' }, 't1');
    assert.deepEqual(m, { orgId: 'org1', cycleId: 'c1', userId: 'u1', name: 'Ana', employeeId: 'E1', self: null, peerIds: [], managerReviewId: null, managerDoneAt: null, createdAt: 't1' });
    assert.equal(R.memberId('c1', 'u1'), 'c1_u1');
});

test('self review: a draft may be partly filled, sending it needs every answer', () => {
    const c = cycle();
    assert.deepEqual(R.validateSelfReview(c, {}).errors, ['Write something before saving']);
    assert.deepEqual(R.validateSelfReview(c, null).errors, ['Write something before saving']);
    const part = R.validateSelfReview(c, { s1: '  Trained two new people. <script> ', zz: 'dropped' });
    assert.deepEqual(part.value, { answers: { s1: 'Trained two new people. script' } });
    const sent = R.validateSelfReview(c, { s1: 'Trained two new people.' }, { submit: true });
    assert.equal(sent.errors.length, 2);
    assert.match(sent.errors[0], /Please answer: /);
    assert.deepEqual(R.validateSelfReview(c, { s1: 'a', s2: 'b', s3: 'c' }, { submit: true }).errors, []);
    assert.equal(R.validateSelfReview(c, { s1: 'x'.repeat(5000) }).value.answers.s1.length, R.ANSWER_MAX);
});

test('a manager does not see a self review until the person has sent it', () => {
    const draft = { self: { answers: { s1: 'Not finished' }, savedAt: 't1', submittedAt: null } };
    assert.equal(R.selfReviewFor(draft, 'manager'), null);
    assert.equal(R.selfReviewFor(draft, 'hr'), null);
    assert.deepEqual(R.selfReviewFor(draft, 'self').answers, { s1: 'Not finished' });
    assert.equal(R.selfReviewFor({ self: { answers: { s1: 'Done' }, savedAt: 't1', submittedAt: 't2' } }, 'manager').submittedAt, 't2');
    assert.equal(R.selfReviewFor({ self: null }, 'self'), null);
});

test('choosing coworkers: never the person themself, their manager or the one choosing', () => {
    const c = cycle(); const known = PEOPLE.map((p) => p.id);
    const pick = (peerIds, over = {}) => R.validatePeers(c, { subjectId: 'u1', managerId: 'm1', pickerId: 'm1', peerIds, knownIds: known, ...over });
    assert.deepEqual(pick(['u2', 'u3', 'u4']).value, ['u2', 'u3', 'u4']);
    assert.deepEqual(pick(['u2', 'u2', 'u3', ' u4 ']).value, ['u2', 'u3', 'u4']);
    assert.match(pick(['u1', 'u2', 'u3']).errors[0], /cannot give coworker feedback about themselves/);
    assert.match(pick(['m1', 'u2', 'u3']).errors[0], /manager writes the manager review/);
    assert.match(pick(['m2', 'u2', 'u3'], { pickerId: 'm2' }).errors[0], /cannot ask yourself/);
    assert.match(pick(['u2', 'u3', 'nobody']).errors[0], /not found/);
    assert.match(pick(['u2', 'u3']).errors[0], /Ask at least 3 coworkers/);
    assert.match(R.validatePeers(cycle({ peerMinAnswers: 4 }), { subjectId: 'u1', peerIds: ['u2', 'u3', 'u4'], knownIds: known }).errors[0], /Ask at least 4/);
    assert.match(R.validatePeers(c, { subjectId: 'x', peerIds: Array.from({ length: 11 }, (_, i) => `k${i}`), knownIds: Array.from({ length: 11 }, (_, i) => `k${i}`) }).errors[0], /at most 10/);
    assert.deepEqual(pick([]).value, []); // the list may be cleared
    assert.match(pick('u2').errors[0], /Send the list/);
    assert.deepEqual(R.validatePeers(c, { subjectId: 'u1', peerIds: ['u2', 'u3', 'u4'], knownIds: new Set(known) }).errors, []);
});

test('the list of coworkers is final once enough answers are in', () => {
    assert.equal(R.peersLocked(cycle(), 2), false);
    assert.equal(R.peersLocked(cycle(), 3), true);
    assert.equal(R.peersLocked(cycle({ peerMinAnswers: 5 }), 4), false);
    assert.equal(R.peersLocked(cycle({ peerMinAnswers: 1 }), 2), false);
});

test('a coworker answers at least one question; the rating is optional', () => {
    const c = cycle();
    assert.deepEqual(R.validatePeerAnswer(c, {}).errors, ['Answer at least one question']);
    assert.deepEqual(R.validatePeerAnswer(c, { answers: { p1: '   ' }, rating: 4 }).errors, ['Answer at least one question']);
    assert.match(R.validatePeerAnswer(c, { answers: { p1: 'Helps everyone.' }, rating: 6 }).errors[0], /1 to 5/);
    assert.match(R.validatePeerAnswer(c, { answers: { p1: 'Helps everyone.' }, rating: 2.5 }).errors[0], /whole number/);
    assert.deepEqual(R.validatePeerAnswer(c, { answers: { p1: ' Helps everyone. ', p9: 'dropped' }, userId: 'u2' }).value, { answers: { p1: 'Helps everyone.' }, rating: null });
    assert.equal(R.validatePeerAnswer(c, { answers: { p2: 'Could speak up more.' }, rating: '4' }).value.rating, 4);
});

test('the answered marker is a hash: one per coworker, per person, per cycle', () => {
    const k = R.peerKey('c1', 'u1', 'u2');
    assert.match(k, /^[0-9a-f]{40}$/);
    assert.equal(k, R.peerKey('c1', 'u1', 'u2'));
    assert.notEqual(k, R.peerKey('c1', 'u2', 'u1'));
    assert.notEqual(k, R.peerKey('c2', 'u1', 'u2'));
    assert.notEqual(k, R.peerKey('c1', 'u1', 'u3'));
    assert.ok(!k.includes('u2'));
});

const ANSWERS = [
    { answers: { p1: 'Zeal for the job', p2: 'Arrive on time' }, rating: 5 },
    { answers: { p1: 'Always helps', p2: 'Speak up more' }, rating: 4 },
    { answers: { p1: 'Knows the stock' }, rating: null }
];

test('combined coworker feedback stays hidden below the minimum', () => {
    const c = cycle();
    const two = R.combinePeerFeedback(c, ANSWERS.slice(0, 2), { asked: 4, viewer: 'manager' });
    assert.deepEqual(two, { asked: 4, answered: 2, minAnswers: 3, needed: 1, hidden: true, rating: null, questions: [] });
    assert.ok(!JSON.stringify(two).includes('Zeal'));
    assert.equal(R.combinePeerFeedback(c, [], { asked: 0, viewer: 'hr' }).hidden, true);
    // a higher minimum set on the cycle is respected, a lower one is not
    assert.equal(R.combinePeerFeedback(cycle({ peerMinAnswers: 4 }), ANSWERS, { viewer: 'hr' }).hidden, true);
    assert.equal(R.combinePeerFeedback(cycle({ peerMinAnswers: 1 }), ANSWERS.slice(0, 2), { viewer: 'hr' }).hidden, true);
    assert.equal(R.combinePeerFeedback(cycle({ peerMinAnswers: 1 }), ANSWERS.slice(0, 1), { viewer: 'hr' }).hidden, true);
});

test('with enough answers the manager and HR see comments in alphabetical order, without names', () => {
    const c = cycle();
    const all = R.combinePeerFeedback(c, ANSWERS.map((a) => ({ ...a, userId: 'never-stored', peerId: 'never-stored' })), { asked: 3, viewer: 'manager' });
    assert.equal(all.hidden, false);
    assert.deepEqual(all.questions[0].comments, ['Always helps', 'Knows the stock', 'Zeal for the job']);
    assert.deepEqual(all.questions[1].comments, ['Arrive on time', 'Speak up more']);
    assert.deepEqual(all.questions[2], { id: 'p3', text: c.peerQuestions[2].text, answered: 0, comments: [] });
    assert.deepEqual(all.rating, { count: 2, average: 4.5 });
    assert.ok(!JSON.stringify(all).includes('never-stored'));
    assert.equal(R.combinePeerFeedback(c, ANSWERS, { viewer: 'hr' }).hidden, false);
    assert.equal(R.combinePeerFeedback(c, ANSWERS, { viewer: 'reader' }).hidden, false);
    assert.equal(R.combinePeerFeedback(c, ANSWERS.map((a) => ({ ...a, rating: null })), { viewer: 'hr' }).rating, null);
    assert.equal(R.combinePeerFeedback(c, ANSWERS, { viewer: 'stranger' }).hidden, true);
    assert.equal(R.combinePeerFeedback(cycle({ peerFeedback: false }), ANSWERS, { viewer: 'hr' }).hidden, true);
});

test('the person reviewed sees coworker feedback only if the cycle says so, and only after it closed', () => {
    assert.equal(R.combinePeerFeedback(cycle({ sharePeerFeedback: true }), ANSWERS, { viewer: 'self' }).hidden, true); // still open
    assert.equal(R.combinePeerFeedback(cycle({ sharePeerFeedback: false, status: 'closed' }), ANSWERS, { viewer: 'self' }).hidden, true);
    const shown = R.combinePeerFeedback(cycle({ sharePeerFeedback: true, status: 'closed' }), ANSWERS, { viewer: 'self' });
    assert.equal(shown.hidden, false);
    assert.equal(shown.questions[0].comments.length, 3);
    assert.equal(R.combinePeerFeedback(cycle({ sharePeerFeedback: true, status: 'closed' }), ANSWERS.slice(0, 2), { viewer: 'self' }).hidden, true);
    assert.equal(R.maySeePeerFeedback(cycle({ sharePeerFeedback: true, status: 'closed' }), 'self', 3), true);
    assert.equal(R.maySeePeerFeedback(cycle({ sharePeerFeedback: true, status: 'closed' }), 'self', 2), false);
});

test('progress for one person and for the cycle', () => {
    const c = cycle();
    const fresh = R.newMember('c1', 'o', PEOPLE[0], 't');
    assert.deepEqual(R.memberProgress(c, fresh), { self: 'not_started', manager: 'not_started', peers: 'not_chosen', peersAsked: 0, peersAnswered: 0, peersNeeded: 3 });
    const busy = { ...fresh, self: { answers: { s1: 'x' }, savedAt: 't1', submittedAt: null }, peerIds: ['u2', 'u3', 'u4'], managerReviewId: 'r1' };
    assert.deepEqual(R.memberProgress(c, busy, { peerAnswers: 2, review: { status: 'draft' } }), { self: 'draft', manager: 'draft', peers: 'waiting', peersAsked: 3, peersAnswered: 2, peersNeeded: 1 });
    const done = { ...busy, self: { ...busy.self, submittedAt: 't2' }, managerDoneAt: 't3' };
    const p = R.memberProgress(c, done, { peerAnswers: 3, review: { status: 'draft' } });
    assert.deepEqual([p.self, p.manager, p.peers, p.peersNeeded], ['done', 'finished', 'enough', 0]);
    assert.equal(R.memberProgress(c, done, { review: { status: 'acknowledged' } }).manager, 'shared');
    assert.equal(R.memberProgress(c, done, { review: null }).manager, 'not_started'); // the linked review was deleted
    const off = R.memberProgress(cycle({ selfReview: false, managerReview: false, peerFeedback: false }), done, { peerAnswers: 3, review: { status: 'draft' } });
    assert.deepEqual([off.self, off.manager, off.peers, off.peersNeeded], ['not_asked', 'not_asked', 'not_asked', 0]);
    const totals = R.cycleProgress([R.memberProgress(c, fresh), R.memberProgress(c, busy, { peerAnswers: 2, review: { status: 'draft' } }), p]);
    assert.deepEqual(totals, { people: 3, selfAsked: 3, selfDone: 1, managerAsked: 3, managerDone: 1, peersAsked: 3, peersEnough: 1, peerAnswers: 5 });
    assert.deepEqual(R.cycleProgress([]), { people: 0, selfAsked: 0, selfDone: 0, managerAsked: 0, managerDone: 0, peersAsked: 0, peersEnough: 0, peerAnswers: 0 });
});

test('closing shares the manager reviews that were marked finished and are complete', () => {
    const c = cycle();
    const members = [
        { userId: 'u1', managerReviewId: 'r1', managerDoneAt: 't' }, // finished and complete: shared
        { userId: 'u2', managerReviewId: 'r2', managerDoneAt: null }, // still being written
        { userId: 'u3', managerReviewId: null, managerDoneAt: null }, // never started
        { userId: 'u4', managerReviewId: 'r4', managerDoneAt: 't' }, // the manager already shared it
        { userId: 'm1', managerReviewId: 'r5', managerDoneAt: 't' }, // marked finished, then emptied elsewhere
        { userId: 'm2', managerReviewId: 'gone', managerDoneAt: 't' } // the review was deleted
    ];
    const reviews = { r1: GOOD_REVIEW, r2: GOOD_REVIEW, r4: { ...GOOD_REVIEW, status: 'shared' }, r5: { ...GOOD_REVIEW, strengths: '' } };
    assert.deepEqual(R.reviewsToShareOnClose(c, members, reviews), { share: ['r1'], notReady: ['u2', 'u3', 'm1', 'm2'] });
    assert.deepEqual(R.reviewsToShareOnClose(cycle({ managerReview: false }), members, reviews), { share: [], notReady: [] });
});

test('a manager sees only their own team, HR sees everyone, nobody else sees anyone', () => {
    const members = PEOPLE.map((p) => ({ userId: p.id }));
    const byId = new Map(PEOPLE.map((p) => [p.id, p]));
    assert.deepEqual(R.visibleMembers(members, byId, { viewerId: 'm1', manager: true }).map((m) => m.userId), ['u1', 'u2']);
    assert.deepEqual(R.visibleMembers(members, byId, { viewerId: 'm2', manager: true }).map((m) => m.userId), ['u3', 'u4']);
    assert.equal(R.visibleMembers(members, byId, { viewerId: 'hr1', companyWide: true }).length, PEOPLE.length);
    assert.deepEqual(R.visibleMembers(members, byId, { viewerId: 'u1' }), []);
    // a person who is not a manager gets nothing even if someone's record names them as manager
    assert.deepEqual(R.visibleMembers(members, byId, { viewerId: 'm1', manager: false }), []);
    // someone who has left the company (no longer in the people list) is visible to HR only
    assert.deepEqual(R.visibleMembers([{ userId: 'left' }], byId, { viewerId: 'm1', manager: true }), []);
    assert.deepEqual(R.visibleMembers(members, Object.fromEntries(byId), { viewerId: 'm1', manager: true }).map((m) => m.userId), ['u1', 'u2']);
});
