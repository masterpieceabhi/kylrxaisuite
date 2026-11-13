/**
 * Payroll through Gusto: build the hours feed from APPROVED timesheet weeks, prepare the payroll in Gusto,
 * show a preview with blockers and the cutoff warning, submit only with an explicit human confirmation.
 *
 * Gusto does the calculations, tax filings and payments; we only hand over hours and read results back.
 * VERIFY against the sandbox: how hours are written (employee_compensations[].hourly_compensations names and
 * multipliers) is our best reading of the docs (see docs/GUSTO.md).
 */
const rules = require('./rules');
const sync = require('./sync');
const payResultsIo = require('./pay-results');
const { GustoError } = require('./client');

const nowIso = () => new Date().toISOString();
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const cid = (ctx) => { if (!ctx.conn || !ctx.conn.companyUuid) throw new GustoError('This company is not connected to Gusto', { status: 409, code: 'not_connected' }); return ctx.conn.companyUuid; };
const fail = (status, code, message, extra) => Object.assign(new GustoError(message, { status, code }), extra || {});

/* ------------------------------- hours feed ------------------------------- */

async function loadWeeks(ctx, start, end) {
    if (ctx.loadWeeks) return ctx.loadWeeks(ctx.orgId, start, end);
    const { rawCollection } = require('../../config/firebase');
    const snap = await rawCollection('timesheet_weeks').where('orgId', '==', ctx.orgId).get();
    const from = rules.addDays(start, -6);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((w) => w.weekStart >= from && w.weekStart <= end);
}
async function loadApprovedLeave(ctx, start, end) {
    const rows = ctx.loadLeave ? await ctx.loadLeave(ctx.orgId) : await (async () => {
        const { rawCollection } = require('../../config/firebase');
        const snap = await rawCollection('leave_requests').where('orgId', '==', ctx.orgId).get();
        return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    })();
    return rows.filter((r) => r.orgId === ctx.orgId && r.status === 'approved' && (r.dates || []).some((d) => d >= start && d <= end));
}

function checkPeriod(start, end) {
    if (!rules.parseIso(start) || !rules.parseIso(end)) throw fail(400, 'validation', 'start and end must be dates (YYYY-MM-DD)');
    if (end < start) throw fail(400, 'validation', 'The end of the pay period is before the start');
    if (Date.parse(end) - Date.parse(start) > 32 * 86400000) throw fail(400, 'validation', 'A pay period cannot be longer than 31 days');
}

/** The hours that would be sent to Gusto, with issues. No Gusto calls except none: reads our data only. */
async function buildFeed(ctx, start, end) {
    checkPeriod(start, end);
    const [people, weeks, leave, links] = await Promise.all([sync.loadPeople(ctx), loadWeeks(ctx, start, end), loadApprovedLeave(ctx, start, end), ctx.store.listLinks(ctx.orgId, 'employee')]);
    const linkMap = new Map(links.filter((l) => l.gustoUuid).map((l) => [l.ourId, l]));
    const feed = rules.buildHoursFeed({
        weeks: weeks.filter((w) => w.orgId === ctx.orgId), leave, periodStart: start, periodEnd: end,
        links: linkMap, people: people.filter((p) => p.classification === 'W2' || !p.classification).map((p) => ({ id: p.id, name: p.name, payType: p.payType, flsa: p.flsa, active: p.active }))
    });
    return { ...feed, hash: rules.feedHash(feed.rows), periodStart: start, periodEnd: end };
}

/* ------------------------------- finding and preparing ------------------------------- */

async function listPayrolls(ctx, { start, end, processed = false } = {}) {
    const c = cid(ctx);
    return ctx.client.paginate(`/v1/companies/${c}/payrolls`, { query: { processing_statuses: processed ? 'processed,unprocessed' : 'unprocessed', payroll_types: 'regular', start_date: start, end_date: end, include: 'totals' } });
}

