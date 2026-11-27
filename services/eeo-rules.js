/**
 * EEO self-identification and EEO-1 style counts (pure).
 *
 * Self-identification is voluntary, kept apart from the personnel record, and only ever shown to
 * HR as totals. Who must file an EEO-1 report, and when, is set by the EEOC: confirm on eeoc.gov.
 */

const SEX = ['male', 'female', 'non_binary', 'declined'];
const RACES = ['white', 'black', 'asian', 'nhopi', 'aian']; // nhopi: Native Hawaiian or Other Pacific Islander; aian: American Indian or Alaska Native
const HISPANIC = ['yes', 'no', 'declined'];
const VETERAN = ['protected_veteran', 'not_protected_veteran', 'declined'];
const DISABILITY = ['yes', 'no', 'declined'];

const JOB_CATEGORIES = [
    { key: 'exec', label: 'Executive/Senior Level Officials and Managers' },
    { key: 'mid_manager', label: 'First/Mid-Level Officials and Managers' },
    { key: 'professionals', label: 'Professionals' },
    { key: 'technicians', label: 'Technicians' },
    { key: 'sales', label: 'Sales Workers' },
    { key: 'admin_support', label: 'Administrative Support Workers' },
    { key: 'craft', label: 'Craft Workers' },
    { key: 'operatives', label: 'Operatives' },
    { key: 'laborers', label: 'Laborers and Helpers' },
    { key: 'service', label: 'Service Workers' }
];

const RACE_COLUMNS = [
    { key: 'hispanic', label: 'Hispanic or Latino' }, { key: 'white', label: 'White' }, { key: 'black', label: 'Black or African American' },
    { key: 'nhopi', label: 'Native Hawaiian or Other Pacific Islander' }, { key: 'asian', label: 'Asian' },
    { key: 'aian', label: 'American Indian or Alaska Native' }, { key: 'two_or_more', label: 'Two or More Races' }
];

function validateSelfId(input) {
    const errors = [];
    const b = input || {};
    const value = {};
    if (b.voluntaryNoticeAccepted !== true) errors.push('Confirm that you understand this is voluntary');
    const pick = (field, list, required = true) => {
        if (b[field] === undefined || b[field] === null || b[field] === '') { if (required) errors.push(`${field} is required (you may choose "declined")`); return; }
        if (!list.includes(b[field])) errors.push(`${field} is not a valid choice`); else value[field] = b[field];
    };
    pick('sex', SEX); pick('hispanic', HISPANIC); pick('veteran', VETERAN); pick('disability', DISABILITY);
    const races = Array.isArray(b.races) ? [...new Set(b.races)] : [];
    if (races.some((r) => !RACES.includes(r))) errors.push('races has a value that is not valid');
    else value.races = races;
    if (value.hispanic === 'yes' && races.length) value.races = races; // both may be given; Hispanic takes priority in counts
    return { errors, value };
}

/** The single EEO-1 race/ethnicity column a person counts in, or null when nothing was reported */
function raceColumn(rec) {
    if (!rec) return null;
    if (rec.hispanic === 'yes') return 'hispanic';
    if ((rec.races || []).length > 1) return 'two_or_more';
    if ((rec.races || []).length === 1) return rec.races[0];
    return null;
}

/**
 * Counts by job category, race/ethnicity column and sex (male/female). Anyone who gave no answer,
 * declined, or is non-binary is listed in `notReported` rather than guessed.
 * people: [{ jobCategory, selfId }]
 */
function eeoReport(people) {
    const rows = JOB_CATEGORIES.map((c) => ({ key: c.key, label: c.label, total: 0, cells: Object.fromEntries(RACE_COLUMNS.flatMap((r) => [[`${r.key}_male`, 0], [`${r.key}_female`, 0]])) }));
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
    const notReported = { noJobCategory: 0, noSelfId: 0, sexNotMaleFemale: 0, noRaceOrEthnicity: 0 };
    let counted = 0;
    for (const p of people) {
        if (!p.jobCategory || !byKey[p.jobCategory]) { notReported.noJobCategory += 1; continue; }
        const rec = p.selfId;
        if (!rec) { notReported.noSelfId += 1; continue; }
        if (rec.sex !== 'male' && rec.sex !== 'female') { notReported.sexNotMaleFemale += 1; continue; }
        const col = raceColumn(rec);
        if (!col) { notReported.noRaceOrEthnicity += 1; continue; }
        const row = byKey[p.jobCategory];
        row.cells[`${col}_${rec.sex}`] += 1; row.total += 1; counted += 1;
    }
    const totals = Object.fromEntries(Object.keys(rows[0].cells).map((k) => [k, rows.reduce((s, r) => s + r.cells[k], 0)]));
    return {
        columns: RACE_COLUMNS, rows, totals, grandTotal: counted, notReported,
        completenessPercent: people.length ? Math.round((counted / people.length) * 100) : 0, people: people.length,
        veterans: people.filter((p) => p.selfId && p.selfId.veteran === 'protected_veteran').length,
        disability: people.filter((p) => p.selfId && p.selfId.disability === 'yes').length
    };
}

module.exports = { SEX, RACES, HISPANIC, VETERAN, DISABILITY, JOB_CATEGORIES, RACE_COLUMNS, validateSelfId, raceColumn, eeoReport };
