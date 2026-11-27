// Ask less: benefits keep one family list and work out the coverage tier; time off uses the person's own day length.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const B = require('../services/benefits-rules.js');
const L = require('../services/leave-rules.js');
const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

const health = { id: 'med', name: 'Medical', type: 'medical', costs: { employee_only: { employee: 50, employer: 200 }, employee_spouse: { employee: 120, employer: 300 }, employee_children: { employee: 100, employer: 280 }, family: { employee: 180, employer: 400 } } };
const spouse = { firstName: 'Ana', lastName: 'Diaz', relationship: 'spouse', dateOfBirth: '1990-04-02' };
const partner = { firstName: 'Lee', lastName: 'Diaz', relationship: 'domestic_partner', dateOfBirth: '1991-04-02' };
const kid = { firstName: 'Sam', lastName: 'Diaz', relationship: 'child', dateOfBirth: '2018-06-10' };

test('the coverage tier follows from the chosen dependents, using the tier keys the rules use', () => {
    assert.equal(B.tierForDependents([]), 'employee_only');
    assert.equal(B.tierForDependents(undefined), 'employee_only');
    assert.equal(B.tierForDependents([spouse]), 'employee_spouse');
    assert.equal(B.tierForDependents([partner]), 'employee_spouse');
    assert.equal(B.tierForDependents([kid]), 'employee_children');
    assert.equal(B.tierForDependents([kid, { ...kid, firstName: 'Mia' }]), 'employee_children');
    assert.equal(B.tierForDependents([spouse, kid]), 'family');
    for (const deps of [[], [spouse], [kid], [spouse, kid], [partner, kid]]) {
        const tier = B.tierForDependents(deps);
        assert.ok(B.TIERS.includes(tier));
        const v = B.validateElection({ tier, dependents: deps }, health, { today: '2026-11-21' });
        assert.deepEqual(v.errors, [], `${tier} passes the server check`);
    }
});

test('a saved family member is sent by reference; validation is not weakened', () => {
    const ok = B.validateDependent({ ...kid, existingDependentId: 'a1b2c3d4e5f6' }, 0, '2026-11-21');
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.existingDependentId, 'a1b2c3d4e5f6');
    assert.equal(ok.value.ssnPlain, undefined);
    assert.ok(B.validateDependent({ ...kid, existingDependentId: '../x' }, 0, '2026-11-21').errors.some((e) => /existingDependentId/.test(e)));
    assert.ok(B.validateDependent({ relationship: 'child', existingDependentId: 'a1b2c3d4e5f6' }, 0, '2026-11-21').errors.some((e) => /firstName is required/.test(e)));
    assert.ok(B.validateDependent({ ...kid, ssn: '***-**-1234', existingDependentId: 'a1b2c3d4e5f6' }, 0, '2026-11-21').errors.some((e) => /ssn must be 9 digits/.test(e)));
    // A newly typed SSN replaces the stored one
    const fresh = B.validateDependent({ ...kid, ssn: '123-45-6789', existingDependentId: 'a1b2c3d4e5f6' }, 0, '2026-11-21');
    assert.equal(fresh.value.ssnPlain, '123456789');
    assert.equal(fresh.value.existingDependentId, undefined);
});

test('a person\'s full day comes from their scheduled weekly hours', () => {
    assert.equal(L.hoursPerDayFor(40), 8);
    assert.equal(L.hoursPerDayFor(37.5), 7.5);
    assert.equal(L.hoursPerDayFor(32), 6.5); // 6.4 rounds to the quarter hour
    assert.equal(L.hoursPerDayFor(30), 6);
    assert.equal(L.hoursPerDayFor(36, 4), 9);
    assert.equal(L.hoursPerDayFor(null), 8);
    assert.equal(L.hoursPerDayFor(undefined), 8);
    assert.equal(L.hoursPerDayFor(0), 8);
    assert.equal(L.hoursPerDayFor('abc'), 8);
    assert.equal(L.hoursPerDayFor(500), 8);
});

