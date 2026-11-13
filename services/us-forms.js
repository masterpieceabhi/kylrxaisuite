/**
 * Pure rules for the two US new-hire forms: federal Form W-4 (withholding) and Form I-9
 * (employment eligibility). No I/O. Tax amounts are not calculated here; the payroll provider does that.
 * Business-day counting is a setting that a US compliance reviewer must confirm.
 */

const W4_FILING_STATUSES = ['single_or_mfs', 'mfj_or_qss', 'head_of_household'];

const I9_CITIZENSHIP = ['us_citizen', 'noncitizen_national', 'lawful_permanent_resident', 'alien_authorized_to_work'];

// Acceptable documents (short lists; titles shown to the user)
const I9_LIST_A = [
    'us_passport', 'us_passport_card', 'permanent_resident_card', 'foreign_passport_with_i551',
    'employment_authorization_document', 'foreign_passport_with_i94', 'micronesia_marshall_passport'
];
const I9_LIST_B = [
    'drivers_license', 'state_id_card', 'school_id_with_photo', 'voter_registration_card', 'military_id_card',
    'us_coast_guard_merchant_mariner_card', 'native_american_tribal_document'
];
const I9_LIST_C = [
    'social_security_card_unrestricted', 'birth_abstract_or_certificate', 'us_citizen_id_card',
    'native_american_tribal_document_c', 'employment_authorization_dhs'
];

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

function parseIsoDate(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    return d;
}

/** Nth weekday (0=Sun) of a month, or the last one when n === -1 */
function nthWeekday(year, month, weekday, n) {
    if (n > 0) {
        const first = new Date(Date.UTC(year, month, 1));
        const offset = (weekday - first.getUTCDay() + 7) % 7;
        return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7));
    }
    const last = new Date(Date.UTC(year, month + 1, 0));
    const back = (last.getUTCDay() - weekday + 7) % 7;
    return new Date(Date.UTC(year, month, last.getUTCDate() - back));
}

/** Federal holidays for a year as ISO dates, with Saturday->Friday and Sunday->Monday observance */
function federalHolidays(year) {
    const fixed = [[0, 1], [5, 19], [6, 4], [10, 11], [11, 25]].map(([m, d]) => {
        const date = new Date(Date.UTC(year, m, d));
        if (date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() - 1);
        if (date.getUTCDay() === 0) date.setUTCDate(date.getUTCDate() + 1);
        return date;
    });
    const floating = [
        nthWeekday(year, 0, 1, 3), nthWeekday(year, 1, 1, 3), nthWeekday(year, 4, 1, -1),
        nthWeekday(year, 8, 1, 1), nthWeekday(year, 9, 1, 2), nthWeekday(year, 10, 4, 4)
    ];
    return new Set([...fixed, ...floating].map(isoDate));
}

/**
 * The date that is `n` business days after `startIso`. Saturdays and Sundays never count;
 * federal holidays are skipped only when options.skipFederalHolidays is true.
 */
function addBusinessDays(startIso, n, options = {}) {
    const d = parseIsoDate(startIso);
    if (!d) return null;
    let remaining = n;
    while (remaining > 0) {
        d.setUTCDate(d.getUTCDate() + 1);
        const dow = d.getUTCDay();
        if (dow === 0 || dow === 6) continue;
        if (options.skipFederalHolidays && federalHolidays(d.getUTCFullYear()).has(isoDate(d))) continue;
        remaining -= 1;
    }
    return isoDate(d);
}

const nonNegInt = (v) => Number.isInteger(Number(v)) && Number(v) >= 0;
const money = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v));

