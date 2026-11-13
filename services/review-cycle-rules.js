/**
 * Review cycles and feedback from coworkers ("360 feedback") for US companies (pure, no I/O).
 *
 * A cycle is written by HR as a draft, opened (which makes one record per person in it), and closed.
 * While it is open: each person writes a self review, their manager (or HR) writes the manager review,
 * and the coworkers who were asked answer a short form about the person.
 *
 * Privacy of coworker feedback: an answer is stored without the giver's id. That a coworker answered is kept
 * separately under a hashed key, only so a second answer can be refused. The combined answers are shown to the
 * manager and HR only once enough coworkers answered (the cycle's minimum, never below 3), and to the person
 * reviewed only if the cycle says so and only after it has closed. Comments come back in alphabetical order,
 * question by question, so their order says nothing about who wrote them.
 */
const crypto = require('crypto');
const { parseIsoDate } = require('./us-forms');
const { clean, block, readyToShare } = require('./performance-rules');

const STATUSES = ['draft', 'open', 'closed'];
const AUDIENCES = ['everyone', 'chosen'];
const PEER_MIN_FLOOR = 3;
const PEER_MIN_DEFAULT = 3;
const MAX_PEERS = 10;
const MAX_QUESTIONS = 6;
const MAX_PEOPLE = 2000;
const ANSWER_MAX = 3000;
const PEER_ANSWER_MAX = 1500;
const DEFAULT_SELF_QUESTIONS = ['What went well for you in this period?', 'What was hard, or did not go as planned?', 'What do you want to learn or do next?'];
const DEFAULT_PEER_QUESTIONS = ['What does this person do well?', 'What could this person do better?', 'Anything else that would help them?'];
const NOTE_HR = 'Keep reviews and feedback about the job. Do not record health, family, age, religion or other protected personal matters. A review can be requested in a dispute, so write it as you would say it to the person. If unsure, confirm with a US employment advisor.';
const NOTE_PRIVACY = 'Feedback from coworkers is stored without names and is shown only when enough coworkers have answered. This keeps answers private from people using this app; it is not a guarantee against someone with direct access to the database. Write about the work, not the person.';

const flag = (v, fallback) => (v === undefined || v === null ? fallback : v === true || v === 'true' || v === 1 || v === '1' || v === 'on');

/** A list of questions as typed (an array, or one per line). Missing means the standard list. */
function questionList(raw, defaults, prefix, label, errors) {
    const withIds = (list) => list.map((text, i) => ({ id: `${prefix}${i + 1}`, text }));
    if (raw === undefined || raw === null || raw === '') return withIds(defaults);
    const list = (Array.isArray(raw) ? raw : String(raw).split('\n')).map((q) => clean(q && typeof q === 'object' ? q.text : q, 200)).filter(Boolean);
    if (list.length < 1 || list.length > MAX_QUESTIONS) errors.push(`${label}: write 1 to ${MAX_QUESTIONS} questions`);
    else if (list.some((t) => t.length < 5)) errors.push(`${label}: each question needs at least 5 characters`);
    else if (new Set(list.map((t) => t.toLowerCase())).size !== list.length) errors.push(`${label}: the same question is there twice`);
    return withIds(list.slice(0, MAX_QUESTIONS));
}

