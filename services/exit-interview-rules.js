/**
 * Exit interview (pure rules).
 *   - a question list HR can edit, with defaults in English and Spanish
 *   - the person who is leaving can answer it themselves until their last day (and change answers until then)
 *   - HR can also record answers and notes from a conversation
 *   - only HR (super admin, HR admin) ever sees answers: never the manager
 *   - a summary of reasons for leaving across a date range
 */
const { canonicalRole } = require('./permissions');
const { parseIsoDate } = require('./us-forms');

const TYPES = ['reason', 'rating', 'yesno', 'text', 'choice'];
const MAX_QUESTIONS = 25;
const MAX_TEXT = 2000;

const REASONS = [
    { value: 'better_pay', label: { en: 'Better pay somewhere else', es: 'Mejor pago en otro lugar' } },
    { value: 'career_growth', label: { en: 'A chance to grow or learn more', es: 'Una oportunidad de crecer o aprender más' } },
    { value: 'manager', label: { en: 'My manager or supervisor', es: 'Mi gerente o supervisor' } },
    { value: 'schedule_workload', label: { en: 'Hours, schedule or workload', es: 'Horas, horario o carga de trabajo' } },
    { value: 'work_environment', label: { en: 'The workplace or the people', es: 'El ambiente de trabajo o las personas' } },
    { value: 'benefits', label: { en: 'Benefits', es: 'Beneficios' } },
    { value: 'job_fit', label: { en: 'The job was not what I expected', es: 'El trabajo no era lo que esperaba' } },
    { value: 'commute_relocation', label: { en: 'Moving away or the commute', es: 'Mudanza o el traslado al trabajo' } },
    { value: 'family_personal', label: { en: 'Family or personal reasons', es: 'Razones familiares o personales' } },
    { value: 'health', label: { en: 'Health', es: 'Salud' } },
    { value: 'school', label: { en: 'Going to school', es: 'Voy a estudiar' } },
    { value: 'retirement', label: { en: 'Retiring', es: 'Jubilación' } },
    { value: 'other', label: { en: 'Something else', es: 'Otra razón' } }
];

const DEFAULT_QUESTIONS = [
    { id: 'reason', type: 'reason', required: true, text: { en: 'What is the main reason you are leaving?', es: '¿Cuál es la razón principal por la que se va?' }, options: REASONS },
    { id: 'overall', type: 'rating', required: true, text: { en: 'Overall, how was working here? (1 = very bad, 5 = very good)', es: 'En general, ¿cómo fue trabajar aquí? (1 = muy mal, 5 = muy bien)' } },
    { id: 'manager_support', type: 'rating', required: false, text: { en: 'How well did your manager support you? (1 = not at all, 5 = very well)', es: '¿Qué tanto le apoyó su gerente? (1 = nada, 5 = mucho)' } },
    { id: 'liked', type: 'text', required: false, text: { en: 'What did you like most about working here?', es: '¿Qué fue lo que más le gustó de trabajar aquí?' } },
    { id: 'improve', type: 'text', required: false, text: { en: 'What is one thing we should change?', es: '¿Qué es una cosa que deberíamos cambiar?' } },
    { id: 'recommend', type: 'yesno', required: false, text: { en: 'Would you recommend us to a friend as a place to work?', es: '¿Nos recomendaría a un amigo como lugar de trabajo?' } },
    { id: 'return', type: 'yesno', required: false, text: { en: 'Would you think about working here again?', es: '¿Consideraría volver a trabajar aquí?' } },
    { id: 'anything_else', type: 'text', required: false, text: { en: 'Is there anything else you want HR to know?', es: '¿Hay algo más que quiera decirle a Recursos Humanos?' } }
];

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
const clone = (v) => JSON.parse(JSON.stringify(v));

/** Only HR sees exit-interview answers. A manager never does, whatever else they may see. */
const canViewAnswers = (user) => Boolean(user) && ['super_admin', 'hr_admin'].includes(canonicalRole(user.role));

/** The questions a company uses: its own list, or the defaults */
const questionsFor = (stored) => (stored && Array.isArray(stored.questions) && stored.questions.length ? stored.questions : clone(DEFAULT_QUESTIONS));

