/**
 * Benefits rules (pure): plan catalog, eligibility, enrollment windows, elections, per-pay-period
 * deductions and employer cost, 401(k) match, ACA hours and 1095-C style rows, COBRA deadlines.
 * Nothing about law is hard-coded as fact: windows, match formula, IRS limits and COBRA day counts
 * are editable tables. Confirm every setting with a US compliance advisor.
 */
const { parseIsoDate, isoDate } = require('./us-forms');

const PLAN_TYPES = ['medical', 'dental', 'vision', 'life', 'disability', '401k', 'hsa', 'fsa'];
const HEALTH_TYPES = ['medical', 'dental', 'vision'];
const FLAT_TYPES = ['life', 'disability'];
const TIERS = ['employee_only', 'employee_spouse', 'employee_children', 'family'];
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'seasonal', 'temporary'];
const PERIODS_PER_YEAR = { weekly: 52, biweekly: 26, semimonthly: 24, monthly: 12 };
const PRE_TAX_DEFAULT = { medical: true, dental: true, vision: true, life: false, disability: false, '401k': true, hsa: true, fsa: true };
const RELATIONSHIPS = ['spouse', 'domestic_partner', 'child'];
const ENROLLMENT_STATUSES = ['pending_approval', 'active', 'waived', 'terminated', 'rejected'];

const DEFAULT_LIFE_EVENTS = [
    { key: 'marriage', label: 'Marriage', labelEs: 'Matrimonio', windowDays: 30, requiresProof: true, effective: 'event_date', proofHint: 'Marriage certificate' },
    { key: 'birth_adoption', label: 'Birth or adoption', labelEs: 'Nacimiento o adopción', windowDays: 30, requiresProof: true, effective: 'event_date', proofHint: 'Birth certificate or adoption papers' },
    { key: 'loss_of_coverage', label: 'Loss of other coverage', labelEs: 'Pérdida de otra cobertura', windowDays: 30, requiresProof: true, effective: 'event_date', proofHint: 'Letter from the other plan' },
    { key: 'divorce', label: 'Divorce or legal separation', labelEs: 'Divorcio o separación legal', windowDays: 30, requiresProof: true, effective: 'event_date', proofHint: 'Court decree' },
    { key: 'death_of_dependent', label: 'Death of spouse or dependent', labelEs: 'Fallecimiento del cónyuge o dependiente', windowDays: 30, requiresProof: true, effective: 'event_date', proofHint: 'Death certificate' },
    { key: 'dependent_ages_out', label: 'Dependent loses eligibility (age)', labelEs: 'El dependiente pierde elegibilidad (edad)', windowDays: 30, requiresProof: false, effective: 'event_date', proofHint: '' },
    { key: 'relocation', label: 'Move that changes plan availability', labelEs: 'Mudanza que cambia los planes', windowDays: 30, requiresProof: true, effective: 'first_of_next_month', proofHint: 'Proof of new address' }
];

const DEFAULT_LIMITS = [
    { key: '401k_employee_deferral', label: '401(k) employee deferral limit (per year)', amount: null },
    { key: '401k_catchup', label: '401(k) catch-up limit (per year)', amount: null },
    { key: 'hsa_self_only', label: 'HSA limit, self-only coverage', amount: null },
    { key: 'hsa_family', label: 'HSA limit, family coverage', amount: null },
    { key: 'fsa_health', label: 'Health FSA limit', amount: null }
].map((l) => ({ ...l, year: null, placeholder: true, note: 'Placeholder. Enter the amount from the current IRS notice. No limit is applied until you do.' }));

const DEFAULT_COBRA = {
    employerNoticeDays: 30, adminNoticeDays: 14, electionDays: 60, firstPaymentDays: 45, noticeFrom: 'event_date',
    events: [
        { key: 'termination', label: 'Termination of employment', maxMonths: 18, auto: true },
        { key: 'hours_reduction', label: 'Reduction in hours', maxMonths: 18, auto: true },
        { key: 'divorce', label: 'Divorce or legal separation', maxMonths: 36, auto: false },
        { key: 'death', label: 'Death of the employee', maxMonths: 36, auto: false },
        { key: 'dependent_ceases', label: 'Dependent child ceases to be a dependent', maxMonths: 36, auto: false }
    ],
    note: 'Day counts and months are editable. Confirm with a US compliance advisor or your COBRA administrator.'
};

const DEFAULT_SETTINGS = {
    newHireWindowDays: 30,
    openEnrollment: { planYear: null, start: null, end: null, effectiveDate: null },
    lifeEvents: DEFAULT_LIFE_EVENTS,
    limits: DEFAULT_LIMITS,
    match: { tiers: [], note: 'Enter your match formula, for example tiers of [up to 3% at 100%] and [up to 5% at 50%].' },
    aca: { measurementStart: null, measurementEnd: null, fullTimeHoursPerWeek: 30, method: 'lookback', monthlyHoursThreshold: 130, stabilityStart: null, stabilityEnd: null },
    cobra: DEFAULT_COBRA
};

