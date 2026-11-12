/**
 * Goals and performance reviews for US companies (pure, no I/O).
 *
 * Goals belong to one person. Reviews are written by a manager or HR for a period, stay a private draft
 * until they are shared, and the employee then acknowledges having seen them (acknowledging is not agreeing).
 * Nothing here scores or ranks people automatically: ratings are what the reviewer typed.
 */
const { parseIsoDate } = require('./us-forms');

const GOAL_STATUSES = ['open', 'done', 'dropped'];
const REVIEW_STATUSES = ['draft', 'shared', 'acknowledged'];
const DEFAULT_AREAS = ['Quality of work', 'Reliability', 'Teamwork', 'Communication', 'Job knowledge'];
const RATING_LABELS = { 1: 'Does not meet expectations', 2: 'Partly meets expectations', 3: 'Meets expectations', 4: 'Exceeds expectations', 5: 'Outstanding' };
const NOTE = 'Keep goals and reviews about the job. Do not record health, family, age, religion or other protected personal matters. A review can be requested in a dispute, so write it as you would say it to the person.';

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);

/** New goal, or a change to one (partial: only the fields that were sent) */
function validateGoal(input, { partial = false } = {}) {
    const errors = []; const b = input || {}; const value = {};
    if (!partial || b.title !== undefined) { const t = clean(b.title, 160); if (t.length < 3) errors.push('Write what the goal is (at least 3 characters)'); else value.title = t; }
    if (b.detail !== undefined) value.detail = block(b.detail, 1000);
    if (b.dueDate !== undefined) { if (b.dueDate === '' || b.dueDate === null) value.dueDate = null; else if (!parseIsoDate(b.dueDate)) errors.push('dueDate must be a real date (YYYY-MM-DD)'); else value.dueDate = String(b.dueDate); }
    if (b.progress !== undefined) { const p = Number(b.progress); if (!Number.isInteger(p) || p < 0 || p > 100) errors.push('progress must be a whole number from 0 to 100'); else value.progress = p; }
    if (b.status !== undefined) { if (!GOAL_STATUSES.includes(b.status)) errors.push(`status must be one of: ${GOAL_STATUSES.join(', ')}`); else value.status = b.status; }
    if (partial && !errors.length && !Object.keys(value).length) errors.push('Nothing to change');
    // finishing a goal means it is fully done; reopening one that was at 100 keeps the number the person set
    if (value.status === 'done' && value.progress === undefined) value.progress = 100;
    return { errors, value: errors.length ? null : value };
}

/** Is a goal late? (open, has a due date, and that date has passed) */
const isOverdue = (goal, todayIso) => goal.status === 'open' && Boolean(goal.dueDate) && goal.dueDate < todayIso;

/** Counts for one person's goals */
function goalSummary(goals, todayIso) {
    const open = goals.filter((g) => g.status === 'open');
    return { total: goals.length, open: open.length, done: goals.filter((g) => g.status === 'done').length, overdue: open.filter((g) => isOverdue(g, todayIso)).length,
        averageProgress: open.length ? Math.round(open.reduce((s, g) => s + (g.progress || 0), 0) / open.length) : null };
}

/** A review as the reviewer writes it. areas: the company's list of things to rate. */
function validateReview(input, areas = DEFAULT_AREAS) {
    const errors = []; const b = input || {}; const value = {};
    if (!parseIsoDate(b.periodStart) || !parseIsoDate(b.periodEnd)) errors.push('periodStart and periodEnd must be real dates (YYYY-MM-DD)');
    else if (b.periodEnd < b.periodStart) errors.push('The period cannot end before it starts');
    else { value.periodStart = String(b.periodStart); value.periodEnd = String(b.periodEnd); }
    const given = b.ratings && typeof b.ratings === 'object' ? b.ratings : {};
    const ratings = [];
    for (const area of areas) {
        const raw = given[area];
        if (raw === undefined || raw === null || raw === '') continue; // an area may be left unrated
        const r = Number(raw);
        if (!Number.isInteger(r) || r < 1 || r > 5) errors.push(`Rate "${area}" from 1 to 5, or leave it empty`);
        else ratings.push({ area, rating: r, comment: clean((b.comments || {})[area], 400) });
    }
    value.ratings = ratings;
    if (b.overall !== undefined && b.overall !== null && b.overall !== '') { const o = Number(b.overall); if (!Number.isInteger(o) || o < 1 || o > 5) errors.push('overall must be a whole number from 1 to 5'); else value.overall = o; } else value.overall = null;
    value.strengths = block(b.strengths, 3000); value.improvements = block(b.improvements, 3000); value.nextSteps = block(b.nextSteps, 3000);
    return { errors, value: errors.length ? null : value };
}

/** What must be filled in before a review can be shown to the employee */
function readyToShare(review) {
    const missing = [];
    if (!(review.ratings || []).length && !review.overall) missing.push('at least one rating');
    if ((review.strengths || '').length < 10) missing.push('what went well (10 characters or more)');
    if ((review.improvements || '').length < 10 && (review.nextSteps || '').length < 10) missing.push('what to work on or next steps (10 characters or more)');
    return { ok: missing.length === 0, missing };
}

const averageRating = (review) => ((review.ratings || []).length ? Math.round((review.ratings.reduce((s, r) => s + r.rating, 0) / review.ratings.length) * 10) / 10 : null);

/** The employee's copy: nothing of a draft, and never the reviewer's private note */
function employeeView(review) {
    if (review.status === 'draft') return null;
    const { privateNote, ...rest } = review;
    return rest;
}

/** May this change be made? Returns null when allowed, or the reason it is not. */
function reviewChangeError(review, action) {
    if (action === 'edit' && review.status !== 'draft') return 'A review that has been shared cannot be changed. Write a new review to correct it.';
    if (action === 'share' && review.status !== 'draft') return 'This review was already shared';
    if (action === 'acknowledge' && review.status === 'draft') return 'This review has not been shared yet';
    if (action === 'acknowledge' && review.status === 'acknowledged') return 'You already acknowledged this review';
    if (action === 'delete' && review.status !== 'draft') return 'Only a draft can be deleted';
    return null;
}

module.exports = { GOAL_STATUSES, REVIEW_STATUSES, DEFAULT_AREAS, RATING_LABELS, NOTE, validateGoal, isOverdue, goalSummary, validateReview, readyToShare, averageRating, employeeView, reviewChangeError, clean, block };
