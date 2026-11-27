/**
 * A customer's own Gusto account (Gusto "App Integration", GUSTO_INTEGRATION=app): the two payroll steps that do
 * not move money.
 *
 *   1. Putting hours on a payroll. The time sheets sent by time-sheets.js sit in Gusto until someone chooses
 *      "Sync hours to payroll". This asks Gusto to do that for one open pay period. The owner still reviews and
 *      runs the payroll in Gusto; nothing here submits a payroll or pays anyone.
 *   2. Reading back what was paid. Processed payrolls are read and kept as pay results, the same rows the cost
 *      report, the accounting journal and the public API already read (services/gusto/pay-results.js).
 *
 * Read from Gusto's App Integrations reference on 2026-11-17 (version 2026-06-15):
 *   POST /v1/companies/{company_id}/time_tracking/payroll_syncs        scope payroll_syncs:write, answers 202
 *        body, all required: kind "regular", pay_schedule_uuid, pay_period_start_date, pay_period_end_date
 *        the work is done later: status pending | in_progress | success | failure | partial_success,
 *        with submitted_at, completed_at, errors[], warnings[]
 *        422 keys: payroll_sync_invalid_pay_schedule, payroll_sync_no_employees, payroll_sync_empty_export
 *   GET  /v1/time_tracking/payroll_syncs/{payroll_sync_uuid}           scope payroll_syncs:read
 *   GET  /v1/companies/{company_id}/payrolls                           scope payrolls:read
 *        processing_statuses, payroll_types, start_date, end_date, include, page, per
 *   GET  /v1/companies/{company_id}/payrolls/{payroll_id}?include=taxes
 * NOT confirmed there, so decided here and to be checked against the demo environment:
 *   - open pay periods are taken from the unprocessed regular payrolls (each carries pay_period with
 *     pay_schedule_uuid); Gusto's pages do not say this is the list a payroll sync accepts
 *   - Gusto also announces a finished sync by a "PayrollSync" webhook; here the status is read when the list is opened
 *   - whether the demo application has been given payroll_syncs:write, payroll_syncs:read and payrolls:read
 */
const { GustoError } = require('./client');
const sync = require('./sync');
const rules = require('./rules');
const timeSheets = require('./time-sheets');
const payResults = require('./pay-results');

const SYNCS = 'payrollSyncs';
const OPEN = ['pending', 'in_progress'];
const nowIso = () => new Date().toISOString();
const fail = (status, code, message, extra) => Object.assign(new GustoError(message, { status, code }), extra || {});
const cid = (ctx) => { if (!ctx.conn || !ctx.conn.companyUuid || ctx.conn.status !== 'connected') throw fail(409, 'not_connected', 'This company is not connected to Gusto'); return ctx.conn.companyUuid; };
const needApp = (ctx) => { if (ctx.opts.integration !== 'app') throw fail(409, 'not_app_integration', 'This is for a customer\'s own Gusto account. This server is set up for Gusto Embedded Payroll.'); };
const today = (ctx) => (ctx.today ? ctx.today() : new Date().toISOString().slice(0, 10));
const isDate = (v) => Boolean(rules.parseIso(v));
const uuidOf = (p) => p.payroll_uuid || p.uuid;

/* ------------------------------- open pay periods ------------------------------- */

/**
 * The pay periods hours can still go into: the customer's regular payrolls that Gusto has not processed yet,
 * from 45 days back to 45 days ahead, oldest first.
 */
async function openPayPeriods(ctx) {
    needApp(ctx);
    const day = today(ctx);
    const rows = await ctx.client.paginate(`/v1/companies/${cid(ctx)}/payrolls`, { query: { processing_statuses: 'unprocessed', payroll_types: 'regular', start_date: rules.addDays(day, -45), end_date: rules.addDays(day, 45) } });
    return rows.filter((p) => p && !p.processed && p.pay_period && p.pay_period.pay_schedule_uuid && isDate(p.pay_period.start_date) && isDate(p.pay_period.end_date))
        .map((p) => ({ payrollUuid: uuidOf(p), payScheduleUuid: p.pay_period.pay_schedule_uuid, start: p.pay_period.start_date, end: p.pay_period.end_date, checkDate: p.check_date || null, deadline: p.payroll_deadline || null, ended: p.pay_period.end_date < day }))
        .sort((a, b) => a.start.localeCompare(b.start));
}

/* ------------------------------- hours onto a payroll ------------------------------- */

