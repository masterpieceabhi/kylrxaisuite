import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const f = require('../services/us-forms.js');

test('3 business days after a Monday start is Thursday; a Thursday start rolls past the weekend to Tuesday', () => {
    assert.equal(f.addBusinessDays('2026-11-09', 3), '2026-11-12'); // Mon -> Thu
    assert.equal(f.addBusinessDays('2026-11-12', 3), '2026-11-17'); // Thu -> Tue
    assert.equal(f.addBusinessDays('2026-11-13', 3), '2026-11-18'); // Fri -> Wed
    assert.equal(f.addBusinessDays('not-a-date', 3), null);
});

test('federal holidays can be skipped when the company chooses to', () => {
    // Thanksgiving 2026 is Thu Nov 26; Tue Nov 24 + 3 business days
    assert.equal(f.addBusinessDays('2026-11-24', 3), '2026-11-27');
    assert.equal(f.addBusinessDays('2026-11-24', 3, { skipFederalHolidays: true }), '2026-11-30');
    const h = f.federalHolidays(2026);
    assert.ok(h.has('2026-11-26') && h.has('2026-07-03') /* Jul 4 is a Saturday: observed Friday */ && h.has('2026-12-25'));
    assert.ok(h.has('2026-01-19') && h.has('2026-05-25') && h.has('2026-09-07') && h.has('2026-10-12'));
});

const goodW4 = () => ({ taxYear: 2026, filingStatus: 'single_or_mfs', qualifyingChildren: 1, otherDependents: 0, extraWithholding: 25, declarationAccepted: true, signedName: 'Jamie Rivera' });

test('W-4 accepts a complete form and keeps counts and amounts', () => {
    const { errors, value } = f.validateW4(goodW4(), 'Jamie Rivera');
    assert.deepEqual(errors, []);
    assert.equal(value.qualifyingChildren, 1);
    assert.equal(value.extraWithholding, 25);
    assert.equal(value.multipleJobs, false);
});

test('W-4 rejects bad filing status, negatives, unsigned or mismatched signature', () => {
    assert.ok(f.validateW4({ ...goodW4(), filingStatus: 'married' }, 'Jamie Rivera').errors.some((e) => /filingStatus/.test(e)));
    assert.ok(f.validateW4({ ...goodW4(), extraWithholding: -5 }, 'Jamie Rivera').errors.some((e) => /extraWithholding/.test(e)));
    assert.ok(f.validateW4({ ...goodW4(), qualifyingChildren: 1.5 }, 'Jamie Rivera').errors.some((e) => /qualifyingChildren/.test(e)));
    assert.ok(f.validateW4({ ...goodW4(), declarationAccepted: false }, 'Jamie Rivera').errors.some((e) => /declaration/.test(e)));
    assert.ok(f.validateW4({ ...goodW4(), signedName: 'Someone Else' }, 'Jamie Rivera').errors.some((e) => /match/.test(e)));
    assert.ok(f.validateW4({ ...goodW4(), taxYear: 1999 }, 'Jamie Rivera').errors.some((e) => /taxYear/.test(e)));
});

test('I-9 Section 1: citizen needs no numbers; work-authorized noncitizen needs number and expiry', () => {
    const base = { citizenshipStatus: 'us_citizen', attestation: true, signedName: 'Jamie Rivera' };
    assert.deepEqual(f.validateI9Section1(base, 'Jamie Rivera').errors, []);
    const alien = { ...base, citizenshipStatus: 'alien_authorized_to_work' };
    const e = f.validateI9Section1(alien, 'Jamie Rivera').errors.join('|');
    assert.match(e, /authorizationNumber/); assert.match(e, /workAuthorizationExpires/);
    const ok = f.validateI9Section1({ ...alien, authorizationNumber: 'A123456789', workAuthorizationExpires: '2027-06-30' }, 'Jamie Rivera');
    assert.deepEqual(ok.errors, []);
    assert.ok(f.validateI9Section1({ ...base, attestation: false }, 'Jamie Rivera').errors.some((x) => /attestation/.test(x)));
});

