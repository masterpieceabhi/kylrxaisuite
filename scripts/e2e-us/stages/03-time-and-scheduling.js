/**
 * Stage 03: time rules, the schedule, the clock, a full previous week of hours for the four hourly people, jobs,
 * tips, timesheet approval, the hours export and the time reports.
 *
 * A real clock punch can only be "now", so last week is built with the routes the app has for past time: HR adds
 * missed punches (POST /api/time/punches/manual), and the employee asks for a fix that the manager approves
 * (POST /api/time/corrections, PUT /api/time/corrections/:id/decision). A few live punches are made today as well.
 *
 * What stage 04 (payroll) needs is left in ctx.state.ids.time: the week, and the hours each person should be paid for.
 */

/** A wall-clock time on a local date in a time zone, as a UTC instant */
function zonedIso(day, hhmm, tz) {
    const guess = new Date(`${day}T${hhmm}:00Z`);
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(guess).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    return new Date(guess.getTime() - (asUtc - guess.getTime())).toISOString();
}
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const round2 = (n) => Math.round(n * 100) / 100;
const near = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) <= tol;

/**
 * Last week's hours. `day` counts from the first day of the workweek. `how` says which route puts the day in:
 * "manual" (HR adds missed punches) or "fix" (the person asks, the manager approves).
 */
const PLAN = {
    cashier: [0, 1, 2, 3, 4].map((day) => ({ day, in: '08:00', out: '17:00', breakStart: '12:00', breakEnd: '12:30', how: 'manual' })).concat([{ day: 5, in: '08:00', out: '12:00', how: 'manual', changeOutTo: '12:30' }]),
    server: [1, 2, 3, 4].map((day) => ({ day, in: '16:00', out: '22:00', how: 'manual' })).concat([{ day: 5, in: '16:00', out: '22:00', how: 'fix' }]),
    stocker: [0, 2, 4].map((day) => ({ day, in: '09:00', out: '13:00', how: 'manual' })),
    leaver: [0, 1, 2, 3].map((day) => ({ day, in: '07:00', out: '15:30', breakStart: '11:00', breakEnd: '11:30', how: 'manual' }))
};
const HOURLY = ['cashier', 'server', 'stocker', 'leaver'];
const FULL_TIME = ['cashier', 'server', 'leaver']; // the stock clerk is part time (stage 01)
const HOLIDAY_DAY = 2;      // a company holiday is put on the third day of last week
const HOLIDAY_HOURS = 8;
const OVERTIME_AFTER = 40;

/** Hours the plan should come to: worked, regular (up to 40) and overtime (the rest) */
function expectedFor(key) {
    const worked = PLAN[key].reduce((sum, d) => sum + (minutesOf(d.changeOutTo || d.out) - minutesOf(d.in)) - (d.breakStart ? minutesOf(d.breakEnd) - minutesOf(d.breakStart) : 0), 0) / 60;
    const regular = Math.min(worked, OVERTIME_AFTER);
    return { workedHours: round2(worked), regularHours: round2(regular), overtimeHours: round2(worked - regular), doubleTimeHours: 0 };
}