function cleanText(input, where, errors, { requiredEn = true } = {}) {
    const t = input && typeof input === 'object' ? input : { en: input };
    const en = String(t.en || '').trim(); const es = String(t.es || '').trim();
    if (requiredEn && en.length < 3) errors.push(`${where}: the English text is required (at least 3 characters)`);
    if (en.length > 300) errors.push(`${where}: the English text is too long (300 characters at most)`);
    if (es.length > 300) errors.push(`${where}: the Spanish text is too long (300 characters at most)`);
    return es ? { en, es } : { en };
}

/** Validates the list HR saves. Ids are kept when given (so old answers still line up) and made from the text otherwise. */
function validateQuestions(input) {
    const errors = []; const value = [];
    if (!Array.isArray(input)) return { errors: ['questions must be a list'], value };
    if (!input.length) return { errors: ['keep at least one question'], value };
    if (input.length > MAX_QUESTIONS) errors.push(`too many questions (${MAX_QUESTIONS} at most)`);
    const ids = new Set();
    input.slice(0, MAX_QUESTIONS).forEach((q, i) => {
        const at = `question ${i + 1}`;
        if (!q || typeof q !== 'object') { errors.push(`${at}: must be an object`); return; }
        if (!TYPES.includes(q.type)) { errors.push(`${at}: type must be one of ${TYPES.join(', ')}`); return; }
        const text = cleanText(q.text, at, errors);
        let id = q.id ? String(q.id) : slug(text.en);
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(id)) { if (q.id) { errors.push(`${at}: id may only use lower-case letters, digits and _`); return; } id = `q_${i + 1}`; }
        if (ids.has(id)) { if (q.id) { errors.push(`${at}: the id "${id}" is used twice`); return; } let n = 2; while (ids.has(`${id}_${n}`)) n += 1; id = `${id}_${n}`.slice(0, 40); }
        ids.add(id);
        const out = { id, type: q.type, required: q.required === true, text };
        if (q.type === 'choice' || q.type === 'reason') {
            const opts = Array.isArray(q.options) ? q.options : (q.type === 'reason' ? REASONS : []);
            if (opts.length < 2 || opts.length > 20) errors.push(`${at}: give 2 to 20 choices`);
            const seen = new Set();
            out.options = opts.slice(0, 20).map((o, j) => {
                const label = cleanText(o && o.label, `${at}, choice ${j + 1}`, errors);
                const v = o && o.value ? String(o.value) : slug(label.en);
                if (!/^[a-z0-9][a-z0-9_]{0,39}$/.test(v)) errors.push(`${at}, choice ${j + 1}: value may only use lower-case letters, digits and _`);
                else if (seen.has(v)) errors.push(`${at}: the choice "${v}" is listed twice`);
                seen.add(v);
                return { value: v, label };
            });
        }
        value.push(out);
    });
    const reasons = value.filter((q) => q.type === 'reason');
    if (reasons.length !== 1) errors.push('keep exactly one "reason for leaving" question: the summary of reasons is built from it');
    else if (!reasons[0].required) reasons[0].required = true; // always asked, or the summary would have holes
    return { errors, value };
}

/** Text in the person's language, falling back to English */
const textIn = (t, lang) => (t && (t[lang] || t.en)) || '';

/**
 * Where a person stands: 'not_leaving', 'open' (may answer: last day is today or later) or 'closed' (last day has passed).
 * A cancelled termination means not leaving.
 */
function windowFor(person, todayIso) {
    const t = person && person.usProfile && person.usProfile.termination;
    if (!t || !t.lastDay) return { status: 'not_leaving', lastDay: null };
    return { status: String(todayIso) <= t.lastDay ? 'open' : 'closed', lastDay: t.lastDay, type: t.type || null };
}

