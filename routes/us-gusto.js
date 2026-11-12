/**
 * Payroll through Gusto, mounted at /api/us/gusto (company admins) with the public webhook receiver exported
 * as `.webhookReceiver` and mounted at /api/webhooks/gusto.
 *
 *   payroll.view     read status, people links, feed, previews, history, taxes, pay stubs
 *   payroll.run      sync people and time off, prepare / submit / cancel a payroll, retry errors
 *   payroll.connect  connect or disconnect the company, run company setup steps, webhooks
 *
 * Also here: off-cycle payrolls, contractors and contractor payments, W-2 / 1099 forms, garnishments, sending benefit
 * deductions, and state tax answers. Garnishment case numbers are only returned to a reader with people.read_pay.
 *
 * Gusto does the calculations, tax filings and payments. This router only hands over what the services in
 * services/gusto build and never stores bank account numbers or SSNs (they pass straight through to Gusto).
 * Submitting a payroll pays real money in demo/production mode, so it needs an explicit confirmation.
 */
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, findEmployee } = require('./us-hr').helpers;
const { requirePermission, can } = require('../services/permissions');
const logger = require('../utils/logger');
const config = require('../services/gusto/config');
const { makeContext } = require('../services/gusto');
const { defaultStore } = require('../services/gusto/store');
const onboarding = require('../services/gusto/onboarding');
const sync = require('../services/gusto/sync');
const payroll = require('../services/gusto/payroll');
const hooks = require('../services/gusto/webhooks');
const offcycle = require('../services/gusto/offcycle');
const contractors = require('../services/gusto/contractors');
const taxForms = require('../services/gusto/tax-forms');
const garnishments = require('../services/gusto/garnishments');
const garnishmentRules = require('../services/garnishment-rules');
const benefitDeductions = require('../services/gusto/benefits');
const mapping = require('../services/gusto/mapping');
const timeRules = require('../services/time-rules');

const NOTE = 'Gusto calculates pay, files payroll taxes and moves the money. Review every total before you submit: a submitted payroll pays real people.';
const VIEW = [requirePermission('payroll.view'), requireUsOrg];
const RUN = [requirePermission('payroll.run'), requireUsOrg];
const CONNECT = [requirePermission('payroll.connect'), requireUsOrg];
const STEPS = ['terms', 'locations', 'federal_tax', 'industry', 'bank', 'bank_verify', 'pay_schedule', 'employees', 'employee_onboarded', 'state_taxes', 'signatory', 'forms', 'finish', 'approval'];
const EXTRA_KEYS = ['errors', 'blockedBy', 'blockers', 'cutoff', 'feed', 'periods', 'partial'];

const actorOf = (req) => req.user.id || req.user.uid || null;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
/** Today's date in the company's own time zone, as the function the services call (they fall back to the UTC date) */
async function todayFn(orgId) {
    let day = new Date().toISOString().slice(0, 10);
    try { const info = await require('./time').helpers.orgInfo(orgId); day = timeRules.localDate(new Date().toISOString(), info.tz); } catch (_) { /* keep the UTC date */ }
    return () => day;
}

/** Turns a service error into a plain response. Unknown errors go to the app's error handler. */
function sendError(res, e, next) {
    if (!e || e.name !== 'GustoError') return next(e);
    const status = e.status >= 400 && e.status <= 599 ? (e.code === 'unauthorized' || e.code === 'forbidden' ? 502 : e.status) : 502;
    const body = { success: false, error: e.message, code: e.code };
    for (const k of EXTRA_KEYS) if (e[k] !== undefined) body[k] = e[k];
    if (e.retryable) body.retryable = true;
    return res.status(status).json(body);
}
const run = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (e) { sendError(res, e, next); } };

/** Context for this company; refuses early when the Gusto settings for the chosen mode are incomplete. */
async function ctxFor(req, { needConfig = true } = {}) {
    const ctx = await makeContext(req.orgId);
    if (needConfig) {
        const problems = config.validateForMode(ctx.opts);
        if (problems.length) throw Object.assign(new (require('../services/gusto/client').GustoError)(`Gusto is not set up on this server: ${problems.join('; ')}`, { status: 503, code: 'not_configured' }), { errors: problems });
    }
    return ctx;
}

