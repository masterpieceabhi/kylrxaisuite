/**
 * Recruiting / applicant tracking rules (pure, no I/O).
 * Requisitions, public applications, resume checks, pipeline stages, interviewer scorecards,
 * duplicate detection, applicant EEO aggregation and the pipeline funnel.
 * Confirm hiring and EEO practices with a US compliance advisor.
 */
const eeo = require('./eeo-rules');

const STAGES = ['applied', 'screen', 'interview', 'assessment', 'offer', 'hired', 'rejected', 'withdrawn'];
const OPEN_STAGES = ['applied', 'screen', 'interview', 'assessment', 'offer'];
const TERMINAL_STAGES = ['hired', 'rejected', 'withdrawn'];
const REQ_STATUSES = ['draft', 'open', 'on_hold', 'filled', 'closed'];
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'temporary', 'contract', 'seasonal', 'intern'];
const SOURCES = ['careers_page', 'referral', 'job_board', 'agency', 'social', 'walk_in', 'other'];
const PAY_UNITS = ['hour', 'year'];
const RECOMMENDATIONS = ['strong_yes', 'yes', 'no', 'strong_no'];
const DEFAULT_COMPETENCIES = ['Role knowledge', 'Communication', 'Problem solving', 'Teamwork', 'Reliability'];
const MAX_RESUME_BYTES = 5 * 1024 * 1024;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanBlock = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s)) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }

/** Which stage moves are allowed. Forward through the funnel, back one step, or out (rejected / withdrawn). */
function canMoveStage(from, to) {
    if (!STAGES.includes(from) || !STAGES.includes(to)) return { ok: false, reason: 'Unknown stage' };
    if (from === to) return { ok: false, reason: 'The candidate is already in that stage' };
    if (from === 'hired') return { ok: false, reason: 'A hired candidate cannot be moved' };
    if (TERMINAL_STAGES.includes(from)) {
        if (to === 'applied' || to === 'screen') return { ok: true }; // reopen a rejected / withdrawn candidate
        return { ok: false, reason: 'Reopen the candidate to Applied or Screen first' };
    }
    if (to === 'hired') return from === 'offer' ? { ok: true } : { ok: false, reason: 'Only a candidate with an offer can be hired' };
    return { ok: true };
}

/** Hiring managers may run the interview stages for their own requisitions; offers, hires and rejections are HR's. */
const MANAGER_STAGES = ['screen', 'interview', 'assessment'];
const managerMayMove = (to) => MANAGER_STAGES.includes(to);

function validateRequisition(input, { partial = false } = {}) {
    const errors = [];
    const b = input || {};
    const value = {};
    const need = (field, label) => { if (!partial || b[field] !== undefined) { const v = clean(b[field], 120); if (!v) errors.push(`${label || field} is required`); else value[field] = v; } };
    need('title', 'title'); need('department', 'department'); need('location', 'location');
    if (!partial || b.employmentType !== undefined) {
        if (!EMPLOYMENT_TYPES.includes(b.employmentType)) errors.push(`employmentType must be one of: ${EMPLOYMENT_TYPES.join(', ')}`); else value.employmentType = b.employmentType;
    }
    if (!partial || b.headcount !== undefined) {
        const h = Number(b.headcount === undefined ? 1 : b.headcount);
        if (!Number.isInteger(h) || h < 1 || h > 500) errors.push('headcount must be a whole number from 1 to 500'); else value.headcount = h;
    }
    if (b.payMin !== undefined || b.payMax !== undefined || b.payUnit !== undefined || !partial) {
        const min = b.payMin === undefined || b.payMin === '' ? null : Number(b.payMin);
        const max = b.payMax === undefined || b.payMax === '' ? null : Number(b.payMax);
        if ((min !== null && (!Number.isFinite(min) || min < 0)) || (max !== null && (!Number.isFinite(max) || max < 0))) errors.push('payMin and payMax must be positive numbers');
        else if (min !== null && max !== null && max < min) errors.push('payMax cannot be less than payMin');
        else { value.payMin = min; value.payMax = max; }
        if (b.payUnit !== undefined && !PAY_UNITS.includes(b.payUnit)) errors.push('payUnit must be hour or year'); else value.payUnit = b.payUnit || 'hour';
    }
    if (b.description !== undefined) value.description = cleanBlock(b.description, 5000);
    if (b.state !== undefined) { const s = String(b.state || '').trim().toUpperCase(); if (s && !/^[A-Z]{2}$/.test(s)) errors.push('state must be a 2-letter code'); else value.state = s || null; }
    if (b.hiringManagerId !== undefined) value.hiringManagerId = clean(b.hiringManagerId, 128) || null;
    if (b.approverIds !== undefined) {
        const ids = Array.isArray(b.approverIds) ? [...new Set(b.approverIds.map((x) => clean(x, 128)).filter(Boolean))] : [];
        if (ids.length > 5) errors.push('At most 5 approvers'); else value.approverIds = ids;
    }
    if (b.competencies !== undefined) {
        const c = Array.isArray(b.competencies) ? b.competencies.map((x) => clean(x, 60)).filter(Boolean) : [];
        if (c.length < 1 || c.length > 12) errors.push('competencies needs 1 to 12 entries'); else value.competencies = [...new Set(c)];
    }
    if (b.targetStartDate !== undefined && b.targetStartDate) { if (!isDate(b.targetStartDate)) errors.push('targetStartDate must be YYYY-MM-DD'); else value.targetStartDate = b.targetStartDate; }
    if (b.status !== undefined && !partial) { if (!REQ_STATUSES.includes(b.status)) errors.push('status is not valid'); else value.status = b.status; }
    return { errors, value: errors.length ? null : value };
}

