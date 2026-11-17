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

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The workweek every company starts with: Monday to Sunday, from the beginning */
const DEFAULT_WORKWEEK = [{ startDay: 1, effectiveFrom: null }];
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function addDaysIso(dateIso, n) {
    const d = new Date(`${dateIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

/** Day of the week of an ISO date: 0 Sunday ... 6 Saturday */
function weekdayOf(dateIso) {
    return new Date(`${dateIso}T00:00:00Z`).getUTCDay();
}

/** First day (ISO date) of the 7-day week containing a local date. startDay: 0 Sunday ... 6 Saturday; Monday when not given */
function weekStart(dateIso, startDay = 1) {
    const day = Number.isInteger(startDay) && startDay >= 0 && startDay <= 6 ? startDay : 1;
    return addDaysIso(dateIso, -((weekdayOf(dateIso) - day + 7) % 7));
}

/**
 * A company's workweek setting as a clean list, oldest first: [{ startDay, effectiveFrom }].
 * The first entry applies from the beginning (effectiveFrom null); each later entry takes over on its date.
 * Anything unreadable falls back to Monday.
 */
function normalizeWorkweek(workweek) {
    const list = (Array.isArray(workweek) ? workweek : [])
        .filter((e) => e && Number.isInteger(e.startDay) && e.startDay >= 0 && e.startDay <= 6 && (e.effectiveFrom === null || e.effectiveFrom === undefined || ISO_DAY.test(String(e.effectiveFrom))))
        .map((e) => ({ startDay: e.startDay, effectiveFrom: e.effectiveFrom || null }))
        .sort((a, b) => String(a.effectiveFrom || '').localeCompare(String(b.effectiveFrom || '')));
    if (!list.length) return DEFAULT_WORKWEEK.map((e) => ({ ...e }));
    // there is always exactly one "from the beginning" entry
    const firstDated = list.findIndex((e) => e.effectiveFrom);
    if (firstDated === -1) return [list[list.length - 1]];
    if (firstDated === 0) return [{ startDay: list[0].startDay, effectiveFrom: null }, ...list.slice(1)];
    return list.slice(firstDated - 1);
}

/**
 * The workweek that contains a local date: { start, end, startDay, days }.
 * A week is 7 days, except the one week cut short when the company moves its workweek to another weekday:
 * that week ends the day before the new workweek begins, so no day is counted twice and none is lost.
 * Weeks before a change keep the start day they had.
 */
function weekRange(dateIso, workweek) {
    const list = normalizeWorkweek(workweek);
    let i = 0;
    for (let k = 1; k < list.length; k++) if (list[k].effectiveFrom <= dateIso) i = k;
    const cur = list[i];
    let start = weekStart(dateIso, cur.startDay);
    let end = addDaysIso(start, 6);
    if (cur.effectiveFrom && start < cur.effectiveFrom) start = cur.effectiveFrom;
    const next = list[i + 1];
    if (next && next.effectiveFrom <= end) end = addDaysIso(next.effectiveFrom, -1);
    return { start, end, startDay: cur.startDay, days: Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1 };
}

/** First day of the workweek that contains a local date, under the company's workweek setting */
function weekStartFor(dateIso, workweek) {
    return weekRange(dateIso, workweek).start;
}

/** True for a real calendar date written YYYY-MM-DD ("2026-02-30" is not one) */
function isRealDate(dateIso) {
    if (!ISO_DAY.test(String(dateIso))) return false;
    const d = new Date(`${dateIso}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dateIso;
}

/** True when the date is the first day of a workweek */
function isWeekStart(dateIso, workweek) {
    return isRealDate(dateIso) && weekRange(dateIso, workweek).start === dateIso;
}

/** The first valid IANA time zone in the list (a work location's zone first, then the company's) */
function pickTimeZone(...candidates) {
    for (const tz of candidates) {
        if (!tz || typeof tz !== 'string') continue;
        try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (_) { /* try the next one */ }
    }
    return 'UTC';
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

/** Splits [start, end) by halving until each piece is inside one local day (accurate to a minute). Used when the exact midnight cannot be found. */
function addByDayHalving(into, start, end, tz) {
    const d1 = localDate(new Date(start).toISOString(), tz);
    const d2 = localDate(new Date(end - 1).toISOString(), tz);
    if (d1 === d2 || end - start <= 60000) {
        into.set(d1, (into.get(d1) || 0) + (end - start) / 60000);
        return;
    }
    const mid = Math.floor((start + end) / 2);
    addByDayHalving(into, start, mid, tz);
    addByDayHalving(into, mid, end, tz);
}

/** The instant (epoch ms) the local day after `dayIso` begins in a time zone, or null when it cannot be pinned down */
function nextLocalMidnight(dayIso, tz) {
    try {
        const next = addDaysIso(dayIso, 1);
        const at = new Date(zonedToUtcIso(next, '00:00', tz)).getTime();
        // a few zones change their clocks at midnight, so check that this really is the boundary between the two days
        if (localDate(new Date(at).toISOString(), tz) !== next || localDate(new Date(at - 1).toISOString(), tz) !== dayIso) return null;
        return at;
    } catch (_) { return null; }
}

/**
 * Splits [start, end) at local midnights and adds the minutes to `into` keyed by local date.
 * The midnight is the real one in that time zone, so a day on which the clocks change is 23 or 25 hours long.
 */
function addByDay(into, start, end, tz) {
    let from = start;
    while (from < end) {
        const day = localDate(new Date(from).toISOString(), tz);
        const midnight = nextLocalMidnight(day, tz);
        if (midnight === null || midnight <= from) { addByDayHalving(into, from, end, tz); return; }
        const to = Math.min(end, midnight);
        into.set(day, (into.get(day) || 0) + (to - from) / 60000);
        from = to;
    }
}

/**
 * Groups punches into local days and workweeks (an overnight shift is split at local midnight).
 * overtimeThresholdHours (e.g. 40 for FLSA) is applied per workweek; pass null for none.
 * workweek is the company's workweek setting (see weekRange); Monday to Sunday when not given.
 */
function timesheet(punches, tz, nowIso, overtimeThresholdHours, workweek) {
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
    const weekEnds = new Map();
    for (const d of days) {
        const range = weekRange(d.date, workweek);
        weeks.set(range.start, (weeks.get(range.start) || 0) + d.workedMinutes);
        weekEnds.set(range.start, range.end);
    }
    const weekRows = [...weeks.entries()].sort().map(([start, minutes]) => {
        const row = { weekStart: start, weekEnd: weekEnds.get(start), workedMinutes: minutes };
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

/**
 * When work began and ended on one local day, as UTC instants: { startAt, endAt }, both null for a day without work.
 * `dayPunches` are that local day's punches, oldest first. Used when a day's approved hours are sent on as one shift.
 * Work that carries over midnight begins (or ends) at the local midnight, because the hours are split there too.
 */
function shiftSpan(dateIso, workedMinutes, dayPunches, tz) {
    if (!(workedMinutes > 0)) return { startAt: null, endAt: null };
    const list = dayPunches || [];
    const first = list[0]; const last = list[list.length - 1];
    const startsHere = first && (first.type === 'in' || first.type === 'break_end');
    const endsHere = last && (last.type === 'out' || last.type === 'break_start');
    return {
        startAt: startsHere ? new Date(first.at).toISOString() : zonedToUtcIso(dateIso, '00:00', tz),
        endAt: endsHere ? new Date(last.at).toISOString() : zonedToUtcIso(addDaysIso(dateIso, 1), '00:00', tz)
    };
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
    WEEKDAYS, DEFAULT_WORKWEEK, addDaysIso, weekdayOf, normalizeWorkweek, weekRange, weekStartFor, isWeekStart, isRealDate, pickTimeZone,
    tzOffsetMinutes, zonedToUtcIso, shiftSpan, validateSequence
};
