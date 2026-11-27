import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../services/pay-schedule-rules.js');

const mk = (o) => { const r = P.validateSchedule(o); assert.deepEqual(r.errors, [], JSON.stringify(r.errors)); return r.value; };
const SCHEDULES = [
    mk({ name: 'Weekly', frequency: 'weekly', anchorPayDate: '2026-01-09', payDayLag: 5 }),
    mk({ name: 'Every two weeks', frequency: 'biweekly', anchorPayDate: '2026-01-09', payDayLag: 5 }),
    mk({ name: 'Twice a month', frequency: 'semimonthly', paydays: [15, 'last'], payDayLag: 5 }),
    mk({ name: 'Monthly', frequency: 'monthly', paydays: ['last'], payDayLag: 0 })
];

test('what the pay schedule page shows: the next 6 pay periods join up with no gap or overlap, for every frequency', () => {
    for (const s of SCHEDULES) {
        for (const from of ['2026-11-12', '2026-12-28', '2027-02-27', '2028-02-29']) {
            const next = P.nextPayDates(s, from, 6, new Set());
            assert.equal(next.length, 6, `${s.name} from ${from}`);
            for (let i = 0; i < next.length; i += 1) {
                const p = next[i];
                assert.ok(p.start <= p.end, `${s.name}: a period starts before it ends`);
                assert.ok(p.payDate >= from, `${s.name}: pay dates are not in the past`);
                assert.ok(p.end <= p.nominalPayDate, `${s.name}: people are paid after the period ends`);
                if (i > 0) assert.equal(p.start, P.addDays(next[i - 1].end, 1), `${s.name} from ${from}: period ${i + 1} starts the day after period ${i} ends`);
            }
        }
    }
});

test('the period marked "current" on the page contains today and is the first row or the one just before it', () => {
    for (const s of SCHEDULES) {
        const today = '2026-11-12';
        const cur = P.periodContaining(s, today, new Set());
        assert.ok(cur && cur.start <= today && today <= cur.end, s.name);
        const next = P.nextPayDates(s, today, 6, new Set());
        assert.ok(next.some((p) => p.start === cur.start) || P.addDays(cur.end, 1) === next[0].start || cur.end >= next[0].start, s.name);
    }
});

test('a pay date on a weekend or holiday is moved the way the schedule says, and the page can tell it moved', () => {
    const base = { name: 'M', frequency: 'monthly', paydays: [15], payDayLag: 0 };
    // 15 Nov 2026 is a Sunday
    const before = P.nextPayDates(mk({ ...base, holidayAdjustment: 'previous_business_day' }), '2026-11-01', 1, new Set())[0];
    assert.deepEqual([before.nominalPayDate, before.payDate], ['2026-11-15', '2026-11-13']);
    const after = P.nextPayDates(mk({ ...base, holidayAdjustment: 'next_business_day' }), '2026-11-01', 1, new Set())[0];
    assert.equal(after.payDate, '2026-11-16');
    const none = P.nextPayDates(mk({ ...base, holidayAdjustment: 'none' }), '2026-11-01', 1, new Set())[0];
    assert.equal(none.payDate, none.nominalPayDate);
    // Friday 13 Nov is a company holiday as well: back one more day
    assert.equal(P.nextPayDates(mk(base), '2026-11-01', 1, new Set(['2026-11-13']))[0].payDate, '2026-11-12');
});

test('a draft that is not saved yet is checked with the same rules (what the "show the pay dates" button sends)', () => {
    assert.deepEqual(P.validateSchedule({ name: 'Draft', frequency: 'biweekly', anchorPayDate: '2026-11-13', payDayLag: 5, holidayAdjustment: 'previous_business_day', active: true }).errors, []);
    assert.ok(P.validateSchedule({ name: 'Draft', frequency: 'biweekly' }).errors.some((e) => /anchorPayDate/.test(e)));
    assert.ok(P.validateSchedule({ name: 'Draft', frequency: 'semimonthly', paydays: [15, 15] }).errors.some((e) => /different/.test(e)));
    assert.ok(P.validateSchedule({ name: 'Draft', frequency: 'monthly', paydays: [32] }).errors.length);
    assert.ok(P.validateSchedule({ name: 'Draft', frequency: 'weekly', anchorPayDate: '2026-11-13', payDayLag: 2.5 }).errors.some((e) => /payDayLag/.test(e)));
});

test('the page and its routes are wired the way the page expects', () => {
    const page = fs.readFileSync(new URL('../admin-us-pay-schedule.html', import.meta.url), 'utf8');
    assert.equal(/\son[a-z]+\s*=\s*["']/.test(page), false, 'no inline event handlers');
    for (const needle of ['/pay-schedules/preview', '/me/permissions', 'expectedUpdatedAt', 'Confirm your schedule with a US compliance advisor']) assert.ok(page.includes(needle), needle);
    assert.equal(/gusto/i.test(page), false, 'the local page does not call the payroll provider');
    const routes = fs.readFileSync(new URL('../routes/us-org.js', import.meta.url), 'utf8');
    assert.match(routes, /router\.post\('\/pay-schedules\/preview', SCHEDULE_VIEW, requireUsOrg/);
    assert.match(routes, /Someone else changed this pay schedule/);
});
