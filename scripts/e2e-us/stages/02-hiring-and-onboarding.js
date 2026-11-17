/**
 * Stage 02: the company hires somebody new and gets them started.
 * A job is opened and approved, shows on the public careers list, a candidate applies there, moves through the pipeline
 * (interview, scorecard, background check, offer), signs the offer letter on the public signing page and is hired.
 * The new hire then signs in, fills in their forms, works through the onboarding checklist, signs the handbook and takes a
 * training, while HR does the I-9 check, E-Verify tracking and the state new-hire report. Last, more people are brought
 * in the other ways the app offers: a pasted sheet with personal set-up links, the company join link, and a file upload.
 *
 * People made here are extra people of the company (never the ten from stage 01). They are listed in state.ids.hiring.
 */

/** The smallest file the careers page accepts as a PDF resume */
const RESUME_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% made-up resume for the local end-to-end run\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
/** A drawn signature as the signing page sends it (a PNG as a data address) */
const SIGNATURE_PNG = `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(180, 7)]).toString('base64')}`;

/** The public apply form is sent as a form with a file, the way careers.html sends it */
async function applyOnCareersPage(ctx, orgId, fields) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append('resume', new Blob([RESUME_PDF], { type: 'application/pdf' }), 'resume.pdf');
    const res = await fetch(`${ctx.APP}/api/public/careers/${orgId}/apply`, { method: 'POST', body: form });
    const text = await res.text();
    let b = {};
    try { b = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { s: res.status, b, text };
}

const tokenFromSignUrl = (url) => { const m = /[?&]t=([^&]+)/.exec(String(url || '')); return m ? decodeURIComponent(m[1]) : null; };