const publicConnection = (conn) => (!conn || !conn.companyUuid ? { connected: false, status: (conn && conn.status) || 'not_connected' } : {
    connected: conn.status === 'connected', status: conn.status, statusNote: conn.statusNote || null, mode: conn.mode || null, companyUuid: conn.companyUuid,
    companyName: conn.companyName || null, adminEmail: conn.adminEmail || null, connectedAt: conn.connectedAt || null, paySchedule: conn.paySchedule || null,
    bankLast4: (conn.onboarding && conn.onboarding.bankLast4) || null, approved: Boolean(conn.onboarding && conn.onboarding.approvedAt)
});

router.use(verifyToken);

/* ------------------------------- status and connection ------------------------------- */

router.get('/status', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req, { needConfig: false });
    const problems = config.validateForMode(ctx.opts);
    const errors = await ctx.store.listErrors(req.orgId);
    const setup = await onboarding.getOnboarding(ctx, { live: false });
    res.json({
        success: true, note: NOTE, mode: ctx.opts.mode, configured: problems.length === 0, configProblems: problems,
        connection: publicConnection(ctx.conn), setup: { next: setup.next || null, approved: Boolean(setup.approved), checkedAt: setup.checkedAt || null },
        openErrors: errors.length, can: { run: can(req.user, 'payroll.run'), connect: can(req.user, 'payroll.connect') }
    });
}));

router.post('/connect', ...CONNECT, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const b = req.body || {};
    const profile = (req.org && req.org.usProfile) || {};
    const input = {
        companyName: b.companyName || profile.legalName || (req.org && req.org.name), tradeName: b.tradeName || undefined, ein: b.ein || profile.ein || undefined,
        admin: { firstName: (b.admin || {}).firstName, lastName: (b.admin || {}).lastName, email: (b.admin || {}).email || req.user.email, phone: (b.admin || {}).phone }
    };
    const out = await onboarding.connectCompany(ctx, input, actorOf(req));
    await audit(req.orgId, req, 'gusto_connected', out.companyUuid, { mode: ctx.opts.mode });
    res.status(201).json({ success: true, ...out, mode: ctx.opts.mode });
}));

router.post('/disconnect', ...CONNECT, run(async (req, res) => {
    if ((req.body || {}).confirm !== true) return res.status(400).json({ success: false, error: 'Send confirm=true to disconnect this company from Gusto.' });
    const ctx = await ctxFor(req, { needConfig: false });
    await onboarding.disconnect(ctx);
    await audit(req.orgId, req, 'gusto_disconnected', req.orgId, {});
    return res.json({ success: true, connection: publicConnection(ctx.conn) });
}));

/* ------------------------------- company setup steps ------------------------------- */

router.get('/setup', ...VIEW, run(async (req, res) => {
    const live = req.query.live === 'true';
    const ctx = await ctxFor(req, { needConfig: live });
    res.json({ success: true, note: NOTE, ...(await onboarding.getOnboarding(ctx, { live })) });
}));

router.post('/setup/:step', ...CONNECT, run(async (req, res) => {
    const step = String(req.params.step);
    if (!STEPS.includes(step)) return res.status(404).json({ success: false, error: `Unknown setup step: ${step}` });
    const ctx = await ctxFor(req);
    const input = { ...(req.body || {}) };
    // who agreed and from where is recorded by the server, never taken from the page
    if (step === 'terms') { input.email = req.user.email || input.email; input.ipAddress = req.ip; input.externalUserId = actorOf(req); }
    if (step === 'forms') input.ipAddress = req.ip;
    const out = await onboarding.runStep(ctx, step, input);
    await audit(req.orgId, req, 'gusto_setup_step', step, {});
    return res.json({ success: true, ...out });
}));

/* ------------------------------- people ------------------------------- */