/** Validates answers against the question list. `partial` (HR notes from a conversation) skips the "required" check. */
function validateAnswers(questions, input, { partial = false } = {}) {
    const errors = []; const value = {};
    const a = input && typeof input === 'object' && !Array.isArray(input) ? input : null;
    if (!a) return { errors: ['answers must be an object keyed by question id'], value };
    const known = new Set(questions.map((q) => q.id));
    for (const k of Object.keys(a)) if (!known.has(k)) errors.push(`"${k}" is not one of the questions`);
    for (const q of questions) {
        const raw = a[q.id];
        const blank = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
        if (blank) { if (q.required && !partial) errors.push(`please answer: ${q.text.en}`); continue; }
        if (q.type === 'rating') { if (!Number.isInteger(raw) || raw < 1 || raw > 5) errors.push(`${q.text.en}: choose a number from 1 to 5`); else value[q.id] = raw; }
        else if (q.type === 'yesno') { if (typeof raw !== 'boolean') errors.push(`${q.text.en}: answer yes or no`); else value[q.id] = raw; }
        else if (q.type === 'text') { const s = String(raw).trim(); if (s.length > MAX_TEXT) errors.push(`${q.text.en}: the answer is too long (${MAX_TEXT} characters at most)`); else value[q.id] = s; }
        else { const v = String(raw); if (!(q.options || []).some((o) => o.value === v)) errors.push(`${q.text.en}: choose one of the listed answers`); else value[q.id] = v; }
    }
    return { errors, value };
}

function validateNotes(input) {
    if (input === undefined) return { errors: [], value: undefined };
    const s = String(input === null ? '' : input).trim();
    return s.length > 4000 ? { errors: ['notes can be at most 4,000 characters'], value: undefined } : { errors: [], value: s };
}

/** The reason answer of a response, with the label it had when it was saved */
function reasonOf(questions, answers) {
    const q = questions.find((x) => x.type === 'reason');
    if (!q || !answers || answers[q.id] === undefined) return null;
    const o = (q.options || []).find((x) => x.value === answers[q.id]);
    return { value: answers[q.id], label: o ? o.label.en : answers[q.id] };
}

/** The record stored for an interview. `existing` keeps the first submission time and HR notes. */
function buildRecord({ orgId, userId, person, lastDay, terminationType, questions, answers, source, actor, now, existing, hrNotes }) {
    const reason = reasonOf(questions, answers);
    return {
        orgId, userId, employeeId: (person && person.employeeId) || null, name: (person && person.name) || null,
        department: (person && (person.departmentName || person.department)) || null, managerId: (person && person.usProfile && person.usProfile.managerId) || null,
        lastDay, terminationType: terminationType || null, answers, reason: reason ? reason.value : null, reasonLabel: reason ? reason.label : null,
        questionSnapshot: questions.map((q) => ({ id: q.id, type: q.type, text: q.text.en })),
        // who gave the answers: 'self', 'hr' (recorded from a conversation), or 'self_and_hr' once both have saved
        source: !existing || !existing.source || existing.source === source ? source : 'self_and_hr',
        submittedAt: (existing && existing.submittedAt) || now, updatedAt: now, updatedBy: actor || null,
        hrNotes: hrNotes !== undefined ? hrNotes : ((existing && existing.hrNotes) || '')
    };
}

const isIsoDate = (s) => Boolean(parseIsoDate(s)); // a real calendar day: 2026-02-30 is refused

