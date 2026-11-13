import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../services/pay-schedule-rules.js');

const mk = (o) => { const r = P.validateSchedule(o); assert.deepEqual(r.errors, [], JSON.stringify(r.errors)); return r.value; };

test('schedule validation', () => {
    assert.ok(P.validateSchedule({ name: 'x', frequency: 'daily' }).errors.length);
    assert.ok(P.validateSchedule({ name: 'x', frequency: 'weekly' }).errors.some((e) => /anchor/.test(e)));
    assert.ok(P.validateSchedule({ name: 'x', frequency: 'weekly', anchorPayDate: '2026-02-30' }).errors.length);
    assert.ok(P.validateSchedule({ name: 'x', frequency: 'semimonthly', paydays: [10, 10] }).errors.length);
    assert.ok(P.validateSchedule({ name: 'x', frequency: 'semimonthly', paydays: [0, 15] }).errors.length);
    assert.ok(P.validateSchedule({ name: 'x', frequency: 'monthly', payDayLag: 99 }).errors.length);
    assert.deepEqual(mk({ name: 'S', frequency: 'semimonthly', paydays: ['last', 15] }).paydays, [15, 31]);
    assert.deepEqual(mk({ name: 'S', frequency: 'monthly' }).paydays, [31]);
});

test('weekly: period, pay date and weekend adjustment', () => {
    // Fridays; pay 5 days after the Sunday period end... anchor Fri 2026-01-09 -> period end Sun 01-04 (lag 5)
    const s = mk({ name: 'W', frequency: 'weekly', anchorPayDate: '2026-01-09', payDayLag: 5 });
    const p = P.periodContaining(s, '2026-01-14');
    assert.deepEqual([p.start, p.end, p.payDate], ['2026-01-12', '2026-01-18', '2026-01-23']);
    assert.equal(P.periodContaining(s, '2026-01-11').start, '2026-01-05');
    assert.equal(P.periodContaining(s, '2026-01-18').end, '2026-01-18');
    assert.equal(P.periodContaining(s, '2026-01-19').start, '2026-01-19');
    // before the anchor works too
    assert.equal(P.periodContaining(s, '2025-12-24').end, '2025-12-28');
    const next = P.nextPayDates(s, '2026-01-10', 3);
    assert.deepEqual(next.map((x) => x.payDate), ['2026-01-16', '2026-01-23', '2026-01-30']);
    assert.equal(P.nextPayDates(s, '2026-01-09', 1)[0].payDate, '2026-01-09');
});

test('biweekly with a holiday adjustment back one business day', () => {
    const s = mk({ name: 'B', frequency: 'biweekly', anchorPayDate: '2026-01-09', payDayLag: 5 });
    const list = P.nextPayDates(s, '2026-01-01', 4);
    assert.deepEqual(list.map((x) => x.payDate), ['2026-01-09', '2026-01-23', '2026-02-06', '2026-02-20']);
    // pay date Fri 2026-02-20 is a holiday here: moves to Thursday
    assert.equal(P.payDateForPeriod(s, '2026-02-15', new Set(['2026-02-20'])), '2026-02-19');
    assert.equal(P.payDateForPeriod(s, '2026-02-16', new Set()), null); // not a period end
    assert.equal(P.payDateForPeriod(s, '2026-02-15'), '2026-02-20');
});

test('biweekly adjustment off a weekend nominal date (Saturday anchor)', () => {
    const s = mk({ name: 'B', frequency: 'biweekly', anchorPayDate: '2026-01-10', payDayLag: 5 }); // Saturday
    const p = P.periodContaining(s, '2026-01-02');
    assert.equal(p.nominalPayDate, '2026-01-10'); assert.equal(p.payDate, '2026-01-09');
    const forward = mk({ name: 'B', frequency: 'biweekly', anchorPayDate: '2026-01-10', payDayLag: 5, holidayAdjustment: 'next_business_day' });
    assert.equal(P.periodContaining(forward, '2026-01-02').payDate, '2026-01-12');
    const none = mk({ name: 'B', frequency: 'biweekly', anchorPayDate: '2026-01-10', payDayLag: 5, holidayAdjustment: 'none' });
    assert.equal(P.periodContaining(none, '2026-01-02').payDate, '2026-01-10');
});