function validateW4(input, signerLegalName) {
    const errors = [];
    const b = input || {};
    const value = { taxYear: Number(b.taxYear) };

    if (!Number.isInteger(value.taxYear) || value.taxYear < 2020 || value.taxYear > 2100) errors.push('taxYear must be a valid year (2020 or later)');
    if (!W4_FILING_STATUSES.includes(b.filingStatus)) errors.push(`filingStatus must be one of: ${W4_FILING_STATUSES.join(', ')}`);
    else value.filingStatus = b.filingStatus;

    value.multipleJobs = b.multipleJobs === true;
    value.qualifyingChildren = b.qualifyingChildren === undefined ? 0 : Number(b.qualifyingChildren);
    value.otherDependents = b.otherDependents === undefined ? 0 : Number(b.otherDependents);
    if (!nonNegInt(value.qualifyingChildren)) errors.push('qualifyingChildren must be a whole number, 0 or more');
    if (!nonNegInt(value.otherDependents)) errors.push('otherDependents must be a whole number, 0 or more');

    for (const f of ['otherIncome', 'deductions', 'extraWithholding']) {
        const n = money(b[f]);
        if (!Number.isFinite(n) || n < 0) errors.push(`${f} must be 0 or more`); else value[f] = Math.round(n * 100) / 100;
    }
    value.exemptFromWithholding = b.exemptFromWithholding === true;

    const signed = String(b.signedName || '').trim();
    if (!b.declarationAccepted) errors.push('declarationAccepted is required (under penalties of perjury)');
    if (!signed) errors.push('signedName is required');
    else if (signerLegalName && signed.toLowerCase() !== String(signerLegalName).trim().toLowerCase()) {
        errors.push('signedName must match the employee legal name');
    } else value.signedName = signed;
    return { errors, value };
}

function validateDocument(doc, allowedTypes, label) {
    const errors = [];
    if (!doc || typeof doc !== 'object') return { errors: [`${label} is required`], value: null };
    const value = {
        type: doc.type,
        title: String(doc.title || '').trim(),
        issuingAuthority: String(doc.issuingAuthority || '').trim(),
        number: String(doc.number || '').trim(),
        expiresOn: doc.expiresOn || null
    };
    if (!allowedTypes.includes(value.type)) errors.push(`${label}.type must be one of: ${allowedTypes.join(', ')}`);
    if (!value.issuingAuthority) errors.push(`${label}.issuingAuthority is required`);
    if (!value.number) errors.push(`${label}.number is required`);
    if (value.expiresOn && !parseIsoDate(value.expiresOn)) errors.push(`${label}.expiresOn must be YYYY-MM-DD`);
    return { errors, value };
}

/** Section 1: completed by the employee no later than the first day of employment */
function validateI9Section1(input, signerLegalName) {
    const errors = [];
    const b = input || {};
    const value = {};

    if (!I9_CITIZENSHIP.includes(b.citizenshipStatus)) errors.push(`citizenshipStatus must be one of: ${I9_CITIZENSHIP.join(', ')}`);
    else value.citizenshipStatus = b.citizenshipStatus;

    if (value.citizenshipStatus === 'lawful_permanent_resident' || value.citizenshipStatus === 'alien_authorized_to_work') {
        const id = String(b.authorizationNumber || '').trim();
        if (!id) errors.push('authorizationNumber (A-Number, USCIS number, I-94 or passport number) is required');
        else value.authorizationNumber = id;
    }
    if (value.citizenshipStatus === 'alien_authorized_to_work') {
        if (!parseIsoDate(b.workAuthorizationExpires)) errors.push('workAuthorizationExpires (YYYY-MM-DD) is required');
        else value.workAuthorizationExpires = b.workAuthorizationExpires;
    }
    if (b.otherLastNamesUsed) value.otherLastNamesUsed = String(b.otherLastNamesUsed).trim();

    const signed = String(b.signedName || '').trim();
    if (!b.attestation) errors.push('attestation is required (under penalty of perjury)');
    if (!signed) errors.push('signedName is required');
    else if (signerLegalName && signed.toLowerCase() !== String(signerLegalName).trim().toLowerCase()) {
        errors.push('signedName must match the employee legal name');
    } else value.signedName = signed;

    if (b.preparerUsed === true) {
        value.preparerUsed = true;
        const prep = String(b.preparerName || '').trim();
        if (!prep) errors.push('preparerName is required when a preparer or translator helped');
        else value.preparerName = prep;
    }
    return { errors, value };
}

