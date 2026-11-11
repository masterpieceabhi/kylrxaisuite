/**
 * Pure rules for clock in/out. No I/O. The server clock is the only clock that counts.
 *
 * Punch types: in, out, break_start, break_end.
 * States: out (not working), in (working), break (on an unpaid break).
 */

const PUNCH_TYPES = ['in', 'out', 'break_start', 'break_end'];
const ALLOWED = { out: ['in'], in: ['out', 'break_start'], break: ['break_end', 'out'] };
const LONG_SHIFT_HOURS = 16;

function localDate(iso, tz) {
    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date(iso));
    } catch (_) {
        return new Date(iso).toISOString().slice(0, 10);
    }
}

/** State after a list of punches (oldest first) */
function stateOf(punches) {
    const last = punches.length ? punches[punches.length - 1] : null;
    if (!last) return 'out';
    if (last.type === 'in' || last.type === 'break_end') return 'in';
    if (last.type === 'break_start') return 'break';
    return 'out';
}

function allowedActions(state) {
    return ALLOWED[state] || [];
}

/** Returns an error code when the punch is not allowed in the current state, else null */
function checkPunch(state, type) {
    if (!PUNCH_TYPES.includes(type)) return 'unknown_action';
    if (!allowedActions(state).includes(type)) {
        if (type === 'in' && state !== 'out') return 'already_in';
        if (type === 'out' && state === 'out') return 'not_in';
        if (type === 'break_start') return state === 'break' ? 'already_on_break' : 'not_in';
        if (type === 'break_end') return 'not_on_break';
        return 'not_allowed';
    }
    return null;
}

/**
 * Worked and break minutes from punches (oldest first). An open shift counts up to `nowIso`.
 * Unpaid breaks are not counted as worked time.
 */
function totals(punches, nowIso) {
    let worked = 0;
    let breakMin = 0;
    let workStart = null;
    let breakStart = null;
    const ms = (iso) => new Date(iso).getTime();
    for (const p of punches) {
        if (p.type === 'in') workStart = ms(p.at);
        else if (p.type === 'break_start' && workStart !== null) {
            worked += ms(p.at) - workStart; workStart = null; breakStart = ms(p.at);
        } else if (p.type === 'break_end' && breakStart !== null) {
            breakMin += ms(p.at) - breakStart; breakStart = null; workStart = ms(p.at);
        } else if (p.type === 'out') {
            if (workStart !== null) worked += ms(p.at) - workStart;
            else if (breakStart !== null) breakMin += ms(p.at) - breakStart;
            workStart = null; breakStart = null;
        }
    }
    const open = workStart !== null || breakStart !== null;
    if (open && nowIso) {
        if (workStart !== null) worked += ms(nowIso) - workStart;
        if (breakStart !== null) breakMin += ms(nowIso) - breakStart;
    }
    return { workedMinutes: Math.max(0, Math.round(worked / 60000)), breakMinutes: Math.max(0, Math.round(breakMin / 60000)), open };
}

/** True when a shift has been open longer than LONG_SHIFT_HOURS (probably a forgotten clock-out) */
function isForgottenClockOut(punches, nowIso) {
    if (stateOf(punches) === 'out') return false;
    const lastIn = [...punches].reverse().find((p) => p.type === 'in');
    if (!lastIn) return false;
    return (new Date(nowIso) - new Date(lastIn.at)) / 3600000 > LONG_SHIFT_HOURS;
}

/** Monday-based week start (ISO date) for a local date */
function weekStart(dateIso) {
    const d = new Date(`${dateIso}T00:00:00Z`);
    const back = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - back);
    return d.toISOString().slice(0, 10);
}

/** Work and break intervals (epoch ms) from punches oldest first; an open one ends at nowIso */
function intervalsOf(punches, nowIso) {
    const out = [];
    const ms = (iso) => new Date(iso).getTime();
    let workStart = null;
    let breakStart = null;
    for (const p of punches) {
        const at = ms(p.at);
        if (p.type === 'in') workStart = at;
        else if (p.type === 'break_start' && workStart !== null) { out.push({ kind: 'work', start: workStart, end: at }); workStart = null; breakStart = at; }
        else if (p.type === 'break_end' && breakStart !== null) { out.push({ kind: 'break', start: breakStart, end: at }); breakStart = null; workStart = at; }
        else if (p.type === 'out') {
            if (workStart !== null) out.push({ kind: 'work', start: workStart, end: at });
            else if (breakStart !== null) out.push({ kind: 'break', start: breakStart, end: at });
            workStart = null; breakStart = null;
        }
    }
    if (nowIso) {
        if (workStart !== null) out.push({ kind: 'work', start: workStart, end: ms(nowIso) });
        if (breakStart !== null) out.push({ kind: 'break', start: breakStart, end: ms(nowIso) });
    }
    return out.filter((i) => i.end > i.start);
}