/** A cycle as HR writes it */
function validateCycle(input) {
    const errors = []; const b = input || {}; const value = {};
    const name = clean(b.name, 120);
    if (name.length < 3) errors.push('Give the review a name (at least 3 characters)'); else value.name = name;
    if (!parseIsoDate(b.periodStart) || !parseIsoDate(b.periodEnd)) errors.push('The period needs a real start and end date (YYYY-MM-DD)');
    else if (String(b.periodEnd) < String(b.periodStart)) errors.push('The period cannot end before it starts');
    else { value.periodStart = String(b.periodStart); value.periodEnd = String(b.periodEnd); }
    if (!parseIsoDate(b.dueDate)) errors.push('Give a real date by which everything should be finished (YYYY-MM-DD)');
    else if (value.periodStart && String(b.dueDate) < value.periodStart) errors.push('The finish-by date cannot be before the period starts');
    else value.dueDate = String(b.dueDate);

    const audience = b.audience === undefined || b.audience === null || b.audience === '' ? 'everyone' : b.audience;
    if (!AUDIENCES.includes(audience)) errors.push(`audience must be one of: ${AUDIENCES.join(', ')}`); else value.audience = audience;
    const ids = [...new Set((Array.isArray(b.peopleIds) ? b.peopleIds : []).map((x) => String(x || '').trim()).filter(Boolean))];
    if (audience === 'chosen' && !ids.length) errors.push('Choose at least one person, or include everyone');
    if (ids.length > MAX_PEOPLE) errors.push(`At most ${MAX_PEOPLE} people can be chosen one by one. Include everyone instead.`);
    value.peopleIds = audience === 'chosen' ? ids.slice(0, MAX_PEOPLE) : [];

    value.selfReview = flag(b.selfReview, true); value.managerReview = flag(b.managerReview, true); value.peerFeedback = flag(b.peerFeedback, false);
    if (!value.selfReview && !value.managerReview && !value.peerFeedback) errors.push('Turn on at least one part: self review, manager review or feedback from coworkers');
    value.sharePeerFeedback = value.peerFeedback && flag(b.sharePeerFeedback, false);

    if (b.peerMinAnswers === undefined || b.peerMinAnswers === null || b.peerMinAnswers === '') value.peerMinAnswers = PEER_MIN_DEFAULT;
    else {
        const m = Number(b.peerMinAnswers);
        if (!Number.isInteger(m) || m < PEER_MIN_FLOOR || m > MAX_PEERS) errors.push(`The fewest answers needed must be a whole number from ${PEER_MIN_FLOOR} to ${MAX_PEERS}`); else value.peerMinAnswers = m;
    }
    const min = value.peerMinAnswers || PEER_MIN_DEFAULT;
    if (b.peerSuggested === undefined || b.peerSuggested === null || b.peerSuggested === '') value.peerSuggested = min;
    else {
        const s = Number(b.peerSuggested);
        if (!Number.isInteger(s) || s < min || s > MAX_PEERS) errors.push(`The number of coworkers to ask must be a whole number from ${min} to ${MAX_PEERS}`); else value.peerSuggested = s;
    }
    value.selfQuestions = questionList(b.selfQuestions, DEFAULT_SELF_QUESTIONS, 's', 'Self review questions', errors);
    value.peerQuestions = questionList(b.peerQuestions, DEFAULT_PEER_QUESTIONS, 'p', 'Questions for coworkers', errors);
    return { errors, value: errors.length ? null : value };
}

/** The fewest coworker answers before anything is shown: the cycle's number, never below 3 */
const minAnswers = (cycle) => Math.max(PEER_MIN_FLOOR, Number.isInteger(Number(cycle && cycle.peerMinAnswers)) ? Number(cycle.peerMinAnswers) : PEER_MIN_DEFAULT);

/** May this be done to the cycle now? Returns null when allowed, or the reason it is not. */
function cycleChangeError(cycle, action, todayIso) {
    const s = cycle.status;
    if (action === 'edit' && s !== 'draft') return 'A review cannot be changed once it has been opened';
    if (action === 'delete' && s !== 'draft') return 'Only a draft can be deleted';
    if (action === 'open') {
        if (s !== 'draft') return s === 'open' ? 'This review is already open' : 'A closed review cannot be opened again. Start a new one.';
        if (cycle.dueDate && todayIso && cycle.dueDate < todayIso) return 'The finish-by date has already passed. Change it first.';
    }
    if (action === 'close' && s !== 'open') return s === 'closed' ? 'This review is already closed' : 'Only an open review can be closed';
    if (['self', 'manager_review', 'peers', 'peer_answer'].includes(action)) {
        if (action === 'self' && !cycle.selfReview) return 'This review does not ask for a self review';
        if (action === 'manager_review' && !cycle.managerReview) return 'This review does not ask for a manager review';
        if ((action === 'peers' || action === 'peer_answer') && !cycle.peerFeedback) return 'This review does not ask coworkers for feedback';
        if (s === 'draft') return 'This review is not open yet';
        if (s === 'closed') return 'This review is closed';
    }
    return null;
}

const isLate = (cycle, todayIso) => cycle.status === 'open' && Boolean(cycle.dueDate) && Boolean(todayIso) && cycle.dueDate < todayIso;

/** The people a cycle covers, out of the company's active people ([{ id, name, ... }]) */
function audienceFor(cycle, people) {
    if (cycle.audience !== 'chosen') return people.slice();
    const wanted = new Set(cycle.peopleIds || []);
    return people.filter((p) => wanted.has(p.id));
}

/** Chosen people who are not (or no longer) in the company's list */
const unknownPeople = (peopleIds, people) => { const known = new Set(people.map((p) => p.id)); return (peopleIds || []).filter((id) => !known.has(id)); };

const memberId = (cycleId, userId) => `${cycleId}_${userId}`;

/** The record made for each person when the cycle opens */
function newMember(cycleId, orgId, person, at) {
    return { orgId, cycleId, userId: person.id, name: person.name || null, employeeId: person.employeeId || null, self: null, peerIds: [], managerReviewId: null, managerDoneAt: null, createdAt: at };
}

