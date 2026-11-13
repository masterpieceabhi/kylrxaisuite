import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const v = require('../services/us-validation.js');

const base = () => ({
    ein: '12-3456789', entityType: 'llc', legalName: 'Acme LLC',
    businessAddress: { line1: '5 Elm', city: 'Dallas', state: 'TX', zip: '75001' }, workStates: ['TX']
});

test('industry code and fiscal year are optional: an old request still passes and sets neither', () => {
    const r = v.validateCompanyProfile(base());
    assert.deepEqual(r.errors, []);
    assert.equal('industryCode' in r.value, false);
    assert.equal('fiscalYearStartMonth' in r.value, false);
});

test('NAICS code: 2 to 6 digits, kept as text so a leading zero is not lost', () => {
    for (const code of ['72', '722', '7225', '72251', '722511', ' 541511 ']) {
        const r = v.validateCompanyProfile({ ...base(), industryCode: code });
        assert.deepEqual(r.errors, [], code);
        assert.equal(r.value.industryCode, code.trim());
    }
    assert.equal(v.validateCompanyProfile({ ...base(), industryCode: 722511 }).value.industryCode, '722511');
    for (const bad of ['7', '7225111', '72-25', 'abcd', '72.5', '-722']) {
        const r = v.validateCompanyProfile({ ...base(), industryCode: bad });
        assert.ok(r.errors.some((e) => /industryCode/.test(e)), bad);
        assert.equal('industryCode' in r.value, false);
    }
});

test('an empty industry code clears it', () => {
    assert.equal(v.validateCompanyProfile({ ...base(), industryCode: '' }).value.industryCode, null);
    assert.equal(v.validateCompanyProfile({ ...base(), industryCode: null }).value.industryCode, null);
});

test('fiscal year start month: whole number 1 to 12, text or number; empty means January', () => {
    for (let m = 1; m <= 12; m += 1) {
        assert.equal(v.validateCompanyProfile({ ...base(), fiscalYearStartMonth: m }).value.fiscalYearStartMonth, m);
        assert.equal(v.validateCompanyProfile({ ...base(), fiscalYearStartMonth: String(m) }).value.fiscalYearStartMonth, m);
    }
    assert.equal(v.validateCompanyProfile({ ...base(), fiscalYearStartMonth: '' }).value.fiscalYearStartMonth, 1);
    for (const bad of [0, 13, -1, 1.5, 'July', '1e1', true, [], {}]) {
        const r = v.validateCompanyProfile({ ...base(), fiscalYearStartMonth: bad });
        assert.ok(r.errors.some((e) => /fiscalYearStartMonth/.test(e)), String(bad));
    }
});

test('fiscalYearFor gives the year that contains a date', () => {
    assert.deepEqual(v.fiscalYearFor('2026-11-12', 1), { start: '2026-01-01', end: '2026-12-31', label: 'FY2026' });
    assert.deepEqual(v.fiscalYearFor('2026-11-12', 7), { start: '2026-07-01', end: '2027-06-30', label: 'FY2027' });
    assert.deepEqual(v.fiscalYearFor('2026-03-31', 7), { start: '2025-07-01', end: '2026-06-30', label: 'FY2026' });
    assert.deepEqual(v.fiscalYearFor('2026-07-01', 7), { start: '2026-07-01', end: '2027-06-30', label: 'FY2027' });
    // a year starting in March ends on the last day of February, leap year included
    assert.equal(v.fiscalYearFor('2027-06-01', 3).end, '2028-02-29');
    assert.equal(v.fiscalYearFor('2026-06-01', 3).end, '2027-02-28');
    assert.equal(v.fiscalYearFor('not a date', 7), null);
    assert.equal(v.fiscalYearFor('2026-05-05', 99).label, 'FY2026'); // a bad month falls back to January
});
