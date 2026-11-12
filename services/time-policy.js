/**
 * Company time rules and the pay-hours split for a workweek. Pure functions, no I/O.
 *
 * Nothing about a state is hard-coded: the company chooses its weekly overtime threshold and,
 * where its state requires it, daily overtime, double time, meal-break checks, rest breaks,
 * premium hours for missed breaks, and whether it pays for company holidays. Every setting
 * needs to be confirmed by a US compliance advisor. Rounding is not calculated here.
 */

const DEFAULT_RULES = {
    overtimeWeeklyHours: 40,
    dailyOvertime: { enabled: false, thresholdHours: 8, doubleTimeThresholdHours: null },
    meal: { enabled: false, requiredAfterHours: 5, minimumMinutes: 30 },
    // Paid company holidays: hours added for each paid holiday in the week. who: 'everyone' or 'full_time'.
    holidayPay: { enabled: false, hours: 8, who: 'everyone' },
    // Rest breaks are not punched. When on, the person confirms each week whether they could take them.
    restBreak: { enabled: false, everyHours: 4, minutes: 10 },
    // Extra paid hours for each day with a missed meal break, and each day a missed rest break was reported.
    breakPremium: { enabled: false, hours: 1 }
};
const HOLIDAY_WHO = ['everyone', 'full_time'];

function validateTimeRules(input) {
    const errors = [];
    const b = input || {};
    const value = JSON.parse(JSON.stringify(DEFAULT_RULES));

    if (b.overtimeWeeklyHours !== undefined) {
        const n = Number(b.overtimeWeeklyHours);
        if (!(n > 0 && n <= 168)) errors.push('overtimeWeeklyHours must be between 0 and 168'); else value.overtimeWeeklyHours = n;
    }
    if (b.dailyOvertime) {
        const d = b.dailyOvertime;
        value.dailyOvertime.enabled = d.enabled === true;
        if (d.thresholdHours !== undefined) {
            const n = Number(d.thresholdHours);
            if (!(n > 0 && n <= 24)) errors.push('dailyOvertime.thresholdHours must be between 0 and 24'); else value.dailyOvertime.thresholdHours = n;
        }
        if (d.doubleTimeThresholdHours !== undefined && d.doubleTimeThresholdHours !== null && d.doubleTimeThresholdHours !== '') {
            const n = Number(d.doubleTimeThresholdHours);
            if (!(n > value.dailyOvertime.thresholdHours && n <= 24)) errors.push('dailyOvertime.doubleTimeThresholdHours must be above the daily overtime hours and at most 24');
            else value.dailyOvertime.doubleTimeThresholdHours = n;
        }
    }
    if (b.meal) {
        value.meal.enabled = b.meal.enabled === true;
        for (const [k, max] of [['requiredAfterHours', 24], ['minimumMinutes', 240]]) {
            if (b.meal[k] === undefined) continue;
            const n = Number(b.meal[k]);
            if (!(n > 0 && n <= max)) errors.push(`meal.${k} must be between 0 and ${max}`); else value.meal[k] = n;
        }
    }
    if (b.holidayPay) {
        const h = b.holidayPay;
        value.holidayPay.enabled = h.enabled === true;
        if (h.hours !== undefined) { const n = Number(h.hours); if (!(n > 0 && n <= 24)) errors.push('holidayPay.hours must be between 0 and 24'); else value.holidayPay.hours = n; }
        if (h.who !== undefined) { if (!HOLIDAY_WHO.includes(h.who)) errors.push(`holidayPay.who must be one of: ${HOLIDAY_WHO.join(', ')}`); else value.holidayPay.who = h.who; }
    }
    if (b.restBreak) {
        const r = b.restBreak;
        value.restBreak.enabled = r.enabled === true;
        if (r.everyHours !== undefined) { const n = Number(r.everyHours); if (!(n > 0 && n <= 24)) errors.push('restBreak.everyHours must be between 0 and 24'); else value.restBreak.everyHours = n; }
        if (r.minutes !== undefined) { const n = Number(r.minutes); if (!(n > 0 && n <= 60)) errors.push('restBreak.minutes must be between 0 and 60'); else value.restBreak.minutes = n; }
    }
    if (b.breakPremium) {
        const p = b.breakPremium;
        value.breakPremium.enabled = p.enabled === true;
        if (p.hours !== undefined) { const n = Number(p.hours); if (!(n > 0 && n <= 8)) errors.push('breakPremium.hours must be between 0 and 8'); else value.breakPremium.hours = n; }
    }
    if (value.breakPremium.enabled && !value.meal.enabled && !value.restBreak.enabled) errors.push('Turn on the meal-break check or rest breaks before turning on premium hours for missed breaks');
    return { errors, value };
}

