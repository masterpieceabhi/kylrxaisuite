/**
 * Pure rules for the extra payroll-provider features (no I/O):
 *   off-cycle payrolls, contractors and contractor payments, W-2 / 1099 form lists, benefit deductions.
 *
 * Everything here is proven only against our own mock. Each spot where Gusto's real names or shapes are our
 * best reading of the public API is marked "VERIFY against Gusto".
 */
const crypto = require('crypto');
const rules = require('./rules');

const hash = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 24);
const toCents = (v) => Math.round(Number(v) * 100);
const money = (cents) => (Math.round(cents) / 100).toFixed(2);
const clean = (v) => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
/** A dollar amount with cents at most, between 0 and `max`. Returns cents or null. */
function centsOf(v, max = 1000000) {
    if (v === undefined || v === null || v === '') return 0;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > max) return null;
    if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return null;
    return Math.round(n * 100);
}
const linkOf = (links, id) => (links instanceof Map ? links.get(id) : (links || {})[id]);

/* ------------------------------- off-cycle payrolls ------------------------------- */

/**
 * Our reason -> Gusto's off_cycle_reason and the fixed-compensation line an entered amount goes on.
 * VERIFY against Gusto: the reason strings ("Bonus", "Correction", "Dismissed employee") and the line names
 * ("Bonus", "Correction Payment", "Severance"). For final pay an entered amount is sent as "Severance", which may
 * not be the right line for every final amount (for example unused time off paid out): confirm before real use.
 */
const OFF_CYCLE_REASONS = {
    bonus: { gusto: 'Bonus', fixedName: 'Bonus', label: 'Bonus', skipRegularDeductions: true, supplementalRate: true, allowLeavers: false },
    correction: { gusto: 'Correction', fixedName: 'Correction Payment', label: 'Correction', skipRegularDeductions: true, supplementalRate: false, allowLeavers: false },
    final_pay: { gusto: 'Dismissed employee', fixedName: 'Severance', label: 'Final pay for someone leaving', skipRegularDeductions: false, supplementalRate: false, allowLeavers: true }
};
const MAX_OFF_CYCLE_PEOPLE = 200;

/**
 * input:  { reason, checkDate, start?, end?, skipRegularDeductions?, people: [{ userId, amount?, hours?, note? }] }
 * ctx:    { today, people: [{ id, name, payType, active }], links: Map|object userId -> { gustoUuid, meta:{jobUuid} } }
 * Amounts are dollars with cents at most; hours are for hourly people only and are paid at their regular rate.
 */
