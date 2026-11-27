/**
 * Stage 07: performance, pay changes and engagement.
 * Goals and written reviews, a review round with coworker (360) feedback, pulse survey and eNPS, announcements and
 * thanks, company equipment, job and pay history with approval, pay schedules, direct-deposit splits, the report
 * builder and the standard reports. Everything goes through the routes the pages call, as the person who would do it.
 *
 * Pay is changed only for one person this stage adds ("Riley Morgan"); the shared people of stage 01 keep their pay,
 * role and manager. One uniform is left with the leaver on purpose: stage 08 checks that offboarding lists it.
 */
const has = (text, needle) => String(text).includes(String(needle));

module.exports = {
    id: '07',
    title: 'Performance, pay changes and engagement',
    covers: ['US-B04', 'US-B05', 'US-I01', 'US-I02', 'US-I03', 'US-I04', 'US-I05', 'US-J01', 'US-J02', 'US-J03', 'US-J04', 'US-J05'],
    async run(ctx) {
        const { call, check, U, state } = ctx;
        const P = state.people;
        const tag = `${state.run}-${String(Date.now()).slice(-6)}`; // unique per run, and per re-run with --reuse
        const ids = state.ids.performance = state.ids.performance || {};
        const [owner, hr, payroll, manager, auditor, executive, cashier, server, stocker, leaver] = await Promise.all(['owner', 'hr', 'payroll', 'manager', 'auditor', 'executive', 'cashier', 'server', 'stocker', 'leaver'].map((k) => ctx.as(k)));
        const uid = (k) => P[k].uid;

        // ====================================================== a person made for the pay checks (not a shared one)
        ctx.section('A new person for the pay checks');
        const domain = state.company.domain;
        const rileyEmail = `riley${String(Date.now()).slice(-7)}@${domain}`;
        const startDate = ctx.addDays(ctx.today, -40);
        const made = await call('POST', `${U}/employees`, hr, { firstName: 'Riley', lastName: 'Morgan', email: rileyEmail, role: 'employee', startDate, jobTitle: 'Shift Lead' });
        const re = made.b.employee || {};
        if (!check('HR adds Riley Morgan, the person whose pay this stage changes', made.s === 201 && re.uid && re.temporaryPassword, made.b)) return;
        const riley = { key: 'riley', uid: re.uid, employeeId: re.employeeId, email: rileyEmail, password: re.temporaryPassword, name: 'Riley Morgan' };
        let rileyToken = await ctx.signIn(rileyEmail, re.temporaryPassword);
        const changed = await call('POST', '/api/auth/change-password', rileyToken, { currentPassword: re.temporaryPassword, newPassword: state.password });
        if (check('Riley replaces the temporary password', changed.s === 200, changed.b)) { riley.password = state.password; rileyToken = await ctx.signIn(rileyEmail, state.password); }
        ids.payPerson = riley;
        const baseProfile = { legalFirstName: 'Riley', legalLastName: 'Morgan', dateOfBirth: '1993-02-11', homeAddress: { line1: '77 Rainey St', city: 'Austin', state: 'TX', zip: '78701' }, workState: 'TX', classification: 'W2', employmentType: 'full_time', payFrequency: 'weekly', payType: 'hourly', payRate: 16, flsaStatus: 'non_exempt', jobTitle: 'Shift Lead', startDate, taxpayerIdType: 'SSN', taxpayerId: '531-41-4077' }; // a made-up number for the local run
        const prof = await call('PUT', `${U}/employees/${riley.uid}/profile`, hr, baseProfile);
        const place = await call('PUT', `${U}/people/${riley.uid}/assignment`, hr, { departmentId: state.ids.departments.store, workLocationId: state.ids.locations.main });
        check('Riley\'s profile is saved (hourly, $16.00) and Riley is placed in the Store department', prof.s === 200 && place.s === 200, { prof: prof.b, place: place.b });
        if (prof.s === 200) ids.payPeople = (ids.payPeople || 0) + 1; // a re-run on the same company adds another Riley
        const hourly = 4 + (ids.payPeople || 0); const inStore = 2 + (ids.payPeople || 0);
        const rateOf = async (id) => { const r = await call('GET', `${U}/employees/${id}/profile`, hr); const p = r.b.profile || r.b.usProfile || (r.b.employee && (r.b.employee.usProfile || r.b.employee.profile)) || r.b.data || {}; return { rate: p.payRate, title: p.jobTitle, text: r.text, s: r.s }; };
        const before = await rateOf(riley.uid);
        check('the profile shows $16.00 before any change', before.s === 200 && before.rate === 16, before.text.slice(0, 400));

        // ================================================================================ departments and locations
        // Stage 01 sends departmentId and locationId with the profile, where they are not kept; the org page's own route is used here.
        ctx.section('Each person is placed in a department and a location');
        let placed = 0; const notPlaced = [];
        for (const p of require('./01-company-and-people').PEOPLE) {
            const r = await call('PUT', `${U}/people/${uid(p.key)}/assignment`, hr, { departmentId: state.ids.departments[p.dept], workLocationId: state.ids.locations[p.loc] });
            if (r.s === 200) placed += 1; else notPlaced.push({ who: p.key, status: r.s, body: r.b });
        }
        check('HR places all ten people in their department and location', placed === 10, notPlaced);
        check('a manager cannot move a person to another department (403)', (await call('PUT', `${U}/people/${uid('cashier')}/assignment`, manager, { departmentId: state.ids.departments.office })).s === 403);

        // ============================================================================== goals and written reviews
        ctx.section('Goals: the manager sets them, the employee updates progress');
        const G = `${U}/performance/goals`;
        const goal = await call('POST', G, manager, { userId: uid('cashier'), title: `Learn to close the store alone ${tag}`, detail: 'Cash count, alarm, deposit bag.', dueDate: ctx.addDays(ctx.today, 30) });
        check('the manager sets a goal for a direct report', goal.s === 201 && goal.b.goal && goal.b.goal.status === 'open' && goal.b.goal.overdue === false, goal.b);
        const goalId = (goal.b.goal || {}).id; ids.goalId = goalId;
        const lateGoal = await call('POST', G, manager, { userId: uid('cashier'), title: `Finish the food safety course ${tag}`, dueDate: ctx.addDays(ctx.today, -5) });
        check('a second goal whose date has passed is saved', lateGoal.s === 201, lateGoal.b);
        const myGoals = await call('GET', G, cashier);
        const seenLate = (myGoals.b.data || []).find((g) => g.id === (lateGoal.b.goal || {}).id);
        check('the employee sees both goals, and the one past its date shows as late', myGoals.s === 200 && (myGoals.b.data || []).some((g) => g.id === goalId) && seenLate && seenLate.overdue === true && myGoals.b.summary.overdue >= 1, myGoals.b);
        const progress = await call('PUT', `${G}/${goalId}`, cashier, { progress: 40, note: 'Closed twice with Maria watching.' });
        check('the employee updates progress to 40% with a note', progress.s === 200 && progress.b.goal.progress === 40 && progress.b.goal.notes.length === 1, progress.b);
        check('a progress number over 100 is refused (400)', (await call('PUT', `${G}/${goalId}`, cashier, { progress: 140 })).s === 400);
        check('the employee cannot remove a goal the manager gave them (403)', (await call('DELETE', `${G}/${goalId}`, cashier)).s === 403);
        const mgrGoals = await call('GET', `${G}?userId=${uid('cashier')}`, manager);
        check('the manager sees the new progress', mgrGoals.s === 200 && (mgrGoals.b.data || []).some((g) => g.id === goalId && g.progress === 40), mgrGoals.b);
        const done = await call('PUT', `${G}/${(lateGoal.b.goal || {}).id}`, cashier, { status: 'done' });
        check('the employee marks the late goal as done, and it is no longer late', done.s === 200 && done.b.goal.status === 'done' && done.b.goal.progress === 100 && done.b.goal.overdue === false, done.b);
        const stillLate = await call('POST', G, manager, { userId: uid('cashier'), title: `Renew the food handler card ${tag}`, dueDate: ctx.addDays(ctx.today, -2) });
        ids.lateGoalId = (stillLate.b.goal || {}).id;
        check('another goal is left late on purpose (for the goals report)', stillLate.s === 201 && stillLate.b.goal.overdue === true, stillLate.b);
        check('an employee cannot see a coworker\'s goals (403)', (await call('GET', `${G}?userId=${uid('server')}`, cashier)).s === 403);
        check('a manager cannot see the goals of someone outside their team (403)', (await call('GET', `${G}?userId=${uid('payroll')}`, manager)).s === 403);
        check('goals need a sign-in (401)', (await call('GET', G, null)).s === 401);
        const team = await call('GET', `${U}/performance/team`, manager);
        const teamIds = (team.b.data || []).map((p) => p.userId).sort().join();
        check('the manager\'s team overview lists their direct reports (the four, plus anyone hired in an earlier stage) and nobody above them', team.s === 200 && ['cashier', 'server', 'stocker', 'leaver'].map(uid).every((id) => teamIds.split(',').includes(id)) && !['owner', 'hr', 'payroll', 'manager'].map(uid).some((id) => teamIds.split(',').includes(id)), team.b);
        check('an employee has no team overview (403)', (await call('GET', `${U}/performance/team`, cashier)).s === 403);

        ctx.section('A written review, shared with the employee');
        const RV = `${U}/performance/reviews`;
        const PRIVATE = `PRIVATE-NOTE-${tag}`;
        const period = { periodStart: ctx.addDays(ctx.today, -70), periodEnd: ctx.addDays(ctx.today, -1) };
        check('nobody writes their own review (403)', (await call('POST', RV, cashier, { userId: uid('cashier'), ...period })).s === 403);
        const draft = await call('POST', RV, manager, { userId: uid('cashier'), ...period, ratings: { Reliability: 4, Teamwork: 5 }, comments: { Teamwork: 'Covers shifts for others.' }, overall: 4, strengths: 'Friendly and fast at the register.', privateNote: PRIVATE });
        check('the manager writes a draft review with a private note', draft.s === 201 && draft.b.review.status === 'draft' && draft.b.review.privateNote === PRIVATE, draft.b);
        const reviewId = (draft.b.review || {}).id; ids.reviewId = reviewId;
        const beforeShare = await call('GET', RV, cashier);
        check('the employee does not see a draft', beforeShare.s === 200 && !(beforeShare.b.data || []).some((r) => r.id === reviewId), beforeShare.b);
        const early = await call('POST', `${RV}/${reviewId}/share`, manager, {});
        check('sharing is refused until "what to work on" is written (400)', early.s === 400, early.b);
        const full = await call('PUT', `${RV}/${reviewId}`, manager, { ...period, ratings: { Reliability: 4, Teamwork: 5 }, overall: 4, strengths: 'Friendly and fast at the register.', nextSteps: 'Train on closing the store alone.', privateNote: PRIVATE });
        check('the manager completes the draft', full.s === 200, full.b);
        const shared = await call('POST', `${RV}/${reviewId}/share`, manager, {});
        check('the manager shares the review', shared.s === 200 && shared.b.review.status === 'shared', shared.b);
        const mineRv = await call('GET', RV, cashier);
        const got = (mineRv.b.data || []).find((r) => r.id === reviewId);
        check('the employee now sees the review', Boolean(got) && got.status === 'shared' && got.overall === 4, mineRv.b);
        check('the private note is never sent to the employee', mineRv.s === 200 && !has(mineRv.text, PRIVATE) && !has(mineRv.text, 'privateNote'), mineRv.text.slice(0, 400));
        const seenRv = await call('POST', `${RV}/${reviewId}/acknowledge`, cashier, { comment: 'Thank you, I agree.' });
        check('the employee marks it as seen, with a comment, and still gets no private note', seenRv.s === 200 && seenRv.b.review.status === 'acknowledged' && !has(seenRv.text, PRIVATE), seenRv.b);
        const mgrRv = await call('GET', `${RV}?userId=${uid('cashier')}`, manager);
        const mgrCopy = (mgrRv.b.data || []).find((r) => r.id === reviewId) || {};
        check('the manager sees it was seen, the comment, and still has the private note', mgrCopy.status === 'acknowledged' && mgrCopy.employeeComment === 'Thank you, I agree.' && mgrCopy.privateNote === PRIVATE, mgrCopy);
        check('a shared review cannot be changed (409)', (await call('PUT', `${RV}/${reviewId}`, manager, { ...period, overall: 5 })).s === 409);
        check('a manager cannot read reviews of someone outside their team (403)', (await call('GET', `${RV}?userId=${uid('payroll')}`, manager)).s === 403);

        // ======================================================================================== review round
        ctx.section('A review round: self review, manager review and coworker feedback');
        const RC = `${U}/review-cycles`;
        const roundBody = { name: `Mid-year review ${tag}`, periodStart: ctx.addDays(ctx.today, -70), periodEnd: ctx.today, dueDate: ctx.addDays(ctx.today, 21), audience: 'chosen', peopleIds: [uid('cashier'), uid('server'), uid('payroll')], peerFeedback: true, sharePeerFeedback: true };
        check('a manager cannot start a review round (403)', (await call('POST', RC, manager, roundBody)).s === 403);
        check('an employee cannot list review rounds (403)', (await call('GET', RC, cashier)).s === 403);
        check('a round that asks for fewer than 3 coworker answers is refused (400)', (await call('POST', RC, hr, { ...roundBody, peerMinAnswers: 2 })).s === 400);
        const round = await call('POST', RC, hr, roundBody);
        check('HR prepares a round for three people (draft)', round.s === 201 && round.b.cycle.status === 'draft' && round.b.cycle.peerMinAnswers >= 3, round.b);
        const cycleId = (round.b.cycle || {}).id; ids.reviewCycleId = cycleId;
        const C = `${RC}/${cycleId}`;
        const mineDraft = await call('GET', `${RC}/mine`, cashier);
        check('a draft round is not shown to the employee', mineDraft.s === 200 && !(mineDraft.b.cycles || []).some((c) => c.id === cycleId), mineDraft.b);
        check('a manager cannot open the round (403)', (await call('POST', `${C}/open`, manager, {})).s === 403);
        const opened = await call('POST', `${C}/open`, hr, {});
        check('HR opens the round: three people are in it', opened.s === 200 && opened.b.cycle.status === 'open' && opened.b.cycle.included === 3, opened.b);

        const mineOpen = await call('GET', `${RC}/mine`, cashier);
        const own = (mineOpen.b.cycles || []).find((c) => c.id === cycleId);
        check('the employee sees the open round and an empty self review', Boolean(own) && own.self && own.self.canWrite === true && own.self.questions.length >= 1 && own.self.submittedAt === null, mineOpen.b);
        const selfQs = own && own.self ? own.self.questions : [];
        const SELF_DRAFT = `SELF-DRAFT-${tag}`;
        const selfDraft = await call('PUT', `${C}/self`, cashier, { answers: { [(selfQs[0] || {}).id]: `${SELF_DRAFT} I trained two new cashiers.` } });
        check('the employee saves the self review without sending it', selfDraft.s === 200, selfDraft.b);
        let member = await call('GET', `${C}/members/${uid('cashier')}`, manager);
        check('the manager cannot read a self review that was not sent', member.s === 200 && member.b.self === null && !has(member.text, SELF_DRAFT), member.b);
        const selfAnswers = Object.fromEntries(selfQs.map((q, i) => [q.id, `Self review answer ${i + 1}: steady work at the register.`]));
        const selfSent = await call('PUT', `${C}/self`, cashier, { answers: selfAnswers, submit: true });
        check('the employee sends the self review', selfSent.s === 200 && Boolean(selfSent.b.self && selfSent.b.self.submittedAt), selfSent.b);
        member = await call('GET', `${C}/members/${uid('cashier')}`, manager);
        check('the manager now reads the self review', member.s === 200 && member.b.self && member.b.self.answers[(selfQs[0] || {}).id] === selfAnswers[(selfQs[0] || {}).id], member.b);

        const mgrRound = await call('GET', C, manager); const hrRound = await call('GET', C, hr);
        check('in the round the manager sees only their own team (2 of 3)', mgrRound.s === 200 && (mgrRound.b.rows || []).map((r) => r.userId).sort().join() === [uid('cashier'), uid('server')].sort().join() && mgrRound.b.wholeCompany === false, mgrRound.b);
        check('HR sees all three people and the progress', hrRound.s === 200 && (hrRound.b.rows || []).length === 3 && hrRound.b.progress.selfDone === 1, hrRound.b);
        check('the manager cannot open a person outside their team (404)', (await call('GET', `${C}/members/${uid('payroll')}`, manager)).s === 404);
        check('an employee cannot open a coworker\'s record in the round (403)', (await call('GET', `${C}/members/${uid('server')}`, cashier)).s === 403);

        const pick = (token, peerIds) => call('PUT', `${C}/members/${uid('cashier')}/coworkers`, token, { peerIds });
        check('asking only two coworkers is refused (400)', (await pick(manager, [uid('server'), uid('stocker')])).s === 400);
        check('the manager cannot ask themself (400)', (await pick(manager, [uid('manager'), uid('server'), uid('stocker')])).s === 400);
        check('an employee cannot choose the coworkers (403)', (await pick(cashier, [uid('server'), uid('stocker'), uid('leaver')])).s === 403);
        const picked = await pick(manager, [uid('server'), uid('stocker'), uid('leaver')]);
        check('the manager asks three coworkers for feedback about the cashier', picked.s === 200 && (picked.b.asked || []).length === 3, picked.b);

        const ANS = `${C}/peer-answers/${uid('cashier')}`;
        const asked = await call('GET', `${RC}/mine`, server);
        const request = (asked.b.requests || []).find((r) => r.cycleId === cycleId && r.subjectId === uid('cashier'));
        check('a coworker sees the request to write about the cashier', Boolean(request) && request.answered === false && request.questions.length >= 1, asked.b);
        const peerQ = request ? request.questions.map((q) => q.id) : ['p1'];
        check('nobody gives coworker feedback about themself (403)', (await call('POST', ANS, cashier, { answers: { [peerQ[0]]: 'I am great' } })).s === 403);
        check('someone who was not asked cannot answer (404)', (await call('POST', ANS, payroll, { answers: { [peerQ[0]]: 'Not asked' } })).s === 404);
        const PEER = [`PEER-A-${tag} always helps on the floor.`, `PEER-B-${tag} is on time every day.`, `PEER-C-${tag} is kind to customers.`];
        const first = await call('POST', ANS, server, { answers: { [peerQ[0]]: PEER[0] }, rating: 4 });
        check('the first coworker answers', first.s === 201, first.b);
        check('answering twice is refused (409)', (await call('POST', ANS, server, { answers: { [peerQ[0]]: 'Again' } })).s === 409);
        member = await call('GET', `${C}/members/${uid('cashier')}`, manager);
        check('with one answer the manager sees only a count, never the words', member.s === 200 && member.b.feedback && member.b.feedback.hidden === true && member.b.feedback.answered === 1 && !has(member.text, 'PEER-A-'), member.b.feedback);
        check('with one answer HR sees only a count too', !has((await call('GET', `${C}/members/${uid('cashier')}`, hr)).text, 'PEER-A-'));
        const second = await call('POST', ANS, stocker, { answers: { [peerQ[0]]: PEER[1] }, rating: 5 });
        const third = await call('POST', ANS, leaver, { answers: { [peerQ[0]]: PEER[2] } });
        check('two more coworkers answer', second.s === 201 && third.s === 201, { second: second.b, third: third.b });
        member = await call('GET', `${C}/members/${uid('cashier')}`, manager);
        const fb = member.b.feedback || {};
        check('with three answers the manager reads them combined', fb.hidden === false && fb.answered === 3 && PEER.every((t) => has(JSON.stringify(fb), t)) && fb.rating && fb.rating.count === 2 && fb.rating.average === 4.5, fb);
        check('the combined feedback does not say who wrote what', !['server', 'stocker', 'leaver'].some((k) => has(JSON.stringify(fb), uid(k)) || has(JSON.stringify(fb), P[k].name)), fb);
        const whileOpen = ((await call('GET', `${RC}/mine`, cashier)).b.cycles || []).find((c) => c.id === cycleId) || {};
        check('while the round is open the employee sees no coworker feedback', whileOpen.coworkerFeedback && whileOpen.coworkerFeedback.hidden === true && !has(JSON.stringify(whileOpen), 'PEER-A-'), whileOpen.coworkerFeedback);

        const MR = `${C}/members/${uid('cashier')}/manager-review`;
        const ROUND_PRIVATE = `ROUND-PRIVATE-${tag}`;
        const good = { overall: 4, ratings: { Reliability: 4 }, strengths: 'Reliable and careful with customers all period.', improvements: 'Ask for help sooner when the line is long.', nextSteps: 'Train as a shift lead.', privateNote: ROUND_PRIVATE };
        check('the employee cannot write their own manager review (403)', (await call('PUT', MR, cashier, good)).s === 403);
        const mr1 = await call('PUT', MR, manager, { ...good, strengths: 'First draft of what went well.' });
        check('the manager saves a draft of the manager review', mr1.s === 201 && mr1.b.state === 'draft', mr1.b);
        const roundReviewId = (mr1.b.review || {}).id;
        const mr2 = await call('PUT', MR, manager, { ...good, finish: true, baseUpdatedAt: (mr1.b.review || {}).updatedAt });
        check('the manager marks the manager review as finished', mr2.s === 200 && mr2.b.state === 'finished', mr2.b);
        check('before the round closes the employee cannot see the manager review', !((await call('GET', RV, cashier)).b.data || []).some((r) => r.id === roundReviewId));
        check('a manager cannot close the round (403)', (await call('POST', `${C}/close`, manager, {})).s === 403);
        const closed = await call('POST', `${C}/close`, hr, {});
        check('HR closes the round: the one finished review is shared', closed.s === 200 && closed.b.cycle.status === 'closed' && closed.b.shared === 1, closed.b);
        check('after closing nobody can write (409)', (await call('PUT', `${C}/self`, cashier, { answers: selfAnswers })).s === 409 && (await call('PUT', MR, manager, good)).s === 409);
        const afterClose = await call('GET', RV, cashier);
        const sharedRound = (afterClose.b.data || []).find((r) => r.id === roundReviewId);
        check('the employee now sees the manager review from the round, without the private note', Boolean(sharedRound) && sharedRound.status === 'shared' && sharedRound.strengths === good.strengths && !has(afterClose.text, ROUND_PRIVATE), afterClose.text.slice(0, 400));
        const ownClosed = ((await call('GET', `${RC}/mine`, cashier)).b.cycles || []).find((c) => c.id === cycleId) || {};
        check('after closing the employee sees the combined coworker feedback, with no names', ownClosed.status === 'closed' && ownClosed.coworkerFeedback && ownClosed.coworkerFeedback.hidden === false && PEER.every((t) => has(JSON.stringify(ownClosed.coworkerFeedback), t)) && !['server', 'stocker', 'leaver'].some((k) => has(JSON.stringify(ownClosed), uid(k))), ownClosed.coworkerFeedback);
        const serverClosed = await call('GET', `${RC}/mine`, server);
        check('another person in the round sees nothing written about the cashier', serverClosed.s === 200 && !has(serverClosed.text, 'PEER-B-') && !has(serverClosed.text, ROUND_PRIVATE), serverClosed.text.slice(0, 300));

        // ================================================================================== pulse survey, eNPS
        ctx.section('Pulse survey and eNPS from the starter templates');
        const SV = `${U}/surveys`;
        const svOpt = await call('GET', `${SV}/options`, hr);
        const tpl = (svOpt.b.templates || {});
        check('HR is offered the two starter templates', svOpt.s === 200 && tpl.pulse && tpl.enps && svOpt.b.canManage === true && svOpt.b.minFloor === 3, svOpt.b);
        check('an employee cannot create a survey (403)', (await call('POST', SV, cashier, { title: 'Nope', questions: [{ type: 'scale', text: 'Is this allowed?' }] })).s === 403);
        check('a manager cannot list surveys or results (403)', (await call('GET', SV, manager)).s === 403);
        const pulse = await call('POST', SV, hr, { title: `${(tpl.pulse || {}).title} ${tag}`, intro: (tpl.pulse || {}).intro, minResponses: 3, questions: (tpl.pulse || {}).questions });
        check('HR makes a pulse survey from the template (draft)', pulse.s === 201 && pulse.b.survey.status === 'draft' && pulse.b.survey.questions.length === 5, pulse.b);
        const pulseId = (pulse.b.survey || {}).id; ids.pulseSurveyId = pulseId;
        const pq = ((pulse.b.survey || {}).questions || []);
        const scaleIds = pq.filter((q) => q.type === 'scale').map((q) => q.id); const textId = (pq.find((q) => q.type === 'text') || {}).id;
        check('a draft survey takes no answers (409)', (await call('POST', `${SV}/${pulseId}/answers`, cashier, { answers: { [scaleIds[0]]: 4 } })).s === 409);
        const pulseOpen = await call('POST', `${SV}/${pulseId}/open`, hr, {});
        check('HR opens the survey', pulseOpen.s === 200 && pulseOpen.b.survey.status === 'open', pulseOpen.b);
        const offered = await call('GET', `${SV}/mine`, cashier);
        check('the employee is offered the survey', offered.s === 200 && (offered.b.data || []).some((s) => s.id === pulseId && s.answered === false), offered.b);
        check('an answer outside 1 to 5 is refused (400)', (await call('POST', `${SV}/${pulseId}/answers`, cashier, { answers: Object.fromEntries(scaleIds.map((q) => [q, 9])) })).s === 400);
        const scores = { cashier: 5, server: 4, stocker: 3, manager: 4 };
        const tokens = { cashier, server, stocker, manager };
        const COMMENTS = { cashier: `COMMENT-A-${tag} more notice for schedule changes`, server: `COMMENT-B-${tag} a second coffee machine`, stocker: `COMMENT-C-${tag} better hand trucks` };
        let answered = 0;
        for (const k of Object.keys(scores)) {
            const r = await call('POST', `${SV}/${pulseId}/answers`, tokens[k], { answers: { ...Object.fromEntries(scaleIds.map((q) => [q, scores[k]])), ...(COMMENTS[k] ? { [textId]: COMMENTS[k] } : {}) } });
            if (r.s === 201) answered += 1; else check(`${P[k].name} answers the pulse survey`, false, r.b);
        }
        check('four people answer the pulse survey', answered === 4, `${answered} of 4`);
        check('a second answer from the same person is refused (409)', (await call('POST', `${SV}/${pulseId}/answers`, cashier, { answers: Object.fromEntries(scaleIds.map((q) => [q, 1])) })).s === 409);
        const live = await call('GET', `${SV}/${pulseId}/results`, hr);
        check('while the survey is open HR sees only how many answered', live.s === 200 && live.b.results.hidden === true && live.b.results.responses === 4 && live.b.results.questions.length === 0, live.b.results);
        check('an employee cannot read results (403)', (await call('GET', `${SV}/${pulseId}/results`, cashier)).s === 403);
        const pulseClosed = await call('POST', `${SV}/${pulseId}/close`, hr, {});
        check('HR closes the survey', pulseClosed.s === 200 && pulseClosed.b.survey.status === 'closed', pulseClosed.b);
        const res = await call('GET', `${SV}/${pulseId}/results`, hr);
        const rq = (res.b.results || {}).questions || [];
        const firstScale = rq.find((q) => q.id === scaleIds[0]) || {}; const textQ = rq.find((q) => q.id === textId) || {};
        check('once closed the results show: 4 answers, average 4.0, 75% favourable', res.s === 200 && res.b.results.hidden === false && res.b.results.responses === 4 && firstScale.average === 4 && firstScale.favorable === 75, { results: res.b.results });
        check('the three comments are shown, with no names on them', (textQ.comments || []).length === 3 && Object.values(COMMENTS).every((c) => textQ.comments.includes(c)) && !Object.keys(scores).some((k) => has(JSON.stringify(res.b.results), uid(k)) || has(JSON.stringify(res.b.results), P[k].name)), textQ);
        check('a closed survey takes no more answers (409)', (await call('POST', `${SV}/${pulseId}/answers`, leaver, { answers: Object.fromEntries(scaleIds.map((q) => [q, 4])) })).s === 409);
        check('the auditor can read the results but cannot create a survey', (await call('GET', `${SV}/${pulseId}/results`, auditor)).s === 200 && (await call('POST', SV, auditor, { title: 'Nope', questions: [{ type: 'scale', text: 'Is this allowed?' }] })).s === 403);

        const enps = await call('POST', SV, hr, { title: `${(tpl.enps || {}).title} ${tag}`, intro: (tpl.enps || {}).intro, minResponses: 3, questions: (tpl.enps || {}).questions });
        const enpsId = (enps.b.survey || {}).id; ids.enpsSurveyId = enpsId;
        const eq = (((enps.b.survey || {}).questions || []).find((q) => q.type === 'enps') || {}).id;
        await call('POST', `${SV}/${enpsId}/open`, hr, {});
        const e1 = await call('POST', `${SV}/${enpsId}/answers`, cashier, { answers: { [eq]: 10 } });
        const e2 = await call('POST', `${SV}/${enpsId}/answers`, server, { answers: { [eq]: 9 } });
        const two = await call('GET', `${SV}/${enpsId}/results`, hr);
        const e3 = await call('POST', `${SV}/${enpsId}/answers`, stocker, { answers: { [eq]: 3 } });
        check('HR makes the "would you recommend us" survey from the template and three people answer', enps.s === 201 && e1.s === 201 && e2.s === 201 && e3.s === 201, { enps: enps.b, e1: e1.b, e2: e2.b, e3: e3.b });
        await call('POST', `${SV}/${enpsId}/close`, hr, {});
        const eres = await call('GET', `${SV}/${enpsId}/results`, hr);
        const en = ((eres.b.results || {}).questions || []).find((q) => q.id === eq) || {};
        check('with only two answers the count showed and nothing else', two.s === 200 && two.b.results.hidden === true && two.b.results.responses === 2, two.b.results);
        check('the eNPS score is right: 2 promoters, 1 detractor, score 33', eres.s === 200 && en.promoters === 2 && en.detractors === 1 && en.score === 33, eres.b.results);

        // ============================================================================ announcements and thanks
        ctx.section('Announcements: to everyone and to one location, pinned, read receipts');
        const AN = `${U}/announcements`;
        check('an employee cannot write an announcement (403)', (await call('POST', AN, cashier, { title: 'Nope', body: 'Nope' })).s === 403);
        check('an announcement for a location that does not exist is refused (400)', (await call('POST', AN, hr, { title: `Wrong place ${tag}`, body: 'Text', audience: { type: 'location', id: 'no-such-location' } })).s === 400);
        const all = await call('POST', AN, hr, { title: `Holiday hours ${tag}`, body: 'We close at 3 pm on Friday.\nSee you Monday.', pinned: true });
        check('HR writes a pinned announcement for everyone (draft)', all.s === 201 && all.b.announcement && all.b.announcement.pinned === true, all.b);
        const allId = (all.b.announcement || {}).id; ids.announcementId = allId;
        const mineAn = async (t) => (await call('GET', `${AN}/mine`, t)).b;
        check('a draft is not shown to employees', !((await mineAn(cashier)).data || []).some((a) => a.id === allId));
        const published = await call('POST', `${AN}/${allId}/publish`, hr, {});
        check('HR publishes it', published.s === 200 && published.b.announcement.publishedAt, published.b);
        const cafe = await call('POST', AN, hr, { title: `Cafe deep clean ${tag}`, body: 'South Lamar closes one hour early on Sunday.', audience: { type: 'location', id: state.ids.locations.second } });
        const cafeId = (cafe.b.announcement || {}).id;
        const cafePub = await call('POST', `${AN}/${cafeId}/publish`, hr, {});
        check('HR publishes a second announcement for the South Lamar location only', cafe.s === 201 && cafePub.s === 200, { cafe: cafe.b, cafePub: cafePub.b });
        const later = await call('POST', AN, hr, { title: `New parking rules ${tag}`, body: 'Park behind the building.' });
        await call('POST', `${AN}/${(later.b.announcement || {}).id}/publish`, hr, {});
        const cashierNews = await mineAn(cashier); const serverNews = await mineAn(server);
        check('a cashier at the main store sees the company announcement but not the cafe one', (cashierNews.data || []).some((a) => a.id === allId) && !(cashierNews.data || []).some((a) => a.id === cafeId), (cashierNews.data || []).map((a) => a.title));
        check('a server at South Lamar sees both', (serverNews.data || []).some((a) => a.id === allId) && (serverNews.data || []).some((a) => a.id === cafeId), (serverNews.data || []).map((a) => a.title));
        const order = (cashierNews.data || []).map((a) => a.id);
        check('the pinned announcement stays above a newer one', order.indexOf(allId) > -1 && order.indexOf(allId) < order.indexOf((later.b.announcement || {}).id), (cashierNews.data || []).map((a) => `${a.pinned ? 'pinned ' : ''}${a.title}`));
        check('the cashier cannot mark the cafe announcement as read (404)', (await call('POST', `${AN}/${cafeId}/read`, cashier, {})).s === 404);
        const read1 = await call('POST', `${AN}/${allId}/read`, cashier, {});
        const readAgain = await call('POST', `${AN}/${allId}/read`, cashier, {});
        const read2 = await call('POST', `${AN}/${allId}/read`, server, {});
        check('two people mark it as read; doing it twice changes nothing', read1.s === 201 && readAgain.s === 200 && readAgain.b.already === true && read2.s === 201, { read1: read1.b, readAgain: readAgain.b, read2: read2.b });
        const reads = await call('GET', `${AN}/${allId}/reads`, hr);
        check('HR sees who has read it: the two of them, by name', reads.s === 200 && reads.b.readCount === 2 && [P.cashier.name, P.server.name].every((n) => (reads.b.data || []).some((r) => r.name === n)), reads.b);
        check('an employee cannot see who has read it (403)', (await call('GET', `${AN}/${allId}/reads`, cashier)).s === 403);
        const hrList = await call('GET', AN, hr);
        const cafeRow = (hrList.b.data || []).find((a) => a.id === cafeId) || {}; const allRow = (hrList.b.data || []).find((a) => a.id === allId) || {};
        check('HR\'s list shows 2 readers for the company one, and that the cafe one is for 2 people', hrList.s === 200 && allRow.readCount === 2 && cafeRow.audienceCount === 2 && allRow.audienceCount >= 10, { all: allRow, cafe: cafeRow });
        check('a manager cannot open HR\'s announcement list (403)', (await call('GET', AN, manager)).s === 403);
        check('a published announcement cannot be deleted (409)', (await call('DELETE', `${AN}/${allId}`, hr)).s === 409);

        ctx.section('Thanks between coworkers: company values and the daily limit');
        const RG = `${U}/recognition`;
        const opt = await call('GET', `${RG}/options`, stocker);
        const values = opt.b.values || [];
        check('an employee sees the company values and the people to thank, but not themself', opt.s === 200 && values.length >= 1 && (opt.b.people || []).some((p) => p.id === uid('cashier')) && !(opt.b.people || []).some((p) => p.id === uid('stocker')), opt.b);
        const oldLimit = opt.b.dailyLimit;
        check('an employee cannot change the thanks settings (403)', (await call('PUT', `${RG}/settings`, stocker, { dailyLimit: 50 })).s === 403);
        const added = await call('PUT', `${RG}/settings`, hr, { values: [...values, { name: `Own the result ${tag}` }], dailyLimit: (opt.b.sentToday || 0) + 2 });
        const opt2 = await call('GET', `${RG}/options`, stocker);
        const newValue = (opt2.b.values || []).find((v) => v.name === `Own the result ${tag}`);
        check('HR adds a company value and sets the daily limit; employees can choose the new value', added.s === 200 && Boolean(newValue) && opt2.b.leftToday === 2, { added: added.b, options: opt2.b });
        const valueId = (newValue || values[0] || {}).id;
        check('you cannot thank yourself (400)', (await call('POST', `${RG}/thanks`, stocker, { toUserId: uid('stocker'), valueId, message: 'Well done me' })).s === 400);
        check('a thanks needs one of the company values (400)', (await call('POST', `${RG}/thanks`, stocker, { toUserId: uid('cashier'), valueId: 'not-a-value', message: 'Thanks for the help' })).s === 400);
        const t1 = await call('POST', `${RG}/thanks`, stocker, { toUserId: uid('cashier'), valueId, message: `THANKS-${tag} for covering my Saturday shift` });
        check('the stock clerk thanks the cashier', t1.s === 201 && t1.b.thanks && t1.b.leftToday === 1, t1.b);
        const thanksId = (t1.b.thanks || {}).id; ids.thanksId = thanksId;
        const t2 = await call('POST', `${RG}/thanks`, stocker, { toUserId: uid('server'), valueId, message: `Thanks ${tag} for the coffee run` });
        const t3 = await call('POST', `${RG}/thanks`, stocker, { toUserId: uid('leaver'), valueId, message: `Thanks ${tag} one too many` });
        check('a second thanks goes through, and the one over the daily limit is refused (409)', t2.s === 201 && t2.b.leftToday === 0 && t3.s === 409, { t2: t2.b, t3: t3.b });
        const restored = await call('PUT', `${RG}/settings`, hr, { values, dailyLimit: oldLimit });
        check('HR puts the settings back', restored.s === 200 && (await call('GET', `${RG}/options`, stocker)).b.dailyLimit === oldLimit, restored.b);
        const feed = await call('GET', `${RG}/feed`, server);
        check('the thanks is in the company feed for everyone', feed.s === 200 && (feed.b.data || []).some((x) => x.id === thanksId), feed.b);
        const got1 = await call('GET', `${RG}/mine`, cashier); const gave = await call('GET', `${RG}/mine`, stocker);
        check('the cashier has it under thanks received, the sender under thanks given', (got1.b.received || []).some((x) => x.id === thanksId) && (gave.b.given || []).some((x) => x.id === thanksId) && !(gave.b.received || []).some((x) => x.id === thanksId), { received: got1.b.received, given: gave.b.given });
        check('an employee cannot hide a thanks (403)', (await call('POST', `${RG}/thanks/${thanksId}/hide`, cashier, { reason: 'because' })).s === 403);
        const hidden = await call('POST', `${RG}/thanks/${thanksId}/hide`, hr, { reason: 'End-to-end check' });
        const feedHidden = await call('GET', `${RG}/feed`, server);
        check('HR hides it and it is gone from the feed', hidden.s === 200 && !(feedHidden.b.data || []).some((x) => x.id === thanksId), hidden.b);
        const shown = await call('POST', `${RG}/thanks/${thanksId}/show`, hr, {});
        check('HR shows it again', shown.s === 200 && ((await call('GET', `${RG}/feed`, server)).b.data || []).some((x) => x.id === thanksId), shown.b);
        const day = opt.b.today || ctx.today;
        const rep = await call('GET', `${RG}/report?from=${day}&to=${day}`, hr);
        check('HR\'s thanks report counts today\'s thanks', rep.s === 200 && rep.b.total >= 2, rep.b);
        check('an employee cannot read the thanks report (403)', (await call('GET', `${RG}/report?from=${day}&to=${day}`, cashier)).s === 403);

        // ==================================================================================== company equipment
        ctx.section('Company equipment: add, give, confirm, problem, return, history');
        const AS = `${U}/assets`;
        const NOTE = `INTERNAL-NOTE-${tag}`;
        check('an employee cannot add equipment or list all of it (403)', (await call('POST', AS, cashier, { name: 'Nope', category: 'Keys' })).s === 403 && (await call('GET', AS, cashier)).s === 403);
        check('an unknown kind of equipment is refused (400)', (await call('POST', AS, hr, { name: 'Rocket', category: 'Spaceship' })).s === 400);
        const laptop = await call('POST', AS, hr, { name: `Register laptop ${tag}`, category: 'Laptop or computer', tag: `LT-${tag}`, serial: `SN-${tag}`, cost: 1234.5, condition: 'new', notes: NOTE });
        check('HR adds a laptop with its cost and an internal note', laptop.s === 201 && laptop.b.item.status === 'available' && laptop.b.item.cost === 1234.5, laptop.b);
        const laptopId = (laptop.b.item || {}).id; ids.laptopAssetId = laptopId;
        check('a second item with the same tag is refused (409)', (await call('POST', AS, hr, { name: 'Other laptop', category: 'Laptop or computer', tag: `LT-${tag}` })).s === 409);
        const uniform = await call('POST', AS, hr, { name: `Barista apron and shirt ${tag}`, category: 'Uniform', tag: `UN-${tag}`, cost: 45, condition: 'new' });
        check('HR adds a uniform', uniform.s === 201, uniform.b);
        const uniformId = (uniform.b.item || {}).id;
        check('a manager cannot give equipment out (403)', (await call('POST', `${AS}/${laptopId}/assign`, manager, { userId: uid('cashier') })).s === 403);
        const gaveLaptop = await call('POST', `${AS}/${laptopId}/assign`, hr, { userId: uid('cashier'), note: 'With charger', condition: 'good', dueBack: ctx.addDays(ctx.today, 90) });
        check('HR gives the laptop to the cashier', gaveLaptop.s === 200 && gaveLaptop.b.item.status === 'assigned' && gaveLaptop.b.item.assignedTo === uid('cashier'), gaveLaptop.b);
        const gaveUniform = await call('POST', `${AS}/${uniformId}/assign`, hr, { userId: uid('leaver'), note: 'Size M' });
        check('HR gives the uniform to the barista (it stays with her)', gaveUniform.s === 200 && gaveUniform.b.item.assignedTo === uid('leaver'), gaveUniform.b);
        if (gaveUniform.s === 200) ids.leaverAssetId = uniformId;
        check('the same item cannot be given out twice (409)', (await call('POST', `${AS}/${laptopId}/assign`, hr, { userId: uid('server') })).s === 409);
        const mineAs = await call('GET', `${AS}/mine`, cashier);
        const held = (mineAs.b.data || []).find((a) => a.id === laptopId);
        check('the cashier sees the laptop under "my equipment"', mineAs.s === 200 && Boolean(held) && held.acknowledgedAt === null, mineAs.b);
        check('the holder never sees the cost or HR\'s internal note', mineAs.s === 200 && !has(mineAs.text, '1234.5') && !has(mineAs.text, NOTE) && !(held && ('cost' in held || 'notes' in held)), mineAs.text.slice(0, 400));
        const teamAs = await call('GET', AS, manager);
        const teamItems = teamAs.b.data || [];
        check('the manager sees their team\'s two items, without cost or internal notes', teamAs.s === 200 && teamAs.b.scope === 'team' && teamItems.some((a) => a.id === laptopId) && teamItems.some((a) => a.id === uniformId) && !has(teamAs.text, '1234.5') && !has(teamAs.text, NOTE) && !teamItems.some((a) => 'cost' in a), teamAs.text.slice(0, 400));
        check('the manager\'s view is read-only: no history, no changes (403)', (await call('GET', `${AS}/${laptopId}`, manager)).s === 403 && (await call('PUT', `${AS}/${laptopId}`, manager, { cost: 1 })).s === 403 && (await call('POST', `${AS}/${laptopId}/return`, manager, {})).s === 403);
        check('someone else cannot confirm the cashier\'s laptop (404)', (await call('POST', `${AS}/${laptopId}/acknowledge`, server, {})).s === 404);
        const ack = await call('POST', `${AS}/${laptopId}/acknowledge`, cashier, {});
        check('the cashier confirms "I have this"', ack.s === 200 && Boolean(ack.b.item && ack.b.item.acknowledgedAt) && !has(ack.text, '1234.5'), ack.b);
        const leaverAck = await call('POST', `${AS}/${uniformId}/acknowledge`, leaver, {});
        check('the barista confirms the uniform', leaverAck.s === 200, leaverAck.b);
        const problem = await call('POST', `${AS}/${laptopId}/problem`, cashier, { text: 'The screen has a crack in the corner' });
        check('the cashier reports a problem with it', problem.s === 200 && problem.b.item.problem && problem.b.item.problem.text === 'The screen has a crack in the corner', problem.b);
        const hrAs = await call('GET', AS, hr);
        const hrLaptop = (hrAs.b.data || []).find((a) => a.id === laptopId) || {};
        check('HR sees the confirmation, the problem and the cost', hrAs.s === 200 && hrAs.b.scope === 'all' && Boolean(hrLaptop.acknowledgedAt) && hrLaptop.problem && hrLaptop.cost === 1234.5 && hrLaptop.notes === NOTE, hrLaptop);
        const back = await call('POST', `${AS}/${laptopId}/return`, hr, { condition: 'damaged', note: 'Cracked screen' });
        check('HR takes the laptop back as damaged', back.s === 200 && back.b.item.status === 'available' && back.b.item.assignedTo === null && back.b.item.condition === 'damaged', back.b);
        check('it is gone from the cashier\'s equipment', !((await call('GET', `${AS}/mine`, cashier)).b.data || []).some((a) => a.id === laptopId));
        const repair = await call('POST', `${AS}/${laptopId}/status`, hr, { status: 'repair', note: 'Sent to the shop' });
        check('HR sends it for repair', repair.s === 200 && repair.b.item.status === 'repair', repair.b);
        const hist = await call('GET', `${AS}/${laptopId}`, hr);
        const history = (hist.b.item || {}).history || [];
        check('the history tells the whole story: given to the cashier, confirmed, problem, returned, repair', hist.s === 200 && history.length >= 5 && has(hist.text, P.cashier.name) && has(hist.text, 'Cracked screen') && has(hist.text, 'crack in the corner'), history);
        check('the auditor can read the history but cannot add equipment', (await call('GET', `${AS}/${laptopId}`, auditor)).s === 200 && (await call('POST', AS, auditor, { name: 'Nope', category: 'Keys' })).s === 403);
        const leaverItems = await call('GET', `${AS}/mine`, leaver);
        check('the uniform is still with the barista', leaverItems.s === 200 && (leaverItems.b.data || []).some((a) => a.id === uniformId), leaverItems.b);

        // ======================================================================================= job and pay history
        ctx.section('Job and pay history: a raise needs a second person');
        const CHR = `${U}/employees/${riley.uid}/comp-history`;
        const h0 = await call('GET', CHR, hr);
        const companyToday = h0.b.today || ctx.today;
        check('HR opens Riley\'s pay history (empty so far)', h0.s === 200 && h0.b.canSeePay === true && Array.isArray(h0.b.timeline), h0.b);
        check('an employee cannot read someone\'s pay history (403)', (await call('GET', CHR, cashier)).s === 403);
        check('a manager cannot propose a raise (403)', (await call('POST', CHR, manager, { effectiveDate: companyToday, reason: 'raise', payRate: 30 })).s === 403);
        check('a raise without a real reason is refused (400)', (await call('POST', CHR, hr, { effectiveDate: companyToday, reason: 'because', payRate: 20 })).s === 400);
        const small = await call('POST', CHR, hr, { effectiveDate: companyToday, reason: 'raise', payRate: 16.5 });
        check('a small raise (about 3%) takes effect at once, with no second person', small.s === 201 && small.b.needsApproval === false && small.b.record.status === 'approved', small.b);
        check('the profile shows $16.50', (await rateOf(riley.uid)).rate === 16.5);
        const raise = await call('POST', CHR, hr, { effectiveDate: companyToday, reason: 'raise', payRate: 20 });
        check('a bigger raise (to $20.00, about 21%) waits for approval', raise.s === 201 && raise.b.needsApproval === true && raise.b.record.status === 'pending_approval', raise.b);
        const raiseId = (raise.b.record || {}).id;
        check('until it is approved the profile still shows $16.50', (await rateOf(riley.uid)).rate === 16.5);
        const q1 = await call('GET', `${U}/comp-history/queue`, hr);
        check('the raise is in the queue of changes waiting for approval, with Riley\'s name', q1.s === 200 && (q1.b.pending || []).some((r) => r.id === raiseId && r.name === 'Riley Morgan' && r.payRate === 20), q1.b);
        check('an employee and a manager cannot open the queue (403)', (await call('GET', `${U}/comp-history/queue`, cashier)).s === 403 && (await call('GET', `${U}/comp-history/queue`, manager)).s === 403);
        const selfApprove = await call('POST', `${U}/comp-history/${raiseId}/approve`, hr, {});
        check('the person who proposed the raise cannot approve it (409)', selfApprove.s === 409, selfApprove.b);
        check('the payroll admin cannot approve a raise (403)', (await call('POST', `${U}/comp-history/${raiseId}/approve`, payroll, {})).s === 403);
        const approved = await call('POST', `${U}/comp-history/${raiseId}/approve`, owner, { note: 'Agreed at the Monday meeting' });
        check('the owner approves it and it takes effect', approved.s === 200 && approved.b.status === 'approved' && approved.b.applied === true, approved.b);
        const afterRaise = await rateOf(riley.uid);
        check('Riley\'s profile now shows the new rate, $20.00', afterRaise.rate === 20, afterRaise.text.slice(0, 400));

        const future = ctx.addDays(companyToday, 30);
        const promo = await call('POST', CHR, hr, { effectiveDate: future, reason: 'promotion', payRate: 23, jobTitle: 'Assistant Manager' });
        check('HR proposes a promotion with a raise to $23.00 that starts in 30 days; it waits for approval', promo.s === 201 && promo.b.needsApproval === true, promo.b);
        const promoId = (promo.b.record || {}).id;
        const promoOk = await call('POST', `${U}/comp-history/${promoId}/approve`, owner, {});
        check('the owner approves it; nothing changes yet because the date has not come', promoOk.s === 200 && promoOk.b.applied === false, promoOk.b);
        const q2 = await call('GET', `${U}/comp-history/queue`, hr);
        check('it moves to the list of scheduled changes', q2.s === 200 && (q2.b.scheduled || []).some((r) => r.id === promoId && r.effectiveDate === future) && !(q2.b.pending || []).some((r) => r.id === promoId || r.id === raiseId), q2.b);
        check('an employee cannot press "apply what is due" (403)', (await call('POST', `${U}/comp-history/apply-due`, cashier, {})).s === 403);
        const due = await call('POST', `${U}/comp-history/apply-due`, hr, {});
        check('"apply what is due" runs and leaves the future change alone', due.s === 200 && due.b.applied === 0, due.b);
        const afterDue = await rateOf(riley.uid);
        // the job title is not part of the profile answer; the people report shows it
        const titleNow = await call('POST', `${U}/report-builder/run`, hr, { definition: { dataset: 'people', columns: ['employeeId', 'jobTitle', 'payRate'], filters: [{ field: 'employeeId', op: 'is', value: riley.employeeId }] } });
        const rileyRow = ((titleNow.b.result || {}).rows || [])[0] || {};
        check('the profile still shows $20.00, and Riley is still a Shift Lead', afterDue.rate === 20 && rileyRow.jobTitle === 'Shift Lead' && rileyRow.payRate === 20, { profile: afterDue.text.slice(0, 300), report: titleNow.b.result });
        const h1 = await call('GET', `${CHR}?asOf=${future}`, hr);
        check('the history shows today\'s pay ($20.00) and, on the start date, $23.00 as Assistant Manager', h1.s === 200 && h1.b.current && h1.b.current.payRate === 20 && h1.b.asOfState && h1.b.asOfState.payRate === 23 && h1.b.asOfState.jobTitle === 'Assistant Manager' && (h1.b.timeline || []).length === 3, h1.b);
        ctx.skip('The promotion taking effect on its start date', 'the date is 30 days away and the run cannot move the clock; the hourly job and the "apply what is due" button do it on the day');
        const execHist = await call('GET', CHR, executive);
        check('the executive cannot read pay history (403)', execHist.s === 403, execHist.b);
        const cashierPay = await rateOf(uid('cashier'));
        check('the shared people keep their pay (the cashier is still at $18.50)', cashierPay.rate === 18.5, cashierPay.text.slice(0, 300));
        ctx.skip('Pay-review due dates', 'services/comp-due-rules.js has no route of its own: it only decides which approved changes are due, which the "apply what is due" route above uses');

        // ===================================================================================== direct-deposit splits
        ctx.section('Direct deposit split over two accounts');
        const DDS = `${U}/employees/${riley.uid}/direct-deposit/splits`;
        const accounts = [
            { bankName: 'Savings Bank', routingNumber: '021000021', accountNumber: '000111222333', accountType: 'savings', allocation: { type: 'amount', value: 100 } },
            { bankName: 'Everyday Bank', routingNumber: '021000021', accountNumber: '000444555666', accountType: 'checking', allocation: { type: 'remainder' } }
        ];
        check('splits without the employee\'s authorization are refused (400)', (await call('PUT', DDS, hr, { accounts })).s === 400);
        check('two accounts that both take "the rest" are refused (400)', (await call('PUT', DDS, hr, { authorization: true, accounts: accounts.map((a) => ({ ...a, allocation: { type: 'remainder' } })) })).s === 400);
        check('a coworker cannot set someone else\'s accounts (403)', (await call('PUT', DDS, cashier, { authorization: true, accounts })).s === 403);
        const split = await call('PUT', DDS, hr, { authorization: true, accounts });
        check('HR enters Riley\'s two accounts, with Riley\'s authorization: $100.00 to savings, the rest to checking', split.s === 200 && (split.b.accounts || []).length === 2, split.b);
        const readSplit = await call('GET', DDS, hr);
        check('the account numbers come back masked (last 4 digits only)', readSplit.s === 200 && (readSplit.b.accounts || []).length === 2 && !has(readSplit.text, '000111222333') && !has(readSplit.text, '000444555666') && has(readSplit.text, '2333') && has(readSplit.text, '5666') && !has(readSplit.text, 'accountNumberEncrypted'), readSplit.text.slice(0, 500));
        const prev = await call('GET', `${DDS}/preview?net=1000`, hr);
        const amounts = (prev.b.accounts || []).map((a) => a.amount);
        check('HR previews a $1,000.00 paycheck: $100.00 and $900.00', prev.s === 200 && amounts.join() === '100,900', prev.b);
        const tiny = await call('GET', `${DDS}/preview?net=60`, hr);
        check('a $60.00 paycheck cannot cover the fixed $100.00, and the preview says so', tiny.s === 200 && (tiny.b.accounts || []).reduce((s, a) => s + a.amount, 0) === 60 && Boolean(tiny.b.fixedShortfall), tiny.b);
        if (riley.password === state.password) {
            const own = await call('GET', DDS, rileyToken);
            check('Riley reads their own two accounts, masked the same way', own.s === 200 && (own.b.accounts || []).length === 2 && !has(own.text, '000111222333') && !has(own.text, '000444555666'), own.text.slice(0, 400));
        } else ctx.skip('Riley reads their own accounts', 'Riley could not replace the temporary password in this run (the change-password route allows 30 tries per 15 minutes per machine), and every route refuses a person who has not chosen a password yet');
        check('a coworker and a manager cannot read the accounts (403)', (await call('GET', DDS, cashier)).s === 403 && (await call('GET', DDS, manager)).s === 403);

        // ============================================================================================= pay schedules
        ctx.section('Pay schedules: create, preview, assign, members, export');
        const PS = `${U}/pay-schedules`;
        const friday = ctx.addDays(ctx.today, (5 - ctx.dayOfWeek(ctx.today) + 7) % 7 || 7);
        check('an employee and a manager cannot see pay schedules (403)', (await call('GET', PS, cashier)).s === 403 && (await call('GET', PS, manager)).s === 403);
        const draftPrev = await call('POST', `${PS}/preview`, payroll, { frequency: 'weekly', anchorPayDate: friday, payDayLag: 5, n: 4 });
        const nextDates = draftPrev.b.next || [];
        check('the payroll admin previews a weekly schedule before saving: the next 4 pay periods', draftPrev.s === 200 && nextDates.length === 4 && draftPrev.b.containing, draftPrev.b);
        check('a weekly schedule without a first pay date is refused (400)', (await call('POST', PS, payroll, { name: `No date ${tag}`, frequency: 'weekly' })).s === 400);
        const sched = await call('POST', PS, payroll, { name: `Weekly store ${tag}`, frequency: 'weekly', anchorPayDate: friday, payDayLag: 5 });
        check('the payroll admin creates the weekly schedule', sched.s === 201 && sched.b.schedule && sched.b.schedule.frequency === 'weekly', sched.b);
        const schedId = (sched.b.schedule || {}).id; ids.payScheduleId = schedId;
        check('a second schedule with the same name is refused (409)', (await call('POST', PS, payroll, { name: `Weekly store ${tag}`, frequency: 'weekly', anchorPayDate: friday })).s === 409);
        const savedPrev = await call('GET', `${PS}/${schedId}/preview?n=3`, payroll);
        check('the saved schedule shows its next 3 pay dates, a week apart', savedPrev.s === 200 && (savedPrev.b.next || []).length === 3 && JSON.stringify(savedPrev.b.next) === JSON.stringify(nextDates.slice(0, 3)), savedPrev.b);
        const twoWeek = await call('POST', PS, payroll, { name: `Every two weeks ${tag}`, frequency: 'biweekly', anchorPayDate: friday });
        const wrong = await call('POST', `${PS}/${(twoWeek.b.schedule || {}).id}/assign`, payroll, { userIds: [riley.uid] });
        check('a weekly-paid person is not put on a two-week schedule by accident', twoWeek.s === 201 && wrong.s === 200 && wrong.b.assigned === 0 && wrong.b.results[0].ok === false, { twoWeek: twoWeek.b, wrong: wrong.b });
        const assign = await call('POST', `${PS}/${schedId}/assign`, payroll, { userIds: [riley.uid, 'nobody-here'] });
        check('Riley is put on the weekly schedule; an unknown person is reported, not guessed', assign.s === 200 && assign.b.assigned === 1 && assign.b.results.some((r) => r.ok === false), assign.b);
        const members = await call('GET', `${PS}/members?scheduleId=${schedId}`, payroll);
        check('the members list of the schedule shows Riley', members.s === 200 && (members.b.data || []).length === 1 && members.b.data[0].id === riley.uid && members.b.data[0].scheduleName === `Weekly store ${tag}`, members.b);
        const listPs = await call('GET', PS, hr);
        check('HR\'s schedule list shows 1 person on it', listPs.s === 200 && (listPs.b.data || []).some((s) => s.id === schedId && s.members === 1), listPs.b);
        check('a schedule with people on it cannot be deleted (409), an empty one can', (await call('DELETE', `${PS}/${schedId}`, payroll)).s === 409 && (await call('DELETE', `${PS}/${(twoWeek.b.schedule || {}).id}`, payroll)).s === 200);
        const csv = await call('GET', `${PS}/export`, payroll);
        check('the export is a CSV with Riley and the schedule name', csv.s === 200 && /text\/csv/.test(csv.headers.get('content-type') || '') && csv.text.split(/\r?\n/).some((l) => has(l, 'Riley Morgan') && has(l, `Weekly store ${tag}`)), csv.text.slice(0, 400));

        // ============================================================================================ report builder
        ctx.section('Report builder');
        const RB = `${U}/report-builder`;
        check('the report builder needs a sign-in (401) and is not for employees or managers (403)', (await call('GET', `${RB}/options`, null)).s === 401 && (await call('GET', `${RB}/options`, cashier)).s === 403 && (await call('GET', `${RB}/options`, manager)).s === 403);
        const oHr = await call('GET', `${RB}/options`, hr); const oExe = await call('GET', `${RB}/options`, executive);
        const fieldsFor = (o, ds) => (((o.b.datasets || []).find((d) => d.key === ds) || {}).fields || []).map((f) => f.key);
        check('HR may report on people, equipment, goals and policy confirmations, with pay columns, and may save', oHr.s === 200 && ['people', 'equipment', 'goals', 'policy_confirmations'].every((k) => (oHr.b.datasets || []).some((d) => d.key === k)) && fieldsFor(oHr, 'people').includes('payRate') && oHr.b.canSave === true && oHr.b.canSeePay === true, oHr.b);
        check('the executive is offered people only, with no pay columns, and may not save', oExe.s === 200 && (oExe.b.datasets || []).map((d) => d.key).join() === 'people' && !fieldsFor(oExe, 'people').includes('payRate') && !fieldsFor(oExe, 'people').includes('payType') && oExe.b.canSave === false, oExe.b);
        check('no data set offers a taxpayer number', !/ssn|taxpayer/i.test(JSON.stringify(oHr.b.datasets || [])));
        const def = { dataset: 'people', columns: ['employeeId', 'name', 'department', 'jobTitle', 'payType', 'payRate'], filters: [{ field: 'payType', op: 'is', value: 'hourly' }], sortBy: 'payRate', sortDir: 'desc', groupBy: 'department' };
        const ran = await call('POST', `${RB}/run`, hr, { definition: def });
        const rows = (ran.b.result || {}).rows || []; const groups = ((ran.b.result || {}).groups || {}).rows || [];
        check('HR runs a people report: hourly people only, highest pay first', ran.s === 200 && rows.length >= hourly && rows.every((r) => r.payType === 'hourly') && rows.every((r, i) => i === 0 || rows[i - 1].payRate >= r.payRate) && rows.some((r) => r.name === 'Riley Morgan' && r.payRate === 20) && rows.some((r) => r.name === P.cashier.name && r.payRate === 18.5), ran.b.result);
        check(`and counts them by department: at least ${inStore} in Store and 2 in Cafe, adding up to everyone listed`, (groups.find((x) => x.key === 'Store') || {}).count >= inStore && (groups.find((x) => x.key === 'Cafe') || {}).count >= 2 && groups.reduce((n, x) => n + x.count, 0) === rows.length, groups);
        check('a column that does not exist is refused (400)', (await call('POST', `${RB}/run`, hr, { definition: { dataset: 'people', columns: ['name', 'ssn'] } })).s === 400);
        check('the executive cannot ask for a pay column (400)', (await call('POST', `${RB}/run`, executive, { definition: { dataset: 'people', columns: ['name', 'payRate'] } })).s === 400);
        const exeRun = await call('POST', `${RB}/run`, executive, { definition: { dataset: 'people', columns: ['name', 'department'], groupBy: 'department' } });
        check('the executive runs a people report without pay', exeRun.s === 200 && exeRun.b.result.total >= 11 && !has(exeRun.text, 'payRate'), exeRun.b);
        const goalsRep = await call('POST', `${RB}/run`, hr, { definition: { dataset: 'goals', columns: ['name', 'title', 'status', 'late'], filters: [{ field: 'late', op: 'is', value: 'yes' }] } });
        check('a goals report with the condition "late is yes" finds the cashier\'s late goal', goalsRep.s === 200 && ((goalsRep.b.result || {}).rows || []).some((r) => r.name === P.cashier.name && has(r.title, `Renew the food handler card ${tag}`)) && goalsRep.b.result.rows.every((r) => r.late === 'yes'), goalsRep.b.result);
        const equipRep = await call('POST', `${RB}/run`, hr, { definition: { dataset: 'equipment', columns: ['name', 'status', 'holder', 'confirmed'], groupBy: 'status' } });
        check('an equipment report shows the uniform with the barista, confirmed', equipRep.s === 200 && ((equipRep.b.result || {}).rows || []).some((r) => r.name === `Barista apron and shirt ${tag}` && r.holder === P.leaver.name && r.confirmed === 'yes'), equipRep.b.result);
        check('the payroll admin cannot report on goals (400)', (await call('POST', `${RB}/run`, payroll, { definition: { dataset: 'goals', columns: ['title'] } })).s === 400);

        check('the auditor and the executive cannot save a report (403)', (await call('POST', `${RB}/saved`, auditor, { name: `Nope ${tag}`, dataset: 'people', columns: ['name'] })).s === 403 && (await call('POST', `${RB}/saved`, executive, { name: `Nope ${tag}`, dataset: 'people', columns: ['name'] })).s === 403);
        check('saving needs a name (400)', (await call('POST', `${RB}/saved`, hr, { dataset: 'people', columns: ['name'] })).s === 400);
        const savedRep = await call('POST', `${RB}/saved`, hr, { name: `Hourly pay list ${tag}`, dataset: 'people', columns: ['name', 'department', 'payType', 'payRate'], filters: [{ field: 'payType', op: 'is', value: 'hourly' }], sortBy: 'name', groupBy: 'department', schedule: 'weekly' });
        check('HR saves the report with a weekly schedule; it is marked as including pay', savedRep.s === 201 && savedRep.b.report.includesPay === true && savedRep.b.report.schedule === 'weekly', savedRep.b);
        const repId = (savedRep.b.report || {}).id; ids.savedReportId = repId;
        const savedList = await call('GET', `${RB}/saved`, executive);
        check('the saved report is in the list, also for the executive', savedList.s === 200 && (savedList.b.data || []).some((r) => r.id === repId), savedList.b);
        const runSaved = await call('POST', `${RB}/saved/${repId}/run`, hr, {});
        check(`HR runs the saved report: the same hourly people (${hourly} or more) with their pay`, runSaved.s === 200 && runSaved.b.result.total >= hourly && runSaved.b.result.total === rows.length && runSaved.b.result.rows.every((r) => typeof r.payRate === 'number') && runSaved.b.removedColumns.length === 0, runSaved.b);
        const exeSaved = await call('POST', `${RB}/saved/${repId}/run`, executive, {});
        check('the executive is refused: the saved report filters on pay type, which that role cannot see (403)', exeSaved.s === 403, exeSaved.b);
        const plainRep = await call('POST', `${RB}/saved`, hr, { name: `People and pay ${tag}`, dataset: 'people', columns: ['name', 'department', 'payRate'], sortBy: 'name' });
        const exePlain = await call('POST', `${RB}/saved/${(plainRep.b.report || {}).id}/run`, executive, {});
        check('for a saved report that only shows pay, the executive gets it with the pay column taken out', plainRep.s === 201 && exePlain.s === 200 && exePlain.b.removedColumns.join() === 'payRate' && exePlain.b.result.rows.length >= 11 && exePlain.b.result.rows.every((r) => !('payRate' in r)) && !has(JSON.stringify(exePlain.b.result), '18.5'), exePlain.b);
        check('the auditor cannot make a dated copy (403)', (await call('POST', `${RB}/saved/${repId}/copies`, auditor, {})).s === 403);
        const copy = await call('POST', `${RB}/saved/${repId}/copies`, hr, {});
        check('HR makes a dated copy of the saved report', copy.s === 201 && copy.b.copy && copy.b.copy.day === companyToday && copy.b.copy.rows === rows.length && copy.b.copy.includesPay === true, copy.b);
        const copies = await call('GET', `${RB}/saved/${repId}/copies`, hr);
        check('the copy is listed under the report', copies.s === 200 && (copies.b.data || []).some((c) => c.id === (copy.b.copy || {}).id), copies.b);
        const dl = await call('GET', `${RB}/saved/${repId}/copies/${(copy.b.copy || {}).id}`, hr);
        check('the copy downloads as a CSV with a dated file name, Riley and the rate', dl.s === 200 && has(dl.b.fileName, companyToday) && /\.csv$/.test(dl.b.fileName) && String(dl.b.csv).split(/\r?\n/).some((l) => has(l, 'Riley Morgan') && has(l, '20')), dl.b);
        check('the executive cannot download a copy that includes pay (403)', (await call('GET', `${RB}/saved/${repId}/copies/${(copy.b.copy || {}).id}`, executive)).s === 403);
        check('HR deletes the second saved report', (await call('DELETE', `${RB}/saved/${(plainRep.b.report || {}).id}`, hr)).s === 200 && (await call('POST', `${RB}/saved/${(plainRep.b.report || {}).id}/run`, hr, {})).s === 404);

        // ========================================================================================== standard reports
        ctx.section('Standard reports: summary, headcount, turnover');
        const RP = `${U}/reports`;
        check('standard reports are not for employees or managers (403), and need a sign-in (401)', (await call('GET', `${RP}/summary`, cashier)).s === 403 && (await call('GET', `${RP}/headcount`, manager)).s === 403 && (await call('GET', `${RP}/summary`, null)).s === 401);
        const summary = await call('GET', `${RP}/summary`, executive);
        check('the executive reads the summary: headcount, turnover, paperwork', summary.s === 200 && summary.b.headcount >= 11 && Array.isArray(summary.b.trend) && summary.b.turnover90d && typeof summary.b.turnover90d.separations === 'number', summary.b);
        const head = await call('GET', `${RP}/headcount`, hr);
        check('the headcount report counts the people of this company and lists them', head.s === 200 && head.b.total === summary.b.headcount && (head.b.list || []).length === head.b.total && head.b.list.some((p) => p.name === 'Riley Morgan') && head.b.list.some((p) => p.name === P.cashier.name && p.department === 'Store'), { total: head.b.total, list: (head.b.list || []).slice(0, 3) });
        const headPast = await call('GET', `${RP}/headcount?asOf=${ctx.addDays(ctx.today, -50)}`, hr);
        check('headcount as of 50 days ago leaves out Riley, who started later', headPast.s === 200 && !(headPast.b.list || []).some((p) => p.name === 'Riley Morgan') && (headPast.b.list || []).some((p) => p.name === P.cashier.name), { total: headPast.b.total });
        const headCsv = await call('GET', `${RP}/headcount?format=csv`, hr);
        check('the headcount report downloads as a CSV with no pay and no taxpayer number', headCsv.s === 200 && /text\/csv/.test(headCsv.headers.get('content-type') || '') && has(headCsv.text, 'Riley Morgan') && !/ssn|taxpayer|pay rate/i.test(headCsv.text.split(/\r?\n/)[0]), headCsv.text.slice(0, 300));
        const turn = await call('GET', `${RP}/turnover`, hr);
        check('the turnover report reads, with the number of people who left', turn.s === 200 && typeof turn.b.separations === 'number' && Array.isArray(turn.b.list), turn.b);
        check('a turnover report whose start is after its end is refused (400)', (await call('GET', `${RP}/turnover?from=${ctx.today}&to=${ctx.addDays(ctx.today, -10)}`, hr)).s === 400);
        check('the accountant and the auditor can read the headcount report', (await call('GET', `${RP}/headcount`, await ctx.as('accountant'))).s === 200 && (await call('GET', `${RP}/headcount`, auditor)).s === 200);
    }
};
