/**
 * E-Verify case tracking rules (pure). The company decides whether it uses E-Verify. The deadline to
 * create a case is 3 business days after the hire date; the other day counts are data-driven defaults
 * that follow the E-Verify rules as commonly described: confirm them in your E-Verify MOU and user guide.
 */
const { addBusinessDays, parseIsoDate } = require('./us-forms');

const STATUSES = ['initial', 'employment_authorized', 'tentative_nonconfirmation', 'referred', 'final_nonconfirmation', 'closed'];
const DEFAULT_SETTINGS = { used: false, createCaseBusinessDays: 3, tncDecisionBusinessDays: 8, tncReferralBusinessDays: 10 };
const TRANSITIONS = {
    initial: ['employment_authorized', 'tentative_nonconfirmation', 'closed'],
    tentative_nonconfirmation: ['referred', 'final_nonconfirmation', 'employment_authorized', 'closed'],
    referred: ['employment_authorized', 'final_nonconfirmation', 'closed'],
    employment_authorized: ['closed'], final_nonconfirmation: ['closed'], closed: []
};

function validateSettings(input) {
    const errors = [];
    const b = input || {};
    const value = { used: b.used === true };
    for (const k of ['createCaseBusinessDays', 'tncDecisionBusinessDays', 'tncReferralBusinessDays']) {
        const n = b[k] === undefined ? DEFAULT_SETTINGS[k] : Number(b[k]);
        if (!Number.isInteger(n) || n < 1 || n > 30) errors.push(`${k} must be a whole number from 1 to 30`); else value[k] = n;
    }
    return { errors, value: errors.length ? null : value };
}

const caseDueDate = (hireDate, settings, options) => addBusinessDays(hireDate, (settings || DEFAULT_SETTINGS).createCaseBusinessDays, options);

function validateCase(input, todayIso) {
    const errors = [];
    const b = input || {};
    const caseNumber = String(b.caseNumber || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 30);
    if (caseNumber.length < 6) errors.push('caseNumber must have at least 6 letters or digits');
    const createdDate = b.createdDate || todayIso;
    if (!parseIsoDate(createdDate)) errors.push('createdDate must be YYYY-MM-DD');
    else if (createdDate > todayIso) errors.push('createdDate cannot be in the future');
    if (errors.length) return { errors, value: null };
    return { errors, value: { caseNumber, createdDate, photoMatchRequired: b.photoMatchRequired === true, notes: String(b.notes || '').replace(/[<>]/g, '').slice(0, 300) } };
}

/** Move a case to a new status. Returns { error } or { patch } with TNC dates worked out. */
function transition(c, to, input, settings, todayIso, nowIso, by) {
    if (!STATUSES.includes(to)) return { error: 'Unknown status' };
    if (!(TRANSITIONS[c.status] || []).includes(to)) return { error: `A case in "${c.status}" cannot move to "${to}"` };
    const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    const patch = { status: to, history: [...(c.history || []), { at: nowIso, from: c.status, to, by: by || null }] };
    if (to === 'tentative_nonconfirmation') {
        patch.tnc = { notifiedOn: todayIso, decisionDue: addBusinessDays(todayIso, s.tncDecisionBusinessDays), employeeDecision: null, referredOn: null, referralDue: null, photoMatch: false };
    }
    if (to === 'referred') {
        const decision = input && input.employeeDecision;
        if (decision !== 'contest') return { error: 'A case can only be referred when the employee chose to contest (employeeDecision: contest)' };
        patch.tnc = { ...(c.tnc || {}), employeeDecision: 'contest', referredOn: todayIso, referralDue: addBusinessDays(todayIso, s.tncReferralBusinessDays) };
    }
    if (to === 'closed') patch.closedOn = todayIso;
    if (input && input.photoMatch !== undefined && (patch.tnc || c.tnc)) patch.tnc = { ...(patch.tnc || c.tnc), photoMatch: input.photoMatch === true };
    return { patch };
}

/** Flags on one case */
function caseFlags(c, todayIso) {
    const flags = [];
    if (c.status === 'initial' && c.dueDate && todayIso > c.dueDate && c.createdDate > c.dueDate) flags.push('case_created_late');
    if (c.status === 'tentative_nonconfirmation' && c.tnc && todayIso > c.tnc.decisionDue) flags.push('tnc_decision_overdue');
    if (c.status === 'referred' && c.tnc && c.tnc.referralDue && todayIso > c.tnc.referralDue) flags.push('referral_resolution_overdue');
    if (c.status === 'final_nonconfirmation') flags.push('action_needed_final_nonconfirmation');
    if (c.photoMatchRequired && c.status === 'initial') flags.push('photo_matching_required');
    return flags;
}

/** People hired who have no case yet. hires: [{ userId, name, hireDate }]; caseUserIds: Set */
function missingCases(hires, caseUserIds, settings, todayIso, options) {
    return hires.filter((h) => !caseUserIds.has(h.userId) && parseIsoDate(h.hireDate)).map((h) => {
        const dueDate = caseDueDate(h.hireDate, settings, options);
        return { ...h, dueDate, overdue: todayIso > dueDate };
    }).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

module.exports = { STATUSES, DEFAULT_SETTINGS, TRANSITIONS, validateSettings, caseDueDate, validateCase, transition, caseFlags, missingCases };