const round2 = (n) => Math.round(n * 100) / 100;
const addDays = (iso, n) => { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };
const addMonths = (iso, n) => {
    const d = parseIsoDate(iso); const day = d.getUTCDate();
    d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
    return isoDate(d);
};
const firstOfNextMonth = (iso) => { const d = parseIsoDate(iso); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1); return isoDate(d); };
const monthStart = (y, m) => `${y}-${String(m).padStart(2, '0')}-01`;
const monthEnd = (y, m) => isoDate(new Date(Date.UTC(y, m, 0)));

/* ------------------------------- plan catalog ------------------------------- */

function validatePlan(input) {
    const errors = []; const b = input || {}; const value = {};
    const name = String(b.name || '').trim();
    if (name.length < 2) errors.push('name is required'); else value.name = name;
    if (!PLAN_TYPES.includes(b.type)) errors.push(`type must be one of: ${PLAN_TYPES.join(', ')}`); else value.type = b.type;
    value.carrier = String(b.carrier || '').trim().slice(0, 80);
    const py = String(b.planYear || '');
    if (!/^\d{4}$/.test(py)) errors.push('planYear must be a 4-digit year'); else value.planYear = py;
    const ppy = b.payPeriodsPerYear === undefined || b.payPeriodsPerYear === '' ? 26 : Number(b.payPeriodsPerYear);
    if (![12, 24, 26, 52].includes(ppy)) errors.push('payPeriodsPerYear must be 12, 24, 26 or 52 (the frequency the costs are quoted in)'); else value.payPeriodsPerYear = ppy;
    value.preTax = b.preTax === undefined ? Boolean(PRE_TAX_DEFAULT[b.type]) : b.preTax === true || b.preTax === 'true';
    value.active = b.active !== false && b.active !== 'false';

    const e = b.eligibility || {};
    const waiting = e.waitingDays === undefined || e.waitingDays === '' ? 0 : Number(e.waitingDays);
    if (!Number.isInteger(waiting) || waiting < 0 || waiting > 365) errors.push('eligibility.waitingDays must be a whole number from 0 to 365');
    const minHours = e.minWeeklyHours === undefined || e.minWeeklyHours === '' ? 0 : Number(e.minWeeklyHours);
    if (!(minHours >= 0 && minHours <= 60)) errors.push('eligibility.minWeeklyHours must be 0 to 60');
    const types = Array.isArray(e.employmentTypes) && e.employmentTypes.length ? e.employmentTypes : EMPLOYMENT_TYPES;
    if (types.some((t) => !EMPLOYMENT_TYPES.includes(t))) errors.push(`eligibility.employmentTypes must come from: ${EMPLOYMENT_TYPES.join(', ')}`);
    value.eligibility = { waitingDays: waiting, minWeeklyHours: minHours, employmentTypes: types, classification: 'W2', firstOfMonthAfterWaiting: e.firstOfMonthAfterWaiting === true };

    if (HEALTH_TYPES.includes(value.type) || FLAT_TYPES.includes(value.type)) {
        const costs = {}; const input2 = b.costs || {};
        const tiersToUse = FLAT_TYPES.includes(value.type) ? ['employee_only'] : TIERS;
        for (const t of tiersToUse) {
            if (!input2[t]) continue;
            const emp = Number(input2[t].employee); const er = Number(input2[t].employer || 0);
            if (!(emp >= 0) || !(er >= 0) || !Number.isFinite(emp + er)) { errors.push(`costs.${t}: employee and employer must be amounts of 0 or more`); continue; }
            costs[t] = { employee: round2(emp), employer: round2(er) };
        }
        if (!Object.keys(costs).length && !errors.length) errors.push('enter the cost for at least one coverage tier');
        value.costs = costs;
    }
    if (value.type === '401k') {
        const maxPct = b.maxPercent === undefined || b.maxPercent === '' ? 75 : Number(b.maxPercent);
        if (!(maxPct > 0 && maxPct <= 100)) errors.push('maxPercent must be between 0 and 100'); else value.maxPercent = maxPct;
        value.allowRoth = b.allowRoth === true;
        const m = validateMatch(b.match);
        errors.push(...m.errors); value.match = m.value;
    }
    if (value.type === 'hsa' || value.type === 'fsa') {
        const er = b.employerContributionAnnual === undefined || b.employerContributionAnnual === '' ? 0 : Number(b.employerContributionAnnual);
        if (!(er >= 0)) errors.push('employerContributionAnnual must be 0 or more'); else value.employerContributionAnnual = round2(er);
        value.limitKey = value.type === 'fsa' ? 'fsa_health' : (b.limitKey === 'hsa_family' ? 'hsa_family' : 'hsa_self_only');
    }
    value.notes = String(b.notes || '').trim().slice(0, 300);
    return { errors, value };
}

