/**
 * Company onboarding with Gusto: a state machine with per-step status (see rules.computeOnboardingSteps).
 * Status comes from what Gusto reports (live reads) plus a little local state (gusto_connections.onboarding).
 * Sensitive inputs (bank account number, signatory SSN) go straight to Gusto and are never stored or logged;
 * we keep only the Gusto ids and the last 4 digits of the account number.
 */
const rules = require('./rules');
const sync = require('./sync');
const { GustoError } = require('./client');
const { validateRoutingNumber, validateEin } = require('../us-validation');

const ENTITY_TO_GUSTO = { sole_proprietorship: 'Sole proprietor', partnership: 'Partnership', llc: 'LLC', s_corp: 'S-Corporation', c_corp: 'C-Corporation', nonprofit: 'Non-profit' }; // VERIFY enum spelling
const nowIso = () => new Date().toISOString();
const cid = (ctx) => { if (!ctx.conn || !ctx.conn.companyUuid) throw new GustoError('This company is not connected to Gusto', { status: 409, code: 'not_connected' }); return ctx.conn.companyUuid; };
const onboardingOf = (ctx) => (ctx.conn && ctx.conn.onboarding) || {};
const errMessage = (e) => (e && e.message ? String(e.message).slice(0, 400) : 'Unknown error');

async function saveOnboarding(ctx, patch) {
    await ctx.store.saveConnection(ctx.orgId, { onboarding: patch });
    ctx.conn = await ctx.store.getConnection(ctx.orgId);
}

/* ------------------------------- connect / disconnect ------------------------------- */

/**
 * Creates the partner-managed company at Gusto with the system token and stores the company tokens.
 * input: { companyName, tradeName?, ein?, admin: { firstName, lastName, email, phone? } }
 */
async function connectCompany(ctx, input, actor) {
    const { store, orgId, client } = ctx;
    const existing = await store.getConnection(orgId);
    if (existing && existing.companyUuid && existing.status === 'connected') throw new GustoError('This company is already connected to Gusto', { status: 409, code: 'already_connected' });
    const errors = [];
    if (!input.companyName) errors.push('companyName is required');
    const a = input.admin || {};
    if (!a.firstName || !a.lastName || !a.email) errors.push('admin firstName, lastName and email are required');
    let ein = null;
    if (input.ein) { const v = validateEin(input.ein); if (!v.valid) errors.push(v.error); else ein = v.formatted.replace('-', ''); }
    if (errors.length) { const e = new GustoError(errors.join('; '), { status: 400, code: 'validation' }); e.errors = errors; throw e; }
    const body = { user: { first_name: a.firstName, last_name: a.lastName, email: a.email, ...(a.phone ? { phone: String(a.phone).replace(/\D/g, '') } : {}) }, company: { name: input.companyName, ...(input.tradeName ? { trade_name: input.tradeName } : {}), ...(ein ? { ein } : {}) } };
    const created = await client.post('/v1/partner_managed_companies', body, { as: 'system', idempotencyKey: `kylrx:${orgId}:company:${(existing && existing.connectAttempt) || 1}` });
    if (!created.company_uuid || !created.access_token || !created.refresh_token) throw new GustoError('Gusto did not return the company and its tokens', { code: 'bad_response' });
    // A new company at Gusto: nothing remembered about an earlier one may carry over (ids of people, locations and
    // pay schedules there, or a setup that was already finished and approved).
    if (!existing || existing.companyUuid !== created.company_uuid) {
        for (const l of await store.listLinks(orgId)) await store.deleteLink(orgId, l.kind, l.ourId);
    }
    await store.saveCompanyTokens(orgId, { accessToken: created.access_token, refreshToken: created.refresh_token, expiresAt: Date.now() + (Number(created.expires_in) || 7200) * 1000 });
    await store.saveConnection(orgId, {
        mode: ctx.opts.mode, companyUuid: created.company_uuid, status: 'connected', statusNote: null, connectedAt: nowIso(), connectedBy: actor || null,
        companyName: input.companyName, adminEmail: a.email, connectAttempt: ((existing && existing.connectAttempt) || 1) + 1, paySchedule: null,
        onboarding: { termsAcceptedAt: null, termsAcceptedBy: null, finishedAt: null, approvedAt: null, snapshot: null, bankAccountUuid: null, bankLast4: null, signatoryUuid: null, errors: {} },
        webhook: { status: null, subscriptionUuid: null, lastEventUuid: null }
    });
    ctx.conn = await store.getConnection(orgId);
    return { companyUuid: created.company_uuid };
}

async function disconnect(ctx) {
    await ctx.store.clearCompanyTokens(ctx.orgId);
    await ctx.store.saveConnection(ctx.orgId, { status: 'disconnected', disconnectedAt: nowIso() });
    ctx.conn = await ctx.store.getConnection(ctx.orgId);
}

