/**
 * OSHA injury and illness log (Form 300) and annual summary (Form 300A) rules (pure).
 * Whether a case is recordable, and who must keep or electronically submit these forms, is
 * decided by OSHA's rules for your industry and size: confirm on osha.gov or with a safety advisor.
 */
const { parseIsoDate } = require('./us-forms');

const CLASSIFICATIONS = ['death', 'days_away', 'restricted_or_transfer', 'other_recordable', 'not_recordable'];
const RECORDABLE = ['death', 'days_away', 'restricted_or_transfer', 'other_recordable'];
const INJURY_TYPES = ['injury', 'skin_disorder', 'respiratory', 'poisoning', 'hearing_loss', 'other_illness'];
const MAX_COUNTED_DAYS = 180; // OSHA stops counting days away or restricted at 180 each

const INJURY_LABELS = { injury: 'Injury', skin_disorder: 'Skin disorder', respiratory: 'Respiratory condition', poisoning: 'Poisoning', hearing_loss: 'Hearing loss', other_illness: 'All other illnesses' };

/** What any worker can report. HR decides later whether it is recordable. */
function validateReport(input, todayIso) {
    const errors = [];
    const b = input || {};
    const value = {};
    if (!parseIsoDate(b.dateOfIncident) || b.dateOfIncident > todayIso) errors.push('dateOfIncident must be a real date that is not in the future');
    else value.dateOfIncident = b.dateOfIncident;
    const what = String(b.description || '').trim();
    if (what.length < 5) errors.push('Please describe what happened (at least 5 characters)'); else value.description = what.slice(0, 1000);
    const where = String(b.location || '').trim();
    if (!where) errors.push('Say where it happened'); else value.location = where.slice(0, 120);
    if (b.bodyPart) value.bodyPart = String(b.bodyPart).slice(0, 80);
    value.receivedMedicalTreatment = b.receivedMedicalTreatment === true;
    value.missedWork = b.missedWork === true;
    return { errors, value };
}

/** HR's classification of a case */
function validateClassification(input) {
    const errors = [];
    const b = input || {};
    const value = {};
    if (!CLASSIFICATIONS.includes(b.classification)) errors.push(`classification must be one of: ${CLASSIFICATIONS.join(', ')}`);
    else value.classification = b.classification;
    if (RECORDABLE.includes(value.classification)) {
        if (!INJURY_TYPES.includes(b.injuryType)) errors.push(`injuryType must be one of: ${INJURY_TYPES.join(', ')}`); else value.injuryType = b.injuryType;
    }
    for (const f of ['daysAway', 'daysRestricted']) {
        const n = b[f] === undefined || b[f] === '' ? 0 : Number(b[f]);
        if (!Number.isInteger(n) || n < 0 || n > 366) errors.push(`${f} must be a whole number of days`); else value[f] = Math.min(n, MAX_COUNTED_DAYS);
    }
    if (value.classification === 'days_away' && !(value.daysAway > 0)) errors.push('A days-away case needs at least 1 day away from work');
    if (value.classification === 'restricted_or_transfer' && !(value.daysRestricted > 0)) errors.push('A restricted-work case needs at least 1 restricted day');
    if (b.dateOfDeath) { if (!parseIsoDate(b.dateOfDeath)) errors.push('dateOfDeath must be YYYY-MM-DD'); else value.dateOfDeath = b.dateOfDeath; }
    if (value.classification === 'death' && !value.dateOfDeath) errors.push('A death case needs the date of death');
    value.privacyCase = b.privacyCase === true;
    if (b.jobTitle) value.jobTitle = String(b.jobTitle).slice(0, 80);
    return { errors, value };
}

/** Rows for the Form 300 log for one calendar year (privacy cases hide the name) */
function logRows(incidents, year) {
    return incidents
        .filter((i) => RECORDABLE.includes(i.classification) && String(i.dateOfIncident).startsWith(String(year)))
        .sort((a, b) => a.dateOfIncident.localeCompare(b.dateOfIncident))
        .map((i, idx) => ({
            caseNumber: idx + 1, employeeName: i.privacyCase ? 'Privacy Case' : (i.employeeName || 'Not recorded'), jobTitle: i.jobTitle || '', dateOfIncident: i.dateOfIncident,
            location: i.location, description: i.description, classification: i.classification, daysAway: i.daysAway || 0, daysRestricted: i.daysRestricted || 0,
            injuryType: i.injuryType, injuryTypeLabel: INJURY_LABELS[i.injuryType] || ''
        }));
}

/** Form 300A totals and the standard incidence rates (cases x 200,000 / hours worked) */
function summary(incidents, year, hoursWorked, averageEmployees) {
    const rows = logRows(incidents, year);
    const count = (c) => rows.filter((r) => r.classification === c).length;
    const recordable = rows.length;
    const dart = count('days_away') + count('restricted_or_transfer');
    const rate = (n) => (hoursWorked > 0 ? Math.round(((n * 200000) / hoursWorked) * 100) / 100 : null);
    return {
        year, deaths: count('death'), daysAwayCases: count('days_away'), restrictedCases: count('restricted_or_transfer'), otherRecordable: count('other_recordable'),
        totalRecordable: recordable, totalDaysAway: rows.reduce((s, r) => s + r.daysAway, 0), totalDaysRestricted: rows.reduce((s, r) => s + r.daysRestricted, 0),
        byInjuryType: INJURY_TYPES.map((t) => ({ type: t, label: INJURY_LABELS[t], count: rows.filter((r) => r.injuryType === t).length })),
        hoursWorked: Math.round(hoursWorked), averageEmployees: Math.round(averageEmployees * 10) / 10,
        tcir: rate(recordable), dartRate: rate(dart)
    };
}

module.exports = { CLASSIFICATIONS, RECORDABLE, INJURY_TYPES, INJURY_LABELS, MAX_COUNTED_DAYS, validateReport, validateClassification, logRows, summary };