/** Status changes: opening needs every named approver to have approved */
function canSetRequisitionStatus(req, to) {
    if (!REQ_STATUSES.includes(to)) return { ok: false, reason: 'Unknown status' };
    if (req.status === to) return { ok: false, reason: `Already ${to}` };
    if (to === 'open') {
        const pending = (req.approvals || []).filter((a) => a.decision !== 'approved');
        if (pending.length) return { ok: false, reason: 'Waiting for approval from: ' + pending.map((a) => a.name || a.userId).join(', ') };
    }
    if (to === 'filled' && req.status === 'draft') return { ok: false, reason: 'Open the requisition before marking it filled' };
    return { ok: true };
}

function pickPublicJob(r) {
    return {
        id: r.id, title: r.title, department: r.department, location: r.location, employmentType: r.employmentType, description: r.description || '',
        payMin: r.payMin == null ? null : r.payMin, payMax: r.payMax == null ? null : r.payMax, payUnit: r.payUnit || 'hour', postedAt: r.openedAt || r.createdAt
    };
}

/** Public application fields (resume validated separately) */
function validateApplication(input) {
    const errors = [];
    const b = input || {};
    const name = clean(b.name, 100);
    const parts = name.split(' ').filter(Boolean);
    if (parts.length < 2) errors.push('Enter your first and last name');
    const email = normalizeEmail(b.email);
    if (!EMAIL.test(email) || email.length > 160) errors.push('Enter a valid email address');
    const phone = clean(b.phone, 30);
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) errors.push('Enter a phone number with at least 10 digits');
    if (b.privacyAccepted !== true && b.privacyAccepted !== 'true') errors.push('Please confirm you have read the applicant privacy notice');
    const source = SOURCES.includes(b.source) ? b.source : 'careers_page';
    if (errors.length) return { errors, value: null };
    return { errors, value: { name, firstName: parts[0], lastName: parts.slice(1).join(' '), email, phone, source } };
}

const isHoneypotTripped = (b) => Boolean(b && String(b.website || b.company_url || '').trim());