/** Section 2: completed by the employer within 3 business days of the first day of employment */
function validateI9Section2(input, firstDayIso) {
    const errors = [];
    const b = input || {};
    const value = {};

    const hasA = Boolean(b.listA);
    const hasBC = Boolean(b.listB || b.listC);
    if (hasA && hasBC) errors.push('Provide one List A document, or one List B plus one List C document, not both');
    else if (!hasA && !(b.listB && b.listC)) errors.push('Provide one List A document, or one List B and one List C document');
    else if (hasA) {
        const r = validateDocument(b.listA, I9_LIST_A, 'listA'); errors.push(...r.errors); value.listA = r.value;
    } else {
        const rb = validateDocument(b.listB, I9_LIST_B, 'listB'); errors.push(...rb.errors); value.listB = rb.value;
        const rc = validateDocument(b.listC, I9_LIST_C, 'listC'); errors.push(...rc.errors); value.listC = rc.value;
    }

    if (!parseIsoDate(b.examinedOn)) errors.push('examinedOn (YYYY-MM-DD) is required');
    else value.examinedOn = b.examinedOn;
    if (!['in_person', 'alternative_procedure'].includes(b.examinationMethod)) errors.push('examinationMethod must be in_person or alternative_procedure');
    else value.examinationMethod = b.examinationMethod;
    if (!parseIsoDate(firstDayIso)) errors.push('The employee has no first day of employment on file');
    else value.firstDayOfEmployment = firstDayIso;

    ['signerName', 'signerTitle'].forEach((f) => {
        const v = String(b[f] || '').trim();
        if (!v) errors.push(`${f} is required`); else value[f] = v;
    });
    if (!b.certification) errors.push('certification is required (employer attests the documents appear genuine)');
    return { errors, value };
}

/** Earliest expiry among the documents and the work-authorization date that need reverification */
function reverificationDate(section1, section2) {
    const dates = [];
    if (section1 && section1.workAuthorizationExpires) dates.push(section1.workAuthorizationExpires);
    if (section2) {
        ['listA', 'listC'].forEach((k) => { if (section2[k] && section2[k].expiresOn) dates.push(section2[k].expiresOn); });
    }
    return dates.length ? dates.sort()[0] : null;
}

/** I-9 records are kept for the later of 3 years after hire or 1 year after termination */
function retainUntil(hireIso, terminationIso) {
    const hire = parseIsoDate(hireIso);
    if (!hire) return null;
    const a = new Date(Date.UTC(hire.getUTCFullYear() + 3, hire.getUTCMonth(), hire.getUTCDate()));
    if (!terminationIso) return isoDate(a);
    const t = parseIsoDate(terminationIso);
    if (!t) return isoDate(a);
    const b = new Date(Date.UTC(t.getUTCFullYear() + 1, t.getUTCMonth(), t.getUTCDate()));
    return isoDate(a > b ? a : b);
}

/**
 * Status of one employee's onboarding paperwork on `todayIso`.
 * i9.state: not_started | section1_done | complete; flags tell what is late.
 */
function onboardingStatus({ firstDay, w4, i9, todayIso, options = {} }) {
    const section1 = i9 && i9.section1;
    const section2 = i9 && i9.section2;
    const section1Due = firstDay || null;
    const section2Due = firstDay ? addBusinessDays(firstDay, 3, options) : null;
    const state = section2 ? 'complete' : section1 ? 'section1_done' : 'not_started';

    const flags = [];
    if (!w4 || !w4.current) flags.push(firstDay && todayIso > firstDay ? 'w4_overdue' : 'w4_pending');
    if (!section1 && section1Due && todayIso > section1Due) flags.push('i9_section1_overdue');
    if (!section2 && section2Due && todayIso > section2Due) flags.push('i9_section2_overdue');

    const reverifyOn = reverificationDate(section1, section2);
    if (reverifyOn) {
        const days = Math.round((parseIsoDate(reverifyOn) - parseIsoDate(todayIso)) / 86400000);
        if (days < 0) flags.push('i9_reverification_overdue');
        else if (days <= 90) flags.push('i9_reverification_soon');
    }
    return {
        w4: w4 && w4.current ? 'complete' : 'missing',
        i9State: state,
        i9Section1Due: section1Due,
        i9Section2Due: section2Due,
        reverifyOn,
        flags,
        ok: flags.length === 0 || flags.every((f) => f.endsWith('_pending') || f === 'i9_reverification_soon')
    };
}

module.exports = {
    W4_FILING_STATUSES, I9_CITIZENSHIP, I9_LIST_A, I9_LIST_B, I9_LIST_C,
    parseIsoDate, isoDate, federalHolidays, addBusinessDays,
    validateW4, validateI9Section1, validateI9Section2, reverificationDate, retainUntil, onboardingStatus
};