/* ------------------------------- facts + steps ------------------------------- */

async function gatherFacts(ctx) {
    const c = cid(ctx);
    const { client, store, orgId } = ctx;
    const ob = onboardingOf(ctx);
    const safe = async (fn, fallback) => { try { return await fn(); } catch (e) { if (e.code === 'not_found' || e.status === 404) return fallback; throw e; } };
    const [locations, fed, industry, banks, schedules, employees, taxReqs, signatories, forms, company] = await Promise.all([
        safe(() => client.get(`/v1/companies/${c}/locations`), []),
        safe(() => client.get(`/v1/companies/${c}/federal_tax_details`), null),
        safe(() => client.get(`/v1/companies/${c}/industry_selection`), null),
        safe(() => client.get(`/v1/companies/${c}/bank_accounts`), []),
        safe(() => client.get(`/v1/companies/${c}/pay_schedules`), []),
        safe(() => client.paginate(`/v1/companies/${c}/employees`), []),
        safe(() => client.get(`/v1/companies/${c}/tax_requirements`), []),
        safe(() => client.get(`/v1/companies/${c}/signatories`), []),
        safe(() => client.get(`/v1/companies/${c}/forms`), []),
        safe(() => client.get(`/v1/companies/${c}`), {})
    ]);
    const links = (await store.listLinks(orgId, 'employee')).filter((l) => l.gustoUuid);
    const gStatus = String(company.company_status || '').toLowerCase();
    const requiredForms = forms.filter((f) => f.requires_signing !== false);
    return {
        company: true, terms: Boolean(ob.termsAcceptedAt), locations: locations.length, federalTax: Boolean(fed && (fed.legal_name || fed.has_ein) && fed.legal_name), industry: Boolean(industry && (industry.naics_code || industry.title)),
        bank: banks.length > 0, bankVerified: banks.some((b) => b.verification_status === 'verified'), bankVerifyPending: banks.some((b) => b.verification_status !== 'verified'),
        paySchedule: schedules.length, employees: Math.max(employees.length, links.length), employeeOnboarded: employees.filter((e) => e.onboarded).length,
        stateTaxes: { required: taxReqs.length, done: taxReqs.filter((t) => t.setup_complete).length }, stateTaxesChecked: false,
        signatory: signatories.length > 0, forms: { total: requiredForms.length, signed: requiredForms.filter((f) => f.signed).length },
        finished: Boolean(ob.finishedAt), approved: Boolean(ob.approvedAt) || gStatus === 'approved', errors: ob.errors || {}
    };
}

/** Steps with live status. live=false returns the last stored snapshot (no Gusto calls). */
async function getOnboarding(ctx, { live = false } = {}) {
    if (!ctx.conn || !ctx.conn.companyUuid) return { connected: false, steps: rules.computeOnboardingSteps({}).map((s) => ({ ...s, status: s.key === 'company' ? 'ready' : 'blocked', blockedBy: s.key === 'company' ? [] : ['Create the company in Gusto'] })), next: 'company', approved: false };
    const ob = onboardingOf(ctx);
    if (!live && ob.snapshot) return { connected: true, ...ob.snapshot, stale: true };
    const facts = await gatherFacts(ctx);
    const steps = rules.computeOnboardingSteps(facts);
    const next = rules.nextOnboardingStep(steps);
    const snapshot = { steps, next: next ? next.key : null, approved: Boolean(facts.approved), checkedAt: nowIso() };
    if (facts.approved && !ob.approvedAt) snapshot.approvedAt = nowIso();
    await saveOnboarding(ctx, { snapshot, ...(facts.approved && !ob.approvedAt ? { approvedAt: nowIso() } : {}) });
    return { connected: true, ...snapshot };
}

/* ------------------------------- step actions ------------------------------- */

async function setStepError(ctx, key, message) {
    await saveOnboarding(ctx, { errors: { [key]: message } });
}

