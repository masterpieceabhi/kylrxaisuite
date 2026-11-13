import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../services/leave-rules.js');

// Thu 2026-11-26 is Thanksgiving (federal). Fri 2026-11-27 is a common company-only holiday.
test('without a company calendar, federal holidays are skipped', () => {
    assert.deepEqual(L.requestDates('2026-11-25', '2026-11-30', { skipHolidays: true }), ['2026-11-25', '2026-11-27', '2026-11-30']);
});

test('with a company calendar, the company days are skipped instead', () => {
    const company = new Set(['2026-11-26', '2026-11-27']);
    assert.deepEqual(L.requestDates('2026-11-25', '2026-11-30', { skipHolidays: true, holidays: company }), ['2026-11-25', '2026-11-30']);
});

test('a federal holiday the company turned off counts as a working day', () => {
    assert.deepEqual(L.requestDates('2026-11-25', '2026-11-27', { skipHolidays: true, holidays: new Set() }), ['2026-11-25', '2026-11-26', '2026-11-27']);
});

test('a policy that does not skip holidays ignores the calendar', () => {
    assert.deepEqual(L.requestDates('2026-11-26', '2026-11-27', { skipHolidays: false, holidays: new Set(['2026-11-26', '2026-11-27']) }), ['2026-11-26', '2026-11-27']);
});

test('validateRequest charges hours only for days the company is open', () => {
    const policy = { type: 'pto', skipHolidays: true, minimumIncrementHours: 1, allowNegative: false };
    const balance = { eligibleToUse: true, availableBalance: 16 };
    const body = { startDate: '2026-11-25', endDate: '2026-11-30', hoursPerDay: 8 };
    const federalOnly = L.validateRequest(policy, body, balance, '2026-11-01', []);
    assert.equal(federalOnly.errors.length, 1); // 3 days = 24 hours, only 16 available
    const withCompany = L.validateRequest(policy, body, balance, '2026-11-01', [], new Set(['2026-11-26', '2026-11-27']));
    assert.deepEqual(withCompany.errors, []);
    assert.equal(withCompany.value.hours, 16);
    assert.deepEqual(withCompany.value.dates, ['2026-11-25', '2026-11-30']);
});
