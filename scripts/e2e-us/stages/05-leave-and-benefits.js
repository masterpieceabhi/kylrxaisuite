/**
 * Stage 05: leave, holidays and benefits.
 *
 * HR sets up PTO and paid sick leave (from the app's presets), the company holidays and holiday pay. People ask for
 * time off, a manager decides, HR adjusts, a long leave case (FMLA style) is walked from request to close, and the
 * payout of unused time is previewed. Then benefits: plans, enrollment by the employee and by HR, a life event, the
 * payroll deduction feed, ACA offers, COBRA, a dependent's SSN, and ending an enrollment.
 *
 * Rules this stage keeps: nothing is put on 'leaver' (stage 08 pays out that balance); approved time off for the
 * shared people is in future weeks only (stage 03 fills last week). Time off in the past, the FMLA case, COBRA and
 * the ended enrollment are on one extra person this stage adds (kept in state.ids.leave.extraPerson).
 */
const PASSWORD = 'E2e-Run#2026pass';
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.006;
/** JSON text with the keys in a fixed order, so two settings can be compared */
const sorted = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

module.exports = {
    id: '05',
    title: 'Leave, holidays and benefits',
    covers: ['US-E01', 'US-E02', 'US-E03', 'US-E04', 'US-E05', 'US-E06', 'US-E07', 'US-E08', 'US-G01', 'US-G02', 'US-G03', 'US-G04', 'US-G06'],
    async run(ctx) {
        const { call, check, U, state, addDays, dayOfWeek } = ctx;
        const P = state.people;
        const stamp = `${state.run}-${String(Date.now()).slice(-6)}`;
        const hr = await ctx.as('hr');
        const manager = await ctx.as('manager');
        const payroll = await ctx.as('payroll');
        const auditor = await ctx.as('auditor');
        const cashier = await ctx.as('cashier');
        const server = await ctx.as('server');
        const stocker = await ctx.as('stocker');
        const prev = { leave: state.ids.leave || null, benefits: state.ids.benefits || null };
        const ids = { leave: { ...(prev.leave || {}) }, benefits: { ...(prev.benefits || {}) } };
        state.ids.leave = ids.leave; state.ids.benefits = ids.benefits;

        // The company's own "today" (America/Chicago), which can be a day behind the clock this run uses
        const first = await call('GET', `${U}/leave/balances`, cashier);
        const today = first.b.asOf || ctx.today;
        const hire = addDays(String(state.startedAt).slice(0, 10), -75); // the start date stage 01 gave everyone
        const year = Number(today.slice(0, 4));

        // ------------------------------------------------------------------------------- the extra person
        ctx.section('One more employee for this stage (time off in the past, a long leave, COBRA)');
        let extra = ids.leave.extraPerson || null;
        if (!extra) {
            const email = `benefits${String(Date.now()).slice(-6)}@${state.company.domain}`;
            const made = await call('POST', `${U}/employees`, hr, { firstName: 'Bianca', lastName: 'Flores', email, role: 'employee', startDate: hire, jobTitle: 'Deli Clerk' });
            const e = made.b.employee || {};
            if (!check('HR adds Bianca Flores, a full-time deli clerk', made.s === 201 && e.uid && e.temporaryPassword, made.b)) return;
            const profile = await call('PUT', `${U}/employees/${e.uid}/profile`, hr, {
                legalFirstName: 'Bianca', legalLastName: 'Flores', dateOfBirth: '1992-02-11', homeAddress: { line1: '415 Barton Springs Rd', city: 'Austin', state: 'TX', zip: '78704' },
                workState: 'TX', classification: 'W2', employmentType: 'full_time', payFrequency: 'weekly', payType: 'hourly', payRate: 15, flsaStatus: 'non_exempt',
                jobTitle: 'Deli Clerk', startDate: hire, departmentId: (state.ids.departments || {}).store, locationId: (state.ids.locations || {}).main,
                taxpayerIdType: 'SSN', taxpayerId: '531-41-4055' // made-up number for the local run
            });
            check('her US profile is saved (hourly 15, full time, weekly pay)', profile.s === 200, profile.b);
            extra = { uid: e.uid, employeeId: e.employeeId, email, password: e.temporaryPassword, passwordChanged: false, name: 'Bianca Flores', payType: 'hourly', payRate: 15 };
            ids.leave.extraPerson = extra; ctx.save();
        } else ctx.info(`using ${extra.name} from the earlier run of this stage`);
        if (!extra.passwordChanged) {
            // the app lets a new person do nothing until the temporary password is replaced
            const temp = await ctx.signIn(extra.email, extra.password);
            const changed = await call('POST', '/api/auth/change-password', temp, { currentPassword: extra.password, newPassword: PASSWORD });
            if (!check('Bianca replaces her temporary password', changed.s === 200, changed.b)) return;
            extra.password = PASSWORD; extra.passwordChanged = true; ctx.save();
        }
        const bianca = await ctx.signIn(extra.email, extra.password);

        // --------------------------------------------------- a second run on the same company: put things back first
        if (prev.leave) {
            const mine = [P.cashier.uid, P.server.uid, P.manager.uid, extra.uid];
            const open = await call('GET', `${U}/leave/requests?scope=all`, hr);
            for (const r of (open.b.data || []).filter((x) => mine.includes(x.userId) && ['pending', 'approved'].includes(x.status))) await call('POST', `${U}/leave/requests/${r.id}/cancel`, hr);
            for (const id of [prev.leave.ptoPolicyId, prev.leave.sickPolicyId].filter(Boolean)) await call('DELETE', `${U}/leave/policies/${id}`, hr);
            for (const id of [prev.leave.holidayId, prev.leave.federalOverrideId].filter(Boolean)) await call('DELETE', `${U}/holidays/${id}`, hr);
            for (const id of Object.values((prev.benefits && prev.benefits.plans) || {})) await call('DELETE', `${U}/benefits/plans/${id}`, hr);
            const oldCobra = await call('GET', `${U}/benefits/cobra`, hr);
            for (const c of (oldCobra.b.data || []).filter((x) => x.userId === extra.uid && x.status !== 'terminated')) await call('POST', `${U}/benefits/cobra/${c.id}/action`, hr, { action: 'terminate', note: 'cleared before a new run' });
            ctx.info('the earlier run of this stage was cleared (requests cancelled, its policies, holiday and plans archived)');
        }

        // =============================================================================================== HOLIDAYS
        ctx.section('Company holidays');
        const holidaySet = new Set();
        let calendar = null;
        for (const y of [year, year + 1]) {
            const c = await call('GET', `${U}/holidays?year=${y}`, cashier);
            if (y === year) calendar = c;
            for (const h of c.b.data || []) if (h.active) holidaySet.add(h.date);
        }
        check('everyone can read the holiday calendar; it starts with the 11 federal holidays', calendar.s === 200 && (calendar.b.data || []).filter((h) => h.kind === 'federal').length === 11, calendar.text.slice(0, 300));

        // a Wednesday at least 17 days out (the PTO waiting period ends by then), in a week with no other holiday
        let wed = addDays(today, 17);
        while (dayOfWeek(wed) !== 3) wed = addDays(wed, 1);
        while ([-1, 0, 1, 5, 6].some((n) => holidaySet.has(addDays(wed, n)))) wed = addDays(wed, 7);
        const tue = addDays(wed, -1); const thu = addDays(wed, 1); const nextMon = addDays(wed, 5); const nextTue = addDays(wed, 6);

        const holidayBody = { date: wed, name: `Founders Day ${stamp}`, paid: true };
        check('an employee cannot add a company holiday (403)', (await call('POST', `${U}/holidays`, cashier, holidayBody)).s === 403);
        check('a holiday without a date is refused (400)', (await call('POST', `${U}/holidays`, hr, { name: 'No date' })).s === 400);
        const hol = await call('POST', `${U}/holidays`, hr, holidayBody);
        if (!check(`HR adds a paid company holiday on ${wed}`, hol.s === 201 && hol.b.holiday && hol.b.holiday.id, hol.b)) return;
        ids.leave.holidayId = hol.b.holiday.id; ids.leave.holidayDate = wed;
        check('the same holiday twice is refused (409)', (await call('POST', `${U}/holidays`, hr, holidayBody)).s === 409);
        const isHol = await call('GET', `${U}/holidays/check?date=${wed}`, cashier);
        const notHol = await call('GET', `${U}/holidays/check?date=${tue}`, cashier);
        check('the day check says that date is a holiday and the day before is not', isHol.b.holiday === true && notHol.b.holiday === false, { wed: isHol.b, tue: notHol.b });
        const fed = await call('POST', `${U}/holidays`, hr, { kind: 'federal', federalKey: 'columbus_day', year: year + 1, active: false });
        if (check(`HR switches off Columbus Day ${year + 1} for the company`, fed.s === 201 && fed.b.holiday, fed.b)) {
            ids.leave.federalOverrideId = fed.b.holiday.id;
            const next = await call('GET', `${U}/holidays?year=${year + 1}`, hr);
            const col = (next.b.data || []).find((h) => h.federalKey === 'columbus_day');
            const chk = col ? await call('GET', `${U}/holidays/check?date=${col.date}`, hr) : { b: {} };
            check('next year\'s calendar shows it as not observed, and that day is no longer a holiday', col && col.active === false && chk.b.holiday === false, { col, chk: chk.b });
        }

        // ------------------------------------------------------------------------------------------ holiday pay
        ctx.section('Holiday pay setting');
        const rulesNow = await call('GET', '/api/time/rules', hr);
        const keep = { ...(rulesNow.b.rules || {}) }; delete keep.workweek; // the other time rules (stage 03 may have set them) are sent back unchanged
        check('an employee cannot change the holiday pay setting (403)', (await call('PUT', '/api/time/rules', cashier, { ...keep, holidayPay: { enabled: true, hours: 8, who: 'everyone' } })).s === 403);
        check('holiday pay of 30 hours a day is refused (400)', (await call('PUT', '/api/time/rules', hr, { ...keep, holidayPay: { enabled: true, hours: 30, who: 'everyone' } })).s === 400);
        const setPay = await call('PUT', '/api/time/rules', hr, { ...keep, holidayPay: { enabled: true, hours: 8, who: 'full_time' } });
        check('HR turns on holiday pay: 8 hours for each paid holiday, full-time staff only', setPay.s === 200 && setPay.b.rules.holidayPay.enabled === true && setPay.b.rules.holidayPay.who === 'full_time', setPay.b);
        const kept = Object.keys(keep).filter((k) => k !== 'holidayPay').every((k) => sorted(setPay.b.rules[k]) === sorted(keep[k]));
        check('the other time rules stay as they were', kept, { before: keep, after: setPay.b.rules });
        // the week that holds the new holiday, as each person's timesheet shows it
        let weekOf = null;
        const cur = await call('GET', '/api/time/weeks/current', cashier);
        let ws = cur.b.nextWeekStart;
        for (let i = 0; i < 8 && ws && !weekOf; i += 1) {
            const w = await call('GET', `/api/time/weeks/${ws}`, cashier);
            if (w.s !== 200) break;
            if (w.b.weekStart <= wed && w.b.weekEnd >= wed) weekOf = w; else ws = w.b.nextWeekStart;
        }
        if (check('the cashier\'s timesheet for that week can be opened', weekOf && weekOf.s === 200, { current: cur.b, ws })) {
            const mineDay = (w) => (w.b.holidayPay || []).find((h) => h.date === wed);
            check('the cashier (hourly, full time) gets 8 paid holiday hours for the company holiday', mineDay(weekOf) && mineDay(weekOf).hours === 8 && (weekOf.b.holidays || []).some((h) => h.date === wed), { holidayPay: weekOf.b.holidayPay, holidays: weekOf.b.holidays });
            const part = await call('GET', `/api/time/weeks/${ws}`, stocker);
            check('the part-time stock clerk gets none (full-time staff only)', part.s === 200 && !mineDay(part), part.b.holidayPay);
            const sal = await call('GET', `/api/time/weeks/${ws}`, manager);
            check('the salaried manager gets no extra holiday hours (the salary already covers the day)', sal.s === 200 && !mineDay(sal), sal.b.holidayPay);
            const unpaid = await call('PUT', `${U}/holidays/${ids.leave.holidayId}`, hr, { paid: false });
            const w2 = await call('GET', `/api/time/weeks/${ws}`, cashier);
            check('when HR marks the holiday unpaid the holiday hours go away', unpaid.s === 200 && !mineDay(w2), { unpaid: unpaid.b, holidayPay: w2.b.holidayPay });
            const paid = await call('PUT', `${U}/holidays/${ids.leave.holidayId}`, hr, { paid: true });
            const w3 = await call('GET', `/api/time/weeks/${ws}`, cashier);
            check('and come back when it is marked paid again', paid.s === 200 && mineDay(w3) && mineDay(w3).hours === 8, w3.b.holidayPay);
        }

        // ================================================================================================= LEAVE
        ctx.section('PTO and paid sick policies, from the presets');
        const presets = await call('GET', `${U}/leave/policies/presets`, hr);
        const ptoPreset = (presets.b.data || []).find((p) => p.key === 'pto_monthly_80');
        const sickPreset = (presets.b.data || []).find((p) => p.key === 'sick_front_load_40');
        if (!check('the app offers starting points for PTO and paid sick leave', presets.s === 200 && ptoPreset && sickPreset, presets.text.slice(0, 300))) return;
        check('an employee cannot create a leave policy (403)', (await call('POST', `${U}/leave/policies`, cashier, { ...ptoPreset, name: 'x' })).s === 403);
        check('a policy with no accrual method is refused (400)', (await call('POST', `${U}/leave/policies`, hr, { name: 'Broken', type: 'pto' })).s === 400);
        const ptoMade = await call('POST', `${U}/leave/policies`, hr, { ...ptoPreset, name: `PTO ${stamp}`, payoutAtTermination: true });
        const sickMade = await call('POST', `${U}/leave/policies`, hr, { ...sickPreset, name: `Paid sick leave ${stamp}` });
        if (!check('HR creates the PTO policy (6.67 hours a month, usable after 90 days, paid out when someone leaves)', ptoMade.s === 201 && ptoMade.b.policy.payoutAtTermination === true && ptoMade.b.policy.usageWaitingDays === 90, ptoMade.b)) return;
        if (!check('HR creates the paid sick policy (40 hours each year, given up front)', sickMade.s === 201 && sickMade.b.policy.accrual.grantHours === 40, sickMade.b)) return;
        const pto = ptoMade.b.policy; const sick = sickMade.b.policy;
        ids.leave.ptoPolicyId = pto.id; ids.leave.sickPolicyId = sick.id; ids.leave.ptoPolicyName = pto.name; ids.leave.sickPolicyName = sick.name;
        const edited = await call('PUT', `${U}/leave/policies/${sick.id}`, hr, { notes: 'Confirmed with the advisor for Texas' });
        check('HR edits the sick policy note and the numbers stay', edited.s === 200 && edited.b.policy.notes.startsWith('Confirmed') && edited.b.policy.accrual.grantHours === 40, edited.b);
        const listed = await call('GET', `${U}/leave/policies`, cashier);
        check('employees see both policies', listed.s === 200 && [pto.id, sick.id].every((id) => (listed.b.data || []).some((p) => p.id === id)), listed.text.slice(0, 300));

        ctx.section('Balances appear for each person');
        // month ends between the start date and today, 6.67 hours each
        let monthEnds = 0;
        for (let d = hire; d <= today; d = addDays(d, 1)) if (addDays(d, 1).slice(8) === '01') monthEnds += 1;
        const expectedPto = r2(monthEnds * 6.67);
        const balances = async (token, uid) => {
            const r = await call('GET', `${U}/leave/balances/${uid}`, token);
            const row = (id) => ((r.b.data || []).find((x) => x.policy.id === id) || {}).balance || null;
            return { s: r.s, pto: row(pto.id), sick: row(sick.id), raw: r };
        };
        const wrong = [];
        for (const key of Object.keys(P).filter((k) => k !== 'owner')) {
            const b = await balances(hr, P[key].uid);
            if (!(b.pto && b.sick && near(b.pto.balance, expectedPto) && b.sick.balance === 40)) wrong.push({ key, pto: b.pto && b.pto.balance, sick: b.sick && b.sick.balance });
        }
        check(`each of the ten people has ${expectedPto} hours of PTO (${monthEnds} month ends since the start date) and 40 hours of sick leave`, wrong.length === 0, wrong);
        const c0 = await balances(cashier, P.cashier.uid);
        if (!check('the cashier sees their own balances, and when PTO can first be used (90 days after the start date)', c0.s === 200 && c0.pto && c0.pto.usageEligibleOn === addDays(hire, 90) && near(c0.pto.availableBalance, expectedPto), c0.raw.b)) return;
        check('an employee cannot read a co-worker\'s balances (403)', (await call('GET', `${U}/leave/balances/${P.server.uid}`, cashier)).s === 403);
        check('the manager reads the balances of someone on their team', (await balances(manager, P.cashier.uid)).s === 200);
        check('balances need a sign-in (401)', (await call('GET', `${U}/leave/balances`, null)).s === 401);

        // --------------------------------------------------------------------------- a request across a holiday
        ctx.section('Time off across the company holiday, approved by the manager');
        const perDay = c0.pto.availableBalance >= 16 ? 8 : 4;
        const hours = perDay * 2;
        check('PTO in the past is refused (400)', (await call('POST', `${U}/leave/requests`, cashier, { policyId: pto.id, startDate: addDays(today, -7), endDate: addDays(today, -7), hoursPerDay: 8 })).s === 400);
        const tooMuch = await call('POST', `${U}/leave/requests`, cashier, { policyId: pto.id, startDate: tue, endDate: addDays(tue, 13), hoursPerDay: 8 });
        check('asking for more hours than the balance is refused (400)', tooMuch.s === 400 && /not enough balance/.test(tooMuch.text), tooMuch.b);
        const asked = await call('POST', `${U}/leave/requests`, cashier, { policyId: pto.id, startDate: tue, endDate: thu, hoursPerDay: perDay, reason: 'Family visit' });
        const req = asked.b.request || {};
        if (!check(`the cashier asks for ${tue} to ${thu}: the holiday in the middle is skipped, so it is 2 days and ${hours} hours`, asked.s === 201 && JSON.stringify(req.dates) === JSON.stringify([tue, thu]) && req.hours === hours && req.status === 'pending', asked.b)) return;
        const c1 = await balances(cashier, P.cashier.uid);
        check('while it waits, the hours are held: available goes down by the hours asked for', c1.pto.pendingHours === hours && near(c1.pto.availableBalance, c0.pto.availableBalance - hours), c1.pto);
        check('a second request on the same days is refused (400)', (await call('POST', `${U}/leave/requests`, cashier, { policyId: pto.id, startDate: tue, endDate: tue, hoursPerDay: perDay })).s === 400);
        check('an employee cannot approve time off (403)', (await call('PUT', `${U}/leave/requests/${req.id}/decision`, cashier, { decision: 'approve' })).s === 403);
        check('a decision needs a sign-in (401)', (await call('PUT', `${U}/leave/requests/${req.id}/decision`, null, { decision: 'approve' })).s === 401);
        const team = await call('GET', `${U}/leave/requests?scope=team&status=pending`, manager);
        check('the manager sees the request waiting', team.s === 200 && (team.b.data || []).some((r) => r.id === req.id), team.text.slice(0, 300));
        check('a decision that is neither approve nor deny is refused (400)', (await call('PUT', `${U}/leave/requests/${req.id}/decision`, manager, { decision: 'maybe' })).s === 400);
        const approved = await call('PUT', `${U}/leave/requests/${req.id}/decision`, manager, { decision: 'approve', note: 'Enjoy' });
        check('the manager approves it', approved.s === 200 && approved.b.request.status === 'approved', approved.b);
        check('it cannot be decided twice (409)', (await call('PUT', `${U}/leave/requests/${req.id}/decision`, manager, { decision: 'deny' })).s === 409);
        ids.leave.approvedRequest = { id: req.id, userId: P.cashier.uid, person: 'cashier', dates: [tue, thu], hoursPerDay: perDay, hours };
        const c2 = await balances(cashier, P.cashier.uid);
        check('after approval the hours show as scheduled and nothing is waiting', c2.pto.scheduledHours === hours && c2.pto.pendingHours === 0, c2.pto);
        // approved hours must stay held: asking again for more than what is left has to be refused
        const left = r2(c0.pto.availableBalance - hours);
        const twice = await call('POST', `${U}/leave/requests`, cashier, { policyId: pto.id, startDate: addDays(tue, 14), endDate: addDays(tue, 14), hoursPerDay: Math.floor(left) + 1, reason: 'More than is left' });
        if (twice.s === 201) await call('POST', `${U}/leave/requests/${twice.b.request.id}/cancel`, cashier); // not left behind for later stages
        check(`the balance goes down: ${c0.pto.availableBalance} available before, minus ${hours} approved, leaves ${left} to ask for, and asking for ${Math.floor(left) + 1} more is refused`, near(c2.pto.availableBalance, left) && twice.s === 400, { available: c2.pto.availableBalance, expected: left, askingForMore: twice.s === 201 ? 'accepted (201)' : twice.b });
        const calM = await call('GET', `${U}/leave/calendar?from=${tue}&to=${thu}`, manager);
        const onCal = (calM.b.data || []).find((r) => r.id === req.id);
        check('the leave calendar shows the cashier off on those days, as approved', calM.s === 200 && onCal && onCal.status === 'approved' && onCal.startDate === tue && onCal.endDate === thu && onCal.hours === hours, calM.b);
        check('an employee cannot open the leave calendar (403)', (await call('GET', `${U}/leave/calendar`, cashier)).s === 403);
        const mineList = await call('GET', `${U}/leave/requests?scope=mine`, cashier);
        check('the cashier sees it in their own list as approved', (mineList.b.data || []).some((r) => r.id === req.id && r.status === 'approved'), mineList.text.slice(0, 300));

        ctx.section('A request is rejected, one is cancelled, and nobody approves their own');
        const s0 = await balances(server, P.server.uid);
        const sAsk = await call('POST', `${U}/leave/requests`, server, { policyId: pto.id, startDate: nextMon, endDate: nextMon, hoursPerDay: 8, reason: 'Concert' });
        const denied = sAsk.s === 201 ? await call('PUT', `${U}/leave/requests/${sAsk.b.request.id}/decision`, manager, { decision: 'deny', note: 'Two people are already off' }) : { s: 0, b: sAsk.b };
        const s1 = await balances(server, P.server.uid);
        check('the server asks for a day, the manager says no, and the server\'s hours are all available again', denied.s === 200 && denied.b.request.status === 'denied' && near(s1.pto.availableBalance, s0.pto.availableBalance) && s1.pto.pendingHours === 0, { denied: denied.b, after: s1.pto });
        const m0 = await balances(manager, P.manager.uid);
        const mAsk = await call('POST', `${U}/leave/requests`, manager, { policyId: pto.id, startDate: nextTue, endDate: nextTue, hoursPerDay: 8, reason: 'Appointment' });
        if (check('the manager asks for a day off', mAsk.s === 201, mAsk.b)) {
            const own = await call('PUT', `${U}/leave/requests/${mAsk.b.request.id}/decision`, manager, { decision: 'approve' });
            check('the manager cannot approve their own request (403)', own.s === 403, own.b);
            const m1 = await balances(manager, P.manager.uid);
            check('another employee cannot cancel it (403)', (await call('POST', `${U}/leave/requests/${mAsk.b.request.id}/cancel`, cashier)).s === 403);
            const cancelled = await call('POST', `${U}/leave/requests/${mAsk.b.request.id}/cancel`, manager);
            const m2 = await balances(manager, P.manager.uid);
            check('the manager cancels it and the 8 held hours come back', cancelled.s === 200 && near(m1.pto.availableBalance, m0.pto.availableBalance - 8) && near(m2.pto.availableBalance, m0.pto.availableBalance), { before: m0.pto, held: m1.pto, after: m2.pto });
            check('a cancelled request cannot be cancelled again (409)', (await call('POST', `${U}/leave/requests/${mAsk.b.request.id}/cancel`, manager)).s === 409);
        }

        // ---------------------------------------------------------- sick days already taken: the balance itself moves
        ctx.section('Sick days already taken, a cancellation and an adjustment by HR');
        const past = [];
        for (let d = addDays(today, -4); past.length < 4 && d > hire; d = addDays(d, -1)) if (![0, 6].includes(dayOfWeek(d)) && !holidaySet.has(d)) past.push(d);
        const [sickDay1, sickDay2, fmlaDay1, fmlaDay2] = past;
        const b0 = await balances(bianca, extra.uid);
        const sk1 = await call('POST', `${U}/leave/requests`, bianca, { policyId: sick.id, startDate: sickDay1, endDate: sickDay1, hoursPerDay: 8, reason: 'Flu' });
        if (!check(`Bianca reports a sick day she took on ${sickDay1} (sick leave can be entered up to 30 days back)`, sk1.s === 201 && sk1.b.request.hours === 8, sk1.b)) return;
        check('the store manager cannot decide for someone who is not on their team (403)', (await call('PUT', `${U}/leave/requests/${sk1.b.request.id}/decision`, manager, { decision: 'approve' })).s === 403);
        const ok1 = await call('PUT', `${U}/leave/requests/${sk1.b.request.id}/decision`, hr, { decision: 'approve' });
        const b1 = await balances(bianca, extra.uid);
        check(`HR approves it and her sick balance goes from ${b0.sick.balance} to ${b0.sick.balance - 8} hours`, ok1.s === 200 && near(b1.sick.balance, b0.sick.balance - 8) && near(b1.sick.usedThisYear, b0.sick.usedThisYear + 8), { before: b0.sick, after: b1.sick });
        ids.leave.sickRequest = { id: sk1.b.request.id, userId: extra.uid, date: sickDay1, hours: 8 };
        const sk2 = await call('POST', `${U}/leave/requests`, bianca, { policyId: sick.id, startDate: sickDay2, endDate: sickDay2, hoursPerDay: 8, reason: 'Still unwell' });
        const ok2 = sk2.s === 201 ? await call('PUT', `${U}/leave/requests/${sk2.b.request.id}/decision`, hr, { decision: 'approve' }) : { s: 0 };
        const b2 = await balances(bianca, extra.uid);
        check('a second sick day is approved: 8 more hours come off', ok2.s === 200 && near(b2.sick.balance, b0.sick.balance - 16), { sk2: sk2.b, after: b2.sick });
        if (sk2.s === 201) {
            const selfCancel = await call('POST', `${U}/leave/requests/${sk2.b.request.id}/cancel`, bianca);
            check('she cannot cancel time off that has already started herself (409: ask HR)', selfCancel.s === 409, selfCancel.b);
            const hrCancel = await call('POST', `${U}/leave/requests/${sk2.b.request.id}/cancel`, hr);
            const b3 = await balances(bianca, extra.uid);
            check('HR cancels the second day and the 8 hours come back', hrCancel.s === 200 && near(b3.sick.balance, b0.sick.balance - 8), { hrCancel: hrCancel.b, after: b3.sick });
        }
        check('an employee cannot adjust a balance (403)', (await call('POST', `${U}/leave/adjustments`, bianca, { userId: extra.uid, policyId: sick.id, hours: 40, reason: 'more please' })).s === 403);
        check('an adjustment with no reason is refused (400)', (await call('POST', `${U}/leave/adjustments`, hr, { userId: extra.uid, policyId: sick.id, hours: 4 })).s === 400);
        const adj = await call('POST', `${U}/leave/adjustments`, hr, { userId: extra.uid, policyId: sick.id, hours: 4, reason: 'Carried over from the previous employer agreement' });
        const b4 = await balances(bianca, extra.uid);
        check(`HR adds 4 hours with a reason: ${r2(b0.sick.balance - 8)} + 4 = ${r2(b0.sick.balance - 4)} hours`, adj.s === 201 && near(b4.sick.balance, b0.sick.balance - 4), { adj: adj.b, after: b4.sick });
        const lv = await balances(hr, P.leaver.uid);
        check('the leaver\'s balances were not touched by any of this', lv.pto && near(lv.pto.balance, expectedPto) && lv.pto.scheduledHours === 0 && lv.pto.pendingHours === 0 && lv.sick.balance === 40, { pto: lv.pto, sick: lv.sick });

        // --------------------------------------------------------------------------------------- long leave case
        ctx.section('A long leave case (FMLA style)');
        const types = await call('GET', `${U}/leave-cases/types`, bianca);
        check('employees see the kinds of leave they can ask for (family and medical, jury duty, bereavement, and more)', types.s === 200 && ['fmla', 'jury_duty', 'bereavement', 'military', 'parental'].every((k) => (types.b.data || []).some((t) => t.key === k)), types.text.slice(0, 300));
        const elig = await call('GET', `${U}/leave-cases/eligibility/me`, bianca);
        const eChecks = (elig.b.data && elig.b.data.checks) || [];
        check('eligibility: after 75 days in an eleven-person company she is not eligible, and the three reasons are shown (months of service, hours, worksite size)', elig.s === 200 && elig.b.data.eligible === false && eChecks.length === 3 && eChecks.find((c) => c.key === 'service').ok === false && eChecks.find((c) => c.key === 'worksite').ok === false, elig.b);
        check('a family and medical case without a reason category is refused (400)', (await call('POST', `${U}/leave-cases/requests`, bianca, { typeKey: 'fmla', startDate: fmlaDay2 })).s === 400);
        const opened = await call('POST', `${U}/leave-cases/requests`, bianca, { typeKey: 'fmla', pattern: 'continuous', startDate: fmlaDay2, endDate: addDays(today, 20), fmlaReason: 'own_health', reason: 'Surgery and recovery' });
        const kase = opened.b.case || {};
        if (!check('Bianca opens a family and medical leave case; it starts as "requested" with a due date for the eligibility notice', opened.s === 201 && kase.status === 'requested' && kase.eligibility && kase.eligibility.eligible === false && (kase.deadlineList || []).some((d) => d.key === 'eligibilityNotice' && d.due >= today), opened.b)) return;
        ids.leave.fmlaCaseId = kase.id;
        const caseUrl = `${U}/leave-cases/${kase.id}`;
        const act = (action, extraBody = {}) => call('POST', `${caseUrl}/action`, hr, { action, ...extraBody });
        check('an employee cannot list everyone\'s leave cases (403)', (await call('GET', `${U}/leave-cases`, cashier)).s === 403);
        check('an employee cannot act on a case, even their own (403)', (await call('POST', `${caseUrl}/action`, bianca, { action: 'designate', override: true, note: 'approve me' })).s === 403);
        const openList = await call('GET', `${U}/leave-cases?status=open`, hr);
        check('HR sees the case in the open list', openList.s === 200 && (openList.b.data || []).some((c) => c.id === kase.id), openList.text.slice(0, 300));
        const base = await call('GET', caseUrl, hr);
        const usedBefore = (base.b.case && base.b.case.balance && base.b.case.balance.usedHours) || 0;
        check('the case shows the entitlement: 12 weeks at 40 hours is 480 hours', base.s === 200 && base.b.case.balance.entitlementHours === 480, base.b.case && base.b.case.balance);
        check('hours cannot be recorded before the case is decided (409)', (await call('POST', `${caseUrl}/usage`, hr, { date: fmlaDay1, hours: 8 })).s === 409);
        const a1 = await act('eligibility_notice');
        check('HR records the eligibility notice; the designation notice now has a due date', a1.s === 200 && a1.b.case.status === 'eligibility_noticed' && a1.b.case.deadlines.eligibilityNoticeSent === today && Boolean(a1.b.case.deadlines.designationNoticeDue), a1.b);
        const a2 = await act('request_certification');
        check('HR asks for the medical certification: due 15 days later', a2.s === 200 && a2.b.case.status === 'certification_requested' && a2.b.case.deadlines.certificationDue === addDays(today, 15), a2.b);
        const a3 = await act('receive_certification');
        check('HR records that the certification arrived', a3.s === 200 && a3.b.case.status === 'certification_received' && a3.b.case.deadlines.certificationReceived === today, a3.b);
        check('starting the leave before it is designated is refused (409)', (await act('start_leave')).s === 409);
        const a4 = await act('designate');
        check('designating the leave for someone who is not eligible is refused without an override (409)', a4.s === 409, a4.b);
        const recalc = await call('POST', `${caseUrl}/recalculate-eligibility`, hr);
        check('HR recalculates eligibility: still not eligible', recalc.s === 200 && recalc.b.eligibility.eligible === false, recalc.b);
        const a5 = await act('designate', { override: true, note: 'Company policy grants this leave from day one' });
        check('HR designates it with an override and a reason; the job is now marked protected', a5.s === 200 && a5.b.case.status === 'designated' && a5.b.case.jobProtected === true, a5.b);
        const a6 = await act('start_leave', { date: fmlaDay2 });
        check('HR starts the leave', a6.s === 200 && a6.b.case.status === 'on_leave' && a6.b.case.leaveStartedOn === fmlaDay2, a6.b);
        const u1 = await call('POST', `${caseUrl}/usage`, hr, { date: fmlaDay1, hours: 8, kind: 'continuous', note: 'Day in hospital' });
        const u2 = await call('POST', `${caseUrl}/usage`, hr, { startDate: fmlaDay2, endDate: fmlaDay2, hoursPerDay: 8 });
        check('usage is recorded: one day, then a block of one more day, 16 hours in all', u1.s === 201 && u2.s === 201 && u2.b.added === 1 && near(u2.b.balance.usedHours, usedBefore + 16), { u1: u1.b, u2: u2.b });
        check('the same day twice is refused (409)', (await call('POST', `${caseUrl}/usage`, hr, { date: fmlaDay1, hours: 8, kind: 'continuous' })).s === 409);
        const link = await call('POST', `${caseUrl}/link-request`, hr, { requestId: sk1.b.request.id });
        check('her approved sick day is linked to the case and counts as 8 more hours', link.s === 201 && link.b.added === 1 && link.b.hours === 8, link.b);
        check('the same request cannot be linked twice (409)', (await call('POST', `${caseUrl}/link-request`, hr, { requestId: sk1.b.request.id })).s === 409);
        check('another person\'s request cannot be linked to her case (404)', (await call('POST', `${caseUrl}/link-request`, hr, { requestId: req.id })).s === 404);
        const notes = await call('PUT', `${caseUrl}/notes`, hr, { hrNotes: 'Doctor letter is in the vault. HR only.' });
        const full = await call('GET', caseUrl, hr);
        const bal = (full.b.case && full.b.case.balance) || {};
        check(`the case adds up: 24 hours used, ${r2(480 - usedBefore - 24)} of 480 left`, full.s === 200 && near(bal.usedHours, usedBefore + 24) && near(bal.remainingHours, 480 - usedBefore - 24) && (full.b.case.linkedRequestIds || []).includes(sk1.b.request.id), bal);
        const hers = await call('GET', `${U}/leave-cases/mine`, bianca);
        const hersCase = (hers.b.data || []).find((c) => c.id === kase.id);
        check('Bianca sees her case, its status and hours, but not the HR notes', notes.s === 200 && hersCase && hersCase.status === 'on_leave' && near(hersCase.balance.usedHours, usedBefore + 24) && !/Doctor letter/.test(hers.text) && /Doctor letter/.test(full.text), hers.text.slice(0, 300));
        const a7 = await act('return_to_work');
        const a8 = await act('close');
        check('HR records the return to work and closes the case', a7.s === 200 && a7.b.case.status === 'returned' && a8.s === 200 && a8.b.case.status === 'closed', { a7: a7.b, a8: a8.b });
        check('a closed case takes no more hours (409)', (await call('POST', `${caseUrl}/usage`, hr, { date: addDays(fmlaDay2, -7), hours: 8 })).s === 409);

        ctx.section('Bereavement and jury duty');
        const bStart = addDays(wed, 12); // a Monday two weeks after the holiday week
        const ber = await call('POST', `${U}/leave-cases/requests`, cashier, { typeKey: 'bereavement', startDate: bStart, endDate: addDays(bStart, 4), reason: 'Funeral out of state' });
        if (check('the cashier asks for five days of bereavement leave and is told the table lists three (HR will review)', ber.s === 201 && (ber.b.warnings || []).length === 1 && ber.b.case.status === 'requested', ber.b)) {
            const d = await call('POST', `${U}/leave-cases/${ber.b.case.id}/action`, hr, { action: 'designate', note: 'Approved for five days' });
            check('HR approves it; this kind of leave carries no FMLA job-protection flag', d.s === 200 && d.b.case.status === 'designated' && d.b.case.jobProtected === false, d.b);
            check('another employee cannot cancel it (403)', (await call('POST', `${U}/leave-cases/${ber.b.case.id}/cancel`, server)).s === 403);
            const cx = await call('POST', `${U}/leave-cases/${ber.b.case.id}/cancel`, cashier, { note: 'Plans changed' });
            const after = await call('GET', `${U}/leave-cases/mine`, cashier);
            check('the cashier cancels it themselves', cx.s === 200 && (after.b.data || []).some((c) => c.id === ber.b.case.id && c.status === 'cancelled'), { cx: cx.b });
        }
        check('jury duty without an end date is refused (400)', (await call('POST', `${U}/leave-cases`, hr, { userId: P.server.uid, typeKey: 'jury_duty', startDate: bStart })).s === 400);
        check('a manager cannot open a case for someone (403)', (await call('POST', `${U}/leave-cases`, manager, { userId: P.server.uid, typeKey: 'jury_duty', startDate: bStart, endDate: bStart })).s === 403);
        const jury = await call('POST', `${U}/leave-cases`, hr, { userId: P.server.uid, typeKey: 'jury_duty', startDate: bStart, endDate: addDays(bStart, 1), reason: 'Summons received by HR' });
        if (check('HR opens a jury duty case for the server', jury.s === 201 && jury.b.case.status === 'requested', jury.b)) {
            check('denying a case needs a reason (400)', (await call('POST', `${U}/leave-cases/${jury.b.case.id}/action`, hr, { action: 'deny' })).s === 400);
            const dn = await call('POST', `${U}/leave-cases/${jury.b.case.id}/action`, hr, { action: 'deny', note: 'The court cancelled the summons' });
            const sv = await call('GET', `${U}/leave-cases/mine`, server);
            check('HR denies it with a reason and the server sees that', dn.s === 200 && dn.b.case.status === 'denied' && (sv.b.data || []).some((c) => c.id === jury.b.case.id && c.status === 'denied'), dn.b);
        }

        // ------------------------------------------------------------------------------------------- leave report
        ctx.section('Leave report');
        const rep = await call('GET', `${U}/reports/leave`, hr);
        const repRow = (rep.b.detail || []).find((d) => d.userId === P.cashier.uid && d.policy === pto.name);
        check(`the leave report lists the cashier's PTO: ${expectedPto} hours, worth ${r2(expectedPto * P.cashier.payRate)} at 18.50 an hour`, rep.s === 200 && repRow && near(repRow.balanceHours, expectedPto) && near(repRow.estimatedValue, expectedPto * P.cashier.payRate), repRow || rep.text.slice(0, 300));
        const sumDetail = r2((rep.b.detail || []).reduce((t, d) => t + d.balanceHours, 0));
        check('the report total equals the sum of its rows', rep.s === 200 && near(rep.b.totals.hours, sumDetail), { total: rep.b.totals, sumDetail });
        const repCsv = await call('GET', `${U}/reports/leave?format=csv`, hr);
        check('it downloads as a spreadsheet file', repCsv.s === 200 && /Employee ID/.test(repCsv.text) && repCsv.text.includes(pto.name), repCsv.text.slice(0, 200));
        check('an employee cannot open the leave report (403)', (await call('GET', `${U}/reports/leave`, cashier)).s === 403);

        // ------------------------------------------------------------------------ approved leave to the provider
        ctx.section('Approved leave to the payroll provider');
        const gs = await call('GET', `${U}/gusto/status`, payroll);
        if (gs.s === 200 && gs.b.connection && gs.b.connection.connected) {
            const push = await call('POST', `${U}/gusto/sync/time-off`, payroll);
            const mineRow = (push.b.results || []).find((r) => r.requestId === req.id || r.id === req.id);
            check('approved time off is sent to the payroll provider with no errors', push.s === 200 && push.b.errors === 0 && push.b.total >= 1, push.b);
            check('the cashier\'s approved days are among what was sent', mineRow && ['synced', 'unchanged'].includes(mineRow.status), mineRow || push.b);
            check('an employee cannot send time off to the provider (403)', (await call('POST', `${U}/gusto/sync/time-off`, cashier)).s === 403);
        } else {
            check('the payroll connection status can be read', gs.s === 200 && gs.b.connection && gs.b.connection.connected === false, gs.b);
            ctx.skip('approved time off is sent to the payroll provider', 'this company is not connected to the payroll provider here; payroll is connected in stage 04, and this step runs when stage 04 ran first');
        }

        // ------------------------------------------------------------------------------- payout of unused time
        ctx.section('Payout of unused time: settings and a preview (the payout itself is in stage 08)');
        check('an employee cannot read the payout settings (403)', (await call('GET', `${U}/leave/payout-settings`, cashier)).s === 403);
        check('a salary divisor of 500 hours a year is refused (400)', (await call('PUT', `${U}/leave/payout-settings`, hr, { salaryHoursPerYear: 500 })).s === 400);
        check('payroll can read the payout settings but not change them (403)', (await call('GET', `${U}/leave/payout-settings`, payroll)).s === 200 && (await call('PUT', `${U}/leave/payout-settings`, payroll, { salaryHoursPerYear: 2080 })).s === 403);
        const ps = await call('PUT', `${U}/leave/payout-settings`, hr, { salaryHoursPerYear: 2080 });
        check('HR sets the salary divisor to 2,080 hours a year', ps.s === 200 && ps.b.settings.salaryHoursPerYear === 2080, ps.b);
        const pv = await call('GET', `${U}/leave/payouts/preview/${P.leaver.uid}`, payroll);
        const ptoLine = (pv.b.lines || []).find((l) => l.policyId === pto.id); const sickLine = (pv.b.lines || []).find((l) => l.policyId === sick.id);
        check(`preview for the leaver: ${expectedPto} PTO hours at 16.00 an hour is ${r2(expectedPto * 16)}; sick leave is not paid out`, pv.s === 200 && pv.b.canRequest === true && ptoLine && ptoLine.paidOut === true && near(ptoLine.hours, expectedPto) && near(pv.b.amount, expectedPto * 16) && pv.b.hourlyRate === 16 && sickLine && sickLine.paidOut === false && sickLine.hours === 0, pv.b);
        const pvM = await call('GET', `${U}/leave/payouts/preview/${P.manager.uid}`, payroll);
        const salRate = Math.round((P.manager.payRate / 2080) * 10000) / 10000;
        check(`preview for the salaried manager uses salary / 2,080: ${salRate} an hour, ${r2(expectedPto * salRate)} in all`, pvM.s === 200 && near(pvM.b.hourlyRate * 100, salRate * 100) && near(pvM.b.amount, expectedPto * salRate), pvM.b);
        check('an employee cannot preview a payout (403)', (await call('GET', `${U}/leave/payouts/preview/${P.leaver.uid}`, cashier)).s === 403);
        const none = await call('GET', `${U}/leave/payouts?userId=${P.leaver.uid}`, payroll);
        check('a preview does not create a payout: the leaver has none waiting', none.s === 200 && (none.b.data || []).filter((p) => ['pending', 'approved'].includes(p.status)).length === 0, none.b);

        // ============================================================================================== BENEFITS
        ctx.section('Benefits settings');
        check('an employee cannot read or change the benefits settings (403)', (await call('GET', `${U}/benefits/config`, cashier)).s === 403 && (await call('PUT', `${U}/benefits/config`, cashier, { newHireWindowDays: 90 })).s === 403);
        check('a new-hire window of 0 days is refused (400)', (await call('PUT', `${U}/benefits/config`, hr, { newHireWindowDays: 0 })).s === 400);
        const cfg = await call('PUT', `${U}/benefits/config`, hr, {
            newHireWindowDays: 90, aca: { measurementStart: hire, measurementEnd: today, fullTimeHoursPerWeek: 30 }, cobra: { electionDays: 60, firstPaymentDays: 45 },
            limits: [{ key: '401k_employee_deferral', label: '401(k) employee deferral limit (per year)', year: String(year), amount: 20000, note: 'Entered by HR for the test run; confirm with the IRS notice' }]
        });
        const cfgBack = await call('GET', `${U}/benefits/config`, hr);
        check('HR saves the settings: 90-day new-hire window, the ACA measurement period, COBRA day counts and the 401(k) limit', cfg.s === 200 && cfgBack.b.data.newHireWindowDays === 90 && cfgBack.b.data.aca.measurementStart === hire && cfgBack.b.data.cobra.electionDays === 60 && cfgBack.b.data.limits[0].amount === 20000, cfgBack.b);

        ctx.section('Plans: medical, dental and 401(k)');
        const elig30 = { waitingDays: 30, employmentTypes: ['full_time'] };
        const planBodies = {
            medical: { name: `Medical PPO ${stamp}`, type: 'medical', carrier: 'Lone Star Health', planYear: String(year), payPeriodsPerYear: 26, eligibility: elig30, costs: { employee_only: { employee: 60, employer: 240 }, employee_spouse: { employee: 130, employer: 400 }, employee_children: { employee: 110, employer: 380 }, family: { employee: 190, employer: 560 } } },
            dental: { name: `Dental ${stamp}`, type: 'dental', carrier: 'Bluebonnet Dental', planYear: String(year), payPeriodsPerYear: 26, eligibility: elig30, costs: { employee_only: { employee: 8, employer: 12 }, employee_spouse: { employee: 15, employer: 20 }, employee_children: { employee: 18, employer: 22 }, family: { employee: 25, employer: 30 } } },
            k401: { name: `401(k) ${stamp}`, type: '401k', carrier: 'Hill Country Retirement', planYear: String(year), eligibility: { waitingDays: 0 }, maxPercent: 50, allowRoth: true, match: { tiers: [{ upToPercent: 3, rate: 100 }, { upToPercent: 5, rate: 50 }] } }
        };
        check('an employee cannot create a plan (403)', (await call('POST', `${U}/benefits/plans`, cashier, planBodies.medical)).s === 403);
        check('the auditor can read plans but not create one (403)', (await call('GET', `${U}/benefits/plans?all=true`, auditor)).s === 200 && (await call('POST', `${U}/benefits/plans`, auditor, planBodies.medical)).s === 403);
        check('a medical plan with no costs is refused (400)', (await call('POST', `${U}/benefits/plans`, hr, { ...planBodies.medical, costs: {} })).s === 400);
        const plans = {};
        for (const [key, body] of Object.entries(planBodies)) {
            const r = await call('POST', `${U}/benefits/plans`, hr, body);
            if (check(`HR creates the ${body.type} plan`, r.s === 201 && r.b.plan && r.b.plan.id, r.b)) plans[key] = r.b.plan;
        }
        if (!plans.medical || !plans.dental || !plans.k401) return;
        ids.benefits.plans = { medical: plans.medical.id, dental: plans.dental.id, k401: plans.k401.id };
        ids.benefits.planNames = { medical: plans.medical.name, dental: plans.dental.name, k401: plans.k401.name };
        const upd = await call('PUT', `${U}/benefits/plans/${plans.dental.id}`, hr, { notes: 'Two cleanings a year' });
        check('HR edits the dental plan note and the costs stay', upd.s === 200 && upd.b.plan.notes === 'Two cleanings a year' && upd.b.plan.costs.family.employee === 25, upd.b);

        ctx.section('An eligible employee enrolls, with a child');
        const me0 = await call('GET', `${U}/benefits/me`, cashier);
        const eligOf = (r, id) => (r.b.eligibility || []).find((e) => e.planId === id) || {};
        const newHire = (me0.b.windows || []).find((w) => w.type === 'new_hire');
        if (!check('the cashier sees the three plans, is eligible for each, and has a new-hire enrollment window open', me0.s === 200 && Object.values(plans).every((p) => (me0.b.plans || []).some((x) => x.id === p.id) && eligOf(me0, p.id).eligible === true) && newHire, { windows: me0.b.windows, eligibility: me0.b.eligibility })) return;
        const st = await call('GET', `${U}/benefits/me`, stocker);
        check('the part-time stock clerk is told the medical plan is for full-time staff', st.s === 200 && eligOf(st, plans.medical.id).eligible === false && /part_time/.test(JSON.stringify(eligOf(st, plans.medical.id).reasons)), eligOf(st, plans.medical.id));
        const stTry = await call('POST', `${U}/benefits/me/enroll`, stocker, { windowType: 'new_hire', elections: [{ planId: plans.medical.id, tier: 'employee_only' }] });
        check('and cannot enroll in it (400)', stTry.s === 400, stTry.b);
        const child = { firstName: 'Mateo', lastName: 'Diaz', relationship: 'child', dateOfBirth: '2020-05-05' };
        const noKid = await call('POST', `${U}/benefits/me/enroll`, cashier, { windowType: 'new_hire', elections: [{ planId: plans.medical.id, tier: 'employee_children', dependents: [] }] });
        check('the "employee and children" tier with no child listed is refused (400)', noKid.s === 400, noKid.b);
        check('enrolling in a window that is not open is refused (409)', (await call('POST', `${U}/benefits/me/enroll`, cashier, { windowType: 'open_enrollment', elections: [{ planId: plans.medical.id, tier: 'employee_only' }] })).s === 409);
        check('a 401(k) percent above the plan maximum is refused (400)', (await call('POST', `${U}/benefits/me/enroll`, cashier, { windowType: 'new_hire', elections: [{ planId: plans.k401.id, deferralPercent: 60 }] })).s === 400);
        const enroll = await call('POST', `${U}/benefits/me/enroll`, cashier, { windowType: 'new_hire', elections: [
            { planId: plans.medical.id, tier: 'employee_children', dependents: [{ ...child, ssn: '123-45-6789' }] }, // made-up number
            { planId: plans.dental.id, tier: 'employee_children', dependents: [child] },
            { planId: plans.k401.id, deferralPercent: 4, contributionType: 'pre_tax' }] });
        const cEnr = enroll.b.enrollment || {};
        const medEl = (cEnr.elections || []).find((e) => e.planId === plans.medical.id) || {};
        if (!check('the cashier enrolls in medical and dental with a child, and 4% to the 401(k)', enroll.s === 201 && cEnr.status === 'active' && cEnr.windowType === 'new_hire' && (cEnr.elections || []).filter((e) => Object.values(ids.benefits.plans).includes(e.planId)).length === 3, enroll.b)) return;
        check('the child\'s SSN comes back masked, never in full', (medEl.dependents || [])[0] && medEl.dependents[0].ssnMasked === '***-**-6789' && !/123-?45-?6789/.test(enroll.text), medEl.dependents);
        // weekly pay: plan costs are quoted for 26 pay periods, so each is halved; 401(k) is a percent of 40 hours at the pay rate
        const cGross = P.cashier.payRate * 40;
        const cExp = { medical: 55, dental: 9, k401: r2(cGross * 0.04), employer: r2(190 + 11 + cGross * 0.035) };
        const me1 = await call('GET', `${U}/benefits/me`, cashier);
        const myLines = ((me1.b.perPayPeriod || {}).lines || []).filter((l) => Object.values(ids.benefits.plans).includes(l.planId));
        const lineOf = (id) => myLines.find((l) => l.planId === id) || {};
        check(`the cashier sees what comes out of each weekly paycheck: medical 55.00 + dental 9.00 + 401(k) ${cExp.k401.toFixed(2)} = ${r2(55 + 9 + cExp.k401).toFixed(2)}`, me1.s === 200 && near(lineOf(plans.medical.id).employeeAmount, 55) && near(lineOf(plans.dental.id).employeeAmount, 9) && near(lineOf(plans.k401.id).employeeAmount, cExp.k401) && near(myLines.reduce((t, l) => t + l.employeeAmount, 0), 55 + 9 + cExp.k401), me1.b.perPayPeriod);
        check(`and what the company adds: 190.00 + 11.00 + a 3.5% match of ${r2(cGross * 0.035).toFixed(2)} = ${cExp.employer.toFixed(2)}`, near(myLines.reduce((t, l) => t + l.employerAmount, 0), cExp.employer), myLines);

        ctx.section('HR enrolls another employee');
        check('an employee cannot enroll someone else (403)', (await call('POST', `${U}/benefits/enrollments`, cashier, { userId: P.server.uid, effectiveDate: today, reason: 'please', elections: [{ planId: plans.medical.id, tier: 'employee_only' }] })).s === 403);
        check('HR must give a reason when enrolling someone outside a window (400)', (await call('POST', `${U}/benefits/enrollments`, hr, { userId: P.server.uid, effectiveDate: today, elections: [{ planId: plans.medical.id, tier: 'employee_only' }] })).s === 400);
        const hrEnr = await call('POST', `${U}/benefits/enrollments`, hr, { userId: P.server.uid, effectiveDate: today, reason: 'Paper form handed in at the cafe', elections: [{ planId: plans.medical.id, tier: 'employee_only' }, { planId: plans.k401.id, deferralPercent: 3 }] });
        if (!check('HR enrolls the server in medical (employee only) and 3% to the 401(k)', hrEnr.s === 201 && hrEnr.b.enrollment.windowType === 'hr_entered' && hrEnr.b.enrollment.status === 'active', hrEnr.b)) return;

        ctx.section('A life event, with proof, and HR\'s decision');
        const lifeEvent = async (token, fields, withProof) => {
            const form = new FormData();
            for (const [k, v] of Object.entries(fields)) form.append(k, v);
            if (withProof) form.append('proof', new Blob([Buffer.from('%PDF-1.4\n% made-up certificate for the end-to-end run\n%%EOF\n')], { type: 'application/pdf' }), 'marriage-certificate.pdf');
            const res = await fetch(`${ctx.APP}${U}/benefits/me/life-events`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
            const text = await res.text(); let b = {}; try { b = JSON.parse(text); } catch (_) { /* not JSON */ }
            return { s: res.status, b, text };
        };
        const eventDate = addDays(today, -5);
        check('a life event from four months ago is refused: its window has ended (400)', (await call('POST', `${U}/benefits/me/life-events`, server, { typeKey: 'marriage', eventDate: addDays(today, -120) })).s === 400);
        const reloc = await call('POST', `${U}/benefits/me/life-events`, server, { typeKey: 'relocation', eventDate, note: 'Moved across town' });
        const married = await lifeEvent(server, { typeKey: 'marriage', eventDate, note: 'Married last week' }, true);
        if (!check('the server reports a marriage and attaches the certificate', married.s === 201 && married.b.event.status === 'pending' && married.b.event.proof && married.b.event.proof.fileName === 'marriage-certificate.pdf', married.b)) return;
        const pend = await call('GET', `${U}/benefits/events?status=pending`, hr);
        check('HR sees both of the server\'s events waiting', pend.s === 200 && [married.b.event.id, reloc.b.event && reloc.b.event.id].every((id) => (pend.b.data || []).some((e) => e.id === id)), pend.text.slice(0, 300));
        check('an employee cannot see the list of life events or decide one (403)', (await call('GET', `${U}/benefits/events`, cashier)).s === 403 && (await call('POST', `${U}/benefits/events/${married.b.event.id}/decision`, server, { decision: 'approve' })).s === 403);
        const proof = await call('GET', `${U}/benefits/events/${married.b.event.id}/proof`, hr);
        check('HR opens the proof; a co-worker cannot (403)', proof.s === 200 && proof.text.startsWith('%PDF') && (await call('GET', `${U}/benefits/events/${married.b.event.id}/proof`, cashier)).s === 403, proof.text.slice(0, 80));
        if (reloc.s === 201) {
            const noProof = await call('POST', `${U}/benefits/events/${reloc.b.event.id}/decision`, hr, { decision: 'approve' });
            check('the move has no proof, so approving it is refused (409)', noProof.s === 409, noProof.b);
            check('rejecting needs a reason (400)', (await call('POST', `${U}/benefits/events/${reloc.b.event.id}/decision`, hr, { decision: 'reject' })).s === 400);
            const rej = await call('POST', `${U}/benefits/events/${reloc.b.event.id}/decision`, hr, { decision: 'reject', note: 'Same plans are offered at the new address' });
            check('HR rejects it with a reason', rej.s === 200 && rej.b.status === 'rejected', rej.b);
        } else check('the server reports a move without proof', false, reloc.b);
        const appr = await call('POST', `${U}/benefits/events/${married.b.event.id}/decision`, hr, { decision: 'approve', note: 'Certificate checked' });
        check('HR approves the marriage', appr.s === 200 && appr.b.status === 'approved', appr.b);
        check('it cannot be decided twice (409)', (await call('POST', `${U}/benefits/events/${married.b.event.id}/decision`, hr, { decision: 'reject', note: 'changed my mind' })).s === 409);
        const sMe = await call('GET', `${U}/benefits/me`, server);
        const lifeWindow = (sMe.b.windows || []).find((w) => w.type === 'life_event' && w.eventId === married.b.event.id);
        check('the approval opens a 30-day window for the server; the rejected move opens none', lifeWindow && lifeWindow.end === addDays(eventDate, 30) && !(sMe.b.windows || []).some((w) => reloc.b.event && w.eventId === reloc.b.event.id), sMe.b.windows);
        const spouse = { firstName: 'Daniel', lastName: 'Nguyen', relationship: 'spouse', dateOfBirth: '1998-03-09', ssn: '234-56-7890' }; // made-up person
        const change = await call('POST', `${U}/benefits/me/enroll`, server, { windowType: 'life_event', eventId: married.b.event.id, elections: [{ planId: plans.medical.id, tier: 'employee_spouse', dependents: [spouse] }] });
        const sEnr = change.b.enrollment || {};
        const sMed = (sEnr.elections || []).find((e) => e.planId === plans.medical.id) || {};
        const sK = (sEnr.elections || []).find((e) => e.planId === plans.k401.id) || {};
        check('the server adds the spouse to medical; the 401(k) choice carries over unchanged', change.s === 201 && sMed.tier === 'employee_spouse' && (sMed.dependents || []).length === 1 && sK.deferralPercent === 3 && sEnr.effectiveDate === eventDate, change.b);
        const sHist = await call('GET', `${U}/benefits/enrollments?userId=${P.server.uid}`, hr);
        check('the earlier enrollment is ended, so only one is active', sHist.s === 200 && (sHist.b.data || []).filter((e) => e.status === 'active').length === 1 && (sHist.b.data || []).some((e) => e.id === hrEnr.b.enrollment.id && e.status === 'terminated'), (sHist.b.data || []).map((e) => `${e.id}:${e.status}`));

        ctx.section('HR enrolls Bianca with a family');
        const fam = [{ firstName: 'Marco', lastName: 'Flores', relationship: 'spouse', dateOfBirth: '1990-10-01', ssn: '345-67-8901' }, { firstName: 'Ines', lastName: 'Flores', relationship: 'child', dateOfBirth: '2018-01-20' }]; // made-up people
        const bEnr = await call('POST', `${U}/benefits/enrollments`, hr, { userId: extra.uid, effectiveDate: addDays(today, -10), reason: 'Enrolled at orientation, entered late', elections: [{ planId: plans.medical.id, tier: 'family', dependents: fam }] });
        if (!check('HR enrolls Bianca in family medical, effective ten days ago', bEnr.s === 201 && bEnr.b.enrollment.status === 'active', bEnr.b)) return;
        const bEnrId = bEnr.b.enrollment.id;
        const bSpouse = bEnr.b.enrollment.elections.find((e) => e.planId === plans.medical.id).dependents.find((d) => d.relationship === 'spouse');
        ids.benefits.enrolled = { cashier: { enrollmentId: cEnr.id, userId: P.cashier.uid }, server: { enrollmentId: sEnr.id, userId: P.server.uid } };

        ctx.section('Payroll deduction feed and summary');
        const sGross = P.server.payRate * 40;
        const expected = {
            [P.cashier.uid]: { medical: 55, dental: 9, '401k': cExp.k401 },
            [P.server.uid]: { medical: 65, '401k': r2(sGross * 0.03) },
            [extra.uid]: { medical: 95 }
        };
        const expectedTotal = r2(Object.values(expected).reduce((t, p) => t + Object.values(p).reduce((a, b) => a + b, 0), 0));
        ids.benefits.expectedWeeklyDeductions = { cashier: expected[P.cashier.uid], server: expected[P.server.uid], total: r2(expectedTotal - 95) };
        const feed = await call('GET', `${U}/benefits/payroll-feed?periodEnd=${today}`, payroll);
        const myNames = Object.values(ids.benefits.planNames);
        const rows = (feed.b.rows || []).filter((r) => myNames.includes(r.planName));
        const badRows = [];
        for (const [uid, byType] of Object.entries(expected)) for (const [type, amount] of Object.entries(byType)) {
            const row = rows.find((r) => r.userId === uid && r.planType === type);
            if (!row || !near(row.employeeDeduction, amount) || row.payFrequency !== 'weekly') badRows.push({ uid, type, amount, got: row && row.employeeDeduction });
        }
        check('payroll reads the deduction feed: six lines, each with the right weekly amount (cashier 55.00, 9.00 and 4%; server 65.00 and 3%; Bianca 95.00)', feed.s === 200 && rows.length === 6 && badRows.length === 0, badRows.length ? badRows : feed.b);
        check(`the lines add up to ${expectedTotal.toFixed(2)} a week`, near(rows.reduce((t, r) => t + r.employeeDeduction, 0), expectedTotal), rows.map((r) => `${r.name} ${r.planType} ${r.employeeDeduction}`));
        check('the feed\'s own totals equal the sum of its lines (employee and employer)', feed.s === 200 && near(feed.b.totals.employeeDeduction, (feed.b.rows || []).reduce((t, r) => t + r.employeeDeduction, 0)) && near(feed.b.totals.employerCost, (feed.b.rows || []).reduce((t, r) => t + r.employerCost, 0)) && (feed.b.errors || []).length === 0, feed.b.totals);
        const sMatch = rows.find((r) => r.userId === P.server.uid && r.planType === '401k') || {};
        check(`the company match on the server's 3% is 3% of ${sGross.toFixed(2)}: ${r2(sGross * 0.03).toFixed(2)}`, near(sMatch.employerCost, sGross * 0.03), sMatch);
        const feedCsv = await call('GET', `${U}/benefits/payroll-feed?periodEnd=${today}&format=csv`, payroll);
        check('the feed downloads as a file with one line per deduction', feedCsv.s === 200 && feedCsv.text.startsWith('employeeId,') && feedCsv.text.includes(plans.medical.name) && !/123-?45-?6789|234-?56-?7890/.test(feedCsv.text), feedCsv.text.slice(0, 200));
        check('an employee cannot read the deduction feed (403), and it needs a sign-in (401)', (await call('GET', `${U}/benefits/payroll-feed`, cashier)).s === 403 && (await call('GET', `${U}/benefits/payroll-feed`, null)).s === 401);
        const summary = await call('GET', `${U}/benefits/summary`, hr);
        const sumRow = (id) => (summary.b.data || []).find((r) => r.planId === id) || {};
        check('the summary counts three people in medical (215.00 a week from employees), one in dental and two in the 401(k)', summary.s === 200 && sumRow(plans.medical.id).enrolled === 3 && near(sumRow(plans.medical.id).employeePerPeriodTotal, 215) && sumRow(plans.dental.id).enrolled === 1 && sumRow(plans.k401.id).enrolled === 2 && near(sumRow(plans.k401.id).employeePerPeriodTotal, cExp.k401 + sGross * 0.03), summary.b.data);
        check('an employee cannot open the summary (403)', (await call('GET', `${U}/benefits/summary`, cashier)).s === 403);

        ctx.section('A dependent\'s SSN is shown only with a reason');
        const revealUrl = `${U}/benefits/enrollments/${bEnrId}/dependents/${bSpouse.id}/ssn/reveal`;
        const viewEnr = await call('GET', `${U}/benefits/enrollments/${bEnrId}`, hr);
        check('HR opens the enrollment: the spouse\'s SSN is masked', viewEnr.s === 200 && /\*\*\*-\*\*-8901/.test(viewEnr.text) && !/345-?67-?8901/.test(viewEnr.text), viewEnr.text.slice(0, 300));
        check('showing it without a reason is refused (400)', (await call('POST', revealUrl, hr, {})).s === 400);
        check('payroll and employees cannot show it (403)', (await call('POST', revealUrl, payroll, { reason: 'curious about it' })).s === 403 && (await call('POST', revealUrl, bianca, { reason: 'it is my spouse' })).s === 403);
        const shown = await call('POST', revealUrl, hr, { reason: 'Carrier asked to confirm the number' });
        check('HR shows it with a reason', shown.s === 200 && shown.b.ssn === '345-67-8901', shown.s);

        ctx.section('ACA: offers of coverage and the summary');
        check('an offer without a start date is refused (400)', (await call('POST', `${U}/benefits/aca/offers`, hr, { userId: P.cashier.uid, offered: true })).s === 400);
        check('an employee cannot record an offer (403)', (await call('POST', `${U}/benefits/aca/offers`, cashier, { userId: P.cashier.uid, fromDate: addDays(hire, 30) })).s === 403);
        const offer = await call('POST', `${U}/benefits/aca/offers`, hr, { userId: P.cashier.uid, fromDate: addDays(hire, 30), offered: true, offerCode: '1e', safeHarborCode: '2c', employeeShareMonthly: 130, coversDependents: true });
        check('HR records that the cashier was offered coverage (codes 1E and 2C, 130.00 a month)', offer.s === 201 && offer.b.offer.offerCode === '1E' && offer.b.offer.safeHarborCode === '2C' && offer.b.offer.employeeShareMonthly === 130, offer.b);
        const mistake = await call('POST', `${U}/benefits/aca/offers`, hr, { userId: P.stocker.uid, fromDate: today, offered: true, offerCode: '1A' });
        const undo = mistake.s === 201 ? await call('DELETE', `${U}/benefits/aca/offers/${mistake.b.offer.id}`, hr) : { s: 0 };
        const stOffers = await call('GET', `${U}/benefits/aca/offers?userId=${P.stocker.uid}`, hr);
        check('an offer entered by mistake for the stock clerk is removed', undo.s === 200 && !(stOffers.b.data || []).some((o) => mistake.b.offer && o.id === mistake.b.offer.id), { mistake: mistake.b, undo: undo.s });
        const aca = await call('GET', `${U}/benefits/aca/summary`, hr);
        const acaRow = (uid) => (aca.b.data || []).find((d) => d.userId === uid) || {};
        check('the ACA summary uses the measurement period and shows the cashier as offered, the stock clerk as not', aca.s === 200 && aca.b.measurement.start === hire && aca.b.measurement.end === today && acaRow(P.cashier.uid).offered === true && acaRow(P.cashier.uid).offerRecords >= 1 && acaRow(P.stocker.uid).offered === false, { measurement: aca.b.measurement, cashier: acaRow(P.cashier.uid), stocker: acaRow(P.stocker.uid) });
        check('its count of full-time people with no offer matches its own rows', aca.s === 200 && aca.b.fullTimeNotOffered === (aca.b.data || []).filter((d) => d.fullTime && !d.offered).length, aca.b.fullTimeNotOffered);
        const c1095 = await call('GET', `${U}/benefits/aca/1095c?year=${year}`, hr);
        const month = Number(today.slice(5, 7));
        const cMonth = (c1095.b.data || []).find((r) => r.employeeId === P.cashier.employeeId && r.month === month) || {};
        check('the month-by-month ACA export has 12 rows a person; this month the cashier is offered (1E, 130.00, 2C) and enrolled', c1095.s === 200 && c1095.b.count % 12 === 0 && (c1095.b.data || []).filter((r) => r.employeeId === P.cashier.employeeId).length === 12 && cMonth.offered === 'Y' && cMonth.line14 === '1E' && cMonth.line15 === 130 && cMonth.line16 === '2C' && cMonth.enrolled === 'Y', cMonth);
        check('an employee cannot open the ACA pages (403)', (await call('GET', `${U}/benefits/aca/summary`, cashier)).s === 403 && (await call('GET', `${U}/benefits/aca/1095c`, cashier)).s === 403);

        ctx.section('COBRA: a qualifying event for a former spouse, walked to the end');
        const evDate = addDays(today, -3);
        const cobraAt = (rec, action, body = {}) => call('POST', `${U}/benefits/cobra/${rec}/action`, hr, { action, ...body });
        check('an employee cannot record a COBRA event (403)', (await call('POST', `${U}/benefits/cobra`, cashier, { userId: extra.uid, eventType: 'divorce', eventDate: evDate })).s === 403);
        check('an unknown kind of event is refused (400)', (await call('POST', `${U}/benefits/cobra`, hr, { userId: extra.uid, eventType: 'lottery', eventDate: evDate })).s === 400);
        const noCover = await call('POST', `${U}/benefits/cobra`, hr, { userId: P.stocker.uid, eventType: 'hours_reduction', eventDate: evDate });
        check('COBRA is refused for someone with no health coverage (409)', noCover.s === 409, noCover.b);
        const cobra = await call('POST', `${U}/benefits/cobra`, hr, { userId: extra.uid, eventType: 'divorce', eventDate: evDate });
        const rec = cobra.b.record || {};
        if (check('HR records a divorce for Bianca: her former spouse loses coverage; the notice is due 30 days after the event', cobra.s === 201 && rec.status === 'pending_notice' && rec.deadlines.employerNoticeDue === addDays(evDate, 30) && rec.deadlines.electionNoticeDue === addDays(evDate, 44), cobra.b)) {
            ids.benefits.cobraRecordId = rec.id;
            check('the same event twice is refused (409)', (await call('POST', `${U}/benefits/cobra`, hr, { userId: extra.uid, eventType: 'divorce', eventDate: evDate })).s === 409);
            const hersCobra = await call('GET', `${U}/benefits/me`, bianca);
            check('Bianca sees the COBRA record and its deadlines on her own benefits page', (hersCobra.b.cobra || []).some((c) => c.id === rec.id && c.deadlines.electionDeadline), hersCobra.b.cobra);
            check('an election cannot be recorded before the election notice is sent (409)', (await cobraAt(rec.id, 'record_election')).s === 409);
            const n1 = await cobraAt(rec.id, 'notice_to_administrator', { date: addDays(evDate, 1) });
            check('HR records the notice to the plan administrator', n1.s === 200 && n1.b.record.employerNoticeSentOn === addDays(evDate, 1) && n1.b.record.status === 'pending_notice', n1.b);
            const n2 = await cobraAt(rec.id, 'send_election_notice', { date: addDays(evDate, 2) });
            check('the election notice goes out; the 60 days to choose run from that date', n2.s === 200 && n2.b.record.status === 'notice_sent' && n2.b.record.deadlines.electionDeadline === addDays(evDate, 62), n2.b);
            const n3 = await cobraAt(rec.id, 'record_election', { date: today });
            check('the former spouse elects coverage; the first payment is due 45 days later', n3.s === 200 && n3.b.record.status === 'elected' && n3.b.record.deadlines.firstPaymentDue === addDays(today, 45), n3.b);
            const n4 = await cobraAt(rec.id, 'record_payment', { date: today });
            check('the first payment is recorded', n4.s === 200 && n4.b.record.status === 'paid' && n4.b.record.firstPaymentOn === today, n4.b);
            check('ending COBRA needs a reason (400)', (await cobraAt(rec.id, 'terminate')).s === 400);
            const n5 = await cobraAt(rec.id, 'terminate', { note: 'Covered by a new employer plan' });
            const cList = await call('GET', `${U}/benefits/cobra`, hr);
            const listedRec = (cList.b.data || []).find((c) => c.id === rec.id) || {};
            check('HR ends COBRA with a reason; the list shows every step that was taken', n5.s === 200 && listedRec.status === 'terminated' && (listedRec.history || []).length === 6 && listedRec.alerts.length === 0, listedRec);
        }
        check('an employee cannot open the COBRA list (403)', (await call('GET', `${U}/benefits/cobra`, cashier)).s === 403);

        ctx.section('Ending an enrollment');
        check('an end date before the coverage started is refused (400)', (await call('POST', `${U}/benefits/enrollments/${bEnrId}/terminate`, hr, { endDate: addDays(today, -30), reason: 'Left the plan' })).s === 400);
        check('an employee cannot end an enrollment (403)', (await call('POST', `${U}/benefits/enrollments/${bEnrId}/terminate`, bianca, { endDate: today, reason: 'Left the plan' })).s === 403);
        const ended = await call('POST', `${U}/benefits/enrollments/${bEnrId}/terminate`, hr, { endDate: today, reason: 'Moved to the spouse\'s plan' });
        check('HR ends Bianca\'s medical coverage today', ended.s === 200, ended.b);
        check('it cannot be ended twice (409)', (await call('POST', `${U}/benefits/enrollments/${bEnrId}/terminate`, hr, { endDate: today, reason: 'again' })).s === 409);
        const feedToday = await call('GET', `${U}/benefits/payroll-feed?periodEnd=${today}`, payroll);
        const feedNext = await call('GET', `${U}/benefits/payroll-feed?periodEnd=${addDays(today, 7)}`, payroll);
        const mineIn = (f) => (f.b.rows || []).filter((r) => myNames.includes(r.planName));
        check(`her 95.00 is still deducted for the period ending today and gone a week later: ${expectedTotal.toFixed(2)} becomes ${r2(expectedTotal - 95).toFixed(2)}`, mineIn(feedToday).some((r) => r.userId === extra.uid) && !mineIn(feedNext).some((r) => r.userId === extra.uid) && near(mineIn(feedNext).reduce((t, r) => t + r.employeeDeduction, 0), expectedTotal - 95), mineIn(feedNext).map((r) => `${r.name} ${r.planType} ${r.employeeDeduction}`));
        const auditorList = await call('GET', `${U}/benefits/enrollments?status=active`, auditor);
        check('the auditor can read the enrollments (the cashier and the server are active) but cannot end one (403)', auditorList.s === 200 && [cEnr.id, sEnr.id].every((id) => (auditorList.b.data || []).some((e) => e.id === id)) && (await call('POST', `${U}/benefits/enrollments/${cEnr.id}/terminate`, auditor, { endDate: today, reason: 'no' })).s === 403, auditorList.text.slice(0, 200));
        check('benefits need a sign-in (401)', (await call('GET', `${U}/benefits/me`, null)).s === 401);
    }
};
