// Hiring asks less: the offer starts from the job opening, the hire carries pay, type and manager into the
// profile, and the job form picks department and location from the org setup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { hireProfileExtras, payTypeForUnit, profileEmploymentType } = require('../routes/us-hiring.js').helpers;
const V = require('../services/us-validation.js');

const page = fs.readFileSync(new URL('../admin-us-hiring.html', import.meta.url), 'utf8');
const route = fs.readFileSync(new URL('../routes/us-hiring.js', import.meta.url), 'utf8');

/** offerDefaults lives in the page's module script; pull it out and run it */
function pageFn(name) {
    const start = page.indexOf(`function ${name}(`);
    assert.ok(start > 0, `${name} is in the page`);
    const end = page.indexOf('\n}', start);
    return new Function(`${page.slice(start, end + 2)}; return ${name};`)();
}
const offerDefaults = pageFn('offerDefaults');

test('offer pay comes from the job opening: middle of the range, else the one end given', () => {
    assert.deepEqual(offerDefaults({ payMin: 15, payMax: 18, payUnit: 'hour' }, '2026-11-21'), { payRate: 16.5, payUnit: 'hour' });
    assert.equal(offerDefaults({ payMin: 15, payMax: null, payUnit: 'hour' }, '2026-11-21').payRate, 15);
    assert.equal(offerDefaults({ payMin: null, payMax: 90000, payUnit: 'year' }, '2026-11-21').payRate, 90000);
    assert.equal(offerDefaults({ payMin: null, payMax: null, payUnit: 'year' }, '2026-11-21').payRate, undefined);
    assert.equal(offerDefaults({ payMin: 0, payMax: null }, '2026-11-21').payRate, undefined, 'an offer needs pay above zero');
    assert.equal(offerDefaults({ payMin: 50000, payMax: 60000, payUnit: 'year' }, '2026-11-21').payUnit, 'year');
    assert.deepEqual(offerDefaults(undefined, '2026-11-21'), {});
});

test('offer start date is the target start date only when it is today or later', () => {
    assert.equal(offerDefaults({ targetStartDate: '2026-12-01' }, '2026-11-21').startDate, '2026-12-01');
    assert.equal(offerDefaults({ targetStartDate: '2026-11-21' }, '2026-11-21').startDate, '2026-11-21');
    assert.equal(offerDefaults({ targetStartDate: '2026-11-20' }, '2026-11-21').startDate, undefined);
    assert.equal(offerDefaults({ targetStartDate: null }, '2026-11-21').startDate, undefined);
});

test('the page never overwrites an existing offer with the defaults', () => {
    assert.match(page, /const dflt = o \? \{\} : offerDefaults\(jobs\.find\(\(j\) => j\.id === cand\.requisitionId\), localToday\(\)\)/);
    assert.match(page, /f\.payRate\.value = o \? o\.payRate : \(dflt\.payRate \?\? ''\)/);
    assert.match(page, /f\.startDate\.value = o \? o\.startDate : \(dflt\.startDate \|\| ''\)/);
});

test('offer pay units map to the profile pay type', () => {
    assert.equal(payTypeForUnit('hour'), 'hourly');
    assert.equal(payTypeForUnit('hourly'), 'hourly');
    assert.equal(payTypeForUnit('year'), 'salary');
    assert.equal(payTypeForUnit('Salary'), 'salary');
    assert.equal(payTypeForUnit('annual'), 'salary');
    assert.equal(payTypeForUnit('week'), null);
    for (const t of ['hourly', 'salary']) assert.ok(V.PAY_TYPES.includes(t));
});

test('job employment types map only where the profile has the same value', () => {
    for (const t of ['full_time', 'part_time', 'seasonal', 'temporary']) assert.equal(profileEmploymentType(t), t);
    assert.equal(profileEmploymentType('contract'), null);
    assert.equal(profileEmploymentType('intern'), null);
    assert.deepEqual(V.EMPLOYMENT_TYPES, ['full_time', 'part_time', 'seasonal', 'temporary']);
});

test('the hire copies pay, type and manager into an empty profile', () => {
    const out = hireProfileExtras({}, { payRate: 18.5, payUnit: 'hour' }, { employmentType: 'part_time', hiringManagerId: 'mgr1' });
    assert.deepEqual(out, { payType: 'hourly', payRate: 18.5, employmentType: 'part_time', managerId: 'mgr1' });
    assert.deepEqual(hireProfileExtras(undefined, null, null), {});
    assert.deepEqual(hireProfileExtras({}, null, { employmentType: 'contract' }), {});
});

test('the hire never overrides what the profile already has', () => {
    const cur = { payType: 'salary', payRate: 70000, employmentType: 'full_time', managerId: 'boss' };
    assert.deepEqual(hireProfileExtras(cur, { payRate: 20, payUnit: 'hour' }, { employmentType: 'part_time', hiringManagerId: 'mgr1' }), {});
    // a salaried profile without a rate does not take an hourly figure
    assert.deepEqual(hireProfileExtras({ payType: 'salary' }, { payRate: 20, payUnit: 'hour' }, null), {});
    assert.deepEqual(hireProfileExtras({ payType: 'hourly' }, { payRate: 20, payUnit: 'hour' }, null), { payRate: 20 });
    assert.deepEqual(hireProfileExtras({ managerId: '' }, null, { hiringManagerId: 'mgr1' }), { managerId: 'mgr1' });
});

test('the hire route uses the extras, checks the manager and records the fields in the audit', () => {
    assert.match(route, /hireProfileExtras\(\(exists\(saved\) && saved\.data\(\)\.usProfile\) \|\| \{\}, d\.offer, job\)/);
    assert.match(route, /extras\.managerId === person\.uid \|\| !\(await userInOrg\(req\.orgId, extras\.managerId\)\)/);
    assert.match(route, /'candidate_hired', c\.id, \{ personId: person\.uid, employeeId, profileFields: Object\.keys\(profilePatch\) \}/);
    // the org chart reads usProfile.managerId
    assert.match(fs.readFileSync(new URL('../routes/us-org.js', import.meta.url), 'utf8'), /setProfile\(emp, \{ managerId \}, req\)/);
});

test('the job form picks department and location from the org setup, with typed fallback', () => {
    assert.match(page, /<select id="departmentPick" hidden><\/select><input name="department" required/);
    assert.match(page, /<select id="locationPick" hidden><\/select><input name="location" required/);
    assert.match(page, /quiet\('\/departments'\), quiet\('\/locations'\), quiet\('\/company\/profile'\)/);
    assert.match(page, /req\('GET', p\)\.catch\(\(\) => null\)/, 'a 403 keeps the typed fields');
    assert.match(page, /Other \/ type it/);
    assert.match(page, /f\.state\.value = st/, 'the state follows the chosen location');
    assert.match(page, /company\.profile \|\| company\.suggested/);
    assert.match(page, /if \(companyStates\.length === 1\) f\.state\.value = companyStates\[0\]/);
    assert.match(page, /await loadJobPickers\(\);\r?\n\s*resetJobForm\(\);/);
    // the job keeps storing the department and location names (validateRequisition needs text)
    assert.match(page, /department: el\.department\.value, location: el\.location\.value/);
});
