/**
 * Stage 04: payroll on the MOCK payroll provider, for the company and the approved hours of stage 03.
 *
 * Connect, every setup step, people sent, a weekly pay schedule whose pay period is last week, then the chain:
 * approved hours -> hours feed -> prepare -> preview -> submit (typed confirmation) -> register -> pay stubs.
 * After that: an off-cycle bonus, a contractor (W-9, sent, paid, 1099 ledger, annual summary), a garnishment,
 * benefit deductions, W-2 and 1099 lists, reconciliation and a past-payroll import (check, save, undo).
 *
 * Nothing is written to the database directly. The mock provider's own test controls (/__mock/...) are used for
 * the two bank test deposits and for last year's tax forms. Safe to run again on the same company.
 */
const MOCK = (process.env.MOCK_URL || 'http://127.0.0.1:4010').replace(/\/+$/, '');
const round2 = (n) => Math.round(n * 100) / 100;
const near = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) <= tol;
const SALARIED = ['hr', 'payroll', 'manager', 'accountant', 'auditor', 'executive'];
const HOURLY = ['cashier', 'server', 'stocker', 'leaver'];
const DEPARTMENT = { hr: 'Office', payroll: 'Office', accountant: 'Office', auditor: 'Office', executive: 'Office', manager: 'Store', cashier: 'Store', stocker: 'Store', server: 'Cafe', leaver: 'Cafe' };