router.get('/people', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req, { needConfig: false });
    const [people, links] = await Promise.all([sync.loadPeople(ctx), ctx.store.listLinks(req.orgId, 'employee')]);
    const byId = new Map(links.map((l) => [l.ourId, l]));
    const rows = people.map((p) => {
        const l = byId.get(p.id) || {};
        return {
            userId: p.id, name: p.name, classification: p.classification || null, payType: p.payType || null, active: p.active !== false,
            inGusto: Boolean(l.gustoUuid), finishedInGusto: Boolean(l.gusto && l.gusto.onboarded), syncState: l.syncState || (l.gustoUuid ? 'synced' : 'not_sent'),
            blockedReasons: l.blockedReasons || null, lastError: l.lastError || null, lastSyncedAt: l.lastSyncedAt || null, drift: l.drift || [],
            bank: !(p.bank && p.bank.length) ? 'none' : (l.hashes && l.hashes.bank) ? 'sent' : (l.meta && l.meta.bankNote) ? 'cannot_send' : 'not_sent', bankNote: (l.meta && l.meta.bankNote) || null,
            stateTax: !(p.stateTax && Object.keys(p.stateTax).length) ? 'none' : (l.hashes && l.hashes.stateTax) ? 'sent' : 'not_sent', stateTaxNote: (l.meta && l.meta.stateTaxNote) || null
        };
    });
    res.json({ success: true, data: rows, totals: { people: rows.length, inGusto: rows.filter((r) => r.inGusto).length, finished: rows.filter((r) => r.finishedInGusto).length, blocked: rows.filter((r) => r.syncState === 'blocked').length } });
}));

router.post('/sync/people', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const b = req.body || {};
    const out = await sync.syncPeople(ctx, { ids: Array.isArray(b.userIds) && b.userIds.length ? b.userIds.map(String) : null, overwrite: b.overwrite === true, force: b.force === true });
    await audit(req.orgId, req, 'gusto_people_synced', req.orgId, { total: out.total, synced: out.synced, blocked: out.blocked, errors: out.errors, overwrite: b.overwrite === true });
    res.json({ success: true, ...out });
}));

router.post('/sync/pull', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    res.json({ success: true, ...(await sync.pullPeople(ctx)) });
}));

router.post('/sync/departments', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    res.json({ success: true, ...(await sync.syncDepartments(ctx)) });
}));

router.post('/sync/time-off', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const out = await sync.syncTimeOff(ctx);
    await audit(req.orgId, req, 'gusto_time_off_synced', req.orgId, { total: out.total, synced: out.synced, errors: out.errors });
    res.json({ success: true, ...out });
}));

/* ------------------------------- errors ------------------------------- */

router.get('/errors', ...VIEW, run(async (req, res) => {
    const store = defaultStore();
    const rows = await store.listErrors(req.orgId, { includeResolved: req.query.resolved === 'true' });
    res.json({ success: true, data: rows.map((e) => ({ id: e.id, scope: e.scope, ref: e.ref, code: e.code || null, message: e.message, at: e.at, attempts: e.attempts || 1, resolved: Boolean(e.resolved) })) });
}));

router.post('/errors/:id/retry', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const err = await ctx.store.getError(req.orgId, String(req.params.id));
    if (!err) return res.status(404).json({ success: false, error: 'Error record not found' });
    const out = await sync.retryError(ctx, err);
    return res.json({ success: true, result: out });
}));

/* ------------------------------- payroll ------------------------------- */

function period(req, src) {
    const start = String(src.start || ''); const end = String(src.end || '');
    if (!isDate(start) || !isDate(end)) return null;
    return { start, end };
}

router.get('/payroll/feed', ...VIEW, run(async (req, res) => {
    const p = period(req, req.query);
    if (!p) return res.status(400).json({ success: false, error: 'start and end are needed as dates (YYYY-MM-DD)' });
    const ctx = await ctxFor(req, { needConfig: false });
    return res.json({ success: true, note: NOTE, ...(await payroll.buildFeed(ctx, p.start, p.end)) });
}));