test('semimonthly 15th and last day, February and leap years', () => {
    const s = mk({ name: 'S', frequency: 'semimonthly', paydays: [15, 31], payDayLag: 0, holidayAdjustment: 'none' });
    const feb = P.periodContaining(s, '2026-02-20');
    assert.deepEqual([feb.start, feb.end], ['2026-02-16', '2026-02-28']);
    const leap = P.periodContaining(s, '2028-02-29');
    assert.deepEqual([leap.start, leap.end], ['2028-02-16', '2028-02-29']);
    const first = P.periodContaining(s, '2026-03-01');
    assert.deepEqual([first.start, first.end], ['2026-03-01', '2026-03-15']);
    const dec = P.periodContaining(s, '2026-12-31');
    assert.deepEqual([dec.start, dec.end], ['2026-12-16', '2026-12-31']);
    const jan = P.periodContaining(s, '2026-01-01');
    assert.deepEqual([jan.start, jan.end], ['2026-01-01', '2026-01-15']);
    assert.equal(P.nextPayDates(s, '2026-01-31', 3).map((x) => x.payDate).join(), '2026-01-31,2026-02-15,2026-02-28');
});

test('semimonthly with lag and weekend adjustment', () => {
    const s = mk({ name: 'S', frequency: 'semimonthly', paydays: [15, 31], payDayLag: 5 });
    // paydays 15th and last; period ends 10th and 26th (nominal pay minus 5)
    const p = P.periodContaining(s, '2026-02-05');
    assert.deepEqual([p.start, p.end, p.nominalPayDate], ['2026-01-27', '2026-02-10', '2026-02-15']);
    assert.equal(p.payDate, '2026-02-13'); // Sunday 15th -> Friday (Monday the 16th is Presidents Day but no holiday set given)
    const p2 = P.periodContaining(s, '2026-02-20');
    assert.deepEqual([p2.end, p2.nominalPayDate, p2.payDate], ['2026-02-23', '2026-02-28', '2026-02-27']);
});

test('monthly on the last day and on a fixed day', () => {
    const last = mk({ name: 'M', frequency: 'monthly', paydays: ['last'], payDayLag: 0, holidayAdjustment: 'none' });
    assert.equal(P.periodContaining(last, '2026-02-10').end, '2026-02-28');
    assert.equal(P.periodContaining(last, '2028-02-10').end, '2028-02-29');
    assert.equal(P.periodContaining(last, '2026-04-30').start, '2026-04-01');
    assert.equal(P.nextPayDates(last, '2026-01-01', 12).length, 12);
    const fifth = mk({ name: 'M', frequency: 'monthly', paydays: [5], payDayLag: 5, holidayAdjustment: 'previous_business_day' });
    const p = P.periodContaining(fifth, '2026-03-15');
    // pay on the 5th, period ends on the 31st/28th... end = 5th - 5 days = the 31st of the month before
    assert.deepEqual([p.start, p.end, p.nominalPayDate], ['2026-03-01', '2026-03-31', '2026-04-05']);
    assert.equal(p.payDate, '2026-04-03'); // Sunday -> Friday
    // year boundary
    assert.equal(P.periodContaining(fifth, '2026-12-31').nominalPayDate, '2027-01-05');
});

test('next pay dates are sorted and unique across a year', () => {
    for (const freq of ['weekly', 'biweekly', 'semimonthly', 'monthly']) {
        const s = mk({ name: freq, frequency: freq, anchorPayDate: '2026-01-02', payDayLag: 3 });
        const list = P.nextPayDates(s, '2026-01-01', 30);
        assert.equal(list.length, 30, freq);
        const dates = list.map((x) => x.payDate);
        assert.deepEqual([...dates].sort(), dates, freq);
        assert.equal(new Set(dates).size, 30, freq);
        // periods tile with no gaps
        for (let i = 1; i < list.length; i += 1) assert.equal(P.addDays(list[i - 1].end, 1), list[i].start, freq);
    }
});
