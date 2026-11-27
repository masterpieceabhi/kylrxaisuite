/**
 * Benefit deductions to the payroll provider (US-G03).
 *
 * The deduction feed itself is built by services/benefits-rules.js (payrollFeed) from the benefits module's data;
 * this module only reads it. For each person and plan it keeps one "employee benefit" at the provider:
 *   preview -> what a send would create, change or switch off, next to what the provider holds now (the compare)
 *   send    -> does exactly what the preview showed (the caller passes the preview's fingerprint back; if anything
 *              changed in between, nothing is sent and a new preview is needed)
 * Only benefits this module created are ever switched off. Benefits set up at the provider by hand are listed, not touched.
 *
 * VERIFY against Gusto: GET /v1/benefits, GET/POST /v1/companies/{id}/company_benefits,
 * GET/POST /v1/employees/{id}/employee_benefits, PUT /v1/employee_benefits/{id} (with `version`), and the bodies in
 * extras-rules.js. A 401(k) is sent as a percent of pay when the chosen percent is known; the company match is sent
 * as the feed's estimated amount per pay period, which is NOT how a real match should be set up: check it in Gusto.
 */
const X = require('./extras-rules');
const { GustoError } = require('./client');

const nowIso = () => new Date().toISOString();
const todayOf = (ctx) => (ctx.today ? ctx.today() : new Date().toISOString().slice(0, 10));
const cidOf = (ctx) => { if (!ctx.conn || !ctx.conn.companyUuid) throw new GustoError('This company is not connected to Gusto', { status: 409, code: 'not_connected' }); return ctx.conn.companyUuid; };
const fail = (status, code, message, extra) => Object.assign(new GustoError(message, { status, code }), extra || {});
const errMessage = (e) => (e && e.message ? String(e.message).slice(0, 300) : 'Unknown error');
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

