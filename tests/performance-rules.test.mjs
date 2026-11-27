import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../services/performance-rules.js');

test('a goal needs a title; dates and progress are checked; done means 100', () => {
    assert.deepEqual(P.validateGoal({ title: 'x' }).errors, ['Write what the goal is (at least 3 characters)']);
    assert.equal(P.validateGoal({ title: 'Learn the register', dueDate: '2026-13-40' }).errors.length, 1);
    assert.equal(P.validateGoal({ title: 'Learn the register', progress: 101 }).errors.length, 1);
    const ok = P.validateGoal({ title: '  Learn   the <b>register</b> ', detail: 'Close out alone', dueDate: '2026-12-31' });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.title, 'Learn the bregister/b');
    assert.deepEqual(P.validateGoal({ status: 'done' }, { partial: true }).value, { status: 'done', progress: 100 });
    assert.deepEqual(P.validateGoal({ status: 'done', progress: 90 }, { partial: true }).value, { status: 'done', progress: 90 });
    assert.deepEqual(P.validateGoal({}, { partial: true }).errors, ['Nothing to change']);
    assert.deepEqual(P.validateGoal({ dueDate: '' }, { partial: true }).value, { dueDate: null });
});

test('goal summary counts open, done and late goals', () => {
    const goals = [{ status: 'open', dueDate: '2026-11-01', progress: 20 }, { status: 'open', dueDate: '2026-12-01', progress: 60 }, { status: 'open', progress: 0 }, { status: 'done', dueDate: '2026-10-01', progress: 100 }, { status: 'dropped', dueDate: '2026-01-01' }];
    assert.deepEqual(P.goalSummary(goals, '2026-11-11'), { total: 5, open: 3, done: 1, overdue: 1, averageProgress: 27 });
    assert.equal(P.goalSummary([], '2026-11-11').averageProgress, null);
});

test('a review checks the period and ratings; areas may be left unrated', () => {
    assert.equal(P.validateReview({ periodStart: '2026-07-01', periodEnd: '2026-06-30' }).errors.length, 1);
    assert.equal(P.validateReview({ periodStart: '2026-01-01', periodEnd: '2026-06-30', ratings: { Reliability: 6 } }).errors.length, 1);
    const r = P.validateReview({ periodStart: '2026-01-01', periodEnd: '2026-06-30', ratings: { Reliability: 4, Teamwork: '', 'Not an area': 5 }, comments: { Reliability: 'Always on time' }, overall: 4, strengths: 'Great with customers', improvements: '', nextSteps: 'Train on closing' });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.value.ratings, [{ area: 'Reliability', rating: 4, comment: 'Always on time' }]);
    assert.equal(r.value.overall, 4);
    assert.equal(P.averageRating(r.value), 4);
    assert.equal(P.averageRating({ ratings: [] }), null);
});

test('a review must say something before it is shared', () => {
    assert.deepEqual(P.readyToShare({ ratings: [], overall: null, strengths: '', improvements: '', nextSteps: '' }).missing.length, 3);
    assert.equal(P.readyToShare({ ratings: [{ area: 'Reliability', rating: 3 }], strengths: 'Reliable and careful', improvements: '', nextSteps: 'Learn the opening routine' }).ok, true);
});

test('the employee never sees a draft or the private note', () => {
    assert.equal(P.employeeView({ status: 'draft', strengths: 'x', privateNote: 'secret' }), null);
    const v = P.employeeView({ status: 'shared', strengths: 'Reliable', privateNote: 'secret' });
    assert.equal(v.strengths, 'Reliable');
    assert.equal('privateNote' in v, false);
});

test('a shared review is locked; acknowledging happens once and only after sharing', () => {
    assert.equal(P.reviewChangeError({ status: 'draft' }, 'edit'), null);
    assert.match(P.reviewChangeError({ status: 'shared' }, 'edit'), /cannot be changed/);
    assert.match(P.reviewChangeError({ status: 'draft' }, 'acknowledge'), /not been shared/);
    assert.equal(P.reviewChangeError({ status: 'shared' }, 'acknowledge'), null);
    assert.match(P.reviewChangeError({ status: 'acknowledged' }, 'acknowledge'), /already/);
    assert.match(P.reviewChangeError({ status: 'shared' }, 'delete'), /Only a draft/);
    assert.match(P.reviewChangeError({ status: 'shared' }, 'share'), /already shared/);
});