const publicSync = (r) => ({
    id: r.id, payScheduleUuid: r.payScheduleUuid, periodStart: r.periodStart, periodEnd: r.periodEnd, status: r.status, submittedAt: r.submittedAt || null, completedAt: r.completedAt || null,
    errors: r.errors || [], warnings: r.warnings || [], startedBy: r.startedBy || null, checkedAt: r.checkedAt || null
});
/** Gusto's errors come as objects of several shapes; only short text is kept and shown */
const textsOf = (list) => (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? x : (x && (x.message || x.error_key || x.category)) || '')).map((s) => String(s).slice(0, 300)).filter(Boolean).slice(0, 50);
const fromGusto = (d) => ({ status: String(d.status || 'pending'), submittedAt: d.submitted_at || null, completedAt: d.completed_at || null, errors: textsOf(d.errors), warnings: textsOf(d.warnings), checkedAt: nowIso() });

/**
 * Ask Gusto to put the time sheets of one open pay period on its payroll.
 * Refused before anything is sent to Gusto when: the period is not an open pay period there, approved hours of
 * the period have not been sent yet (or sent days have changed since), or a request for the same period is still running.
 */
async function startPayrollSync(ctx, input, { actor = null } = {}) {
    needApp(ctx);
    const company = cid(ctx);
    const b = input || {};
    const payScheduleUuid = String(b.payScheduleUuid || ''); const start = String(b.start || ''); const end = String(b.end || '');
    if (!payScheduleUuid || payScheduleUuid.length > 100) throw fail(400, 'validation', 'Choose a pay period');
    if (!isDate(start) || !isDate(end) || end < start) throw fail(400, 'validation', 'start and end must be dates (YYYY-MM-DD)');

    const period = (await openPayPeriods(ctx)).find((p) => p.payScheduleUuid === payScheduleUuid && p.start === start && p.end === end);
    if (!period) throw fail(409, 'no_open_pay_period', 'Gusto has no open pay period with these dates. Choose one from the list.');

    const pv = await timeSheets.preview(ctx, start, end);
    const waiting = pv.counts.send + pv.counts.update + pv.counts.remove;
    if (waiting > 0) throw fail(409, 'hours_not_sent', `${waiting} day${waiting === 1 ? '' : 's'} of hours in this pay period ${waiting === 1 ? 'has' : 'have'} not been sent to Gusto yet. Send the hours first.`, { counts: pv.counts });

    const mine = (await ctx.store.listRecords(SYNCS, ctx.orgId)).filter((r) => r.payScheduleUuid === payScheduleUuid && r.periodStart === start && r.periodEnd === end);
    if (mine.some((r) => OPEN.includes(r.status))) throw fail(409, 'sync_in_progress', 'Gusto is still working on an earlier request for this pay period.');

    const made = await ctx.client.post(`/v1/companies/${company}/time_tracking/payroll_syncs`, { kind: 'regular', pay_schedule_uuid: payScheduleUuid, pay_period_start_date: start, pay_period_end_date: end });
    if (!made || !made.uuid) throw fail(502, 'bad_response', 'Gusto did not return the request');
    const rec = await ctx.store.saveRecord(SYNCS, ctx.orgId, made.uuid, { payScheduleUuid, periodStart: start, periodEnd: end, startedBy: actor, startedAt: nowIso(), ...fromGusto(made) });
    // people who are not matched, weeks not approved and the like: their hours are not in Gusto, so not on this payroll
    return { sync: publicSync(rec), notIncluded: pv.issues.filter((i) => i.severity !== 'info'), checkDate: period.checkDate, deadline: period.deadline };
}

/** Ask Gusto how one request is doing and remember the answer */
async function refreshPayrollSync(ctx, id) {
    needApp(ctx);
    cid(ctx);
    const rec = await ctx.store.getRecord(SYNCS, ctx.orgId, String(id));
    if (!rec) throw fail(404, 'not_found', 'That request is not known here');
    const d = await ctx.client.get(`/v1/time_tracking/payroll_syncs/${rec.id}`);
    return publicSync(await ctx.store.saveRecord(SYNCS, ctx.orgId, rec.id, fromGusto(d || {})));
}

/**
 * The requests made from here, newest first. With `refresh`, the ones Gusto had not finished are asked about
 * again (ten at most); one that cannot be read keeps its last known state.
 */