module.exports = {
    id: '03',
    title: 'Time, scheduling and tips',
    covers: ['US-A06', 'US-D01', 'US-D02', 'US-D03', 'US-D04', 'US-D05', 'US-D06', 'US-D08', 'US-D09', 'US-D10', 'US-D11', 'US-E06', 'US-J03'],
    PLAN,
    async run(ctx) {
        const { call, check, U, state } = ctx;
        const P = state.people;
        const T = '/api/time';
        const owner = await ctx.as('owner');
        const hr = await ctx.as('hr');
        const payroll = await ctx.as('payroll');
        const manager = await ctx.as('manager');
        const auditor = await ctx.as('auditor');
        const tok = {};
        for (const k of HOURLY) tok[k] = await ctx.as(k);
        const stamp = String(Date.now()).slice(-6);

        // ------------------------------------------------------------------------------------- weeks and time rules
        ctx.section('Company time rules and the workweek');
        const rules0 = await call('GET', `${T}/rules`, tok.cashier);
        if (!check('[needed] anyone signed in reads the company time rules, time zone and workweek', rules0.s === 200 && rules0.b.timeZone === 'America/Chicago' && rules0.b.workweek && rules0.b.workweek.currentWeek, rules0.b)) return;
        const tz = rules0.b.timeZone;
        const today = rules0.b.today;                          // today in the company's time zone, not the UTC date
        const thisWeekStart = rules0.b.workweek.currentWeek.start;
        const thisWeekEnd = rules0.b.workweek.currentWeek.end;
        const lastWeekStart = ctx.addDays(thisWeekStart, -7);
        const lastWeekEnd = ctx.addDays(thisWeekStart, -1);
        const nextWeekStart = ctx.addDays(thisWeekEnd, 1);
        const dayOf = (n) => ctx.addDays(lastWeekStart, n);
        ctx.info(`today ${today} (${tz}); last week ${lastWeekStart} to ${lastWeekEnd}; this week from ${thisWeekStart}`);
        check('the workweek starts on Monday and overtime starts after 40 hours a week (the defaults)', rules0.b.workweek.startDayName === 'Monday' && rules0.b.rules.overtimeWeeklyHours === 40 && ctx.dayOfWeek(lastWeekStart) === 1, rules0.b.workweek);
        const cur = await call('GET', `${T}/weeks/current`, tok.cashier);
        check('the week before the current one is the week this run fills in', cur.s === 200 && cur.b.currentWeekStart === thisWeekStart && cur.b.prevWeekStart === lastWeekStart, { cur: cur.b.currentWeekStart, prev: cur.b.prevWeekStart });

        const already = await call('GET', `${T}/weeks/${lastWeekStart}?userId=${P.cashier.uid}`, hr);
        if (already.s === 200 && already.b.status === 'approved') {
            check('[needed] last week is still open for this company (run this stage on a new company, not with --reuse)', false, 'the cashier\'s week is already approved; this stage builds the week once');
            return;
        }

        const newRules = { meal: { enabled: true, requiredAfterHours: 5, minimumMinutes: 30 }, holidayPay: { enabled: true, hours: HOLIDAY_HOURS, who: 'full_time' } };
        check('an employee cannot change the time rules (403)', (await call('PUT', `${T}/rules`, tok.cashier, newRules)).s === 403);
        check('a manager cannot change the time rules (403)', (await call('PUT', `${T}/rules`, manager, newRules)).s === 403);
        const badRules = await call('PUT', `${T}/rules`, hr, { overtimeWeeklyHours: 500 });
        check('an overtime limit of 500 hours a week is refused (400)', badRules.s === 400 && Array.isArray(badRules.b.errors), badRules.b);
        const badWeek = await call('PUT', `${T}/rules`, hr, { workweekStartDay: 0, workweekEffectiveFrom: lastWeekStart });
        check('moving the workweek start to a date in the past is refused (400)', badWeek.s === 400, badWeek.b);
        const savedRules = await call('PUT', `${T}/rules`, hr, newRules);
        check('HR turns on the meal-break check and holiday pay (8 hours, full-time staff only)', savedRules.s === 200 && savedRules.b.rules.meal.enabled === true && savedRules.b.rules.holidayPay.enabled === true && savedRules.b.rules.holidayPay.who === 'full_time' && savedRules.b.workweek.startDay === 1, savedRules.b);

        ctx.section('A paid company holiday in last week');
        const holidayDate = dayOf(HOLIDAY_DAY);
        const holidayName = 'Founders Day';
        const hol = await call('POST', `${U}/holidays`, hr, { name: holidayName, date: holidayDate, paid: true });
        check('HR adds a paid company holiday on the Wednesday of last week', hol.s === 201 || hol.s === 409, hol.b);
        check('an employee cannot add a company holiday (403)', (await call('POST', `${U}/holidays`, tok.cashier, { name: 'My day', date: holidayDate })).s === 403);
        const holCheck = await call('GET', `${U}/holidays/check?date=${holidayDate}`, tok.cashier);
        check('the calendar says that day is a company holiday', holCheck.s === 200 && holCheck.b.holiday === true, holCheck.b);
        // every paid holiday of the company that falls in last week counts (a federal holiday may be in the same week)
        const paidHolidays = new Set();
        for (const year of new Set([lastWeekStart.slice(0, 4), lastWeekEnd.slice(0, 4)])) {
            const cal = await call('GET', `${U}/holidays?year=${year}`, hr);
            (cal.b.data || []).filter((h) => h.active !== false && h.paid !== false && h.date >= lastWeekStart && h.date <= lastWeekEnd).forEach((h) => paidHolidays.add(h.date));
        }
        check('the holiday calendar lists it inside last week', paidHolidays.has(holidayDate), [...paidHolidays]);
        const holidayHoursFullTime = paidHolidays.size * HOLIDAY_HOURS;

        // ------------------------------------------------------------------------------------------- minimum wage
        ctx.section('Minimum-wage rules and the wage check');
        const wageRules = await call('GET', `${U}/wages/rules`, hr);
        const federal = (wageRules.b.data || []).find((r) => r.jurisdiction === 'federal');
        check('the federal minimum wage is there to start with ($7.25, tipped $2.13)', wageRules.s === 200 && federal && federal.hourlyMinimum === 7.25 && federal.tippedCashWage === 2.13, wageRules.b);
        check('an employee cannot read the wage rules (403)', (await call('GET', `${U}/wages/rules`, tok.cashier)).s === 403);
        check('a rule with a tipped wage above the minimum is refused (400)', (await call('POST', `${U}/wages/rules`, hr, { jurisdiction: 'state', state: 'TX', effectiveDate: '2020-01-01', hourlyMinimum: 7.25, tippedCashWage: 9 })).s === 400);
        const txRule = await call('POST', `${U}/wages/rules`, hr, { jurisdiction: 'state', state: 'TX', effectiveDate: '2009-07-24', hourlyMinimum: 7.25, tippedCashWage: 2.13, verified: true, notes: 'Texas follows the federal rate (entered by the end-to-end run)' });
        check('HR adds the Texas rule', txRule.s === 201 || txRule.s === 409, txRule.b);
        const eff = await call('GET', `${U}/wages/effective?state=TX&date=${today}`, hr);
        check('the minimum in force in Texas today is $7.25 an hour, $2.13 for tipped staff', eff.s === 200 && eff.b.data.hourlyMinimum === 7.25 && eff.b.data.tippedCashWage === 2.13, eff.b);
        const viol = await call('GET', `${U}/wages/violations`, hr);
        check('the wage check looks at the hourly people (four, plus anyone hired in an earlier stage) and finds nobody under the minimum', viol.s === 200 && viol.b.checked >= 4 && viol.b.violations.length === 0, { checked: viol.b.checked, violations: viol.b.violations });
        // a city rule that starts later: the check for that date must flag the stock clerk ($17.00 an hour)
        const later = ctx.addDays(today, 200);
        const cityName = `Austin ${stamp}`;
        const loc = await call('PUT', `${U}/wages/employees/${P.stocker.uid}/location`, hr, { workCity: cityName, workCounty: 'Travis' });
        check('HR records the city the stock clerk works in', loc.s === 200 && loc.b.workCity === cityName, loc.b);
        const cityRule = await call('POST', `${U}/wages/rules`, hr, { jurisdiction: 'city', state: 'TX', name: cityName, effectiveDate: later, hourlyMinimum: 20, notes: 'made-up future rule for the end-to-end run' });
        if (check('HR adds a city rule of $20.00 that starts in 200 days', cityRule.s === 201 && cityRule.b.rule.id, cityRule.b)) {
            const v2 = await call('GET', `${U}/wages/violations?date=${later}`, hr);
            const row = (v2.b.violations || []).find((r) => r.id === P.stocker.uid);
            check('the wage check for that date flags the stock clerk as $3.00 an hour short', v2.s === 200 && v2.b.violations.length === 1 && row && row.minimum === 20 && row.shortfall === 3, v2.b.violations);
            const v3 = await call('GET', `${U}/wages/violations?date=${today}`, hr);
            check('and still finds nobody short today, before the rule starts', v3.s === 200 && v3.b.violations.length === 0, v3.b.violations);
            const gone = await call('DELETE', `${U}/wages/rules/${cityRule.b.rule.id}`, hr);
            check('HR archives the made-up city rule again', gone.s === 200, gone.b);
        }

        // ------------------------------------------------------------------------------------------ clock policy
        ctx.section('Clock policy: location is recorded after the person has seen the notice');
        check('an employee cannot change the clock policy (403)', (await call('PUT', `${U}/clock/policies`, tok.cashier, { scope: 'org' })).s === 403);
        check('a clock policy with an unknown photo setting is refused (400)', (await call('PUT', `${U}/clock/policies`, hr, { scope: 'org', selfie: 'sometimes' })).s === 400);
        const pol = await call('PUT', `${U}/clock/policies`, hr, { scope: 'org', allowedMethods: ['web', 'kiosk_pin'], selfie: 'off', geofence: { mode: 'record', accuracyMeters: 200 }, requireNotice: true });
        check('HR saves a company clock policy: web and kiosk, no photo, location recorded, notice required', pol.s === 200 && pol.b.policy && pol.b.policy.geofence.mode === 'record' && pol.b.policy.requireNotice === true, pol.b);
        const pols = await call('GET', `${U}/clock/policies`, hr);
        check('the policy list shows it', pols.s === 200 && (pols.b.data || []).some((p) => p.scope === 'org'), pols.b);
        const need = await call('GET', `${U}/clock/my-requirements`, tok.cashier);
        check('the cashier is told a location notice is waiting to be read', need.s === 200 && need.b.policy === true && JSON.stringify(need.b.pending).includes('location_notice'), need.b);
        const consent = await call('POST', `${U}/clock/consents`, tok.cashier, { type: 'location_notice', decision: 'accepted' });
        check('the cashier accepts the location notice', consent.s === 201 && consent.b.consent, consent.b);
        const need2 = await call('GET', `${U}/clock/my-requirements`, tok.cashier);
        check('after that nothing is waiting for the cashier', need2.s === 200 && (need2.b.pending || []).length === 0, need2.b);
        const mine = await call('GET', `${U}/clock/my-consents`, tok.cashier);
        check('the cashier sees the agreement on file and may take it back', mine.s === 200 && (mine.b.current || []).some((c) => c.type === 'location_notice' && c.status === 'ok' && c.canRevoke === true), mine.b.current);
        const consentStatus = await call('GET', `${U}/clock/consents/status`, hr);
        check('HR reads who has and has not agreed', consentStatus.s === 200, consentStatus.b);

        // --------------------------------------------------------------------------------------------- schedule
        ctx.section('The manager builds and publishes the schedule');
        check('an employee cannot read the schedule settings (403)', (await call('GET', `${U}/schedule/settings`, tok.cashier)).s === 403);
        const sset = await call('PUT', `${U}/schedule/settings`, hr, { minRestHours: 8, maxDailyHours: 12, maxWeeklyHours: 60, overtimeWeeklyHours: 40, claimNeedsApproval: true, swapNeedsManager: true });
        check('HR saves the schedule settings (claims and swaps need the manager)', sset.s === 200 && sset.b.settings.claimNeedsApproval === true && sset.b.settings.swapNeedsManager === true, sset.b);
        const tpl = await call('POST', `${U}/schedule/templates`, manager, { name: `Day shift ${stamp}`, startTime: '08:00', endTime: '17:00', breakMinutes: 30 });
        check('the manager saves a shift template (08:00 to 17:00, 30 minute break)', tpl.s === 201 && tpl.b.template.id, tpl.b);
        check('an employee cannot add a shift (403)', (await call('POST', `${U}/schedule/shifts`, tok.cashier, { userId: P.cashier.uid, date: dayOf(0), startTime: '08:00', endTime: '12:00' })).s === 403);
        const notMine = await call('POST', `${U}/schedule/shifts`, manager, { userId: P.hr.uid, date: dayOf(0), startTime: '08:00', endTime: '12:00' });
        check('the manager cannot schedule someone who is not on their team (403)', notMine.s === 403, notMine.b);
        check('a shift without a date is refused (400)', (await call('POST', `${U}/schedule/shifts`, manager, { userId: P.cashier.uid, startTime: '08:00', endTime: '12:00' })).s === 400);

        let planned = 0;
        const scheduledHours = {};
        for (const key of HOURLY) {
            // the schedule holds the planned shifts (the cashier's Saturday was extra, so it is not on the schedule)
            const days = PLAN[key].filter((d) => !(key === 'cashier' && d.day === 5));
            const first = days[0];
            const body = { userIds: [P[key].uid], dates: days.map((d) => dayOf(d.day)), startTime: first.in, endTime: first.out, breakMinutes: first.breakStart ? 30 : 0 };
            if (key === 'cashier' && tpl.b.template) { body.templateId = tpl.b.template.id; delete body.startTime; delete body.endTime; delete body.breakMinutes; }
            const made = await call('POST', `${U}/schedule/shifts/bulk`, manager, body);
            check(`last week's shifts for ${P[key].name} are added (${days.length})`, made.s === 201 && made.b.created === days.length && made.b.skipped === 0, made.b);
            if (key === 'cashier') check('the fifth shift takes the cashier over 40 planned hours, and the manager is warned that overtime is likely', (made.b.results || []).some((r) => (r.warnings || []).some((w) => w.code === 'overtime_risk')), made.b.results);
            planned += days.length;
            scheduledHours[key] = round2(days.reduce((s, d) => s + (minutesOf(d.out) - minutesOf(d.in) - (d.breakStart ? 30 : 0)) / 60, 0));
        }
        const overlap = await call('POST', `${U}/schedule/shifts`, manager, { userId: P.cashier.uid, date: dayOf(0), startTime: '10:00', endTime: '14:00' });
        check('a second shift that overlaps the cashier\'s Monday shift is refused (409)', overlap.s === 409 && /overlap/i.test(overlap.b.error || ''), overlap.b);
        const draftWeek = await call('GET', `${U}/schedule/week?weekStart=${lastWeekStart}`, manager);
        const cashierRow = ((draftWeek.b.staff) || []).find((s) => s.userId === P.cashier.uid);
        check('the week view shows the manager\'s people (the four, plus anyone hired in an earlier stage) and the planned shifts, not yet published', draftWeek.s === 200 && draftWeek.b.shifts.length === planned && ['cashier', 'server', 'stocker', 'leaver'].every((k) => draftWeek.b.staff.some((x) => x.userId === P[k].uid)) && draftWeek.b.published === false, { shifts: (draftWeek.b.shifts || []).length, staff: (draftWeek.b.staff || []).length, published: draftWeek.b.published });
        check('the cashier is planned for 42.5 hours', cashierRow && near(cashierRow.scheduledHours, scheduledHours.cashier), cashierRow);
        check('a week that does not start on a Monday is refused (400)', (await call('GET', `${U}/schedule/week?weekStart=${dayOf(2)}`, manager)).s === 400);
        const pub1 = await call('POST', `${U}/schedule/publish`, manager, { weekStart: lastWeekStart });
        check('the manager publishes last week; all four people are told', pub1.s === 200 && pub1.b.published === planned && pub1.b.notified === 4, pub1.b);
        const copy = await call('POST', `${U}/schedule/copy`, manager, { fromWeek: lastWeekStart, toWeek: thisWeekStart });
        check('last week is copied to this week', copy.s === 201 && copy.b.created === planned && copy.b.skipped.length === 0, copy.b);
        const pub2 = await call('POST', `${U}/schedule/publish`, manager, { weekStart: thisWeekStart });
        check('the manager publishes this week', pub2.s === 200 && pub2.b.published === planned, pub2.b);
        const myWeek = await call('GET', `${U}/schedule/mine?from=${thisWeekStart}&to=${thisWeekEnd}`, tok.cashier);
        check('the cashier sees their five shifts of this week', myWeek.s === 200 && myWeek.b.data.length === 5 && myWeek.b.data.every((s) => s.userId === P.cashier.uid && s.startTime === '08:00'), myWeek.b);
        const notices = await call('GET', `${U}/schedule/notices`, tok.cashier);
        const firstNotice = (notices.b.data || [])[0];
        check('the cashier has unread notices that the schedule was published', notices.s === 200 && notices.b.unread >= 2 && firstNotice && firstNotice.type === 'schedule_published', notices.b);
        if (firstNotice) {
            const read = await call('POST', `${U}/schedule/notices/${firstNotice.id}/read`, tok.cashier);
            const after = await call('GET', `${U}/schedule/notices`, tok.cashier);
            check('marking one as read lowers the unread count', read.s === 200 && after.b.unread === notices.b.unread - 1, after.b.unread);
        }

        ctx.section('Open shift, claim, swap and availability (next week)');
        // these need shifts that have not started, so they are put in next week
        const openShift = await call('POST', `${U}/schedule/shifts`, manager, { date: nextWeekStart, startTime: '10:00', endTime: '14:00', role: 'Cashier', notes: 'Extra cover' });
        const swapShift = await call('POST', `${U}/schedule/shifts`, manager, { userId: P.leaver.uid, date: ctx.addDays(nextWeekStart, 1), startTime: '09:00', endTime: '13:00' });
        check('the manager adds an open shift for a cashier and a shift for the barista next week', openShift.s === 201 && swapShift.s === 201 && openShift.b.shift.userId === null, { open: openShift.b, swap: swapShift.b });
        const avail = await call('PUT', `${U}/schedule/availability`, tok.stocker, { weekly: [{ dow: ctx.dayOfWeek(ctx.addDays(nextWeekStart, 3)), available: false }, { dow: ctx.dayOfWeek(ctx.addDays(nextWeekStart, 4)), available: true, start: '09:00', end: '15:00' }], exceptions: [{ date: ctx.addDays(nextWeekStart, 5), available: false, note: 'family event' }] });
        check('the stock clerk saves when they can work (not Thursdays, Fridays 09:00 to 15:00, one day off)', avail.s === 200 && avail.b.availability.weekly.length === 2 && avail.b.availability.exceptions.length === 1, avail.b);
        check('availability with a bad day of the week is refused (400)', (await call('PUT', `${U}/schedule/availability`, tok.stocker, { weekly: [{ dow: 9 }] })).s === 400);
        const seenAvail = await call('GET', `${U}/schedule/availability/${P.stocker.uid}`, manager);
        check('the manager reads the stock clerk\'s availability', seenAvail.s === 200 && seenAvail.b.availability.weekly.length === 2, seenAvail.b);
        check('an employee cannot read a coworker\'s availability (403)', (await call('GET', `${U}/schedule/availability/${P.stocker.uid}`, tok.cashier)).s === 403);
        const offDay = await call('POST', `${U}/schedule/shifts`, manager, { userId: P.stocker.uid, date: ctx.addDays(nextWeekStart, 3), startTime: '09:00', endTime: '13:00' });
        check('a shift on a day the stock clerk said they cannot work is saved with a warning', offDay.s === 201 && (offDay.b.warnings || []).some((w) => /avail/i.test(`${w.code} ${w.message}`)), offDay.b);
        const pub3 = await call('POST', `${U}/schedule/publish`, manager, { weekStart: nextWeekStart });
        check('next week is published', pub3.s === 200 && pub3.b.published === 3, pub3.b);

        if (openShift.s === 201) {
            const id = openShift.b.shift.id;
            const openList = await call('GET', `${U}/schedule/open`, tok.cashier);
            check('the cashier sees the open shift', openList.s === 200 && openList.b.data.some((s) => s.id === id && s.claimPending === false), openList.b);
            const openOther = await call('GET', `${U}/schedule/open`, tok.stocker);
            const wrongRole = await call('POST', `${U}/schedule/shifts/${id}/claim`, tok.stocker);
            check('the stock clerk does not see it and cannot take it: the shift is for a cashier (403)', openOther.s === 200 && !openOther.b.data.some((s) => s.id === id) && wrongRole.s === 403, { list: openOther.b, claim: wrongRole.b });
            const claim = await call('POST', `${U}/schedule/shifts/${id}/claim`, tok.cashier);
            check('the cashier asks for the open shift; it waits for the manager', claim.s === 200 && claim.b.status === 'pending_approval', claim.b);
            check('a second request for the same shift is refused while one is waiting (409)', (await call('POST', `${U}/schedule/shifts/${id}/claim`, tok.cashier)).s === 409);
            const claims = await call('GET', `${U}/schedule/claims`, manager);
            check('the manager sees the request', claims.s === 200 && claims.b.data.some((c) => c.shiftId === id && c.claimedBy === P.cashier.uid), claims.b);
            check('an employee cannot approve a claim (403)', (await call('POST', `${U}/schedule/shifts/${id}/claim/decision`, tok.cashier, { decision: 'approve' })).s === 403);
            const okClaim = await call('POST', `${U}/schedule/shifts/${id}/claim/decision`, manager, { decision: 'approve' });
            const mineNext = await call('GET', `${U}/schedule/mine?from=${nextWeekStart}&to=${ctx.addDays(nextWeekStart, 6)}`, tok.cashier);
            check('the manager approves and the shift is now on the cashier\'s schedule', okClaim.s === 200 && mineNext.b.data.some((s) => s.id === id), { decision: okClaim.b, mine: mineNext.b });
        }
        if (swapShift.s === 201) {
            const id = swapShift.b.shift.id;
            const coworkers = await call('GET', `${U}/schedule/coworkers`, tok.leaver);
            check('the barista gets the list of coworkers to swap with (names only)', coworkers.s === 200 && coworkers.b.data.some((c) => c.userId === P.stocker.uid) && !/payRate|email/.test(JSON.stringify(coworkers.b.data)), coworkers.text.slice(0, 200));
            check('a swap for somebody else\'s shift is refused (404)', (await call('POST', `${U}/schedule/swaps`, tok.cashier, { shiftId: id, targetUserId: P.stocker.uid })).s === 404);
            const swap = await call('POST', `${U}/schedule/swaps`, tok.leaver, { shiftId: id, targetUserId: P.stocker.uid, note: 'Dentist that morning' });
            if (check('the barista asks the stock clerk to take their Tuesday shift', swap.s === 201 && swap.b.swap.status === 'pending_peer', swap.b)) {
                const sid = swap.b.swap.id;
                const inbox = await call('GET', `${U}/schedule/swaps`, tok.stocker);
                check('the stock clerk sees the request', inbox.s === 200 && inbox.b.data.some((s) => s.id === sid), inbox.b);
                check('the manager cannot decide before the coworker has answered (404)', (await call('POST', `${U}/schedule/swaps/${sid}/decision`, manager, { decision: 'approve' })).s === 404);
                const yes = await call('POST', `${U}/schedule/swaps/${sid}/respond`, tok.stocker, { accept: true });
                check('the stock clerk accepts; it now waits for the manager', yes.s === 200 && yes.b.status === 'pending_manager' && yes.b.managerApprovalNeeded === true, yes.b);
                const queue = await call('GET', `${U}/schedule/swaps?scope=manage&status=pending_manager`, manager);
                check('the manager sees the swap waiting', queue.s === 200 && queue.b.data.some((s) => s.id === sid), queue.b);
                check('an employee cannot open the manager\'s swap list (403)', (await call('GET', `${U}/schedule/swaps?scope=manage`, tok.cashier)).s === 403);
                const okSwap = await call('POST', `${U}/schedule/swaps/${sid}/decision`, manager, { decision: 'approve', note: 'Fine' });
                const theirs = await call('GET', `${U}/schedule/mine?from=${nextWeekStart}&to=${ctx.addDays(nextWeekStart, 6)}`, tok.stocker);
                const gone = await call('GET', `${U}/schedule/mine?from=${nextWeekStart}&to=${ctx.addDays(nextWeekStart, 6)}`, tok.leaver);
                check('the manager approves: the shift moves from the barista to the stock clerk', okSwap.s === 200 && okSwap.b.status === 'approved' && theirs.b.data.some((s) => s.id === id) && !gone.b.data.some((s) => s.id === id), { decision: okSwap.b, stocker: theirs.b.data.length, barista: gone.b.data.length });
            }
        }

        // ------------------------------------------------------------------------------------- last week's hours
        ctx.section('Last week\'s hours: HR adds missed punches');
        check('an employee cannot add a missed punch (403)', (await call('POST', `${T}/punches/manual`, tok.cashier, { userId: P.cashier.uid, type: 'in', at: zonedIso(dayOf(0), '08:00', tz), reason: 'forgot to clock in' })).s === 403);
        check('a manager cannot add a missed punch either: that is for HR and payroll (403)', (await call('POST', `${T}/punches/manual`, manager, { userId: P.cashier.uid, type: 'in', at: zonedIso(dayOf(0), '08:00', tz), reason: 'forgot to clock in' })).s === 403);
        check('a missed punch without a reason is refused (400)', (await call('POST', `${T}/punches/manual`, hr, { userId: P.cashier.uid, type: 'in', at: zonedIso(dayOf(0), '08:00', tz) })).s === 400);
        check('a missed punch in the future is refused (400)', (await call('POST', `${T}/punches/manual`, hr, { userId: P.cashier.uid, type: 'in', at: new Date(Date.now() + 3600000).toISOString(), reason: 'forgot to clock in' })).s === 400);
        for (const key of HOURLY) {
            const days = PLAN[key].filter((d) => d.how === 'manual');
            let ok = 0; let total = 0; let firstBad = null;
            for (const d of days) {
                const punches = [['in', d.in], ...(d.breakStart ? [['break_start', d.breakStart], ['break_end', d.breakEnd]] : []), ['out', d.out]];
                for (const [type, time] of punches) {
                    total += 1;
                    // HR enters most of them; the payroll admin enters the stock clerk's
                    const r = await call('POST', `${T}/punches/manual`, key === 'stocker' ? payroll : hr, { userId: P[key].uid, type, at: zonedIso(dayOf(d.day), time, tz), reason: 'Clock was not in use yet last week' });
                    if (r.s === 201) ok += 1; else if (!firstBad) firstBad = { day: dayOf(d.day), type, time, status: r.s, body: r.b };
                }
            }
            check(`${P[key].name}: ${days.length} days of last week are entered (${total} punches) by ${key === 'stocker' ? 'the payroll admin' : 'HR'}`, ok === total, firstBad);
        }

        ctx.section('Last week\'s hours: the employee asks for a fix, the manager decides');
        const sat = dayOf(5);
        check('a fix without saying what happened is refused (400)', (await call('POST', `${T}/corrections`, tok.server, { kind: 'add', type: 'in', localDate: sat, localTime: '16:00', reason: 'x' })).s === 400);
        const outFirst = await call('POST', `${T}/corrections`, tok.server, { kind: 'add', type: 'out', localDate: sat, localTime: '22:00', reason: 'Worked Saturday evening, the clock was down' });
        check('asking to add a clock-out with no clock-in before it is refused (400)', outFirst.s === 400 && /order/i.test(outFirst.b.error || ''), outFirst.b);
        const fixIn = await call('POST', `${T}/corrections`, tok.server, { kind: 'add', type: 'in', localDate: sat, localTime: '16:00', reason: 'Worked Saturday evening, the clock was down' });
        if (check('the server asks to add Saturday\'s clock-in at 16:00', fixIn.s === 201 && fixIn.b.correction.status === 'pending', fixIn.b)) {
            const pending = await call('GET', `${T}/corrections?scope=pending`, manager);
            check('the manager sees the request waiting', pending.s === 200 && pending.b.data.some((c) => c.id === fixIn.b.correction.id), pending.b);
            check('an employee cannot open the list of everyone\'s requests (403)', (await call('GET', `${T}/corrections?scope=pending`, tok.cashier)).s === 403);
            check('the server cannot approve their own request (403)', (await call('PUT', `${T}/corrections/${fixIn.b.correction.id}/decision`, tok.server, { decision: 'approve' })).s === 403);
            const ok1 = await call('PUT', `${T}/corrections/${fixIn.b.correction.id}/decision`, manager, { decision: 'approve', note: 'Confirmed with the rota' });
            check('the manager approves it', ok1.s === 200 && ok1.b.status === 'approved', ok1.b);
            check('deciding it a second time is refused (409)', (await call('PUT', `${T}/corrections/${fixIn.b.correction.id}/decision`, manager, { decision: 'deny' })).s === 409);
            const fixOut = await call('POST', `${T}/corrections`, tok.server, { kind: 'add', type: 'out', localDate: sat, localTime: '22:00', reason: 'Worked Saturday evening, the clock was down' });
            const ok2 = fixOut.s === 201 ? await call('PUT', `${T}/corrections/${fixOut.b.correction.id}/decision`, manager, { decision: 'approve' }) : { s: 0, b: {} };
            check('the clock-out at 22:00 is asked for and approved the same way', fixOut.s === 201 && ok2.s === 200, { request: fixOut.b, decision: ok2.b });
        }
        // a request that is turned down, and one the person takes back
        const wrong = await call('POST', `${T}/corrections`, tok.server, { kind: 'add', type: 'in', localDate: dayOf(6), localTime: '10:00', reason: 'I think I also worked Sunday' });
        if (check('the server also asks for a Sunday clock-in', wrong.s === 201, wrong.b)) {
            const no = await call('PUT', `${T}/corrections/${wrong.b.correction.id}/decision`, manager, { decision: 'deny', note: 'The cafe was closed on Sunday' });
            check('the manager turns it down', no.s === 200 && no.b.status === 'denied', no.b);
        }
        const oops = await call('POST', `${T}/corrections`, tok.leaver, { kind: 'add', type: 'in', localDate: dayOf(4), localTime: '07:00', reason: 'Not sure I worked Friday' });
        if (check('the barista asks for a Friday clock-in', oops.s === 201, oops.b)) {
            const cancel = await call('POST', `${T}/corrections/${oops.b.correction.id}/cancel`, tok.leaver);
            const mineList = await call('GET', `${T}/corrections`, tok.leaver);
            check('and takes the request back', cancel.s === 200 && mineList.b.data.some((c) => c.id === oops.b.correction.id && c.status === 'cancelled'), { cancel: cancel.b, list: mineList.b });
        }
        // the cashier's Saturday clock-out was entered half an hour early: a "change" request
        const cashierWeek0 = await call('GET', `${T}/weeks/${lastWeekStart}`, tok.cashier);
        const satRow = ((cashierWeek0.b.days) || []).find((d) => d.date === sat);
        const satOut = satRow && satRow.punches.find((p) => p.type === 'out');
        check('before the fix the cashier\'s week shows 46.5 hours, 6.5 of them overtime', cashierWeek0.s === 200 && near(cashierWeek0.b.totals.workedHours, 46.5) && near(cashierWeek0.b.totals.overtimeHours, 6.5), cashierWeek0.b.totals);
        if (check('the cashier finds Saturday\'s clock-out (12:00) on their timesheet', Boolean(satOut) && satOut.time === '12:00', satRow)) {
            const change = await call('POST', `${T}/corrections`, tok.cashier, { kind: 'change', punchId: satOut.id, localTime: '12:30', reason: 'I left at 12:30, not 12:00' });
            const okChange = change.s === 201 ? await call('PUT', `${T}/corrections/${change.b.correction.id}/decision`, manager, { decision: 'approve' }) : { s: 0, b: {} };
            check('the cashier asks to move it to 12:30 and the manager approves', change.s === 201 && change.b.correction.originalLocalTime === '12:00' && okChange.s === 200, { request: change.b, decision: okChange.b });
        }

        // ---------------------------------------------------------------------------------- the week adds up
        ctx.section('Each person\'s week adds up');
        const expected = {};
        for (const key of HOURLY) {
            expected[key] = { ...expectedFor(key), holidayHours: FULL_TIME.includes(key) ? holidayHoursFullTime : 0, payRate: P[key].payRate };
            const e = expected[key];
            const w = await call('GET', `${T}/weeks/${lastWeekStart}`, tok[key]);
            const t = w.b.totals || {};
            check(`${P[key].name}: ${e.workedHours} hours worked = ${e.regularHours} regular + ${e.overtimeHours} overtime, ${e.holidayHours} holiday hours`, w.s === 200 && near(t.workedHours, e.workedHours) && near(t.regularHours, e.regularHours) && near(t.overtimeHours, e.overtimeHours) && near(t.holidayHours, e.holidayHours) && w.b.openShift === false, t);
            if (key === 'server') check('the server worked six hours a day with no break, so the week is flagged for missed meal breaks', (w.b.flags || []).includes('missed_meal_break') && w.b.days.filter((d) => d.flags.includes('missed_meal_break')).length === 5, { flags: w.b.flags });
            if (key === 'cashier') {
                check('the cashier took a 30 minute break each long day, so no meal-break flag', !(w.b.flags || []).includes('missed_meal_break'), w.b.flags);
                const days = w.b.days || [];
                const fri = days.find((d) => d.date === dayOf(4)) || {};
                const satD = days.find((d) => d.date === sat) || {};
                check('overtime starts on Friday once 40 hours are reached (6.0 regular + 2.5 overtime), and all of Saturday is overtime (4.5)', near(fri.regularHours, 6) && near(fri.overtimeHours, 2.5) && near(satD.regularHours, 0) && near(satD.overtimeHours, 4.5), { fri, sat: satD });
                check('the holiday is shown on the Wednesday with 8 paid hours', (w.b.holidayPay || []).some((h) => h.date === holidayDate && near(h.hours, HOLIDAY_HOURS)) && (days.find((d) => d.date === holidayDate) || {}).holiday, w.b.holidayPay);
            }
            if (key === 'stocker') check('the part-time stock clerk gets no holiday hours (holiday pay is for full-time staff)', near(t.holidayHours, 0) && (w.b.holidayPay || []).length === 0, w.b.holidayPay);
        }
        check('an employee cannot read a coworker\'s week (403)', (await call('GET', `${T}/weeks/${lastWeekStart}?userId=${P.server.uid}`, tok.cashier)).s === 403);
        check('the manager reads a team member\'s week', (await call('GET', `${T}/weeks/${lastWeekStart}?userId=${P.server.uid}`, manager)).s === 200);
        check('the manager cannot read the week of someone outside their team (403)', (await call('GET', `${T}/weeks/${lastWeekStart}?userId=${P.hr.uid}`, manager)).s === 403);
        const sheet = await call('GET', `${T}/timesheet?userId=${P.cashier.uid}&from=${lastWeekStart}&to=${lastWeekEnd}`, manager);
        check('the day-by-day timesheet for the cashier shows six worked days', sheet.s === 200 && sheet.b.days.filter((d) => d.workedMinutes > 0).length === 6, (sheet.b.days || []).map((d) => [d.date, d.workedMinutes]));

        // ---------------------------------------------------------------------------------------- live punches
        ctx.section('Live punches today: phone, an offline punch sent late, and the shared kiosk');
        check('no token cannot punch (401)', (await call('POST', `${T}/punch`, null, { action: 'in' })).s === 401);
        const st0 = await call('GET', `${T}/status`, tok.cashier);
        check('the cashier is clocked out and may clock in', st0.s === 200 && st0.b.status.state === 'out' && st0.b.status.allowed.includes('in'), st0.b);
        check('clocking out while not clocked in is refused (409)', (await call('POST', `${T}/punch`, tok.cashier, { action: 'out' })).s === 409);
        const where = { lat: 30.2672, lng: -97.7431, accuracy: 25 };
        const pIn = await call('POST', `${T}/punch`, tok.cashier, { action: 'in', location: where, clientKey: `e2e-${state.run}-${stamp}-in` });
        check('the cashier clocks in from their phone', pIn.s === 200 && pIn.b.status.state === 'in', pIn.b);
        const pAgain = await call('POST', `${T}/punch`, tok.cashier, { action: 'in', location: where, clientKey: `e2e-${state.run}-${stamp}-in` });
        check('the same tap sent twice is recorded once', pAgain.s === 200 && pAgain.b.duplicate === true, pAgain.b);
        const pB1 = await call('POST', `${T}/punch`, tok.cashier, { action: 'break_start' });
        const pB2 = await call('POST', `${T}/punch`, tok.cashier, { action: 'break_end' });
        check('the cashier starts and ends a break', pB1.s === 200 && pB1.b.status.state === 'break' && pB2.s === 200 && pB2.b.status.state === 'in', { start: pB1.b, end: pB2.b });
        const nowTeam = await call('GET', `${T}/team/now`, manager);
        check('the manager sees their people (the four, plus anyone hired in an earlier stage), with the cashier working right now', nowTeam.s === 200 && ['cashier', 'server', 'stocker', 'leaver'].every((k) => nowTeam.b.data.some((r) => r.userId === P[k].uid)) && nowTeam.b.counts.in === 1 && nowTeam.b.data.find((r) => r.userId === P.cashier.uid).state === 'in', nowTeam.b);
        const nowAll = await call('GET', `${T}/team/now`, hr);
        check('HR sees everyone; an employee cannot see who is working (403)', nowAll.s === 200 && nowAll.b.data.length >= 10 && (await call('GET', `${T}/team/now`, tok.cashier)).s === 403, (nowAll.b.data || []).length);
        const pOut = await call('POST', `${T}/punch`, tok.cashier, { action: 'out', location: where });
        check('the cashier clocks out', pOut.s === 200 && pOut.b.status.state === 'out', pOut.b);

        // a punch made with no connection is sent later with the time it was made
        const lateIn = new Date(Date.now() - 20 * 60000).toISOString();
        const lateOut = new Date(Date.now() - 10 * 60000).toISOString();
        const l1 = await call('POST', `${T}/punch`, tok.leaver, { action: 'in', clientKey: `e2e-${state.run}-${stamp}-latein`, clientAt: lateIn });
        const l2 = await call('POST', `${T}/punch`, tok.leaver, { action: 'out', clientKey: `e2e-${state.run}-${stamp}-lateout`, clientAt: lateOut });
        check('two punches the barista made offline are recorded at the time they were made and marked as sent late', l1.s === 200 && l1.b.late === true && l1.b.recordedAt === lateIn && l2.s === 200 && l2.b.late === true, { in: l1.b, out: l2.b });
        check('an offline punch older than three days is refused (409)', (await call('POST', `${T}/punch`, tok.leaver, { action: 'in', clientKey: `e2e-${state.run}-${stamp}-old`, clientAt: new Date(Date.now() - 80 * 3600000).toISOString() })).s === 409);
        const exc = await call('GET', `${U}/clock/exceptions`, manager);
        const lateExc = (exc.b.data || []).find((e) => e.userId === P.leaver.uid);
        check('the late punches are listed for the manager to look at', exc.s === 200 && Boolean(lateExc), exc.b);
        if (lateExc) check('the manager marks it as looked at', (await call('PUT', `${U}/clock/exceptions/${lateExc.id}/resolve`, manager, { note: 'Phone had no signal in the store room' })).s === 200);

        // the shared tablet: HR sets it up and gives the stock clerk a PIN
        check('a manager cannot set up a kiosk (403)', (await call('POST', `${T}/kiosks`, manager, { name: 'Back door' })).s === 403);
        const kiosk = await call('POST', `${T}/kiosks`, hr, { name: `Store tablet ${stamp}` });
        const pin = await call('PUT', `${T}/pin`, hr, { userId: P.stocker.uid, pin: '4821' });
        if (check('HR sets up a shared tablet and gives the stock clerk a PIN', kiosk.s === 201 && kiosk.b.key && pin.s === 200 && pin.b.employeeId === P.stocker.employeeId, { kiosk: kiosk.s, pin: pin.b })) {
            const K = { 'X-Kiosk-Key': kiosk.b.key };
            const number = P.stocker.employeeId.replace(/\D/g, '');
            check('a tablet that is not set up is refused (401)', (await call('POST', `${T}/kiosk/identify`, null, { employeeNumber: number, pin: '4821' }, { 'X-Kiosk-Key': 'x'.repeat(30) })).s === 401);
            check('a wrong PIN is refused (401)', (await call('POST', `${T}/kiosk/identify`, null, { employeeNumber: number, pin: '0000' }, K)).s === 401);
            const who = await call('POST', `${T}/kiosk/identify`, null, { employeeNumber: number, pin: '4821' }, K);
            if (check('the stock clerk types their number and PIN on the tablet and is recognised', who.s === 200 && who.b.session && /Sam/.test(who.b.name || ''), who.b)) {
                const kIn = await call('POST', `${T}/kiosk/punch`, null, { session: who.b.session, action: 'in', clientKey: `e2e-${state.run}-${stamp}-kin` }, K);
                const kOut = await call('POST', `${T}/kiosk/punch`, null, { session: who.b.session, action: 'out', clientKey: `e2e-${state.run}-${stamp}-kout` }, K);
                check('the stock clerk clocks in and out on the tablet', kIn.s === 200 && kIn.b.status.state === 'in' && kOut.s === 200 && kOut.b.status.state === 'out', { in: kIn.b, out: kOut.b });
                check('a made-up kiosk session is refused (401)', (await call('POST', `${T}/kiosk/punch`, null, { session: 'not-a-session', action: 'in' }, K)).s === 401);
            }
            const kiosks = await call('GET', `${T}/kiosks`, hr);
            check('the kiosk list shows the tablet, and never its key', kiosks.s === 200 && kiosks.b.data.some((k) => k.id === kiosk.b.id && k.active) && !kiosks.text.includes(kiosk.b.key), kiosks.b);
        }
        ctx.skip('A photo at clock-in', 'needs a camera; the policy here has photos switched off');

        // --------------------------------------------------------------------------------------- jobs and time
        ctx.section('Jobs and which job the time went to');
        check('a manager cannot add a job (403)', (await call('POST', `${U}/jobs`, manager, { code: 'X1', name: 'X' })).s === 403);
        check('a job code with a space in it is refused (400)', (await call('POST', `${U}/jobs`, hr, { code: 'front desk', name: 'Front' })).s === 400);
        const jobIds = {};
        for (const [code, name, costCenter] of [['FRONT', 'Front of store', 'CC-100'], ['STOCK', 'Stock room', 'CC-200']]) {
            const made = await call('POST', `${U}/jobs`, hr, { code, name, costCenter });
            if (made.s === 201) jobIds[code] = made.b.job.id;
            else jobIds[code] = (((await call('GET', `${U}/jobs?all=1`, hr)).b.data || []).find((j) => j.code === code) || {}).id;
            check(`the job "${name}" (${code}) exists`, Boolean(jobIds[code]), made.b);
        }
        check('the same job code twice is refused (409)', (await call('POST', `${U}/jobs`, hr, { code: 'FRONT', name: 'Again' })).s === 409);
        check('everyone can see the job list', ((await call('GET', `${U}/jobs`, tok.stocker)).b.data || []).length >= 2);
        const split = await call('POST', `${U}/allocations`, tok.stocker, { date: dayOf(0), allocations: [{ jobId: jobIds.STOCK, minutes: 180, note: 'Delivery' }, { jobId: jobIds.FRONT, minutes: 60 }] });
        check('the stock clerk splits Monday\'s four hours: three in the stock room, one at the front', split.s === 201 && split.b.workedMinutes === 240 && split.b.allocatedMinutes === 240, split.b);
        const tooMuch = await call('POST', `${U}/allocations`, tok.stocker, { date: dayOf(2), allocations: [{ jobId: jobIds.STOCK, minutes: 300 }] });
        check('five hours on a day with four worked is refused (400)', tooMuch.s === 400, tooMuch.b);
        const stockerWeek = await call('GET', `${T}/weeks/${lastWeekStart}`, tok.stocker);
        const wedIn = (((stockerWeek.b.days || []).find((d) => d.date === dayOf(2)) || {}).punches || []).find((p) => p.type === 'in');
        if (check('the stock clerk finds Wednesday\'s clock-in', Boolean(wedIn), stockerWeek.b.days)) {
            const one = await call('POST', `${U}/allocations/from-punch`, tok.stocker, { punchId: wedIn.id, jobId: jobIds.STOCK });
            check('and puts that whole work period (240 minutes) on the stock room', one.s === 201 && one.b.minutes === 240, one.b);
            check('the same period cannot be put on a job twice (409)', (await call('POST', `${U}/allocations/from-punch`, tok.stocker, { punchId: wedIn.id, jobId: jobIds.FRONT })).s === 409);
        }
        const allocs = await call('GET', `${U}/allocations?userId=${P.stocker.uid}&from=${lastWeekStart}&to=${lastWeekEnd}`, manager);
        check('the manager reads the stock clerk\'s allocations (three rows, 480 minutes)', allocs.s === 200 && allocs.b.data.length === 3 && allocs.b.data.reduce((s, a) => s + a.minutes, 0) === 480, allocs.b);
        check('an employee cannot read a coworker\'s allocations (403)', (await call('GET', `${U}/allocations?userId=${P.stocker.uid}`, tok.cashier)).s === 403);
        const jobReport = await call('GET', `${U}/jobs/report?from=${lastWeekStart}&to=${lastWeekEnd}`, manager);
        const stockRow = (jobReport.b.data || []).find((r) => r.jobId === jobIds.STOCK || r.code === 'STOCK');
        check('the job report adds up to 8 hours: 7 in the stock room and 1 at the front', jobReport.s === 200 && near(jobReport.b.totalHours, 8) && stockRow && stockRow.minutes === 420, jobReport.b);

        // ------------------------------------------------------------------------------------------------- tips
        ctx.section('Tips');
        const tipDays = PLAN.server.map((d) => dayOf(d.day));
        const CASH_PER_DAY = 40; const CARD_TIPS = 100;
        check('a manager cannot mark someone as a tipped employee (403)', (await call('PUT', `${U}/tips/employees/${P.server.uid}/tipped`, manager, { tipped: true })).s === 403);
        const tipped = await call('PUT', `${U}/tips/employees/${P.server.uid}/tipped`, hr, { tipped: true });
        check('HR marks the server as a tipped employee', tipped.s === 200 && tipped.b.tipped === true, tipped.b);
        const notTipped = await call('POST', `${U}/tips/me`, tok.cashier, { date: tipDays[0], cashTips: 10 });
        check('the cashier, who is not tipped, cannot declare tips (403)', notTipped.s === 403, notTipped.b);
        check('tips for a day in the future are refused (400)', (await call('POST', `${U}/tips/me`, tok.server, { date: ctx.addDays(today, 3), cashTips: 10 })).s === 400);
        let declared = 0;
        for (const date of tipDays) { const r = await call('POST', `${U}/tips/me`, tok.server, { date, cashTips: CASH_PER_DAY, note: 'Evening shift' }); if (r.s === 201 || r.s === 200) declared += 1; }
        check(`the server declares $${CASH_PER_DAY} cash tips for each of the five days worked`, declared === tipDays.length, declared);
        const fixTip = await call('POST', `${U}/tips/me`, tok.server, { date: tipDays[0], cashTips: CASH_PER_DAY, note: 'Counted again' });
        check('declaring a day again replaces it, it does not add to it', fixTip.s === 200 && fixTip.b.record.cashTips === CASH_PER_DAY, fixTip.b);
        const card = await call('POST', `${U}/tips/card`, hr, { userId: P.server.uid, date: tipDays[4], cardTips: CARD_TIPS });
        check(`HR enters $${CARD_TIPS} of card tips for the Saturday`, card.s === 201 && card.b.record.total === CASH_PER_DAY + CARD_TIPS, card.b);
        const tipTotal = CASH_PER_DAY * tipDays.length + CARD_TIPS;
        const myTips = await call('GET', `${U}/tips/me?month=${tipDays[4].slice(0, 7)}`, tok.server);
        check('the server sees their own tips for the month, cash and card', myTips.s === 200 && myTips.b.tipped === true && myTips.b.data.some((r) => r.date === tipDays[4] && r.cardTips === CARD_TIPS && r.cashTips === CASH_PER_DAY), myTips.b);
        const tipReport = await call('GET', `${U}/tips/report?from=${lastWeekStart}&to=${lastWeekEnd}`, payroll);
        const tipRow = (tipReport.b.data || []).find((r) => r.userId === P.server.uid);
        check(`the tip report for payroll shows $${tipTotal} for the server last week ($200 cash + $100 card over five days)`, tipReport.s === 200 && tipRow && tipRow.totalTips === tipTotal && tipRow.cashTips === 200 && tipRow.cardTips === 100 && tipRow.days === 5 && tipRow.reportable === 'yes', tipReport.b);
        const tipCsv = await call('GET', `${U}/tips/report?from=${lastWeekStart}&to=${lastWeekEnd}&format=csv`, payroll);
        check('the same report downloads as a CSV file', tipCsv.s === 200 && /text\/csv/.test(tipCsv.headers.get('content-type') || '') && tipCsv.text.includes(P.server.employeeId), tipCsv.text.slice(0, 200));
        check('an employee cannot read the tip report (403)', (await call('GET', `${U}/tips/report`, tok.server)).s === 403);

        // ------------------------------------------------------------------------------------------ timesheets
        ctx.section('Timesheets are sent in and approved');
        check('a week that has not started cannot be sent in (400)', (await call('POST', `${T}/weeks/${nextWeekStart}/submit`, tok.cashier)).s === 400);
        check('a date that is not the first day of a workweek is refused (400)', (await call('POST', `${T}/weeks/${dayOf(1)}/submit`, tok.cashier)).s === 400);
        for (const key of HOURLY) {
            const r = await call('POST', `${T}/weeks/${lastWeekStart}/submit`, tok[key], {});
            check(`${P[key].name} sends in last week (${expected[key].workedHours} hours)`, r.s === 200 && r.b.status === 'submitted' && near(r.b.totals.workedHours, expected[key].workedHours), r.b);
        }
        check('sending the same week in twice is refused (409)', (await call('POST', `${T}/weeks/${lastWeekStart}/submit`, tok.cashier, {})).s === 409);
        const mgrOwn = await call('POST', `${T}/weeks/${lastWeekStart}/submit`, manager, {});
        check('the manager, who is salaried, sends in their own week too', mgrOwn.s === 200, mgrOwn.b);
        const queue = await call('GET', `${T}/approvals`, manager);
        check('the manager\'s approval list has exactly their four people', queue.s === 200 && queue.b.count === 4 && HOURLY.every((k) => queue.b.data.some((w) => w.userId === P[k].uid)) && queue.b.canDecide === true && queue.b.canReopen === false, { count: queue.b.count, names: (queue.b.data || []).map((w) => w.name) });
        const queueHr = await call('GET', `${T}/approvals`, hr);
        check('HR sees all five weeks that are waiting', queueHr.s === 200 && queueHr.b.count === 5, queueHr.b.count);
        check('an employee cannot open the approval list (403)', (await call('GET', `${T}/approvals`, tok.cashier)).s === 403);
        const audView = await call('GET', `${T}/approvals`, auditor);
        check('the auditor can look at the list but cannot decide (403)', audView.s === 200 && audView.b.canDecide === false && (await call('PUT', `${T}/weeks/${P.cashier.uid}/${lastWeekStart}/decision`, auditor, { decision: 'approve' })).s === 403, audView.b.canDecide);
        check('an employee cannot approve hours (403)', (await call('PUT', `${T}/weeks/${P.server.uid}/${lastWeekStart}/decision`, tok.cashier, { decision: 'approve' })).s === 403);
        const own = await call('PUT', `${T}/weeks/${P.manager.uid}/${lastWeekStart}/decision`, manager, { decision: 'approve' });
        check('the manager cannot approve their own hours (403)', own.s === 403 && /own/i.test(own.b.error || ''), own.b);
        const hrDecides = await call('PUT', `${T}/weeks/${P.manager.uid}/${lastWeekStart}/decision`, hr, { decision: 'approve' });
        check('HR approves the manager\'s week', hrDecides.s === 200 && hrDecides.b.status === 'approved', hrDecides.b);
        check('the manager cannot approve the week of someone outside their team (403)', (await call('PUT', `${T}/weeks/${P.hr.uid}/${lastWeekStart}/decision`, manager, { decision: 'approve' })).s === 403);
        check('sending a week back without saying why is refused (400)', (await call('PUT', `${T}/weeks/${P.leaver.uid}/${lastWeekStart}/decision`, manager, { decision: 'reject' })).s === 400);
        const back = await call('PUT', `${T}/weeks/${P.leaver.uid}/${lastWeekStart}/decision`, manager, { decision: 'reject', note: 'Please check Thursday and send again' });
        const sentBack = await call('GET', `${T}/weeks/${lastWeekStart}`, tok.leaver);
        check('the manager sends the barista\'s week back with a note the barista can read', back.s === 200 && back.b.status === 'rejected' && sentBack.b.status === 'rejected' && /Thursday/.test(sentBack.b.decisionNote || ''), { decision: back.b, week: { status: sentBack.b.status, note: sentBack.b.decisionNote } });
        const again = await call('POST', `${T}/weeks/${lastWeekStart}/submit`, tok.leaver, {});
        check('the barista sends it in again', again.s === 200 && again.b.status === 'submitted', again.b);
        for (const key of HOURLY) {
            const r = await call('PUT', `${T}/weeks/${P[key].uid}/${lastWeekStart}/decision`, manager, { decision: 'approve' });
            check(`the manager approves ${P[key].name}'s week`, r.s === 200 && r.b.status === 'approved', r.b);
        }
        check('a week that is already approved cannot be decided again (409)', (await call('PUT', `${T}/weeks/${P.cashier.uid}/${lastWeekStart}/decision`, manager, { decision: 'reject', note: 'changed my mind' })).s === 409);

        ctx.section('An approved week is locked until HR reopens it');
        const locked1 = await call('POST', `${T}/punches/manual`, hr, { userId: P.stocker.uid, type: 'in', at: zonedIso(dayOf(1), '09:00', tz), reason: 'Forgotten Tuesday shift' });
        check('a missed punch cannot be added to an approved week (409)', locked1.s === 409, locked1.b);
        const locked2 = await call('POST', `${T}/corrections`, tok.stocker, { kind: 'add', type: 'in', localDate: dayOf(1), localTime: '09:00', reason: 'Forgotten Tuesday shift' });
        check('the employee cannot ask for a fix in an approved week either (409)', locked2.s === 409, locked2.b);
        check('a manager cannot reopen a week (403)', (await call('POST', `${T}/weeks/${P.stocker.uid}/${lastWeekStart}/reopen`, manager, { reason: 'Forgotten Tuesday shift' })).s === 403);
        check('reopening needs a reason (400)', (await call('POST', `${T}/weeks/${P.stocker.uid}/${lastWeekStart}/reopen`, hr, {})).s === 400);
        const reopen = await call('POST', `${T}/weeks/${P.stocker.uid}/${lastWeekStart}/reopen`, hr, { reason: 'Checking Tuesday with the stock clerk' });
        check('HR reopens the stock clerk\'s week', reopen.s === 200 && reopen.b.status === 'open' && reopen.b.was === 'approved', reopen.b);
        const resend = await call('POST', `${T}/weeks/${lastWeekStart}/submit`, tok.stocker, {});
        const reapprove = await call('PUT', `${T}/weeks/${P.stocker.uid}/${lastWeekStart}/decision`, payroll, { decision: 'approve' });
        check('nothing had to change: the stock clerk sends it in again and the payroll admin approves it', resend.s === 200 && reapprove.s === 200 && reapprove.b.status === 'approved', { resend: resend.b, approve: reapprove.b });
        const done = await call('GET', `${T}/approvals?status=approved`, hr);
        check('five weeks are now approved (four hourly people and the manager)', done.s === 200 && done.b.data.filter((w) => w.weekStart === lastWeekStart).length === 5, (done.b.data || []).map((w) => [w.name, w.weekStart]));

        // ------------------------------------------------------------------------- tip pool and tip credit check
        ctx.section('Tip pool and tip credit check (they use the approved hours)');
        const pool = await call('POST', `${U}/tips/pools`, hr, { name: `Cafe pool ${stamp}`, shareMethod: 'hours', participants: [{ userId: P.server.uid }, { userId: P.leaver.uid }, { userId: P.manager.uid, manager: true }] });
        if (check('HR sets up a tip pool shared by hours: server, barista, and the manager (who is left out)', pool.s === 201 && pool.b.pool.participants.length === 3 && pool.b.pool.excludeManagers === true, pool.b)) {
            check('a pool with nobody in it is refused (400)', (await call('POST', `${U}/tips/pools`, hr, { name: 'Empty', shareMethod: 'hours', participants: [] })).s === 400);
            check('a manager cannot share out a pool (403)', (await call('POST', `${U}/tips/pools/${pool.b.pool.id}/distribute`, manager, { amount: 310, from: lastWeekStart, to: lastWeekEnd })).s === 403);
            const share = await call('POST', `${U}/tips/pools/${pool.b.pool.id}/distribute`, hr, { amount: 310, from: lastWeekStart, to: lastWeekEnd });
            const shares = (share.b.distribution && share.b.distribution.shares) || [];
            const of = (uid) => shares.find((s) => s.userId === uid) || {};
            // server 30 hours, barista 32 hours: 310 x 30/62 = 150.00 and 310 x 32/62 = 160.00
            check('$310 is shared by approved hours: $150 to the server (30 h), $160 to the barista (32 h), nothing to the manager', share.s === 201 && of(P.server.uid).amount === 150 && of(P.leaver.uid).amount === 160 && of(P.manager.uid).amount === 0 && of(P.manager.uid).excluded === true && near(shares.reduce((s, x) => s + x.amount, 0), 310), share.b);
            const dist = await call('GET', `${U}/tips/distributions`, payroll);
            check('the payroll admin sees the distribution in the list', dist.s === 200 && dist.b.data.some((d) => d.poolId === pool.b.pool.id && d.amount === 310), dist.b);
        }
        const credit = await call('GET', `${U}/tips/credit-check?weekStart=${lastWeekStart}`, hr);
        const cRow = (credit.b.data || []).find((r) => r.userId === P.server.uid);
        // $12.00 an hour + $300 tips / 30 hours = $22.00 an hour, against a $7.25 minimum
        check('tip credit check: the server\'s $12.00 wage plus $10.00 an hour in tips ($300 over 30 hours) is $22.00, above the $7.25 minimum', credit.s === 200 && cRow && cRow.status === 'ok' && cRow.hours === 30 && cRow.tips === tipTotal && cRow.tipsPerHour === 10 && cRow.effectiveHourly === 22 && cRow.minimum === 7.25 && cRow.makeUpAmount === 0, credit.b);
        check('only tipped employees are in the tip credit check', (credit.b.data || []).length === 1, (credit.b.data || []).map((r) => r.name));
        check('a tip credit check for a week that does not start on a Monday is refused (400)', (await call('GET', `${U}/tips/credit-check?weekStart=${dayOf(3)}`, hr)).s === 400);

        // ----------------------------------------------------------------------------------- export and reports
        ctx.section('Hours export for payroll');
        const exp = await call('GET', `${T}/export/hours?from=${lastWeekStart}&to=${lastWeekStart}`, payroll);
        const rowOf = (key) => (exp.b.data || []).find((r) => r.employee_id === P[key].employeeId) || {};
        check('the export has one row per approved week: five rows', exp.s === 200 && exp.b.count === 5, exp.b);
        for (const key of HOURLY) {
            const e = expected[key]; const r = rowOf(key);
            check(`export row for ${P[key].name}: ${e.regularHours} regular, ${e.overtimeHours} overtime, ${e.holidayHours} holiday`, near(r.regular_hours, e.regularHours) && near(r.overtime_hours, e.overtimeHours) && near(r.total_hours, e.workedHours) && near(r.holiday_hours, e.holidayHours) && r.flsa_status === 'non_exempt' && r.week_end === lastWeekEnd, r);
        }
        check('the manager\'s row is marked exempt with no hours', rowOf('manager').flsa_status === 'exempt' && near(rowOf('manager').total_hours, 0), rowOf('manager'));
        const csv = await call('GET', `${T}/export/hours?from=${lastWeekStart}&to=${lastWeekStart}&format=csv`, await ctx.as('accountant'));
        check('the accountant downloads the same hours as a CSV file', csv.s === 200 && /text\/csv/.test(csv.headers.get('content-type') || '') && csv.text.split('\n').filter(Boolean).length === 6 && csv.text.includes(`${P.cashier.employeeId},`), csv.text.slice(0, 300));
        check('a manager and an employee cannot download the hours export (403)', (await call('GET', `${T}/export/hours`, manager)).s === 403 && (await call('GET', `${T}/export/hours`, tok.cashier)).s === 403);
        check('no token cannot download it (401)', (await call('GET', `${T}/export/hours`, null)).s === 401);

        ctx.section('Reports: time, labor, planned and worked');
        const timeRep = await call('GET', `${U}/reports/time`, hr);
        check('the time report reads for HR', timeRep.s === 200 && timeRep.b.success === true, timeRep.b);
        const labor = await call('GET', `${U}/reports/labor?from=${lastWeekStart}&to=${lastWeekStart}`, await ctx.as('executive'));
        const lab = (key) => (labor.b.byPerson || []).find((r) => r.userId === P[key].uid) || {};
        // 40 x 18.50 + 7 x 18.50 x 1.5 = 740.00 + 194.25 = 934.25
        check('labor report (read by the executive): the cashier\'s 40 regular and 7 overtime hours cost an estimated $934.25', labor.s === 200 && near(lab('cashier').regularHours, 40) && near(lab('cashier').overtimeHours, 7) && near(lab('cashier').estimatedCost, 934.25) && near(lab('cashier').overtimeCost, 194.25), lab('cashier'));
        check('labor report: server 30 h x $12 = $360, stock clerk 12 h x $17 = $204, barista 32 h x $16 = $512', near(lab('server').estimatedCost, 360) && near(lab('stocker').estimatedCost, 204) && near(lab('leaver').estimatedCost, 512), [lab('server'), lab('stocker'), lab('leaver')].map((r) => r.estimatedCost));
        check('labor report: each person is listed under their department (the cashier under Store, the server under Cafe)', lab('cashier').department === 'Store' && lab('server').department === 'Cafe', [lab('cashier'), lab('server')].map((r) => [r.name, r.department]));
        check('an employee and a manager cannot read the labor report (403)', (await call('GET', `${U}/reports/labor`, tok.cashier)).s === 403 && (await call('GET', `${U}/reports/labor`, manager)).s === 403);
        const laborCsv = await call('GET', `${U}/reports/labor?from=${lastWeekStart}&to=${lastWeekStart}&format=csv`, hr);
        check('the labor report downloads as a CSV file', laborCsv.s === 200 && /text\/csv/.test(laborCsv.headers.get('content-type') || '') && laborCsv.text.includes(P.cashier.employeeId), laborCsv.text.slice(0, 200));
        const summary = await call('GET', `${U}/reports/summary`, hr);
        check('the report summary reads', summary.s === 200, summary.b);
        const vs = await call('GET', `${U}/schedule/reports/vs-actual?from=${lastWeekStart}&to=${lastWeekEnd}`, manager);
        check('planned and worked: every one of last week\'s planned shifts is compared with the clock', vs.s === 200 && vs.b.data.length === planned && vs.b.data.every((r) => r.name), { rows: (vs.b.data || []).length, summary: vs.b.summary });
        ctx.info(`planned and worked summary: ${JSON.stringify(vs.b.summary)}`);
        const noShow = (vs.b.data || []).filter((r) => r.status === 'no_show');
        check('nobody is shown as a no-show: every planned shift of last week was worked, and on time', noShow.length === 0 && vs.b.summary.noShow === 0 && vs.b.summary.onTime === planned, { noShow: noShow.slice(0, 3), summary: vs.b.summary });
        const plannedMinutes = Math.round(HOURLY.reduce((s, k) => s + scheduledHours[k], 0) * 60);
        check('planned hours in the report are the hours that were scheduled (' + (plannedMinutes / 60) + ')', vs.b.summary.scheduledMinutes === plannedMinutes, vs.b.summary);
        const weekAfter = await call('GET', `${U}/schedule/week?weekStart=${lastWeekStart}`, manager);
        check('the schedule week view now shows last week as published', weekAfter.s === 200 && weekAfter.b.published === true, weekAfter.b.published);
        check('an employee cannot read planned and worked (403)', (await call('GET', `${U}/schedule/reports/vs-actual`, tok.cashier)).s === 403);
        check('the premium-pay list for late schedule changes reads (no rules entered, so it is empty)', (await call('GET', `${U}/schedule/reports/premium`, manager)).s === 200);

        // ------------------------------------------------------------------------------------- for the next stage
        state.ids.time = {
            timeZone: tz, today, lastWeekStart, lastWeekEnd, thisWeekStart, thisWeekEnd, nextWeekStart, holidayDate, holidayHoursPerDay: HOLIDAY_HOURS,
            expected,                       // per person: workedHours, regularHours, overtimeHours, holidayHours, payRate
            tips: { server: { cash: CASH_PER_DAY * tipDays.length, card: CARD_TIPS, total: tipTotal, poolShare: 150 }, leaver: { poolShare: 160 } },
            jobs: jobIds, approvedWeeks: [...HOURLY, 'manager']
        };
        ctx.save();
        void owner;
    }
};
