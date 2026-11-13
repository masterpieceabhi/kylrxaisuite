/**
 * Our model <-> Gusto payloads (pure; no I/O). Each function is a small adapter. Field names for the parts of
 * Gusto's API we are less sure of are called out with "VERIFY" and listed in docs/GUSTO.md.
 */
const crypto = require('crypto');
const rules = require('./rules');

const W4_STATUS = { single_or_mfs: 'Single', mfj_or_qss: 'Married', head_of_household: 'Head of Household' };
// Form W-4 (2020 and later) credit amounts per qualifying child / other dependent. Federal, well known; kept here as data.
const W4_CHILD_CREDIT = 2000;
const W4_OTHER_DEPENDENT_CREDIT = 500;

const hash = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex').slice(0, 20);
const money = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

/** Our person document (users/{id}) -> the shape the Gusto mappers use. SSN is NOT decrypted here. */
function personFromDoc(id, d = {}) {
    const p = d.usProfile || {};
    const parts = String(d.name || '').trim().split(/\s+/);
    const w4 = d.usForms && d.usForms.w4 && d.usForms.w4.current ? d.usForms.w4.current : null;
    return {
        id, orgId: d.orgId, employeeId: d.employeeId || null, name: d.name || null, email: d.email || null,
        first: p.legalFirstName || parts[0] || null, last: p.legalLastName || parts.slice(1).join(' ') || null, middle: p.legalMiddleName || null,
        dob: p.dateOfBirth || null, startDate: p.startDate || d.joiningDate || null, title: d.jobTitle || p.jobTitle || 'Employee',
        department: d.departmentName || (d.department && d.department !== 'General Operations' ? d.department : null) || null,
        workState: p.workState || null, home: p.homeAddress || null, classification: p.classification || null,
        payType: p.payType || null, payRate: p.payRate === undefined ? null : Number(p.payRate), flsa: p.flsaStatus || null, payFrequency: p.payFrequency || null,
        active: !/^(terminated|inactive|offboarded)$/i.test(String(d.status || 'Active')), hasSsn: Boolean(p.taxpayerIdEncrypted), ssnEnc: p.taxpayerIdEncrypted || null,
        ssnLast4: p.taxpayerIdLast4 || null, w4, managerId: p.managerId || null,
        // bank accounts keep their numbers encrypted here; state tax answers are plain (they are not identifiers)
        bank: bankAccountsFromForms(d.usForms || {}), stateTax: (d.usForms && d.usForms.stateTax) || null
    };
}

/** Why a person cannot be sent to Gusto yet (plain language), or [] when ready. */
function problemsFor(person) {
    const out = [];
    if (person.classification && person.classification !== 'W2') out.push('This person is a contractor (1099), so they are not sent as an employee. Add them under Contractors and send them from the Contractors section.');
    if (!person.first || !person.last) out.push('Legal first and last name are missing.');
    if (!person.email) out.push('Email is missing.');
    if (!person.dob) out.push('Date of birth is missing.');
    if (!person.home || !person.home.line1) out.push('Home address is missing.');
    if (!person.startDate) out.push('Start date is missing.');
    if (!(person.payRate > 0)) out.push('Pay rate is missing.');
    if (!person.payType) out.push('Pay type (hourly or salary) is missing.');
    return out;
}

/* ------------------------------- employee pieces ------------------------------- */

function toGustoEmployee(person, ssn) {
    const body = { first_name: person.first, last_name: person.last, email: person.email, date_of_birth: person.dob };
    if (person.middle) body.middle_initial = String(person.middle).trim().charAt(0).toUpperCase();
    if (ssn) body.ssn = String(ssn).replace(/\D/g, '');
    return body;
}

function toGustoHomeAddress(person) {
    const h = person.home || {};
    return { street_1: h.line1, street_2: h.line2 || '', city: h.city, state: h.state, zip: h.zip, effective_date: person.startDate };
}

function toGustoJob(person) { return { title: person.title || 'Employee', hire_date: person.startDate }; }