/** What the first bytes say the file is: only PDF and DOCX resumes are accepted */
function validateResume(file) {
    if (!file || !file.buffer || !file.buffer.length) return { errors: ['Attach your resume (PDF or DOCX)'], value: null };
    const buf = file.buffer;
    if (buf.length > MAX_RESUME_BYTES) return { errors: ['The resume is larger than 5 MB'], value: null };
    const ext = String(file.originalname || '').split('.').pop().toLowerCase();
    let kind = null;
    if (buf.slice(0, 5).toString('latin1') === '%PDF-') kind = 'pdf';
    else if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04 && buf.includes(Buffer.from('word/')) && buf.includes(Buffer.from('[Content_Types].xml'))) kind = 'docx';
    if (!kind) return { errors: ['Only PDF or DOCX resumes are accepted'], value: null };
    if (ext !== kind) return { errors: [`The file name ends in .${ext} but the content is a ${kind.toUpperCase()}`], value: null };
    return {
        errors: [], value: {
            kind, mime: kind === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            fileName: String(file.originalname || `resume.${kind}`).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100), size: buf.length
        }
    };
}

/** Pipeline stage history helpers */
function addStageHistory(history, stage, atIso, by, note) {
    const h = Array.isArray(history) ? history.map((x) => ({ ...x })) : [];
    const last = h[h.length - 1];
    if (last && !last.leftAt) last.leftAt = atIso;
    h.push({ stage, enteredAt: atIso, leftAt: null, by: by || null, note: note ? clean(note, 300) : null });
    return h;
}

function validateScorecard(input, competencies) {
    const errors = [];
    const b = input || {};
    const comps = competencies && competencies.length ? competencies : DEFAULT_COMPETENCIES;
    const ratings = [];
    const given = b.ratings && typeof b.ratings === 'object' ? b.ratings : {};
    for (const c of comps) {
        const r = Number(given[c]);
        if (!Number.isInteger(r) || r < 1 || r > 5) errors.push(`Rate "${c}" from 1 to 5`);
        else ratings.push({ competency: c, rating: r, comment: clean((b.comments || {})[c], 300) });
    }
    if (!RECOMMENDATIONS.includes(b.recommendation)) errors.push(`recommendation must be one of: ${RECOMMENDATIONS.join(', ')}`);
    const round = clean(b.round || 'interview', 40);
    if (errors.length) return { errors, value: null };
    const average = Math.round((ratings.reduce((s, x) => s + x.rating, 0) / ratings.length) * 100) / 100;
    return { errors, value: { round, ratings, average, recommendation: b.recommendation, notes: cleanBlock(b.notes, 2000) } };
}

function validateInterview(input) {
    const errors = [];
    const b = input || {};
    const when = String(b.when || '');
    if (!when || Number.isNaN(Date.parse(when))) errors.push('when must be a date and time');
    const interviewers = Array.isArray(b.interviewers) ? b.interviewers.map((x) => clean(x, 80)).filter(Boolean).slice(0, 8) : [];
    if (!interviewers.length) errors.push('Name at least one interviewer');
    if (errors.length) return { errors, value: null };
    return { errors, value: { when: new Date(when).toISOString(), interviewers, location: clean(b.location, 160), kind: clean(b.kind || 'interview', 40), notes: cleanBlock(b.notes, 1000) } };
}

function validateOffer(input) {
    const errors = [];
    const b = input || {};
    const payRate = Number(b.payRate);
    if (!Number.isFinite(payRate) || payRate <= 0) errors.push('payRate must be a positive number');
    if (!PAY_UNITS.includes(b.payUnit)) errors.push('payUnit must be hour or year');
    if (!isDate(b.startDate)) errors.push('startDate must be YYYY-MM-DD');
    const jobTitle = clean(b.jobTitle, 120);
    if (!jobTitle) errors.push('jobTitle is required');
    if (errors.length) return { errors, value: null };
    return { errors, value: { payRate, payUnit: b.payUnit, startDate: b.startDate, jobTitle, notes: cleanBlock(b.notes, 500) } };
}

/** Possible duplicates: same email (case-insensitive) in the same company */
function findDuplicates(candidates, email, excludeId) {
    const e = normalizeEmail(email);
    return candidates.filter((c) => c.id !== excludeId && normalizeEmail(c.email) === e);
}

const daysBetween = (aIso, bIso) => Math.max(0, (Date.parse(bIso) - Date.parse(aIso)) / 86400000);

/**
 * Funnel report. candidates: [{ stage, source, requisitionId, stageHistory }]
 * Returns counts now per stage, how many ever reached each stage, average days spent per stage and counts by source.
 */