/** { rows, errors, percents } for the period end date. Reads the benefits module's collections; writes nothing. */
async function loadFeed(ctx, periodEnd) {
    if (ctx.loadDeductionFeed) return ctx.loadDeductionFeed(ctx.orgId, periodEnd);
    const { rawCollection } = require('../../config/firebase');
    const B = require('../benefits-rules');
    const { loadPeople } = require('../us-people-loader');
    const all = async (name) => (await rawCollection(name).where('orgId', '==', ctx.orgId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    const [plans, enrollments, people, settingsSnap] = await Promise.all([all('benefit_plans'), all('benefit_enrollments'), loadPeople(ctx.orgId), rawCollection('benefit_settings').doc(ctx.orgId).get()]);
    const has = typeof settingsSnap.exists === 'function' ? settingsSnap.exists() : settingsSnap.exists;
    const limits = (has && settingsSnap.data().limits) || B.DEFAULT_LIMITS; // the same default routes/us-benefits.js uses
    const feed = B.payrollFeed(enrollments, plans, Object.fromEntries(people.map((p) => [p.id, p])), { periodEnd, limits });
    // the feed gives a 401(k) as estimated dollars; the percent the person chose is on their election
    const planById = new Map(plans.map((p) => [p.id, p]));
    const percents = new Map();
    for (const enr of enrollments) {
        if (!B.activeOn(enr, periodEnd)) continue;
        for (const el of enr.elections || []) {
            const plan = planById.get(el.planId);
            if (plan && plan.type === '401k' && !el.waived && Number(el.deferralPercent) > 0) percents.set(`${enr.userId}|401k|${String(plan.name).replace(/\s+/g, ' ').trim()}`, Number(el.deferralPercent));
        }
    }
    return { rows: feed.rows, errors: feed.errors, percents };
}

async function preview(ctx, { periodEnd } = {}) {
    const cid = cidOf(ctx);
    const date = periodEnd || todayOf(ctx);
    if (!isDate(date)) throw fail(400, 'validation', 'periodEnd must be a date (YYYY-MM-DD)');
    const feed = await loadFeed(ctx, date);
    const wanted = X.wantedDeductions(feed.rows, feed.percents || new Map());
    const [links, managed, catalog, companyBenefits] = await Promise.all([
        ctx.store.listLinks(ctx.orgId, 'employee'), ctx.store.listLinks(ctx.orgId, 'employee_benefit'),
        ctx.client.get('/v1/benefits'), ctx.client.get(`/v1/companies/${cid}/company_benefits`)
    ]);
    const linkMap = new Map(links.filter((l) => l.gustoUuid).map((l) => [l.ourId, l]));
    const managedRows = managed.filter((m) => m.gustoUuid && !m.ended).map((m) => ({ id: m.ourId, userId: m.userId, name: m.name || null, key: m.key, planName: m.planName, employeeBenefitUuid: m.gustoUuid }));
    // read what the provider holds for everyone a row could touch
    const userIds = new Set([...wanted.map((w) => w.userId), ...managedRows.map((m) => m.userId)]);
    const current = new Map();
    for (const userId of userIds) {
        const l = linkMap.get(userId);
        if (l) current.set(l.gustoUuid, await ctx.client.get(`/v1/employees/${l.gustoUuid}/employee_benefits`));
    }
    const plan = X.planDeductions({ wanted, links: linkMap, catalog, companyBenefits, current, managed: managedRows });
    return { periodEnd: date, ...plan, feedErrors: feed.errors || [], feedRows: feed.rows.length };
}

/** Strip what the page does not need (request bodies, provider ids) */
const publicRow = (r) => ({ id: r.id, userId: r.userId, name: r.name, planName: r.planName, taxTreatment: r.taxTreatment || null, action: r.action, wanted: r.wanted, current: r.current, reason: r.reason || null, notes: r.notes || [] });
const publicPreview = (p) => ({ periodEnd: p.periodEnd, fingerprint: p.fingerprint, totals: p.totals, changes: p.changes, rows: p.rows.map(publicRow), newCompanyBenefits: p.companyBenefitsToCreate.map((c) => c.description), notFromHere: p.unmanaged, feedErrors: p.feedErrors, feedRows: p.feedRows });

async function send(ctx, { periodEnd, fingerprint, actor } = {}) {
    const cid = cidOf(ctx);
    const plan = await preview(ctx, { periodEnd });
    if (!fingerprint || fingerprint !== plan.fingerprint) throw fail(409, 'changed', 'The deductions or what Gusto holds changed since the preview. Look at the new preview, then send again.');
    const results = [];
    if (plan.changes) {
        // company-level benefits first: a person's deduction hangs off one
        const companyUuid = new Map();
        for (const c of plan.companyBenefitsToCreate) {
            try {
                const made = await ctx.client.post(`/v1/companies/${cid}/company_benefits`, { benefit_type: c.benefitType, description: c.description, active: true }, { idempotencyKey: `kylrx:${ctx.orgId}:cbenefit:${X.hash([c.key])}` });
                companyUuid.set(c.key, made.uuid);
            } catch (e) { companyUuid.set(c.key, { error: errMessage(e) }); }
        }
        for (const r of plan.rows) {
            if (!['create', 'update', 'end'].includes(r.action)) continue;
            const prior = (await ctx.store.getLink(ctx.orgId, 'employee_benefit', r.id)) || {};
            try {
                if (r.action === 'create') {
                    const cb = r.companyBenefitUuid || companyUuid.get(r.key);
                    if (!cb || cb.error) throw fail(502, 'gusto_error', `The benefit "${r.planName}" could not be set up in Gusto${cb && cb.error ? `: ${cb.error}` : ''}`);
                    const made = await ctx.client.post(`/v1/employees/${r.employeeUuid}/employee_benefits`, { company_benefit_uuid: cb, ...r.body }, { idempotencyKey: `kylrx:${ctx.orgId}:ebenefit:${X.hash([r.id, r.body])}:${prior.tries || 0}` });
                    await ctx.store.saveLink(ctx.orgId, 'employee_benefit', r.id, { gustoUuid: made.uuid, userId: r.userId, name: r.name, key: r.key, planName: r.planName, ended: false, syncState: 'synced', lastSyncedAt: nowIso(), tries: (prior.tries || 0) + 1 });
                } else if (r.action === 'update') {
                    await ctx.client.putVersioned(`/v1/employee_benefits/${r.employeeBenefitUuid}`, `/v1/employee_benefits/${r.employeeBenefitUuid}`, () => r.body);
                    // from now on this one is kept in step from here (it may have been set up by hand before)
                    await ctx.store.saveLink(ctx.orgId, 'employee_benefit', r.id, { gustoUuid: r.employeeBenefitUuid, userId: r.userId, name: r.name, key: r.key, planName: r.planName, ended: false, syncState: 'synced', lastSyncedAt: nowIso() });
                } else {
                    await ctx.client.putVersioned(`/v1/employee_benefits/${r.employeeBenefitUuid}`, `/v1/employee_benefits/${r.employeeBenefitUuid}`, (cur) => (cur.active === false ? null : { active: false }));
                    await ctx.store.saveLink(ctx.orgId, 'employee_benefit', r.id, { ended: true, endedAt: nowIso() });
                }
                results.push({ id: r.id, userId: r.userId, name: r.name, planName: r.planName, action: r.action, ok: true });
            } catch (e) {
                // a clear refusal is replayed for the same idempotency key, so the next try for this row uses a new one
                if (r.action === 'create' && e.status >= 400 && e.status < 500 && e.status !== 429) await ctx.store.saveLink(ctx.orgId, 'employee_benefit', r.id, { userId: r.userId, name: r.name, key: r.key, planName: r.planName, tries: (prior.tries || 0) + 1 });
                await ctx.store.logError(ctx.orgId, { scope: 'benefit_deduction', ref: r.id, name: r.name || null, code: e.code || 'error', message: `${r.planName}: ${errMessage(e)}` });
                results.push({ id: r.id, userId: r.userId, name: r.name, planName: r.planName, action: r.action, ok: false, error: errMessage(e) });
            }
        }
    }
    const sent = results.filter((r) => r.ok).length; const failed = results.length - sent;
    if (results.length && !failed) await ctx.store.resolveErrors(ctx.orgId, 'benefit_deduction');
    const runId = `${Date.now()}`;
    await ctx.store.saveRecord('deductionRuns', ctx.orgId, runId, { periodEnd: plan.periodEnd, at: nowIso(), by: actor || null, totals: plan.totals, sent, failed });
    // the compare after sending: everything that went through now reads "unchanged"
    const after = await preview(ctx, { periodEnd: plan.periodEnd });
    return { periodEnd: plan.periodEnd, sent, failed, results, after: publicPreview(after) };
}

async function lastRun(ctx) {
    const runs = await ctx.store.listRecords('deductionRuns', ctx.orgId);
    return runs.sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;
}

module.exports = { preview: async (ctx, o) => publicPreview(await preview(ctx, o)), send, lastRun, loadFeed };