/** Pay rate. Hourly: per hour. Salary: our payRate is treated as an ANNUAL salary (VERIFY with how HR enters it). */
function toGustoCompensation(person) {
    const hourly = person.payType === 'hourly';
    let flsa;
    if (person.flsa === 'exempt') flsa = 'Exempt';
    else flsa = hourly ? 'Nonexempt' : 'Salaried Nonexempt';
    return { rate: money(person.payRate), payment_unit: hourly ? 'Hour' : 'Year', flsa_status: flsa };
}

/** W-4 -> Gusto federal taxes. Only what we hold; Gusto remains the source of truth once the employee is onboarded. */
function toGustoFederalTaxes(w4) {
    if (!w4 || !w4.filingStatus) return null;
    const body = {
        filing_status: w4.exemptFromWithholding ? 'Exempt from withholding' : W4_STATUS[w4.filingStatus] || 'Single',
        two_jobs: Boolean(w4.multipleJobs),
        dependents_amount: money((Number(w4.qualifyingChildren) || 0) * W4_CHILD_CREDIT + (Number(w4.otherDependents) || 0) * W4_OTHER_DEPENDENT_CREDIT),
        other_income: money(w4.otherIncome), deductions: money(w4.deductions), extra_withholding: money(w4.extraWithholding), w4_data_type: 'rev_2020_w4'
    };
    return body;
}

/* ------------------------------- bank accounts and state tax answers ------------------------------- */

/**
 * A person's direct deposit accounts as stored on their record (usForms): the split list when there is one, else the
 * single account. Mirrors storedSplits() in routes/us-comp.js. Account numbers stay encrypted here.
 */
function bankAccountsFromForms(f = {}) {
    const d = f.directDeposit;
    const pick = (a, i) => ({ id: a.id || `acct${i + 1}`, bankName: a.bankName || null, routingNumber: a.routingNumber || null, accountType: a.accountType || 'checking', accountNumberEnc: a.accountNumberEncrypted || null, last4: a.accountLast4 || null, allocation: a.allocation || { type: 'remainder', value: null } });
    if (Array.isArray(f.directDepositSplits) && f.directDepositSplits.length && !(d && !d.split)) return f.directDepositSplits.map(pick);
    if (d && d.accountLast4) return [pick({ ...d, id: 'legacy', allocation: { type: 'remainder', value: null } }, 0)];
    return [];
}

/** Changes when any account or its share changes. Never includes an account number (only the last 4). */
const bankHash = (accounts) => hash((accounts || []).map((a) => [a.id, a.routingNumber, a.last4, a.accountType, a.allocation && a.allocation.type, a.allocation && a.allocation.value]));

/** VERIFY against Gusto: name, routing_number, account_number, account_type ("Checking" / "Savings") */
function toGustoBankAccount(a, accountNumber) {
    return { name: a.bankName || `Account ending ${a.last4 || ''}`.trim(), routing_number: a.routingNumber, account_number: String(accountNumber || '').replace(/\D/g, ''), account_type: a.accountType === 'savings' ? 'Savings' : 'Checking' };
}

/**
 * How pay is split across the accounts, as the provider's payment method. `uuidOf(account)` gives the provider's id
 * of each account. Our splits may mix fixed amounts and percents; the provider splits by one or the other, so a mix
 * is not sent and the reason is returned instead.
 * VERIFY against Gusto: type "Direct Deposit", split_by "Amount" | "Percentage", splits[{ uuid, name, priority,
 * split_amount }]; that Percentage needs whole numbers adding up to 100; that Amount is in CENTS with null for the
 * account that takes the rest.
 */
