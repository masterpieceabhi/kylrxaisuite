/**
 * Dated minimum-wage rules (pure). Nothing here is hard-coded law except the two federal
 * figures that ship as editable seed rows. Everything else is entered by the company.
 * Confirm every rate with a US compliance advisor.
 */
const { parseIsoDate } = require('./us-forms');

const JURISDICTIONS = ['federal', 'state', 'county', 'city'];
const round2 = (n) => Math.round(n * 100) / 100;

const SEED_RULES = [
    {
        jurisdiction: 'federal', state: null, name: 'United States', effectiveDate: '2009-07-24',
        hourlyMinimum: 7.25, tippedCashWage: 2.13, verified: true, seed: true,
        notes: 'Federal minimum wage and federal tipped cash wage. Editable; confirm current figures.'
    }
];

const norm = (s) => String(s || '').trim().toLowerCase();

function validateRule(input) {
    const errors = [];
    const b = input || {};
    const value = {};
    if (!JURISDICTIONS.includes(b.jurisdiction)) errors.push(`jurisdiction must be one of: ${JURISDICTIONS.join(', ')}`);
    else value.jurisdiction = b.jurisdiction;

    const state = String(b.state || '').trim().toUpperCase();
    value.state = null; value.name = null;
    if (value.jurisdiction === 'state') {
        if (!/^[A-Z]{2}$/.test(state)) errors.push('state must be a 2-letter state code');
        else { value.state = state; value.name = state; }
    } else if (value.jurisdiction === 'county' || value.jurisdiction === 'city') {
        if (!/^[A-Z]{2}$/.test(state)) errors.push('state (2-letter code) is required for a county or city rule');
        else value.state = state;
        const name = String(b.name || '').trim();
        if (name.length < 2) errors.push(`name of the ${value.jurisdiction} is required`);
        else value.name = name;
    } else if (value.jurisdiction === 'federal') value.name = 'United States';

    if (!parseIsoDate(b.effectiveDate)) errors.push('effectiveDate must be a valid date (YYYY-MM-DD)');
    else value.effectiveDate = b.effectiveDate;

    const num = (field) => {
        if (b[field] === undefined || b[field] === null || b[field] === '') return null;
        const n = Number(b[field]);
        if (!Number.isFinite(n) || n < 0 || n > 200) { errors.push(`${field} must be a number between 0 and 200`); return null; }
        return round2(n);
    };
    value.hourlyMinimum = num('hourlyMinimum');
    value.tippedCashWage = num('tippedCashWage');
    if (value.hourlyMinimum === null && value.tippedCashWage === null) errors.push('enter an hourly minimum, a tipped cash wage, or both');
    if (value.hourlyMinimum !== null && value.tippedCashWage !== null && value.tippedCashWage > value.hourlyMinimum) errors.push('tippedCashWage cannot be higher than hourlyMinimum');
    value.notes = String(b.notes || '').trim().slice(0, 500);
    value.verified = b.verified === true || b.verified === 'true';
    return { errors, value };
}

const scopeKey = (r) => `${r.jurisdiction}|${norm(r.state)}|${r.jurisdiction === 'state' ? '' : norm(r.name)}`;

/** Does this rule cover a worker located at { state, city, county }? */
function appliesTo(rule, loc) {
    const l = loc || {};
    if (rule.jurisdiction === 'federal') return true;
    if (norm(rule.state) !== norm(l.state)) return false;
    if (rule.jurisdiction === 'state') return true;
    if (rule.jurisdiction === 'city') return Boolean(l.city) && norm(rule.name) === norm(l.city);
    if (rule.jurisdiction === 'county') return Boolean(l.county) && norm(rule.name) === norm(l.county);
    return false;
}

/**
 * Effective minimum for a location on a date: for each applicable jurisdiction take its newest rule
 * that has started; the highest hourly minimum wins. The tipped cash wage is the highest cash wage
 * any applicable jurisdiction requires (a rule with no tipped wage means no tip credit there, so
 * the full hourly minimum is the cash wage).
 */