function validateOffCycle(input, { today, people = [], links = {} } = {}) {
    const errors = []; const b = input || {};
    const reason = OFF_CYCLE_REASONS[b.reason] ? b.reason : null;
    if (!reason) errors.push(`reason must be one of: ${Object.keys(OFF_CYCLE_REASONS).join(', ')}`);
    const def = OFF_CYCLE_REASONS[reason] || {};
    const checkDate = rules.parseIso(b.checkDate) ? String(b.checkDate) : null;
    if (!checkDate) errors.push('checkDate must be a date (YYYY-MM-DD)');
    else if (today && checkDate < today) errors.push('The pay date cannot be in the past');
    // the work dates this pay is for; when not given, the single day before or on the pay date that is not in the future
    let start = b.start ? String(b.start) : null; let end = b.end ? String(b.end) : null;
    if (!start && !end && checkDate) { start = today && today < checkDate ? today : checkDate; end = start; }
    if (!rules.parseIso(start) || !rules.parseIso(end)) errors.push('start and end must both be dates (YYYY-MM-DD), or both left empty');
    else if (end < start) errors.push('The end of the work dates is before the start');
    else if (Date.parse(end) - Date.parse(start) > 92 * 86400000) errors.push('The work dates cannot span more than 3 months');
    else if (checkDate && end > checkDate) errors.push('The work dates cannot end after the pay date');

    const byId = new Map(people.map((p) => [p.id, p]));
    const rows = [];
    const list = Array.isArray(b.people) ? b.people : [];
    if (!list.length) errors.push('Choose at least one person');
    if (list.length > MAX_OFF_CYCLE_PEOPLE) errors.push(`At most ${MAX_OFF_CYCLE_PEOPLE} people in one off-cycle payroll`);
    const seen = new Set();
    list.slice(0, MAX_OFF_CYCLE_PEOPLE).forEach((r, i) => {
        const at = `people[${i}]`;
        const row = r || {};
        const userId = String(row.userId || '');
        const person = byId.get(userId);
        if (!person) { errors.push(`${at}: this person was not found`); return; }
        const who = person.name || userId;
        if (seen.has(userId)) { errors.push(`${who} is listed twice`); return; }
        seen.add(userId);
        const link = linkOf(links, userId);
        if (!link || !link.gustoUuid) { errors.push(`${who} is not in Gusto yet. Send people to Gusto first.`); return; }
        if (person.active === false && !def.allowLeavers) errors.push(`${who} is no longer active. Use "Final pay for someone leaving".`);
        const amountCents = centsOf(row.amount);
        if (amountCents === null) errors.push(`${who}: the amount must be zero or more, with cents at most`);
        const hours = row.hours === undefined || row.hours === null || row.hours === '' ? 0 : Number(row.hours);
        if (!Number.isFinite(hours) || hours < 0 || hours > 400 || Math.abs(hours * 1000 - Math.round(hours * 1000)) > 1e-6) errors.push(`${who}: hours must be between 0 and 400`);
        else if (hours > 0 && person.payType !== 'hourly') errors.push(`${who} is not paid by the hour, so enter an amount instead of hours`);
        if (amountCents === 0 && !(hours > 0)) errors.push(`${who}: enter an amount or hours`);
        rows.push({ userId, name: person.name || null, employeeUuid: link.gustoUuid, jobUuid: (link.meta && link.meta.jobUuid) || null, amountCents: amountCents || 0, hours: Number.isFinite(hours) ? hours : 0, note: clean(row.note).slice(0, 200) });
    });
    rows.sort((x, y) => x.userId.localeCompare(y.userId));
    const value = {
        reason, gustoReason: def.gusto || null, fixedName: def.fixedName || null, checkDate, start, end,
        skipRegularDeductions: b.skipRegularDeductions === undefined ? Boolean(def.skipRegularDeductions) : b.skipRegularDeductions === true,
        supplementalRate: Boolean(def.supplementalRate), people: rows,
        totals: { people: rows.length, amountCents: rows.reduce((s, r) => s + r.amountCents, 0), hours: Math.round(rows.reduce((s, r) => s + r.hours, 0) * 1000) / 1000 }
    };
    return { errors, value };
}

/** Fingerprint of what was asked for: the same request twice maps to the same off-cycle payroll at the provider */
function offCycleHash(value) {
    return hash([value.reason, value.checkDate, value.start, value.end, value.skipRegularDeductions, value.people.map((p) => [p.userId, p.amountCents, p.hours])]);
}

/**
 * Body for POST /v1/companies/{id}/payrolls.
 * VERIFY against Gusto: off_cycle, off_cycle_reason, start_date, end_date, check_date, employee_uuids,
 * skip_regular_deductions and fixed_withholding_rate are our reading of "Create an off-cycle payroll".
 */
function toGustoOffCycle(value) {
    return {
        off_cycle: true, off_cycle_reason: value.gustoReason, start_date: value.start, end_date: value.end, check_date: value.checkDate,
        employee_uuids: value.people.map((p) => p.employeeUuid), skip_regular_deductions: value.skipRegularDeductions, fixed_withholding_rate: value.supplementalRate
    };
}

/**
 * employee_compensations update for a prepared off-cycle payroll. Only people Gusto put on the payroll are written;
 * the others are returned as `missing` (they have usually not finished onboarding at the provider).
 */
