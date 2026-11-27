/**
 * Company holiday lookups for other modules.
 *   const { isCompanyHoliday } = require('../services/company-holidays');
 *   await isCompanyHoliday(orgId, '2026-07-03', { locationId })   // -> true / false
 *   await companyHolidayInfo(orgId, '2026-07-03')                   // -> { name, paid, kind, date } | null
 *   await holidaySetForRange(orgId, '2026-01-01', '2026-12-31')     // -> Set of observed ISO dates (active holidays)
 * Federal holidays count unless the company switched them off on its calendar.
 */
const { listByOrg } = require('./people-data-store');
const H = require('./holiday-rules');

const cache = new Map(); // orgId -> { at, docs }
const TTL_MS = 30 * 1000;

async function docsFor(orgId) {
    const hit = cache.get(orgId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.docs;
    const docs = await listByOrg('company_holidays', orgId);
    cache.set(orgId, { at: Date.now(), docs });
    return docs;
}

/** Call after the calendar changes so readers see it at once */
function invalidate(orgId) { cache.delete(orgId); }

async function calendarFor(orgId, year) {
    return H.buildCalendar(year, await docsFor(orgId));
}

async function companyHolidayInfo(orgId, dateIso, { locationId } = {}) {
    const year = Number(String(dateIso).slice(0, 4));
    if (!Number.isInteger(year)) return null;
    const h = H.holidayOn(await calendarFor(orgId, year), String(dateIso).slice(0, 10), locationId);
    return h ? { name: h.name, paid: h.paid, kind: h.kind, date: h.date } : null;
}

async function isCompanyHoliday(orgId, dateIso, opts = {}) {
    return Boolean(await companyHolidayInfo(orgId, dateIso, opts));
}

async function holidaySetForRange(orgId, fromIso, toIso, { locationId } = {}) {
    const out = new Set();
    const docs = await docsFor(orgId);
    for (let y = Number(fromIso.slice(0, 4)); y <= Number(toIso.slice(0, 4)); y += 1) {
        for (const d of H.holidayDateSet(H.buildCalendar(y, docs), locationId)) if (d >= fromIso && d <= toIso) out.add(d);
    }
    return out;
}

module.exports = { isCompanyHoliday, companyHolidayInfo, holidaySetForRange, calendarFor, invalidate };
