/**
 * PF (and any percentage-of-BASIC component) must follow the EARNED, LOP-prorated basic,
 * even when the catalog says the PF component itself is not prorated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const engine = require('../services/payroll/payrollCalculationEngine.js');

const employee = { employeeId: 'EMP0001', name: 'Test Person' };
const structure = {
    components: [
        { componentCode: 'BASIC', calculationBasis: 'FLAT', amount: 30000 },
        { componentCode: 'HRA', calculationBasis: 'Percentage', percentage: 40 },
        { componentCode: 'PF_EE', calculationBasis: 'Percentage', percentage: 12 },
        { componentCode: 'PF_ER', calculationBasis: 'Percentage', percentage: 12 },
    ]
};
const catalog = (pfProrate, extra = {}) => [
    { componentCode: 'BASIC', componentType: 'Earning', prorateOnLop: true, isPfApplicable: true },
    { componentCode: 'HRA', componentType: 'Earning', prorateOnLop: true },
    { componentCode: 'PF_EE', componentType: 'Deduction', prorateOnLop: pfProrate, ...extra },
    { componentCode: 'PF_ER', componentType: 'Employer_Contribution', prorateOnLop: pfProrate, ...extra },
];
const att = { calendarDaysInMonth: 30, lopDays: 3 };
const get = (r, code) => r.components.find((c) => c.componentCode === code);

test('PF on earned basic when the PF component is NOT prorated in the catalog', () => {
    const r = engine.calculateEmployeePayroll(employee, structure, att, catalog(false));
    assert.equal(get(r, 'BASIC').earnedAmount, 27000);
    assert.equal(get(r, 'PF_EE').earnedAmount, 3240);          // 12% of 27,000, not 3,600
    assert.equal(get(r, 'PF_EE').scheduledAmount, 3600);
    assert.equal(get(r, 'PF_ER').earnedAmount, 3240);
    assert.equal(r.totalDeductions, 3240);
});

test('PF on earned basic when the PF component is prorated (no double proration)', () => {
    const r = engine.calculateEmployeePayroll(employee, structure, att, catalog(true));
    assert.equal(get(r, 'PF_EE').earnedAmount, 3240);
});

test('no unpaid leave: PF is 12% of full basic', () => {
    const r = engine.calculateEmployeePayroll(employee, structure, { calendarDaysInMonth: 30, lopDays: 0 }, catalog(false));
    assert.equal(get(r, 'PF_EE').earnedAmount, 3600);
});

test('percentage earnings follow earned basic too', () => {
    const r = engine.calculateEmployeePayroll(employee, structure, att, catalog(false));
    assert.equal(get(r, 'HRA').earnedAmount, 10800);           // 40% of 27,000
});

test('catalog PF wage ceiling of 15,000 caps the PF basis', () => {
    const r = engine.calculateEmployeePayroll(employee, structure, att, catalog(false, { pfWageCeiling: 15000 }));
    assert.equal(get(r, 'PF_EE').earnedAmount, 1800);          // 12% of 15,000
    assert.equal(get(r, 'PF_ER').earnedAmount, 1800);
});

test('run-level ceiling option; a lower earned basic stays below the ceiling', () => {
    const r = engine.calculateEmployeePayroll(employee, structure, att, catalog(false), { pfWageCeiling: 15000 });
    assert.equal(get(r, 'PF_EE').earnedAmount, 1800);
    const small = { components: [
        { componentCode: 'BASIC', calculationBasis: 'FLAT', amount: 12000 },
        { componentCode: 'PF_EE', calculationBasis: 'Percentage', percentage: 12 } ] };
    const r2 = engine.calculateEmployeePayroll(employee, small, att, catalog(false), { pfWageCeiling: 15000 });
    assert.equal(get(r2, 'PF_EE').earnedAmount, 1296);         // 12% of 10,800
});

test('no ceiling by default (ceiling is optional)', () => {
    const r = engine.calculateEmployeePayroll(employee, structure, att, catalog(false));
    assert.equal(get(r, 'PF_EE').earnedAmount, 3240);
});
