// Employee documents are never auto-deleted while the person still works there; after they leave, the keep period
// counts from the last day (longer payroll retention in NY and NJ), and I-9 copies follow the I-9 rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const V = require('../services/vault-rules.js');
const forms = require('../services/us-forms.js');

const TODAY = '2031-06-01';
const working = { usProfile: { workState: 'TX' } };
const leftTx = { usProfile: { workState: 'TX', termination: { lastDay: '2028-01-15' } } };
const leftNy = { usProfile: { workState: 'NY', termination: { lastDay: '2028-01-15' } } };

test('a current employee keeps every document, however old', () => {
    for (const category of ['performance', 'payroll_record', 'i9_document', 'medical_confidential']) {
        const r = V.employeeRetention({ category, retainUntil: '2020-01-01' }, working, TODAY, '2015-01-01', forms.retainUntil);
        assert.equal(r.keep, true, category);
    }
    assert.equal(V.employeeRetention({ category: 'performance' }, null, TODAY, null, forms.retainUntil).keep, true, 'unknown person is kept');
    const later = { usProfile: { termination: { lastDay: '2031-12-31' } } };
    assert.equal(V.employeeRetention({ category: 'performance' }, later, TODAY, '2015-01-01', forms.retainUntil).keep, true, 'leaving later is still employed');
});

test('after leaving: 4 years by default, 6 for payroll in New York and New Jersey', () => {
    assert.equal(V.employeeRetention({ category: 'performance', retainUntil: '2020-01-01' }, leftTx, TODAY, '2015-01-01', forms.retainUntil).retainUntil, '2032-01-15');
    assert.equal(V.employeeRetention({ category: 'payroll_record' }, leftTx, TODAY, '2015-01-01', forms.retainUntil).retainUntil, '2032-01-15');
    assert.equal(V.employeeRetention({ category: 'payroll_record' }, leftNy, TODAY, '2015-01-01', forms.retainUntil).retainUntil, '2034-01-15');
    assert.equal(V.yearsAfterLeaving('payroll_record', 'nj'), 6);
    assert.equal(V.yearsAfterLeaving('performance', 'NY'), 4);
    // an upload-based date that is later still wins
    assert.equal(V.employeeRetention({ category: 'performance', retainUntil: '2035-01-01' }, leftTx, TODAY, '2015-01-01', forms.retainUntil).retainUntil, '2035-01-01');
});

test('an I-9 copy: the later of 3 years after hire and 1 year after the last day', () => {
    assert.equal(V.employeeRetention({ category: 'i9_document' }, leftTx, TODAY, '2015-01-01', forms.retainUntil).retainUntil, '2029-01-15');
    assert.equal(V.employeeRetention({ category: 'i9_document' }, leftTx, TODAY, '2027-06-01', forms.retainUntil).retainUntil, '2030-06-01');
});

test('the daily job uses the after-leaving rule for employee documents', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../services/retention-jobs.js', import.meta.url), 'utf8');
    assert.match(src, /V\.employeeRetention\(/);
});