function effectiveMinimum(rules, loc, date) {
    const latest = new Map();
    for (const r of rules || []) {
        if (r.active === false || !appliesTo(r, loc) || String(r.effectiveDate) > String(date)) continue;
        const k = scopeKey(r);
        const cur = latest.get(k);
        if (!cur || String(r.effectiveDate) > String(cur.effectiveDate)) latest.set(k, r);
    }
    const used = [...latest.values()];
    let hourly = null; let tipped = null; let hourlySource = null; let tippedSource = null;
    for (const r of used) {
        if (r.hourlyMinimum !== null && r.hourlyMinimum !== undefined && (hourly === null || r.hourlyMinimum > hourly)) { hourly = r.hourlyMinimum; hourlySource = r; }
        const cash = r.tippedCashWage !== null && r.tippedCashWage !== undefined ? r.tippedCashWage : r.hourlyMinimum;
        if (cash !== null && cash !== undefined && (tipped === null || cash > tipped)) { tipped = cash; tippedSource = r; }
    }
    if (tipped !== null && hourly !== null && tipped > hourly) tipped = hourly;
    const brief = (r) => (r ? { id: r.id || null, jurisdiction: r.jurisdiction, name: r.name, state: r.state, effectiveDate: r.effectiveDate, verified: r.verified === true } : null);
    return {
        date, hourlyMinimum: hourly, tippedCashWage: tipped, hourlySource: brief(hourlySource), tippedSource: brief(tippedSource),
        unverified: used.some((r) => r.verified !== true), rulesUsed: used.length
    };
}

/** Hourly employees paid below the effective minimum. People: { id, name, payType, payRate, workState, workCity, workCounty, tipped } */
function checkEmployees(rules, people, date) {
    const rows = []; const violations = [];
    for (const p of people || []) {
        if (p.payType !== 'hourly' || !(Number(p.payRate) > 0)) continue;
        const eff = effectiveMinimum(rules, { state: p.workState, city: p.workCity, county: p.workCounty }, date);
        const required = eff.hourlyMinimum;
        const row = { id: p.id, name: p.name, workState: p.workState || null, workCity: p.workCity || null, payRate: Number(p.payRate), minimum: required, tipped: Boolean(p.tipped), source: eff.hourlySource, unverified: eff.unverified };
        if (required !== null) {
            row.shortfall = round2(Math.max(0, required - row.payRate));
            row.ok = row.payRate >= required;
            // A tipped worker may legally be paid the tipped cash wage on the clock; flag but do not fail them
            if (!row.ok && row.tipped && eff.tippedCashWage !== null && row.payRate >= eff.tippedCashWage) { row.ok = true; row.note = 'Tipped: cash wage at or above the tipped minimum. Check the tip credit each pay period.'; }
        } else { row.ok = true; row.note = 'No minimum wage rule applies'; }
        rows.push(row);
        if (!row.ok) violations.push(row);
    }
    return { date, checked: rows.length, violations, rows };
}

/** One call for other modules: is this pay rate acceptable for this person today? */
function checkRate(rules, loc, date, rate, { tipped = false } = {}) {
    const eff = effectiveMinimum(rules, loc, date);
    const need = tipped ? eff.tippedCashWage : eff.hourlyMinimum;
    if (need === null) return { ok: true, minimum: null, effective: eff };
    return { ok: Number(rate) >= need, minimum: need, shortfall: round2(Math.max(0, need - Number(rate))), effective: eff };
}

/** Rules for one scope ordered newest first, for the history view */
function history(rules, filter) {
    return (rules || []).filter((r) => (!filter.jurisdiction || r.jurisdiction === filter.jurisdiction) && (!filter.state || norm(r.state) === norm(filter.state)) && (!filter.name || norm(r.name) === norm(filter.name)))
        .sort((a, b) => String(b.effectiveDate).localeCompare(String(a.effectiveDate)));
}

module.exports = { JURISDICTIONS, SEED_RULES, validateRule, appliesTo, effectiveMinimum, checkEmployees, checkRate, history, scopeKey };
