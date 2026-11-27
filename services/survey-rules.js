/**
 * Pulse surveys and eNPS for US companies (pure, no I/O).
 *
 * A survey is written by HR, opened, answered once by each person, and closed.
 * Answers are stored without the person's name. Results are shown only after answering has ended and enough people answered
 * (the survey's minimum, never below 3), per question as well as for the survey as a whole,
 * so one person's answer cannot be picked out.
 */
const crypto = require('crypto');
const { parseIsoDate } = require('./us-forms');

const QUESTION_TYPES = ['scale', 'enps', 'yesno', 'text'];
const STATUSES = ['draft', 'open', 'closed'];
const MIN_RESPONSES_FLOOR = 3;
const MIN_RESPONSES_DEFAULT = 5;
const MAX_QUESTIONS = 20;
const SCALE_LABELS = { 1: 'Strongly disagree', 2: 'Disagree', 3: 'Neither', 4: 'Agree', 5: 'Strongly agree' };
const NOTE_HR = 'Keep questions about work. Do not ask about health, family, religion, union activity or other protected personal matters. If unsure, confirm with a US employment advisor.';
const NOTE_PRIVACY = 'Answers are stored without names. Results appear only after the survey has closed and enough people have answered. This keeps answers private from people using this app; it is not a guarantee against someone with direct access to the database.';

const TEMPLATES = {
    pulse: {
        title: 'Quick pulse',
        intro: 'Five short questions about how work is going. It takes about a minute.',
        questions: [
            { type: 'scale', text: 'I know what is expected of me at work.' },
            { type: 'scale', text: 'I have the tools and training I need to do my job.' },
            { type: 'scale', text: 'My manager treats me with respect.' },
            { type: 'scale', text: 'My schedule works for me.' },
            { type: 'text', text: 'What is one thing we could do better?', required: false }
        ]
    },
    enps: {
        title: 'Would you recommend working here?',
        intro: 'One question, plus room for a comment.',
        questions: [
            { type: 'enps', text: 'How likely are you to recommend this company as a place to work?' },
            { type: 'text', text: 'What is the main reason for your score?', required: false }
        ]
    }
};

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);

/** A survey as HR writes it. Question ids are kept when valid so a saved draft keeps its ids. */
function validateSurvey(input) {
    const errors = []; const b = input || {}; const value = {};
    const title = clean(b.title, 120);
    if (title.length < 3) errors.push('Give the survey a title (at least 3 characters)'); else value.title = title;
    value.intro = block(b.intro, 600);
    if (b.closesOn === undefined || b.closesOn === null || b.closesOn === '') value.closesOn = null;
    else if (!parseIsoDate(b.closesOn)) errors.push('closesOn must be a real date (YYYY-MM-DD)');
    else value.closesOn = String(b.closesOn);
    if (b.minResponses === undefined || b.minResponses === null || b.minResponses === '') value.minResponses = MIN_RESPONSES_DEFAULT;
    else {
        const m = Number(b.minResponses);
        if (!Number.isInteger(m) || m < MIN_RESPONSES_FLOOR || m > 50) errors.push(`minResponses must be a whole number from ${MIN_RESPONSES_FLOOR} to 50`); else value.minResponses = m;
    }
    const list = Array.isArray(b.questions) ? b.questions : [];
    if (!list.length) errors.push('Add at least one question');
    if (list.length > MAX_QUESTIONS) errors.push(`A survey can have at most ${MAX_QUESTIONS} questions`);
    const used = new Set(); const questions = [];
    list.slice(0, MAX_QUESTIONS).forEach((raw, i) => {
        const q = raw || {};
        if (!QUESTION_TYPES.includes(q.type)) { errors.push(`Question ${i + 1}: type must be one of ${QUESTION_TYPES.join(', ')}`); return; }
        const text = clean(q.text, 200);
        if (text.length < 5) { errors.push(`Question ${i + 1}: write the question (at least 5 characters)`); return; }
        let id = typeof q.id === 'string' && /^q[0-9]{1,3}$/.test(q.id) && !used.has(q.id) ? q.id : null;
        if (!id) { let n = 1; while (used.has(`q${n}`) || list.some((o) => o && o.id === `q${n}`)) n += 1; id = `q${n}`; }
        used.add(id);
        questions.push({ id, type: q.type, text, required: q.required === undefined ? q.type !== 'text' : Boolean(q.required) });
    });
    value.questions = questions;
    if (!errors.length && !questions.some((q) => q.type !== 'text')) errors.push('Add at least one question that is not a comment box');
    return { errors, value: errors.length ? null : value };
}

