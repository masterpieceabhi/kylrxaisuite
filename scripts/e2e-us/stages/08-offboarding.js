/**
 * Stage 08: a person leaves and comes back.
 *
 * Lena Park ('leaver', hourly, reports to the store manager) gives notice. HR records the planned last day, the
 * offboarding checklist is worked through, Lena fills in her exit interview (HR and the owner read it, her manager
 * cannot), her unused paid time off is paid out (HR asks, payroll approves and pays), her employment ends, her access
 * is cut, COBRA and equipment are followed up, the reports count the exit, and then she is rehired with the same
 * employee number. A throwaway person covers the cancel path and the "not eligible for rehire" path.
 *
 * The app has no route that brings a planned last day forward or makes it effective at once: a planned exit takes
 * effect by itself when the calendar reaches the last day. A run cannot wait for that, so after the notice period
 * steps the planned exit is cancelled and recorded again with a last day of yesterday (which takes effect at once).
 *
 * The stage copes with being run again on the same company (--reuse): a Lena who is still gone or still leaving from
 * an earlier run is brought back first.
 */
module.exports = {
    id: '08',
    title: 'Offboarding and rehire',
    covers: ['US-B09', 'US-C03', 'US-C05', 'US-E07', 'US-G06', 'US-H07', 'US-I05', 'US-I06', 'US-J02'],
    async run(ctx) {
        const { call, check, U, state } = ctx;
        const run = state.run;
        const stamp = String(Date.now()).slice(-6);
        const ids = state.ids.offboarding = state.ids.offboarding || {};
        const lena = state.people.leaver;
        const owner = await ctx.as('owner');
        const hr = await ctx.as('hr');
        const payroll = await ctx.as('payroll');
        const manager = await ctx.as('manager');
        const cashier = await ctx.as('cashier');
        const auditor = await ctx.as('auditor');

        const leavingList = async (token = hr) => call('GET', `${U}/offboarding`, token);
        const rowOf = (r, uid) => (r.b.data || []).find((x) => x.userId === uid);
        const first = await leavingList();
        if (!check('[needed] HR opens the list of people who are leaving', first.s === 200 && Array.isArray(first.b.data) && /^\d{4}-\d{2}-\d{2}$/.test(String(first.b.today)), first.text.slice(0, 300))) return;
        const today = first.b.today; // the company's own date (its time zone), which is what the app compares last days with
        const yesterday = ctx.addDays(today, -1);
        const plannedLastDay = ctx.addDays(today, 7);
        // When an earlier run on this company already rehired Lena today, her start date is today, so her last day cannot be
        // yesterday: it is today. The reports count a person as gone from the day after the last day, so those checks wait.
        const sameDay = ids.rehiredOn === today;
        const finalLastDay = sameDay ? today : yesterday;
        const lastDayWord = sameDay ? 'today' : 'yesterday';

        /** The sign-in the pages use (Firebase; here the local Auth emulator). Gives a token, or null when it is refused. */
        async function pageSignIn(email, password) {
            const host = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
            const res = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
            const j = await res.json().catch(() => ({}));
            return j.idToken || null;
        }

        /** After a rehire the person signs in with the one-time password and chooses their own again */
        async function takeBackAccess(person, temporaryPassword, label) {
            const token = await pageSignIn(person.email, temporaryPassword);
            if (!token) { check(`${label} signs in with the new temporary password`, false, 'the sign-in was refused'); return false; }
            const status = await call('GET', '/api/auth/password-status', token);
            let chosen = person.password;
            let changed = await call('POST', '/api/auth/change-password', token, { currentPassword: temporaryPassword, newPassword: chosen });
            if (changed.s !== 200) { chosen = `E2e-Back#${stamp}pass`; changed = await call('POST', '/api/auth/change-password', token, { currentPassword: temporaryPassword, newPassword: chosen }); }
            check(`${label} signs in with the new temporary password, is told to change it and does`, status.s === 200 && status.b.mustChangePassword === true && changed.s === 200, { status: status.b, changed: changed.b });
            if (changed.s === 200) { person.password = chosen; ctx.forget(person.key); ctx.save(); }
            if (changed.s !== 200) return false;
            return true;
        }

        // ------------------------------------------------------------------------------- an earlier run on this company
        const before = rowOf(first, lena.uid);
        if (before) {
            ctx.section('Lena is still leaving or gone from an earlier run: she is brought back first');
            if (/terminated/i.test(String(before.status))) {
                const back = await call('POST', `${U}/offboarding/${lena.uid}/rehire`, hr, { startDate: today });
                if (check('[needed] Lena is rehired so the stage can start again', back.s === 201 && back.b.temporaryPassword, back.b)) { ids.rehiredOn = today; ctx.save(); await takeBackAccess(lena, back.b.temporaryPassword, 'Lena'); }
                else return;
            } else {
                const undo = await call('POST', `${U}/offboarding/${lena.uid}/cancel`, hr, {});
                if (!check('[needed] the planned exit from the earlier run is cancelled', undo.s === 200, undo.b)) return;
            }
        }
        let lenaToken = null;
        try { lenaToken = await ctx.as('leaver', { renew: true }); } catch (_) { /* handled just below */ }
        if (!lenaToken || (await call('GET', `${U}/me/profile`, lenaToken)).s !== 200) {
            // an earlier run stopped between her rehire and her new password: HR gives her a fresh temporary password
            ctx.section('Lena cannot sign in after an interrupted earlier run: HR reissues her access');
            const again = await call('POST', `${U}/team-import/people/${lena.uid}/reissue`, hr, { method: 'password' });
            const temp = again.b.temporaryPassword || (again.b.access && again.b.access.temporaryPassword);
            if (!check('[needed] HR reissues a temporary password for Lena', again.s === 200 && temp, { s: again.s, keys: Object.keys(again.b) })) return;
            if (!(await takeBackAccess(lena, temp, 'Lena'))) return;
            lenaToken = await ctx.as('leaver', { renew: true });
        }

        // ------------------------------------------------------------------- what Lena has: paid time off and equipment
        ctx.section('Before she leaves: paid time off that is paid out at the end, a key, health cover');
        const pols = await call('GET', `${U}/leave/policies`, hr);
        let payoutPolicy = (pols.b.data || []).find((p) => p.payoutAtTermination && p.type === 'pto');
        if (!payoutPolicy) {
            const made = await call('POST', `${U}/leave/policies`, hr, { name: `Vacation paid at exit ${run}`, type: 'pto', accrual: { method: 'front_load', grantHours: 40 }, payoutAtTermination: true, notes: 'Made by the end-to-end run for the offboarding stage' });
            if (check('a PTO policy marked "paid out when the person leaves" is added', made.s === 201 && made.b.policy && made.b.policy.payoutAtTermination === true, made.b)) payoutPolicy = made.b.policy;
        } else check('a PTO policy marked "paid out when the person leaves" is already there', true);
        ids.payoutPolicyId = payoutPolicy && payoutPolicy.id;
        let preview = await call('GET', `${U}/leave/payouts/preview/${lena.uid}`, payroll);
        if (payoutPolicy && preview.s === 200 && !(preview.b.hours > 0)) {
            const add = await call('POST', `${U}/leave/adjustments`, hr, { userId: lena.uid, policyId: payoutPolicy.id, hours: 16, reason: 'Unused vacation carried in for the end-to-end run' });
            check('HR adds 16 hours of unused vacation to Lena (she had none left)', add.s === 201, add.b);
            preview = await call('GET', `${U}/leave/payouts/preview/${lena.uid}`, payroll);
        }

        const perf = state.ids.performance || {};
        let assetId = perf.leaverAssetId || null;
        if (assetId) {
            const a = await call('GET', `${U}/assets/${assetId}`, hr);
            if (!(a.s === 200 && a.b.item && a.b.item.status === 'assigned' && a.b.item.assignedTo === lena.uid)) assetId = null;
        }
        if (!assetId) {
            // anything she already holds (from an earlier stage or an earlier run of this one) will do
            const all = await call('GET', `${U}/assets`, hr);
            const hers = (all.b.data || []).find((a) => a.status === 'assigned' && a.assignedTo === lena.uid);
            if (hers) assetId = hers.id;
        }
        let assetName = null;
        if (!assetId) {
            assetName = `Cafe back-door key ${run}-${stamp}`;
            const made = await call('POST', `${U}/assets`, hr, { name: assetName, category: 'Keys', tag: `KEY-${run}-${stamp}`, condition: 'good', cost: 25 });
            check('HR adds a key to the equipment list', made.s === 201 && made.b.item && made.b.item.id, made.b);
            assetId = made.b.item && made.b.item.id;
            const given = await call('POST', `${U}/assets/${assetId}/assign`, hr, { userId: lena.uid, condition: 'good', note: 'Opens the cafe on early shifts' });
            check('and gives it to Lena', given.s === 200 && given.b.item && given.b.item.assignedTo === lena.uid, given.b);
        } else {
            const a = await call('GET', `${U}/assets/${assetId}`, hr);
            assetName = a.b.item.name;
            check('Lena still holds the equipment an earlier stage gave her', true);
        }
        ids.assetId = assetId;
        const mine = await call('GET', `${U}/assets/mine`, lenaToken);
        check('Lena sees the item in her own equipment list', mine.s === 200 && (mine.b.data || []).some((a) => a.id === assetId), mine.text.slice(0, 300));
        const confirmed = await call('POST', `${U}/assets/${assetId}/acknowledge`, lenaToken, {});
        check('and confirms she has it', confirmed.s === 200 || confirmed.s === 409, confirmed.b);

        // health cover, so that leaving is a COBRA qualifying event
        const enrolledBefore = await call('GET', `${U}/benefits/enrollments`, hr);
        let hasCover = enrolledBefore.s === 200 && (enrolledBefore.b.data || []).some((e) => e.userId === lena.uid && !e.endDate && /active/i.test(String(e.status || 'active')) && (e.elections || []).some((el) => !el.waived && ['medical', 'dental', 'vision'].includes(el.type)));
        if (!hasCover) {
            const plan = await call('POST', `${U}/benefits/plans`, hr, { name: `Medical basic ${run}-${stamp}`, type: 'medical', carrier: 'Test Health', planYear: today.slice(0, 4), payPeriodsPerYear: 52, costs: { employee_only: { employee: 30, employer: 120 } }, eligibility: { waitingDays: 0 } });
            const planId = plan.b.plan && plan.b.plan.id;
            const enrol = await call('POST', `${U}/benefits/enrollments`, hr, { userId: lena.uid, reason: 'Enrolled by HR for the end-to-end run', effectiveDate: ctx.addDays(today, -30), elections: [{ planId, tier: 'employee_only' }] });
            hasCover = check('HR enrolls Lena in a medical plan (so COBRA applies when she leaves)', plan.s === 201 && enrol.s === 201, { plan: plan.s === 201 ? 'ok' : plan.b, enrol: enrol.b });
            ids.medicalPlanId = planId || null;
        }

        // ------------------------------------------------------------------------------------- who may record an exit
        ctx.section('Who may record that someone is leaving');
        const exit = { lastDay: plannedLastDay, type: 'resignation', reason: 'Moving to another city', rehireEligible: true, notes: 'Gave one week of notice' };
        check('an employee cannot record an exit (403)', (await call('POST', `${U}/offboarding/${lena.uid}/terminate`, cashier, exit)).s === 403);
        check('her manager cannot record it either (403)', (await call('POST', `${U}/offboarding/${lena.uid}/terminate`, manager, exit)).s === 403);
        check('the auditor reads the leaving list but cannot record an exit (403)', (await leavingList(auditor)).s === 200 && (await call('POST', `${U}/offboarding/${lena.uid}/terminate`, auditor, exit)).s === 403);
        check('no token is refused (401)', (await call('POST', `${U}/offboarding/${lena.uid}/terminate`, null, exit)).s === 401);
        check('HR cannot end their own employment (403)', (await call('POST', `${U}/offboarding/${state.people.hr.uid}/terminate`, hr, exit)).s === 403);
        const badType = await call('POST', `${U}/offboarding/${lena.uid}/terminate`, hr, { ...exit, type: 'vanished' });
        check('an unknown kind of exit is refused (400)', badType.s === 400, badType.b);
        const tooEarly = await call('POST', `${U}/offboarding/${lena.uid}/terminate`, hr, { ...exit, lastDay: ctx.addDays(today, -400) });
        check('a last day before the start date is refused (400)', tooEarly.s === 400, tooEarly.b);
        const noReason = await call('POST', `${U}/offboarding/${lena.uid}/terminate`, hr, { ...exit, reason: '' });
        check('an exit without a reason is refused (400)', noReason.s === 400, noReason.b);
        const noSummaryYet = await call('GET', `${U}/offboarding/${lena.uid}/summary`, hr);
        check('there is no offboarding summary for someone who is not leaving (409)', noSummaryYet.s === 409, noSummaryYet.b);

        // --------------------------------------------------------------------------------------- HR starts offboarding
        ctx.section('HR records Lena\'s resignation with a last day next week');
        const started = await call('POST', `${U}/offboarding/${lena.uid}/terminate`, hr, exit);
        if (!check('[needed] the planned exit is recorded and does not take effect yet', started.s === 201 && started.b.immediate === false && started.b.termination && started.b.termination.lastDay === plannedLastDay, started.b)) return;
        check('the I-9 keep-until date is worked out at once', /^\d{4}-\d{2}-\d{2}$/.test(String(started.b.termination.i9RetainUntil)) && started.b.termination.i9RetainUntil > plannedLastDay, started.b.termination);
        const twice = await call('POST', `${U}/offboarding/${lena.uid}/terminate`, hr, exit);
        check('recording it a second time is refused (409)', twice.s === 409, twice.b);
        const listed = await leavingList();
        const row = rowOf(listed, lena.uid) || {};
        check('Lena is on the leaving list with her last day, the kind of exit and her checklist progress', row.lastDay === plannedLastDay && row.type === 'resignation' && /terminating/i.test(String(row.status)) && row.listId && row.progress, row);
        check('her manager cannot open the leaving list (403)', (await leavingList(manager)).s === 403);
        const stillIn = await call('GET', `${U}/me/profile`, lenaToken);
        check('Lena still signs in and works during her notice', stillIn.s === 200, stillIn.b);

        // ---------------------------------------------------------------------------------------------- the checklist
        ctx.section('The offboarding checklist');
        const lists = await call('GET', `${U}/checklists/person/${lena.uid}`, hr);
        const off = (lists.b.lists || []).find((l) => l.kind === 'offboarding');
        if (check('an offboarding checklist appears for Lena, counted from her last day', lists.s === 200 && off && off.anchorDate === plannedLastDay && (off.tasks || []).length >= 8, lists.text.slice(0, 400))) {
            ids.offboardingListId = off.id;
            const task = (key) => off.tasks.find((t) => t.id === key || t.key === key) || {};
            const tick = (token, t, status, note) => call('PUT', `${U}/checklists/person/${lena.uid}/${off.id}/tasks/${t.id}`, token, { status, note });
            const titles = off.tasks.map((t) => t.title).join(' | ');
            check('it covers hand-over, equipment, access, final pay, unused leave, COBRA notice and the I-9', /Hand over/.test(titles) && /equipment/i.test(titles) && /access/i.test(titles) && /final paycheck/i.test(titles) && /unused leave/i.test(titles) && /COBRA/.test(titles) && /I-9/.test(titles), titles);
            const handover = off.tasks.find((t) => t.assignee === 'manager');
            const hrTask = off.tasks.find((t) => /final timesheet/i.test(t.title)) || off.tasks.find((t) => t.assignee === 'hr');
            const optional = off.tasks.find((t) => /exit conversation/i.test(t.title)) || task('exit_interview');
            if (handover) {
                check('an employee cannot tick a task on Lena\'s list (403)', (await tick(cashier, handover, 'done')).s === 403);
                check('Lena cannot tick her manager\'s task (403)', (await tick(lenaToken, handover, 'done')).s === 403);
                const done = await tick(manager, handover, 'done', 'Opening routine handed to Sofia');
                check('her manager ticks the hand-over task', done.s === 200, done.b);
                check('her manager cannot tick an HR task (403)', (await tick(manager, hrTask, 'done')).s === 403);
            }
            const hrDone = await tick(hr, hrTask, 'done', 'Hours checked up to the last shift');
            check('HR ticks the final timesheet task', hrDone.s === 200, hrDone.b);
            const badStatus = await tick(hr, hrTask, 'finished');
            check('a made-up task status is refused (400)', badStatus.s === 400, badStatus.b);
            if (optional && optional.id) {
                const skipped = await tick(hr, optional, 'skipped', 'She filled in the form herself');
                check('HR skips the optional exit conversation with a note', skipped.s === 200, skipped.b);
            }
            const extra = await call('POST', `${U}/checklists/person/${lena.uid}/${off.id}/tasks`, hr, { title: 'Return the cafe apron', assignee: 'employee', dueDate: plannedLastDay, required: false });
            check('HR adds a task of its own for Lena', extra.s === 201 && extra.b.task && extra.b.task.id, extra.b);
            check('her manager cannot add tasks (403)', (await call('POST', `${U}/checklists/person/${lena.uid}/${off.id}/tasks`, manager, { title: 'Extra', assignee: 'hr' })).s === 403);
            const hers = await call('GET', `${U}/checklists/mine`, lenaToken);
            const herOff = (hers.b.lists || []).find((l) => l.kind === 'offboarding');
            check('Lena sees only her own tasks of the offboarding list', hers.s === 200 && herOff && herOff.tasks.length >= 1 && herOff.tasks.every((t) => t.assignee === 'employee') && herOff.tasks.some((t) => /apron/i.test(t.title)), hers.text.slice(0, 400));
            if (extra.b.task) {
                const own = await tick(lenaToken, extra.b.task, 'done');
                check('and ticks hers', own.s === 200, own.b);
            }
            const after = await call('GET', `${U}/checklists/person/${lena.uid}`, hr);
            const offAfter = (after.b.lists || []).find((l) => l.kind === 'offboarding') || { tasks: [] };
            const doneCount = offAfter.tasks.filter((t) => t.done || t.status === 'done').length;
            check('the list now shows the ticked tasks as done and who is next', doneCount >= 3 && offAfter.tasks.some((t) => !t.done && t.status !== 'done' && !t.skipped), { doneCount, summary: offAfter.summary });
            const todo = await call('GET', `${U}/checklists/overview`, hr);
            check('HR\'s company to-do list shows Lena\'s open offboarding tasks', todo.s === 200 && (todo.b.data || []).some((t) => t.userId === lena.uid && t.kind === 'offboarding'), todo.text.slice(0, 300));
            check('an employee cannot open the company to-do list (403)', (await call('GET', `${U}/checklists/overview`, cashier)).s === 403);
            const progress = rowOf(await leavingList(), lena.uid) || {};
            check('the leaving list shows her checklist progress moving', progress.progress && JSON.stringify(progress.progress) !== JSON.stringify(row.progress), { before: row.progress, now: progress.progress });
        }

        // ---------------------------------------------------------------------------------------- the exit interview
        ctx.section('Exit interview: Lena answers, HR and the owner read, her manager cannot');
        const questions = await call('GET', `${U}/exit-interviews/questions`, hr);
        const qs = questions.b.questions || [];
        check('HR sees the exit interview questions, in English and Spanish', questions.s === 200 && qs.length >= 5 && qs.some((q) => q.type === 'reason') && qs.every((q) => q.text && q.text.en) && qs.some((q) => q.text.es), questions.text.slice(0, 300));
        check('her manager cannot open the question list (403)', (await call('GET', `${U}/exit-interviews/questions`, manager)).s === 403);
        const noReasonQ = await call('PUT', `${U}/exit-interviews/questions`, hr, { questions: qs.filter((q) => q.type !== 'reason') });
        check('a question list without the "reason for leaving" question is refused (400)', noReasonQ.s === 400, noReasonQ.b);
        const extraQ = { id: `e2e_${stamp}`, type: 'text', required: false, text: { en: 'What would have made you stay?', es: '¿Qué le habría hecho quedarse?' } };
        const edited = await call('PUT', `${U}/exit-interviews/questions`, hr, { questions: [...qs.filter((q) => !/^e2e_/.test(q.id)), extraQ] });
        check('HR adds a question of its own', edited.s === 200 && (edited.b.questions || []).some((q) => q.id === extraQ.id), edited.b);

        const form = await call('GET', `${U}/exit-interview/me`, lenaToken);
        const fq = form.b.questions || [];
        check('Lena opens her exit interview: it is open until her last day and includes HR\'s new question', form.s === 200 && form.b.status === 'open' && form.b.lastDay === plannedLastDay && fq.some((q) => q.id === extraQ.id) && fq.every((q) => q.text.es), form.text.slice(0, 300));
        const notLeaving = await call('GET', `${U}/exit-interview/me`, cashier);
        check('someone who is not leaving has no exit interview to fill in', notLeaving.s === 200 && notLeaving.b.status === 'not_leaving' && (notLeaving.b.questions || []).length === 0 && (await call('PUT', `${U}/exit-interview/me`, cashier, { answers: { reason: 'other' } })).s === 409, notLeaving.b);
        const reasonQ = fq.find((q) => q.type === 'reason') || { id: 'reason' };
        const answers = { [reasonQ.id]: 'commute_relocation' };
        for (const q of fq) {
            if (q.id === reasonQ.id) continue;
            if (q.type === 'rating') answers[q.id] = 4;
            else if (q.type === 'yesno') answers[q.id] = true;
            else if (q.type === 'text') answers[q.id] = q.id === extraQ.id ? 'A store closer to my new home' : `Lena on ${q.id}: the morning crew`;
            else if (q.type === 'choice' && q.options && q.options[0]) answers[q.id] = q.options[0].value;
        }
        const incomplete = await call('PUT', `${U}/exit-interview/me`, lenaToken, { answers: { [extraQ.id]: 'only this' } });
        check('answers that leave out a required question are refused (400)', incomplete.s === 400, incomplete.b);
        const badRating = await call('PUT', `${U}/exit-interview/me`, lenaToken, { answers: { ...answers, [(fq.find((q) => q.type === 'rating') || {}).id || 'overall']: 9 } });
        check('a rating outside 1 to 5 is refused (400)', badRating.s === 400, badRating.b);
        const sent = await call('PUT', `${U}/exit-interview/me`, lenaToken, { answers });
        check('Lena sends her answers', sent.s === 200 && sent.b.submittedAt && sent.b.answers && sent.b.answers[reasonQ.id] === 'commute_relocation', sent.b);
        const firstRating = (fq.find((q) => q.type === 'rating') || {}).id;
        const changed = await call('PUT', `${U}/exit-interview/me`, lenaToken, { answers: { ...answers, ...(firstRating ? { [firstRating]: 5 } : {}) } });
        check('and can still change them before her last day', changed.s === 200 && (!firstRating || changed.b.answers[firstRating] === 5), changed.b);

        for (const [who, token] of [['her manager', manager], ['payroll', payroll], ['the auditor', auditor], ['another employee', cashier]]) {
            const one = await call('GET', `${U}/exit-interviews/${lena.uid}`, token);
            const all = await call('GET', `${U}/exit-interviews`, token);
            const sum = await call('GET', `${U}/exit-interviews/summary`, token);
            check(`${who} cannot read Lena's answers, the list or the summary (403)`, one.s === 403 && all.s === 403 && sum.s === 403 && !/morning crew/.test(one.text + all.text + sum.text), { one: one.s, all: all.s, sum: sum.s });
        }
        const hrReads = await call('GET', `${U}/exit-interviews/${lena.uid}`, hr);
        check('HR reads her answers', hrReads.s === 200 && hrReads.b.interview && hrReads.b.interview.answered === true && hrReads.b.interview.source === 'self' && /morning crew/.test(hrReads.text) && /Moving away|commute/i.test(String(hrReads.b.interview.reason)), hrReads.text.slice(0, 400));
        const ownerReads = await call('GET', `${U}/exit-interviews/${lena.uid}`, owner);
        check('the owner reads them too', ownerReads.s === 200 && /morning crew/.test(ownerReads.text), ownerReads.text.slice(0, 200));
        const notes = await call('PUT', `${U}/exit-interviews/${lena.uid}`, hr, { hrNotes: 'Would come back if a store opens near her new home.' });
        check('HR adds its own notes without changing her answers', notes.s === 200 && notes.b.interview && /new home/.test(notes.b.interview.hrNotes) && notes.b.interview.source === 'self' && /morning crew/.test(notes.text), notes.text.slice(0, 300));
        const herView = await call('GET', `${U}/exit-interview/me`, lenaToken);
        check('Lena does not see HR\'s notes', herView.s === 200 && !/Would come back/.test(herView.text), herView.text.slice(0, 200));
        const range = `from=${ctx.addDays(today, -30)}&to=${ctx.addDays(today, 30)}`;
        const interviews = await call('GET', `${U}/exit-interviews?${range}`, hr);
        check('HR\'s list shows Lena as having answered', interviews.s === 200 && (interviews.b.data || []).some((r) => r.userId === lena.uid && r.answered === true && r.lastDay === plannedLastDay), interviews.text.slice(0, 300));
        const reasons = await call('GET', `${U}/exit-interviews/summary?${range}`, hr);
        check('the reasons-for-leaving summary counts her reason and her ratings', reasons.s === 200 && reasons.b.responses >= 1 && (reasons.b.reasons || []).some((r) => r.reason === 'commute_relocation' && r.count >= 1) && (reasons.b.ratings || []).some((r) => r.answers >= 1), reasons.b);
        const reasonsCsv = await call('GET', `${U}/exit-interviews/summary?${range}&format=csv`, hr);
        check('the summary downloads as a CSV file', reasonsCsv.s === 200 && /text\/csv/.test(reasonsCsv.headers.get('content-type') || '') && /attachment/.test(reasonsCsv.headers.get('content-disposition') || '') && /Moving away or the commute/.test(reasonsCsv.text), reasonsCsv.text.slice(0, 300));
        const badRange = await call('GET', `${U}/exit-interviews/summary?from=${today}&to=${ctx.addDays(today, -5)}`, hr);
        check('a date range that ends before it starts is refused (400)', badRange.s === 400, badRange.b);
        const reset = await call('POST', `${U}/exit-interviews/questions/reset`, hr, {});
        check('HR puts the standard question list back', reset.s === 200 && reset.b.customised === false && !(reset.b.questions || []).some((q) => q.id === extraQ.id), reset.b);

        // --------------------------------------------------------------------------------------- offboarding summary
        ctx.section('The offboarding summary');
        const summary = await call('GET', `${U}/offboarding/${lena.uid}/summary`, hr);
        const leaveLine = (summary.b.leave || []).find((l) => l.payoutRequired) || {};
        check('HR sees what is left to finish: last day, kind of exit, unused time off to pay, recent hours, I-9 keep-until date', summary.s === 200 && summary.b.lastDay === plannedLastDay && summary.b.type === 'resignation' && Array.isArray(summary.b.lastTwoWeeks) && summary.b.i9RetainUntil === started.b.termination.i9RetainUntil && summary.b.totalPayoutHours > 0 && leaveLine.payoutHours > 0, summary.b);
        check('the summary says final-pay rules differ by state', /state/i.test((summary.b.notes || []).join(' ')), summary.b.notes);
        check('her manager cannot open the summary (403)', (await call('GET', `${U}/offboarding/${lena.uid}/summary`, manager)).s === 403);
        const teamItems = await call('GET', `${U}/assets`, manager);
        check('her manager sees the equipment she still holds (team view)', teamItems.s === 200 && teamItems.b.scope === 'team' && (teamItems.b.data || []).some((a) => a.id === assetId), teamItems.text.slice(0, 300));
        ctx.skip('The offboarding summary lists equipment still with the person and final pay in dollars', 'GET /offboarding/:id/summary gives time off, hours and the I-9 date only; equipment is read from GET /assets and the payout amount from the payout preview');

        // ------------------------------------------------------------------------------------ unused time-off payout
        ctx.section('Unused time off is paid out: HR asks, payroll approves and pays');
        check('an employee cannot open the payout preview (403)', (await call('GET', `${U}/leave/payouts/preview/${lena.uid}`, cashier)).s === 403);
        check('her manager cannot open it either (403)', (await call('GET', `${U}/leave/payouts/preview/${lena.uid}`, manager)).s === 403);
        preview = await call('GET', `${U}/leave/payouts/preview/${lena.uid}`, payroll);
        const expectedAmount = Math.round(Number(preview.b.hours) * lena.payRate * 100) / 100;
        check(`payroll previews the payout: unused hours at her hourly rate of ${lena.payRate}`, preview.s === 200 && preview.b.canRequest === true && preview.b.hours > 0 && preview.b.hourlyRate === lena.payRate && Math.abs(preview.b.amount - expectedAmount) < 0.011 && preview.b.person && preview.b.person.leaving === true, preview.b);
        check('the preview agrees with the offboarding summary on the hours', Math.abs(Number(preview.b.hours) - Number(summary.b.totalPayoutHours)) < 0.011, { preview: preview.b.hours, summary: summary.b.totalPayoutHours });
        check('an employee cannot ask for a payout (403)', (await call('POST', `${U}/leave/payouts`, cashier, { userId: lena.uid })).s === 403);
        const badAsk = await call('POST', `${U}/leave/payouts`, hr, { userId: lena.uid, reason: 'because' });
        check('a payout with an unknown reason is refused (400)', badAsk.s === 400, badAsk.b);
        // an open payout from an earlier, interrupted run would block this one: withdraw it
        const open = await call('GET', `${U}/leave/payouts?userId=${lena.uid}`, payroll);
        for (const p of (open.b.data || []).filter((x) => ['pending', 'approved'].includes(x.status))) await call('POST', `${U}/leave/payouts/${p.id}/cancel`, hr, {});
        const asked = await call('POST', `${U}/leave/payouts`, hr, { userId: lena.uid, reason: 'termination', note: 'Leaving, last day next week' });
        const payout = asked.b.payout || {};
        if (check('HR asks for the payout: it waits for payroll', asked.s === 201 && payout.status === 'pending' && payout.hours === preview.b.hours && payout.amount === preview.b.amount, asked.b)) {
            ids.payoutId = payout.id;
            const again = await call('POST', `${U}/leave/payouts`, hr, { userId: lena.uid, reason: 'termination' });
            check('a second request while one is waiting is refused (409)', again.s === 409, again.b);
            const hrApproves = await call('POST', `${U}/leave/payouts/${payout.id}/approve`, hr, {});
            check('HR, who asked, cannot approve it (403)', hrApproves.s === 403, hrApproves.b);
            check('the accountant can see it but not approve it (403)', (await call('GET', `${U}/leave/payouts`, await ctx.as('accountant'))).s === 200 && (await call('POST', `${U}/leave/payouts/${payout.id}/approve`, await ctx.as('accountant'), {})).s === 403);
            const tooSoon = await call('POST', `${U}/leave/payouts/${payout.id}/paid`, payroll, { payDate: today });
            check('it cannot be marked paid before it is approved (409)', tooSoon.s === 409, tooSoon.b);
            const approved = await call('POST', `${U}/leave/payouts/${payout.id}/approve`, payroll, {});
            check('payroll approves it', approved.s === 200 && approved.b.payout && approved.b.payout.status === 'approved' && approved.b.payout.approvedBy === state.people.payroll.uid && approved.b.payout.requestedBy === state.people.hr.uid, approved.b);
            const toPay = await call('GET', `${U}/leave/payouts/approved`, payroll);
            check('it is on the list payroll adds to the next pay run, with the amount', toPay.s === 200 && toPay.b.count >= 1 && /Lena Park/.test(toPay.text) && toPay.b.totalAmount >= payout.amount, toPay.text.slice(0, 400));
            const toPayCsv = await call('GET', `${U}/leave/payouts/approved.csv`, payroll);
            check('and downloads as a CSV file', toPayCsv.s === 200 && /text\/csv/.test(toPayCsv.headers.get('content-type') || '') && /Lena Park/.test(toPayCsv.text), toPayCsv.text.slice(0, 300));
            const badDate = await call('POST', `${U}/leave/payouts/${payout.id}/paid`, payroll, { payDate: 'next friday' });
            check('a pay date that is not a date is refused (400)', badDate.s === 400, badDate.b);
            const paid = await call('POST', `${U}/leave/payouts/${payout.id}/paid`, payroll, { payDate: today, payReference: `FINAL-${run}` });
            check('payroll marks it paid with the pay date and reference', paid.s === 200 && paid.b.payout && paid.b.payout.status === 'paid' && paid.b.payout.payReference === `FINAL-${run}`, paid.b);
            const paidTwice = await call('POST', `${U}/leave/payouts/${payout.id}/paid`, payroll, { payDate: today });
            check('it cannot be paid twice (409)', paidTwice.s === 409, paidTwice.b);
            const gone = await call('GET', `${U}/leave/payouts/approved`, payroll);
            check('it has left the to-pay list', gone.s === 200 && !(gone.b.data || []).some((r) => JSON.stringify(r).includes(payout.id)) && !/Lena Park/.test(gone.text), gone.text.slice(0, 300));
            const balances = await call('GET', `${U}/leave/balances/${lena.uid}`, hr);
            const paidPolicies = (payout.lines || []).filter((l) => l.hours > 0).map((l) => l.policyId);
            const left = (balances.b.data || []).filter((r) => paidPolicies.includes(r.policy.id)).map((r) => ({ policy: r.policy.name, balance: r.balance && r.balance.balance }));
            check('her balance on the paid-out policy is now zero', balances.s === 200 && left.length === paidPolicies.length && left.every((r) => r.balance === 0), left);
            const nothing = await call('GET', `${U}/leave/payouts/preview/${lena.uid}`, payroll);
            check('and there is nothing left to pay out', nothing.s === 200 && nothing.b.canRequest === false && nothing.b.hours === 0, nothing.b);
            const history = await call('GET', `${U}/leave/payouts?userId=${lena.uid}&status=paid`, payroll);
            check('the paid payout stays in the payout history', history.s === 200 && (history.b.data || []).some((p) => p.id === payout.id), history.text.slice(0, 200));
        }

        // -------------------------------------------------------------------------------------------- the cancel path
        ctx.section('A planned exit that is taken back (a throwaway person)');
        const domain = state.company.domain;
        const tmpEmail = `temp08-${stamp}@${domain}`;
        const tmpMade = await call('POST', `${U}/employees`, hr, { firstName: 'Tessa', lastName: `Quill${stamp}`, email: tmpEmail, role: 'employee', startDate: ctx.addDays(today, -40), jobTitle: 'Seasonal Helper' });
        const tmp = tmpMade.b.employee || {};
        if (check('a throwaway person is added', tmpMade.s === 201 && tmp.uid && tmp.employeeId, tmpMade.b)) {
            ids.throwawayUid = tmp.uid;
            const t1 = await call('POST', `${U}/offboarding/${tmp.uid}/terminate`, hr, { lastDay: ctx.addDays(today, 10), type: 'resignation', reason: 'Going back to school' });
            check('her planned exit is recorded', t1.s === 201 && t1.b.immediate === false, t1.b);
            const l1 = await call('GET', `${U}/checklists/person/${tmp.uid}`, hr);
            check('and her offboarding checklist appears', (l1.b.lists || []).some((l) => l.kind === 'offboarding'), l1.text.slice(0, 200));
            check('an employee cannot cancel it (403)', (await call('POST', `${U}/offboarding/${tmp.uid}/cancel`, cashier, {})).s === 403);
            const c1 = await call('POST', `${U}/offboarding/${tmp.uid}/cancel`, hr, {});
            check('HR cancels the planned exit', c1.s === 200, c1.b);
            const afterCancel = await leavingList();
            const l2 = await call('GET', `${U}/checklists/person/${tmp.uid}`, hr);
            check('she is off the leaving list and her offboarding checklist is gone', !rowOf(afterCancel, tmp.uid) && !(l2.b.lists || []).some((l) => l.kind === 'offboarding'), { row: rowOf(afterCancel, tmp.uid), lists: (l2.b.lists || []).map((l) => l.kind) });
            const c2 = await call('POST', `${U}/offboarding/${tmp.uid}/cancel`, hr, {});
            check('cancelling again is refused (409)', c2.s === 409, c2.b);
            check('someone who has not left cannot be rehired (409)', (await call('POST', `${U}/offboarding/${tmp.uid}/rehire`, hr, { startDate: today })).s === 409);
            const noShort = await call('POST', `${U}/offboarding/${tmp.uid}/terminate`, hr, { lastDay: yesterday, type: 'termination_for_cause', reason: 'bad' });
            check('a termination for cause needs a real reason (400)', noShort.s === 400, noShort.b);
            // later she does leave, for cause, and is marked not eligible for rehire
            const t2 = await call('POST', `${U}/offboarding/${tmp.uid}/terminate`, hr, { lastDay: yesterday, type: 'termination_for_cause', reason: 'Repeated no-shows after two written warnings', rehireEligible: false });
            check('later she is let go with a last day of yesterday: it takes effect at once', t2.s === 201 && t2.b.immediate === true, t2.b);
            const l3 = await call('GET', `${U}/checklists/person/${tmp.uid}`, hr);
            check('a new offboarding checklist appears for this second exit', (l3.b.lists || []).some((l) => l.kind === 'offboarding'), { lists: (l3.b.lists || []).map((l) => l.kind) });
            check('an exit that has taken effect cannot be cancelled (409)', (await call('POST', `${U}/offboarding/${tmp.uid}/cancel`, hr, {})).s === 409);
            const r1 = await call('POST', `${U}/offboarding/${tmp.uid}/rehire`, hr, { startDate: today });
            check('rehiring someone marked "not eligible for rehire" is refused (409)', r1.s === 409, r1.b);
            const r2 = await call('POST', `${U}/offboarding/${tmp.uid}/rehire`, hr, { startDate: today, override: true, reason: 'Owner agreed to a second chance' });
            check('unless HR overrides it with a reason', r2.s === 201 && r2.b.temporaryPassword, r2.b);
        }

        // --------------------------------------------------------------------------------------- employment ends
        ctx.section('Lena\'s employment ends');
        ctx.skip('A planned last day arrives and takes effect by itself, or HR brings it forward', 'the app applies a planned exit only when the calendar reaches the last day (hourly job) and has no route to change the last day or end it now; the run cancels the planned exit and records it again with a last day of yesterday');
        const undo = await call('POST', `${U}/offboarding/${lena.uid}/cancel`, hr, {});
        const ended = await call('POST', `${U}/offboarding/${lena.uid}/terminate`, hr, { ...exit, lastDay: finalLastDay, notes: 'Left earlier than planned' });
        if (!check(`[needed] HR records that her last day was ${lastDayWord}: it takes effect at once`, undo.s === 200 && ended.s === 201 && ended.b.immediate === true, { undo: undo.b, ended: ended.b })) return;
        const lenaOldToken = lenaToken;
        ctx.forget('leaver');
        const withOld = await call('GET', `${U}/me/profile`, lenaOldToken);
        check('the sign-in she already had stops working', withOld.s === 401 || withOld.s === 403, { s: withOld.s, b: withOld.b });
        const withOld2 = await call('GET', `${U}/exit-interview/me`, lenaOldToken);
        check('including on her exit interview page', withOld2.s === 401 || withOld2.s === 403, { s: withOld2.s });
        let signedIn = await pageSignIn(lena.email, lena.password);
        const useNew = signedIn ? await call('GET', `${U}/me/profile`, signedIn) : { s: 0 };
        check('she cannot sign in any more', !signedIn || useNew.s === 401 || useNew.s === 403, { gotToken: Boolean(signedIn), s: useNew.s });

        const gone = rowOf(await leavingList(), lena.uid) || {};
        check(`the leaving list shows her as gone, with ${lastDayWord} as her last day`, /terminated/i.test(String(gone.status)) && gone.lastDay === finalLastDay, gone);
        const finalLists = await call('GET', `${U}/checklists/person/${lena.uid}`, hr);
        const finalOff = (finalLists.b.lists || []).find((l) => l.kind === 'offboarding');
        check('her offboarding checklist is there for the exit that took effect', Boolean(finalOff), { lists: (finalLists.b.lists || []).map((l) => l.kind), listId: gone.listId, progress: gone.progress });
        if (finalOff) {
            const access = finalOff.tasks.find((t) => /access/i.test(t.title)) || {};
            check('the "turn off system access" task ticked itself', access.done === true || access.status === 'done', access);
        }
        const finalSummary = await call('GET', `${U}/offboarding/${lena.uid}/summary`, hr);
        check('the summary now shows nothing left to pay out and the I-9 keep-until date', finalSummary.s === 200 && finalSummary.b.totalPayoutHours === 0 && /^\d{4}-\d{2}-\d{2}$/.test(String(finalSummary.b.i9RetainUntil)), finalSummary.b);

        ctx.section('Gone from the lists of current people, present in the lists of former people');
        const headcount = await call('GET', `${U}/reports/headcount`, hr);
        if (sameDay) ctx.skip('The headcount list no longer has her', 'her last day is today in this repeated run, and she counts as employed through her last day');
        else check('the headcount list no longer has her', headcount.s === 200 && (headcount.b.list || []).length > 0 && !(headcount.b.list || []).some((p) => p.employeeId === lena.employeeId), `in list: ${(headcount.b.list || []).some((p) => p.employeeId === lena.employeeId)}`);
        const i9Now = await call('GET', `${U}/i9`, hr);
        check('the I-9 list of current people no longer has her', i9Now.s === 200 && (i9Now.b.data || []).length > 0 && !/Lena Park/.test(i9Now.text), i9Now.text.slice(0, 200));
        const pick = await call('GET', `${U}/assets/options`, hr);
        check('she can no longer be chosen when giving out equipment', pick.s === 200 && (pick.b.people || []).length > 0 && !(pick.b.people || []).some((p) => p.id === lena.uid), (pick.b.people || []).length);
        const team = await call('GET', `${U}/people/${state.people.manager.uid}/team`, hr);
        check('her manager\'s team no longer has her', team.s === 200 && /Carlos/.test(team.text) && !/Lena/.test(team.text), team.text.slice(0, 300));
        const people = await call('GET', `${U}/employees`, hr);
        const inPeople = (people.b.data || []).find((p) => p.id === lena.uid);
        check('the people list leaves her out or marks her as a former employee', people.s === 200 && (!inPeople || /terminated|former|inactive/i.test(JSON.stringify(inPeople))), inPeople);

        // ------------------------------------------------------------------------------------------------- equipment
        ctx.section('Equipment still with people who have left');
        const out1 = await call('GET', `${U}/assets`, hr);
        const stillOut = (out1.b.unreturned || []).find((a) => a.id === assetId);
        check('the equipment list shows her item as still with someone who has left', out1.s === 200 && stillOut && stillOut.assignedTo === lena.uid && /Lena/.test(String(stillOut.assignedToName)), out1.b.unreturned);
        check('the auditor sees that list too; an employee cannot open the company equipment list (403)', ((await call('GET', `${U}/assets`, auditor)).b.unreturned || []).some((a) => a.id === assetId) && (await call('GET', `${U}/assets`, cashier)).s === 403);
        const spare = await call('POST', `${U}/assets`, hr, { name: `Cafe apron ${run}-${stamp}`, category: 'Uniform', tag: `APR-${run}-${stamp}` });
        const refuse = spare.b.item ? await call('POST', `${U}/assets/${spare.b.item.id}/assign`, hr, { userId: lena.uid }) : { s: 0 };
        check('equipment cannot be given to someone who has left (409)', spare.s === 201 && refuse.s === 409, { spare: spare.s, refuse: refuse.b });
        if (spare.b.item) await call('DELETE', `${U}/assets/${spare.b.item.id}`, hr);
        check('her manager cannot take equipment back (403)', (await call('POST', `${U}/assets/${assetId}/return`, manager, { condition: 'good' })).s === 403);
        const back = await call('POST', `${U}/assets/${assetId}/return`, hr, { condition: 'fair', note: 'Handed in at the front desk' });
        check('HR takes the item back and notes its condition', back.s === 200 && back.b.item && back.b.item.status === 'available', back.b);
        // anything else she still holds (given by an earlier stage or run) is taken back the same way
        const out2 = await call('GET', `${U}/assets`, hr);
        for (const a of (out2.b.unreturned || []).filter((x) => x.assignedTo === lena.uid)) await call('POST', `${U}/assets/${a.id}/return`, hr, { condition: 'good', note: 'Handed in at the front desk' });
        const keyNow = await call('GET', `${U}/assets/${assetId}`, hr);
        const keyItem = keyNow.b.item || {};
        check('the item is available again and its history shows who had it', keyNow.s === 200 && keyItem.status === 'available' && (keyItem.history || []).some((h) => /returned/.test(JSON.stringify(h)) && /Lena/.test(JSON.stringify(h))), keyItem);
        const allEnd = await call('GET', `${U}/assets`, hr);
        check('nothing of Lena\'s is left on the "still with leavers" list', allEnd.s === 200 && !(allEnd.b.unreturned || []).some((a) => a.assignedTo === lena.uid), allEnd.b.unreturned);
        if (finalOff) {
            const eq = finalOff.tasks.find((t) => /equipment/i.test(t.title));
            const done = eq ? await call('PUT', `${U}/checklists/person/${lena.uid}/${finalOff.id}/tasks/${eq.id}`, hr, { status: 'done', note: 'Key returned' }) : { s: 0 };
            check('HR ticks "collect keys, uniform and equipment" on her checklist', done.s === 200, done.b);
        }

        // ----------------------------------------------------------------------------------------------------- COBRA
        ctx.section('COBRA: leaving is a qualifying event');
        if (!hasCover) ctx.skip('COBRA record for Lena', 'she could not be given health cover through the benefits routes in this run, and COBRA applies only to people with cover');
        else {
            const existing = await call('GET', `${U}/benefits/cobra`, hr);
            let record = (existing.b.data || []).find((c) => c.userId === lena.uid && c.eventDate === finalLastDay && c.status !== 'terminated');
            check('the COBRA list reads and knows "termination of employment" as a qualifying event', existing.s === 200 && (existing.b.events || []).some((e) => e.key === 'termination'), existing.text.slice(0, 300));
            if (!record) {
                check('a COBRA record was opened for Lena by her exit, without HR doing it by hand', false, 'no COBRA record exists after the termination took effect; HR has to open one by hand (the event is marked "auto" in the settings)');
                const badEvent = await call('POST', `${U}/benefits/cobra`, hr, { userId: lena.uid, eventType: 'won_the_lottery', eventDate: finalLastDay });
                check('an unknown qualifying event is refused (400)', badEvent.s === 400, badEvent.b);
                check('payroll cannot open a COBRA record (403)', (await call('POST', `${U}/benefits/cobra`, payroll, { userId: lena.uid, eventType: 'termination', eventDate: finalLastDay })).s === 403);
                const made = await call('POST', `${U}/benefits/cobra`, hr, { userId: lena.uid, eventType: 'termination', eventDate: finalLastDay });
                check('HR opens the COBRA record for her termination', made.s === 201 && made.b.record && made.b.record.status === 'pending_notice', made.b);
                record = made.b.record;
            }
            if (record) {
                ids.cobraId = record.id;
                const dup = await call('POST', `${U}/benefits/cobra`, hr, { userId: lena.uid, eventType: 'termination', eventDate: finalLastDay });
                check('the same event cannot be recorded twice (409)', dup.s === 409, dup.b);
                const admin = await call('POST', `${U}/benefits/cobra/${record.id}/action`, hr, { action: 'notice_to_administrator', date: today });
                const notice = await call('POST', `${U}/benefits/cobra/${record.id}/action`, hr, { action: 'send_election_notice', date: today });
                check('HR records the notice to the plan administrator and the election notice to Lena', admin.s === 200 && notice.s === 200 && notice.b.record.status === 'notice_sent', { admin: admin.b, notice: notice.b });
                const wrongStep = await call('POST', `${U}/benefits/cobra/${record.id}/action`, hr, { action: 'record_payment', date: today });
                check('a payment cannot be recorded before she elects cover (409)', wrongStep.s === 409, wrongStep.b);
                const shown = await call('GET', `${U}/benefits/cobra`, hr);
                const mineRow = (shown.b.data || []).find((c) => c.id === record.id) || {};
                check('the COBRA list shows her record with its deadlines', mineRow.status === 'notice_sent' && /\d{4}-\d{2}-\d{2}/.test(JSON.stringify(mineRow.deadlines || mineRow)), mineRow);
                check('an employee cannot read the COBRA list (403)', (await call('GET', `${U}/benefits/cobra`, cashier)).s === 403);
            }
        }

        // --------------------------------------------------------------------------------------------------- reports
        ctx.section('Reports: I-9 keep-until date and turnover');
        let auditRow = {};
        if (sameDay) ctx.skip('The I-9 audit report lists her as a former employee with the keep-until date', 'her last day is today in this repeated run; the report lists a person as former from the day after the last day');
        else {
            const audit = await call('GET', `${U}/reports/i9-audit`, hr);
            auditRow = (audit.b.list || []).find((r) => r.id === lena.uid) || {};
            check('the I-9 audit report lists her as a former employee with her last day and the date the form must be kept until', audit.s === 200 && auditRow.status === 'former' && auditRow.lastDay === finalLastDay && auditRow.keepUntil === finalSummary.b.i9RetainUntil, auditRow);
            const expectedKeep = [ctx.addDays(`${Number(finalLastDay.slice(0, 4)) + 1}${finalLastDay.slice(4)}`, 0), null][0];
            check('the keep-until date is at least one year after her last day', String(auditRow.keepUntil) >= expectedKeep, { keepUntil: auditRow.keepUntil, lastDay: finalLastDay });
            const auditCsv = await call('GET', `${U}/reports/i9-audit?format=csv`, hr);
            const csvLine = auditCsv.text.split(/\r?\n/).find((l) => /Lena Park/.test(l)) || '';
            check('the I-9 audit CSV has her row with the keep-until date', auditCsv.s === 200 && /Keep until/.test(auditCsv.text) && csvLine.includes(String(auditRow.keepUntil)), csvLine);
        }
        check('an employee cannot open the I-9 audit report (403)', (await call('GET', `${U}/reports/i9-audit`, cashier)).s === 403);
        const turnover = await call('GET', `${U}/reports/turnover?from=${ctx.addDays(today, -30)}&to=${today}`, hr);
        const exitRow = (turnover.b.list || []).find((r) => r.id === lena.uid) || {};
        check('the turnover report counts her exit as a resignation', turnover.s === 200 && turnover.b.separations >= 1 && exitRow.lastDay === finalLastDay && exitRow.type === 'resignation' && (turnover.b.byType || []).some((t) => t.key === 'resignation' && t.count >= 1) && exitRow.tenureDays >= (sameDay ? 0 : 1), { separations: turnover.b.separations, byType: turnover.b.byType, exitRow });
        const turnoverCsv = await call('GET', `${U}/reports/turnover?from=${ctx.addDays(today, -30)}&to=${today}&format=csv`, hr);
        check('the turnover CSV has her row', turnoverCsv.s === 200 && /Last day/.test(turnoverCsv.text) && /Lena Park/.test(turnoverCsv.text), turnoverCsv.text.slice(0, 300));
        const execTurnover = await call('GET', `${U}/reports/turnover`, await ctx.as('executive'));
        check('the executive reads the turnover report; an employee cannot (403)', execTurnover.s === 200 && (await call('GET', `${U}/reports/turnover`, cashier)).s === 403, execTurnover.s);
        const headline = await call('GET', `${U}/reports/summary`, hr);
        check('the reports headline counts the separation in the last 90 days', headline.s === 200 && headline.b.turnover90d && headline.b.turnover90d.separations >= 1, headline.b);
        const pastList = await call('GET', `${U}/exit-interviews?${range}`, hr);
        check('the answers she gave during her notice are still in HR\'s exit interview list', pastList.s === 200 && (pastList.b.data || []).some((r) => r.userId === lena.uid && r.answered === true), (pastList.b.data || []).filter((r) => r.userId === lena.uid));
        const afterExit = await call('GET', `${U}/exit-interviews/${lena.uid}`, hr);
        check('and HR still reads them on her exit interview after the last day was changed', afterExit.s === 200 && /morning crew/.test(afterExit.text), { answered: afterExit.b.interview && afterExit.b.interview.answered, lastDay: afterExit.b.interview && afterExit.b.interview.lastDay, answers: afterExit.b.interview && afterExit.b.interview.answers });
        const closed = await call('PUT', `${U}/exit-interviews/${lena.uid}`, hr, { hrNotes: 'Left a day early; key handed in.' });
        check('HR can still add exit notes after she has gone', closed.s === 200, closed.b);

        // ---------------------------------------------------------------------------------------------------- rehire
        ctx.section('Lena is rehired');
        check('an employee cannot rehire anyone (403)', (await call('POST', `${U}/offboarding/${lena.uid}/rehire`, cashier, { startDate: today })).s === 403);
        const beforeLast = await call('POST', `${U}/offboarding/${lena.uid}/rehire`, hr, { startDate: ctx.addDays(finalLastDay, -5) });
        check('a new start date before her last day is refused (400)', beforeLast.s === 400, beforeLast.b);
        const rehired = await call('POST', `${U}/offboarding/${lena.uid}/rehire`, hr, { startDate: today });
        if (!check('[needed] HR rehires her from today and gets a one-time password for her', rehired.s === 201 && rehired.b.startDate === today && rehired.b.temporaryPassword && rehired.b.i9, { ...rehired.b, temporaryPassword: rehired.b.temporaryPassword ? '(given)' : null })) return;
        ids.rehiredOn = today; ctx.save();
        check('the one-time password is not kept by browsers (no-store)', /no-store/.test(rehired.headers.get('cache-control') || ''), rehired.headers.get('cache-control'));
        check('the app says her earlier I-9 can be reused (it is less than three years old)', rehired.b.i9.action === 'update_section_3', rehired.b.i9);
        check('rehiring her a second time is refused (409)', (await call('POST', `${U}/offboarding/${lena.uid}/rehire`, hr, { startDate: today })).s === 409);
        const oldPassword = await pageSignIn(lena.email, lena.password);
        const oldWorks = oldPassword ? (await call('GET', `${U}/me/profile`, oldPassword)).s : 0;
        check('her old password does not let her into the app', oldWorks !== 200, { s: oldWorks });
        if (!(await takeBackAccess(lena, rehired.b.temporaryPassword, 'Lena'))) { ctx.skip('The steps Lena does herself after the rehire, and the I-9 follow-up', 'she could not choose her new password in this run (see the failed check above); run the stage again on this company to finish'); return; }
        lenaToken = await ctx.as('leaver', { renew: true });
        const meAgain = await call('GET', `${U}/me/profile`, lenaToken);
        check('she is signed in and working again', meAgain.s === 200, meAgain.b);
        const peopleAgain = await call('GET', `${U}/employees`, hr);
        const sameRow = (peopleAgain.b.data || []).find((p) => p.id === lena.uid) || {};
        check(`she has the same employee number as before (${lena.employeeId})`, sameRow.employeeId === lena.employeeId, sameRow);
        check('she is off the leaving list', !rowOf(await leavingList(), lena.uid));
        const headcount2 = await call('GET', `${U}/reports/headcount`, hr);
        const hcRow = (headcount2.b.list || []).find((p) => p.employeeId === lena.employeeId) || {};
        check('she is back in the headcount list with her new start date', hcRow.startDate === today, hcRow);
        const team2 = await call('GET', `${U}/people/${state.people.manager.uid}/team`, hr);
        check('she is back in her manager\'s team', team2.s === 200 && /Lena/.test(team2.text), team2.text.slice(0, 300));
        const listsBack = await call('GET', `${U}/checklists/person/${lena.uid}`, hr);
        const re = (listsBack.b.lists || []).find((l) => l.kind === 'rehire');
        check('a rehire checklist appears, counted from her new start date', re && re.anchorDate === today && re.tasks.some((t) => /I-9/.test(t.title)) && re.tasks.some((t) => /W-4/.test(t.title)), (listsBack.b.lists || []).map((l) => ({ kind: l.kind, anchorDate: l.anchorDate })));
        const hersBack = await call('GET', `${U}/checklists/mine`, lenaToken);
        const herRe = (hersBack.b.lists || []).find((l) => l.kind === 'rehire');
        check('Lena sees her own rehire tasks (tax form, bank account)', herRe && herRe.tasks.length >= 1 && herRe.tasks.every((t) => t.assignee === 'employee'), hersBack.text.slice(0, 300));
        if (herRe) {
            const w4 = herRe.tasks.find((t) => /W-4/.test(t.title));
            const done = w4 ? await call('PUT', `${U}/checklists/person/${lena.uid}/${herRe.id}/tasks/${w4.id}`, lenaToken, { status: 'done' }) : { s: 0 };
            check('and ticks the tax form task', done.s === 200, done.b);
        }

        ctx.section('I-9 on rehire');
        const i9 = await call('GET', `${U}/employees/${lena.uid}/i9`, hr);
        check('her I-9 shows a rehire waiting to be recorded on Supplement B', i9.s === 200 && i9.b.person && i9.b.person.rehire && i9.b.person.rehire.action === 'update_section_3' && i9.b.person.next === 'rehire', i9.b.person);
        const i9List = await call('GET', `${U}/i9`, hr);
        check('the I-9 list counts one rehire to handle', i9List.s === 200 && i9List.b.summary && i9List.b.summary.rehires >= 1 && /Lena Park/.test(i9List.text), i9List.b.summary);
        const noDate = await call('POST', `${U}/employees/${lena.uid}/i9/reverification`, hr, { kind: 'rehire', examinedOn: today, signerName: 'Hannah Reyes', certification: true });
        check('a rehire entry without the rehire date is refused (400)', noDate.s === 400, noDate.b);
        check('her manager cannot record it (403)', (await call('POST', `${U}/employees/${lena.uid}/i9/reverification`, manager, { kind: 'rehire', rehireDate: today, examinedOn: today, signerName: 'Maria Gonzalez', certification: true })).s === 403);
        const supp = await call('POST', `${U}/employees/${lena.uid}/i9/reverification`, hr, { kind: 'rehire', rehireDate: today, examinedOn: today, examinationMethod: 'in_person', signerName: 'Hannah Reyes', signerTitle: 'HR Manager', certification: true });
        check('HR records the rehire on Supplement B', supp.s === 201 && supp.b.supplement && supp.b.supplement.kind === 'rehire', supp.b);
        const i9After = await call('GET', `${U}/employees/${lena.uid}/i9`, hr);
        check('and the I-9 no longer waits for anything', i9After.s === 200 && !i9After.b.person.rehire && i9After.b.person.next !== 'rehire' && JSON.stringify(i9After.b.section2 || {}).includes('rehire'), { person: i9After.b.person });
        const auditAgain = await call('GET', `${U}/reports/i9-audit`, hr);
        const auditRow2 = (auditAgain.b.list || []).find((r) => r.id === lena.uid) || {};
        check('the I-9 audit report shows her as a current employee again, with no keep-until date', auditRow2.status === 'current' && !auditRow2.keepUntil, auditRow2);
        const turnover2 = await call('GET', `${U}/reports/turnover?from=${ctx.addDays(today, -30)}&to=${today}`, hr);
        check('the turnover report still counts her earlier exit', turnover2.s === 200 && (turnover2.b.list || []).some((r) => r.id === lena.uid && r.lastDay === finalLastDay), (turnover2.b.list || []).map((r) => `${r.name} ${r.lastDay}`));
        if (ids.cobraId) {
            const endCobra = await call('POST', `${U}/benefits/cobra/${ids.cobraId}/action`, hr, { action: 'terminate', date: today, note: 'Rehired, back on the company plan' });
            check('HR closes her COBRA record because she is back', endCobra.s === 200 && endCobra.b.record.status === 'terminated', endCobra.b);
        }
        const lastSummary = await call('GET', `${U}/offboarding/${lena.uid}/summary`, hr);
        check('there is no offboarding summary for her any more (409)', lastSummary.s === 409, lastSummary.b);
        const closedForm = await call('GET', `${U}/exit-interview/me`, lenaToken);
        check('and no exit interview for her to fill in', closedForm.s === 200 && closedForm.b.status === 'not_leaving', closedForm.b);
        ctx.save();
    }
};
