/**
 * Background-check (FCRA) workflow rules (pure, no I/O).
 * Order is blocked until a standalone disclosure and the candidate's written authorization are recorded.
 * A "consider" result must go through a pre-adverse-action notice, a waiting period (data-driven,
 * default 5 business days, editable) and only then the adverse-action notice. A dispute pauses the process.
 * Only status and a report reference are stored here, never the report itself.
 * State and local "fair chance" rules also apply: confirm with a US compliance advisor.
 */
const { addBusinessDays } = require('./us-forms');

const DEFAULT_SETTINGS = { waitingBusinessDays: 5, packages: ['standard'] };
const RESULTS = ['clear', 'consider'];

function validateSettings(input) {
    const errors = [];
    const b = input || {};
    const days = Number(b.waitingBusinessDays);
    if (!Number.isInteger(days) || days < 1 || days > 30) errors.push('waitingBusinessDays must be a whole number from 1 to 30');
    if (errors.length) return { errors, value: null };
    return { errors, value: { waitingBusinessDays: days } };
}

const newCheck = (orgId, candidateId, nowIso, by) => ({
    orgId, candidateId, status: 'needs_authorization', disclosure: null, authorization: null, order: null, result: null, adverse: null, dispute: null,
    history: [{ at: nowIso, event: 'check_created', by: by || null }], createdAt: nowIso, createdBy: by || null
});

/** Where the check is right now, worked out from what has been recorded */
function statusOf(c) {
    if (!c.disclosure || !c.authorization) return 'needs_authorization';
    if (c.dispute && !c.dispute.resolvedAt) return 'disputed';
    if (c.adverse && c.adverse.finalSentAt) return 'adverse_action_final';
    if (c.adverse && c.adverse.preSentAt) return 'waiting_period';
    if (c.result && c.result.status === 'consider') return 'consider_review';
    if (c.result && c.result.status === 'clear') return 'clear';
    if (c.order && c.order.reference) return c.order.status === 'in_progress' ? 'in_progress' : 'ordered';
    return 'ready_to_order';
}

const hist = (c, nowIso, event, by, extra) => [...(c.history || []), { at: nowIso, event, by: by || null, ...(extra || {}) }];

function recordDisclosure(c, input, nowIso, by) {
    const b = input || {};
    if (b.standalone !== true) return { error: 'Confirm the disclosure was given as a standalone document (nothing else on the page)' };
    if (c.disclosure) return { error: 'The disclosure is already recorded' };
    return { patch: { disclosure: { providedAt: nowIso, standalone: true, version: String(b.version || 'v1').slice(0, 40), by: by || null }, history: hist(c, nowIso, 'disclosure_recorded', by) } };
}

function recordAuthorization(c, input, nowIso, by) {
    const b = input || {};
    if (!c.disclosure) return { error: 'Record the disclosure before the authorization' };
    if (c.authorization) return { error: 'The authorization is already recorded' };
    if (b.authorized !== true) return { error: 'Confirm the candidate gave written authorization' };
    const method = ['esign', 'paper'].includes(b.method) ? b.method : null;
    if (!method) return { error: 'method must be esign or paper' };
    return { patch: { authorization: { signedAt: nowIso, method, signRequestId: b.signRequestId ? String(b.signRequestId).slice(0, 80) : null, by: by || null }, history: hist(c, nowIso, 'authorization_recorded', by, { method }) } };
}

function canOrder(c) {
    if (!c.disclosure) return { ok: false, reason: 'Record the standalone disclosure first' };
    if (!c.authorization) return { ok: false, reason: 'Record the written authorization first' };
    if (c.order && c.order.reference) return { ok: false, reason: 'A report was already ordered' };
    return { ok: true };
}

function recordOrder(c, order, nowIso, by) {
    const ok = canOrder(c);
    if (!ok.ok) return { error: ok.reason };
    return { patch: { order: { orderedAt: nowIso, provider: order.provider, reference: order.reference, package: order.package || 'standard', status: order.status || 'in_progress' }, history: hist(c, nowIso, 'report_ordered', by, { provider: order.provider }) } };
}

function recordResult(c, result, nowIso, by) {
    if (!c.order || !c.order.reference) return { error: 'Order the report first' };
    if (c.result) return { error: 'A result is already recorded' };
    if (!RESULTS.includes(result.status)) return { error: 'result must be clear or consider' };
    return { patch: { order: { ...c.order, status: 'complete' }, result: { status: result.status, receivedAt: nowIso, reportReference: String(result.reportReference || c.order.reference).slice(0, 80) }, history: hist(c, nowIso, `result_${result.status}`, by) } };
}