router.get('/payroll/history', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req, { needConfig: false });
    res.json({ success: true, data: await payroll.history(ctx) });
}));

router.get('/payroll/reconciliation', ...VIEW, run(async (req, res) => {
    const p = period(req, req.query);
    if (!p) return res.status(400).json({ success: false, error: 'start and end are needed as dates (YYYY-MM-DD)' });
    const ctx = await ctxFor(req);
    return res.json({ success: true, ...(await payroll.reconciliation(ctx, p.start, p.end)) });
}));

router.post('/payroll/prepare', ...RUN, run(async (req, res) => {
    const p = period(req, req.body || {});
    if (!p) return res.status(400).json({ success: false, error: 'start and end are needed as dates (YYYY-MM-DD)' });
    const ctx = await ctxFor(req);
    const out = await payroll.preparePayroll(ctx, { ...p, actor: actorOf(req) });
    await audit(req.orgId, req, 'gusto_payroll_prepared', out.payrollUuid, { start: p.start, end: p.end, gross: out.totals && out.totals.gross_pay });
    return res.json({ success: true, note: NOTE, ...out });
}));

/** Payroll cost from stored pay results (?from=&to= are pay dates) */
router.get('/payroll/cost', ...VIEW, run(async (req, res) => {
    const ok = (v) => v === undefined || /^\d{4}-\d{2}-\d{2}$/.test(String(v));
    if (!ok(req.query.from) || !ok(req.query.to)) return res.status(400).json({ success: false, error: 'from and to must be dates (YYYY-MM-DD)' });
    const ctx = await ctxFor(req, { needConfig: false });
    await audit(req.orgId, req, 'payroll_cost_viewed', null, { from: req.query.from || null, to: req.query.to || null });
    return res.json({ success: true, note: NOTE, ...(await payroll.cost(ctx, { from: req.query.from, to: req.query.to })) });
}));

/** What each person was paid in one submitted payroll */
router.get('/payroll/:id/register', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req, { needConfig: false });
    const out = await payroll.register(ctx, String(req.params.id));
    await audit(req.orgId, req, 'payroll_register_viewed', out.payrollUuid, { rows: out.rows.length });
    return res.json({ success: true, note: NOTE, ...out });
}));

router.get('/payroll/:id', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req);
    res.json({ success: true, note: NOTE, ...(await payroll.previewPayroll(ctx, String(req.params.id))) });
}));

router.post('/payroll/:id/submit', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const b = req.body || {};
    const id = String(req.params.id);
    let out;
    try {
        out = await payroll.submitPayroll(ctx, id, { confirm: b.confirm === true, confirmPayrollId: String(b.confirmPayrollId || ''), acceptLate: b.acceptLate === true, actor: actorOf(req) });
    } catch (e) {
        await audit(req.orgId, req, 'gusto_payroll_submit_refused', id, { code: e.code || 'error' });
        throw e;
    }
    await audit(req.orgId, req, 'gusto_payroll_submitted', id, { gross: out.totals && out.totals.gross_pay, mode: ctx.opts.mode, acceptedLate: b.acceptLate === true });
    res.json({ success: true, ...out });
}));

router.post('/payroll/:id/cancel', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const out = await payroll.cancelPayroll(ctx, String(req.params.id), { actor: actorOf(req) });
    await audit(req.orgId, req, 'gusto_payroll_cancelled', out.payrollUuid, { status: out.status });
    res.json({ success: true, ...out });
}));

router.post('/payroll/:id/refresh', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const rec = await payroll.refreshPayroll(ctx, String(req.params.id));
    if (!rec) return res.status(404).json({ success: false, error: 'We have no payroll with that id.' });
    return res.json({ success: true, payrollUuid: rec.payrollUuid, status: rec.status, lastCheckedAt: rec.lastCheckedAt, receipt: rec.receipt || null });
}));

/* ------------------------------- taxes and pay stubs ------------------------------- */

router.get('/taxes', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req);
    res.json({ success: true, note: 'Read from Gusto. Gusto files and pays these; nothing is filed from this screen.', ...(await payroll.taxFilings(ctx)) });
}));

