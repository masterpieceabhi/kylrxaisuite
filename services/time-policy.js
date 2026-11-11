/**
 * Company time rules and the pay-hours split for a workweek. Pure functions, no I/O.
 *
 * Nothing about a state is hard-coded: the company chooses its weekly overtime threshold and,
 * where its state requires it, daily overtime, double time and meal-break checks. Every setting
 * needs to be confirmed by a US compliance advisor. Premium pay and rounding are not calculated here.
 */

const DEFAULT_RULES = {
    overtimeWeeklyHours: 40,
    dailyOvertime: { enabled: false, thresholdHours: 8, doubleTimeThresholdHours: null },
    meal: { enabled: false, requiredAfterHours: 5, minimumMinutes: 30 }
};

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
    return { errors, value };
}

/**
 * Splits each day's worked minutes into regular, overtime and double time.
 *   days: [{ date, workedMinutes, longestBreakMinutes }] from time-rules.timesheet()
 *   opts: { exempt } exempt staff are paid straight time and get no overtime split
 * Daily overtime is applied first; hours still regular after that count toward the weekly threshold.
 * Returns { days: [{ date, workedMinutes, regularMinutes, overtimeMinutes, doubleTimeMinutes, flags }], totals }.
 */
function computeWeek(days, rules, opts = {}) {
    const r = { ...DEFAULT_RULES, ...(rules || {}) };
    const daily = r.dailyOvertime || DEFAULT_RULES.dailyOvertime;
    const meal = r.meal || DEFAULT_RULES.meal;
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const weeklyLimit = (r.overtimeWeeklyHours || 40) * 60;
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
        return { date: d.date, workedMinutes: worked, regularMinutes: reg, overtimeMinutes: ot, doubleTimeMinutes: dt, flags };
    });

    const sum = (k) => out.reduce((s, d) => s + d[k], 0);
    return {
        days: out,
        totals: { workedMinutes: sum('workedMinutes'), regularMinutes: sum('regularMinutes'), overtimeMinutes: sum('overtimeMinutes'), doubleTimeMinutes: sum('doubleTimeMinutes') },
        flags: Array.from(new Set(out.flatMap((d) => d.flags)))
    };
}

const toHours = (min) => Math.round((min / 60) * 100) / 100;

module.exports = { DEFAULT_RULES, validateTimeRules, computeWeek, toHours };