function preAdverse(c, input, todayIso, settings, by, nowIso) {
    const b = input || {};
    const s = { ...DEFAULT_SETTINGS, ...(settings || {}) };
    if (!c.result || c.result.status !== 'consider') return { error: 'A pre-adverse-action notice is only for a "consider" result' };
    if (c.adverse && c.adverse.preSentAt) return { error: 'The pre-adverse-action notice was already sent' };
    if (b.reportCopyProvided !== true || b.summaryOfRightsProvided !== true) return { error: 'Confirm you sent the candidate a copy of the report and the summary of their rights' };
    const waitingUntil = addBusinessDays(todayIso, s.waitingBusinessDays);
    return { patch: { adverse: { preSentAt: nowIso, preSentBy: by || null, reportCopyProvided: true, summaryOfRightsProvided: true, waitingBusinessDays: s.waitingBusinessDays, waitingUntil, finalSentAt: null }, history: hist(c, nowIso, 'pre_adverse_sent', by, { waitingUntil }) } };
}

function canSendAdverse(c, todayIso) {
    if (!c.adverse || !c.adverse.preSentAt) return { ok: false, reason: 'Send the pre-adverse-action notice first' };
    if (c.adverse.finalSentAt) return { ok: false, reason: 'The adverse-action notice was already sent' };
    if (c.dispute && !c.dispute.resolvedAt) return { ok: false, reason: 'The candidate has an open dispute. Resolve it first' };
    if (todayIso < c.adverse.waitingUntil) return { ok: false, reason: `Wait until ${c.adverse.waitingUntil} before sending the adverse-action notice` };
    return { ok: true };
}

function sendAdverse(c, todayIso, by, nowIso) {
    const ok = canSendAdverse(c, todayIso);
    if (!ok.ok) return { error: ok.reason };
    return { patch: { adverse: { ...c.adverse, finalSentAt: nowIso, finalSentBy: by || null }, history: hist(c, nowIso, 'adverse_action_sent', by) } };
}

function openDispute(c, input, nowIso, by) {
    if (!c.result || c.result.status !== 'consider') return { error: 'There is nothing to dispute yet' };
    if (c.dispute && !c.dispute.resolvedAt) return { error: 'A dispute is already open' };
    const note = String((input && input.note) || '').replace(/[<>]/g, '').trim().slice(0, 500);
    if (note.length < 5) return { error: 'Describe the dispute (at least 5 characters)' };
    return { patch: { dispute: { openedAt: nowIso, note, resolvedAt: null, resolution: null, by: by || null }, history: hist(c, nowIso, 'dispute_opened', by) } };
}

function resolveDispute(c, input, nowIso, by) {
    if (!c.dispute || c.dispute.resolvedAt) return { error: 'There is no open dispute' };
    const resolution = input && input.resolution;
    if (!['corrected_clear', 'upheld'].includes(resolution)) return { error: 'resolution must be corrected_clear or upheld' };
    const patch = { dispute: { ...c.dispute, resolvedAt: nowIso, resolution, resolvedBy: by || null }, history: hist(c, nowIso, `dispute_${resolution}`, by) };
    if (resolution === 'corrected_clear') { patch.result = { ...c.result, status: 'clear', correctedAt: nowIso }; patch.adverse = null; }
    return { patch };
}

/** Summary for the screen (there is no report content stored, only status and a reference) */
function summarize(c, todayIso) {
    return {
        id: c.id, candidateId: c.candidateId, status: statusOf(c), disclosureAt: c.disclosure ? c.disclosure.providedAt : null,
        authorizationAt: c.authorization ? c.authorization.signedAt : null, provider: c.order ? c.order.provider : null,
        reportReference: c.result ? c.result.reportReference : (c.order ? c.order.reference : null), result: c.result ? c.result.status : null,
        preAdverseSentAt: c.adverse ? c.adverse.preSentAt : null, waitingUntil: c.adverse ? c.adverse.waitingUntil : null,
        adverseSentAt: c.adverse ? c.adverse.finalSentAt : null, dispute: c.dispute || null, history: c.history || [],
        canSendAdverse: canSendAdverse(c, todayIso).ok
    };
}

module.exports = { DEFAULT_SETTINGS, RESULTS, validateSettings, newCheck, statusOf, recordDisclosure, recordAuthorization, canOrder, recordOrder, recordResult, preAdverse, canSendAdverse, sendAdverse, openDispute, resolveDispute, summarize };