// Each person may read their own pay stubs; payroll roles may read anyone's in their company.
router.get('/my/pay-stubs', requireUsOrg, run(async (req, res) => {
    const ctx = await ctxFor(req);
    try { res.json({ success: true, data: await payroll.payStubs(ctx, actorOf(req)) }); } catch (e) {
        if (e.code === 'not_linked' || e.code === 'not_connected') return res.json({ success: true, data: [], note: 'No pay stubs yet.' });
        throw e;
    }
    return undefined;
}));

router.get('/pay-stubs/:userId', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const userId = String(req.params.userId);
    const data = await payroll.payStubs(ctx, userId);
    await audit(req.orgId, req, 'gusto_pay_stubs_viewed', userId, {});
    res.json({ success: true, data });
}));

/* ------------------------------- off-cycle payrolls (US-F06) ------------------------------- */

// Creating one prepares it. After that it is an ordinary prepared payroll: review it with GET /payroll/:id, pay it
// with POST /payroll/:id/submit (same typed confirmation, same double-submit guard), drop it with POST /payroll/:id/cancel.
router.get('/off-cycle/options', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req, { needConfig: false });
    res.json({ success: true, note: NOTE, reasons: offcycle.REASONS, people: await offcycle.candidates(ctx) });
}));

router.post('/off-cycle', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    ctx.today = await todayFn(req.orgId);
    const b = req.body || {};
    const out = await offcycle.createOffCycle(ctx, { reason: b.reason, checkDate: b.checkDate, start: b.start, end: b.end, skipRegularDeductions: b.skipRegularDeductions, allowRepeat: b.allowRepeat === true, people: b.people }, { actor: actorOf(req) });
    await audit(req.orgId, req, 'gusto_off_cycle_prepared', out.payrollUuid, { reason: out.reason, checkDate: out.checkDate, people: out.entered.length, gross: out.totals && out.totals.gross_pay });
    res.status(out.reused ? 200 : 201).json({ success: true, note: NOTE, ...out });
}));

/* ------------------------------- contractors and contractor payments (US-F07) ------------------------------- */

const CONTRACTOR_NOTE = 'A contractor payment is recorded in Gusto for the 1099 with the method "Check": you pay the contractor yourself. Each recorded payment is also written to the 1099 payment ledger here.';

router.get('/contractors', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req, { needConfig: false });
    const data = await contractors.listContractors(ctx);
    res.json({ success: true, note: CONTRACTOR_NOTE, data, totals: { contractors: data.length, inGusto: data.filter((c) => c.inGusto).length, blocked: data.filter((c) => c.syncState === 'blocked').length } });
}));

router.post('/sync/contractors', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const b = req.body || {};
    const out = await contractors.syncContractors(ctx, { ids: Array.isArray(b.contractorIds) && b.contractorIds.length ? b.contractorIds.map(String) : null });
    await audit(req.orgId, req, 'gusto_contractors_synced', req.orgId, { total: out.total, synced: out.synced, blocked: out.blocked, errors: out.errors });
    res.json({ success: true, ...out });
}));

router.get('/contractor-payments', ...VIEW, run(async (req, res) => {
    const y = req.query.year === undefined ? null : Number(req.query.year);
    if (y !== null && !(Number.isInteger(y) && y >= 2000 && y <= 2100)) return res.status(400).json({ success: false, error: 'year must be a year like 2026' });
    const ctx = await ctxFor(req, { needConfig: false });
    const data = await contractors.listPayments(ctx, { year: y });
    await audit(req.orgId, req, 'gusto_contractor_payments_viewed', null, { year: y, rows: data.length });
    return res.json({ success: true, note: CONTRACTOR_NOTE, data });
}));