function offCycleCompensations(value, existing = []) {
    const present = new Map(existing.map((ec) => [ec.employee_uuid, ec]));
    const comps = []; const missing = [];
    for (const p of value.people) {
        const ec = present.get(p.employeeUuid);
        if (!ec) { missing.push({ userId: p.userId, name: p.name }); continue; }
        const jobUuid = p.jobUuid || ((ec.fixed_compensations || [])[0] || {}).job_uuid || ((ec.hourly_compensations || [])[0] || {}).job_uuid || null;
        const body = { employee_uuid: p.employeeUuid, excluded: false, fixed_compensations: [{ name: value.fixedName, amount: money(p.amountCents), job_uuid: jobUuid }] };
        // hours are paid at the person's regular hourly rate (multiplier 1); overtime does not belong on an off-cycle entry here
        body.hourly_compensations = p.hours > 0 ? [{ name: 'Regular Hours', job_uuid: jobUuid, hours: (Math.round(p.hours * 1000) / 1000).toFixed(3), compensation_multiplier: 1 }] : [];
        comps.push(body);
    }
    return { comps, missing };
}

/* ------------------------------- contractors ------------------------------- */

const addressOk = (a) => Boolean(a && a.line1 && a.city && a.state && a.zip);

/**
 * contractor: { id, name, businessName, email, active, createdAt, w9: { status, legalName, businessName, taxClassification, tinType, hasTin, address } | null }
 * Returns plain-language reasons the contractor cannot be sent yet, or [].
 */
function contractorProblems(c) {
    const out = [];
    const w = c && c.w9;
    if (!w || w.status !== 'received') { out.push('A W-9 is needed first (legal name, taxpayer ID and address).'); return out; }
    if (!w.hasTin) out.push('The taxpayer ID on the W-9 is missing.');
    if (!addressOk(w.address)) out.push('The address on the W-9 is not complete.');
    if (w.tinType !== 'EIN' && clean(w.legalName).split(' ').length < 2) out.push('The legal name on the W-9 needs a first and a last name.');
    if (w.tinType === 'EIN' && !clean(w.businessName || c.businessName || w.legalName)) out.push('A business name is needed.');
    return out;
}

/**
 * Body for POST /v1/companies/{id}/contractors. A W-9 with an EIN is sent as a business, otherwise as an individual.
 * Every contractor is sent with wage_type "Fixed": hours x rate is worked out here and sent as one wage amount.
 * VERIFY against Gusto: type, wage_type, start_date, self_onboarding, file_new_hire_report, and that an ITIN is
 * accepted in the `ssn` field.
 */
function toGustoContractor(c, tin) {
    const w = c.w9 || {};
    const body = { wage_type: 'Fixed', start_date: String(c.startDate || c.createdAt || '').slice(0, 10), self_onboarding: false, file_new_hire_report: false };
    if (c.email) body.email = c.email;
    const digits = String(tin || '').replace(/\D/g, '');
    if (w.tinType === 'EIN') {
        body.type = 'Business'; body.business_name = clean(w.businessName || c.businessName || w.legalName);
        if (digits) body.ein = digits;
    } else {
        const parts = clean(w.legalName).split(' ');
        body.type = 'Individual'; body.first_name = parts[0] || ''; body.last_name = parts.slice(1).join(' ');
        if (digits) body.ssn = digits;
    }
    return body;
}
const toGustoContractorAddress = (a) => ({ street_1: a.line1, street_2: a.line2 || '', city: a.city, state: a.state, zip: a.zip });
/** What we compare to decide whether a contractor needs re-sending (never includes the taxpayer ID itself) */
const contractorHash = (c) => { const { ssn, ein, ...rest } = toGustoContractor(c, ''); return hash([rest, (c.w9 || {}).tinLast4 || null, (c.w9 || {}).address || null]); };

