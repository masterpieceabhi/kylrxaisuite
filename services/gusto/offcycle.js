/**
 * Off-cycle payrolls (US-F06): a bonus, a correction, or final pay for someone leaving, for chosen people.
 *
 * create -> the payroll is made at the provider, prepared with the entered amounts / hours and calculated.
 * After that it is an ordinary prepared payroll in our store (kind 'off_cycle'), so preview, submit (with the typed
 * confirmation and the double-submit guard) and cancel are the same functions as for a regular payroll (payroll.js).
 *
 * VERIFY against Gusto: POST /v1/companies/{id}/payrolls with off_cycle=true (see extras-rules.toGustoOffCycle) and
 * that the returned payroll is prepared / updated / calculated / submitted exactly like a regular one.
 */
const X = require('./extras-rules');
const sync = require('./sync');
const payroll = require('./payroll');

const { cid, fail, summarize, cutoffFor } = payroll._internal;
const nowIso = () => new Date().toISOString();
const todayOf = (ctx) => (ctx.today ? ctx.today() : new Date().toISOString().slice(0, 10));

async function createOffCycle(ctx, input, { actor } = {}) {
    const c = cid(ctx);
    const [people, links] = await Promise.all([sync.loadPeople(ctx), ctx.store.listLinks(ctx.orgId, 'employee')]);
    const linkMap = new Map(links.filter((l) => l.gustoUuid).map((l) => [l.ourId, l]));
    const { errors, value } = X.validateOffCycle(input, { today: todayOf(ctx), people: people.filter((p) => p.classification === 'W2' || !p.classification), links: linkMap });
    if (errors.length) throw fail(400, 'validation', errors.join('; '), { errors });

    // The same request (same people, amounts, dates) maps to one payroll: a second click re-uses the open
    // preparation, and paying an identical one again after it was submitted needs an explicit yes.
    const inputHash = X.offCycleHash(value);
    const same = (await ctx.store.listPayrolls(ctx.orgId)).filter((r) => r.kind === 'off_cycle' && r.inputHash === inputHash);
    const paid = same.filter((r) => ['submitting', 'submitted', 'paid'].includes(r.status));
    if (paid.length && (input || {}).allowRepeat !== true) throw fail(409, 'already_submitted', 'An off-cycle payroll with exactly these people, amounts and dates was already submitted. Confirm that you want to pay it again.');
    const open = same.find((r) => r.status === 'prepared');
    let payrollUuid = open ? open.payrollUuid : null;
    if (!payrollUuid) {
        // The provider replays a clear refusal (4xx) for the same idempotency key, so each refusal moves the key on;
        // an unclear failure (network, 5xx) keeps it, so a create that did go through is found instead of repeated.
        const tries = await ctx.store.getLink(ctx.orgId, 'offcycle_try', inputHash);
        const refused = (tries && tries.refused) || 0;
        let created;
        try {
            created = await ctx.client.post(`/v1/companies/${c}/payrolls`, X.toGustoOffCycle(value), { idempotencyKey: `kylrx:${ctx.orgId}:offcycle:${inputHash}:${same.length}:${refused}` });
        } catch (e) {
            if (e.status >= 400 && e.status < 500 && e.status !== 429) await ctx.store.saveLink(ctx.orgId, 'offcycle_try', inputHash, { refused: refused + 1 });
            throw e;
        }
        payrollUuid = created.payroll_uuid || created.uuid;
        if (!payrollUuid) throw fail(502, 'gusto_error', 'Gusto did not return an id for the new off-cycle payroll.');
    }
    const removeAtProvider = async () => { try { await ctx.client.del(`/v1/companies/${c}/payrolls/${payrollUuid}`); } catch (_) { /* best effort: an unsubmitted payroll pays nobody */ } };

    let calculated; let missing = [];
    try {
        await ctx.client.put(`/v1/companies/${c}/payrolls/${payrollUuid}/prepare`, {});
        await ctx.client.putVersioned(`/v1/companies/${c}/payrolls/${payrollUuid}`, `/v1/companies/${c}/payrolls/${payrollUuid}`, (cur) => {
            const r = X.offCycleCompensations(value, cur.employee_compensations || []);
            missing = r.missing;
            return { employee_compensations: r.comps };
        });
        if (missing.length === value.people.length) throw fail(409, 'not_in_payroll', 'Gusto did not put any of these people on the payroll. They may not have finished onboarding in Gusto.', { errors: missing.map((m) => `${m.name || m.userId} is not on the payroll in Gusto`) });
        await ctx.client.put(`/v1/companies/${c}/payrolls/${payrollUuid}/calculate`, {});
        calculated = await payroll.waitCalculated(ctx, payrollUuid, ctx.pollOpts);
    } catch (e) {
        if (!open) await removeAtProvider(); // do not leave a half-made payroll behind
        throw e;
    }
    const blockers = await ctx.client.get(`/v1/companies/${c}/payrolls/blockers`);
    const issues = missing.map((m) => ({ severity: 'warning', code: 'not_in_payroll', userId: m.userId, message: `${m.name || m.userId} is in Gusto but was not put on this payroll (they may not have finished onboarding in Gusto). Nothing was entered for them.` }));
    const entered = value.people.map((p) => ({ userId: p.userId, name: p.name, employeeUuid: p.employeeUuid, amount: p.amountCents / 100, hours: p.hours, note: p.note }));
    const record = await ctx.store.savePayroll(ctx.orgId, payrollUuid, {
        kind: 'off_cycle', reason: value.reason, status: 'prepared', periodStart: value.start, periodEnd: value.end, checkDate: calculated.check_date || value.checkDate, inputHash,
        offCycle: { people: entered, skipRegularDeductions: value.skipRegularDeductions, totals: { people: value.totals.people, amount: value.totals.amountCents / 100, hours: value.totals.hours } },
        feedHash: null, feedTotals: null, feedRows: [], preparedAt: nowIso(), preparedBy: actor || null, totals: calculated.totals, blockers: blockers.map((b) => b.message || b.key), issues, submittedAt: null, submittedBy: null
    });
    return {
        payrollUuid, kind: 'off_cycle', reason: value.reason, status: 'prepared', period: { start: value.start, end: value.end }, checkDate: record.checkDate, cutoff: cutoffFor(ctx, calculated),
        ...summarize(calculated, entered), entered, blockers: record.blockers, issues, canSubmit: !record.blockers.length, reused: Boolean(open)
    };
}

/** People who can be chosen: linked W-2 people. Leavers are listed too (for final pay) and marked. */
async function candidates(ctx) {
    const [people, links] = await Promise.all([sync.loadPeople(ctx), ctx.store.listLinks(ctx.orgId, 'employee')]);
    const linkMap = new Map(links.filter((l) => l.gustoUuid).map((l) => [l.ourId, l]));
    return people.filter((p) => (p.classification === 'W2' || !p.classification) && linkMap.has(p.id))
        .map((p) => ({ userId: p.id, name: p.name, payType: p.payType || null, active: p.active !== false, finishedInGusto: Boolean((linkMap.get(p.id).gusto || {}).onboarded) }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = { createOffCycle, candidates, REASONS: Object.fromEntries(Object.entries(X.OFF_CYCLE_REASONS).map(([k, v]) => [k, v.label])) };