router.post('/contractor-payments', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    ctx.today = await todayFn(req.orgId);
    const b = req.body || {};
    const out = await contractors.createPayment(ctx, { contractorId: b.contractorId, date: b.date, amount: b.amount, hours: b.hours, rate: b.rate, reimbursement: b.reimbursement, memo: b.memo, requestId: b.requestId, allowDuplicate: b.allowDuplicate === true }, { actor: actorOf(req) });
    if (!out.duplicate) await audit(req.orgId, req, 'gusto_contractor_payment_recorded', out.payment.contractorId, { paymentId: out.payment.id, date: out.payment.date, amount: out.payment.amount, reimbursement: out.payment.reimbursement, inLedger: out.payment.inLedger });
    res.status(out.duplicate ? 200 : 201).json({ success: true, ...out });
}));

router.post('/contractor-payments/:id/cancel', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const payment = await contractors.cancelPayment(ctx, String(req.params.id), { actor: actorOf(req), reason: (req.body || {}).reason });
    await audit(req.orgId, req, 'gusto_contractor_payment_cancelled', payment.contractorId, { paymentId: payment.id, amount: payment.amount });
    res.json({ success: true, payment });
}));

// Writes the 1099 ledger rows of a recorded payment whose first ledger write failed (it cannot write them twice)
router.post('/contractor-payments/:id/ledger', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req, { needConfig: false });
    ctx.today = await todayFn(req.orgId);
    const payment = await contractors.ensureLedger(ctx, String(req.params.id));
    await audit(req.orgId, req, 'gusto_contractor_payment_ledger_written', payment.contractorId, { paymentId: payment.id });
    res.json({ success: true, payment });
}));

/* ------------------------------- W-2 and 1099 forms (US-F10) ------------------------------- */

const FORMS_NOTE = 'Gusto prepares and files W-2 and 1099 forms. This list shows which years are ready.';
function sendPdf(res, file) {
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${file.filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.send(file.buffer);
}

router.get('/tax-forms', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const out = await taxForms.availability(ctx);
    await audit(req.orgId, req, 'gusto_tax_forms_listed', null, { employees: out.employees.length, contractors: out.contractors.length });
    res.json({ success: true, note: FORMS_NOTE, ...out });
}));

// Each person may read their own W-2 list and files. The form id is checked against that person's own list.
router.get('/my/tax-forms', requireUsOrg, run(async (req, res) => {
    const ctx = await ctxFor(req);
    try { return res.json({ success: true, data: await taxForms.formsFor(ctx, 'employee', actorOf(req)) }); } catch (e) {
        if (e.code === 'not_connected') return res.json({ success: true, data: [] });
        throw e;
    }
}));

router.get('/my/tax-forms/:formId/pdf', requireUsOrg, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const file = await taxForms.pdf(ctx, 'employee', actorOf(req), String(req.params.formId));
    await audit(req.orgId, req, 'gusto_my_tax_form_downloaded', actorOf(req), { year: file.form.year });
    return sendPdf(res, file);
}));

router.get('/tax-forms/:kind/:ownerId/:formId/pdf', ...VIEW, run(async (req, res) => {
    const kind = String(req.params.kind);
    if (!['employee', 'contractor'].includes(kind)) return res.status(400).json({ success: false, error: 'kind must be employee or contractor' });
    const ctx = await ctxFor(req);
    const file = await taxForms.pdf(ctx, kind, String(req.params.ownerId), String(req.params.formId));
    await audit(req.orgId, req, 'gusto_tax_form_downloaded', String(req.params.ownerId), { kind, year: file.form.year });
    return sendPdf(res, file);
}));

/* ------------------------------- garnishments (US-F11) ------------------------------- */

// payroll.run writes. The case number is only put in a response for a reader with people.read_pay.
const mayReadCase = (req) => can(req.user, 'people.read_pay');
const hideCase = (req, g) => (mayReadCase(req) ? g : { ...g, caseNumber: null, caseNumberHidden: true, remittanceNumber: null });

