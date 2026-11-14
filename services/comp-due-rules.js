/**
 * Which job and pay changes are due to take effect (pure, no I/O).
 *
 * A change is due when it is approved, has not been applied yet, and its effective date is today or earlier
 * in the company's own time zone. Used by the hourly job and the "Apply now" button in routes/us-comp.js.
 * Applying is safe to repeat: a change that was applied is no longer due.
 */
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
const isApproved = (r) => (r.status || 'approved') === 'approved';

/** Is this one record due on this day (YYYY-MM-DD)? */
function isDue(record, today) {
    if (!record || !isDate(today) || !isDate(record.effectiveDate)) return false;
    return isApproved(record) && !record.applied && record.effectiveDate <= today;
}

/** The due records out of a list, oldest first */
function dueRecords(records, today) {
    return (records || []).filter((r) => isDue(r, today)).sort((a, b) => (a.effectiveDate === b.effectiveDate ? String(a.createdAt || '').localeCompare(String(b.createdAt || '')) : a.effectiveDate < b.effectiveDate ? -1 : 1));
}

/** The people in one company who have at least one due record: [{ userId, recordIds }] */
function duePeople(records, today) {
    const by = new Map();
    for (const r of dueRecords(records, today)) {
        if (!r.userId) continue;
        if (!by.has(r.userId)) by.set(r.userId, []);
        by.get(r.userId).push(r.id);
    }
    return [...by.entries()].map(([userId, recordIds]) => ({ userId, recordIds }));
}

/**
 * Splits not-yet-applied records from every company into one work list per company.
 * records: [{ orgId, userId, status, applied, effectiveDate }]; todayByOrg: { orgId: 'YYYY-MM-DD' } (each company's own day).
 * A company with no known day is left out, so nothing is applied on a guess.
 */
function workByCompany(records, todayByOrg) {
    const orgs = new Map();
    for (const r of records || []) { if (!r || !r.orgId) continue; if (!orgs.has(r.orgId)) orgs.set(r.orgId, []); orgs.get(r.orgId).push(r); }
    const out = [];
    for (const [orgId, list] of orgs) {
        const today = (todayByOrg || {})[orgId];
        if (!isDate(today)) continue;
        const people = duePeople(list, today);
        if (people.length) out.push({ orgId, today, people });
    }
    return out;
}

/** Company ids that have something waiting (approved, not applied), whatever the date */
function companiesWaiting(records) {
    return [...new Set((records || []).filter((r) => r && r.orgId && r.userId && isApproved(r) && !r.applied).map((r) => r.orgId))];
}

module.exports = { isDue, dueRecords, duePeople, workByCompany, companiesWaiting };