/** Match tiers: ascending [{upToPercent, rate}] where rate is the percent of those contributions matched */
function validateMatch(input) {
    const errors = []; const tiers = [];
    const raw = input && Array.isArray(input.tiers) ? input.tiers : [];
    let prev = 0;
    raw.forEach((t, i) => {
        const up = Number(t.upToPercent); const rate = Number(t.rate);
        if (!(up > prev && up <= 100)) errors.push(`match tier ${i + 1}: upToPercent must be higher than the previous tier and at most 100`);
        else if (!(rate >= 0 && rate <= 500)) errors.push(`match tier ${i + 1}: rate must be 0 to 500`);
        else { tiers.push({ upToPercent: up, rate }); prev = up; }
    });
    return { errors, value: { tiers, note: String((input && input.note) || '').slice(0, 300) } };
}

/** Employer match as a percent of pay for a given employee deferral percent */
function matchPercent(tiers, deferralPercent) {
    let prev = 0; let pct = 0;
    for (const t of tiers || []) {
        const portion = Math.max(0, Math.min(deferralPercent, t.upToPercent) - prev);
        pct += (portion * t.rate) / 100; prev = t.upToPercent;
    }
    return Math.round(pct * 10000) / 10000;
}

function validateLimits(input) {
    const errors = []; const out = [];
    (Array.isArray(input) ? input : []).forEach((l, i) => {
        const key = String((l && l.key) || '').trim();
        if (!key) { errors.push(`limit ${i + 1}: key is required`); return; }
        const year = l.year === null || l.year === '' || l.year === undefined ? null : String(l.year);
        if (year !== null && !/^\d{4}$/.test(year)) { errors.push(`limit ${key}: year must be 4 digits`); return; }
        const amount = l.amount === null || l.amount === '' || l.amount === undefined ? null : Number(l.amount);
        if (amount !== null && !(amount >= 0)) { errors.push(`limit ${key}: amount must be 0 or more`); return; }
        out.push({ key, label: String(l.label || key).slice(0, 120), year, amount, placeholder: amount === null, note: String(l.note || '').slice(0, 200) });
    });
    return { errors, value: out };
}

/** The annual limit for a key and year (a row without a year applies to any year); null when not set */
function limitFor(limits, key, year) {
    const rows = (limits || []).filter((l) => l.key === key && l.amount !== null && l.amount !== undefined);
    return (rows.find((l) => String(l.year) === String(year)) || rows.find((l) => !l.year) || {}).amount ?? null;
}

/* ------------------------------ eligibility ------------------------------ */

function eligibility(plan, person, asOf) {
    const reasons = [];
    const e = plan.eligibility || {};
    if (person.classification !== 'W2') reasons.push('Only W-2 employees are eligible');
    if (e.employmentTypes && person.employmentType && !e.employmentTypes.includes(person.employmentType)) reasons.push(`Employment type ${person.employmentType} is not eligible`);
    let hoursVerified = true;
    if (e.minWeeklyHours > 0) {
        if (person.weeklyHours === null || person.weeklyHours === undefined) hoursVerified = false;
        else if (person.weeklyHours < e.minWeeklyHours) reasons.push(`Averages ${person.weeklyHours} hours a week; the plan needs ${e.minWeeklyHours}`);
    }
    let eligibleOn = null;
    if (parseIsoDate(person.hireDate)) {
        eligibleOn = addDays(person.hireDate, e.waitingDays || 0);
        if (e.firstOfMonthAfterWaiting && eligibleOn.slice(8) !== '01') eligibleOn = firstOfNextMonth(eligibleOn);
        if (asOf && eligibleOn > asOf) reasons.push(`Waiting period ends ${eligibleOn}`);
    } else reasons.push('Start date is not on file');
    return { eligible: reasons.length === 0, eligibleOn, reasons, hoursVerified };
}

/* ----------------------------- enrollment windows ----------------------------- */