/**
 * input: { contractorId, date, amount? | hours? + rate?, reimbursement?, memo?, requestId? }
 * Either an amount, or hours and an hourly rate (not both). The date cannot be in the future: a payment is written
 * to the 1099 ledger when it is recorded, and the ledger does not hold future payments.
 */
function validateContractorPayment(input, { today } = {}) {
    const errors = []; const b = input || {};
    const value = { contractorId: String(b.contractorId || '') };
    if (!value.contractorId) errors.push('contractorId is required');
    if (!rules.parseIso(b.date)) errors.push('date must be a date (YYYY-MM-DD)');
    else if (today && String(b.date) > today) errors.push('date cannot be in the future');
    else value.date = String(b.date);
    const has = (v) => v !== undefined && v !== null && v !== '';
    const amountCents = centsOf(b.amount);
    const hours = has(b.hours) ? Number(b.hours) : 0; const rate = has(b.rate) ? Number(b.rate) : 0;
    const byHours = has(b.hours) || has(b.rate);
    if (has(b.amount) && Number(b.amount) > 0 && byHours) errors.push('Send either an amount, or hours and a rate, not both');
    if (amountCents === null) errors.push('amount must be zero or more, with cents at most');
    if (byHours) {
        if (!(hours > 0 && hours <= 2000) || Math.abs(hours * 100 - Math.round(hours * 100)) > 1e-6) errors.push('hours must be above 0 (two decimals at most)');
        if (centsOf(b.rate, 10000) === null || !(rate > 0)) errors.push('rate must be above 0, with cents at most');
    }
    const reimbursementCents = centsOf(b.reimbursement);
    if (reimbursementCents === null) errors.push('reimbursement must be zero or more, with cents at most');
    value.hours = byHours ? hours : null; value.rate = byHours ? rate : null;
    value.wageCents = byHours ? Math.round(hours * rate * 100) : (amountCents || 0);
    value.reimbursementCents = reimbursementCents || 0;
    if (!errors.length && value.wageCents + value.reimbursementCents <= 0) errors.push('Enter an amount, hours and a rate, or a reimbursement');
    if (value.wageCents > 100000000) errors.push('The payment is too large');
    value.memo = clean(b.memo).slice(0, 300);
    if (has(b.requestId)) { if (/^[A-Za-z0-9_-]{8,64}$/.test(String(b.requestId))) value.requestId = String(b.requestId); else errors.push('requestId must be 8 to 64 letters, digits, dashes or underscores'); }
    return { errors, value };
}

/**
 * Body for POST /v1/companies/{id}/contractor_payments. The payment is recorded with method "Check": the provider
 * keeps it for the 1099 and the company pays the contractor itself. Direct deposit needs the contractor's bank
 * account at the provider, which we do not send.
 * VERIFY against Gusto: contractor_uuid, date, payment_method, wage, reimbursement.
 */
function toGustoContractorPayment(value, contractorUuid) {
    return { contractor_uuid: contractorUuid, date: value.date, payment_method: 'Check', wage: money(value.wageCents), reimbursement: money(value.reimbursementCents) };
}

/**
 * The 1099 ledger rows for one provider payment. The ids are fixed by the provider's payment id, so writing them a
 * second time finds the first write and adds nothing. A reimbursement is its own row: it is not 1099 income.
 */
function ledgerRowsFor(payment) {
    const rows = [];
    const base = { contractorId: payment.contractorId, date: payment.date, method: 'check', source: 'gusto', providerPaymentId: payment.gustoUuid };
    const hoursNote = payment.hours ? `${payment.hours} hour(s) at $${Number(payment.rate).toFixed(2)}` : '';
    const text = (kind) => [kind, hoursNote, payment.memo].filter(Boolean).join('. ').slice(0, 300);
    if (payment.wageCents > 0) rows.push({ id: `gusto_${payment.gustoUuid}`, ...base, amount: payment.wageCents / 100, category: 'nonemployee_compensation', description: text('Paid through the payroll provider') });
    if (payment.reimbursementCents > 0) rows.push({ id: `gusto_${payment.gustoUuid}_reimb`, ...base, amount: payment.reimbursementCents / 100, category: 'reimbursement', description: ['Reimbursement through the payroll provider', payment.memo].filter(Boolean).join('. ').slice(0, 300) });
    return rows;
}

