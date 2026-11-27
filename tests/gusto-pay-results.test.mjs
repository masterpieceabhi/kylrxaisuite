import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PR = require('../services/gusto/pay-results.js');
const canonical = require('../services/canonical.js');

const links = [{ ourId: 'u1', gustoUuid: 'g1' }, { ourId: 'u2', gustoUuid: 'g2' }];
const people = [{ id: 'u1', employeeId: 'EMP0001', name: 'Ana', department: 'Kitchen' }, { id: 'u2', employeeId: 'EMP0002', name: 'Ben', department: 'Front' }];
const base = { check_date: '2026-11-20', pay_period: { start_date: '2026-11-02', end_date: '2026-11-15' } };

test('share splits a total by weight and never loses a cent', () => {
    assert.deepEqual(PR.share(100, [1, 1, 1]), [34, 33, 33]);
    assert.deepEqual(PR.share(0, [5, 5]), [0, 0]);
    assert.deepEqual(PR.share(500, [0, 0]), [0, 0]);
    const parts = PR.share(12345, [70000, 30000, 1]);
    assert.equal(parts.reduce((a, b) => a + b, 0), 12345);
});

test('uses the per-person taxes and deductions Gusto sends', () => {
    const payroll = { ...base, totals: { employee_taxes: '999.00', employer_taxes: '999.00' }, employee_compensations: [{
        employee_uuid: 'g1', gross_pay: '1000.00', net_pay: '760.00',
        taxes: [{ name: 'Federal Income Tax', employer: false, amount: '120.00' }, { name: 'Social Security', employer: false, amount: '62.00' }, { name: 'Social Security', employer: true, amount: '62.00' }],
        deductions: [{ name: 'Garnishment', amount: '8.00' }], benefits: [{ name: 'Medical', employee_deduction: '50.00', company_contribution: '200.00' }],
        hourly_compensations: [{ hours: '70.000' }, { hours: '2.500' }], paid_time_off: [{ hours: '8.000' }]
    }] };
    const { rows, unmatched } = PR.buildPayResults({ orgId: 'o1', payrollUuid: 'p1', payroll, links, people, nowIso: '2026-11-18T00:00:00.000Z' });
    assert.equal(unmatched.length, 0);
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.employeeTaxes, 182); assert.equal(r.employerTaxes, 62); assert.equal(r.deductions, 58);
    assert.equal(r.gross, 1000); assert.equal(r.net, 760); assert.equal(r.hours, 80.5);
    assert.equal(r.allocated, false); assert.equal(r.department, 'Kitchen'); assert.equal(r.payDate, '2026-11-20');
    assert.equal(r.gross - r.employeeTaxes - r.deductions, r.net);
});

test('shares company totals by gross when there is no per-person detail, and says so', () => {
    const payroll = { ...base, totals: { gross_pay: '3000.00', employee_taxes: '600.00', employer_taxes: '240.00' }, employee_compensations: [
        { employee_uuid: 'g1', gross_pay: '2000.00', net_pay: '1600.00' }, { employee_uuid: 'g2', gross_pay: '1000.00', net_pay: '800.00' }
    ] };
    const { rows } = PR.buildPayResults({ orgId: 'o1', payrollUuid: 'p1', payroll, links, people, nowIso: 'x' });
    assert.deepEqual(rows.map((r) => r.employeeTaxes), [400, 200]);
    assert.deepEqual(rows.map((r) => r.employerTaxes), [160, 80]);
    assert.deepEqual(rows.map((r) => r.deductions), [0, 0]);
    assert.ok(rows.every((r) => r.allocated === true));
    const t = PR.totalsOf(rows);
    assert.equal(t.gross, 3000); assert.equal(t.employeeTaxes, 600); assert.equal(t.employerCost, 3240); assert.equal(t.people, 2);
});

test('leaves out excluded people and reports people with no link', () => {
    const payroll = { ...base, totals: {}, employee_compensations: [
        { employee_uuid: 'g1', gross_pay: '100.00', net_pay: '100.00', excluded: true }, { employee_uuid: 'g9', gross_pay: '100.00', net_pay: '80.00' }, { employee_uuid: 'g2', gross_pay: '100.00', net_pay: '100.00' }
    ] };
    const { rows, unmatched } = PR.buildPayResults({ orgId: 'o1', payrollUuid: 'p1', payroll, links, people, nowIso: 'x' });
    assert.deepEqual(rows.map((r) => r.userId), ['u2']);
    assert.deepEqual(unmatched, ['g9']);
});

