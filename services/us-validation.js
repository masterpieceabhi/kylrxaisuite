/**
 * Validation and normalization for US company and employee records.
 * Pure functions (no I/O) so they are easy to test. Rates and thresholds are not hard-coded here.
 */

const US_STATES = [
    'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
    'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
    'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
    'PR', 'GU', 'VI', 'AS', 'MP'
];

const CLASSIFICATIONS = ['W2', '1099'];
const FLSA_STATUSES = ['exempt', 'non_exempt'];
const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'seasonal', 'temporary'];
const PAY_TYPES = ['hourly', 'salary'];
const PAY_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'];
const ENTITY_TYPES = ['sole_proprietorship', 'partnership', 'llc', 's_corp', 'c_corp', 'nonprofit'];

const digits = (v) => String(v === undefined || v === null ? '' : v).replace(/\D/g, '');

/** SSN: 9 digits; area not 000, 666 or 900-999; group not 00; serial not 0000. */
function validateSsn(input) {
    const d = digits(input);
    if (d.length !== 9) return { valid: false, error: 'SSN must have 9 digits' };
    const area = Number(d.slice(0, 3));
    const group = Number(d.slice(3, 5));
    const serial = Number(d.slice(5));
    if (area === 0 || area === 666 || area >= 900) return { valid: false, error: 'SSN area number is not valid' };
    if (group === 0) return { valid: false, error: 'SSN group number is not valid' };
    if (serial === 0) return { valid: false, error: 'SSN serial number is not valid' };
    return { valid: true, digits: d, idType: 'SSN', last4: d.slice(5) };
}

/** ITIN: 9 digits starting with 9, fourth and fifth digits in the ranges the IRS assigns. */
function validateItin(input) {
    const d = digits(input);
    if (d.length !== 9 || d[0] !== '9') return { valid: false, error: 'ITIN must have 9 digits starting with 9' };
    const mid = Number(d.slice(3, 5));
    const ok = (mid >= 50 && mid <= 65) || (mid >= 70 && mid <= 88) || (mid >= 90 && mid <= 92) || (mid >= 94 && mid <= 99);
    if (!ok) return { valid: false, error: 'ITIN middle digits are not valid' };
    return { valid: true, digits: d, idType: 'ITIN', last4: d.slice(5) };
}

/** Accepts an SSN, or an ITIN when idType is "ITIN" */
function validateTaxpayerId(input, idType) {
    return String(idType || 'SSN').toUpperCase() === 'ITIN' ? validateItin(input) : validateSsn(input);
}

function maskTaxpayerId(last4) {
    return last4 ? `XXX-XX-${last4}` : null;
}

/** EIN: 9 digits, shown as NN-NNNNNNN; prefix 00 is never issued. */
function validateEin(input) {
    const d = digits(input);
    if (d.length !== 9) return { valid: false, error: 'EIN must have 9 digits' };
    if (d.slice(0, 2) === '00') return { valid: false, error: 'EIN prefix is not valid' };
    return { valid: true, formatted: `${d.slice(0, 2)}-${d.slice(2)}` };
}

function validateZip(input) {
    return /^\d{5}(-\d{4})?$/.test(String(input || '').trim());
}

function validateAddress(a) {
    const errors = [];
    if (!a || typeof a !== 'object') return { errors: ['address is required'], value: null };
    const value = {
        line1: String(a.line1 || '').trim(),
        line2: String(a.line2 || '').trim(),
        city: String(a.city || '').trim(),
        state: String(a.state || '').trim().toUpperCase(),
        zip: String(a.zip || '').trim()
    };
    if (!value.line1) errors.push('address.line1 is required');
    if (!value.city) errors.push('address.city is required');
    if (!US_STATES.includes(value.state)) errors.push('address.state must be a US state or territory code');
    if (!validateZip(value.zip)) errors.push('address.zip must be 12345 or 12345-6789');
    return { errors, value };
}

function parsePastDate(v, minAgeYears) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
    const now = new Date();
    if (d > now) return null;
    if (minAgeYears) {
        const cutoff = new Date(Date.UTC(now.getUTCFullYear() - minAgeYears, now.getUTCMonth(), now.getUTCDate()));
        if (d > cutoff) return null;
    }
    return m[0];
}

