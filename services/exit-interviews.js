/**
 * Exit interviews: storage for the rules in exit-interview-rules.js.
 *   exit_interview_settings/{orgId}              the company's question list
 *   exit_interviews/{userId}_{lastDay}           one record per departure (a person who is rehired and leaves again gets a new one)
 * Every document has orgId and every read checks it. Answers are never written to the audit log.
 */
const { rawCollection } = require('../config/firebase');
const R = require('./exit-interview-rules');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const nowIso = () => new Date().toISOString();
const PEOPLE = ['users', 'employees'];
const recRef = (userId, lastDay) => rawCollection('exit_interviews').doc(`${userId}_${lastDay}`);

async function getQuestions(orgId) {
    const s = await rawCollection('exit_interview_settings').doc(orgId).get();
    const stored = exists(s) && s.data().orgId === orgId ? s.data() : null;
    return { questions: R.questionsFor(stored), customised: Boolean(stored && stored.questions && stored.questions.length), updatedAt: stored ? stored.updatedAt : null };
}

async function saveQuestions(orgId, input, actor) {
    const { errors, value } = R.validateQuestions(input);
    if (errors.length) return { errors };
    await rawCollection('exit_interview_settings').doc(orgId).set({ orgId, questions: value, updatedAt: nowIso(), updatedBy: actor || null });
    return { questions: value };
}

async function resetQuestions(orgId) {
    await rawCollection('exit_interview_settings').doc(orgId).delete();
    return { questions: R.questionsFor(null) };
}

async function getRecord(orgId, userId, lastDay) {
    if (!lastDay) return null;
    const s = await recRef(userId, lastDay).get();
    return exists(s) && s.data().orgId === orgId ? s.data() : null;
}

/** The leaver's own view. `person` is their stored record. */
async function selfView(orgId, userId, person, todayIso) {
    const window = R.windowFor(person, todayIso);
    const [{ questions }, record] = await Promise.all([getQuestions(orgId), getRecord(orgId, userId, window.lastDay)]);
    return R.selfView({ window, questions, record });
}

/** The leaver saves their answers. Returns { view } | { conflict } | { errors } */
async function saveSelf(orgId, userId, person, input, todayIso) {
    const window = R.windowFor(person, todayIso);
    if (window.status === 'not_leaving') return { conflict: 'There is no exit interview for you to fill in.' };
    if (window.status === 'closed') return { conflict: 'The exit interview closed on your last day.' };
    const { questions } = await getQuestions(orgId);
    const { errors, value } = R.validateAnswers(questions, input);
    if (errors.length) return { errors };
    const existing = await getRecord(orgId, userId, window.lastDay);
    const doc = R.buildRecord({ orgId, userId, person, lastDay: window.lastDay, terminationType: window.type, questions, answers: value, source: 'self', actor: userId, now: nowIso(), existing });
    await recRef(userId, window.lastDay).set(doc);
    return { view: R.selfView({ window, questions, record: doc }) };
}

/** HR records answers and/or notes from a conversation, at any time. Returns { record } | { conflict } | { errors } */
async function saveByHr(orgId, userId, person, body, actor) {
    const t = person && person.usProfile && person.usProfile.termination;
    if (!t || !t.lastDay) return { conflict: 'No termination is recorded for this person, so there is no exit interview.' };
    const { questions } = await getQuestions(orgId);
    const b = body || {};
    const existing = await getRecord(orgId, userId, t.lastDay);
    const notes = R.validateNotes(b.hrNotes);
    const ans = b.answers === undefined ? { errors: [], value: undefined } : R.validateAnswers(questions, b.answers, { partial: true });
    const errors = [...notes.errors, ...ans.errors];
    if (b.answers === undefined && b.hrNotes === undefined) errors.push('send answers, hrNotes, or both');
    if (errors.length) return { errors };
    const doc = R.buildRecord({ orgId, userId, person, lastDay: t.lastDay, terminationType: t.type, questions, answers: ans.value !== undefined ? ans.value : ((existing && existing.answers) || {}), source: ans.value !== undefined ? 'hr' : ((existing && existing.source) || 'hr'), actor, now: nowIso(), existing, hrNotes: notes.value });
    if (ans.value === undefined && existing) { doc.source = existing.source; doc.questionSnapshot = existing.questionSnapshot; doc.reason = existing.reason; doc.reasonLabel = existing.reasonLabel; }
    await recRef(userId, t.lastDay).set(doc);
    return { record: doc };
}