/** A self review as the person writes it. submit: every question must be answered. */
function validateSelfReview(cycle, input, { submit = false } = {}) {
    const errors = []; const given = input && typeof input === 'object' ? input : {}; const answers = {};
    for (const q of cycle.selfQuestions || []) {
        const t = block(given[q.id], ANSWER_MAX);
        if (t) answers[q.id] = t; else if (submit) errors.push(`Please answer: ${q.text}`);
    }
    if (!errors.length && !Object.keys(answers).length) errors.push('Write something before saving');
    return { errors, value: errors.length ? null : { answers } };
}

/** What a manager or HR sees of a self review: nothing until the person has sent it */
function selfReviewFor(member, viewer) {
    const s = member.self || null;
    if (!s) return null;
    if (viewer !== 'self' && !s.submittedAt) return null;
    return { answers: s.answers || {}, savedAt: s.savedAt || null, submittedAt: s.submittedAt || null };
}

/**
 * The coworkers asked to give feedback about one person.
 * subjectId: the person reviewed. managerId: their manager. pickerId: who is choosing. knownIds: active people of the company.
 */
function validatePeers(cycle, { subjectId, managerId = null, pickerId = null, peerIds, knownIds = [] }) {
    const errors = [];
    if (!Array.isArray(peerIds)) return { errors: ['Send the list of coworkers to ask'], value: null };
    const ids = [...new Set(peerIds.map((x) => String(x || '').trim()).filter(Boolean))];
    const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
    const min = minAnswers(cycle);
    if (ids.includes(String(subjectId))) errors.push('A person cannot give coworker feedback about themselves');
    if (managerId && ids.includes(String(managerId))) errors.push('The person\'s manager writes the manager review and cannot also be asked as a coworker');
    if (pickerId && ids.includes(String(pickerId))) errors.push('You cannot ask yourself: you will be able to read the combined answers');
    if (ids.some((id) => !known.has(id))) errors.push('Some of the people chosen were not found or no longer work here');
    if (ids.length && ids.length < min) errors.push(`Ask at least ${min} coworkers. Fewer than ${min} answers are never shown, to keep them private.`);
    if (ids.length > MAX_PEERS) errors.push(`Ask at most ${MAX_PEERS} coworkers`);
    return { errors, value: errors.length ? null : ids };
}

/** Once enough answers are in to be read, the list of coworkers is final: adding one more would give that person's answer away */
const peersLocked = (cycle, answered) => answered >= minAnswers(cycle);

/** One coworker's answers. At least one question must be answered; the rating is optional. */
function validatePeerAnswer(cycle, input) {
    const errors = []; const b = input && typeof input === 'object' ? input : {}; const given = b.answers && typeof b.answers === 'object' ? b.answers : {}; const answers = {};
    for (const q of cycle.peerQuestions || []) { const t = block(given[q.id], PEER_ANSWER_MAX); if (t) answers[q.id] = t; }
    let rating = null;
    if (b.rating !== undefined && b.rating !== null && b.rating !== '') { const r = Number(b.rating); if (!Number.isInteger(r) || r < 1 || r > 5) errors.push('The rating must be a whole number from 1 to 5, or left empty'); else rating = r; }
    if (!errors.length && !Object.keys(answers).length) errors.push('Answer at least one question');
    return { errors, value: errors.length ? null : { answers, rating } };
}

/** The record that says "this coworker answered about this person" without saying what. One per coworker per person per cycle. */
const peerKey = (cycleId, subjectId, peerId) => crypto.createHash('sha256').update(`${cycleId}:${subjectId}:${peerId}`).digest('hex').slice(0, 40);

/**
 * Who may read the combined coworker feedback about a person.
 * viewer: 'hr' | 'manager' | 'reader' (the HR view) or 'self' (the person reviewed).
 */
function maySeePeerFeedback(cycle, viewer, answered) {
    if (!cycle.peerFeedback || answered < minAnswers(cycle)) return false;
    if (viewer === 'self') return Boolean(cycle.sharePeerFeedback) && cycle.status === 'closed';
    return viewer === 'hr' || viewer === 'manager' || viewer === 'reader';
}

/**
 * Combined coworker feedback about one person. answers: [{ answers: { p1: '...' }, rating }] (no giver ids).
 * Below the minimum, or when this viewer may not read it, only the counts come back.
 */