/**
 * Validates a US employee profile. Returns { errors, value } where value never contains the
 * taxpayer ID itself (callers encrypt it separately) and has only known fields.
 */
function validateEmployeeProfile(input) {
    const errors = [];
    const body = input || {};
    const value = {};

    const oneOf = (field, list, required) => {
        const raw = body[field];
        if (raw === undefined || raw === null || raw === '') {
            if (required) errors.push(`${field} is required`);
            return;
        }
        if (!list.includes(raw)) errors.push(`${field} must be one of: ${list.join(', ')}`);
        else value[field] = raw;
    };

    ['legalFirstName', 'legalLastName'].forEach((f) => {
        const v = String(body[f] || '').trim();
        if (!v) errors.push(`${f} is required`); else value[f] = v;
    });
    if (body.legalMiddleName) value.legalMiddleName = String(body.legalMiddleName).trim();
    if (body.preferredName) value.preferredName = String(body.preferredName).trim();

    const dob = parsePastDate(body.dateOfBirth, 14);
    if (!dob) errors.push('dateOfBirth must be a valid past date (YYYY-MM-DD) for someone at least 14');
    else value.dateOfBirth = dob;

    const addr = validateAddress(body.homeAddress);
    errors.push(...addr.errors.map((e) => e.replace('address.', 'homeAddress.')));
    if (addr.errors.length === 0) value.homeAddress = addr.value;

    const workState = String(body.workState || '').trim().toUpperCase();
    if (!US_STATES.includes(workState)) errors.push('workState must be a US state or territory code');
    else value.workState = workState;

    oneOf('classification', CLASSIFICATIONS, true);
    oneOf('employmentType', EMPLOYMENT_TYPES, true);
    oneOf('payType', PAY_TYPES, true);
    oneOf('payFrequency', PAY_FREQUENCIES, true);

    if (value.classification === 'W2') {
        oneOf('flsaStatus', FLSA_STATUSES, true);
    } else if (value.classification === '1099' && body.flsaStatus) {
        errors.push('flsaStatus applies to W2 employees only');
    }

    const rate = Number(body.payRate);
    if (!(rate > 0) || !Number.isFinite(rate)) errors.push('payRate must be a positive number');
    else value.payRate = Math.round(rate * 100) / 100;

    if (value.flsaStatus === 'exempt' && value.payType === 'hourly') {
        errors.push('an exempt employee cannot be paid hourly');
    }

    const idType = String(body.taxpayerIdType || 'SSN').toUpperCase();
    if (!['SSN', 'ITIN'].includes(idType)) errors.push('taxpayerIdType must be SSN or ITIN');
    else value.taxpayerIdType = idType;

    return { errors, value };
}

function validateCompanyProfile(input) {
    const errors = [];
    const body = input || {};
    const value = {};

    const ein = validateEin(body.ein);
    if (!ein.valid) errors.push(ein.error); else value.ein = ein.formatted;

    if (!ENTITY_TYPES.includes(body.entityType)) errors.push(`entityType must be one of: ${ENTITY_TYPES.join(', ')}`);
    else value.entityType = body.entityType;

    const legalName = String(body.legalName || '').trim();
    if (!legalName) errors.push('legalName is required'); else value.legalName = legalName;

    const addr = validateAddress(body.businessAddress);
    errors.push(...addr.errors.map((e) => e.replace('address.', 'businessAddress.')));
    if (addr.errors.length === 0) value.businessAddress = addr.value;

    const states = Array.isArray(body.workStates) ? body.workStates.map((s) => String(s).trim().toUpperCase()) : [];
    if (states.length === 0 || states.some((s) => !US_STATES.includes(s))) {
        errors.push('workStates must list at least one valid US state code');
    } else {
        value.workStates = Array.from(new Set(states));
    }
    if (body.stateTaxId) value.stateTaxId = String(body.stateTaxId).trim();
    return { errors, value };
}

module.exports = {
    US_STATES, CLASSIFICATIONS, FLSA_STATUSES, EMPLOYMENT_TYPES, PAY_TYPES, PAY_FREQUENCIES, ENTITY_TYPES,
    validateSsn, validateItin, validateTaxpayerId, maskTaxpayerId, validateEin, validateZip,
    validateAddress, validateEmployeeProfile, validateCompanyProfile
};