module.exports = {
    id: '02',
    title: 'Hiring and onboarding',
    covers: ['US-B07', 'US-C01', 'US-C02', 'US-C03', 'US-C04', 'US-C05', 'US-C06', 'US-C07', 'US-C08', 'US-C09', 'US-C10'],
    async run(ctx) {
        const { call, check, U, state } = ctx;
        const P = '/api/public';
        const orgId = state.company.orgId;
        const domain = state.company.domain;
        const PASSWORD = state.password;
        const tag = `${state.run.slice(-4)}${Date.now().toString(36).slice(-4)}`; // unique for every run, also when the company is reused
        const yesterday = ctx.addDays(ctx.today, -1); // the company's clock (Central time) can be a day behind this machine's UTC date
        const longAgo = ctx.addDays(ctx.today, -200); // people brought in from an old system: outside the new-hire lists
        const mine = state.ids.hiring = { tag, people: {} };

        const owner = await ctx.as('owner');
        const hr = await ctx.as('hr');
        const manager = await ctx.as('manager');
        const cashier = await ctx.as('cashier');
        const auditor = await ctx.as('auditor');

        // ------------------------------------------------------------------------------------------ requisition
        ctx.section('A job is opened and approved');
        const jobTitle = `Shift Lead ${tag}`;
        const reqBody = { title: jobTitle, department: 'Store', location: 'Congress Ave Store', state: 'TX', employmentType: 'full_time', headcount: 1, payMin: 19, payMax: 23, payUnit: 'hour', description: 'Runs the floor on the evening shift.', hiringManagerId: state.people.manager.uid, approverIds: [state.people.owner.uid], targetStartDate: ctx.addDays(ctx.today, 14) };
        check('an employee cannot open a job (403)', (await call('POST', `${U}/hiring/requisitions`, cashier, reqBody)).s === 403);
        check('nobody opens a job without signing in (401)', (await call('POST', `${U}/hiring/requisitions`, null, reqBody)).s === 401);
        const made = await call('POST', `${U}/hiring/requisitions`, hr, reqBody);
        const requisition = made.b.requisition || {};
        if (!check('HR writes a job requisition, with the store manager as hiring manager and the owner as approver', made.s === 201 && requisition.id && requisition.status === 'draft' && (requisition.approvals || []).length === 1, made.b)) return;
        mine.requisitionId = requisition.id;
        const early = await call('POST', `${U}/hiring/requisitions/${requisition.id}/status`, hr, { status: 'open' });
        check('the job cannot be opened while the owner has not approved it', early.s === 409 && /approval/i.test(String(early.b.error)), early.b);
        const before = await call('GET', `${P}/careers/${orgId}/jobs`, null);
        check('the public careers list reads without signing in, and does not show the job yet', before.s === 200 && Array.isArray(before.b.jobs) && !before.b.jobs.some((j) => j.id === requisition.id), before.text.slice(0, 300));
        check('somebody who is not the approver cannot approve it (403)', (await call('POST', `${U}/hiring/requisitions/${requisition.id}/approve`, manager, { decision: 'approved' })).s === 403);
        const approved = await call('POST', `${U}/hiring/requisitions/${requisition.id}/approve`, owner, { decision: 'approved', note: 'Go ahead' });
        check('the owner approves the job', approved.s === 200 && (approved.b.approvals || []).every((a) => a.decision === 'approved'), approved.b);
        const opened = await call('POST', `${U}/hiring/requisitions/${requisition.id}/status`, hr, { status: 'open' });
        check('HR opens the approved job', opened.s === 200 && opened.b.requisition && opened.b.requisition.status === 'open', opened.b);
        const careers = await call('GET', `${P}/careers/${orgId}/jobs`, null);
        const posted = (careers.b.jobs || []).find((j) => j.id === requisition.id);
        check('the public careers list now shows the job with its pay range', careers.s === 200 && posted && posted.title === jobTitle && posted.payMin === 19 && posted.payMax === 23, careers.text.slice(0, 300));
        check('the public list says nothing about the hiring manager or the approvals', posted && posted.hiringManagerId === undefined && posted.approvals === undefined && !careers.text.includes(state.people.manager.uid), posted);

        // --------------------------------------------------------------------------------------------- candidate
        ctx.section('A candidate applies on the careers page and moves through the pipeline');
        const candName = { first: 'Nora', last: `Whitfield${tag}` };
        const candFull = `${candName.first} ${candName.last}`;
        const candEmail = `nora.${tag}@${domain}`;
        const applied = await applyOnCareersPage(ctx, orgId, { requisitionId: requisition.id, name: candFull, email: candEmail, phone: '512-555-0142', source: 'careers_page', privacyAccepted: 'true', eeo: JSON.stringify({}) });
        let candidateId = null;
        let hire = null; // { uid, employeeId, temporaryPassword, name }
        if (applied.s === 429) {
            ctx.skip('the candidate part of hiring (apply, pipeline, scorecard, interview, background check, offer, signed offer, hire)', `the public apply route allows 5 applications an hour from one address and this machine has used them (try again in ${applied.b.retryAfterSec || '?'} seconds, or start the app with PUBLIC_APPLY_MAX raised)`);
        } else if (check('the candidate applies through the public apply route with a resume and gets a reference', applied.s === 201 && applied.b.received === true && applied.b.reference, applied.text.slice(0, 300))) {
            const list = await call('GET', `${U}/hiring/candidates?requisitionId=${requisition.id}`, hr);
            const cand = (list.b.data || []).find((c) => c.email === candEmail);
            if (check('HR sees the new candidate in the Applied stage, with a resume on file', list.s === 200 && cand && cand.stage === 'applied' && cand.hasResume === true, list.text.slice(0, 300))) candidateId = cand.id;
        }

        if (candidateId) {
            mine.candidateId = candidateId;
            const C = `${U}/hiring/candidates/${candidateId}`;
            check('an employee cannot see candidates (403)', (await call('GET', `${U}/hiring/candidates`, cashier)).s === 403);
            const resume = await call('GET', `${C}/resume`, hr);
            check('HR downloads the resume', resume.s === 200 && resume.text.startsWith('%PDF-'), resume.text.slice(0, 80));
            const mgrList = await call('GET', `${U}/hiring/candidates`, manager);
            check('the hiring manager sees the candidate for their own job', mgrList.s === 200 && (mgrList.b.data || []).some((c) => c.id === candidateId), mgrList.text.slice(0, 200));
            const toScreen = await call('PUT', `${C}/stage`, manager, { stage: 'screen' });
            check('the hiring manager moves the candidate to Screen', toScreen.s === 200 && toScreen.b.stage === 'screen', toScreen.b);
            const mgrReject = await call('PUT', `${C}/stage`, manager, { stage: 'rejected', note: 'not for me to decide' });
            check('the hiring manager cannot reject a candidate: that is for HR (403)', mgrReject.s === 403, mgrReject.b);
            const toInterview = await call('PUT', `${C}/stage`, hr, { stage: 'interview' });
            check('HR moves the candidate to Interview', toInterview.s === 200 && toInterview.b.stage === 'interview', toInterview.b);
            const interview = await call('POST', `${C}/interviews`, manager, { when: `${ctx.addDays(ctx.today, 2)}T15:00:00-06:00`, interviewers: ['Maria Gonzalez', 'Hannah Reyes'], location: 'Congress Ave Store', kind: 'in person' });
            check('the hiring manager schedules an interview', interview.s === 201 && (interview.b.interviews || []).length === 1, interview.b);
            const ratings = { 'Role knowledge': 4, Communication: 5, 'Problem solving': 4, Teamwork: 5, Reliability: 4 };
            const incomplete = await call('POST', `${C}/scorecards`, manager, { round: 'On site', ratings: { Communication: 5 }, recommendation: 'yes' });
            check('a scorecard that leaves skills unrated is refused (400)', incomplete.s === 400, incomplete.b);
            const card = await call('POST', `${C}/scorecards`, manager, { round: 'On site', ratings, recommendation: 'strong_yes', notes: 'Calm with customers, knows the register.' });
            check('the hiring manager submits a scorecard and gets the average (4.4)', card.s === 201 && card.b.average === 4.4, card.b);
            const note = await call('POST', `${C}/notes`, hr, { text: 'References checked by phone.' });
            check('HR adds a note', note.s === 201, note.b);
            const detail = await call('GET', C, hr);
            const cd = detail.b.candidate || {};
            check('the candidate record shows the stage history, the interview, the scorecard and the note', detail.s === 200 && (cd.stageHistory || []).length === 3 && (cd.interviews || []).length === 1 && (cd.scorecards || []).length === 1 && cd.scorecardAverage === 4.4 && (cd.notes || []).length === 1, { stages: (cd.stageHistory || []).map((x) => x.stage), interviews: (cd.interviews || []).length, scorecards: (cd.scorecards || []).length, avg: cd.scorecardAverage, notes: (cd.notes || []).length });

            // ------------------------------------------------------------------------------------ background check
            ctx.section('Background check on the mock provider');
            const B = `${C}/background`;
            check('the hiring manager cannot touch background checks (403)', (await call('POST', `${B}/disclosure`, manager, { standalone: true })).s === 403);
            const disclosure = await call('POST', `${B}/disclosure`, hr, { standalone: true });
            check('HR records that the standalone disclosure was given', disclosure.s === 200 && disclosure.b.check && disclosure.b.check.disclosureAt, disclosure.b);
            const tooSoon = await call('POST', `${B}/order`, hr, { package: 'standard' });
            check('the report cannot be ordered before the candidate has given permission', tooSoon.s === 409, tooSoon.b);
            const authorization = await call('POST', `${B}/authorization`, hr, { authorized: true, method: 'paper' });
            check('HR records the candidate\'s written permission', authorization.s === 200 && authorization.b.check && authorization.b.check.status === 'ready_to_order', authorization.b);
            const order = await call('POST', `${B}/order`, hr, { package: 'standard' });
            check('HR orders the report from the mock provider', order.s === 200 && order.b.check && order.b.check.provider === 'mock' && order.b.check.status === 'in_progress' && /^MOCK-/.test(String(order.b.check.reportReference)), order.b);
            const result = await call('POST', `${B}/refresh`, hr, {});
            check('the result comes back clear', result.s === 200 && result.b.check && result.b.check.result === 'clear' && result.b.check.status === 'clear', result.b);
            const bgList = await call('GET', `${U}/hiring/background`, hr);
            check('the background-check list shows this check as clear', bgList.s === 200 && (bgList.b.data || []).some((x) => x.id === candidateId && x.status === 'clear'), bgList.text.slice(0, 300));
            ctx.skip('a background check with a real screening company', 'only the mock provider exists; a real one needs a contract and a key');

            // ------------------------------------------------------------------------------------- offer and e-sign
            ctx.section('Offer, offer letter signed by the candidate, hire');
            const offer = await call('PUT', `${C}/offer`, hr, { payRate: 21, payUnit: 'hour', startDate: yesterday, jobTitle });
            check('HR prepares the offer and the candidate moves to the Offer stage', offer.s === 200 && offer.b.stage === 'offer' && offer.b.offer && offer.b.offer.payRate === 21, offer.b);
            const notYet = await call('POST', `${C}/hire`, hr, {});
            check('the candidate cannot be hired before the offer is accepted', notYet.s === 409, notYet.b);
            check('an employee cannot send documents for signature (403)', (await call('POST', `${U}/esign/requests`, cashier, { templateId: 'x', signerType: 'candidate', candidateId })).s === 403);
            const seeded = await call('POST', `${U}/esign/templates/seed-defaults`, hr, {});
            const templates = await call('GET', `${U}/esign/templates`, hr);
            const offerTpl = (templates.b.data || []).find((t) => t.type === 'offer_letter');
            check('the starter document templates are there (offer letter, handbook acknowledgement)', seeded.s === 200 && templates.s === 200 && offerTpl && (templates.b.data || []).some((t) => t.type === 'handbook_ack'), templates.text.slice(0, 300));
            const sent = offerTpl ? await call('POST', `${U}/esign/requests`, hr, { templateId: offerTpl.id, signerType: 'candidate', candidateId }) : { s: 0, b: {} };
            const offerToken = tokenFromSignUrl(sent.b.signUrl);
            check('HR sends the offer letter for e-signature and gets the signing link to pass on', sent.s === 201 && offerToken && sent.b.request && sent.b.request.status === 'pending', sent.b);
            ctx.skip('the signing link reaching the candidate by email', 'the app shows the link to HR to pass on; it sends no email');
            if (offerToken) {
                mine.offerSignRequestId = sent.b.request.id;
                const page = await call('GET', `${P}/sign/${offerToken}`, null);
                check('the candidate opens the public signing page and reads the letter with the job title, pay and start date', page.s === 200 && page.b.signerName === candFull && String(page.b.html).includes(jobTitle) && String(page.b.html).includes('$21.00') && String(page.b.html).includes(yesterday), String(page.b.html || page.text).slice(0, 400));
                const wrongName = await call('POST', `${P}/sign/${offerToken}/sign`, null, { consent: true, typedName: 'Somebody Else', signatureData: SIGNATURE_PNG });
                check('signing with another name is refused (400)', wrongName.s === 400, wrongName.b);
                const noConsent = await call('POST', `${P}/sign/${offerToken}/sign`, null, { consent: false, typedName: candFull, signatureData: SIGNATURE_PNG });
                check('signing without agreeing to electronic signatures is refused (400)', noConsent.s === 400, noConsent.b);
                const signedOffer = await call('POST', `${P}/sign/${offerToken}/sign`, null, { consent: true, typedName: candFull, signatureData: SIGNATURE_PNG });
                check('the candidate signs the offer letter through the public signing route', signedOffer.s === 200 && signedOffer.b.signedAt, signedOffer.b);
                const again = await call('GET', `${P}/sign/${offerToken}`, null);
                check('the signing link cannot be used a second time', again.s === 410 && again.b.code === 'signed', again.b);
                const afterSign = await call('GET', C, hr);
                check('the signed offer marks the offer accepted', afterSign.s === 200 && afterSign.b.candidate && afterSign.b.candidate.offerStatus === 'accepted', afterSign.b.candidate && { offerStatus: afterSign.b.candidate.offerStatus });
                const cert = await call('GET', `${U}/esign/requests/${sent.b.request.id}/certificate`, hr);
                check('HR downloads the completion certificate of the signed letter', cert.s === 200 && cert.text.includes(candFull), cert.text.slice(0, 200));
                const sigList = await call('GET', `${U}/esign/requests?candidateId=${candidateId}`, auditor);
                check('the auditor sees the request as signed', sigList.s === 200 && (sigList.b.data || []).some((r) => r.id === sent.b.request.id && r.status === 'signed'), sigList.text.slice(0, 200));
            }
            check('the hiring manager cannot hire: that is for HR (403)', (await call('POST', `${C}/hire`, manager, {})).s === 403);
            const hired = await call('POST', `${C}/hire`, hr, {});
            const e = hired.b.employee || {};
            if (check('HR hires the candidate, who becomes a person with an employee number and a temporary password', hired.s === 201 && e.uid && e.employeeId && e.temporaryPassword && e.name === candFull, hired.b)) hire = e;
            const afterHire = await call('GET', C, hr);
            check('the candidate record is now Hired and points to the new person', afterHire.s === 200 && afterHire.b.candidate && afterHire.b.candidate.stage === 'hired' && afterHire.b.candidate.personId === e.uid && afterHire.b.candidate.employeeId === e.employeeId, afterHire.b.candidate && { stage: afterHire.b.candidate.stage, personId: afterHire.b.candidate.personId });
            check('hiring the same candidate twice is refused (409)', (await call('POST', `${C}/hire`, hr, {})).s === 409);
            const filled = await call('GET', `${U}/hiring/requisitions/${requisition.id}`, hr);
            const gone = await call('GET', `${P}/careers/${orgId}/jobs`, null);
            check('the job is filled and is no longer on the public careers list', filled.s === 200 && filled.b.requisition.status === 'filled' && filled.b.requisition.filledCount === 1 && gone.s === 200 && !(gone.b.jobs || []).some((j) => j.id === requisition.id), { status: filled.b.requisition && filled.b.requisition.status, stillListed: (gone.b.jobs || []).some((j) => j.id === requisition.id) });
            const funnel = await call('GET', `${U}/hiring/funnel?requisitionId=${requisition.id}`, hr);
            check('the hiring funnel for the job reads', funnel.s === 200, funnel.b);
        }

        // Without a candidate (the apply limit), the rest still runs on a person added directly
        if (!hire) {
            const direct = await call('POST', `${U}/employees`, hr, { firstName: candName.first, lastName: candName.last, email: candEmail, role: 'employee', startDate: yesterday, jobTitle, department: 'Store' });
            if (!check('a new person is added directly so that onboarding can be checked', direct.s === 201 && direct.b.employee && direct.b.employee.uid, direct.b)) return;
            hire = direct.b.employee;
        }
        const nh = { key: 'newhire', uid: hire.uid, employeeId: hire.employeeId, email: candEmail, password: PASSWORD, name: candFull, title: jobTitle, viaCandidate: Boolean(candidateId) };
        mine.people.newhire = nh;
        ctx.save();

        // ------------------------------------------------------------------------------------- first sign-in
        ctx.section('The new hire signs in for the first time');
        let me = null;
        try {
            const temp = await ctx.signIn(candEmail, hire.temporaryPassword);
            const blocked = await call('GET', `${U}/me/profile`, temp);
            check('with the temporary password nothing opens until a new password is chosen (403)', blocked.s === 403 && blocked.b.code === 'password_change_required', blocked.b);
            const changed = await call('POST', '/api/auth/change-password', temp, { currentPassword: hire.temporaryPassword, newPassword: PASSWORD });
            check('the new hire chooses their own password and is sent to onboarding', changed.s === 200 && changed.b.next === 'us-onboarding.html', changed.b);
            me = await ctx.signIn(candEmail, PASSWORD);
        } catch (err) { check('the new hire signs in', false, err.message); }
        if (!me) return;
        const perms = await call('GET', `${U}/me/permissions`, me);
        check('the new hire is a plain employee of this company', perms.s === 200 && /employee/.test(String(perms.b.role)), perms.b);
        if (candidateId) {
            const docs = await call('GET', `${U}/vault/documents`, me);
            check('the signed offer letter is among the new hire\'s own documents', docs.s === 200 && (docs.b.data || []).some((d) => /offer/i.test(`${d.title} ${d.category}`)), docs.text.slice(0, 300));
        }

        // ---------------------------------------------------------------------------------------- checklist
        ctx.section('The onboarding checklist appears and is worked through');
        const myLists = await call('GET', `${U}/checklists/mine`, me);
        const onboardingMine = (myLists.b.lists || []).find((l) => l.kind === 'onboarding');
        const myTaskIds = onboardingMine ? onboardingMine.tasks.map((t) => t.id) : [];
        if (!check('the new hire sees their onboarding checklist with only their own tasks (W-4, I-9, bank account, handbook, emergency contact)', myLists.s === 200 && onboardingMine && ['w4', 'i9_section1', 'direct_deposit', 'handbook', 'emergency_contact'].every((t) => myTaskIds.includes(t)) && onboardingMine.tasks.every((t) => t.assignee === 'employee'), myLists.text.slice(0, 400))) return;
        const listId = onboardingMine.id;
        const T = `${U}/checklists/person/${nh.uid}/${listId}/tasks`;
        const hrView = await call('GET', `${U}/checklists/person/${nh.uid}`, hr);
        const full = ((hrView.b.lists || []).find((l) => l.id === listId) || { tasks: [] });
        check('HR sees the whole list, with the HR tasks too (document check, payroll, state new-hire report)', hrView.s === 200 && ['i9_section2', 'manager_told', 'payroll_added', 'new_hire_report'].every((t) => full.tasks.some((x) => x.id === t)) && full.summary && full.summary.complete === false, hrView.text.slice(0, 300));
        check('another employee cannot open the new hire\'s checklist (403)', (await call('GET', `${U}/checklists/person/${nh.uid}`, cashier)).s === 403);

        const w4 = await call('PUT', `${U}/employees/${nh.uid}/w4`, me, { taxYear: Number(yesterday.slice(0, 4)), filingStatus: 'single_or_mfs', multipleJobs: false, qualifyingChildren: 0, otherDependents: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exemptFromWithholding: false, signedName: candFull, declarationAccepted: true });
        check('the new hire fills in the W-4', w4.s === 200, w4.b);
        const i9 = await call('PUT', `${U}/employees/${nh.uid}/i9/section1`, me, { citizenshipStatus: 'us_citizen', signedName: candFull, attestation: true });
        check('the new hire fills in I-9 Section 1', i9.s === 200, i9.b);
        const dd = await call('PUT', `${U}/employees/${nh.uid}/direct-deposit`, me, { bankName: 'Test Bank', routingNumber: '021000021', accountNumber: `00098${String(Date.now()).slice(-6)}`, accountType: 'checking', authorization: true });
        check('the new hire adds a bank account for direct deposit', dd.s === 200, dd.b);
        check('the new hire cannot do the employer\'s part of their own I-9 (Section 2)', (await call('PUT', `${U}/employees/${nh.uid}/i9/section2`, me, { listA: { type: 'us_passport', issuingAuthority: 'U.S. Department of State', number: 'P1' }, examinedOn: yesterday, examinationMethod: 'in_person', signerName: candFull, signerTitle: 'Shift Lead', certification: true })).s === 403);
        const afterForms = await call('GET', `${U}/checklists/mine`, me);
        const formTasks = (((afterForms.b.lists || []).find((l) => l.id === listId) || { tasks: [] }).tasks).filter((t) => ['w4', 'i9_section1', 'direct_deposit'].includes(t.id));
        check('the three form tasks tick themselves once the forms are filled in', afterForms.s === 200 && formTasks.length === 3 && formTasks.every((t) => t.done && t.doneByData), formTasks.map((t) => ({ id: t.id, done: t.done })));
        const tickOwn = await call('PUT', `${T}/emergency_contact`, me, { status: 'done', note: 'Gave my sister\'s number' });
        check('the new hire ticks one of their own tasks', tickOwn.s === 200, tickOwn.b);
        const tickHrs = await call('PUT', `${T}/manager_told`, me, { status: 'done' });
        check('the new hire cannot tick an HR task (403)', tickHrs.s === 403, tickHrs.b);

        ctx.section('HR does its part: profile, manager, I-9 Section 2');
        const ssnDigits = `541${String(10 + (Date.now() % 89))}${String(1000 + (Date.now() % 8999))}`;
        const ssn = `${ssnDigits.slice(0, 3)}-${ssnDigits.slice(3, 5)}-${ssnDigits.slice(5)}`; // a made-up number for the local run
        const profile = await call('PUT', `${U}/employees/${nh.uid}/profile`, hr, {
            legalFirstName: candName.first, legalLastName: candName.last, dateOfBirth: '1994-02-17', homeAddress: { line1: '415 Barton Springs Rd', city: 'Austin', state: 'TX', zip: '78704' },
            workState: 'TX', classification: 'W2', employmentType: 'full_time', payFrequency: 'weekly', payType: 'hourly', payRate: 21, flsaStatus: 'non_exempt',
            jobTitle, startDate: yesterday, departmentId: state.ids.departments.store, locationId: state.ids.locations.main, taxpayerIdType: 'SSN', taxpayerId: ssn
        });
        check('HR completes the new hire\'s US profile (address, pay as in the offer, SSN)', profile.s === 200, profile.b);
        const boss = await call('PUT', `${U}/people/${nh.uid}/manager`, owner, { managerId: state.people.manager.uid });
        check('the new hire reports to the store manager', boss.s === 200, boss.b);
        const tickTold = await call('PUT', `${T}/manager_told`, hr, { status: 'done' });
        check('HR ticks "tell the new hire who their manager is"', tickTold.s === 200, tickTold.b);
        const section2 = await call('PUT', `${U}/employees/${nh.uid}/i9/section2`, hr, { listA: { type: 'us_passport', title: 'U.S. Passport', issuingAuthority: 'U.S. Department of State', number: `P7${String(Date.now()).slice(-6)}`, expiresOn: ctx.addDays(ctx.today, 1500) }, examinedOn: yesterday, examinationMethod: 'in_person', signerName: 'Hannah Reyes', signerTitle: 'HR Manager', certification: true });
        check('HR checks the documents and completes I-9 Section 2', section2.s === 200, section2.b);
        const custom = await call('POST', T, hr, { title: 'Walk the new hire through closing the store', assignee: 'manager', dueDate: ctx.addDays(ctx.today, 5), required: false });
        const customId = custom.b.task && custom.b.task.id;
        check('HR adds a task of its own for the manager', custom.s === 201 && customId, custom.b);
        if (customId) {
            check('an employee who is not the manager cannot tick it (403)', (await call('PUT', `${T}/${customId}`, cashier, { status: 'done' })).s === 403);
            const byManager = await call('PUT', `${T}/${customId}`, manager, { status: 'done' });
            check('the new hire\'s manager ticks the manager task', byManager.s === 200, byManager.b);
        }
        const overview = await call('GET', `${U}/checklists/overview`, hr);
        const openFor = (overview.b.data || []).filter((r) => r.userId === nh.uid).map((r) => r.taskId);
        check('HR\'s open-task list shows what is still open for the new hire (handbook, payroll, new-hire report) and not what is done', overview.s === 200 && ['handbook', 'payroll_added', 'new_hire_report'].every((t) => openFor.includes(t)) && !openFor.includes('w4') && !openFor.includes('i9_section2') && !openFor.includes('manager_told'), openFor);

        // ---------------------------------------------------------------------------------------- handbook
        ctx.section('Handbook acknowledgement by e-signature');
        const tplList = await call('GET', `${U}/esign/templates`, hr);
        let handbookTpl = (tplList.b.data || []).find((t) => t.type === 'handbook_ack');
        if (!handbookTpl) { await call('POST', `${U}/esign/templates/seed-defaults`, hr, {}); handbookTpl = ((await call('GET', `${U}/esign/templates`, hr)).b.data || []).find((t) => t.type === 'handbook_ack'); }
        const hbSent = handbookTpl ? await call('POST', `${U}/esign/requests`, hr, { templateId: handbookTpl.id, signerType: 'employee', userId: nh.uid }) : { s: 0, b: { error: 'no handbook template' } };
        if (check('HR sends the handbook acknowledgement to the new hire', hbSent.s === 201 && hbSent.b.request && hbSent.b.request.id, hbSent.b)) {
            const hbId = hbSent.b.request.id;
            const twice = await call('POST', `${U}/esign/requests`, hr, { templateId: handbookTpl.id, signerType: 'employee', userId: nh.uid });
            check('the same document cannot be sent twice while the first is still open (409)', twice.s === 409, twice.b);
            const myDocs = await call('GET', `${U}/esign/my`, me);
            check('the new hire sees the handbook waiting for their signature', myDocs.s === 200 && (myDocs.b.data || []).some((r) => r.id === hbId && ['pending', 'viewed'].includes(r.status)), myDocs.b);
            check('another employee cannot get the new hire\'s signing link (403)', (await call('POST', `${U}/esign/my/${hbId}/link`, cashier, {})).s === 403);
            const link = await call('POST', `${U}/esign/my/${hbId}/link`, me, {});
            const hbToken = tokenFromSignUrl(link.b.signUrl);
            check('the new hire opens their own signing link from "my documents"', link.s === 200 && hbToken, link.b);
            const oldLink = await call('GET', `${P}/sign/${tokenFromSignUrl(hbSent.b.signUrl)}`, null);
            check('the link HR was first shown stops working once the new hire has their own', oldLink.s === 404, oldLink.b);
            if (hbToken) {
                const hbPage = await call('GET', `${P}/sign/${hbToken}`, null);
                const hbSigned = await call('POST', `${P}/sign/${hbToken}/sign`, null, { consent: true, typedName: candFull, signatureData: SIGNATURE_PNG });
                check('the new hire reads and signs the handbook acknowledgement', hbPage.s === 200 && String(hbPage.b.html).includes(candFull) && hbSigned.s === 200, { page: hbPage.s, signed: hbSigned.b });
                const mySigned = await call('GET', `${U}/esign/my`, me);
                const signedDocs = await call('GET', `${U}/vault/documents`, me);
                check('it shows as signed, and the signed copy is among the new hire\'s documents', (mySigned.b.data || []).some((r) => r.id === hbId && r.status === 'signed') && (signedDocs.b.data || []).some((d) => /handbook/i.test(String(d.title))), { my: mySigned.b.data, docs: (signedDocs.b.data || []).map((d) => d.title) });
            }
            const tickHandbook = await call('PUT', `${T}/handbook`, me, { status: 'done' });
            check('the new hire ticks "read the employee handbook"', tickHandbook.s === 200, tickHandbook.b);
        }

        // ---------------------------------------------------------------------------------------- E-Verify
        ctx.section('E-Verify case tracking');
        const settingsBefore = await call('GET', `${U}/hiring/settings`, hr);
        const everifyWas = (settingsBefore.b.everify || {}).used === true;
        const caseBody = { userId: nh.uid, caseNumber: `EV${tag.toUpperCase()}2026`, photoMatchRequired: false, notes: 'Opened on the E-Verify website' };
        if (!everifyWas) {
            const off = await call('POST', `${U}/hiring/everify/cases`, hr, caseBody);
            check('while E-Verify is switched off for the company, no case can be recorded (409)', off.s === 409, off.b);
        }
        const on = await call('PUT', `${U}/hiring/settings`, hr, { everify: { used: true } });
        check('HR switches E-Verify on for the company', on.s === 200, on.b);
        const missing = await call('GET', `${U}/hiring/everify/cases`, hr);
        check('the new hire is listed as still needing an E-Verify case', missing.s === 200 && missing.b.used === true && (missing.b.missing || []).some((m) => m.userId === nh.uid), missing.text.slice(0, 300));
        check('the auditor can read the cases but cannot record one (403)', (await call('GET', `${U}/hiring/everify/cases`, auditor)).s === 200 && (await call('POST', `${U}/hiring/everify/cases`, auditor, caseBody)).s === 403);
        const ev = await call('POST', `${U}/hiring/everify/cases`, hr, caseBody);
        const evCase = ev.b.case || {};
        if (check('HR records the E-Verify case number with its due date', ev.s === 201 && evCase.id && evCase.status === 'initial' && evCase.dueDate && evCase.hireDate === yesterday, ev.b)) {
            mine.everifyCaseId = evCase.id;
            check('a second case for the same person is refused (409)', (await call('POST', `${U}/hiring/everify/cases`, hr, caseBody)).s === 409);
            const authorized = await call('POST', `${U}/hiring/everify/cases/${evCase.id}/status`, hr, { status: 'employment_authorized' });
            check('the case moves to Employment authorized', authorized.s === 200 && authorized.b.case.status === 'employment_authorized', authorized.b);
            const backwards = await call('POST', `${U}/hiring/everify/cases/${evCase.id}/status`, hr, { status: 'tentative_nonconfirmation' });
            check('an authorized case cannot go back to a mismatch (409)', backwards.s === 409, backwards.b);
            const closed = await call('POST', `${U}/hiring/everify/cases/${evCase.id}/status`, hr, { status: 'closed' });
            check('the case is closed', closed.s === 200 && closed.b.case.status === 'closed' && closed.b.case.closedOn, closed.b);
            const after = await call('GET', `${U}/hiring/everify/cases`, hr);
            check('the new hire is no longer listed as needing a case', after.s === 200 && !(after.b.missing || []).some((m) => m.userId === nh.uid) && (after.b.cases || []).some((c) => c.userId === nh.uid), after.text.slice(0, 300));
        }
        if (!everifyWas) {
            const restore = await call('PUT', `${U}/hiring/settings`, hr, { everify: { used: false } });
            check('E-Verify is put back to how the company had it (off), so later stages are not affected', restore.s === 200, restore.b);
        }
        ctx.skip('opening the case with E-Verify itself', 'tracking only: cases are created on the E-Verify website by hand, which needs a real employer account');

        // ------------------------------------------------------------------------------- new-hire reporting
        ctx.section('State new-hire reporting');
        const seededAgencies = await call('POST', `${U}/hiring/newhire/agencies/seed`, hr, {});
        const agencies = await call('GET', `${U}/hiring/newhire/agencies`, hr);
        check('the state agency table has an entry for Texas', seededAgencies.s === 200 && agencies.s === 200 && (agencies.b.data || []).some((a) => a.state === 'TX' && a.dueDays >= 1), agencies.text.slice(0, 300));
        const pending = await call('GET', `${U}/hiring/newhire/pending`, hr);
        const row = (pending.b.data || []).find((r) => r.userId === nh.uid);
        check('the new hire is on the list to report, for Texas, with a due date and only the last 4 digits of the SSN', pending.s === 200 && row && row.state === 'TX' && row.dueDate > yesterday && row.hasSsn === true && row.ssnLast4 === ssnDigits.slice(-4) && !pending.text.includes(ssnDigits) && !pending.text.includes(ssn), row || pending.text.slice(0, 300));
        check('people who started months ago are not on the list', pending.s === 200 && !(pending.b.data || []).some((r) => r.userId === state.people.cashier.uid));
        check('the auditor cannot download the file with full SSNs (403)', (await call('GET', `${U}/hiring/newhire/export.csv?state=TX&userIds=${nh.uid}`, auditor)).s === 403);
        const csv = await call('GET', `${U}/hiring/newhire/export.csv?state=TX&userIds=${nh.uid}`, hr);
        const csvLines = csv.text.trim().split(/\r?\n/);
        check('HR downloads the new-hire file: one line for the new hire with name, SSN, address, hire date and the employer\'s EIN', csv.s === 200 && /text\/csv/.test(String(csv.headers.get('content-type'))) && csvLines.length === 2 && csvLines[1].includes(candName.last) && csvLines[1].replace(/-/g, '').includes(ssnDigits) && csvLines[1].includes('415 Barton Springs Rd') && csvLines[1].includes(yesterday) && csvLines[1].replace(/-/g, '').includes('123456789'), csv.text.slice(0, 500));
        const submit = await call('POST', `${U}/hiring/newhire/submit`, hr, { userIds: [nh.uid], state: 'TX', confirmationNumber: `TX-${tag.toUpperCase()}` });
        check('HR marks the report as submitted with the state\'s confirmation number', submit.s === 200 && submit.b.submitted === 1, submit.b);
        const pendingAfter = await call('GET', `${U}/hiring/newhire/pending`, hr);
        const submissions = await call('GET', `${U}/hiring/newhire/submissions`, hr);
        check('the new hire leaves the to-report list and is on the submitted list', pendingAfter.s === 200 && !(pendingAfter.b.data || []).some((r) => r.userId === nh.uid) && (submissions.b.data || []).some((r) => r.userId === nh.uid && r.confirmationNumber === `TX-${tag.toUpperCase()}`), submissions.text.slice(0, 300));
        const again2 = await call('POST', `${U}/hiring/newhire/submit`, hr, { userIds: [nh.uid], state: 'TX', confirmationNumber: 'TX-AGAIN' });
        check('reporting the same person twice changes nothing', again2.s === 200 && again2.b.submitted === 0 && (again2.b.skipped || []).length === 1, again2.b);
        const listAfterReport = await call('GET', `${U}/checklists/person/${nh.uid}`, hr);
        const tasksNow = ((listAfterReport.b.lists || []).find((l) => l.id === listId) || { tasks: [] }).tasks;
        const reportTask = tasksNow.find((t) => t.id === 'new_hire_report');
        check('marking it submitted ticks "file the state new-hire report" on the checklist', reportTask && reportTask.done === true && /TX/.test(String(reportTask.note)), reportTask);
        ctx.skip('filing the report with the Texas agency', 'the state filing itself is done by hand on the agency\'s website');

        ctx.section('The checklist is finished');
        const payrollTick = await call('PUT', `${T}/payroll_added`, hr, { status: 'done', note: 'Will be synced with the next payroll run' });
        check('HR ticks "add the person to payroll"', payrollTick.s === 200, payrollTick.b);
        const done = await call('GET', `${U}/checklists/person/${nh.uid}`, hr);
        const finalList = (done.b.lists || []).find((l) => l.id === listId) || {};
        check('every required onboarding task is now done (100%)', done.s === 200 && finalList.summary && finalList.summary.complete === true && finalList.summary.percent === 100, finalList.summary || done.b);
        const formsView = await call('GET', `${U}/employees/${nh.uid}/forms`, hr);
        check('HR sees the new hire\'s W-4, I-9 and direct deposit on file', formsView.s === 200 && /w4/i.test(formsView.text) && /i9/i.test(formsView.text), formsView.text.slice(0, 300));

        // ----------------------------------------------------------------------------------------- training
        ctx.section('A training is assigned and completed');
        check('an employee cannot set up a training (403)', (await call('POST', `${U}/training`, cashier, { name: 'Not allowed' })).s === 403);
        const training = await call('POST', `${U}/training`, hr, { name: `Shift lead cash handling ${tag}`, description: 'How to count the drawer and make the deposit.', audience: { type: 'job_title', values: [jobTitle] }, dueWithinDays: 30 });
        const tr = training.b.training || {};
        if (check('HR sets up a training for everybody with the new hire\'s job title', training.s === 201 && tr.id, training.b)) {
            mine.trainingId = tr.id;
            const myTrainings = await call('GET', `${U}/training/mine`, me);
            const t0 = (myTrainings.b.data || []).find((x) => x.id === tr.id);
            check('it is on the new hire\'s list as due, with a due date', myTrainings.s === 200 && t0 && t0.status === 'due' && t0.dueDate && t0.canReport === true, t0 || myTrainings.b);
            const others = await call('GET', `${U}/training/mine`, cashier);
            const notMine = await call('POST', `${U}/training/mine/${tr.id}/complete`, cashier, {});
            check('it is not on the cashier\'s list, and the cashier cannot report it done (403)', others.s === 200 && !(others.b.data || []).some((x) => x.id === tr.id) && notMine.s === 403, { list: others.s, report: notMine.b });
            const reported = await call('POST', `${U}/training/mine/${tr.id}/complete`, me, { note: 'Did it with Maria on my first shift' });
            const completionId = reported.b.completion && reported.b.completion.id;
            check('the new hire reports the training as completed', reported.s === 201 && reported.b.completion.status === 'reported', reported.b);
            const waitingHr = await call('GET', `${U}/training/mine`, me);
            const t1 = (waitingHr.b.data || []).find((x) => x.id === tr.id) || {};
            check('it does not count yet: it waits for HR to confirm', t1.waitingForHr === true && t1.status !== 'done', t1);
            const queue = await call('GET', `${U}/training/completions?status=reported`, hr);
            check('HR sees the report waiting', queue.s === 200 && (queue.b.data || []).some((c) => c.id === completionId), queue.text.slice(0, 300));
            check('the auditor cannot confirm it (403)', (await call('POST', `${U}/training/completions/${completionId}/confirm`, auditor, {})).s === 403);
            const confirmed = await call('POST', `${U}/training/completions/${completionId}/confirm`, hr, {});
            check('HR confirms it', confirmed.s === 200 && confirmed.b.completion.status === 'confirmed', confirmed.b);
            const doneMine = await call('GET', `${U}/training/mine`, me);
            const report = await call('GET', `${U}/training/report?trainingId=${tr.id}`, hr);
            check('the training is done on the new hire\'s list and on HR\'s report', ((doneMine.b.data || []).find((x) => x.id === tr.id) || {}).status === 'done' && report.s === 200 && (report.b.data || []).length === 1 && report.b.data[0].status === 'done', { mine: (doneMine.b.data || []).find((x) => x.id === tr.id), report: report.b.data });
        }

        // ------------------------------------------------------------------------------- waiting for me
        ctx.section('The "waiting for me" list');
        const waitManager = await call('GET', `${U}/approvals/waiting`, manager);
        const waitHire = await call('GET', `${U}/approvals/waiting`, me);
        check('the manager can ask what is waiting for them; the new hire gets "nothing to approve" instead of an error', waitManager.s === 200 && waitManager.b.canApprove === true && waitHire.s === 200 && waitHire.b.canApprove === false, { manager: waitManager.b, newHire: waitHire.b });
        ctx.skip('a job requisition waiting for its approver on the "waiting for me" list', 'the list counts hours, punch fixes and time off only; a requisition waiting for approval is not on it and there is no other route that lists "requisitions waiting for me"');

        // -------------------------------------------------------------------------------------- team import
        ctx.section('Team import: a pasted sheet, a check, and personal set-up links');
        check('an employee cannot use the team import (403)', (await call('GET', `${U}/team-import/fields`, cashier)).s === 403);
        const impEmail = `ivy.${tag}@${domain}`;
        const sheet = ['First name\tLast name\tEmail\tFirst day of work\tJob title', `Ivy\tSheet${tag}\t${impEmail}\t${longAgo}\tStock Clerk`, `Otto\tNoemail${tag}\tnot-an-email\t${longAgo}\tStock Clerk`].join('\n');
        const analyzed = await call('POST', `${U}/team-import/analyze`, hr, { text: sheet });
        const mapping = (analyzed.b.columns || []).map((c) => c.field);
        if (check('a pasted sheet is read and its columns are recognised (name, email, first day, job title)', analyzed.s === 200 && analyzed.b.hasHeader === true && analyzed.b.rowCount === 2 && ['first_name', 'last_name', 'email', 'start_date', 'job_title'].every((f, i) => mapping[i] === f), analyzed.b)) {
            const preview = await call('POST', `${U}/team-import/check`, hr, { rows: analyzed.b.rows, mapping, options: {} });
            const results = preview.b.results || [];
            check('the preview says one row is fine and one has a bad email, and creates nobody', preview.s === 200 && preview.b.summary.ok === 1 && preview.b.summary.problems === 1 && results[1] && results[1].problems.some((p) => p.field === 'email') && (await call('GET', `${U}/team-import/access`, hr)).b.data.every((p) => p.email !== impEmail), preview.b);
            const created = await call('POST', `${U}/team-import/create`, hr, { rows: analyzed.b.rows, mapping, options: { access: 'link' } });
            const good = (created.b.results || [])[0] || {};
            if (check('the good row becomes a person with an employee number and a personal set-up link (no password is shown); the bad row is skipped', created.s === 201 && created.b.summary.created === 1 && created.b.summary.skipped === 1 && good.status === 'created' && good.employeeId && good.setupToken && good.temporaryPassword === undefined, created.b)) {
                mine.people.imported = { key: 'imported', uid: good.uid, employeeId: good.employeeId, email: impEmail, password: PASSWORD, name: good.name };
                const access = await call('GET', `${U}/team-import/access`, hr);
                check('HR sees that person as waiting to set up their sign-in', access.s === 200 && (access.b.data || []).some((p) => p.id === good.uid && p.access === 'waiting_for_setup'), (access.b.data || []).find((p) => p.id === good.uid));
                const info = await call('POST', '/api/auth/team/setup/info', null, { token: good.setupToken });
                check('the set-up link says who it is for and which company', info.s === 200 && info.b.firstName === 'Ivy' && info.b.email === impEmail && String(info.b.company).includes('Lone Star Market'), info.b);
                const weak = await call('POST', '/api/auth/team/setup/complete', null, { token: good.setupToken, password: 'short' });
                check('a weak password is refused (400)', weak.s === 400, weak.b);
                const setup = await call('POST', '/api/auth/team/setup/complete', null, { token: good.setupToken, password: PASSWORD });
                check('the person chooses a password with the link', setup.s === 200 && setup.b.email === impEmail, setup.b);
                const used = await call('POST', '/api/auth/team/setup/complete', null, { token: good.setupToken, password: `${PASSWORD}2` });
                check('the link works only once', used.s === 404, used.b);
                let ivy = null;
                try { ivy = await ctx.signIn(impEmail, PASSWORD); } catch (err) { /* reported below */ }
                const ivyLists = ivy ? await call('GET', `${U}/checklists/mine`, ivy) : { s: 0, b: {} };
                check('they sign in with it and find their own onboarding checklist', Boolean(ivy) && ivyLists.s === 200 && (ivyLists.b.lists || []).some((l) => l.kind === 'onboarding'), ivyLists.b);
            }
        }

        ctx.section('The company join link');
        const joinLink = await call('POST', `${U}/team-import/join-links`, hr, { days: 3, label: `Break room poster ${tag}` });
        if (check('HR makes a company join link that works for 3 days', joinLink.s === 201 && joinLink.b.token && joinLink.b.link && joinLink.b.link.state === 'active', joinLink.b)) {
            const joinToken = joinLink.b.token;
            const joinInfo = await call('POST', '/api/auth/team/join/info', null, { token: joinToken });
            check('the join link shows which company it belongs to', joinInfo.s === 200 && String(joinInfo.b.company).includes('Lone Star Market'), joinInfo.b);
            const joinEmail = `jo.${tag}@${domain}`;
            const asked = await call('POST', '/api/auth/team/join/request', null, { token: joinToken, firstName: 'Jo', lastName: `Joiner${tag}`, email: joinEmail, phone: '512-555-0177', password: PASSWORD });
            check('somebody asks to join with the link and is told to wait for approval', asked.s === 202 && asked.b.status === 'waiting_for_approval', asked.b);
            let tooEarly = false;
            try { await ctx.signIn(joinEmail, PASSWORD); tooEarly = true; } catch (_) { /* refused, as it should be */ }
            check('they cannot sign in before HR approves', tooEarly === false);
            check('an employee cannot see who asked to join (403)', (await call('GET', `${U}/team-import/join-requests`, cashier)).s === 403);
            const requests = await call('GET', `${U}/team-import/join-requests`, hr);
            const request = (requests.b.data || []).find((r) => r.email === joinEmail);
            if (check('HR sees the request waiting', requests.s === 200 && request && request.status === 'waiting' && requests.b.waiting >= 1, requests.b)) {
                const ok = await call('POST', `${U}/team-import/join-requests/${request.id}/approve`, hr, { startDate: longAgo, jobTitle: 'Stock Clerk', department: 'Store' });
                const j = ok.b.employee || {};
                check('HR approves and the person gets an employee number, as a plain employee', ok.s === 201 && j.uid && j.employeeId && j.role === 'employee', ok.b);
                check('a request cannot be approved twice (409)', (await call('POST', `${U}/team-import/join-requests/${request.id}/approve`, hr, {})).s === 409);
                let jo = null;
                try { jo = await ctx.signIn(joinEmail, PASSWORD); } catch (err) { /* reported below */ }
                const joPerms = jo ? await call('GET', `${U}/me/permissions`, jo) : { s: 0, b: {} };
                check('they now sign in with the password they chose', Boolean(jo) && joPerms.s === 200 && /employee/.test(String(joPerms.b.role)), joPerms.b);
                if (j.uid) mine.people.joined = { key: 'joined', uid: j.uid, employeeId: j.employeeId, email: joinEmail, password: PASSWORD, name: j.name };
            }
            const revoked = await call('DELETE', `${U}/team-import/join-links/${joinLink.b.link.id}`, hr);
            const dead = await call('POST', '/api/auth/team/join/info', null, { token: joinToken });
            check('HR turns the join link off and it stops working', revoked.s === 200 && dead.s === 404, { revoked: revoked.b, after: dead.b });
        }

        ctx.section('Bulk import from a file, with a dry run first');
        const bulkEmail = `bea.${tag}@${domain}`;
        const bulkRows = [
            { first_name: 'Bea', last_name: `Bulk${tag}`, email: bulkEmail, start_date: longAgo, job_title: 'Barista', department: 'Cafe', role: 'employee' },
            { first_name: 'Bad', last_name: 'Row', email: bulkEmail, start_date: 'next week', job_title: 'Barista', department: 'Cafe' }
        ];
        const dry = await call('POST', `${U}/employees/bulk`, hr, { dryRun: true, rows: bulkRows });
        check('the dry run says row 2 is fine and row 3 is not (same email twice, bad date)', dry.s === 200 && dry.b.dryRun === true && dry.b.summary.ok === 1 && dry.b.summary.errors === 1 && dry.b.results[0].status === 'ok' && dry.b.results[1].row === 3 && dry.b.results[1].errors.length >= 2, dry.b);
        const dryAgain = await call('POST', `${U}/employees/bulk`, hr, { dryRun: true, rows: [bulkRows[0]] });
        check('the dry run created nobody (the same email is still free)', dryAgain.s === 200 && dryAgain.b.summary.ok === 1, dryAgain.b);
        const bulk = await call('POST', `${U}/employees/bulk`, hr, { rows: bulkRows });
        const b0 = (bulk.b.results || [])[0] || {};
        check('the real upload creates the good row with an employee number and a temporary password, and reports the bad one', bulk.s === 200 && bulk.b.summary.ok === 1 && bulk.b.summary.errors === 1 && b0.status === 'created' && b0.employeeId && b0.temporaryPassword, bulk.b);
        if (b0.status === 'created') mine.people.bulk = { key: 'bulk', employeeId: b0.employeeId, email: bulkEmail, temporaryPassword: b0.temporaryPassword, name: b0.name, note: 'still has the temporary password' };
        check('uploading the same file again creates nobody (the email now has an account)', (await call('POST', `${U}/employees/bulk`, hr, { rows: [bulkRows[0]] })).b.summary.ok === 0);

        const everyone = await call('GET', `${U}/employees`, hr);
        const emails = (everyone.b.data || []).map((p) => p.email);
        check('the people list now has the new hire and the people who were imported, joined and uploaded', everyone.s === 200 && [candEmail, impEmail, `jo.${tag}@${domain}`, bulkEmail].every((x) => emails.includes(x)), `count ${(everyone.b.data || []).length}`);
        ctx.save();
    }
};