/** Date range for the list and the summary: defaults to the last 12 months up to today */
function validateRange(query, todayIso) {
    const q = query || {}; const errors = [];
    const to = q.to || todayIso;
    const d = new Date(`${todayIso}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() - 1); d.setUTCDate(d.getUTCDate() + 1);
    const from = q.from || d.toISOString().slice(0, 10);
    if (!isIsoDate(from)) errors.push('from must be a real date (YYYY-MM-DD)');
    if (!isIsoDate(to)) errors.push('to must be a real date (YYYY-MM-DD)');
    if (!errors.length && from > to) errors.push('from must be on or before to');
    return { errors, from, to };
}

const inRange = (day, from, to) => Boolean(day) && day >= from && day <= to;
const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Reasons for leaving across a date range (by last day).
 *   leavers:   [{ userId, lastDay, type }]   everyone whose last day is in the range
 *   responses: stored interview records
 * Returns counts per reason (largest first), the response rate, average ratings and yes/no totals.
 */
function summarize({ questions, leavers, responses, from, to }) {
    const people = (leavers || []).filter((l) => inRange(l.lastDay, from, to));
    const answered = (responses || []).filter((r) => inRange(r.lastDay, from, to) && r.answers && Object.keys(r.answers).length);
    const reasonQ = questions.find((q) => q.type === 'reason');
    const labels = new Map(((reasonQ && reasonQ.options) || []).map((o) => [o.value, o.label.en]));
    const counts = new Map();
    for (const r of answered) { if (!r.reason) continue; const c = counts.get(r.reason) || { reason: r.reason, label: labels.get(r.reason) || r.reasonLabel || r.reason, count: 0 }; c.count += 1; counts.set(r.reason, c); }
    const withReason = [...counts.values()].reduce((n, c) => n + c.count, 0);
    const reasons = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).map((c) => ({ ...c, percent: withReason ? round1((c.count / withReason) * 100) : 0 }));
    const ratings = questions.filter((q) => q.type === 'rating').map((q) => {
        const vals = answered.map((r) => r.answers[q.id]).filter((v) => Number.isInteger(v));
        return { id: q.id, text: q.text.en, answers: vals.length, average: vals.length ? round1(vals.reduce((s, v) => s + v, 0) / vals.length) : null };
    });
    const yesNo = questions.filter((q) => q.type === 'yesno').map((q) => {
        const vals = answered.map((r) => r.answers[q.id]).filter((v) => typeof v === 'boolean');
        return { id: q.id, text: q.text.en, yes: vals.filter(Boolean).length, no: vals.filter((v) => !v).length };
    });
    const byType = {};
    for (const p of people) byType[p.type || 'unknown'] = (byType[p.type || 'unknown'] || 0) + 1;
    return {
        from, to, leavers: people.length, responses: answered.length, responseRate: people.length ? round1((Math.min(answered.length, people.length) / people.length) * 100) : null,
        withoutAnswer: Math.max(0, people.length - answered.length), reasons, ratings, yesNo, byType
    };
}

/** Text that starts like a spreadsheet formula is prefixed, so opening the CSV can never run it */
const csvSafe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v);

/** Rows for the CSV download of the summary */
function summaryCsvRows(s) {
    const rows = [
        ...s.reasons.map((r) => ({ section: 'Reason for leaving', item: r.label, count: r.count, share: `${r.percent}%` })),
        { section: 'Totals', item: 'People who left in this period', count: s.leavers, share: '' },
        { section: 'Totals', item: 'Exit interviews answered', count: s.responses, share: s.responseRate === null ? '' : `${s.responseRate}%` },
        ...s.ratings.map((r) => ({ section: 'Average rating (1 to 5)', item: r.text, count: r.answers, share: r.average === null ? '' : String(r.average) })),
        ...s.yesNo.flatMap((y) => [{ section: 'Yes / no', item: `${y.text}: yes`, count: y.yes, share: '' }, { section: 'Yes / no', item: `${y.text}: no`, count: y.no, share: '' }])
    ];
    return rows.map((r) => ({ ...r, item: csvSafe(r.item) }));
}
const SUMMARY_COLUMNS = [{ key: 'section', label: 'Section' }, { key: 'item', label: 'Item' }, { key: 'count', label: 'Count' }, { key: 'share', label: 'Share or average' }];

/** What the leaver's own page gets: questions in both languages, no ids of other people, no HR notes */
function selfView({ window, questions, record }) {
    return {
        status: window.status, lastDay: window.lastDay,
        questions: window.status === 'not_leaving' ? [] : questions.map((q) => ({ id: q.id, type: q.type, required: q.required, text: { en: q.text.en, es: q.text.es || q.text.en }, ...(q.options ? { options: q.options.map((o) => ({ value: o.value, label: { en: o.label.en, es: o.label.es || o.label.en } })) } : {}) })),
        answers: (record && record.answers) || {}, submittedAt: (record && record.source !== 'hr' && record.submittedAt) || null, updatedAt: (record && record.updatedAt) || null
    };
}

/** Row for HR's list */
function listRow(leaver, record) {
    return {
        userId: leaver.userId, employeeId: leaver.employeeId || null, name: leaver.name || null, lastDay: leaver.lastDay, type: leaver.type || null,
        answered: Boolean(record && record.answers && Object.keys(record.answers).length), source: record ? record.source : null,
        reason: record ? record.reasonLabel : null, submittedAt: record ? record.submittedAt : null, hasNotes: Boolean(record && record.hrNotes)
    };
}

module.exports = {
    TYPES, REASONS, DEFAULT_QUESTIONS, MAX_QUESTIONS, MAX_TEXT, canViewAnswers, questionsFor, validateQuestions, textIn, windowFor, validateAnswers, validateNotes,
    reasonOf, buildRecord, validateRange, summarize, summaryCsvRows, SUMMARY_COLUMNS, selfView, listRow, slug
};