const doc = (type, extra = {}) => ({ type, issuingAuthority: 'State', number: 'X123456', ...extra });
const sec2 = (o = {}) => ({ examinedOn: '2026-11-10', examinationMethod: 'in_person', signerName: 'Pat HR', signerTitle: 'HR Manager', certification: true, ...o });

test('I-9 Section 2: one List A, or one List B plus one List C, never mixed or partial', () => {
    assert.deepEqual(f.validateI9Section2(sec2({ listA: doc('us_passport', { expiresOn: '2031-01-01' }) }), '2026-11-09').errors, []);
    assert.deepEqual(f.validateI9Section2(sec2({ listB: doc('drivers_license'), listC: doc('social_security_card_unrestricted') }), '2026-11-09').errors, []);
    assert.ok(f.validateI9Section2(sec2({ listB: doc('drivers_license') }), '2026-11-09').errors.length > 0);
    assert.ok(f.validateI9Section2(sec2({ listA: doc('us_passport'), listB: doc('drivers_license') }), '2026-11-09').errors.some((e) => /not both/.test(e)));
    assert.ok(f.validateI9Section2(sec2({ listA: doc('library_card') }), '2026-11-09').errors.some((e) => /listA.type/.test(e)));
    assert.ok(f.validateI9Section2(sec2({ listA: doc('us_passport'), certification: false }), '2026-11-09').errors.some((e) => /certification/.test(e)));
    assert.ok(f.validateI9Section2(sec2({ listA: doc('us_passport') }), null).errors.some((e) => /first day/.test(e)));
});

test('retention: later of 3 years after hire or 1 year after termination', () => {
    assert.equal(f.retainUntil('2026-11-09', null), '2029-11-09');
    assert.equal(f.retainUntil('2026-11-09', '2027-03-01'), '2029-11-09');
    assert.equal(f.retainUntil('2020-01-15', '2029-06-01'), '2030-06-01');
});

test('reverification date is the earliest expiry among work authorization and List A/C documents', () => {
    assert.equal(f.reverificationDate({ workAuthorizationExpires: '2027-06-30' }, { listA: { expiresOn: '2027-01-15' } }), '2027-01-15');
    assert.equal(f.reverificationDate({}, { listB: { expiresOn: '2025-01-01' } }), null);
});

test('onboarding status flags what is late', () => {
    const base = { firstDay: '2026-11-02', w4: undefined, i9: undefined, todayIso: '2026-11-04' };
    let s = f.onboardingStatus(base);
    assert.equal(s.i9Section2Due, '2026-11-05');
    assert.ok(s.flags.includes('w4_overdue') && s.flags.includes('i9_section1_overdue') && !s.flags.includes('i9_section2_overdue'));
    s = f.onboardingStatus({ ...base, todayIso: '2026-11-06' });
    assert.ok(s.flags.includes('i9_section2_overdue'));
    s = f.onboardingStatus({ ...base, todayIso: '2026-11-06', w4: { current: {} }, i9: { section1: {}, section2: {} } });
    assert.deepEqual(s.flags, []); assert.equal(s.i9State, 'complete'); assert.equal(s.ok, true);
    s = f.onboardingStatus({ firstDay: '2026-11-02', w4: { current: {} }, i9: { section1: { workAuthorizationExpires: '2027-01-10' }, section2: {} }, todayIso: '2026-11-10' });
    assert.ok(s.flags.includes('i9_reverification_soon'));
    s = f.onboardingStatus({ firstDay: '2026-11-02', w4: { current: {} }, i9: { section1: { workAuthorizationExpires: '2026-11-01' }, section2: {} }, todayIso: '2026-11-10' });
    assert.ok(s.flags.includes('i9_reverification_overdue') && s.ok === false);
    s = f.onboardingStatus({ firstDay: '2026-11-20', w4: undefined, i9: undefined, todayIso: '2026-11-10' });
    assert.ok(s.flags.includes('w4_pending') && s.ok === true);
});