/** Splits [start, end) at local midnights and adds the minutes to `into` keyed by local date */
function addByDay(into, start, end, tz) {
    const d1 = localDate(new Date(start).toISOString(), tz);
    const d2 = localDate(new Date(end - 1).toISOString(), tz);
    if (d1 === d2 || end - start <= 60000) {
        into.set(d1, (into.get(d1) || 0) + (end - start) / 60000);
        return;
    }
    const mid = Math.floor((start + end) / 2);
    addByDay(into, start, mid, tz);
    addByDay(into, mid, end, tz);
}

/**
 * Groups punches into local days and workweeks (an overnight shift is split at local midnight).
 * overtimeThresholdHours (e.g. 40 for FLSA) is applied per workweek; pass null for none.
 */
function timesheet(punches, tz, nowIso, overtimeThresholdHours) {
    const workByDay = new Map();
    const breakByDay = new Map();
    for (const i of intervalsOf(punches, nowIso)) addByDay(i.kind === 'work' ? workByDay : breakByDay, i.start, i.end, tz);
    // longest single break per day (for meal-break checks)
    const longestBreak = new Map();
    for (const i of intervalsOf(punches, nowIso).filter((x) => x.kind === 'break')) {
        const parts = new Map();
        addByDay(parts, i.start, i.end, tz);
        parts.forEach((min, day) => longestBreak.set(day, Math.max(longestBreak.get(day) || 0, min)));
    }
    const punchCount = new Map();
    for (const p of punches) { const k = localDate(p.at, tz); punchCount.set(k, (punchCount.get(k) || 0) + 1); }
    const dates = new Set([...workByDay.keys(), ...breakByDay.keys(), ...punchCount.keys()]);
    const open = stateOf(punches) !== 'out';
    const days = [...dates].sort().map((date) => ({
        date,
        workedMinutes: Math.round(workByDay.get(date) || 0),
        breakMinutes: Math.round(breakByDay.get(date) || 0),
        longestBreakMinutes: Math.round(longestBreak.get(date) || 0),
        open: open && date === localDate(nowIso || new Date().toISOString(), tz),
        punches: punchCount.get(date) || 0
    }));
    const weeks = new Map();
    for (const d of days) {
        const w = weekStart(d.date);
        weeks.set(w, (weeks.get(w) || 0) + d.workedMinutes);
    }
    const weekRows = [...weeks.entries()].sort().map(([start, minutes]) => {
        const row = { weekStart: start, workedMinutes: minutes };
        if (overtimeThresholdHours) {
            const limit = overtimeThresholdHours * 60;
            row.regularMinutes = Math.min(minutes, limit);
            row.overtimeMinutes = Math.max(0, minutes - limit);
        }
        return row;
    });
    return { days, weeks: weekRows };
}

function tzOffsetMinutes(utcMs, tz) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(utcMs));
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs) / 60000;
}

/** A wall-clock time in a time zone ("2026-11-09", "08:30", "America/Chicago") as a UTC ISO string */
function zonedToUtcIso(dateIso, timeHHMM, tz) {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateIso));
    const tm = /^(\d{1,2}):(\d{2})$/.exec(String(timeHHMM));
    if (!dm || !tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) return null;
    const guess = Date.UTC(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2]);
    let utc = guess - tzOffsetMinutes(guess, tz) * 60000;
    const again = tzOffsetMinutes(utc, tz);
    utc = guess - again * 60000;
    return new Date(utc).toISOString();
}

/** First invalid step in a list of punches (oldest first), or null when the sequence is valid */
function validateSequence(punches) {
    const seen = [];
    for (let i = 0; i < punches.length; i++) {
        const code = checkPunch(stateOf(seen), punches[i].type);
        if (code) return { index: i, code };
        seen.push(punches[i]);
    }
    return null;
}

/** Normalizes what a worker types on a keypad ("1", "0001", "EMP0001") into an employee ID */
function employeeIdFromKeypad(input, prefix = 'EMP', padLength = 4) {
    const digits = String(input || '').replace(/\D/g, '');
    if (!digits || digits.length > padLength + 2) return null;
    return `${prefix}${digits.padStart(padLength, '0')}`;
}

function validPin(pin) {
    return /^\d{4,6}$/.test(String(pin || ''));
}

module.exports = {
    PUNCH_TYPES, LONG_SHIFT_HOURS, localDate, stateOf, allowedActions, checkPunch, totals,
    isForgottenClockOut, weekStart, timesheet, employeeIdFromKeypad, validPin,
    tzOffsetMinutes, zonedToUtcIso, validateSequence
};