function funnel(candidates, nowIso) {
    const current = Object.fromEntries(STAGES.map((s) => [s, 0]));
    const reached = Object.fromEntries(STAGES.map((s) => [s, 0]));
    const spent = Object.fromEntries(STAGES.map((s) => [s, []]));
    const bySource = {};
    for (const c of candidates) {
        if (current[c.stage] !== undefined) current[c.stage] += 1;
        const seen = new Set();
        for (const h of c.stageHistory || []) {
            seen.add(h.stage);
            spent[h.stage] && spent[h.stage].push(daysBetween(h.enteredAt, h.leftAt || nowIso));
        }
        for (const s of seen) reached[s] += 1;
        const src = c.source || 'other';
        bySource[src] = bySource[src] || { applied: 0, hired: 0, rejected: 0 };
        bySource[src].applied += 1;
        if (c.stage === 'hired') bySource[src].hired += 1;
        if (c.stage === 'rejected') bySource[src].rejected += 1;
    }
    const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
    const timeInStageDays = Object.fromEntries(OPEN_STAGES.map((s) => [s, avg(spent[s])]));
    const conversion = {};
    OPEN_STAGES.concat('hired').forEach((s, i, arr) => { if (i > 0) conversion[`${arr[i - 1]}_to_${s}`] = reached[arr[i - 1]] ? Math.round((reached[s] / reached[arr[i - 1]]) * 100) : null; });
    return { total: candidates.length, current, reached, timeInStageDays, conversionPercent: conversion, bySource };
}

/** Applicant EEO answers are stored without any link to a person; only totals are shown. Small groups are suppressed. */
const MIN_CELL = 5;
function aggregateApplicantEeo(records) {
    const total = records.length;
    if (total < MIN_CELL) return { total, suppressed: true, note: `Fewer than ${MIN_CELL} voluntary responses, so no breakdown is shown.` };
    const tally = (pick) => { const out = {}; for (const r of records) { const k = pick(r) || 'not_reported'; out[k] = (out[k] || 0) + 1; } return out; };
    return {
        total, suppressed: false,
        sex: tally((r) => r.sex), raceEthnicity: tally((r) => eeo.raceColumn(r)), veteran: tally((r) => r.veteran), disability: tally((r) => r.disability)
    };
}

/** In-memory per-key sliding window limiter. check() returns { ok, retryAfterSec } */
function createLimiter({ max, windowMs }) {
    const hits = new Map();
    return {
        check(key, now = Date.now()) {
            const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
            if (list.length >= max) { hits.set(key, list); return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - list[0])) / 1000)) }; }
            list.push(now); hits.set(key, list);
            if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
            return { ok: true, retryAfterSec: 0 };
        },
        reset() { hits.clear(); }
    };
}

const PRIVACY_NOTICE = {
    en: 'We collect your name, contact details, resume and any answers you give so we can consider you for employment. Only our hiring team can see them. Equal employment (EEO) answers are optional, never affect your application and are stored separately and only reported as totals. Ask us to correct or delete your information at any time.',
    es: 'Recopilamos su nombre, datos de contacto, currículum y las respuestas que usted indique para considerarlo para un empleo. Solo nuestro equipo de contratación puede verlos. Las respuestas de igualdad de oportunidades (EEO) son opcionales, no afectan su solicitud, se guardan por separado y solo se informan como totales. Puede pedirnos corregir o eliminar su información en cualquier momento.'
};

module.exports = {
    STAGES, OPEN_STAGES, TERMINAL_STAGES, REQ_STATUSES, EMPLOYMENT_TYPES, SOURCES, PAY_UNITS, RECOMMENDATIONS, DEFAULT_COMPETENCIES, MAX_RESUME_BYTES, MANAGER_STAGES, PRIVACY_NOTICE,
    normalizeEmail, canMoveStage, managerMayMove, validateRequisition, canSetRequisitionStatus, pickPublicJob, validateApplication, isHoneypotTripped, validateResume,
    addStageHistory, validateScorecard, validateInterview, validateOffer, findDuplicates, funnel, aggregateApplicantEeo, createLimiter, clean, cleanBlock, isDate, MIN_CELL
};