/** Does the company's holiday pay cover this person? person: { exempt, employmentType } */
function holidayPayApplies(rules, person = {}) {
    const h = (rules && rules.holidayPay) || DEFAULT_RULES.holidayPay;
    if (!h.enabled || person.exempt) return false; // salaried exempt staff are paid their salary for the holiday
    if (h.who === 'full_time') return String(person.employmentType || '').toLowerCase().replace(/[^a-z]/g, '') === 'fulltime';
    return true;
}

/**
 * Splits each day's worked minutes into regular, overtime and double time.
 *   days: [{ date, workedMinutes, longestBreakMinutes }] from time-rules.timesheet()
 *   opts.exempt: exempt staff are paid straight time and get no overtime split
 *   opts.paidHolidays: dates (YYYY-MM-DD) of the paid company holidays in this week
 *   opts.holidayEligible: this person gets holiday pay (see holidayPayApplies)
 *   opts.missedRestDays: dates on which the person reported they could not take a rest break
 * Daily overtime is applied first; hours still regular after that count toward the weekly threshold.
 * Holiday hours and premium hours are paid on top. They are not hours worked, so they never count toward overtime.
 * Returns { days: [{ date, workedMinutes, regularMinutes, overtimeMinutes, doubleTimeMinutes, restBreaksDue, premiumMinutes, flags }], holidayPay, totals }.
 */
function computeWeek(days, rules, opts = {}) {
    const r = { ...DEFAULT_RULES, ...(rules || {}) };
    const daily = r.dailyOvertime || DEFAULT_RULES.dailyOvertime;
    const meal = r.meal || DEFAULT_RULES.meal;
    const hol = r.holidayPay || DEFAULT_RULES.holidayPay;
    const rest = r.restBreak || DEFAULT_RULES.restBreak;
    const prem = r.breakPremium || DEFAULT_RULES.breakPremium;
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const weeklyLimit = (r.overtimeWeeklyHours || 40) * 60;
    const missedRest = new Set(opts.missedRestDays || []);
    let regularSoFar = 0;

    const out = sorted.map((d) => {
        const worked = d.workedMinutes;
        let reg = worked; let ot = 0; let dt = 0;
        const flags = [];
        if (!opts.exempt) {
            if (daily.enabled) {
                const otLimit = daily.thresholdHours * 60;
                const dtLimit = daily.doubleTimeThresholdHours ? daily.doubleTimeThresholdHours * 60 : null;
                if (dtLimit !== null && worked > dtLimit) { dt = worked - dtLimit; }
                const afterDt = worked - dt;
                if (afterDt > otLimit) { ot = afterDt - otLimit; }
                reg = worked - dt - ot;
            }
            if (regularSoFar + reg > weeklyLimit) {
                const extra = regularSoFar + reg - weeklyLimit;
                const move = Math.min(extra, reg);
                reg -= move; ot += move;
            }
            regularSoFar += reg;
        }
        if (meal.enabled && !opts.exempt && worked > meal.requiredAfterHours * 60 && (d.longestBreakMinutes || 0) < meal.minimumMinutes) {
            flags.push('missed_meal_break');
        }
        const restBreaksDue = rest.enabled && !opts.exempt ? Math.floor(worked / (rest.everyHours * 60)) : 0;
        if (restBreaksDue > 0 && missedRest.has(d.date)) flags.push('missed_rest_break');
        // one premium for a missed meal break and one for a missed rest break on the same day
        const premiumMinutes = prem.enabled && !opts.exempt ? flags.length * prem.hours * 60 : 0;
        return { date: d.date, workedMinutes: worked, regularMinutes: reg, overtimeMinutes: ot, doubleTimeMinutes: dt, restBreaksDue, premiumMinutes, flags };
    });

    const holidayPay = hol.enabled && opts.holidayEligible && !opts.exempt
        ? [...new Set(opts.paidHolidays || [])].sort().map((date) => ({ date, minutes: hol.hours * 60 })) : [];
    const sum = (k) => out.reduce((s, d) => s + d[k], 0);
    return {
        days: out,
        holidayPay,
        totals: { workedMinutes: sum('workedMinutes'), regularMinutes: sum('regularMinutes'), overtimeMinutes: sum('overtimeMinutes'), doubleTimeMinutes: sum('doubleTimeMinutes'),
            holidayMinutes: holidayPay.reduce((s, h) => s + h.minutes, 0), premiumMinutes: sum('premiumMinutes') },
        flags: Array.from(new Set(out.flatMap((d) => d.flags)))
    };
}

const toHours = (min) => Math.round((min / 60) * 100) / 100;

module.exports = { DEFAULT_RULES, HOLIDAY_WHO, validateTimeRules, holidayPayApplies, computeWeek, toHours };