function combinePeerFeedback(cycle, answers, { asked = 0, viewer = 'hr' } = {}) {
    const min = minAnswers(cycle); const n = answers.length;
    const base = { asked, answered: n, minAnswers: min, needed: Math.max(0, min - n) };
    if (!maySeePeerFeedback(cycle, viewer, n)) return { ...base, hidden: true, rating: null, questions: [] };
    const ratings = answers.map((a) => a.rating).filter((r) => Number.isInteger(r));
    const questions = (cycle.peerQuestions || []).map((q) => {
        const comments = answers.map((a) => (a.answers || {})[q.id]).filter((v) => typeof v === 'string' && v.trim()).sort((a, b) => a.localeCompare(b));
        return { id: q.id, text: q.text, answered: comments.length, comments };
    });
    return { ...base, hidden: false, rating: ratings.length ? { count: ratings.length, average: Math.round((ratings.reduce((s, r) => s + r, 0) / ratings.length) * 10) / 10 } : null, questions };
}

/** Where the manager review stands. review: the linked review record, or null when there is none (or it was deleted). */
function managerReviewState(cycle, member, review) {
    if (!cycle.managerReview) return 'not_asked';
    if (!review) return 'not_started';
    if (review.status && review.status !== 'draft') return 'shared';
    return member.managerDoneAt ? 'finished' : 'draft';
}

/** One person's progress in a cycle */
function memberProgress(cycle, member, { peerAnswers = 0, review = null } = {}) {
    const s = member.self || null; const asked = (member.peerIds || []).length; const min = minAnswers(cycle);
    return {
        self: !cycle.selfReview ? 'not_asked' : s && s.submittedAt ? 'done' : s && s.savedAt ? 'draft' : 'not_started',
        manager: managerReviewState(cycle, member, review),
        peers: !cycle.peerFeedback ? 'not_asked' : !asked && !peerAnswers ? 'not_chosen' : peerAnswers >= min ? 'enough' : 'waiting',
        peersAsked: asked, peersAnswered: peerAnswers, peersNeeded: cycle.peerFeedback ? Math.max(0, min - peerAnswers) : 0
    };
}

/** Totals for the cycle from each person's progress */
function cycleProgress(rows) {
    const count = (f) => rows.filter(f).length;
    return { people: rows.length,
        selfAsked: count((r) => r.self !== 'not_asked'), selfDone: count((r) => r.self === 'done'),
        managerAsked: count((r) => r.manager !== 'not_asked'), managerDone: count((r) => r.manager === 'finished' || r.manager === 'shared'),
        peersAsked: count((r) => r.peers !== 'not_asked'), peersEnough: count((r) => r.peers === 'enough'), peerAnswers: rows.reduce((s, r) => s + (r.peersAnswered || 0), 0) };
}

/**
 * Manager reviews that closing the cycle shares with the employee: the ones the manager marked as finished,
 * still a draft, and complete enough to share. Returns { share: [reviewId], notReady: [userId] }.
 */
function reviewsToShareOnClose(cycle, members, reviewsById) {
    const share = []; const notReady = [];
    if (!cycle.managerReview) return { share, notReady };
    for (const m of members) {
        const r = m.managerReviewId ? reviewsById[m.managerReviewId] : null;
        if (r && r.status && r.status !== 'draft') continue; // already shared by the manager
        if (r && m.managerDoneAt && readyToShare(r).ok) share.push(m.managerReviewId); else notReady.push(m.userId);
    }
    return { share, notReady };
}

/** The members of a cycle this viewer may see: everyone for HR, only direct reports for a manager, never the viewer themself */
function visibleMembers(members, peopleById, { viewerId, companyWide = false, manager = false } = {}) {
    const get = (id) => (peopleById instanceof Map ? peopleById.get(id) : peopleById[id]);
    return members.filter((m) => {
        if (companyWide) return true;
        if (m.userId === viewerId) return false;
        const p = get(m.userId);
        return manager && Boolean(p) && p.managerId === viewerId;
    });
}

module.exports = { STATUSES, AUDIENCES, PEER_MIN_FLOOR, PEER_MIN_DEFAULT, MAX_PEERS, MAX_QUESTIONS, MAX_PEOPLE, ANSWER_MAX, PEER_ANSWER_MAX, DEFAULT_SELF_QUESTIONS, DEFAULT_PEER_QUESTIONS, NOTE_HR, NOTE_PRIVACY,
    validateCycle, minAnswers, cycleChangeError, isLate, audienceFor, unknownPeople, memberId, newMember, validateSelfReview, selfReviewFor, validatePeers, peersLocked, validatePeerAnswer, peerKey,
    maySeePeerFeedback, combinePeerFeedback, managerReviewState, memberProgress, cycleProgress, reviewsToShareOnClose, visibleMembers };