test('store, setStatus and remove through the context hooks; ids are stable so a second store does not duplicate', async () => {
    const db = new Map();
    const ctx = {
        orgId: 'o1', store: { listLinks: async () => links },
        savePayResults: async (orgId, rows) => rows.forEach((r) => db.set(r.id, { ...r })),
        listPayResults: async (orgId, uuid) => [...db.values()].filter((r) => r.orgId === orgId && (!uuid || r.payrollUuid === uuid)),
        deletePayResults: async (orgId, ids) => ids.forEach((id) => db.delete(id))
    };
    const payroll = { ...base, totals: { employee_taxes: '20.00', employer_taxes: '8.00' }, employee_compensations: [{ employee_uuid: 'g1', gross_pay: '100.00', net_pay: '80.00' }] };
    assert.deepEqual(await PR.store(ctx, 'p1', payroll, { people }), { saved: 1, unmatched: [] });
    await PR.store(ctx, 'p1', payroll, { people });
    assert.equal(db.size, 1);
    assert.equal(await PR.setStatus(ctx, 'p1', 'paid'), 1);
    assert.equal([...db.values()][0].status, 'paid');
    assert.equal((await PR.listForOrg(ctx, { from: '2026-11-01', to: '2026-11-30' })).length, 1);
    assert.equal((await PR.listForOrg(ctx, { from: '2026-12-01' })).length, 0);
    assert.equal(await PR.remove(ctx, 'p1'), 1);
    assert.equal(db.size, 0);
});

test('a stored row maps to the public API pay result', () => {
    const payroll = { ...base, totals: { employee_taxes: '20.00', employer_taxes: '8.00' }, employee_compensations: [{ employee_uuid: 'g1', gross_pay: '100.00', net_pay: '80.00' }] };
    const { rows } = PR.buildPayResults({ orgId: 'o1', payrollUuid: 'p1', payroll, links, people, nowIso: '2026-11-18T00:00:00.000Z' });
    const api = canonical.toPayResult(rows[0]);
    assert.equal(api.person_id, 'u1'); assert.equal(api.employee_number, 'EMP0001'); assert.equal(api.pay_date, '2026-11-20');
    assert.equal(api.gross, 100); assert.equal(api.net, 80); assert.equal(api.employee_taxes, 20); assert.equal(api.employer_taxes, 8);
    assert.deepEqual(api.pay_period, { start: '2026-11-02', end: '2026-11-15' });
});

test('shared taxes never push deductions below zero, so every row and the company total still add up', () => {
    // People taxed at different rates: shared by gross, the lower-taxed person got a bigger share than was withheld
    // from them, deductions were clamped at zero, and the journal came out of balance.
    const comps = [
        { employee_uuid: 'g1', gross_pay: '1000.00', net_pay: '850.00' }, // 15% withheld
        { employee_uuid: 'g2', gross_pay: '1000.33', net_pay: '750.24' }, // about 25% withheld
        { employee_uuid: 'g3', gross_pay: '0.00', net_pay: '0.00' }
    ];
    const grossC = 100000 + 100033; const netC = 85000 + 75024;
    const payroll = { ...base, totals: { gross_pay: '2000.33', employee_taxes: ((grossC - netC) / 100).toFixed(2), employer_taxes: '180.01' }, employee_compensations: comps };
    const links3 = [...links, { ourId: 'u3', gustoUuid: 'g3' }];
    const people3 = [...people, { id: 'u3', name: 'Nora New' }];
    const { rows } = PR.buildPayResults({ orgId: 'o1', payrollUuid: 'p1', payroll, links: links3, people: people3, nowIso: 'x' });
    const c = (v) => Math.round(v * 100);
    for (const r of rows) {
        assert.ok(r.deductions >= 0, JSON.stringify(r));
        assert.equal(c(r.gross), c(r.net) + c(r.employeeTaxes) + c(r.deductions), `${r.name} adds up`);
    }
    const t = PR.totalsOf(rows);
    assert.equal(c(t.employeeTaxes), grossC - netC, 'the shares add up to the company total');
    assert.equal(c(t.gross), c(t.net) + c(t.employeeTaxes) + c(t.deductions), 'the company total balances');
    assert.equal(rows.find((r) => r.userId === 'u3').employeeTaxes, 0, 'nothing withheld, no tax share');
});