test('day options: full, half, and 2 hours only when smaller than half', () => {
    assert.deepEqual(L.dayOptions(8), { full: 8, half: 4, two: 2 });
    assert.deepEqual(L.dayOptions(6), { full: 6, half: 3, two: 2 });
    assert.deepEqual(L.dayOptions(4), { full: 4, half: 2, two: null });
    assert.deepEqual(L.dayOptions(7.5), { full: 7.5, half: 3.75, two: 2 });
    assert.deepEqual(L.dayOptions(7.5, 1), { full: 8, half: 4, two: 2 }); // snapped to a 1-hour policy
    assert.deepEqual(L.dayOptions(undefined), { full: 8, half: 4, two: 2 });
});

test('the server defaults hours per day to the person\'s own day and still accepts 8/4/2', () => {
    const p = { type: 'pto', minimumIncrementHours: 0.25, skipHolidays: false, allowNegative: false };
    const bal = { availableBalance: 100, eligibleToUse: true };
    const day1 = { startDate: '2026-11-24', endDate: '2026-11-24' };
    assert.equal(L.validateRequest(p, day1, bal, '2026-11-21').value.hoursPerDay, 8); // old callers unchanged
    assert.equal(L.validateRequest(p, day1, bal, '2026-11-21', [], null, 7.5).value.hoursPerDay, 7.5);
    assert.equal(L.validateRequest({ ...p, minimumIncrementHours: 1 }, day1, bal, '2026-11-21', [], null, 7.5).value.hoursPerDay, 8);
    for (const h of [8, 4, 2, '8', '4', '2']) assert.equal(L.validateRequest(p, { ...day1, hoursPerDay: h }, bal, '2026-11-21', [], null, 6).value.hoursPerDay, Number(h));
});

test('the pages and routes are wired to what the system knows', () => {
    const page = read('my-benefits.html');
    assert.match(page, /<div id="famBox"><\/div>/);
    assert.match(page, /function initFamily\(\)/);
    assert.match(page, /\[data\.enrollment, \.\.\.\(data\.history \|\| \[\]\)\]/);
    assert.match(page, /existingDependentId: f\.id/);
    assert.match(page, /e\.tier = tierFor\(deps\)/);
    assert.doesNotMatch(page, /data-f="tier"/);
    assert.doesNotMatch(page, /data-depadd/);
    assert.doesNotMatch(page, /ssn: f\.ssnMasked/);
    const route = read('routes/us-benefits.js');
    assert.match(route, /savedDeps\.get\(d\.existingDependentId\)/);
    assert.match(route, /old\.dateOfBirth !== d\.dateOfBirth/);
    assert.match(route, /ssnEncrypted: old\.ssnEncrypted/);
    const leave = read('leave.html');
    assert.match(leave, /<select name="hoursPerDay" id="len"><\/select>/);
    assert.match(leave, /hoursPerDay = Number\(b\.hoursPerDay\) > 0/);
    assert.match(leave, /\$\('policy'\)\.addEventListener\('change', paintLen\)/);
    assert.doesNotMatch(leave, /Full day \(8 hours\)/);
    const leaveRoute = read('routes/us-leave.js');
    assert.match(leaveRoute, /hoursPerDay: L\.hoursPerDayFor\(profile\.scheduledWeeklyHours\)/);
    assert.match(leaveRoute, /companyHolidays, L\.hoursPerDayFor\(/);
});

test('the page copies of the tier and day-option logic match the services', async () => {
    const grab = (src, start, end) => { const i = src.indexOf(start); assert.ok(i >= 0, start); return src.slice(i, src.indexOf(end, i) + end.length); };
    const tierSrc = grab(read('my-benefits.html'), 'function tierFor(deps) {', "'employee_only';\n}");
    const tierFor = new Function(`${tierSrc}; return tierFor;`)();
    for (const deps of [[], [spouse], [partner], [kid], [spouse, kid]]) assert.equal(tierFor(deps), B.tierForDependents(deps));
    const leave = read('leave.html');
    const optSrc = grab(leave, 'const toIncrement =', 'return { full, half, two };\n}');
    const dayOptions = new Function(`${optSrc}; return dayOptions;`)();
    for (const [h, inc] of [[8, 0.25], [7.5, 0.25], [7.5, 1], [4, 0.25], [6, 0.5], [undefined, undefined]]) assert.deepEqual(dayOptions(h, inc), L.dayOptions(h, inc));
});
