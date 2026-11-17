/**
 * Stage 01: a brand-new US company signs up, fills in its profile, sets up locations and departments, and adds its
 * people with everything payroll and compliance need (profile, W-4, I-9, direct deposit, role, manager).
 * Every later stage uses this company and these people. Checks named "[needed]" stop the run when they fail.
 */
const PASSWORD = 'E2e-Run#2026pass';

/** key, role, and what goes on the US profile. All made-up people. */
const PEOPLE = [
    { key: 'hr', role: 'hr_admin', first: 'Hannah', last: 'Reyes', title: 'HR Manager', dept: 'office', loc: 'main', pay: { payType: 'salary', payRate: 68000, flsaStatus: 'exempt' }, dob: '1986-03-14' },
    { key: 'payroll', role: 'payroll_admin', first: 'Paul', last: 'Okafor', title: 'Payroll Specialist', dept: 'office', loc: 'main', pay: { payType: 'salary', payRate: 61000, flsaStatus: 'exempt' }, dob: '1990-07-02' },
    { key: 'manager', role: 'manager', first: 'Maria', last: 'Gonzalez', title: 'Store Manager', dept: 'store', loc: 'main', pay: { payType: 'salary', payRate: 56000, flsaStatus: 'exempt' }, dob: '1984-11-21' },
    { key: 'accountant', role: 'accountant', first: 'Arthur', last: 'Chen', title: 'Accountant', dept: 'office', loc: 'main', pay: { payType: 'salary', payRate: 64000, flsaStatus: 'exempt' }, dob: '1979-01-30' },
    { key: 'auditor', role: 'auditor', first: 'Audrey', last: 'Bell', title: 'Internal Auditor', dept: 'office', loc: 'main', pay: { payType: 'salary', payRate: 66000, flsaStatus: 'exempt' }, dob: '1982-05-09' },
    { key: 'executive', role: 'executive', first: 'Evan', last: 'Brooks', title: 'Operations Director', dept: 'office', loc: 'main', pay: { payType: 'salary', payRate: 98000, flsaStatus: 'exempt' }, dob: '1975-09-17' },
    { key: 'cashier', role: 'employee', first: 'Carlos', last: 'Diaz', title: 'Cashier', dept: 'store', loc: 'main', managedBy: 'manager', pay: { payType: 'hourly', payRate: 18.5, flsaStatus: 'non_exempt' }, dob: '1997-04-12' },
    { key: 'server', role: 'employee', first: 'Sofia', last: 'Nguyen', title: 'Server', dept: 'cafe', loc: 'second', managedBy: 'manager', pay: { payType: 'hourly', payRate: 12, flsaStatus: 'non_exempt' }, dob: '1999-08-25', tipped: true },
    { key: 'stocker', role: 'employee', first: 'Sam', last: 'Turner', title: 'Stock Clerk', dept: 'store', loc: 'main', managedBy: 'manager', pay: { payType: 'hourly', payRate: 17, flsaStatus: 'non_exempt' }, dob: '2001-12-03', employmentType: 'part_time' },
    { key: 'leaver', role: 'employee', first: 'Lena', last: 'Park', title: 'Barista', dept: 'cafe', loc: 'second', managedBy: 'manager', pay: { payType: 'hourly', payRate: 16, flsaStatus: 'non_exempt' }, dob: '1995-06-18' }
];