function toGustoPaymentSplits(accounts, uuidOf = (a) => a.id) {
    const list = accounts || [];
    const rest = list.filter((a) => a.allocation.type === 'remainder');
    if (!list.length) return { ok: false, reason: 'No bank account is on file.' };
    if (rest.length !== 1) return { ok: false, reason: 'Exactly one account must take the rest of the pay.' };
    const kinds = new Set(list.filter((a) => a.allocation.type !== 'remainder').map((a) => a.allocation.type));
    if (kinds.size > 1) return { ok: false, reason: 'The pay is split by both fixed amounts and percents. Gusto splits by one or the other, so this split was not sent: set it up in Gusto by hand.' };
    const line = (a, i, amount) => ({ uuid: uuidOf(a), name: a.bankName || `Account ending ${a.last4 || ''}`.trim(), priority: i + 1, split_amount: amount });
    if (kinds.has('amount')) {
        const ordered = [...list.filter((a) => a.allocation.type === 'amount'), rest[0]];
        return { ok: true, body: { type: 'Direct Deposit', split_by: 'Amount', splits: ordered.map((a, i) => line(a, i, a.allocation.type === 'amount' ? Math.round(Number(a.allocation.value) * 100) : null)) } };
    }
    const pcts = list.filter((a) => a.allocation.type === 'percent');
    if (pcts.some((a) => !Number.isInteger(Number(a.allocation.value)))) return { ok: false, reason: 'A percent with decimals cannot be sent: Gusto takes whole percents. Set this split up in Gusto by hand.' };
    const left = 100 - pcts.reduce((s, a) => s + Number(a.allocation.value), 0);
    if (left < 1) return { ok: false, reason: 'The percents leave nothing for the account that takes the rest.' };
    return { ok: true, body: { type: 'Direct Deposit', split_by: 'Percentage', splits: list.map((a, i) => line(a, i, a.allocation.type === 'percent' ? Number(a.allocation.value) : left)) } };
}

