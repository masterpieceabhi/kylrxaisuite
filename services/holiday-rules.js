/**
 * Company holiday calendar rules (pure).
 * Federal holidays are generated for a year (same observed dates as services/us-forms federalHolidays);
 * the company overrides them (paid/unpaid, switched off, only some locations) and adds its own days.
 * Stored docs (collection company_holidays): { orgId, kind: 'federal'|'custom', federalKey?, date, name, paid, observedRule, locationIds[], active }
 */
const { parseIsoDate, isoDate, federalHolidays } = require('./us-forms');

const OBSERVED_RULES = ['none', 'nearest_weekday'];

function nth(year, month, weekday, n) {
    if (n > 0) {
        const first = new Date(Date.UTC(year, month, 1));
        return new Date(Date.UTC(year, month, 1 + ((weekday - first.getUTCDay() + 7) % 7) + (n - 1) * 7));
    }
    const last = new Date(Date.UTC(year, month + 1, 0));
    return new Date(Date.UTC(year, month, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7)));
}

/** Observed shift: Saturday -> Friday, Sunday -> Monday */
function observed(iso, rule = 'nearest_weekday') {
    if (rule === 'none') return iso;
    const d = parseIsoDate(iso);
    if (!d) return iso;
    if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
    else if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
    return isoDate(d);
}

/** The federal holidays of a calendar year with names; `date` is the day it is observed. */
function namedFederalHolidays(year) {
    const fixed = [['new_years_day', "New Year's Day", 0, 1], ['juneteenth', 'Juneteenth', 5, 19], ['independence_day', 'Independence Day', 6, 4],
        ['veterans_day', 'Veterans Day', 10, 11], ['christmas', 'Christmas Day', 11, 25]]
        .map(([key, name, m, d]) => { const nominal = isoDate(new Date(Date.UTC(year, m, d))); return { key: `${key}`, name, nominalDate: nominal, date: observed(nominal) }; });
    const floating = [['mlk_day', 'Martin Luther King Jr. Day', 0, 1, 3], ['presidents_day', "Washington's Birthday (Presidents' Day)", 1, 1, 3],
        ['memorial_day', 'Memorial Day', 4, 1, -1], ['labor_day', 'Labor Day', 8, 1, 1], ['columbus_day', 'Columbus Day', 9, 1, 2], ['thanksgiving', 'Thanksgiving Day', 10, 4, 4]]
        .map(([key, name, m, wd, n]) => { const d = isoDate(nth(year, m, wd, n)); return { key, name, nominalDate: d, date: d }; });
    return [...fixed, ...floating].map((h) => ({ ...h, federalKey: `${h.key}`, kind: 'federal' }));
}

function validateHoliday(input) {
    const errors = [];
    const b = input || {};
    const value = {};
    const kind = b.kind === 'federal' ? 'federal' : 'custom';
    value.kind = kind;
    if (kind === 'federal') {
        const keys = namedFederalHolidays(2026).map((h) => h.federalKey);
        if (!keys.includes(b.federalKey)) errors.push(`federalKey must be one of: ${keys.join(', ')}`);
        else value.federalKey = b.federalKey;
        const year = Number(b.year);
        if (!Number.isInteger(year) || year < 2000 || year > 2100) errors.push('year is required for a federal holiday override');
        else value.year = year;
    } else {
        if (!parseIsoDate(b.date)) errors.push('date must be a valid date (YYYY-MM-DD)');
        else value.date = String(b.date);
        const name = String(b.name || '').trim();
        if (!name) errors.push('name is required'); else value.name = name.slice(0, 100);
    }
    value.paid = b.paid === undefined ? true : Boolean(b.paid);
    value.active = b.active === undefined ? true : Boolean(b.active);
    const rule = b.observedRule || (kind === 'custom' ? 'none' : 'nearest_weekday');
    if (!OBSERVED_RULES.includes(rule)) errors.push(`observedRule must be one of: ${OBSERVED_RULES.join(', ')}`);
    else value.observedRule = rule;
    const loc = b.locationIds === undefined || b.locationIds === null ? [] : b.locationIds;
    if (!Array.isArray(loc) || loc.some((x) => typeof x !== 'string')) errors.push('locationIds must be a list of location ids (empty = all locations)');
    else value.locationIds = loc;
    if (kind === 'federal' && b.name) value.name = String(b.name).trim().slice(0, 100);
    return { errors, value };
}

/**
 * The calendar of one year: federal holidays (with company overrides applied) plus custom days.
 * Returns [{ id, kind, name, nominalDate, date (observed), paid, active, locationIds, federalKey }] sorted by date.
 */
function buildCalendar(year, docs = []) {
    const overrides = new Map();
    for (const d of docs) if (d.kind === 'federal' && d.federalKey) overrides.set(`${d.federalKey}:${d.year}`, d);
    const out = [];
    // a January 1 on a Saturday is observed on 31 December of the year before
    for (const y of [year, year + 1]) {
        for (const h of namedFederalHolidays(y)) {
            const o = overrides.get(`${h.federalKey}:${y}`);
            const date = o && o.observedRule ? observed(h.nominalDate, o.observedRule) : h.date;
            if (parseIsoDate(date).getUTCFullYear() !== year) continue;
            out.push({
                id: o ? o.id || null : null, kind: 'federal', federalKey: h.federalKey, name: (o && o.name) || h.name, nominalDate: h.nominalDate, date,
                paid: o ? o.paid !== false : true, active: o ? o.active !== false : true, locationIds: (o && o.locationIds) || [], customized: Boolean(o)
            });
        }
    }
    for (const d of docs) {
        if (d.kind !== 'custom' || !d.date) continue;
        const date = observed(d.date, d.observedRule || 'none');
        if (parseIsoDate(date).getUTCFullYear() !== year) continue;
        out.push({ id: d.id || null, kind: 'custom', name: d.name, nominalDate: d.date, date, paid: d.paid !== false, active: d.active !== false, locationIds: d.locationIds || [], customized: true });
    }
    return out.sort((a, b) => (a.date === b.date ? String(a.name).localeCompare(String(b.name)) : a.date < b.date ? -1 : 1));
}

/** Holiday record for a date (active, applies to the location if given), or null */
function holidayOn(calendar, dateIso, locationId) {
    return calendar.find((h) => h.active && h.date === dateIso &&
        (!h.locationIds.length || !locationId || h.locationIds.includes(locationId))) || null;
}

/** Observed dates of active holidays in a year as a Set (for pay date adjustment) */
function holidayDateSet(calendar, locationId) {
    return new Set(calendar.filter((h) => h.active && (!h.locationIds.length || !locationId || h.locationIds.includes(locationId))).map((h) => h.date));
}

module.exports = { OBSERVED_RULES, observed, namedFederalHolidays, validateHoliday, buildCalendar, holidayOn, holidayDateSet, federalHolidays };