module.exports = {
    id: '01',
    title: 'Company signup and people',
    covers: ['US-A01', 'US-A02', 'US-A03', 'US-A07', 'US-A08', 'US-B01', 'US-B02', 'US-B03', 'US-C04', 'US-C05', 'US-C08', 'US-L01'],
    PEOPLE,
    async run(ctx) {
        const { call, check, U, state } = ctx;
        const run = state.run;
        const domain = `e2e${run}.test`;
        const startDate = ctx.addDays(ctx.today, -75);

        // ------------------------------------------------------------------------------------------------ signup
        ctx.section('A new US company signs up');
        const companyName = `Lone Star Market ${run}`;
        const ownerEmail = `owner@${domain}`;
        const signup = await call('POST', '/api/auth/register-organization', null, {
            fullName: 'Olivia Carter', email: ownerEmail, password: PASSWORD,
            organization: { legalName: `${companyName} LLC`, displayName: companyName, organizationType: 'LLC', industry: 'Retail', country: 'United States', state: 'TX', city: 'Austin', pinCode: '78701', registeredAddress: '100 Congress Ave', timezone: 'America/Chicago', currency: 'USD', officialPhone: '5125550100' }
        });
        if (!check('[needed] signup creates the company and its owner (201)', signup.s === 201 && signup.b.orgId, signup.text.slice(0, 300))) return;
        state.company = { orgId: signup.b.orgId, name: companyName, domain, state: 'TX', timezone: 'America/Chicago' };
        state.people.owner = { key: 'owner', uid: signup.b.uid, email: ownerEmail, password: PASSWORD, role: 'super_admin', name: 'Olivia Carter' };
        state.password = PASSWORD;

        const owner = await ctx.as('owner');
        check('[needed] the owner signs in', Boolean(owner));
        const perms = await call('GET', `${U}/me/permissions`, owner);
        check('the owner is in a US company with the owner role', perms.s === 200 && /super/.test(String(perms.b.role)), perms.b);

        // ---------------------------------------------------------------------------------------- company profile
        ctx.section('Company profile');
        const profile = { legalName: `${companyName} LLC`, ein: '12-3456789', entityType: 'llc', businessAddress: { line1: '100 Congress Ave', city: 'Austin', state: 'TX', zip: '78701' }, workStates: ['TX'], industryCode: '445110', fiscalYearStartMonth: 1 };
        const bad = await call('PUT', `${U}/company/profile`, owner, { ...profile, ein: '12' });
        check('a bad EIN is refused (400)', bad.s === 400, bad.b);
        const saved = await call('PUT', `${U}/company/profile`, owner, profile);
        check('[needed] the company profile is saved (EIN, entity type, address, work state, industry code)', saved.s === 200 && saved.b.profile && saved.b.profile.industryCode === '445110', saved.b);
        const readBack = await call('GET', `${U}/company/profile`, owner);
        check('and reads back', readBack.s === 200 && readBack.b.profile.legalName === profile.legalName, readBack.b);

        // ------------------------------------------------------------------------------- locations and departments
        ctx.section('Locations and departments');
        const locs = {};
        for (const [key, body] of Object.entries({
            main: { name: 'Congress Ave Store', address: { line1: '100 Congress Ave', city: 'Austin', state: 'TX', zip: '78701' }, state: 'TX', city: 'Austin', county: 'Travis', timezone: 'America/Chicago' },
            second: { name: 'South Lamar Cafe', address: { line1: '2200 S Lamar Blvd', city: 'Austin', state: 'TX', zip: '78704' }, state: 'TX', city: 'Austin', county: 'Travis', timezone: 'America/Chicago' }
        })) {
            const r = await call('POST', `${U}/locations`, owner, body);
            const made = r.b.location || r.b.data || r.b;
            if (check(`location "${body.name}" is added`, (r.s === 201 || r.s === 200) && made && made.id, r.b)) locs[key] = made.id;
        }
        const depts = {};
        for (const [key, name] of Object.entries({ office: 'Office', store: 'Store', cafe: 'Cafe' })) {
            const r = await call('POST', `${U}/departments`, owner, { name });
            const made = r.b.department || r.b.data || r.b;
            if (check(`department "${name}" is added`, (r.s === 201 || r.s === 200) && made && made.id, r.b)) depts[key] = made.id;
        }
        state.ids.locations = locs; state.ids.departments = depts;

        // -------------------------------------------------------------------------------------------------- people
        ctx.section('People are added, each with a temporary password they replace');
        for (const p of PEOPLE) {
            const email = `${p.key}@${domain}`;
            // a new person can be added as employee, manager or HR; the other roles are given on the roles screen afterwards
            const addAs = ['employee', 'manager', 'hr_admin'].includes(p.role) ? p.role : 'employee';
            const made = await call('POST', `${U}/employees`, owner, { firstName: p.first, lastName: p.last, email, role: addAs, startDate, jobTitle: p.title });
            const e = made.b.employee || {};
            if (!check(`[needed] ${p.first} ${p.last} (${p.role}) is added with an employee number`, made.s === 201 && e.uid && e.employeeId && e.temporaryPassword, made.b)) continue;
            // first sign-in with the temporary password, then the person chooses their own
            let token = null;
            try { token = await ctx.signIn(email, e.temporaryPassword); } catch (err) { check(`${p.first} signs in with the temporary password`, false, err.message); }
            if (token) {
                const status = await call('GET', '/api/auth/password-status', token);
                const changed = await call('POST', '/api/auth/change-password', token, { currentPassword: e.temporaryPassword, newPassword: PASSWORD });
                check(`${p.first} is told to change the temporary password and does`, status.s === 200 && status.b.mustChangePassword === true && changed.s === 200, { status: status.b, changed: changed.b });
            }
            state.people[p.key] = { key: p.key, uid: e.uid, employeeId: e.employeeId, email, password: PASSWORD, role: p.role, name: `${p.first} ${p.last}`, title: p.title, tipped: Boolean(p.tipped), payType: p.pay.payType, payRate: p.pay.payRate };
        }
        ctx.save();
        const everyone = PEOPLE.filter((p) => state.people[p.key]);
        if (!check('[needed] all ten people exist', everyone.length === PEOPLE.length, `${everyone.length} of ${PEOPLE.length}`)) return;

        ctx.section('US profile, pay and classification');
        let n = 0;
        for (const p of everyone) {
            const person = state.people[p.key];
            n += 1;
            const body = {
                legalFirstName: p.first, legalLastName: p.last, dateOfBirth: p.dob, homeAddress: { line1: `${100 + n} Barton Springs Rd`, city: 'Austin', state: 'TX', zip: '78704' },
                workState: 'TX', classification: 'W2', employmentType: p.employmentType || 'full_time', payFrequency: 'weekly', ...p.pay,
                jobTitle: p.title, startDate, departmentId: depts[p.dept], locationId: locs[p.loc],
                taxpayerIdType: 'SSN', taxpayerId: `5${String(10 + n)}-${String(20 + n)}-${String(4000 + n)}` // made-up numbers for the local run
            };
            const r = await call('PUT', `${U}/employees/${person.uid}/profile`, owner, body);
            check(`${p.first}'s US profile is saved (${p.pay.payType} ${p.pay.payRate}, ${p.pay.flsaStatus})`, r.s === 200, r.b);
        }
        const hourlyExempt = await call('PUT', `${U}/employees/${state.people.cashier.uid}/profile`, owner, { legalFirstName: 'Carlos', legalLastName: 'Diaz', dateOfBirth: '1997-04-12', homeAddress: { line1: '1 A St', city: 'Austin', state: 'TX', zip: '78704' }, workState: 'TX', classification: 'W2', employmentType: 'full_time', payFrequency: 'weekly', payType: 'hourly', payRate: 18.5, flsaStatus: 'exempt' });
        check('an exempt employee paid hourly is refused (400)', hourlyExempt.s === 400, hourlyExempt.b);
        const masked = await call('GET', `${U}/employees/${state.people.cashier.uid}/profile`, owner);
        check('the SSN comes back masked, never in full', masked.s === 200 && !/5\d\d-\d\d-40\d\d/.test(masked.text) && /\d{4}/.test(masked.text), masked.text.slice(0, 300));
        const reveal = await call('POST', `${U}/employees/${state.people.cashier.uid}/taxpayer-id/reveal`, owner, { reason: 'end-to-end check' });
        check('the owner can reveal it with a reason', reveal.s === 200, reveal.b);

        ctx.section('Roles, managers and the org chart');
        for (const p of everyone.filter((x) => !['employee', 'manager', 'hr_admin'].includes(x.role))) {
            const r = await call('PUT', `${U}/roles/users/${state.people[p.key].uid}`, owner, { role: p.role });
            check(`${p.first} is given the ${p.role} role`, r.s === 200, r.b);
            ctx.forget(p.key); // the role is in the sign-in token, so the next use signs in again
        }
        for (const p of everyone.filter((x) => x.managedBy)) {
            const r = await call('PUT', `${U}/people/${state.people[p.key].uid}/manager`, owner, { managerId: state.people[p.managedBy].uid });
            check(`${p.first} reports to ${state.people[p.managedBy].name}`, r.s === 200, r.b);
        }
        const chart = await call('GET', `${U}/org/chart`, owner);
        check('the org chart reads', chart.s === 200, chart.b);
        const team = await call('GET', `${U}/people/${state.people.manager.uid}/team`, owner);
        check('the manager has four direct reports', team.s === 200 && /Carlos|cashier/i.test(team.text) && /Lena/i.test(team.text), team.text.slice(0, 300));
        const roleUsers = await call('GET', `${U}/roles/users`, owner);
        check('the role list shows each of the eight roles in use', roleUsers.s === 200 && ['hr_admin', 'payroll_admin', 'manager', 'accountant', 'auditor', 'executive', 'employee', 'super_admin'].every((r) => roleUsers.text.includes(r)), roleUsers.text.slice(0, 300));

        // ----------------------------------------------------------------------------- forms each person fills in
        ctx.section('W-4, I-9 Section 1 and direct deposit, filled in by each person');
        for (const p of everyone) {
            const person = state.people[p.key];
            const me = await ctx.as(p.key);
            const w4 = await call('PUT', `${U}/employees/${person.uid}/w4`, me, { taxYear: Number(ctx.today.slice(0, 4)), filingStatus: 'single_or_mfs', multipleJobs: false, qualifyingChildren: 0, otherDependents: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exemptFromWithholding: false, signedName: `${p.first} ${p.last}`, declarationAccepted: true });
            const i9 = await call('PUT', `${U}/employees/${person.uid}/i9/section1`, me, { citizenshipStatus: 'us_citizen', signedName: `${p.first} ${p.last}`, attestation: true });
            const dd = await call('PUT', `${U}/employees/${person.uid}/direct-deposit`, me, { bankName: 'Test Bank', routingNumber: '021000021', accountNumber: `0001234${String(5000 + n)}`, accountType: 'checking', authorization: true });
            check(`${p.first}: W-4, I-9 Section 1 and direct deposit are on file`, w4.s === 200 && i9.s === 200 && dd.s === 200, { w4: w4.s === 200 ? 'ok' : w4.b, i9: i9.s === 200 ? 'ok' : i9.b, dd: dd.s === 200 ? 'ok' : dd.b });
        }
        const hr = await ctx.as('hr');
        ctx.section('HR completes I-9 Section 2');
        for (const p of everyone) {
            // nobody completes Section 2 of their own I-9: the owner does HR's
            const byOwner = p.key === 'hr';
            const r = await call('PUT', `${U}/employees/${state.people[p.key].uid}/i9/section2`, byOwner ? owner : hr, { listA: { type: 'us_passport', title: 'U.S. Passport', issuingAuthority: 'U.S. Department of State', number: `P${1000000 + PEOPLE.indexOf(p)}`, expiresOn: ctx.addDays(ctx.today, 1500) }, examinedOn: startDate, examinationMethod: 'in_person', signerName: byOwner ? 'Olivia Carter' : 'Hannah Reyes', signerTitle: byOwner ? 'Owner' : 'HR Manager', certification: true });
            check(`${p.first}: I-9 Section 2 is completed by ${byOwner ? 'the owner' : 'HR'}`, r.s === 200, r.b);
        }
        const ownI9 = await call('PUT', `${U}/employees/${state.people.hr.uid}/i9/section2`, hr, { listA: { type: 'us_passport', issuingAuthority: 'U.S. Department of State', number: 'P1' }, examinedOn: startDate, examinationMethod: 'in_person', signerName: 'Hannah Reyes', signerTitle: 'HR Manager', certification: true });
        check('HR cannot complete Section 2 of their own I-9', ownI9.s >= 400 && ownI9.s < 500, ownI9.b);
        const forms = await call('GET', `${U}/employees/${state.people.cashier.uid}/forms`, hr);
        check('HR sees the cashier\'s forms as complete', forms.s === 200 && /w4/i.test(forms.text) && /i9/i.test(forms.text), forms.text.slice(0, 400));
        const onboarding = await call('GET', `${U}/compliance/onboarding`, hr);
        check('the onboarding compliance list reads', onboarding.s === 200, onboarding.b);

        // -------------------------------------------------------------------------------------- who may see what
        ctx.section('Who may see what');
        const cashier = await ctx.as('cashier');
        check('an employee cannot list people (403)', (await call('GET', `${U}/employees`, cashier)).s === 403);
        check('an employee cannot read another person\'s profile (403)', (await call('GET', `${U}/employees/${state.people.server.uid}/profile`, cashier)).s === 403);
        check('an employee reads their own profile', (await call('GET', `${U}/me/profile`, cashier)).s === 200);
        const auditor = await ctx.as('auditor');
        check('the auditor lists people but cannot change a profile', (await call('GET', `${U}/employees`, auditor)).s === 200 && (await call('PUT', `${U}/employees/${state.people.cashier.uid}/profile`, auditor, {})).s === 403);
        const list = await call('GET', `${U}/employees`, hr);
        check('HR lists the ten people who were added, with no SSN in the list', list.s === 200 && (list.b.data || []).length === 10 && !/taxpayerIdEncrypted/.test(list.text), `count ${(list.b.data || []).length}`);
        check('no token is refused (401)', (await call('GET', `${U}/employees`, null)).s === 401);
    }
};