async function listPayrollSyncs(ctx, { refresh = false } = {}) {
    needApp(ctx);
    let rows = await ctx.store.listRecords(SYNCS, ctx.orgId);
    if (refresh && ctx.conn && ctx.conn.status === 'connected') {
        for (const r of rows.filter((x) => OPEN.includes(x.status)).slice(0, 10)) {
            try { await refreshPayrollSync(ctx, r.id); } catch (e) { if (!e || e.name !== 'GustoError') throw e; if (e.code === 'reauth_required') throw e; }
        }
        rows = await ctx.store.listRecords(SYNCS, ctx.orgId);
    }
    return rows.map(publicSync).sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
}

/* ------------------------------- reading what was paid ------------------------------- */

/**
 * Read the payrolls Gusto has processed in a range of pay periods (90 days back by default, a year at most) and
 * keep each person's pay as pay results. Safe to repeat: rows have stable ids and are rewritten.
 * People in Gusto who are not matched here are counted, not stored.
 */
async function pullPayResults(ctx, { start, end } = {}, { actor = null } = {}) {
    needApp(ctx);
    const company = cid(ctx);
    const day = today(ctx);
    const to = end || day; const from = start || rules.addDays(to, -90);
    if (!isDate(from) || !isDate(to) || to < from) throw fail(400, 'validation', 'start and end must be dates (YYYY-MM-DD)');
    if (Date.parse(to) - Date.parse(from) > 366 * 86400000) throw fail(400, 'validation', 'Choose a period of one year or less');

    const list = await ctx.client.paginate(`/v1/companies/${company}/payrolls`, { query: { processing_statuses: 'processed', payroll_types: 'regular,off_cycle', start_date: from, end_date: to } });
    const people = await sync.loadPeople(ctx);
    const out = { from, to, payrolls: 0, rows: 0, unmatched: 0, failed: 0, problems: [] };
    const unmatched = new Set();
    for (const p of list.filter((x) => x && x.processed && uuidOf(x))) {
        const id = uuidOf(p);
        try {
            const full = await ctx.client.get(`/v1/companies/${company}/payrolls/${id}`, { query: { include: 'taxes' } });
            const status = full.check_date && full.check_date <= day ? 'paid' : 'submitted';
            const saved = await payResults.store(ctx, id, full, { status, people });
            out.payrolls += 1; out.rows += saved.saved;
            saved.unmatched.forEach((u) => unmatched.add(u));
            await ctx.store.resolveErrors(ctx.orgId, 'pay_results', id);
        } catch (e) {
            if (!e || e.name !== 'GustoError') throw e;
            if (e.code === 'reauth_required' || e.code === 'not_connected') throw e;
            out.failed += 1;
            out.problems.push({ payrollUuid: id, code: e.code || 'gusto_error', message: e.message });
            await ctx.store.logError(ctx.orgId, { scope: 'pay_results', ref: id, message: `A payroll could not be read from Gusto: ${e.message}`, code: e.code || null });
        }
    }
    out.unmatched = unmatched.size;
    await ctx.store.saveConnection(ctx.orgId, { lastPayResultsPull: { at: nowIso(), by: actor, from, to, payrolls: out.payrolls, rows: out.rows, unmatched: out.unmatched, failed: out.failed } });
    return out;
}

/** What is kept here, one line per payroll, newest pay date first (no call to Gusto) */
async function listPayResults(ctx, { from, to } = {}) {
    needApp(ctx);
    if ((from && !isDate(from)) || (to && !isDate(to))) throw fail(400, 'validation', 'from and to must be dates (YYYY-MM-DD)');
    const rows = (await payResults.listForOrg(ctx, { from, to })).filter((r) => r.source === 'gusto');
    const by = new Map();
    for (const r of rows) { if (!by.has(r.payrollUuid)) by.set(r.payrollUuid, []); by.get(r.payrollUuid).push(r); }
    const payrolls = [...by.entries()].map(([payrollUuid, list]) => ({ payrollUuid, payDate: list[0].payDate, periodStart: list[0].periodStart, periodEnd: list[0].periodEnd, status: list[0].status, estimated: list.some((r) => r.allocated), ...payResults.totalsOf(list) }))
        .sort((a, b) => String(b.payDate || '').localeCompare(String(a.payDate || '')));
    return { payrolls, totals: payResults.totalsOf(rows), lastPull: (ctx.conn && ctx.conn.lastPayResultsPull) || null };
}

module.exports = { openPayPeriods, startPayrollSync, refreshPayrollSync, listPayrollSyncs, pullPayResults, listPayResults };