router.get('/garnishments', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req, { needConfig: false });
    ctx.today = await todayFn(req.orgId);
    const showCase = mayReadCase(req);
    const data = await garnishments.list(ctx, { showCase, userId: req.query.userId ? String(req.query.userId) : null });
    await audit(req.orgId, req, showCase ? 'garnishments_viewed_with_case_numbers' : 'garnishments_viewed', null, { rows: data.length });
    res.json({ success: true, note: garnishments.NOTE, data, types: Object.fromEntries(Object.entries(garnishmentRules.TYPES).map(([k, v]) => [k, v.label])), paymentPeriods: garnishmentRules.PAYMENT_PERIODS, can: { write: can(req.user, 'payroll.run'), readCase: showCase } });
}));

router.post('/garnishments', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    ctx.today = await todayFn(req.orgId);
    const g = await garnishments.create(ctx, req.body || {}, { actor: actorOf(req) });
    await audit(req.orgId, req, 'garnishment_recorded', g.userId, { garnishmentId: g.id, type: g.type, amountType: g.amountType, sent: g.provider.state === 'sent' }); // never the case number
    res.status(201).json({ success: true, note: garnishments.NOTE, garnishment: hideCase(req, g) });
}));

router.post('/garnishments/:id/send', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    ctx.today = await todayFn(req.orgId);
    const g = await garnishments.send(ctx, String(req.params.id));
    await audit(req.orgId, req, 'garnishment_sent', g.userId, { garnishmentId: g.id, state: g.provider.state });
    res.json({ success: true, garnishment: hideCase(req, g) });
}));

router.post('/garnishments/:id/end', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    ctx.today = await todayFn(req.orgId);
    const out = await garnishments.end(ctx, String(req.params.id), { endDate: (req.body || {}).endDate, reason: (req.body || {}).reason }, { actor: actorOf(req) });
    await audit(req.orgId, req, out.planned ? 'garnishment_end_planned' : 'garnishment_ended', out.garnishment.userId, { garnishmentId: out.garnishment.id, endDate: out.garnishment.endDate });
    res.json({ success: true, planned: out.planned, garnishment: hideCase(req, out.garnishment) });
}));

/* ------------------------------- benefit deductions (US-G03) ------------------------------- */

const DEDUCTION_NOTE = 'Amounts are per pay period and come from the benefits deduction feed. Sending sets each person\'s deduction in Gusto; Gusto takes it from pay. Check 401(k) company match in Gusto: it is sent as an estimate.';

router.get('/benefit-deductions/preview', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req);
    ctx.today = await todayFn(req.orgId);
    const out = await benefitDeductions.preview(ctx, { periodEnd: req.query.periodEnd ? String(req.query.periodEnd) : undefined });
    const last = await benefitDeductions.lastRun(ctx);
    await audit(req.orgId, req, 'gusto_benefit_deductions_previewed', null, { periodEnd: out.periodEnd, rows: out.rows.length });
    res.json({ success: true, note: DEDUCTION_NOTE, ...out, lastSent: last ? { at: last.at, periodEnd: last.periodEnd, sent: last.sent, failed: last.failed } : null });
}));

router.post('/benefit-deductions/send', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    ctx.today = await todayFn(req.orgId);
    const b = req.body || {};
    if (b.confirm !== true) return res.status(400).json({ success: false, error: 'Send confirm=true and the fingerprint of the preview you reviewed.' });
    const out = await benefitDeductions.send(ctx, { periodEnd: b.periodEnd ? String(b.periodEnd) : undefined, fingerprint: String(b.fingerprint || ''), actor: actorOf(req) });
    await audit(req.orgId, req, 'gusto_benefit_deductions_sent', null, { periodEnd: out.periodEnd, sent: out.sent, failed: out.failed });
    return res.json({ success: true, note: DEDUCTION_NOTE, ...out });
}));

/* ------------------------------- state tax answers (US-F03) ------------------------------- */

// The questions come from Gusto (they differ by state). The answers are kept on the person's record
// (usForms.stateTax) and sent with the people sync, or right away from here.
async function personFor(req, res) {
    const emp = await findEmployee(req.orgId, String(req.params.userId));
    if (!emp) { res.status(404).json({ success: false, error: 'Person not found' }); return null; }
    return emp;
}