async function mock(method, path, body) {
    try {
        const res = await fetch(MOCK + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        return await res.json();
    } catch (e) { return null; }
}

module.exports = {
    id: '04',
    title: 'Payroll on the mock provider',
    covers: ['US-B10', 'US-D09', 'US-E06', 'US-F01', 'US-F02', 'US-F03', 'US-F04', 'US-F05', 'US-F06', 'US-F07', 'US-F08', 'US-F09', 'US-F10', 'US-F11', 'US-F13', 'US-G03', 'US-J06'],
    async run(ctx) {
        const { call, check, U, state } = ctx;
        const G = `${U}/gusto`;
        const P = state.people;
        const time = state.ids.time;
        if (!check('[needed] stage 03 left last week\'s approved hours for this company', Boolean(time && time.expected && time.lastWeekStart), 'run stage 03 first (ctx.state.ids.time is missing)')) return;
        const { lastWeekStart, lastWeekEnd, today } = time;
        const stamp = String(Date.now()).slice(-6);
        const owner = await ctx.as('owner');
        const hr = await ctx.as('hr');
        const payroll = await ctx.as('payroll');
        const manager = await ctx.as('manager');
        const accountant = await ctx.as('accountant');
        const auditor = await ctx.as('auditor');
        const cashier = await ctx.as('cashier');
        const server = await ctx.as('server');
        const stocker = await ctx.as('stocker');

        // what each person should be paid for last week, worked out here from the hours of stage 03
        const want = {};
        for (const k of HOURLY) {
            const e = time.expected[k];
            // holiday hours are paid at the normal rate; overtime at one and a half times
            want[k] = { regular: e.regularHours, overtime: e.overtimeHours, holiday: e.holidayHours, gross: round2((e.regularHours + e.holidayHours) * e.payRate + e.overtimeHours * e.payRate * 1.5), hours: round2(e.regularHours + e.holidayHours + e.overtimeHours) };
        }
        for (const k of SALARIED) want[k] = { gross: round2(P[k].payRate / 52), hours: 0 };
        const everyone = [...SALARIED, ...HOURLY];
        const wantGross = round2(everyone.reduce((s, k) => s + want[k].gross, 0));
        const keyOf = (userId) => everyone.find((k) => P[k].uid === userId);

        // ------------------------------------------------------------------------------------------ mock mode
        ctx.section('The server is on the mock payroll provider');
        check('no token is refused (401)', (await call('GET', `${G}/status`, null)).s === 401);
        check('an employee cannot open payroll (403)', (await call('GET', `${G}/status`, cashier)).s === 403);
        check('a manager cannot open payroll (403)', (await call('GET', `${G}/status`, manager)).s === 403);
        let status = await call('GET', `${G}/status`, payroll);
        if (!check('[needed] payroll status reads and the server is in mock mode (nothing here can reach a real payroll provider)', status.s === 200 && status.b.mode === 'mock' && status.b.configured === true, status.s === 200 ? `mode is "${status.b.mode}", configured ${status.b.configured}: this stage only runs on the mock provider. Start the app with GUSTO_MODE=mock.` : status.text.slice(0, 300))) return;
        check('the payroll admin may run payroll but not connect the company', status.b.can.run === true && status.b.can.connect === false, status.b.can);
        const mockUp = await mock('GET', '/__mock/deposits');
        if (!check('[needed] the mock provider answers on its own address', Boolean(mockUp && mockUp.deposit_1), `no answer from ${MOCK}/__mock/deposits (node scripts/mock-gusto.js)`)) return;

        // ----------------------------------------------------------------------------------------- connection
        ctx.section('The owner connects the company');
        let conn = status.b.connection || {};
        if (conn.connected && conn.companyUuid) {
            // a run on a company that was connected before: is the company still known to the provider (the mock forgets on restart)?
            const known = await mock('GET', '/__mock/state');
            const there = known && (known.companies || []).some((c) => c.uuid === conn.companyUuid);
            if (!there) {
                const off = await call('POST', `${G}/disconnect`, owner, { confirm: true });
                check('the old connection (the mock provider was restarted and forgot the company) is removed', off.s === 200 && off.b.connection.connected === false, off.b);
                conn = { connected: false };
            } else ctx.info(`already connected (${conn.companyUuid})`);
        }
        const firstRun = !conn.connected;
        if (firstRun) {
            const admin = { firstName: 'Olivia', lastName: 'Carter', email: P.owner.email, phone: '5125550100' };
            check('the payroll admin cannot connect the company: only the owner can (403)', (await call('POST', `${G}/connect`, payroll, { admin })).s === 403);
            check('HR cannot connect the company (403)', (await call('POST', `${G}/connect`, hr, { admin })).s === 403);
            const before = await call('GET', `${G}/setup`, payroll);
            check('before connecting, every setup step is waiting for the company to be created', before.s === 200 && before.b.connected === false && before.b.next === 'company', before.b);
            const made = await call('POST', `${G}/connect`, owner, { admin });
            if (!check('[needed] the owner connects the company to the provider (201)', made.s === 201 && made.b.companyUuid && made.b.mode === 'mock', made.b)) return;
            status = await call('GET', `${G}/status`, payroll);
            conn = status.b.connection || {};
        }
        check('status says connected, in mock mode, under the company\'s legal name', conn.connected === true && conn.mode === 'mock' && /Lone Star Market/.test(conn.companyName || ''), conn);
        check('disconnecting needs an explicit yes (400)', (await call('POST', `${G}/disconnect`, owner, {})).s === 400);

        // ---------------------------------------------------------------------------------------- setup steps
        ctx.section('Company setup at the provider, step by step');
        // weekly pay: the pay period that ends on the last day of last week, paid far enough ahead for direct deposit
        const payDate = ctx.addDays(today, 7);
        const inputs = {
            terms: {}, locations: {}, federal_tax: {},
            industry: { naicsCode: '445110', title: 'Supermarkets and Other Grocery Retailers' },
            bank: { routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking' }, // made-up test account, mock only
            bank_verify: { deposit1: mockUp.deposit_1, deposit2: mockUp.deposit_2 },
            pay_schedule: { frequency: 'weekly', anchorPayDate: payDate, anchorEndOfPayPeriod: lastWeekEnd },
            employees: {}, employee_onboarded: {},
            state_taxes: { states: { TX: { state_tax_id: '12-345678-9', sui_rate: '2.7' } } },
            signatory: { firstName: 'Olivia', lastName: 'Carter', email: P.owner.email, title: 'Owner', phone: '5125550100', birthday: '1980-01-15', homeAddress: { street_1: '100 Congress Ave', city: 'Austin', state: 'TX', zip: '78701' } },
            forms: { agree: true, signatureText: 'Olivia Carter' },
            finish: {}, approval: {}
        };
        let setup = await call('GET', `${G}/setup?live=true`, payroll);
        if (!check('[needed] the setup steps read live from the provider', setup.s === 200 && Array.isArray(setup.b.steps), setup.b)) return;
        const order = setup.b.steps.map((s) => s.key).filter((k) => k !== 'company');
        check('the app lists 14 steps after creating the company, and this run has an input for each', order.length === 14 && order.every((k) => inputs[k]), order);
        if (firstRun) {
            check('the payroll admin cannot do a setup step (403)', (await call('POST', `${G}/setup/terms`, payroll, {})).s === 403);
            const early = await call('POST', `${G}/setup/approval`, owner, {});
            check('asking for approval before the other steps is refused, with what is still missing (409)', early.s === 409 && Array.isArray(early.b.blockedBy) && early.b.blockedBy.length > 0, early.b);
            check('an unknown setup step is refused (404)', (await call('POST', `${G}/setup/shortcut`, owner, {})).s === 404);
            const badSchedule = await call('POST', `${G}/setup/pay_schedule`, owner, { frequency: 'weekly', anchorPayDate: ctx.addDays(lastWeekEnd, -3), anchorEndOfPayPeriod: lastWeekEnd });
            check('a pay date before the end of the pay period is refused', badSchedule.s === 400 || badSchedule.s === 409, badSchedule.b);
        }
        for (const key of order) {
            const now = setup.b.steps.find((s) => s.key === key);
            if (now && now.status === 'done') { ctx.info(`${key}: already done`); continue; }
            const r = await call('POST', `${G}/setup/${key}`, owner, inputs[key]);
            if (r.s === 200 && Array.isArray(r.b.steps)) setup = r;
            const after = (r.b.steps || []).find((s) => s.key === key);
            const done = check(`setup step "${key}" is done`, r.s === 200 && after && after.status === 'done', { status: r.s, code: r.b.code, error: r.b.error, errors: r.b.errors, blockedBy: r.b.blockedBy, step: after, result: r.b.result });
            if (!done && r.s !== 200) { setup = await call('GET', `${G}/setup?live=true`, payroll); if (setup.s !== 200) return; }
            if (done && key === 'employees') check('all ten people are sent to the provider in that step, none blocked', r.b.result && r.b.result.total === 10 && r.b.result.blocked === 0 && r.b.result.errors === 0, r.b.result);
            if (done && key === 'bank') {
                const s2 = await call('GET', `${G}/status`, payroll);
                check('the company bank account is shown by its last four digits only', s2.b.connection.bankLast4 === '6789' && !s2.text.includes('000123456789'), s2.b.connection);
            }
        }

        ctx.section('People at the provider');
        let people = await call('GET', `${G}/people`, payroll);
        if (!check('[needed] the people list reads', people.s === 200 && Array.isArray(people.b.data), people.b)) return;
        if (people.b.data.some((p) => p.active && p.classification === 'W2' && !p.inGusto)) {
            const s = await call('POST', `${G}/sync/people`, payroll, {});
            check('people who were not at the provider yet are sent', s.s === 200 && s.b.errors === 0, s.b);
            people = await call('GET', `${G}/people`, payroll);
        }
        // the setup step finishes one person; the others are finished one by one, as the page does
        let finished = 0;
        for (const p of people.b.data.filter((x) => x.inGusto && !x.finishedInGusto && x.active)) {
            const r = await call('POST', `${G}/setup/employee_onboarded`, owner, { userId: p.userId });
            if (r.s === 200 && r.b.result && r.b.result.onboarded === true) finished += 1; else check(`${p.name} is finished at the provider`, false, r.b);
        }
        if (finished) ctx.info(`${finished} more people finished at the provider`);
        people = await call('GET', `${G}/people`, payroll);
        const mineRows = people.b.data.filter((p) => keyOf(p.userId));
        check('all ten people of stage 01 are at the provider and finished there, nobody in an error state', mineRows.length === 10 && mineRows.every((p) => p.inGusto && p.finishedInGusto && p.syncState !== 'error' && p.syncState !== 'blocked'), mineRows.filter((p) => !p.inGusto || !p.finishedInGusto || p.syncState === 'error'));
        check('each person\'s bank details went with them (never shown, only "sent")', mineRows.every((p) => p.bank === 'sent') && !/0001234/.test(people.text), mineRows.map((p) => [p.name, p.bank, p.bankNote]));
        const resend = await call('POST', `${G}/sync/people`, payroll, {});
        check('sending people again changes nothing', resend.s === 200 && resend.b.errors === 0 && resend.b.synced === 0 && resend.b.unchanged >= 10, resend.b);
        check('HR can look at the list but cannot send people (403)', (await call('GET', `${G}/people`, hr)).s === 200 && (await call('POST', `${G}/sync/people`, hr, {})).s === 403);
        const depts = await call('POST', `${G}/sync/departments`, payroll, {});
        check('departments are sent to the provider', depts.s === 200, depts.b);
        const pull = await call('POST', `${G}/sync/pull`, payroll, {});
        check('reading people back from the provider finds all ten, none unknown on either side', pull.s === 200 && pull.b.gustoCount === 10 && pull.b.unmatched.length === 0 && pull.b.missingInGusto.length === 0, pull.b);
        const afterPull = await call('GET', `${G}/people`, payroll);
        check('nothing differs between our records and the provider\'s (pay rates, pay type)', afterPull.s === 200 && afterPull.b.data.every((p) => !(p.drift || []).length) && afterPull.b.data.filter((p) => p.finishedInGusto).length === 10, (afterPull.b.data || []).filter((p) => (p.drift || []).length).map((p) => [p.name, p.drift]));
        const end = await call('GET', `${G}/setup?live=true`, payroll);
        const open = (end.b.steps || []).filter((s) => s.status !== 'done');
        check('every setup step is done and the provider has approved the company', end.s === 200 && open.length === 0 && end.b.approved === true, open.length ? open : end.b);
        status = await call('GET', `${G}/status`, payroll);
        check('status: connected, approved, weekly pay schedule, nothing left to set up', status.b.connection.approved === true && status.b.setup.next === null && status.b.connection.paySchedule && status.b.connection.paySchedule.frequency === 'weekly', status.b);
        const errs = await call('GET', `${G}/errors`, payroll);
        check('the list of provider errors is empty', errs.s === 200 && errs.b.data.length === 0, errs.b);

        // ------------------------------------------------------------------------------------------ hours feed
        ctx.section('The hours feed for last week, from the approved timesheets');
        check('a feed without dates is refused (400)', (await call('GET', `${G}/payroll/feed`, payroll)).s === 400);
        check('a feed whose end is before its start is refused (400)', (await call('GET', `${G}/payroll/feed?start=${lastWeekEnd}&end=${lastWeekStart}`, payroll)).s === 400);
        const feed = await call('GET', `${G}/payroll/feed?start=${lastWeekStart}&end=${lastWeekEnd}`, payroll);
        const frow = (k) => (feed.b.rows || []).find((r) => r.userId === P[k].uid) || {};
        const blockersInFeed = (feed.b.issues || []).filter((i) => i.severity === 'blocker');
        check('the feed says holiday hours go to the provider inside regular hours', (feed.b.issues || []).some((i) => i.code === 'extra_hours_as_regular'), feed.b.issues);
        check('the feed is ready: no blockers, and one row for each of the four hourly people (salaried people need no hours)', feed.s === 200 && feed.b.ready === true && blockersInFeed.length === 0 && HOURLY.every((k) => frow(k).userId) && !SALARIED.some((k) => frow(k).userId), { ready: feed.b.ready, issues: feed.b.issues, rows: (feed.b.rows || []).map((r) => r.name) });
        for (const k of HOURLY) {
            const r = frow(k); const w = want[k];
            check(`feed row for ${P[k].name}: ${w.regular} regular, ${w.overtime} overtime, ${w.holiday} holiday hours (the hours approved in stage 03)`, near(r.regularHours, w.regular) && near(r.overtimeHours, w.overtime) && near(r.holidayHours || 0, w.holiday) && near(r.doubleTimeHours, 0), r);
        }
        const ft = feed.b.totals || {};
        const sumOf = (f) => round2(HOURLY.reduce((s, k) => s + want[k][f], 0));
        check(`feed totals add up: ${sumOf('regular')} regular, ${sumOf('overtime')} overtime, ${sumOf('holiday')} holiday hours for 4 people`, near(ft.regularHours, sumOf('regular')) && near(ft.overtimeHours, sumOf('overtime')) && near(ft.holidayHours, sumOf('holiday')) && ft.people === 4, ft);
        const tipsInFeed = /tip/i.test(JSON.stringify(feed.b.rows || []));
        if (!tipsInFeed) ctx.skip('Tips on the pay run', `the hours feed has no tips: the server's $${time.tips.server.total} of declared tips and the $${time.tips.server.poolShare} tip-pool share from stage 03 never reach the payroll provider through any route (payroll has to key them in at the provider)`);
        else check('the server\'s declared tips are in the feed', new RegExp(String(time.tips.server.total)).test(JSON.stringify(frow('server'))), frow('server'));
        const partial = await call('GET', `${G}/payroll/feed?start=${ctx.addDays(lastWeekStart, 2)}&end=${ctx.addDays(lastWeekEnd, 2)}`, payroll);
        check('a pay period that cuts through the workweeks gets a warning that those weeks are left out', partial.s === 200 && (partial.b.issues || []).some((i) => i.code === 'partial_week'), partial.b.issues);
        check('an employee cannot read the hours feed (403)', (await call('GET', `${G}/payroll/feed?start=${lastWeekStart}&end=${lastWeekEnd}`, cashier)).s === 403);

        // ------------------------------------------------------------------------------------ regular payroll
        ctx.section('Regular payroll for last week: prepare and preview');
        let payrollId = null; let alreadyPaid = false;
        const hist0 = await call('GET', `${G}/payroll/history`, payroll);
        const paidBefore = (hist0.b.data || []).find((r) => r.kind === 'regular' && r.periodStart === lastWeekStart && r.periodEnd === lastWeekEnd && ['submitted', 'paid'].includes(r.status));
        if (paidBefore) { payrollId = paidBefore.payrollUuid; alreadyPaid = true; ctx.info(`last week was already paid in an earlier run (${payrollId}); the prepare and submit checks are not repeated`); }
        check('HR cannot prepare a payroll (403)', (await call('POST', `${G}/payroll/prepare`, hr, { start: lastWeekStart, end: lastWeekEnd })).s === 403);
        check('the accountant can read payroll but cannot prepare one (403)', (await call('GET', `${G}/payroll/history`, accountant)).s === 200 && (await call('POST', `${G}/payroll/prepare`, accountant, { start: lastWeekStart, end: lastWeekEnd })).s === 403);
        check('preparing without dates is refused (400)', (await call('POST', `${G}/payroll/prepare`, payroll, {})).s === 400);
        const offGrid = await call('POST', `${G}/payroll/prepare`, payroll, { start: ctx.addDays(lastWeekStart, -3), end: ctx.addDays(lastWeekEnd, -3) });
        check('a period that is not one of the provider\'s pay periods is refused, and the provider\'s periods are named (404)', offGrid.s === 404 && offGrid.b.code === 'no_payroll_for_period' && Array.isArray(offGrid.b.periods), offGrid.b);

        if (!alreadyPaid) {
            const prep = await call('POST', `${G}/payroll/prepare`, payroll, { start: lastWeekStart, end: lastWeekEnd });
            if (!check('[needed] the payroll admin prepares last week\'s payroll at the provider', prep.s === 200 && prep.b.status === 'prepared' && prep.b.payrollUuid, prep.b)) return;
            payrollId = prep.b.payrollUuid;
            check(`the provider's pay date is ${payDate} and the deadline to submit has not passed`, prep.b.checkDate === payDate && prep.b.cutoff && prep.b.cutoff.status !== 'passed', { checkDate: prep.b.checkDate, cutoff: prep.b.cutoff });
            check('no blockers, and it can be submitted; the only note is that holiday hours are sent as regular hours', prep.b.canSubmit === true && prep.b.blockers.length === 0 && prep.b.issues.length === 1 && prep.b.issues[0].code === 'extra_hours_as_regular', { blockers: prep.b.blockers, issues: prep.b.issues });
            check(`the provider calculates $${wantGross} gross for ten people`, near(prep.b.totals.gross_pay, wantGross, 0.03) && prep.b.employees.length === 10, { totals: prep.b.totals, people: prep.b.employees.length });
            const emp = (k) => prep.b.employees.find((e) => e.name === P[k].name) || {};
            const c = time.expected.cashier;
            // (40 regular + 8 holiday) x 18.50 + 7 overtime x 18.50 x 1.5
            check(`cashier: (${c.regularHours} regular + ${c.holidayHours} holiday) x $${c.payRate} + ${c.overtimeHours} overtime x $${c.payRate} x 1.5 = $${want.cashier.gross}`, near(emp('cashier').gross, want.cashier.gross), emp('cashier'));
            for (const k of ['server', 'stocker', 'leaver']) {
                const e = time.expected[k];
                check(`${P[k].name}: (${e.regularHours} worked + ${e.holidayHours} holiday) x $${e.payRate} = $${want[k].gross}`, near(emp(k).gross, want[k].gross), emp(k));
            }
            // the six salaried people: compared by amount, because the preview only names people who have hours
            const hourlyNames = new Set(HOURLY.map((k) => P[k].name));
            const salariedGross = prep.b.employees.filter((e) => !hourlyNames.has(e.name)).map((e) => Number(e.gross)).sort((a, b) => a - b);
            const salariedWant = SALARIED.map((k) => want[k].gross).sort((a, b) => a - b);
            check('each of the six salaried people gets one fifty-second of their yearly salary', salariedGross.length === 6 && salariedGross.every((g, i) => near(g, salariedWant[i])), { got: salariedGross, want: salariedWant });
            check('every person in the preview is shown by name, salaried people too', prep.b.employees.every((e) => Boolean(e.name)), prep.b.employees.filter((e) => !e.name).map((e) => ({ name: e.name, gross: e.gross })));

            const prev = await call('GET', `${G}/payroll/${payrollId}`, payroll);
            check('the preview shows it as prepared, not submitted, with hours unchanged since it was prepared', prev.s === 200 && prev.b.kind === 'regular' && prev.b.status === 'prepared' && prev.b.processed === false && prev.b.stale === false && prev.b.period.start === lastWeekStart && prev.b.period.end === lastWeekEnd, prev.b);
            check('the auditor can read the preview; an employee cannot (403)', (await call('GET', `${G}/payroll/${payrollId}`, auditor)).s === 200 && (await call('GET', `${G}/payroll/${payrollId}`, cashier)).s === 403);
            check('an unknown payroll is a 404', (await call('GET', `${G}/payroll/00000000-0000-4000-8000-000000000000`, payroll)).s === 404);
            const noStub = await call('GET', `${G}/my/pay-stubs`, cashier);
            check('before the payroll is submitted the cashier has no pay stub', noStub.s === 200 && noStub.b.data.length === 0, noStub.b);

            ctx.section('Hours that change after the review block the submit');
            const reopen = await call('POST', `/api/time/weeks/${P.stocker.uid}/${lastWeekStart}/reopen`, hr, { reason: 'Payroll check: are the stock clerk\'s hours right?' });
            const stalePrev = await call('GET', `${G}/payroll/${payrollId}`, payroll);
            check('HR reopens the stock clerk\'s week: the preview now says the hours changed', reopen.s === 200 && stalePrev.s === 200 && stalePrev.b.stale === true, { reopen: reopen.b, stale: stalePrev.b.stale });
            const staleSubmit = await call('POST', `${G}/payroll/${payrollId}/submit`, payroll, { confirm: true, confirmPayrollId: payrollId });
            check('and submitting is refused until it is prepared again (409)', staleSubmit.s === 409 && staleSubmit.b.code === 'stale_hours', staleSubmit.b);
            const resendWeek = await call('POST', `/api/time/weeks/${lastWeekStart}/submit`, stocker, {});
            const reapprove = await call('PUT', `/api/time/weeks/${P.stocker.uid}/${lastWeekStart}/decision`, manager, { decision: 'approve' });
            const freshPrev = await call('GET', `${G}/payroll/${payrollId}`, payroll);
            check('the stock clerk sends the same hours in again and the manager approves: the prepared payroll is good again', resendWeek.s === 200 && reapprove.s === 200 && freshPrev.b.stale === false, { resend: resendWeek.b, approve: reapprove.b, stale: freshPrev.b.stale });

            ctx.section('Submit with the typed confirmation');
            check('HR cannot submit payroll (403)', (await call('POST', `${G}/payroll/${payrollId}/submit`, hr, { confirm: true, confirmPayrollId: payrollId })).s === 403);
            const noConfirm = await call('POST', `${G}/payroll/${payrollId}/submit`, payroll, { confirm: true });
            check('submit without the typed payroll id is refused (400)', noConfirm.s === 400 && noConfirm.b.code === 'confirmation_required', noConfirm.b);
            check('submit with the wrong id typed is refused (400)', (await call('POST', `${G}/payroll/${payrollId}/submit`, payroll, { confirm: true, confirmPayrollId: 'last-week' })).s === 400);
            const both = await Promise.all([1, 2].map(() => call('POST', `${G}/payroll/${payrollId}/submit`, payroll, { confirm: true, confirmPayrollId: payrollId })));
            const won = both.find((r) => r.s === 200);
            check('two submits at the same moment: exactly one goes through', both.filter((r) => r.s === 200).length === 1 && both.filter((r) => r.s === 409).length === 1, both.map((r) => [r.s, r.b.code || r.b.status]));
            check(`the payroll is submitted for $${wantGross} gross and pay results are stored for all ten people`, Boolean(won) && won.b.status === 'submitted' && near(won.b.totals.gross_pay, wantGross, 0.03) && won.b.payResults && won.b.payResults.saved === 10 && won.b.payResults.unmatched.length === 0, won ? won.b : both[0].b);
            check('submitting it again is refused (409)', (await call('POST', `${G}/payroll/${payrollId}/submit`, payroll, { confirm: true, confirmPayrollId: payrollId })).s === 409);
            const again = await call('POST', `${G}/payroll/prepare`, payroll, { start: lastWeekStart, end: lastWeekEnd });
            check('preparing the same pay period again is refused: it is already submitted (409)', again.s === 409 && /already/.test(again.b.code || ''), again.b);
        }
        if (!payrollId) return;

        // ------------------------------------------------------------------------- register, stubs, history, cost
        ctx.section('Payroll register');
        const reg = await call('GET', `${G}/payroll/${payrollId}/register`, payroll);
        const rrow = (k) => (reg.b.rows || []).find((r) => r.userId === P[k].uid) || {};
        check('the register has ten people for last week\'s pay period', reg.s === 200 && reg.b.rows.length === 10 && reg.b.periodStart === lastWeekStart && reg.b.periodEnd === lastWeekEnd, { rows: (reg.b.rows || []).length, period: [reg.b.periodStart, reg.b.periodEnd] });
        for (const k of HOURLY) check(`register row for ${P[k].name}: ${want[k].hours} paid hours, $${want[k].gross} gross`, near(rrow(k).gross, want[k].gross) && near(rrow(k).hours, want[k].hours) && rrow(k).employeeId === P[k].employeeId, rrow(k));
        check('the register total is the sum of its rows and matches what was submitted', near(reg.b.totals.gross, wantGross, 0.03) && near(reg.b.totals.gross, round2((reg.b.rows || []).reduce((s, r) => s + r.gross, 0))) && reg.b.totals.people === 10, reg.b.totals);
        check('on every row gross = net + employee taxes + deductions', (reg.b.rows || []).every((r) => near(r.gross, r.net + r.employeeTaxes + r.deductions, 0.02)), (reg.b.rows || []).map((r) => [r.name, r.gross, r.net, r.employeeTaxes, r.deductions]));
        check('the mock provider gives no per-person taxes, so the register says the tax split is an estimate', reg.b.allocated === true, reg.b.allocated);
        check('the six salaried people are on the register with their weekly salary', SALARIED.every((k) => near(rrow(k).gross, want[k].gross)), SALARIED.map((k) => [P[k].name, rrow(k).gross, want[k].gross]));
        check('each row carries the department the person was put in (Office, Store or Cafe)', HOURLY.concat(SALARIED).every((k) => rrow(k).department === DEPARTMENT[k]), (reg.b.rows || []).map((r) => [r.name, r.department]));
        check('an employee and a manager cannot read the register (403)', (await call('GET', `${G}/payroll/${payrollId}/register`, cashier)).s === 403 && (await call('GET', `${G}/payroll/${payrollId}/register`, manager)).s === 403);

        ctx.section('Pay stubs');
        const myStubs = await call('GET', `${G}/my/pay-stubs`, cashier);
        const stub = (myStubs.b.data || []).find((s) => s.payroll_uuid === payrollId) || {};
        check(`the cashier sees their own pay stub for last week: $${want.cashier.gross} gross`, myStubs.s === 200 && near(stub.gross_pay, want.cashier.gross) && stub.pay_period && stub.pay_period.start_date === lastWeekStart && stub.pay_period.end_date === lastWeekEnd, myStubs.b);
        check('net pay on the stub is below gross', Number(stub.net_pay) > 0 && Number(stub.net_pay) < Number(stub.gross_pay), stub);
        const srvStubs = await call('GET', `${G}/my/pay-stubs`, server);
        const srvStub = (srvStubs.b.data || []).find((s) => s.payroll_uuid === payrollId) || {};
        check(`the server sees their own stub ($${want.server.gross}), not the cashier's`, srvStubs.s === 200 && near(srvStub.gross_pay, want.server.gross) && !srvStubs.text.includes(String(want.cashier.gross)), srvStubs.b);
        check('the cashier cannot read the server\'s pay stubs (403)', (await call('GET', `${G}/pay-stubs/${P.server.uid}`, cashier)).s === 403);
        check('the manager cannot read a team member\'s pay stubs (403)', (await call('GET', `${G}/pay-stubs/${P.cashier.uid}`, manager)).s === 403);
        const adminStubs = await call('GET', `${G}/pay-stubs/${P.cashier.uid}`, payroll);
        check('the payroll admin reads the cashier\'s stubs', adminStubs.s === 200 && adminStubs.b.data.some((s) => s.payroll_uuid === payrollId && near(s.gross_pay, want.cashier.gross)), adminStubs.b);
        check('no token cannot read pay stubs (401)', (await call('GET', `${G}/my/pay-stubs`, null)).s === 401);
        const ownerStubs = await call('GET', `${G}/my/pay-stubs`, owner);
        check('the owner, who is not on the payroll, simply has no stubs', ownerStubs.s === 200 && ownerStubs.b.data.length === 0, ownerStubs.b);

        ctx.section('Payroll history, cost by department, taxes');
        const hist = await call('GET', `${G}/payroll/history`, payroll);
        const hrow = (hist.b.data || []).find((r) => r.payrollUuid === payrollId) || {};
        check('history shows last week as a submitted regular payroll, with who prepared and submitted it', hist.s === 200 && hrow.kind === 'regular' && ['submitted', 'paid'].includes(hrow.status) && hrow.periodStart === lastWeekStart && near(hrow.totals.gross_pay, wantGross, 0.03) && hrow.preparedBy === P.payroll.uid && hrow.submittedBy === P.payroll.uid, hrow);
        check('the hours that were sent are kept with it', hrow.feedTotals && near(hrow.feedTotals.overtimeHours, sumOf('overtime')) && near(hrow.feedTotals.regularHours, sumOf('regular')), hrow.feedTotals);
        const refresh = await call('POST', `${G}/payroll/${payrollId}/refresh`, payroll, {});
        check('asking the provider again confirms it is submitted there', refresh.s === 200 && ['submitted', 'paid'].includes(refresh.b.status), refresh.b);
        const checkDate = hrow.checkDate || payDate;
        const cost = await call('GET', `${G}/payroll/cost?from=${checkDate}&to=${checkDate}`, accountant);
        const dept = (name) => (cost.b.byDepartment || []).find((d) => d.key === name) || {};
        const deptWant = (name) => round2(everyone.filter((k) => DEPARTMENT[k] === name).reduce((s, k) => s + want[k].gross, 0));
        if (!alreadyPaid) {
            check(`the accountant reads payroll cost for that pay date: $${wantGross} gross for ten people`, cost.s === 200 && near(cost.b.totals.gross, wantGross, 0.03) && cost.b.totals.people === 10, cost.b.totals);
            check(`cost by department: Office $${deptWant('Office')}, Store $${deptWant('Store')}, Cafe $${deptWant('Cafe')} gross`, ['Office', 'Store', 'Cafe'].every((d) => near(dept(d).gross, deptWant(d), 0.03)), (cost.b.byDepartment || []).map((d) => [d.key, d.people, d.gross]));
            check('employer cost is gross pay plus the employer\'s taxes', near(cost.b.totals.employerCost, cost.b.totals.gross + cost.b.totals.employerTaxes, 0.02) && cost.b.totals.employerTaxes > 0, cost.b.totals);
        } else check('the accountant reads payroll cost for that pay date, split over the three departments', cost.s === 200 && ['Office', 'Store', 'Cafe'].every((d) => dept(d).gross > 0), (cost.b.byDepartment || []).map((d) => [d.key, d.people, d.gross]));
        const byDate = (cost.b.byPayDate || []).find((d) => d.key === checkDate) || {};
        check('cost by pay date has that pay date, and it adds up to the total', cost.s === 200 && near(byDate.gross, cost.b.totals.gross) && byDate.people === cost.b.totals.people, cost.b.byPayDate);
        check('a bad date on the cost report is refused (400)', (await call('GET', `${G}/payroll/cost?from=yesterday`, accountant)).s === 400);
        check('an employee cannot read payroll cost (403)',(await call('GET', `${G}/payroll/cost`, cashier)).s === 403);
        const taxes = await call('GET', `${G}/taxes`, payroll);
        check('tax payments for the payroll and the company\'s forms are read from the provider', taxes.s === 200 && taxes.b.payments.some((t) => t.payroll_uuid === payrollId) && Array.isArray(taxes.b.forms), taxes.b);

        ctx.section('Reconciliation: our hours against the provider\'s');
        const rec = await call('GET', `${G}/payroll/reconciliation?start=${lastWeekStart}&end=${lastWeekEnd}`, payroll);
        check('reconciliation finds the submitted payroll and nobody missing on either side', rec.s === 200 && rec.b.hasPayroll === true && rec.b.payrollProcessed === true && rec.b.missingLinks.length === 0 && rec.b.onlyInGusto.length === 0 && rec.b.linkedNotInFeed.length === 0, { hasPayroll: rec.b.hasPayroll, missingLinks: rec.b.missingLinks, onlyInGusto: rec.b.onlyInGusto, linkedNotInFeed: rec.b.linkedNotInFeed });
        const diff = (k) => (rec.b.diffs || []).find((d) => d.userId === P[k].uid) || {};
        check('the stock clerk (no holiday hours) matches: 12 hours here, 12 at the provider', diff('stocker').match === true && near(diff('stocker').gusto.regular, 12), diff('stocker'));
        check('overtime matches for the cashier: 7 hours here, 7 at the provider', near((diff('cashier').ours || {}).overtime, want.cashier.overtime) && near((diff('cashier').gusto || {}).overtime, want.cashier.overtime), diff('cashier'));
        // The app sends holiday hours inside "Regular Hours", so a correct payroll must still reconcile as clean
        check('the payroll that was just sent reconciles with no differences (holiday hours were sent by the app itself)', rec.b.clean === true && rec.b.mismatches === 0, (rec.b.diffs || []).filter((d) => !d.match));

        // ------------------------------------------------------------------------------------------ off-cycle
        ctx.section('Off-cycle payroll: a bonus for the cashier');
        const opt = await call('GET', `${G}/off-cycle/options`, payroll);
        check('the options list the reasons (bonus, correction, final pay) and the people who can be paid', opt.s === 200 && opt.b.reasons && opt.b.reasons.bonus && opt.b.people.some((x) => x.userId === P.cashier.uid), opt.b);
        check('HR can read the options but cannot prepare an off-cycle payroll (403)', (await call('GET', `${G}/off-cycle/options`, hr)).s === 200 && (await call('POST', `${G}/off-cycle`, hr, {})).s === 403);
        const badOc = await call('POST', `${G}/off-cycle`, payroll, { reason: 'bonus', checkDate: ctx.addDays(today, -5), people: [] });
        check('a pay date in the past and nobody chosen is refused with both reasons (400)', badOc.s === 400 && Array.isArray(badOc.b.errors) && badOc.b.errors.length >= 2, badOc.b);
        // an amount that differs on every run, so a second run on the same company is never "the same bonus again"
        const bonus = round2(150 + (Number(stamp) % 5000) / 100);
        const ocBody = { reason: 'bonus', checkDate: ctx.addDays(today, 10), people: [{ userId: P.cashier.uid, amount: bonus, note: 'Covered the Saturday shift' }] };
        const oc = await call('POST', `${G}/off-cycle`, payroll, ocBody);
        let bonusId = null;
        if (check(`a bonus of $${bonus} for the cashier is prepared at the provider (201)`, oc.s === 201 && oc.b.status === 'prepared' && oc.b.kind === 'off_cycle' && near(oc.b.totals.gross_pay, bonus), oc.b)) {
            bonusId = oc.b.payrollUuid;
            const same = await call('POST', `${G}/off-cycle`, payroll, ocBody);
            check('asking for the same bonus again re-uses the one being prepared', same.s === 200 && same.b.payrollUuid === bonusId, same.b);
            const ocPrev = await call('GET', `${G}/payroll/${bonusId}`, payroll);
            check('the preview shows one person, the bonus amount, and nothing else (no salary, no hours)', ocPrev.s === 200 && ocPrev.b.kind === 'off_cycle' && ocPrev.b.reason === 'bonus' && ocPrev.b.employees.length === 1 && near(ocPrev.b.employees[0].gross, bonus) && ocPrev.b.stale === false, ocPrev.b);
            check('the bonus also needs the typed confirmation (400)', (await call('POST', `${G}/payroll/${bonusId}/submit`, payroll, { confirm: true })).s === 400);
            const ocSub = await call('POST', `${G}/payroll/${bonusId}/submit`, payroll, { confirm: true, confirmPayrollId: bonusId });
            check('the bonus is submitted', ocSub.s === 200 && ocSub.b.status === 'submitted' && near(ocSub.b.totals.gross_pay, bonus), ocSub.b);
            const twice = await call('POST', `${G}/off-cycle`, payroll, ocBody);
            check('the identical bonus a second time needs an explicit yes (409)', twice.s === 409 && twice.b.code === 'already_submitted', twice.b);
            const ocReg = await call('GET', `${G}/payroll/${bonusId}/register`, payroll);
            check('its register has one row: the cashier and the bonus', ocReg.s === 200 && ocReg.b.rows.length === 1 && ocReg.b.rows[0].userId === P.cashier.uid && near(ocReg.b.rows[0].gross, bonus), ocReg.b);
            const h2 = await call('GET', `${G}/payroll/history`, payroll);
            const brow = (h2.b.data || []).find((r) => r.payrollUuid === bonusId) || {};
            check('history shows it as a submitted off-cycle bonus', brow.kind === 'off_cycle' && brow.reason === 'bonus' && brow.status === 'submitted', brow);
            const stubs2 = await call('GET', `${G}/my/pay-stubs`, cashier);
            check('the cashier now has a second pay stub, for the bonus', stubs2.s === 200 && stubs2.b.data.some((s) => s.payroll_uuid === bonusId && near(s.gross_pay, bonus)) && stubs2.b.data.some((s) => s.payroll_uuid === payrollId), stubs2.b);
            const srv2 = await call('GET', `${G}/my/pay-stubs`, server);
            check('the server has no stub for the cashier\'s bonus', srv2.s === 200 && !srv2.b.data.some((s) => s.payroll_uuid === bonusId), srv2.b);
        }
        // one that is prepared and then dropped: nothing is paid
        const dropBody = { reason: 'correction', checkDate: ctx.addDays(today, 10), people: [{ userId: P.stocker.uid, amount: round2(bonus / 10), note: 'Entered by mistake' }] };
        const drop = await call('POST', `${G}/off-cycle`, payroll, dropBody);
        if (check('a correction payment for the stock clerk is prepared', drop.s === 201, drop.b)) {
            const disc = await call('POST', `${G}/payroll/${drop.b.payrollUuid}/cancel`, payroll, {});
            check('and discarded before it is submitted: nothing was paid', disc.s === 200 && disc.b.status === 'discarded', disc.b);
            check('a discarded payroll cannot be submitted (409)', (await call('POST', `${G}/payroll/${drop.b.payrollUuid}/submit`, payroll, { confirm: true, confirmPayrollId: drop.b.payrollUuid })).s === 409);
            const st = await call('GET', `${G}/my/pay-stubs`, stocker);
            check('the stock clerk has no stub for it', st.s === 200 && !st.b.data.some((s) => s.payroll_uuid === drop.b.payrollUuid), st.b);
        }

        // ----------------------------------------------------------------------------------------- contractor
        ctx.section('A 1099 contractor: W-9, sent to the provider, paid, on the 1099 ledger once');
        const cName = `Bright Windows ${state.run} ${stamp}`;
        check('the payroll admin cannot add a contractor: that is HR\'s job (403)', (await call('POST', `${U}/contractors`, payroll, { name: cName })).s === 403);
        check('a contractor with a bad email is refused (400)', (await call('POST', `${U}/contractors`, hr, { name: cName, email: 'not-an-email' })).s === 400);
        const made = await call('POST', `${U}/contractors`, hr, { name: cName, email: `windows.${stamp}@example.test`, notes: 'Window cleaning, monthly' });
        if (check('HR adds a contractor', made.s === 201 && made.b.contractor && made.b.contractor.id && made.b.contractor.w9Status === 'missing', made.b)) {
            const cId = made.b.contractor.id;
            check('the same name twice is refused (409)', (await call('POST', `${U}/contractors`, hr, { name: cName })).s === 409);
            const before = await call('GET', `${G}/contractors`, payroll);
            const mineBefore = (before.b.data || []).find((c) => c.contractorId === cId);
            check('without a W-9 the payroll list says the contractor cannot be sent, and why', Boolean(mineBefore) && mineBefore.syncState === 'blocked' && /W-9/.test((mineBefore.blockedReasons || []).join()), mineBefore);
            const w9Body = { legalName: cName, taxClassification: 'individual', tinType: 'SSN', tin: '512-45-6789', address: { line1: '9 Oak Ave', city: 'Austin', state: 'TX', zip: '78703' }, certified: true, signature: cName }; // made-up number
            check('a W-9 that is not certified is refused (400)', (await call('PUT', `${U}/contractors/${cId}/w9`, hr, { ...w9Body, certified: false })).s === 400);
            const w9 = await call('PUT', `${U}/contractors/${cId}/w9`, hr, w9Body);
            check('the W-9 is saved and the taxpayer number comes back masked', w9.s === 200 && !w9.text.includes('512-45-6789') && !w9.text.includes('512456789') && /6789/.test(w9.text), w9.text.slice(0, 300));
            const notYet = await call('POST', `${G}/contractor-payments`, payroll, { contractorId: cId, date: today, amount: 5 });
            check('a payment before the contractor is at the provider is refused (409)', notYet.s === 409 && notYet.b.code === 'not_linked', notYet.b);
            check('HR cannot send contractors to the provider (403)', (await call('POST', `${G}/sync/contractors`, hr, { contractorIds: [cId] })).s === 403);
            const sync1 = await call('POST', `${G}/sync/contractors`, payroll, { contractorIds: [cId] });
            check('the payroll admin sends the contractor to the provider', sync1.s === 200 && sync1.b.synced === 1 && sync1.b.errors === 0, sync1.b);
            const sync2 = await call('POST', `${G}/sync/contractors`, payroll, { contractorIds: [cId] });
            check('sending again changes nothing', sync2.s === 200 && sync2.b.unchanged === 1, sync2.b);
            check('a payment dated in the future is refused (400)', (await call('POST', `${G}/contractor-payments`, payroll, { contractorId: cId, date: ctx.addDays(today, 5), amount: 5 })).s === 400);
            check('HR cannot record a contractor payment through payroll (403)', (await call('POST', `${G}/contractor-payments`, hr, { contractorId: cId, date: today, amount: 5 })).s === 403);
            const payBody = { contractorId: cId, date: today, hours: 3, rate: 40, reimbursement: 12.5, memo: 'Window cleaning, both stores', requestId: `e2e-${state.run}-${stamp}-0001` };
            const pay1 = await call('POST', `${G}/contractor-payments`, payroll, payBody);
            if (check('a payment of 3 hours x $40 = $120 plus $12.50 expenses is recorded and written to the 1099 ledger', pay1.s === 201 && pay1.b.payment.amount === 120 && pay1.b.payment.reimbursement === 12.5 && pay1.b.payment.inLedger === true, pay1.b)) {
                const pid = pay1.b.payment.id;
                const dup = await Promise.all([call('POST', `${G}/contractor-payments`, payroll, payBody), call('POST', `${G}/contractor-payments`, payroll, payBody)]);
                check('the same request sent twice more adds nothing', dup.every((r) => r.s === 200 && r.b.duplicate === true && r.b.payment.id === pid), dup.map((r) => r.b));
                const ledger = await call('GET', `${U}/contractors/${cId}/payments`, accountant);
                const rows = ledger.b.data || [];
                check('the 1099 ledger has the payment exactly once: one $120 income row and one $12.50 expenses row', ledger.s === 200 && rows.length === 2 && rows.filter((r) => r.amount === 120 && r.category === 'nonemployee_compensation').length === 1 && rows.filter((r) => r.amount === 12.5 && r.category === 'reimbursement').length === 1 && rows.every((r) => !r.voided), rows);
                const twin = await call('POST', `${G}/contractor-payments`, payroll, { ...payBody, requestId: `e2e-${state.run}-${stamp}-0002` });
                check('a look-alike payment under a new request needs an explicit yes (409)', twin.s === 409 && twin.b.code === 'possible_duplicate', twin.b);
                const list = await call('GET', `${G}/contractor-payments`, payroll);
                check('the payment list shows it as recorded', list.s === 200 && list.b.data.some((x) => x.id === pid && x.contractorName === cName && x.status === 'recorded'), list.b);
                const summary = await call('GET', `${U}/contractors/summary?year=${today.slice(0, 4)}`, accountant);
                const srow = (summary.b.data || []).find((t) => t.contractorId === cId) || {};
                check('the yearly 1099 summary: $132.50 paid, of which $120 counts as 1099 income, W-9 on file, under the reporting limit', summary.s === 200 && srow.totalPaid === 132.5 && srow.necTotal === 120 && srow.paymentCount === 2 && srow.w9Status === 'received' && srow.over1099Threshold === false, srow.contractorId ? srow : summary.b);
                const sumCsv = await call('GET', `${U}/contractors/summary.csv?year=${today.slice(0, 4)}`, accountant);
                check('the summary downloads as a CSV with only the last four digits of the taxpayer number', sumCsv.s === 200 && sumCsv.text.includes(cName) && !sumCsv.text.includes('512456789') && !sumCsv.text.includes('512-45-6789'), sumCsv.text.slice(0, 300));
                check('an employee cannot read the 1099 ledger or the summary (403)', (await call('GET', `${U}/contractors/${cId}/payments`, cashier)).s === 403 && (await call('GET', `${U}/contractors/summary`, cashier)).s === 403);
                // a second payment that is cancelled: its ledger rows stay, marked void, and the summary does not move
                const pay2 = await call('POST', `${G}/contractor-payments`, payroll, { contractorId: cId, date: today, amount: 75, memo: 'Entered twice by mistake', requestId: `e2e-${state.run}-${stamp}-0003` });
                if (check('a second payment of $75 is recorded', pay2.s === 201 && pay2.b.payment.amount === 75, pay2.b)) {
                    check('cancelling needs a reason (400)', (await call('POST', `${G}/contractor-payments/${pay2.b.payment.id}/cancel`, payroll, {})).s === 400);
                    const cancel = await call('POST', `${G}/contractor-payments/${pay2.b.payment.id}/cancel`, payroll, { reason: 'Entered twice by mistake' });
                    const ledger2 = await call('GET', `${U}/contractors/${cId}/payments`, accountant);
                    const summary2 = await call('GET', `${U}/contractors/summary?year=${today.slice(0, 4)}`, accountant);
                    const srow2 = (summary2.b.data || []).find((t) => t.contractorId === cId) || {};
                    check('it is cancelled at the provider; its ledger row is kept but marked void, and the yearly summary is still $132.50', cancel.s === 200 && cancel.b.payment.status === 'cancelled' && ledger2.b.data.length === 3 && ledger2.b.data.filter((r) => r.voided).length === 1 && srow2.totalPaid === 132.5, { cancel: cancel.b, ledger: ledger2.b.data, summary: srow2 });
                    check('cancelling it twice is refused (409)', (await call('POST', `${G}/contractor-payments/${pay2.b.payment.id}/cancel`, payroll, { reason: 'again' })).s === 409);
                }
            }
            state.ids.contractor = { id: cId, name: cName };

            ctx.section('W-2 and 1099 forms');
            const year = Number(today.slice(0, 4)) - 1;
            // the mock provider is asked to make last year's forms (a real provider makes them itself in January)
            const yearEnd = await mock('POST', '/__mock/year-end', { company_uuid: conn.companyUuid, year, all_contractors: true });
            const forms = await call('GET', `${G}/tax-forms`, payroll);
            check('the list of tax forms reads, with no provider address in it', forms.s === 200 && Array.isArray(forms.b.employees) && Array.isArray(forms.b.contractors) && !forms.text.includes('document_url') && !forms.text.includes(MOCK.replace(/^https?:\/\//, '')), forms.text.slice(0, 300));
            const pf = (forms.b.employees || []).find((x) => x.id === P.cashier.uid);
            const cf = (forms.b.contractors || []).find((x) => x.id === cId);
            if (check('the mock provider made last year\'s forms', Boolean(yearEnd && yearEnd.created >= 1), yearEnd)) {
                check(`the cashier has a W-2 for ${year} and the contractor a 1099`, Boolean(pf) && pf.years.includes(year) && Boolean(cf) && cf.years.includes(year), { employee: pf, contractor: cf });
                const f = pf && (pf.forms || []).find((x) => !x.draft);
                if (f) {
                    const pdf = await call('GET', `${G}/tax-forms/employee/${P.cashier.uid}/${f.id}/pdf`, payroll);
                    check('the W-2 comes through the app as a PDF download', pdf.s === 200 && /application\/pdf/.test(pdf.headers.get('content-type') || '') && pdf.text.startsWith('%PDF-') && /attachment/.test(pdf.headers.get('content-disposition') || ''), { status: pdf.s, type: pdf.headers.get('content-type') });
                    check('an employee cannot use the payroll download route (403)', (await call('GET', `${G}/tax-forms/employee/${P.cashier.uid}/${f.id}/pdf`, cashier)).s === 403);
                    const mine = await call('GET', `${G}/my/tax-forms`, cashier);
                    const mineIds = new Set((mine.b.data || []).map((x) => x.id));
                    check('the cashier sees their own W-2 in "my tax forms"', mine.s === 200 && mineIds.has(f.id), mine.b);
                    const ownPdf = await call('GET', `${G}/my/tax-forms/${f.id}/pdf`, cashier);
                    check('and downloads it', ownPdf.s === 200 && ownPdf.text.startsWith('%PDF-'), ownPdf.s);
                    check('the server cannot download the cashier\'s W-2 (404)', (await call('GET', `${G}/my/tax-forms/${f.id}/pdf`, server)).s === 404);
                    if (cf && cf.forms.length) {
                        check('a contractor\'s form id on an employee finds nothing (404)', (await call('GET', `${G}/tax-forms/employee/${P.cashier.uid}/${cf.forms[0].id}/pdf`, payroll)).s === 404);
                        const cpdf = await call('GET', `${G}/tax-forms/contractor/${cId}/${cf.forms[0].id}/pdf`, payroll);
                        check('the 1099 comes through the app as a PDF', cpdf.s === 200 && cpdf.text.startsWith('%PDF-'), cpdf.s);
                    }
                }
            }
            ctx.skip('Filing W-2 and 1099 forms with the IRS', 'the provider files them; only a real provider account can prove it');
        }

        // ---------------------------------------------------------------------------------------- garnishment
        ctx.section('A garnishment (court-ordered deduction)');
        check('HR cannot record a garnishment (403)', (await call('POST', `${G}/garnishments`, hr, {})).s === 403);
        check('an employee cannot read garnishments (403)', (await call('GET', `${G}/garnishments`, cashier)).s === 403);
        const gBad = await call('POST', `${G}/garnishments`, payroll, { userId: P.stocker.uid, type: 'creditor' });
        check('an order with no case number, amount or start date is refused with each reason (400)', gBad.s === 400 && Array.isArray(gBad.b.errors) && gBad.b.errors.length >= 3, gBad.b);
        const caseNo = `TX-${state.run}-${stamp}`;
        const g = await call('POST', `${G}/garnishments`, payroll, { userId: P.stocker.uid, type: 'creditor', caseNumber: caseNo, amountType: 'amount', value: 25, limits: { perPayPeriodMax: 40, totalAmount: 500 }, startDate: today, payeeNotes: 'Travis County court' });
        if (check('the payroll admin records a $25 per pay period order for the stock clerk and it is sent to the provider', g.s === 201 && g.b.garnishment.status === 'active' && g.b.garnishment.provider.state === 'sent' && /compliance advisor/i.test(g.b.note || ''), g.b)) {
            const gid = g.b.garnishment.id;
            const seen = await call('GET', `${G}/garnishments`, hr);
            const row = (seen.b.data || []).find((x) => x.id === gid);
            check('HR sees the order and its case number but may not change it', Boolean(row) && row.caseNumber === caseNo && seen.b.can.write === false && seen.b.can.readCase === true, row);
            check('the stored (encrypted) case number is never in a response', !seen.text.includes('caseNumberEnc'));
            const future = await call('POST', `${G}/garnishments`, payroll, { userId: P.stocker.uid, type: 'tax_levy', levyAuthority: 'state', caseNumber: `LEVY-${stamp}`, amountType: 'percent', value: 10, startDate: ctx.addDays(today, 20), endDate: ctx.addDays(today, 21) });
            check('an order that starts later is kept as scheduled and is not sent yet', future.s === 201 && future.b.garnishment.status === 'scheduled' && future.b.garnishment.provider.state === 'not_sent', future.b);
            if (future.s === 201) {
                check('it cannot be sent before it starts (409)', (await call('POST', `${G}/garnishments/${future.b.garnishment.id}/send`, payroll, {})).s === 409);
                await call('POST', `${G}/garnishments/${future.b.garnishment.id}/end`, payroll, { reason: 'end-to-end run tidy-up' });
            }
            check('an end date before the start is refused (400)', (await call('POST', `${G}/garnishments/${gid}/end`, payroll, { endDate: ctx.addDays(today, -40) })).s === 400);
            // ended again so that later payrolls of this company are not changed by this run
            const ended = await call('POST', `${G}/garnishments/${gid}/end`, payroll, { reason: 'Order paid off' });
            check('ending the order switches the deduction off at the provider', ended.s === 200 && ended.b.planned === false && ended.b.garnishment.status === 'ended' && ended.b.garnishment.provider.active === false, ended.b);
            check('ending it twice is refused (409)', (await call('POST', `${G}/garnishments/${gid}/end`, payroll, {})).s === 409);
        }
        check('an unknown garnishment is a 404', (await call('POST', `${G}/garnishments/does-not-exist/send`, payroll, {})).s === 404);

        // ---------------------------------------------------------------------------------- benefit deductions
        ctx.section('Benefit deductions and state tax answers');
        check('a bad date on the deduction preview is refused (400)', (await call('GET', `${G}/benefit-deductions/preview?periodEnd=soon`, payroll)).s === 400);
        const pre = await call('GET', `${G}/benefit-deductions/preview`, payroll);
        if (check('the preview of benefit deductions to send reads', pre.s === 200 && pre.b.totals && typeof pre.b.fingerprint === 'string' && Array.isArray(pre.b.rows), pre.b)) {
            ctx.info(`${pre.b.rows.length} deduction row(s): ${JSON.stringify(pre.b.totals)}`);
            check('HR cannot send benefit deductions (403)', (await call('POST', `${G}/benefit-deductions/send`, hr, { confirm: true })).s === 403);
            check('sending without the confirmation is refused (400)', (await call('POST', `${G}/benefit-deductions/send`, payroll, { periodEnd: pre.b.periodEnd, fingerprint: pre.b.fingerprint })).s === 400);
            const stale = await call('POST', `${G}/benefit-deductions/send`, payroll, { confirm: true, periodEnd: pre.b.periodEnd, fingerprint: 'not-the-preview' });
            check('sending something other than what was previewed is refused (409)', stale.s === 409 && stale.b.code === 'changed', stale.b);
            const send = await call('POST', `${G}/benefit-deductions/send`, payroll, { confirm: true, periodEnd: pre.b.periodEnd, fingerprint: pre.b.fingerprint });
            check('sending the reviewed deductions works and leaves nothing to change', send.s === 200 && send.b.failed === 0 && send.b.sent === pre.b.changes && send.b.after.changes === 0, send.b);
            if (!pre.b.rows.length) ctx.info('nobody is enrolled in a benefit plan yet at this point of the run, so there was nothing to send');
        }
        const st = await call('GET', `${G}/people/${P.cashier.uid}/state-tax`, payroll);
        check('the provider\'s state tax questions for the cashier read (Texas has no state income tax form)', st.s === 200 && st.b.inGusto === true && Array.isArray(st.b.states), st.b);
        check('state tax answers for an unknown person are a 404, and a bad state a 400', (await call('GET', `${G}/people/does-not-exist/state-tax`, payroll)).s === 404 && (await call('PUT', `${G}/people/${P.cashier.uid}/state-tax`, payroll, { state: 'Texas', answers: {} })).s === 400);
        const hooks = await call('GET', `${G}/webhooks/health`, payroll);
        check('the health of provider notifications reads', hooks.s === 200, hooks.b);

        // -------------------------------------------------------------------------------- past-payroll import
        ctx.section('Past payroll from a file: check, save, undo');
        const I = `${U}/payroll-import`;
        const opts = await call('GET', `${I}/options`, payroll);
        if (check('the payroll admin gets the column list and a template', opts.s === 200 && opts.b.columns.length === 11 && typeof opts.b.template === 'string' && opts.b.maxRows > 0, opts.b)) {
            const head = opts.b.template.split(/\r?\n/)[0];
            // a pay day eight weeks ago, before this company used the provider
            const oldPay = ctx.addDays(today, -56); const oldStart = ctx.addDays(today, -69); const oldEnd = ctx.addDays(today, -63);
            const line = (p, gross, net, tax, er, ded, hours, chk = '') => [p.employeeId, oldPay, oldStart, oldEnd, gross, net, tax, er, ded, hours, chk].join(',');
            const GOOD = [head, line(P.cashier, '740.00', '592.00', '118.00', '56.61', '30.00', '40', '10452'), line(P.server, '"$1,480.00"', '1184.00', '296.00', '113.22', '0', '74')].join('\r\n');
            const BAD = [head, line(P.cashier, '740.00', '592.00', '118.00', '56.61', '30.00', '40'), line({ employeeId: 'NOBODY-999' }, '100', '90', '10', '5', '0', '8'), line(P.cashier, '100', '90', '10', '5', '0', '8')].join('\n');
            check('HR and an employee cannot check or save an import (403)', (await call('POST', `${I}/preview`, hr, { csv: GOOD })).s === 403 && (await call('POST', `${I}/commit`, hr, { csv: GOOD })).s === 403 && (await call('POST', `${I}/preview`, cashier, { csv: GOOD })).s === 403);
            const empty = await call('POST', `${I}/preview`, payroll, {});
            check('an empty file is reported as empty', empty.s === 200 && empty.b.ok === false && /empty/i.test((empty.b.fileErrors || [])[0] || ''), empty.b);
            const badPrev = await call('POST', `${I}/preview`, payroll, { csv: BAD });
            check('the check lists the problems row by row: an unknown employee number, and the same person and pay date twice', badPrev.s === 200 && badPrev.b.ok === false && badPrev.b.rows.length === 3 && badPrev.b.errorRows === 2 && /No person/.test(badPrev.b.rows[1].errors[0] || '') && /Same person and pay date/.test(badPrev.b.rows[2].errors[0] || ''), (badPrev.b.rows || []).map((r) => r.errors));
            const refused = await call('POST', `${I}/commit`, payroll, { csv: BAD });
            check('a file with any bad row is refused whole (400)', refused.s === 400 && refused.b.success === false, refused.b);
            const good = await call('POST', `${I}/preview`, payroll, { csv: GOOD });
            // 740.00 + 1,480.00 = 2,220.00 gross; employer cost = gross + employer taxes = 2,220.00 + 169.83
            if (check('a clean file of two rows checks out: $2,220.00 gross, $1,776.00 net, $2,389.83 employer cost', good.s === 200 && good.b.ok === true && good.b.totals.rows === 2 && good.b.totals.people === 2 && good.b.totals.gross === 2220 && good.b.totals.net === 1776 && good.b.totals.employerCost === 2389.83 && good.b.errorsCsv === null, good.b.ok ? good.b.totals : (good.b.rows || []).map((r) => r.errors))) {
                const cost0 = await call('GET', `${G}/payroll/cost?from=${oldPay}&to=${oldPay}`, payroll);
                check('checking a file saves nothing', cost0.s === 200 && cost0.b.totals.people === 0, cost0.b.totals);
                check('saving with totals that are not the ones previewed is refused (409)', (await call('POST', `${I}/commit`, payroll, { csv: GOOD, expectRows: 3 })).s === 409 && (await call('POST', `${I}/commit`, payroll, { csv: GOOD, expectRows: 2, expectGross: 1 })).s === 409);
                const saved = await call('POST', `${I}/commit`, payroll, { csv: GOOD, fileName: 'old-payroll.csv', note: `end-to-end run ${state.run}`, expectRows: 2, expectGross: 2220 });
                if (check('the payroll admin saves the import (201)', saved.s === 201 && saved.b.batch.status === 'saved' && saved.b.batch.rows === 2 && saved.b.batch.totals.gross === 2220, saved.b)) {
                    const id = saved.b.batch.id;
                    const detail = await call('GET', `${I}/batches/${id}`, payroll);
                    const cRow = (detail.b.rows || []).find((r) => r.userId === P.cashier.uid) || {};
                    check('the import reads back row by row, marked as imported, with the check number', detail.s === 200 && detail.b.rows.length === 2 && detail.b.rows.every((r) => r.source === 'import') && cRow.gross === 740 && cRow.net === 592 && cRow.hours === 40 && cRow.payDate === oldPay && String(cRow.checkNumber) === '10452', detail.b);
                    check('the list of imports shows it; HR cannot read it (403)', (await call('GET', `${I}/batches`, payroll)).b.data.some((x) => x.id === id && x.status === 'saved') && (await call('GET', `${I}/batches/${id}`, hr)).s === 403);
                    const cost1 = await call('GET', `${G}/payroll/cost?from=${oldPay}&to=${oldPay}`, payroll);
                    check('the payroll cost report counts the imported pay: $2,220.00 for two people', cost1.s === 200 && cost1.b.totals.gross === 2220 && cost1.b.totals.people === 2, cost1.b.totals);
                    const dupPrev = await call('POST', `${I}/preview`, payroll, { csv: GOOD });
                    check('the same pay cannot be imported twice', dupPrev.b.ok === false && dupPrev.b.rows.every((r) => /already imported/.test(r.errors[0] || '')) && (await call('POST', `${I}/commit`, payroll, { csv: GOOD })).s === 400, (dupPrev.b.rows || []).map((r) => r.errors));
                    const stubsAfter = await call('GET', `${G}/my/pay-stubs`, cashier);
                    ctx.info(`imported pay on the employee's own pay-stub list: ${stubsAfter.b.data.some((s) => /import/.test(JSON.stringify(s))) ? 'shown' : 'not shown (stubs come from the provider only)'}`);
                    const undo = await call('DELETE', `${I}/batches/${id}`, payroll);
                    check('undo takes the two rows out again', undo.s === 200 && undo.b.removedRows === 2 && undo.b.batch.status === 'undone', undo.b);
                    const cost2 = await call('GET', `${G}/payroll/cost?from=${oldPay}&to=${oldPay}`, payroll);
                    check('the cost report no longer counts it', cost2.s === 200 && cost2.b.totals.gross === 0, cost2.b.totals);
                    check('undo twice is refused (409), and the record of the import is kept as undone', (await call('DELETE', `${I}/batches/${id}`, payroll)).s === 409 && (await call('GET', `${I}/batches`, payroll)).b.data.some((x) => x.id === id && x.status === 'undone'));
                    check('after the undo the same file checks out clean again', (await call('POST', `${I}/preview`, payroll, { csv: GOOD })).b.ok === true);
                }
            }
        }

        // ------------------------------------------------------------------------------------------- the rest
        ctx.skip('The accounting journal for this payroll', 'no route builds or shows the journal on its own: it is made only inside a sync to a connected accounting system (services/connectors/journal.js), which needs that system\'s credentials');
        ctx.skip('Money actually moving (direct deposit, tax payments, filings)', 'the mock provider only records the payroll; a real run needs payroll provider credentials');
        state.ids.payroll = { companyUuid: conn.companyUuid, regular: { payrollUuid: payrollId, periodStart: lastWeekStart, periodEnd: lastWeekEnd, payDate: checkDate, gross: wantGross, perPerson: Object.fromEntries(everyone.map((k) => [k, want[k].gross])) }, bonus: bonusId ? { payrollUuid: bonusId, userKey: 'cashier', amount: bonus } : null };
        ctx.save();
    }
};