async function findPayroll(ctx, start, end, { processed = false } = {}) {
    const list = await listPayrolls(ctx, { start: rules.addDays(start, -35), end: rules.addDays(end, 35), processed });
    const hit = list.find((p) => p.pay_period && p.pay_period.start_date === start && p.pay_period.end_date === end);
    if (!hit) {
        const near = list.slice(0, 6).map((p) => `${p.pay_period.start_date} to ${p.pay_period.end_date}`);
        throw fail(404, 'no_payroll_for_period', `Gusto has no regular payroll for ${start} to ${end}. Check the pay schedule.${near.length ? ` Gusto's pay periods: ${near.join('; ')}.` : ''}`, { periods: near });
    }
    return hit;
}

async function waitCalculated(ctx, payrollUuid, { timeoutMs = 30000, intervalMs = 250 } = {}) {
    const c = cid(ctx);
    const t0 = Date.now();
    for (;;) {
        const p = await ctx.client.get(`/v1/companies/${c}/payrolls/${payrollUuid}`);
        const st = p.processing_request && p.processing_request.status;
        if (st === 'calculate_success' && p.totals) return p;
        if (st && /fail|error/i.test(st)) throw fail(422, 'calculation_failed', 'Gusto could not calculate this payroll. Open it in Gusto to see why.');
        if (Date.now() - t0 > timeoutMs) throw fail(504, 'calculation_timeout', 'Gusto is still calculating. Check again in a minute.');
        await sleepMs(intervalMs);
    }
}

function summarize(payroll, feedRows) {
    const names = new Map(feedRows.map((r) => [r.employeeUuid, r.name]));
    return {
        totals: payroll.totals || null,
        employees: (payroll.employee_compensations || []).map((e) => ({ employeeUuid: e.employee_uuid, name: names.get(e.employee_uuid) || null, gross: e.gross_pay || null, net: e.net_pay || null, excluded: Boolean(e.excluded) }))
    };
}

function cutoffFor(ctx, payroll) {
    return rules.cutoffInfo({ nowIso: nowIso(), checkDate: payroll.check_date, gustoDeadlineIso: payroll.payroll_deadline, achBusinessDays: (ctx.opts && ctx.opts.achBusinessDays) || 4 });
}

/** Prepare in Gusto with our hours and calculate. Nothing is paid until submit. */
async function preparePayroll(ctx, { start, end, actor }) {
    const c = cid(ctx);
    const feed = await buildFeed(ctx, start, end);
    if (!feed.ready) throw fail(409, 'feed_blocked', 'Fix the blockers before preparing payroll.', { feed });
    if (!feed.rows.length) throw fail(409, 'feed_empty', 'There are no hours or people to send for this pay period.', { feed });
    const found = await findPayroll(ctx, start, end);
    if (found.processed) throw fail(409, 'already_processed', 'This payroll has already been submitted.');
    const prior = await ctx.store.getPayroll(ctx.orgId, found.payroll_uuid);
    if (prior && ['submitting', 'submitted'].includes(prior.status)) throw fail(409, 'already_submitted', 'This payroll was already submitted.');

    await ctx.client.put(`/v1/companies/${c}/payrolls/${found.payroll_uuid}/prepare`, {});
    let notInPayroll = [];
    await ctx.client.putVersioned(`/v1/companies/${c}/payrolls/${found.payroll_uuid}`, `/v1/companies/${c}/payrolls/${found.payroll_uuid}`, (cur) => {
        const comps = rules.toGustoCompensations(feed.rows, cur.employee_compensations || []);
        const present = new Set((cur.employee_compensations || []).map((e) => e.employee_uuid));
        notInPayroll = feed.rows.filter((r) => !present.has(r.employeeUuid)).map((r) => ({ userId: r.userId, name: r.name }));
        return { employee_compensations: comps };
    });
    await ctx.client.put(`/v1/companies/${c}/payrolls/${found.payroll_uuid}/calculate`, {});
    const calculated = await waitCalculated(ctx, found.payroll_uuid, ctx.pollOpts);
    const blockers = await ctx.client.get(`/v1/companies/${c}/payrolls/blockers`);
    const issues = [...feed.issues];
    for (const n of notInPayroll) issues.push({ severity: 'warning', code: 'not_in_payroll', userId: n.userId, message: `${n.name || n.userId} is in Gusto but not on this payroll yet (they may not have finished onboarding in Gusto). Their hours were not sent.` });
    const record = await ctx.store.savePayroll(ctx.orgId, found.payroll_uuid, {
        status: 'prepared', periodStart: start, periodEnd: end, checkDate: found.check_date, feedHash: feed.hash, feedTotals: feed.totals, feedRows: feed.rows.map((r) => ({ userId: r.userId, name: r.name, regularHours: r.regularHours, overtimeHours: r.overtimeHours, doubleTimeHours: r.doubleTimeHours, ptoHours: r.ptoHours })),
        preparedAt: nowIso(), preparedBy: actor || null, totals: calculated.totals, blockers: blockers.map((b) => b.message || b.key), issues, submittedAt: null, submittedBy: null
    });
    return { payrollUuid: found.payroll_uuid, status: 'prepared', period: { start, end }, checkDate: found.check_date, cutoff: cutoffFor(ctx, calculated), ...summarize(calculated, feed.rows), feedTotals: feed.totals, blockers: record.blockers, issues, canSubmit: !record.blockers.length };
}

/** Current state of a prepared payroll: Gusto totals, blockers, whether our hours changed since prepare */
async function previewPayroll(ctx, payrollUuid) {
    const c = cid(ctx);
    const record = await ctx.store.getPayroll(ctx.orgId, payrollUuid);
    if (!record) throw fail(404, 'not_found', 'We have no prepared payroll with that id.');
    const [p, blockers] = await Promise.all([ctx.client.get(`/v1/companies/${c}/payrolls/${payrollUuid}`), ctx.client.get(`/v1/companies/${c}/payrolls/blockers`)]);
    let stale = false;
    const offCycle = record.kind === 'off_cycle';
    if (record.status === 'prepared' && offCycle) {
        // an off-cycle payroll has no hours feed: it is stale when Gusto's total is no longer the one that was reviewed
        stale = !p.totals || !record.totals || p.totals.gross_pay !== record.totals.gross_pay;
    } else if (record.status === 'prepared') {
        const feed = await buildFeed(ctx, record.periodStart, record.periodEnd);
        stale = feed.hash !== record.feedHash;
    }
    const extra = offCycle ? { kind: 'off_cycle', reason: record.reason || null, entered: (record.offCycle && record.offCycle.people) || [], ...summarize(p, (record.offCycle && record.offCycle.people) || []) } : { kind: 'regular' };
    return { ...extra, payrollUuid, status: record.status, processed: Boolean(p.processed), period: { start: record.periodStart, end: record.periodEnd }, checkDate: p.check_date, cutoff: cutoffFor(ctx, p), totals: p.totals || null, blockers: blockers.map((b) => b.message || b.key), stale, issues: record.issues || [], feedTotals: record.feedTotals, preparedAt: record.preparedAt, submittedAt: record.submittedAt || null };
}

/**
 * Submit. Needs BOTH: confirm === true and confirmPayrollId equal to this payroll's id (typed or echoed by the UI
 * after the person reviewed the totals). Refuses if our hours changed since prepare, blockers exist, or the
 * deadline passed (unless acceptLate).
 */
async function submitPayroll(ctx, payrollUuid, { confirm, confirmPayrollId, acceptLate = false, actor }) {
    const c = cid(ctx);
    if (confirm !== true || confirmPayrollId !== payrollUuid) throw fail(400, 'confirmation_required', 'Submitting pays real money. Confirm by sending confirm=true and confirmPayrollId equal to the payroll id.');
    const record = await ctx.store.getPayroll(ctx.orgId, payrollUuid);
    if (!record) throw fail(404, 'not_found', 'We have no prepared payroll with that id. Prepare it first.');
    if (record.status !== 'prepared') throw fail(409, 'wrong_state', `This payroll is "${record.status}", so it cannot be submitted.`);
    const p = await ctx.client.get(`/v1/companies/${c}/payrolls/${payrollUuid}`);
    if (p.processed) throw fail(409, 'already_processed', 'Gusto already shows this payroll as submitted.');
    if (!p.totals) throw fail(409, 'not_calculated', 'The payroll is not calculated. Prepare it again.');
    if (record.kind === 'off_cycle') {
        if (!record.totals || p.totals.gross_pay !== record.totals.gross_pay) throw fail(409, 'stale_totals', 'The totals in Gusto changed after you prepared this off-cycle payroll. Prepare it again and review the new totals.');
    } else {
        const feed = await buildFeed(ctx, record.periodStart, record.periodEnd);
        if (feed.hash !== record.feedHash) throw fail(409, 'stale_hours', 'Hours changed after you prepared this payroll. Prepare it again and review the new totals.');
    }
    const blockers = await ctx.client.get(`/v1/companies/${c}/payrolls/blockers`);
    if (blockers.length) throw fail(409, 'blockers', `Gusto reports blockers: ${blockers.map((b) => b.message || b.key).join('; ')}`, { blockers });
    const cutoff = cutoffFor(ctx, p);
    if (cutoff.status === 'passed' && !acceptLate) throw fail(409, 'deadline_passed', cutoff.message, { cutoff });
    const claimed = await ctx.store.claimPayroll(ctx.orgId, payrollUuid, ['prepared'], { status: 'submitting', submittingAt: nowIso(), submittedBy: actor || null });
    if (!claimed) throw fail(409, 'wrong_state', 'Someone else is submitting this payroll right now.');
    try {
        await ctx.client.put(`/v1/companies/${c}/payrolls/${payrollUuid}/submit`, { version: p.version });
    } catch (e) {
        await ctx.store.savePayroll(ctx.orgId, payrollUuid, { status: 'prepared', submitError: String(e.message).slice(0, 300) });
        throw e;
    }
    const saved = await ctx.store.savePayroll(ctx.orgId, payrollUuid, { status: 'submitted', submittedAt: nowIso(), submittedBy: actor || null, submittedTotals: p.totals, acceptedLate: Boolean(acceptLate && cutoff.status === 'passed') });
    // Keep what each person was paid, for the register, cost reports, the accounting journal and the API.
    // The payroll is already submitted at this point, so a failure here must not look like a failed submit.
    let payResults = null;
    try { payResults = await payResultsIo.store(ctx, payrollUuid, p, { status: 'submitted', people: await sync.loadPeople(ctx) }); }
    catch (e) { try { await ctx.store.logError(ctx.orgId, { scope: 'pay_results', ref: payrollUuid, message: `Pay results were not saved: ${String(e.message).slice(0, 200)}`, code: 'pay_results_failed' }); } catch (_) { /* best effort */ } }
    try { (ctx.emitEvent || require('../events').emit)(ctx.orgId, 'payroll.run.completed', { run_id: payrollUuid, pay_date: p.check_date || null, period_start: record.periodStart, period_end: record.periodEnd }); } catch (_) { /* never blocks a submit */ }
    return { payrollUuid, status: saved.status, totals: p.totals, submittedAt: saved.submittedAt, cutoff, payResults };
}

async function cancelPayroll(ctx, payrollUuid, { actor } = {}) {
    const c = cid(ctx);
    const record = await ctx.store.getPayroll(ctx.orgId, payrollUuid);
    if (!record) throw fail(404, 'not_found', 'We have no payroll with that id.');
    if (record.status === 'prepared') { // never submitted: nothing to cancel at Gusto, just discard our prepared state
        if (record.kind === 'off_cycle') {
            // an off-cycle payroll exists at Gusto only because we created it, so remove the unsubmitted one there too.
            // VERIFY against Gusto: DELETE /v1/companies/{id}/payrolls/{payroll_id} for an unprocessed off-cycle payroll.
            const claimed = await ctx.store.claimPayroll(ctx.orgId, payrollUuid, ['prepared'], { status: 'discarding' });
            if (!claimed) throw fail(409, 'wrong_state', 'This payroll is being submitted or was already discarded.');
            try { await ctx.client.del(`/v1/companies/${c}/payrolls/${payrollUuid}`); } catch (e) {
                if (e.code !== 'not_found') { await ctx.store.savePayroll(ctx.orgId, payrollUuid, { status: 'prepared' }); throw e; }
            }
        }
        await ctx.store.savePayroll(ctx.orgId, payrollUuid, { status: 'discarded', discardedAt: nowIso(), discardedBy: actor || null });
        return { payrollUuid, status: 'discarded' };
    }
    if (record.status !== 'submitted') throw fail(409, 'wrong_state', `This payroll is "${record.status}" and cannot be cancelled.`);
    await ctx.client.put(`/v1/companies/${c}/payrolls/${payrollUuid}/cancel`, {});
    await ctx.store.savePayroll(ctx.orgId, payrollUuid, { status: 'cancelled', cancelledAt: nowIso(), cancelledBy: actor || null });
    try { await payResultsIo.remove(ctx, payrollUuid); } catch (_) { /* the payroll is cancelled either way */ }
    return { payrollUuid, status: 'cancelled' };
}

/** Pull the latest state/receipt of a payroll we submitted */
async function refreshPayroll(ctx, payrollUuid) {
    const c = cid(ctx);
    const record = await ctx.store.getPayroll(ctx.orgId, payrollUuid);
    if (!record) return null;
    const p = await ctx.client.get(`/v1/companies/${c}/payrolls/${payrollUuid}`);
    const patch = { gustoProcessed: Boolean(p.processed), lastCheckedAt: nowIso() };
    if (p.processed) { try { patch.receipt = await ctx.client.get(`/v1/payrolls/${payrollUuid}/receipt`); } catch (e) { if (e.code !== 'not_found') throw e; } }
    if (p.payment_status === 'paid' || p.paid_at) patch.status = 'paid';
    else if (p.processed && record.status === 'prepared') patch.status = 'submitted';
    const out = await ctx.store.savePayroll(ctx.orgId, payrollUuid, patch);
    // Refresh the stored pay results too: Gusto's final figures can differ from the preview, and older payrolls may have none
    if (p.processed && ['submitted', 'paid'].includes(out.status)) { try { await payResultsIo.store(ctx, payrollUuid, p, { status: out.status, people: await sync.loadPeople(ctx) }); } catch (_) { /* shown as missing on the register */ } }
    return out;
}

async function history(ctx) {
    return (await ctx.store.listPayrolls(ctx.orgId)).map((r) => ({ payrollUuid: r.payrollUuid, status: r.status, periodStart: r.periodStart, periodEnd: r.periodEnd, checkDate: r.checkDate, totals: r.submittedTotals || r.totals || null, preparedAt: r.preparedAt || null, preparedBy: r.preparedBy || null, submittedAt: r.submittedAt || null, submittedBy: r.submittedBy || null, feedTotals: r.feedTotals || null, kind: r.kind || 'regular', reason: r.reason || null }));
}

/** What each person was paid in one payroll, from the stored pay results */
async function register(ctx, payrollUuid) {
    const record = await ctx.store.getPayroll(ctx.orgId, payrollUuid);
    if (!record) throw fail(404, 'not_found', 'We have no payroll with that id.');
    const rows = (await payResultsIo.listForPayroll(ctx, payrollUuid)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { payrollUuid, status: record.status, periodStart: record.periodStart, periodEnd: record.periodEnd, checkDate: record.checkDate, rows, totals: payResultsIo.totalsOf(rows), allocated: rows.some((r) => r.allocated) };
}

/** Payroll cost between two pay dates, by department and by pay date */
async function cost(ctx, { from, to } = {}) {
    const rows = await payResultsIo.listForOrg(ctx, { from, to });
    const group = (key) => { const m = new Map(); rows.forEach((r) => { const k = key(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }); return [...m.entries()].map(([k, list]) => ({ key: k, ...payResultsIo.totalsOf(list) })); };
    return { from: from || null, to: to || null, totals: payResultsIo.totalsOf(rows), byDepartment: group((r) => r.department || 'No department').sort((a, b) => b.employerCost - a.employerCost), byPayDate: group((r) => r.payDate || 'No pay date').sort((a, b) => String(a.key).localeCompare(String(b.key))), allocated: rows.some((r) => r.allocated) };
}

/* ------------------------------- read-only: stubs, taxes, reconciliation ------------------------------- */

async function payStubs(ctx, userId) {
    const link = await ctx.store.getLink(ctx.orgId, 'employee', userId);
    if (!link || !link.gustoUuid) throw fail(404, 'not_linked', 'This person is not in Gusto yet.');
    return ctx.client.get(`/v1/employees/${link.gustoUuid}/pay_stubs`);
}

async function taxFilings(ctx) {
    const c = cid(ctx);
    const [liabilities, forms] = await Promise.all([ctx.client.get(`/v1/companies/${c}/tax_liabilities`), ctx.client.get(`/v1/companies/${c}/forms`)]);
    return { payments: liabilities, forms: forms.map((f) => ({ uuid: f.uuid, title: f.title || f.name, signed: Boolean(f.signed) })) };
}

/** Our hours vs the hours Gusto holds for the pay period; plus people without a link */
async function reconciliation(ctx, start, end) {
    const feed = await buildFeed(ctx, start, end);
    const people = (await sync.loadPeople(ctx)).filter((p) => p.classification === 'W2' || !p.classification);
    const links = await ctx.store.listLinks(ctx.orgId, 'employee');
    const linkMap = new Map(links.filter((l) => l.gustoUuid).map((l) => [l.ourId, l]));
    let payroll = null;
    try { payroll = await findPayroll(ctx, start, end, { processed: true }); } catch (e) { if (e.code !== 'no_payroll_for_period') throw e; }
    const comps = payroll ? (await ctx.client.get(`/v1/companies/${cid(ctx)}/payrolls/${payroll.payroll_uuid}`)).employee_compensations || [] : [];
    const rec = rules.reconcile({ feedRows: feed.rows, gustoCompensations: comps, people: people.map((p) => ({ id: p.id, name: p.name, payType: p.payType, active: p.active })), links: linkMap });
    return { period: { start, end }, payrollUuid: payroll ? payroll.payroll_uuid : null, payrollProcessed: payroll ? Boolean(payroll.processed) : null, hasPayroll: Boolean(payroll), feedIssues: feed.issues, ...rec };
}

module.exports = { _internal: { cid, fail, summarize, cutoffFor }, register, cost, buildFeed, listPayrolls, findPayroll, preparePayroll, previewPayroll, submitPayroll, cancelPayroll, refreshPayroll, history, payStubs, taxFilings, reconciliation, waitCalculated };
