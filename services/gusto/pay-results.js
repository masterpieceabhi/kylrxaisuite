/**
 * Pay results: one stored row per person per payroll, written when a payroll is submitted to Gusto.
 * The payroll register, the payroll cost report, the accounting journal and the public API read these
 * (collection `pay_results`, shape read by services/canonical.js toPayResult).
 *
 * Gusto gives per-person taxes, deductions and benefits on each employee compensation. When a payroll
 * carries only totals (the mock server, or a trimmed response), the totals are shared out by each
 * person's part of gross pay and the row is marked `allocated: true` so nobody mistakes it for a real figure.
 */
const COLLECTION = 'pay_results';
const cents = (v) => Math.round((Number(v) || 0) * 100);
const money = (c) => Math.round(c) / 100;
const sum = (list, pick) => (Array.isArray(list) ? list.reduce((s, x) => s + cents(pick(x)), 0) : 0);
const docId = (orgId, payrollUuid, userId) => `${orgId}_${payrollUuid}_${userId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 300);

/** Shares `totalCents` across rows in proportion to `weights` (cents), giving the rounding remainder to the largest */
function share(totalCents, weights) {
    const all = weights.reduce((s, w) => s + w, 0);
    if (!all || !totalCents) return weights.map(() => 0);
    const parts = weights.map((w) => Math.floor((totalCents * w) / all));
    let left = totalCents - parts.reduce((s, p) => s + p, 0);
    const order = weights.map((w, i) => i).sort((a, b) => weights[b] - weights[a]);
    for (let i = 0; left > 0 && order.length; i = (i + 1) % order.length) { parts[order[i]] += 1; left -= 1; }
    return parts;
}

const hoursOf = (ec) => Math.round(((ec.hourly_compensations || []).reduce((s, h) => s + (Number(h.hours) || 0), 0) + (ec.paid_time_off || []).reduce((s, h) => s + (Number(h.hours) || 0), 0)) * 100) / 100;

/**
 * Pure builder.
 *   payroll: the Gusto payroll (employee_compensations, totals, check_date, pay_period)
 *   links:   [{ ourId, gustoUuid }] employee links
 *   people:  [{ id, employeeId, name, department }]
 * Returns { rows, unmatched } where unmatched lists Gusto employees we have no link for.
 */
function buildPayResults({ orgId, payrollUuid, payroll, links, people, status = 'submitted', nowIso }) {
    const byGusto = new Map((links || []).filter((l) => l.gustoUuid).map((l) => [l.gustoUuid, l.ourId]));
    const byId = new Map((people || []).map((p) => [p.id, p]));
    const comps = (payroll.employee_compensations || []).filter((ec) => !ec.excluded);
    const period = payroll.pay_period || {};
    const totals = payroll.totals || {};
    const detailed = comps.some((ec) => Array.isArray(ec.taxes));
    const gross = comps.map((ec) => cents(ec.gross_pay));
    const empTaxShare = detailed ? null : share(cents(totals.employee_taxes), gross);
    const erTaxShare = detailed ? null : share(cents(totals.employer_taxes), gross);
    const rows = []; const unmatched = [];
    comps.forEach((ec, i) => {
        const userId = byGusto.get(ec.employee_uuid);
        if (!userId) { unmatched.push(ec.employee_uuid); return; }
        const person = byId.get(userId) || {};
        const g = gross[i]; const net = cents(ec.net_pay);
        let empTax; let erTax; let ded;
        if (detailed) {
            empTax = sum(ec.taxes, (t) => (t.employer ? 0 : t.amount));
            erTax = sum(ec.taxes, (t) => (t.employer ? t.amount : 0));
            ded = sum(ec.deductions, (d) => d.amount) + sum(ec.benefits, (b) => b.employee_deduction);
        } else {
            empTax = empTaxShare[i]; erTax = erTaxShare[i];
            ded = Math.max(0, g - net - empTax); // whatever else came out of gross
        }
        rows.push({
            id: docId(orgId, payrollUuid, userId), orgId, source: 'gusto', payrollUuid, userId, employeeId: person.employeeId || null, name: person.name || null, department: person.department || null,
            periodStart: period.start_date || null, periodEnd: period.end_date || null, payDate: payroll.check_date || null, status, currency: 'USD',
            gross: money(g), net: money(net), employeeTaxes: money(empTax), employerTaxes: money(erTax), deductions: money(ded), hours: hoursOf(ec),
            allocated: !detailed, updatedAt: nowIso
        });
    });
    return { rows, unmatched };
}

/** Company totals of a set of rows */
function totalsOf(rows) {
    const t = { gross: 0, net: 0, employeeTaxes: 0, employerTaxes: 0, deductions: 0, hours: 0 };
    rows.forEach((r) => { Object.keys(t).forEach((k) => { t[k] += cents(r[k]); }); });
    return { people: rows.length, ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, money(v)])), employerCost: money(t.gross + t.employerTaxes) };
}

/* ------------------------------------ storage ------------------------------------ */

const col = () => require('../../config/firebase').rawCollection(COLLECTION);

async function listForPayroll(ctx, payrollUuid) {
    if (ctx.listPayResults) return ctx.listPayResults(ctx.orgId, payrollUuid);
    const snap = await col().where('orgId', '==', ctx.orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.payrollUuid === payrollUuid);
}

async function listForOrg(ctx, { from, to } = {}) {
    let rows;
    if (ctx.listPayResults) rows = await ctx.listPayResults(ctx.orgId, null);
    else rows = (await col().where('orgId', '==', ctx.orgId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
    return rows.filter((r) => (!from || (r.payDate || '') >= from) && (!to || (r.payDate || '') <= to));
}

/** Writes (or rewrites) the rows of one payroll. Safe to call again: ids are stable. */
async function store(ctx, payrollUuid, payroll, { status = 'submitted', people } = {}) {
    const links = await ctx.store.listLinks(ctx.orgId, 'employee');
    const nowIso = new Date().toISOString();
    const { rows, unmatched } = buildPayResults({ orgId: ctx.orgId, payrollUuid, payroll, links, people: people || [], status, nowIso });
    if (ctx.savePayResults) await ctx.savePayResults(ctx.orgId, rows);
    else await Promise.all(rows.map(({ id, ...doc }) => col().doc(id).set({ ...doc, createdAt: nowIso }, { merge: true })));
    return { saved: rows.length, unmatched };
}

async function setStatus(ctx, payrollUuid, status) {
    const rows = await listForPayroll(ctx, payrollUuid);
    const nowIso = new Date().toISOString();
    if (ctx.savePayResults) await ctx.savePayResults(ctx.orgId, rows.map((r) => ({ ...r, status, updatedAt: nowIso })));
    else await Promise.all(rows.map((r) => col().doc(r.id).set({ status, updatedAt: nowIso }, { merge: true })));
    return rows.length;
}

/** A cancelled payroll paid nobody: its rows are removed so reports, the journal and the API do not count it */
async function remove(ctx, payrollUuid) {
    const rows = await listForPayroll(ctx, payrollUuid);
    if (ctx.deletePayResults) await ctx.deletePayResults(ctx.orgId, rows.map((r) => r.id));
    else await Promise.all(rows.map((r) => col().doc(r.id).delete()));
    return rows.length;
}

module.exports = { COLLECTION, buildPayResults, totalsOf, share, store, setStatus, remove, listForPayroll, listForOrg };