const actions = {
    async terms(ctx, input) {
        const c = cid(ctx);
        if (!input.email || !input.ipAddress || !input.externalUserId) throw new GustoError('email, ipAddress and externalUserId are required', { status: 400, code: 'validation' });
        await ctx.client.post(`/v1/partner_managed_companies/${c}/accept_terms_of_service`, { email: input.email, ip_address: input.ipAddress, external_user_id: input.externalUserId }, { as: 'system' });
        await saveOnboarding(ctx, { termsAcceptedAt: nowIso(), termsAcceptedBy: input.email });
        return { accepted: true };
    },
    async locations(ctx) {
        const r = await sync.syncLocations(ctx);
        if (r.status === 'blocked') throw new GustoError(r.reason, { status: 409, code: 'blocked' });
        return r;
    },
    async federal_tax(ctx, input) {
        const c = cid(ctx);
        const org = ctx.org || (await loadOrg(ctx));
        const p = org.usProfile || {};
        const legalName = input.legalName || p.legalName;
        const ein = input.ein || p.ein;
        const entity = input.taxPayerType || ENTITY_TO_GUSTO[p.entityType];
        if (!legalName || !ein || !entity) throw new GustoError('Legal name, EIN and entity type are needed (fill in the Company profile or send them)', { status: 400, code: 'validation' });
        const e = validateEin(ein); if (!e.valid) throw new GustoError(e.error, { status: 400, code: 'validation' });
        const body = { legal_name: legalName, ein: e.formatted.replace('-', ''), tax_payer_type: entity, filing_form: input.filingForm || '941', taxable_as_scorp: p.entityType === 's_corp' };
        await ctx.client.putVersioned(`/v1/companies/${c}/federal_tax_details`, `/v1/companies/${c}/federal_tax_details`, () => body);
        return { saved: true };
    },
    async industry(ctx, input) {
        const c = cid(ctx);
        if (!input.naicsCode && !input.title) throw new GustoError('Choose the industry (NAICS code or title)', { status: 400, code: 'validation' });
        await ctx.client.put(`/v1/companies/${c}/industry_selection`, { naics_code: input.naicsCode || undefined, title: input.title || undefined, sic_codes: input.sicCodes || [] });
        return { saved: true };
    },
    async bank(ctx, input) {
        const c = cid(ctx);
        const r = validateRoutingNumber(input.routingNumber);
        if (!r.valid) throw new GustoError(r.error, { status: 400, code: 'validation' });
        const acct = String(input.accountNumber || '').replace(/\D/g, '');
        if (acct.length < 4 || acct.length > 17) throw new GustoError('Account number must have 4 to 17 digits', { status: 400, code: 'validation' });
        const type = String(input.accountType || 'checking').toLowerCase() === 'savings' ? 'Savings' : 'Checking';
        const b = await ctx.client.post(`/v1/companies/${c}/bank_accounts`, { routing_number: r.digits, account_number: acct, account_type: type });
        await saveOnboarding(ctx, { bankAccountUuid: b.uuid, bankLast4: acct.slice(-4) });
        return { bankAccountUuid: b.uuid, last4: acct.slice(-4), verification: b.verification_status || 'awaiting_deposits' };
    },
    async bank_verify(ctx, input) {
        const c = cid(ctx);
        const banks = await ctx.client.get(`/v1/companies/${c}/bank_accounts`);
        const target = banks.find((b) => b.uuid === onboardingOf(ctx).bankAccountUuid) || banks.find((b) => b.verification_status !== 'verified');
        if (!target) throw new GustoError('Add the bank account first', { status: 409, code: 'blocked' });
        const d1 = Number(input.deposit1); const d2 = Number(input.deposit2);
        if (!(d1 > 0) || !(d2 > 0) || d1 >= 1 || d2 >= 1) throw new GustoError('Enter the two small deposit amounts in dollars (for example 0.12)', { status: 400, code: 'validation' });
        const v = await ctx.client.put(`/v1/companies/${c}/bank_accounts/${target.uuid}/verify`, { deposit_1: d1, deposit_2: d2 });
        return { verification: v.verification_status };
    },
    async pay_schedule(ctx, input) {
        const settings = input && input.frequency ? input : (ctx.conn.paySchedule || null);
        if (!settings) throw new GustoError('Choose the pay schedule first (how often, first pay date, end of the pay period)', { status: 400, code: 'validation' });
        const r = await sync.syncPaySchedule(ctx, settings);
        if (r.status === 'invalid') { const e = new GustoError(r.errors.join('; '), { status: 400, code: 'validation' }); e.errors = r.errors; throw e; }
        await ctx.store.saveConnection(ctx.orgId, { paySchedule: settings });
        return r;
    },
    async employees(ctx, input) { return sync.syncPeople(ctx, { ids: input.userIds || null }); },
    async employee_onboarded(ctx, input) {
        const links = (await ctx.store.listLinks(ctx.orgId, 'employee')).filter((l) => l.gustoUuid);
        const target = input.userId ? links.find((l) => l.ourId === input.userId) : links.find((l) => !(l.gusto && l.gusto.onboarded));
        if (!target) throw new GustoError('Sync at least one person to Gusto first', { status: 409, code: 'blocked' });
        await ctx.client.put(`/v1/employees/${target.gustoUuid}/onboarding_status`, { onboarding_status: 'onboarding_completed' });
        await ctx.store.saveLink(ctx.orgId, 'employee', target.ourId, { gusto: { onboarded: true } });
        return { userId: target.ourId, onboarded: true };
    },
    async state_taxes(ctx, input) {
        const c = cid(ctx);
        const reqs = await ctx.client.get(`/v1/companies/${c}/tax_requirements`);
        const results = [];
        for (const r of reqs) {
            const values = (input.states || {})[r.state];
            if (!values || r.setup_complete) { results.push({ state: r.state, status: r.setup_complete ? 'done' : 'missing_input' }); continue; }
            await ctx.client.putVersioned(`/v1/companies/${c}/tax_requirements/${r.state}`, `/v1/companies/${c}/tax_requirements/${r.state}`, (cur) => ({
                requirement_sets: (cur.requirement_sets || []).map((set) => ({ key: set.key, state: set.state, requirements: (set.requirements || []).filter((q) => values[q.key] !== undefined).map((q) => ({ key: q.key, value: String(values[q.key]) })) }))
            }));
            results.push({ state: r.state, status: 'saved' });
        }
        if (results.some((r) => r.status === 'missing_input')) {
            const e = new GustoError(`Still needed: ${results.filter((r) => r.status === 'missing_input').map((r) => r.state).join(', ')}`, { status: 400, code: 'validation' });
            e.partial = results; throw e;
        }
        return { states: results };
    },
    async signatory(ctx, input) {
        const c = cid(ctx);
        for (const f of ['firstName', 'lastName', 'email', 'title']) if (!input[f]) throw new GustoError(`${f} is required`, { status: 400, code: 'validation' });
        const body = { first_name: input.firstName, last_name: input.lastName, email: input.email, title: input.title, phone: String(input.phone || '').replace(/\D/g, '') || undefined, birthday: input.birthday || undefined, ssn: input.ssn ? String(input.ssn).replace(/\D/g, '') : undefined, home_address: input.homeAddress || undefined };
        const s = await ctx.client.post(`/v1/companies/${c}/signatories`, body);
        await saveOnboarding(ctx, { signatoryUuid: s.uuid });
        return { signatoryUuid: s.uuid };
    },
    async forms(ctx, input) {
        const c = cid(ctx);
        if (input.agree !== true || !input.signatureText || String(input.signatureText).trim().length < 3) throw new GustoError('The signatory must type their full name and agree to sign', { status: 400, code: 'validation' });
        const forms = (await ctx.client.get(`/v1/companies/${c}/forms`)).filter((f) => f.requires_signing !== false && !f.signed);
        for (const f of forms) await ctx.client.put(`/v1/forms/${f.uuid}/sign`, { signature_text: String(input.signatureText).trim(), agree: true, signed_by_ip_address: input.ipAddress || '0.0.0.0' });
        return { signed: forms.length };
    },
    async finish(ctx) {
        const c = cid(ctx);
        const r = await ctx.client.put(`/v1/companies/${c}/finish_onboarding`, {});
        await saveOnboarding(ctx, { finishedAt: nowIso() });
        return { submitted: true, status: (r && r.onboarding_status) || 'submitted' };
    },
    async approval(ctx) { return { checked: true }; }
};