function validateLifeEvents(input) {
    const errors = []; const out = []; const seen = new Set();
    (Array.isArray(input) ? input : []).forEach((e, i) => {
        const key = String((e && e.key) || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
        if (key.length < 2 || seen.has(key)) { errors.push(`life event ${i + 1}: a unique key is required`); return; }
        seen.add(key);
        const days = Number(e.windowDays);
        if (!Number.isInteger(days) || days < 1 || days > 365) { errors.push(`life event ${key}: windowDays must be 1 to 365`); return; }
        out.push({ key, label: String(e.label || key).slice(0, 80), labelEs: String(e.labelEs || e.label || key).slice(0, 80), windowDays: days, requiresProof: e.requiresProof !== false, effective: e.effective === 'first_of_next_month' ? 'first_of_next_month' : 'event_date', proofHint: String(e.proofHint || '').slice(0, 120) });
    });
    return { errors, value: out };
}

function validateOpenEnrollment(input) {
    const errors = []; const b = input || {};
    const value = { planYear: null, start: null, end: null, effectiveDate: null };
    for (const f of ['start', 'end', 'effectiveDate']) {
        if (b[f]) { if (!parseIsoDate(b[f])) errors.push(`${f} must be a valid date`); else value[f] = b[f]; }
    }
    if (b.planYear) { if (!/^\d{4}$/.test(String(b.planYear))) errors.push('planYear must be a 4-digit year'); else value.planYear = String(b.planYear); }
    if (value.start && value.end && value.end < value.start) errors.push('end cannot be before start');
    return { errors, value };
}

/** Life-event end of window and effective date from the table row */
function lifeEventDates(eventType, eventDate) {
    return { windowStart: eventDate, windowEnd: addDays(eventDate, eventType.windowDays), effectiveDate: eventType.effective === 'first_of_next_month' ? firstOfNextMonth(eventDate) : eventDate };
}

/**
 * Enrollment windows open for a person today. events: this person's approved life events
 * ({id, typeKey, eventDate, windowEnd, effectiveDate}). eligibleOn: earliest plan eligibility.
 */
function openWindows(settings, person, events, today, eligibleOn) {
    const out = [];
    const oe = settings.openEnrollment || {};
    if (oe.start && oe.end && today >= oe.start && today <= oe.end) out.push({ type: 'open_enrollment', start: oe.start, end: oe.end, effectiveDate: oe.effectiveDate || addDays(oe.end, 1), planYear: oe.planYear });
    if (parseIsoDate(person.hireDate) && eligibleOn) {
        const end = addDays(eligibleOn, settings.newHireWindowDays || 30);
        if (today >= person.hireDate && today <= end) out.push({ type: 'new_hire', start: person.hireDate, end, effectiveDate: eligibleOn > today ? eligibleOn : today });
    }
    for (const ev of events || []) {
        if (ev.status && ev.status !== 'approved') continue;
        if (today >= ev.eventDate && today <= ev.windowEnd) out.push({ type: 'life_event', start: ev.eventDate, end: ev.windowEnd, effectiveDate: ev.effectiveDate, eventId: ev.id, eventType: ev.typeKey });
    }
    return out;
}

function validateLifeEventRequest(input, types, today) {
    const errors = []; const b = input || {}; const value = {};
    const type = (types || []).find((t) => t.key === b.typeKey);
    if (!type) errors.push('typeKey is not a known life event');
    if (!parseIsoDate(b.eventDate)) errors.push('eventDate must be a valid date (YYYY-MM-DD)');
    else if (today && b.eventDate > addDays(today, 60)) errors.push('eventDate is too far in the future');
    else if (type) {
        value.typeKey = type.key; value.eventDate = b.eventDate;
        Object.assign(value, lifeEventDates(type, b.eventDate));
        if (today && value.windowEnd < today) errors.push(`The ${type.windowDays}-day window for this event has already ended (${value.windowEnd}). Ask HR.`);
    }
    value.note = String(b.note || '').trim().slice(0, 300);
    if (type && type.requiresProof) value.proofRequired = true;
    return { errors, value };
}

/* -------------------------- dependents and elections -------------------------- */

function validateDependent(d, i, today) {
    const errors = []; const value = {}; const p = `dependent ${i + 1}`;
    ['firstName', 'lastName'].forEach((f) => { const v = String((d && d[f]) || '').trim(); if (!v) errors.push(`${p}: ${f} is required`); else value[f] = v.slice(0, 60); });
    if (!RELATIONSHIPS.includes(d && d.relationship)) errors.push(`${p}: relationship must be one of: ${RELATIONSHIPS.join(', ')}`); else value.relationship = d.relationship;
    const dob = parseIsoDate(d && d.dateOfBirth);
    if (!dob || (today && d.dateOfBirth > today)) errors.push(`${p}: dateOfBirth must be a valid past date`); else value.dateOfBirth = d.dateOfBirth;
    if (d && d.ssn !== undefined && d.ssn !== '' && d.ssn !== null) {
        const digits = String(d.ssn).replace(/\D/g, '');
        if (digits.length !== 9 || /^(000|666)/.test(digits) || /^(\d)\1{8}$/.test(digits)) errors.push(`${p}: ssn must be 9 digits`);
        else value.ssnPlain = digits;
    }
    value.student = d && d.student === true;
    return { errors, value };
}

function needsSpouse(tier) { return tier === 'employee_spouse' || tier === 'family'; }
function needsChildren(tier) { return tier === 'employee_children' || tier === 'family'; }

/**
 * Validates one election against its plan. Returns value without any plain SSN beyond ssnPlain on
 * dependents (the route encrypts it and removes it before saving).
 */
function validateElection(input, plan, { today, limits } = {}) {
    const errors = []; const b = input || {};
    const value = { planId: plan.id, planName: plan.name, type: plan.type };
    if (b.waived === true) {
        const reason = String(b.waiveReason || '').trim();
        if (!HEALTH_TYPES.includes(plan.type) && !FLAT_TYPES.includes(plan.type) && plan.type !== '401k' && plan.type !== 'hsa' && plan.type !== 'fsa') errors.push('this plan cannot be waived');
        if (reason.length < 3) errors.push('Say why you are waiving (at least 3 characters)');
        value.waived = true; value.waiveReason = reason.slice(0, 200);
        return { errors, value };
    }
    value.waived = false;
    if (HEALTH_TYPES.includes(plan.type) || FLAT_TYPES.includes(plan.type)) {
        const tier = FLAT_TYPES.includes(plan.type) ? 'employee_only' : b.tier;
        if (!TIERS.includes(tier)) errors.push(`tier must be one of: ${TIERS.join(', ')}`);
        else if (!plan.costs || !plan.costs[tier]) errors.push(`this plan does not offer the ${tier.replace(/_/g, ' ')} tier`);
        else value.tier = tier;
        const deps = []; const raw = Array.isArray(b.dependents) ? b.dependents : [];
        raw.forEach((d, i) => { const r = validateDependent(d, i, today); errors.push(...r.errors); if (!r.errors.length) deps.push(r.value); });
        if (FLAT_TYPES.includes(plan.type) && deps.length) errors.push('dependents are not covered under this plan');
        if (value.tier) {
            const spouses = deps.filter((d) => d.relationship !== 'child').length; const kids = deps.filter((d) => d.relationship === 'child').length;
            if (needsSpouse(value.tier) && !spouses) errors.push('add your spouse or partner for this tier');
            if (needsChildren(value.tier) && !kids) errors.push('add at least one child for this tier');
            if (!needsSpouse(value.tier) && spouses) errors.push('a spouse or partner needs the +spouse or family tier');
            if (!needsChildren(value.tier) && kids) errors.push('children need the +children or family tier');
        }
        value.dependents = deps;
    } else if (plan.type === '401k') {
        const pct = Number(b.deferralPercent);
        if (!(pct >= 0 && pct <= plan.maxPercent)) errors.push(`deferralPercent must be 0 to ${plan.maxPercent}`); else value.deferralPercent = pct;
        const kind = b.contributionType || 'pre_tax';
        if (!['pre_tax', 'roth'].includes(kind) || (kind === 'roth' && !plan.allowRoth)) errors.push('contributionType must be pre_tax' + (plan.allowRoth ? ' or roth' : ' (Roth is not offered)')); else value.contributionType = kind;
    } else {
        const amt = Number(b.annualAmount);
        const cap = limitFor(limits, plan.limitKey, plan.planYear);
        if (!(amt >= 0) || !Number.isFinite(amt)) errors.push('annualAmount must be 0 or more');
        else if (cap !== null && amt > cap) errors.push(`annualAmount is above the plan limit of ${cap}`);
        else value.annualAmount = round2(amt);
    }
    return { errors, value };
}

/* ------------------------------- deductions ------------------------------- */

function estimateGrossPerPeriod(person) {
    const ppy = PERIODS_PER_YEAR[person.payFrequency];
    if (!ppy || !(Number(person.payRate) > 0)) return null;
    if (person.payType === 'salary') return round2(Number(person.payRate) / ppy);
    const hours = Number(person.weeklyHours) > 0 ? Number(person.weeklyHours) : 40;
    return round2((Number(person.payRate) * hours * 52) / ppy);
}

/** One enrollment election -> money per pay period for the person's own pay frequency */
function deductionLine(plan, election, person, { grossPerPeriod, limits, matchTiers } = {}) {
    const ppy = PERIODS_PER_YEAR[person.payFrequency];
    if (!ppy) return { error: 'payFrequency is missing' };
    const line = { planId: plan.id, planName: plan.name, type: plan.type, tier: election.tier || null, employeeAmount: 0, employerAmount: 0, preTax: plan.preTax, notes: [] };
    if (election.waived) return { ...line, waived: true };
    if (HEALTH_TYPES.includes(plan.type) || FLAT_TYPES.includes(plan.type)) {
        const c = plan.costs[election.tier]; if (!c) return { error: 'tier not offered' };
        line.employeeAmount = round2((c.employee * plan.payPeriodsPerYear) / ppy);
        line.employerAmount = round2((c.employer * plan.payPeriodsPerYear) / ppy);
    } else if (plan.type === '401k') {
        if (grossPerPeriod === null || grossPerPeriod === undefined) return { error: 'gross pay per period is unknown' };
        let pct = election.deferralPercent || 0;
        let emp = (grossPerPeriod * pct) / 100;
        const cap = limitFor(limits, '401k_employee_deferral', plan.planYear);
        if (cap !== null && emp > cap / ppy) { emp = cap / ppy; pct = (emp / grossPerPeriod) * 100; line.notes.push('Capped at the annual limit'); line.capped = true; }
        line.employeeAmount = round2(emp);
        line.employerAmount = round2((grossPerPeriod * matchPercent(matchTiers || (plan.match && plan.match.tiers), pct)) / 100);
        line.preTax = election.contributionType !== 'roth';
        line.taxTreatment = line.preTax ? 'pre_tax' : 'roth';
    } else {
        line.employeeAmount = round2((election.annualAmount || 0) / ppy);
        line.employerAmount = round2((plan.employerContributionAnnual || 0) / ppy);
    }
    line.taxTreatment = line.taxTreatment || (line.preTax ? 'pre_tax' : 'post_tax');
    return line;
}

const activeOn = (enr, date) => (enr.status === 'active' || (enr.status === 'terminated' && enr.endDate)) && enr.effectiveDate <= date && (!enr.endDate || enr.endDate >= date);

/** Payroll provider feed: one row per person per active election on the period end date */
function payrollFeed(enrollments, plans, people, { periodEnd, limits, matchTiers }) {
    const planById = new Map(plans.map((p) => [p.id, p]));
    const rows = []; const errors = [];
    for (const enr of enrollments) {
        if (!activeOn(enr, periodEnd)) continue;
        const person = people[enr.userId]; if (!person) continue;
        const gross = estimateGrossPerPeriod(person);
        for (const el of enr.elections || []) {
            const plan = planById.get(el.planId); if (!plan || el.waived) continue;
            const line = deductionLine(plan, el, person, { grossPerPeriod: gross, limits, matchTiers });
            if (line.error) { errors.push({ userId: enr.userId, planId: el.planId, error: line.error }); continue; }
            rows.push({ employeeId: person.employeeId || '', userId: enr.userId, name: person.name || '', payFrequency: person.payFrequency, planType: plan.type, planName: plan.name, carrier: plan.carrier || '', tier: line.tier || '', taxTreatment: line.taxTreatment, employeeDeduction: line.employeeAmount, employerCost: line.employerAmount, periodEnd, effectiveDate: enr.effectiveDate });
        }
    }
    rows.sort((a, b) => String(a.name).localeCompare(String(b.name)) || a.planType.localeCompare(b.planType));
    const sum = (k) => round2(rows.reduce((s, r) => s + r[k], 0));
    return { periodEnd, rows, errors, totals: { employeeDeduction: sum('employeeDeduction'), employerCost: sum('employerCost'), preTaxEmployee: round2(rows.filter((r) => r.taxTreatment !== 'post_tax').reduce((s, r) => s + r.employeeDeduction, 0)) } };
}
const FEED_HEADER = ['employeeId', 'userId', 'name', 'payFrequency', 'planType', 'planName', 'carrier', 'tier', 'taxTreatment', 'employeeDeduction', 'employerCost', 'periodEnd', 'effectiveDate'];

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (header, rows) => [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n';

/* ------------------------------------ ACA ------------------------------------ */

function validateAcaSettings(input) {
    const errors = []; const b = input || {}; const value = { ...DEFAULT_SETTINGS.aca };
    for (const f of ['measurementStart', 'measurementEnd', 'stabilityStart', 'stabilityEnd']) {
        if (b[f]) { if (!parseIsoDate(b[f])) errors.push(`${f} must be a valid date`); else value[f] = b[f]; } else if (b[f] === '' || b[f] === null) value[f] = null;
    }
    if (value.measurementStart && value.measurementEnd && value.measurementEnd < value.measurementStart) errors.push('measurementEnd cannot be before measurementStart');
    if (b.fullTimeHoursPerWeek !== undefined) { const n = Number(b.fullTimeHoursPerWeek); if (!(n > 0 && n <= 60)) errors.push('fullTimeHoursPerWeek must be 1 to 60'); else value.fullTimeHoursPerWeek = n; }
    if (b.monthlyHoursThreshold !== undefined) { const n = Number(b.monthlyHoursThreshold); if (!(n > 0 && n <= 300)) errors.push('monthlyHoursThreshold must be 1 to 300'); else value.monthlyHoursThreshold = n; }
    if (b.method !== undefined) { if (!['lookback', 'monthly'].includes(b.method)) errors.push('method must be lookback or monthly'); else value.method = b.method; }
    return { errors, value };
}

/** Average weekly hours over a measurement period from approved timesheet weeks */
function acaAverage(weeks, start, end, threshold = 30) {
    let total = 0; let counted = 0;
    for (const w of weeks || []) {
        if (w.status && w.status !== 'approved') continue;
        if (!w.weekStart || w.weekStart < start || w.weekStart > end) continue;
        const h = Number(w.totals && w.totals.workedHours);
        if (Number.isFinite(h)) { total += h; counted++; }
    }
    const avg = counted ? total / counted : 0;
    return { start, end, weeksCounted: counted, totalHours: round2(total), averageWeeklyHours: round2(avg), fullTime: counted > 0 && avg >= threshold, threshold };
}

function monthHours(weeks, year, month) {
    const s = monthStart(year, month); const e = monthEnd(year, month);
    return round2((weeks || []).filter((w) => (!w.status || w.status === 'approved') && w.weekStart >= s && w.weekStart <= e).reduce((t, w) => t + (Number(w.totals && w.totals.workedHours) || 0), 0));
}

function validateOffer(input) {
    const errors = []; const b = input || {}; const value = {};
    if (!parseIsoDate(b.fromDate)) errors.push('fromDate must be a valid date'); else value.fromDate = b.fromDate;
    if (b.toDate) { if (!parseIsoDate(b.toDate) || b.toDate < b.fromDate) errors.push('toDate must be a valid date on or after fromDate'); else value.toDate = b.toDate; } else value.toDate = null;
    value.offered = b.offered !== false;
    value.offerCode = String(b.offerCode || '').trim().toUpperCase().slice(0, 4);
    value.safeHarborCode = String(b.safeHarborCode || '').trim().toUpperCase().slice(0, 4);
    const share = b.employeeShareMonthly === undefined || b.employeeShareMonthly === '' ? null : Number(b.employeeShareMonthly);
    if (share !== null && !(share >= 0)) errors.push('employeeShareMonthly must be 0 or more'); else value.employeeShareMonthly = share === null ? null : round2(share);
    value.coversSpouse = b.coversSpouse === true; value.coversDependents = b.coversDependents === true;
    value.note = String(b.note || '').trim().slice(0, 200);
    return { errors, value };
}

/** 12 rows (one per month) per person for a 1095-C style export. Codes come from the offer record. */
function acaMonthlyRows({ person, year, aca, weeks, measurement, offers, enrolledMonths = [] }) {
    const rows = [];
    for (let m = 1; m <= 12; m++) {
        const s = monthStart(year, m); const e = monthEnd(year, m);
        let fullTime;
        if (aca.method === 'monthly') fullTime = monthHours(weeks, year, m) >= aca.monthlyHoursThreshold;
        else if (aca.stabilityStart && aca.stabilityEnd) fullTime = Boolean(measurement && measurement.fullTime) && s >= aca.stabilityStart && e <= aca.stabilityEnd;
        else fullTime = Boolean(measurement && measurement.fullTime);
        const offer = (offers || []).filter((o) => o.fromDate <= e && (!o.toDate || o.toDate >= s)).sort((a, b) => b.fromDate.localeCompare(a.fromDate))[0];
        rows.push({
            employeeId: person.employeeId || '', name: person.name || '', ssnLast4: person.ssnLast4 || '', year, month: m,
            fullTime: fullTime ? 'Y' : 'N', offered: offer && offer.offered ? 'Y' : 'N', line14: offer ? offer.offerCode : '', line15: offer && offer.employeeShareMonthly !== null && offer.employeeShareMonthly !== undefined ? offer.employeeShareMonthly : '',
            line16: offer ? offer.safeHarborCode : '', enrolled: enrolledMonths.includes(m) ? 'Y' : 'N', hoursInMonth: monthHours(weeks, year, m)
        });
    }
    return rows;
}
const ACA_HEADER = ['employeeId', 'name', 'ssnLast4', 'year', 'month', 'fullTime', 'hoursInMonth', 'offered', 'line14', 'line15', 'line16', 'enrolled'];

/** Months of a year in which an enrollment in a health plan was active for any day */
function enrolledMonthsOf(enrollments, year) {
    const set = new Set();
    for (const enr of enrollments) {
        if (!['active', 'terminated'].includes(enr.status) || !(enr.elections || []).some((e) => !e.waived && e.type === 'medical')) continue;
        for (let m = 1; m <= 12; m++) if (enr.effectiveDate <= monthEnd(year, m) && (!enr.endDate || enr.endDate >= monthStart(year, m))) set.add(m);
    }
    return [...set].sort((a, b) => a - b);
}

/* ------------------------------------ COBRA ------------------------------------ */

function validateCobraSettings(input) {
    const errors = []; const b = input || {}; const value = JSON.parse(JSON.stringify(DEFAULT_COBRA));
    for (const f of ['employerNoticeDays', 'adminNoticeDays', 'electionDays', 'firstPaymentDays']) {
        if (b[f] !== undefined) { const n = Number(b[f]); if (!Number.isInteger(n) || n < 0 || n > 365) errors.push(`${f} must be a whole number from 0 to 365`); else value[f] = n; }
    }
    if (Array.isArray(b.events)) {
        const ev = [];
        b.events.forEach((e, i) => {
            const key = String((e && e.key) || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_'); const mo = Number(e && e.maxMonths);
            if (key.length < 2 || !Number.isInteger(mo) || mo < 1 || mo > 60) errors.push(`event ${i + 1}: key and maxMonths (1 to 60) are required`);
            else ev.push({ key, label: String(e.label || key).slice(0, 80), maxMonths: mo, auto: e.auto === true });
        });
        if (ev.length) value.events = ev;
    }
    return { errors, value };
}

function validateCobraEvent(input, cfg) {
    const errors = []; const b = input || {}; const value = {};
    const ev = (cfg.events || []).find((e) => e.key === b.eventType);
    if (!ev) errors.push('eventType is not a known COBRA qualifying event'); else value.eventType = ev.key;
    if (!parseIsoDate(b.eventDate)) errors.push('eventDate must be a valid date'); else value.eventDate = b.eventDate;
    if (b.lossOfCoverageDate) { if (!parseIsoDate(b.lossOfCoverageDate) || b.lossOfCoverageDate < b.eventDate) errors.push('lossOfCoverageDate must be a valid date on or after the event'); else value.lossOfCoverageDate = b.lossOfCoverageDate; }
    else value.lossOfCoverageDate = b.eventDate;
    return { errors, value, event: ev };
}

function cobraDeadlines(rec, cfg) {
    const ev = (cfg.events || []).find((e) => e.key === rec.eventType) || { maxMonths: 18 };
    const employerNoticeDue = addDays(rec.eventDate, cfg.employerNoticeDays);
    const employerNoticeAt = rec.employerNoticeSentOn || employerNoticeDue;
    const electionNoticeDue = addDays(employerNoticeAt, cfg.adminNoticeDays);
    const electionNoticeAt = rec.electionNoticeSentOn || electionNoticeDue;
    const electionDeadline = addDays(electionNoticeAt, cfg.electionDays);
    const out = { employerNoticeDue, electionNoticeDue, electionDeadline, maxCoverageEnd: addDays(addMonths(rec.lossOfCoverageDate, ev.maxMonths), -1) };
    if (rec.electedOn) { out.firstPaymentDue = addDays(rec.electedOn, cfg.firstPaymentDays); }
    return out;
}

const COBRA_ACTIONS = {
    notice_to_administrator: { from: ['pending_notice'], to: 'pending_notice', field: 'employerNoticeSentOn' },
    send_election_notice: { from: ['pending_notice'], to: 'notice_sent', field: 'electionNoticeSentOn' },
    record_election: { from: ['notice_sent'], to: 'elected', field: 'electedOn' },
    waive: { from: ['notice_sent'], to: 'waived', field: 'waivedOn' },
    record_payment: { from: ['elected'], to: 'paid', field: 'firstPaymentOn' },
    terminate: { from: ['pending_notice', 'notice_sent', 'elected', 'paid'], to: 'terminated', field: 'terminatedOn', reason: true }
};

function applyCobraAction(rec, action, params, cfg, todayIso) {
    const def = COBRA_ACTIONS[action];
    if (!def) return { errors: [`action must be one of: ${Object.keys(COBRA_ACTIONS).join(', ')}`] };
    if (!def.from.includes(rec.status)) return { errors: [`Cannot ${action.replace(/_/g, ' ')} when the record is ${rec.status.replace(/_/g, ' ')}`], conflict: true };
    const date = (params && params.date) || todayIso;
    if (!parseIsoDate(date)) return { errors: ['date must be a valid date'] };
    const note = String((params && params.note) || '').trim().slice(0, 300);
    if (def.reason && note.length < 3) return { errors: ['A reason is required'] };
    if (action === 'record_election' && date > cobraDeadlines(rec, cfg).electionDeadline) return { errors: ['The election deadline has passed. Record a late election only after HR review (terminate or extend).'], conflict: true };
    const patch = { status: def.to, [def.field]: date };
    patch.historyEntry = { at: todayIso, action, date, from: rec.status, to: def.to, note };
    return { errors: [], patch };
}

function cobraAlerts(rec, cfg, todayIso) {
    const d = cobraDeadlines(rec, cfg); const out = [];
    const open = !['elected', 'paid', 'waived', 'terminated', 'lapsed'].includes(rec.status);
    if (open && !rec.employerNoticeSentOn && todayIso > d.employerNoticeDue) out.push('Notice to the administrator is overdue');
    if (open && rec.status === 'pending_notice' && todayIso > d.electionNoticeDue) out.push('Election notice is overdue');
    if (rec.status === 'notice_sent' && todayIso > d.electionDeadline) out.push('Election deadline passed with no election');
    if (rec.status === 'elected' && d.firstPaymentDue && todayIso > d.firstPaymentDue) out.push('First payment is overdue');
    return out;
}

module.exports = {
    PLAN_TYPES, HEALTH_TYPES, FLAT_TYPES, TIERS, EMPLOYMENT_TYPES, PERIODS_PER_YEAR, RELATIONSHIPS, ENROLLMENT_STATUSES, DEFAULT_SETTINGS, DEFAULT_LIFE_EVENTS, DEFAULT_LIMITS, DEFAULT_COBRA, FEED_HEADER, ACA_HEADER, COBRA_ACTIONS,
    validatePlan, validateMatch, matchPercent, validateLimits, limitFor, eligibility, validateLifeEvents, validateOpenEnrollment, lifeEventDates, openWindows, validateLifeEventRequest,
    validateDependent, validateElection, estimateGrossPerPeriod, deductionLine, activeOn, payrollFeed, toCsv,
    validateAcaSettings, acaAverage, monthHours, validateOffer, acaMonthlyRows, enrolledMonthsOf,
    validateCobraSettings, validateCobraEvent, cobraDeadlines, applyCobraAction, cobraAlerts, addDays, addMonths
};