/** One person's answers, checked against the survey's questions. Unknown keys are dropped. */
function validateAnswers(survey, input) {
    const errors = []; const given = input && typeof input === 'object' ? input : {}; const value = {};
    for (const q of survey.questions || []) {
        const raw = given[q.id];
        const empty = raw === undefined || raw === null || String(raw).trim() === '';
        if (empty) { if (q.required) errors.push(`Please answer: ${q.text}`); continue; }
        if (q.type === 'scale') { const n = Number(raw); if (!Number.isInteger(n) || n < 1 || n > 5) errors.push(`"${q.text}" needs a number from 1 to 5`); else value[q.id] = n; }
        else if (q.type === 'enps') { const n = Number(raw); if (!Number.isInteger(n) || n < 0 || n > 10) errors.push(`"${q.text}" needs a number from 0 to 10`); else value[q.id] = n; }
        else if (q.type === 'yesno') { if (raw !== 'yes' && raw !== 'no') errors.push(`"${q.text}" needs yes or no`); else value[q.id] = raw; }
        else { const t = block(raw, 1000); if (t) value[q.id] = t; }
    }
    if (!errors.length && !Object.keys(value).length) errors.push('Answer at least one question');
    return { errors, value: errors.length ? null : value };
}

/** Can people answer this survey today? (todayIso: the company's local date) */
const isAcceptingAnswers = (survey, todayIso) => survey.status === 'open' && (!survey.closesOn || todayIso <= survey.closesOn);

/** May this change be made? Returns null when allowed, or the reason it is not. */
function surveyChangeError(survey, action, todayIso) {
    if (action === 'edit' && survey.status !== 'draft') return 'A survey cannot be changed once it has been opened. Close it and write a new one.';
    if (action === 'delete' && survey.status !== 'draft') return 'Only a draft can be deleted';
    if (action === 'open') {
        if (survey.status !== 'draft') return survey.status === 'open' ? 'This survey is already open' : 'A closed survey cannot be opened again. Write a new one.';
        if (survey.closesOn && todayIso && survey.closesOn < todayIso) return 'The closing date has already passed. Change it first.';
    }
    if (action === 'close' && survey.status !== 'open') return 'Only an open survey can be closed';
    if (action === 'answer' && !isAcceptingAnswers(survey, todayIso)) return survey.status === 'draft' ? 'This survey is not open yet' : 'This survey is closed';
    return null;
}

/** eNPS from 0-10 scores: promoters 9-10, passives 7-8, detractors 0-6; score = % promoters minus % detractors */
function enps(scores) {
    const n = scores.length;
    const promoters = scores.filter((s) => s >= 9).length; const detractors = scores.filter((s) => s <= 6).length;
    return { count: n, promoters, passives: n - promoters - detractors, detractors, score: n ? Math.round(((promoters - detractors) / n) * 100) : null };
}

/**
 * Results for a survey. responses: [{ answers: { q1: 4, ... } }]. audience: how many people could answer.
 * accepting: people can still answer. Then, and below the survey's minimum, nothing but the count is returned;
 * a single question with too few answers is hidden too.
 * Comments come back in alphabetical order, so their order says nothing about who wrote them or when.
 */
function summarize(survey, responses, { audience = null, accepting = false } = {}) {
    const min = Math.max(MIN_RESPONSES_FLOOR, Number(survey.minResponses) || MIN_RESPONSES_DEFAULT);
    const n = responses.length;
    const base = { responses: n, audience, rate: audience ? Math.min(100, Math.round((n / audience) * 100)) : null, minResponses: min, stillOpen: Boolean(accepting) };
    // While answers are still coming in, only the count is given: comparing the results before and after
    // one more answer would give that person's answer away.
    if (accepting) return { ...base, hidden: true, needed: Math.max(0, min - n), questions: [] };
    if (n < min) return { ...base, hidden: true, needed: min - n, questions: [] };
    const questions = (survey.questions || []).map((q) => {
        const vals = responses.map((r) => (r.answers || {})[q.id]).filter((v) => v !== undefined && v !== null && v !== '');
        const out = { id: q.id, type: q.type, text: q.text, answered: vals.length };
        if (vals.length < min) return { ...out, hidden: true };
        if (q.type === 'scale') { const counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }; vals.forEach((v) => { counts[v] += 1; }); return { ...out, counts, average: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10, favorable: Math.round(((counts[4] + counts[5]) / vals.length) * 100) }; }
        if (q.type === 'enps') { const counts = {}; for (let i = 0; i <= 10; i += 1) counts[i] = 0; vals.forEach((v) => { counts[v] += 1; }); return { ...out, counts, ...enps(vals) }; }
        if (q.type === 'yesno') { const yes = vals.filter((v) => v === 'yes').length; return { ...out, yes, no: vals.length - yes, yesPercent: Math.round((yes / vals.length) * 100) }; }
        return { ...out, comments: vals.map(String).sort((a, b) => a.localeCompare(b)) };
    });
    return { ...base, hidden: false, questions };
}

/** The record that says "this person answered" without saying what. One per person per survey. */
const responderKey = (surveyId, userId) => crypto.createHash('sha256').update(`${surveyId}:${userId}`).digest('hex').slice(0, 40);

module.exports = { QUESTION_TYPES, STATUSES, MIN_RESPONSES_FLOOR, MIN_RESPONSES_DEFAULT, MAX_QUESTIONS, SCALE_LABELS, NOTE_HR, NOTE_PRIVACY, TEMPLATES, validateSurvey, validateAnswers, isAcceptingAnswers, surveyChangeError, enps, summarize, responderKey, clean, block };
