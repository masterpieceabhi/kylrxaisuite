/**
 * State new-hire reporting rules (pure, no I/O).
 * Employers report new hires to a state agency within a number of days. The days differ by state and
 * change, so each company keeps its own agency table. The seed values below are PLACEHOLDERS marked
 * "verify with your state agency": the federal rule is a maximum of 20 days and some states are shorter.
 */
const { US_STATES } = require('./us-validation');
const { parseIsoDate, isoDate } = require('./us-forms');

const METHODS = ['online_portal', 'file_upload', 'fax', 'mail', 'other'];
const FEDERAL_MAX_DAYS = 20;
const SEED_NOTE = 'Seed value. Verify with your state agency before relying on it.';

const addCalendarDays = (iso, n) => { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };

function seedAgencies(states) {
    return (states || US_STATES).map((st) => ({
        state: st, agencyName: `${st} state new-hire reporting agency`, portalUrl: '', portalNote: 'Find your state agency on the federal Office of Child Support Services employer pages (acf.hhs.gov/css). ' + SEED_NOTE,
        dueDays: FEDERAL_MAX_DAYS, method: 'online_portal', seeded: true, verified: false
    }));
}

function validateAgency(input) {
    const errors = [];
    const b = input || {};
    const state = String(b.state || '').trim().toUpperCase();
    if (!US_STATES.includes(state)) errors.push('state must be a US state or territory code');
    const agencyName = String(b.agencyName || '').replace(/[<>]/g, '').trim().slice(0, 120);
    if (!agencyName) errors.push('agencyName is required');
    const dueDays = Number(b.dueDays);
    if (!Number.isInteger(dueDays) || dueDays < 1 || dueDays > FEDERAL_MAX_DAYS) errors.push(`dueDays must be a whole number from 1 to ${FEDERAL_MAX_DAYS}`);
    if (b.method !== undefined && !METHODS.includes(b.method)) errors.push(`method must be one of: ${METHODS.join(', ')}`);
    let portalUrl = String(b.portalUrl || '').trim();
    if (portalUrl && !/^https:\/\/[^\s<>"']+$/i.test(portalUrl)) errors.push('portalUrl must start with https://');
    if (errors.length) return { errors, value: null };
    return { errors, value: { state, agencyName, portalUrl, portalNote: String(b.portalNote || '').replace(/[<>]/g, '').slice(0, 400), dueDays, method: b.method || 'online_portal', seeded: false, verified: b.verified === true } };
}

const startDateOf = (u) => { const d = String((u.usProfile && u.usProfile.startDate) || u.joiningDate || '').slice(0, 10); return parseIsoDate(d) ? d : null; };
const stateOf = (u, org) => {
    const s = u.usProfile && u.usProfile.workState;
    if (s) return String(s).toUpperCase();
    const states = (org && org.usProfile && org.usProfile.workStates) || [];
    return states[0] ? String(states[0]).toUpperCase() : null;
};

/**
 * people: [{ id, data }] from users. agencies: { STATE: agency }. submitted: Set of userIds.
 * Returns rows for people hired on/after sinceIso that have not been reported, with due dates and overdue flags.
 */
function pendingList(people, agencies, submitted, org, todayIso, sinceIso) {
    const rows = [];
    for (const p of people) {
        const u = p.data;
        if (/^terminated$/i.test(String(u.status || ''))) continue;
        const start = startDateOf(u);
        if (!start || start < sinceIso || submitted.has(p.id)) continue;
        const state = stateOf(u, org);
        const agency = state ? agencies[state] : null;
        const dueDays = agency ? agency.dueDays : FEDERAL_MAX_DAYS;
        const dueDate = addCalendarDays(start, dueDays);
        rows.push({
            userId: p.id, employeeId: u.employeeId || null, name: u.name || null, state, startDate: start, dueDate,
            overdue: todayIso > dueDate, daysLeft: Math.round((parseIsoDate(dueDate) - parseIsoDate(todayIso)) / 86400000),
            ssnLast4: (u.usProfile && u.usProfile.taxpayerIdLast4) || null, hasSsn: Boolean(u.usProfile && u.usProfile.taxpayerIdEncrypted),
            agencyConfigured: Boolean(agency), agencyName: agency ? agency.agencyName : null
        });
    }
    return rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
}

const CSV_COLUMNS = ['Employee First Name', 'Employee Last Name', 'Employee SSN', 'Employee Address', 'Employee City', 'Employee State', 'Employee ZIP', 'Date of Hire', 'Work State', 'Employer Name', 'Employer FEIN', 'Employer Address', 'Employer City', 'Employer State', 'Employer ZIP'];

/** CSV cell: quoted, and a leading = + - @ is neutralized so a spreadsheet cannot run it as a formula */
function csvCell(v) {
    let s = String(v === undefined || v === null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
}

/** entries: [{ user, ssn (full digits or ''), }] */
function buildCsv(entries, org) {
    const o = org.usProfile || {}; const oa = o.businessAddress || {};
    const lines = [CSV_COLUMNS.map(csvCell).join(',')];
    for (const e of entries) {
        const u = e.user; const p = u.usProfile || {}; const a = p.homeAddress || {};
        const name = String(u.name || '').trim().split(' ');
        const first = p.legalFirstName || name[0] || ''; const last = p.legalLastName || name.slice(1).join(' ');
        lines.push([
            first, last, e.ssn ? `${e.ssn.slice(0, 3)}-${e.ssn.slice(3, 5)}-${e.ssn.slice(5)}` : '', [a.line1, a.line2].filter(Boolean).join(' '), a.city, a.state, a.zip,
            startDateOf(u) || '', stateOf(u, org) || '', org.name || org.companyName || '', o.ein || '', [oa.line1, oa.line2].filter(Boolean).join(' '), oa.city, oa.state, oa.zip
        ].map(csvCell).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}

function validateSubmission(input, todayIso) {
    const errors = [];
    const b = input || {};
    const ids = Array.isArray(b.userIds) ? [...new Set(b.userIds.map(String))] : [];
    if (!ids.length || ids.length > 500) errors.push('userIds needs 1 to 500 people');
    const state = String(b.state || '').trim().toUpperCase();
    if (!US_STATES.includes(state)) errors.push('state must be a US state or territory code');
    const confirmationNumber = String(b.confirmationNumber || '').replace(/[^A-Za-z0-9 _.-]/g, '').trim().slice(0, 60);
    if (confirmationNumber.length < 3) errors.push('confirmationNumber is required (at least 3 characters)');
    const submittedOn = b.submittedOn || todayIso;
    if (!parseIsoDate(submittedOn)) errors.push('submittedOn must be YYYY-MM-DD'); else if (submittedOn > todayIso) errors.push('submittedOn cannot be in the future');
    return { errors, value: errors.length ? null : { userIds: ids, state, confirmationNumber, submittedOn } };
}

module.exports = { METHODS, FEDERAL_MAX_DAYS, CSV_COLUMNS, seedAgencies, validateAgency, startDateOf, stateOf, pendingList, csvCell, buildCsv, validateSubmission, addCalendarDays };