async function loadOrg(ctx) {
    const { rawCollection } = require('../../config/firebase');
    const s = await rawCollection('organizations').doc(ctx.orgId).get();
    return (typeof s.exists === 'function' ? s.exists() : s.exists) ? s.data() : {};
}

/** Run one step. Failure is recorded on the step and rethrown with a plain message. */
async function runStep(ctx, key, input = {}) {
    if (!actions[key]) throw new GustoError(`Unknown step: ${key}`, { status: 400, code: 'validation' });
    if (!ctx.conn || !ctx.conn.companyUuid) throw new GustoError('Create the company in Gusto first', { status: 409, code: 'not_connected' });
    const before = await getOnboarding(ctx, { live: true });
    const step = before.steps.find((s) => s.key === key);
    if (step && step.status === 'blocked') throw Object.assign(new GustoError(`Not yet: finish first: ${step.blockedBy.join(', ')}`, { status: 409, code: 'blocked' }), { blockedBy: step.blockedBy });
    let result;
    try {
        result = await actions[key](ctx, input);
        await saveOnboarding(ctx, { errors: { [key]: null } });
    } catch (e) {
        await setStepError(ctx, key, errMessage(e));
        throw e;
    }
    const after = await getOnboarding(ctx, { live: true });
    return { result, ...after };
}

/** Called by the webhook processor on company.approved */
async function markApproved(ctx) {
    if (!ctx.conn) return;
    await saveOnboarding(ctx, { approvedAt: onboardingOf(ctx).approvedAt || nowIso() });
}

module.exports = { connectCompany, disconnect, getOnboarding, runStep, markApproved, gatherFacts, ENTITY_TO_GUSTO };