router.get('/people/:userId/state-tax', ...VIEW, run(async (req, res) => {
    const emp = await personFor(req, res); if (!emp) return undefined;
    const ctx = await ctxFor(req);
    const out = await sync.stateTaxFor(ctx, mapping.personFromDoc(emp.id, emp.data));
    return res.json({ success: true, note: 'The questions are the ones Gusto asks for each state. Confirm the answers with the person\'s state withholding form.', userId: emp.id, name: emp.data.name || null, ...out });
}));

router.put('/people/:userId/state-tax', ...RUN, run(async (req, res) => {
    const emp = await personFor(req, res); if (!emp) return undefined;
    const { errors, value } = mapping.validateStateTaxAnswers(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ctx = await ctxFor(req);
    const rec = { answers: value.answers, updatedAt: new Date().toISOString(), updatedBy: actorOf(req) };
    // replace this state's answers as a whole (a merge would keep answers that were cleared)
    const stateTax = { ...((emp.data.usForms && emp.data.usForms.stateTax) || {}), [value.state]: rec };
    await emp.ref.update({ 'usForms.stateTax': stateTax });
    await audit(req.orgId, req, 'gusto_state_tax_saved', emp.id, { state: value.state, answers: Object.keys(value.answers).length });
    const person = mapping.personFromDoc(emp.id, { ...emp.data, usForms: { ...(emp.data.usForms || {}), stateTax } });
    try {
        const out = await sync.sendStateTax(ctx, person);
        return res.json({ success: true, saved: true, sentToGusto: true, ...out });
    } catch (e) {
        if (e.code === 'not_linked' || e.code === 'not_connected') return res.json({ success: true, saved: true, sentToGusto: false, note: 'Saved. It will be sent when this person is sent to Gusto.' });
        throw e;
    }
}));

/* ------------------------------- webhooks ------------------------------- */

router.get('/webhooks/health', ...VIEW, run(async (req, res) => {
    const ctx = await ctxFor(req, { needConfig: false });
    res.json({ success: true, ...(await hooks.health(ctx)) });
}));

router.post('/webhooks/subscribe', ...CONNECT, run(async (req, res) => {
    const ctx = await ctxFor(req);
    const out = await hooks.subscribe(ctx, { publicBaseUrl: (req.body || {}).publicBaseUrl });
    await audit(req.orgId, req, 'gusto_webhooks_subscribed', out.subscriptionUuid, { url: out.url });
    res.status(201).json({ success: true, ...out });
}));

router.post('/webhooks/poll', ...RUN, run(async (req, res) => {
    const ctx = await ctxFor(req);
    res.json({ success: true, ...(await hooks.pollEvents(ctx)) });
}));

/* ------------------------------- public webhook receiver ------------------------------- */

// Mounted at /api/webhooks/gusto. No login: every event is checked against Gusto's signature with the company's
// verification token. middleware/observability.js keeps the exact bytes in req.rawBody for that check.
const webhookReceiver = express.Router();
webhookReceiver.post('/:orgId', async (req, res) => {
    const orgId = String(req.params.orgId);
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(orgId)) return res.status(404).json({ success: false });
    try {
        const raw = req.rawBody !== undefined ? req.rawBody : JSON.stringify(req.body || {});
        const out = await hooks.receive(orgId, raw, req.headers, { store: defaultStore(), makeContext });
        return res.status(out.status).json(out.body);
    } catch (e) {
        logger.error(`gusto webhook for ${orgId} failed: ${e.message}`);
        return res.status(500).json({ success: false });
    }
});

// Backstop for missed webhooks: poll Gusto's events for every connected company. Off unless GUSTO_POLL_JOB=on.
let stopPoll = null;
function startJobs() {
    if (stopPoll || process.env.GUSTO_POLL_JOB !== 'on') return false;
    stopPoll = hooks.startPollJob({ makeContext, store: defaultStore(), log: logger });
    return true;
}

module.exports = router;
module.exports.webhookReceiver = webhookReceiver;
module.exports.startJobs = startJobs;
module.exports.STEPS = STEPS;
