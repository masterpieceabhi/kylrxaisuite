// Forms start from what the system already knows (2026-11-22 review: people typed the company and their own
// details again although sign-up and earlier steps had them).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { fromSignup } = require('../routes/us-hr.js');

test('the company profile starts from the sign-up details', () => {
    const s = fromSignup({ legalName: 'Prompt AI Ethical Solutions USA LLC', organizationType: 'LLC', registeredAddress: '100 Main St', city: 'Dallas', state: 'tx', pinCode: '75201', financialYearStart: '01-01' });
    assert.equal(s.legalName, 'Prompt AI Ethical Solutions USA LLC');
    assert.equal(s.entityType, 'llc');
    assert.deepEqual(s.businessAddress, { line1: '100 Main St', city: 'Dallas', state: 'TX', zip: '75201' });
    assert.deepEqual(s.workStates, ['TX']);
    assert.equal(s.fiscalYearStartMonth, 1);
});

test('India-style or unknown sign-up values are left blank instead of guessed', () => {
    const s = fromSignup({ organizationType: 'Private Limited', state: 'Karnataka', pinCode: '560103', financialYearStart: '04-01' });
    assert.equal(s.entityType, '');
    assert.equal(s.businessAddress.state, '');
    assert.equal(s.businessAddress.zip, '');
    assert.deepEqual(s.workStates, []);
    assert.equal(s.fiscalYearStartMonth, 4);
    assert.doesNotThrow(() => fromSignup(undefined));
});

test('the pages fill in what is known', () => {
    const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    assert.match(read('admin-us-people.html'), /const profile = \{ \.\.\.\(suggested \|\| \{\}\), \.\.\.Object\.fromEntries/);
    assert.match(read('admin-us-people.html'), /companyStates\.length === 1/);
    assert.match(read('leave.html'), /f\.endDate\.value = f\.startDate\.value/);
    assert.match(read('admin-us-i9.html'), /const ISSUER = \{/);
    assert.match(read('report-injury.html'), /dateOfIncident\.max = injuryToday\(\)/);
});