/** One state's answers typed in by payroll: { state, answers: { questionKey: value } } */
function validateStateTaxAnswers(input) {
    const errors = []; const b = input || {};
    const state = String(b.state || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) errors.push('state must be two letters');
    const answers = {};
    const src = b.answers && typeof b.answers === 'object' && !Array.isArray(b.answers) ? b.answers : null;
    if (!src) errors.push('answers must be a list of question and answer');
    else {
        const keys = Object.keys(src);
        if (keys.length > 40) errors.push('too many answers');
        for (const k of keys.slice(0, 40)) {
            const v = src[k];
            if (!/^[A-Za-z0-9_.-]{1,80}$/.test(k)) { errors.push(`"${String(k).slice(0, 20)}" is not a question name`); continue; }
            if (v === '' || v === null || v === undefined) continue; // an empty answer is "not answered"
            if (!['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 120) { errors.push(`the answer to ${k} is not valid`); continue; }
            answers[k] = typeof v === 'string' ? v.trim() : v;
        }
    }
    return { errors, value: { state, answers } };
}

/**
 * Our saved answers -> the provider's state tax update, using only the questions the provider actually asks.
 *   saved:    { TX: { answers: { key: value } }, ... }
 *   provider: GET /v1/employees/{id}/state_taxes  [{ state, questions: [{ key, label }] }]
 * Returns { states (the body), sent, unknown (answers the provider does not ask for), unanswered (questions with no answer) }.
 * VERIFY against Gusto: PUT body { states: [{ state, questions: [{ key, answers: [{ value, valid_from, valid_up_to }] }] }] }
 * and the valid_from value ("2010-01-01" is what Gusto's examples use).
 */
function toGustoStateTaxes(saved, provider) {
    const states = []; const unknown = []; const unanswered = []; let sent = 0;
    const byState = new Map((Array.isArray(provider) ? provider : []).map((s) => [s.state, s]));
    for (const [state, rec] of Object.entries(saved || {})) {
        const answers = (rec && rec.answers) || {};
        const p = byState.get(state);
        if (!p) { if (Object.keys(answers).length) unknown.push(`${state}: Gusto does not list this state for the person`); continue; }
        const asked = new Set((p.questions || []).map((q) => q.key));
        const questions = [];
        for (const [key, value] of Object.entries(answers)) {
            if (!asked.has(key)) { unknown.push(`${state}: ${key}`); continue; }
            questions.push({ key, answers: [{ value, valid_from: '2010-01-01', valid_up_to: null }] }); sent += 1;
        }
        if (questions.length) states.push({ state, questions });
    }
    for (const p of byState.values()) for (const q of p.questions || []) {
        const mine = saved && saved[p.state] && saved[p.state].answers;
        const has = mine && mine[q.key] !== undefined;
        const already = (q.answers || []).some((a) => a.value !== null && a.value !== undefined && a.value !== '');
        if (!has && !already) unanswered.push(`${p.state}: ${q.label || q.key}`);
    }
    return { states, sent, unknown, unanswered };
}
const stateTaxHash = (saved) => hash(Object.keys(saved || {}).sort().map((st) => [st, Object.entries((saved[st] && saved[st].answers) || {}).sort(([a], [b]) => a.localeCompare(b))]));

/* ------------------------------- company pieces ------------------------------- */

function toGustoLocation(address, phone) {
    return { phone_number: String(phone || '0000000000').replace(/\D/g, '').slice(-10).padStart(10, '0'), street_1: address.line1, street_2: address.line2 || '', city: address.city, state: address.state, zip: address.zip, country: 'USA', mailing_address: true, filing_address: true };
}

/** settings: { frequency, anchorPayDate, anchorEndOfPayPeriod, day1, day2 } (our frequency names) */
function toGustoPaySchedule(s) {
    const body = { frequency: rules.GUSTO_FREQUENCY[s.frequency], anchor_pay_date: s.anchorPayDate, anchor_end_of_pay_period: s.anchorEndOfPayPeriod };
    if (s.frequency === 'semimonthly') { body.day_1 = Number(s.day1 || 15); body.day_2 = Number(s.day2 || 31); }
    return body;
}
function validatePaySchedule(s) {
    const errors = [];
    if (!s || !rules.GUSTO_FREQUENCY[s.frequency]) errors.push('frequency must be weekly, biweekly, semimonthly or monthly');
    if (!rules.parseIso(s && s.anchorPayDate)) errors.push('anchorPayDate must be a date (YYYY-MM-DD)');
    if (!rules.parseIso(s && s.anchorEndOfPayPeriod)) errors.push('anchorEndOfPayPeriod must be a date (YYYY-MM-DD)');
    if (!errors.length && s.anchorPayDate < s.anchorEndOfPayPeriod) errors.push('The pay date cannot be before the end of the pay period');
    return errors;
}

/**
 * Our approved leave request -> Gusto time off request. VERIFY: the real endpoint and body for partners to create
 * time off requests (and whether Gusto accepts them at all for Embedded) are not confirmed. Isolated here and in sync.js.
 */
function toGustoTimeOff(request, employeeUuid) {
    return {
        employee_uuid: employeeUuid, policy_type: String(request.type || '').toLowerCase().includes('sick') ? 'sick' : 'vacation',
        start_date: request.startDate, end_date: request.endDate, hours: String(request.hours), status: 'approved', external_id: request.id
    };
}

/* ------------------------------- reading Gusto back ------------------------------- */

function fromGustoEmployee(g = {}) {
    const job = (g.jobs || []).find((j) => j.primary) || (g.jobs || [])[0] || null;
    const comp = job && (job.compensations || []).find((c) => c.uuid === job.current_compensation_uuid) || (job && (job.compensations || [])[0]) || null;
    return {
        uuid: g.uuid, version: g.version, onboarded: Boolean(g.onboarded), onboardingStatus: g.onboarding_status || null, terminated: Boolean(g.terminated),
        email: g.email || null, jobUuid: job ? job.uuid : null, jobVersion: job ? job.version : null, compensationUuid: comp ? comp.uuid : null, compensationVersion: comp ? comp.version : null,
        rate: comp ? Number(comp.rate) : null, paymentUnit: comp ? comp.payment_unit : null
    };
}

/** Compare the parts of our record that Gusto also holds; returns field names that differ (Gusto wins; we only report) */
function drift(person, gusto) {
    const out = [];
    if (!gusto) return out;
    if (gusto.rate !== null && Math.abs(gusto.rate - Number(person.payRate || 0)) > 0.005) out.push('payRate');
    if (gusto.email && person.email && gusto.email.toLowerCase() !== person.email.toLowerCase()) out.push('email');
    if (gusto.terminated && person.active) out.push('terminated_in_gusto');
    return out;
}

module.exports = {
    W4_STATUS, W4_CHILD_CREDIT, W4_OTHER_DEPENDENT_CREDIT, hash, money,
    personFromDoc, problemsFor, toGustoEmployee, toGustoHomeAddress, toGustoJob, toGustoCompensation, toGustoFederalTaxes,
    bankAccountsFromForms, bankHash, toGustoBankAccount, toGustoPaymentSplits, validateStateTaxAnswers, toGustoStateTaxes, stateTaxHash,
    toGustoLocation, toGustoPaySchedule, validatePaySchedule, toGustoTimeOff, fromGustoEmployee, drift
};