/** Everyone in the company with a recorded termination: [{ userId, employeeId, name, lastDay, type }] */
async function leavers(orgId) {
    const snaps = await Promise.all(PEOPLE.map((n) => rawCollection(n).where('orgId', '==', orgId).get()));
    const seen = new Set(); const out = [];
    for (const d of snaps.flatMap((s) => s.docs)) {
        const u = d.data(); const t = u.usProfile && u.usProfile.termination;
        if (!t || !t.lastDay || seen.has(d.id)) continue;
        seen.add(d.id);
        out.push({ userId: d.id, employeeId: u.employeeId || null, name: u.name || null, lastDay: t.lastDay, type: t.type || null });
    }
    return out;
}

async function records(orgId) {
    const snap = await rawCollection('exit_interviews').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => d.data());
}

/** HR's list for a date range (by last day), newest last day first. Past departures of rehired people are included from their records. */
async function list(orgId, from, to) {
    const [people, recs] = await Promise.all([leavers(orgId), records(orgId)]);
    const byKey = new Map(recs.map((r) => [`${r.userId}_${r.lastDay}`, r]));
    const rows = people.filter((p) => p.lastDay >= from && p.lastDay <= to).map((p) => R.listRow(p, byKey.get(`${p.userId}_${p.lastDay}`)));
    const current = new Set(people.map((p) => `${p.userId}_${p.lastDay}`));
    for (const r of recs) if (!current.has(`${r.userId}_${r.lastDay}`) && r.lastDay >= from && r.lastDay <= to) rows.push(R.listRow({ userId: r.userId, employeeId: r.employeeId, name: r.name, lastDay: r.lastDay, type: r.terminationType }, r));
    return rows.sort((a, b) => String(b.lastDay).localeCompare(String(a.lastDay)) || String(a.name).localeCompare(String(b.name)));
}

async function summary(orgId, from, to) {
    const [people, recs, { questions }] = await Promise.all([leavers(orgId), records(orgId), getQuestions(orgId)]);
    const current = new Set(people.map((p) => `${p.userId}_${p.lastDay}`));
    const past = recs.filter((r) => !current.has(`${r.userId}_${r.lastDay}`)).map((r) => ({ userId: r.userId, lastDay: r.lastDay, type: r.terminationType }));
    return R.summarize({ questions, leavers: [...people, ...past], responses: recs, from, to });
}

/** One person's interview for HR: the questions as they were asked, the answers, and HR's notes */
async function detail(orgId, userId, person) {
    const t = person && person.usProfile && person.usProfile.termination;
    if (!t || !t.lastDay) return null;
    const [{ questions }, record] = await Promise.all([getQuestions(orgId), getRecord(orgId, userId, t.lastDay)]);
    return {
        userId, name: (person && person.name) || null, employeeId: (person && person.employeeId) || null, lastDay: t.lastDay, type: t.type || null,
        answered: Boolean(record && Object.keys(record.answers || {}).length), source: record ? record.source : null, submittedAt: record ? record.submittedAt : null, updatedAt: record ? record.updatedAt : null,
        questions, answers: record ? record.answers : {}, hrNotes: record ? record.hrNotes || '' : '', reason: record ? record.reasonLabel : null
    };
}

module.exports = { getQuestions, saveQuestions, resetQuestions, getRecord, selfView, saveSelf, saveByHr, leavers, records, list, summary, detail };