/* ------------------------------- W-2 and 1099 forms ------------------------------- */

/**
 * Which tax form a provider form is, from its name and title.
 * VERIFY against Gusto: the exact `name` values for W-2 and 1099 forms (we match loosely on "W-2"/"W2" and "1099").
 */
function classifyForm(f) {
    const text = `${(f && f.name) || ''} ${(f && f.title) || ''}`;
    if (/w[-_ ]?2/i.test(text)) return 'w2';
    if (/1099/.test(text)) return '1099';
    return null;
}
function formYear(f) {
    if (Number.isInteger(Number(f.year)) && Number(f.year) > 1990) return Number(f.year);
    const m = /\b(20\d{2})\b/.exec(`${f.title || ''} ${f.description || ''}`);
    return m ? Number(m[1]) : null;
}
/** Provider forms -> the tax forms of one kind, newest first. Only what a browser may see (no provider links). */
function taxFormsOf(forms, kind) {
    return (Array.isArray(forms) ? forms : []).filter((f) => f && f.uuid && classifyForm(f) === kind)
        .map((f) => ({ id: String(f.uuid), kind, title: clean(f.title || f.name || (kind === 'w2' ? 'W-2' : '1099')).slice(0, 120), year: formYear(f), draft: Boolean(f.draft) }))
        .sort((a, b) => (b.year || 0) - (a.year || 0) || a.title.localeCompare(b.title));
}
const yearsOf = (list) => [...new Set(list.filter((f) => !f.draft && f.year).map((f) => f.year))].sort((a, b) => b - a);

/* ------------------------------- benefit deductions ------------------------------- */

/**
 * Our plan type (and Roth for 401(k)) -> names the provider may list the benefit under, first match wins.
 * The provider's own numbers (benefit_type) are read from GET /v1/benefits by name and never hard-coded.
 * VERIFY against Gusto: these names, especially life and disability.
 */
const BENEFIT_NAMES = {
    medical: ['Medical Insurance'], dental: ['Dental Insurance'], vision: ['Vision Insurance'],
    '401k': ['401(k)'], '401k_roth': ['Roth 401(k)'], hsa: ['Health Savings Account'], fsa: ['Health FSA'],
    life: ['Life Insurance', 'Group-Term Life Insurance', 'Voluntary Life Insurance'],
    disability: ['Short Term Disability', 'Disability Insurance', 'Short Term Disability (post-tax)']
};
const benefitKind = (row) => (row.planType === '401k' && row.taxTreatment === 'roth' ? '401k_roth' : row.planType);
const benefitKey = (row) => `${benefitKind(row)}|${clean(row.planName)}`;

/**
 * Feed rows (services/benefits-rules.js payrollFeed) -> one wanted deduction per person per plan.
 * percents: optional Map "userId|planType|planName" -> 401(k) percent of pay, so a 401(k) is sent as a percent
 * instead of the feed's dollar estimate.
 */
function wantedDeductions(feedRows, percents = new Map()) {
    const out = new Map();
    for (const r of feedRows || []) {
        const key = benefitKey(r); const id = `${r.userId}|${key}`;
        const pct = r.planType === '401k' ? percents.get(`${r.userId}|${r.planType}|${clean(r.planName)}`) : undefined;
        const cur = out.get(id) || { id, userId: r.userId, name: r.name || null, key, kind: benefitKind(r), planType: r.planType, planName: clean(r.planName), taxTreatment: r.taxTreatment, employeeCents: 0, employerCents: 0, percent: null, notes: [] };
        cur.employeeCents += toCents(r.employeeDeduction || 0); cur.employerCents += toCents(r.employerCost || 0);
        if (pct > 0 && pct <= 100) cur.percent = pct;
        out.set(id, cur);
    }
    for (const w of out.values()) {
        if (w.planType === '401k' && w.percent) w.notes.push('Sent as a percent of pay. The company match is sent as an estimated amount per pay period.');
        else if (w.planType === '401k') w.notes.push('Sent as an estimated amount per pay period: the percent chosen was not found.');
    }
    return [...out.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.key.localeCompare(b.key));
}

/** What an employee benefit at the provider looks like once reduced to what we compare */
function readEmployeeBenefit(b) {
    const c = b.contribution || null;
    const employerCents = c && c.type === 'amount' ? toCents(c.value || 0) : c ? null : toCents(b.company_contribution || 0);
    return { active: b.active !== false, percent: b.deduct_as_percentage ? Number(b.employee_deduction) : null, employeeCents: b.deduct_as_percentage ? null : toCents(b.employee_deduction || 0), employerCents };
}
/**
 * Body for an employee benefit. VERIFY against Gusto: employee_deduction, deduct_as_percentage and
 * contribution { type: 'amount', value } (the older company_contribution field is not sent).
 */
function toGustoEmployeeBenefit(w) {
    return { active: true, employee_deduction: w.percent ? String(w.percent) : money(w.employeeCents), deduct_as_percentage: Boolean(w.percent), contribution: { type: 'amount', value: money(w.employerCents) } };
}
const sameBenefit = (w, cur) => cur.active && (w.percent ? cur.percent === w.percent : cur.percent === null && cur.employeeCents === w.employeeCents) && cur.employerCents === w.employerCents;

/**
 * Compare what we want with what the provider holds and say what a send would do.
 *   wanted:          from wantedDeductions()
 *   links:           userId -> { gustoUuid }
 *   catalog:         GET /v1/benefits                  [{ benefit_type, name }]
 *   companyBenefits: GET company_benefits              [{ uuid, benefit_type, description, active }]
 *   current:         Map employeeUuid -> employee_benefits[]
 *   managed:         benefits we sent before           [{ id: "userId|key", userId, name, key, planName, employeeBenefitUuid }]
 * Row actions: create, update, unchanged, end (we sent it before and it is no longer in the feed),
 * not_in_provider (the person is not linked), cannot_send (the provider has no benefit of this kind).
 */
function planDeductions({ wanted = [], links = {}, catalog = [], companyBenefits = [], current = new Map(), managed = [] }) {
    const typeByName = new Map(catalog.map((b) => [String(b.name).toLowerCase(), b.benefit_type]));
    const typeFor = (kind) => { for (const n of BENEFIT_NAMES[kind] || []) if (typeByName.has(n.toLowerCase())) return typeByName.get(n.toLowerCase()); return null; };
    const companyFor = (type, description) => companyBenefits.find((b) => b.benefit_type === type && clean(b.description).toLowerCase() === description.toLowerCase()) || null;
    const rows = []; const createCompany = new Map(); const wantedIds = new Set();
    const usedBenefitUuids = new Set();
    for (const w of wanted) {
        wantedIds.add(w.id);
        const base = { id: w.id, userId: w.userId, name: w.name, key: w.key, kind: w.kind, planName: w.planName, taxTreatment: w.taxTreatment, notes: w.notes || [], wanted: { employee: w.percent ? null : w.employeeCents / 100, percent: w.percent || null, employer: w.employerCents / 100 }, current: null };
        const link = linkOf(links, w.userId);
        if (!link || !link.gustoUuid) { rows.push({ ...base, action: 'not_in_provider', reason: 'This person is not in Gusto yet.' }); continue; }
        const type = typeFor(w.kind);
        if (type === null) { rows.push({ ...base, action: 'cannot_send', reason: `Gusto has no benefit that matches "${w.planType}". Set this one up in Gusto by hand.` }); continue; }
        const company = companyFor(type, w.planName);
        if (!company) createCompany.set(w.key, { key: w.key, benefitType: type, description: w.planName });
        const mine = company ? (current.get(link.gustoUuid) || []).find((b) => b.company_benefit_uuid === company.uuid) : null;
        if (!mine) { rows.push({ ...base, action: 'create', employeeUuid: link.gustoUuid, companyBenefitUuid: company ? company.uuid : null, body: toGustoEmployeeBenefit(w) }); continue; }
        usedBenefitUuids.add(mine.uuid);
        const cur = readEmployeeBenefit(mine);
        const shown = { employee: cur.employeeCents === null ? null : cur.employeeCents / 100, percent: cur.percent, employer: cur.employerCents === null ? null : cur.employerCents / 100, active: cur.active };
        rows.push({ ...base, current: shown, action: sameBenefit(w, cur) ? 'unchanged' : 'update', employeeUuid: link.gustoUuid, companyBenefitUuid: company.uuid, employeeBenefitUuid: mine.uuid, body: toGustoEmployeeBenefit(w) });
    }
    // benefits we sent earlier that the feed no longer has: switch them off (never ones somebody set up at the provider by hand)
    const byUuid = new Map(); for (const list of current.values()) for (const b of list) byUuid.set(b.uuid, b);
    for (const m of managed) {
        if (wantedIds.has(m.id) || !m.employeeBenefitUuid) continue;
        const b = byUuid.get(m.employeeBenefitUuid);
        if (!b || b.active === false) continue;
        usedBenefitUuids.add(b.uuid);
        const cur = readEmployeeBenefit(b);
        rows.push({ id: m.id, userId: m.userId, name: m.name || null, key: m.key, kind: null, planName: m.planName || m.key, notes: [], wanted: null, current: { employee: cur.employeeCents === null ? null : cur.employeeCents / 100, percent: cur.percent, employer: cur.employerCents === null ? null : cur.employerCents / 100, active: true }, action: 'end', employeeBenefitUuid: b.uuid, reason: 'No longer in the deduction feed.' });
    }
    // for the compare: what the provider holds that did not come from here
    const uuidToUser = new Map(); for (const [userId, l] of (links instanceof Map ? links.entries() : Object.entries(links || {}))) if (l && l.gustoUuid) uuidToUser.set(l.gustoUuid, userId);
    const companyByUuid = new Map(companyBenefits.map((b) => [b.uuid, b]));
    const unmanaged = [];
    for (const [employeeUuid, list] of current.entries()) for (const b of list) {
        if (usedBenefitUuids.has(b.uuid) || b.active === false) continue;
        const cur = readEmployeeBenefit(b);
        unmanaged.push({ userId: uuidToUser.get(employeeUuid) || null, description: (companyByUuid.get(b.company_benefit_uuid) || {}).description || 'Benefit', employee: cur.employeeCents === null ? null : cur.employeeCents / 100, percent: cur.percent });
    }
    const count = (a) => rows.filter((r) => r.action === a).length;
    const totals = { create: count('create'), update: count('update'), end: count('end'), unchanged: count('unchanged'), notInProvider: count('not_in_provider'), cannotSend: count('cannot_send') };
    const fingerprint = hash(rows.map((r) => [r.id, r.action, r.wanted, r.employeeBenefitUuid || null]));
    return { rows, companyBenefitsToCreate: [...createCompany.values()], unmanaged, totals, changes: totals.create + totals.update + totals.end, fingerprint };
}

module.exports = {
    hash, money, centsOf, OFF_CYCLE_REASONS, MAX_OFF_CYCLE_PEOPLE, validateOffCycle, offCycleHash, toGustoOffCycle, offCycleCompensations,
    contractorProblems, toGustoContractor, toGustoContractorAddress, contractorHash, validateContractorPayment, toGustoContractorPayment, ledgerRowsFor,
    classifyForm, formYear, taxFormsOf, yearsOf,
    BENEFIT_NAMES, benefitKind, benefitKey, wantedDeductions, readEmployeeBenefit, toGustoEmployeeBenefit, planDeductions
};
