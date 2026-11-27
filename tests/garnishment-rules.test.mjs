import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../services/garnishment-rules.js');

const base = { userId: 'u1', type: 'creditor', caseNumber: 'CV-2026-001234', amountType: 'amount', value: 150, startDate: '2026-11-01' };
const ok = (over = {}) => { const r = G.validateGarnishment({ ...base, ...over }); assert.deepEqual(r.errors, []); return r; };
const errs = (over) => G.validateGarnishment({ ...base, ...over }).errors.join(' | ');

test('a valid order: the case number comes back separately and never inside the stored value', () => {
    const r = ok({ limits: { perPayPeriodMax: 200, annualMax: '5000', totalAmount: 12000.5 }, endDate: '2027-01-31', payeeNotes: '  County clerk,  PO Box 1 ' });
    assert.equal(r.caseNumber, 'CV-2026-001234');
    assert.equal(r.value.caseLast4, '1234');
    assert.ok(!JSON.stringify(r.value).includes('CV-2026-001234'));
    assert.deepEqual(r.value.limits, { perPayPeriodMax: 200, annualMax: 5000, totalAmount: 12000.5 });
    assert.equal(r.value.payeeNotes, 'County clerk, PO Box 1');
    assert.equal(r.value.endDate, '2027-01-31');
});

test('percent orders, tax levies and child support carry their own fields', () => {
    assert.equal(ok({ amountType: 'percent', value: 25 }).value.value, 25);
    assert.equal(ok({ type: 'tax_levy', levyAuthority: 'state' }).value.levyAuthority, 'state');
    const cs = ok({ type: 'child_support', issuingState: 'tx', paymentPeriod: 'Every other week', remittanceNumber: 'R-77', fipsCode: '48453' }).value;
    assert.deepEqual([cs.issuingState, cs.paymentPeriod, cs.remittanceNumber, cs.fipsCode], ['TX', 'Every other week', 'R-77', '48453']);
});

test('what is refused', () => {
    assert.match(errs({ userId: '' }), /userId is required/);
    assert.match(errs({ type: 'gift' }), /type must be one of/);
    assert.match(errs({ type: 'tax_levy' }), /levyAuthority must be federal or state/);
    assert.match(errs({ caseNumber: '' }), /caseNumber is required/);
    assert.match(errs({ caseNumber: '<script>' }), /caseNumber may have/);
    assert.match(errs({ amountType: 'half' }), /amountType must be amount or percent/);
    assert.match(errs({ value: 0 }), /must be above 0/);
    assert.match(errs({ value: 10.005 }), /cents at most/);
    assert.match(errs({ amountType: 'percent', value: 101 }), /at most 100/);
    assert.match(errs({ amountType: 'percent', value: '' }), /at most 100/);
    assert.match(errs({ limits: { perPayPeriodMax: 100 } }), /lower than the amount/);
    assert.match(errs({ limits: { annualMax: -1 } }), /limits\.annualMax must be above 0/);
    assert.match(errs({ startDate: '2026-02-30' }), /startDate must be a date/);
    assert.match(errs({ endDate: '2026-10-01' }), /endDate cannot be before startDate/);
    assert.match(errs({ type: 'child_support' }), /issuingState/);
    assert.match(errs({ type: 'child_support', issuingState: 'TX', paymentPeriod: 'Daily', fipsCode: '12' }), /paymentPeriod must be one of.*fipsCode must be 5 or 7 digits/);
    assert.equal(G.validateGarnishment({ ...base, value: -1 }).caseNumber, null, 'no case number is handed back when the input is not valid');
});

test('there is no built-in legal limit: a 100 percent order with no limits is accepted, and the note says to confirm', () => {
    const r = ok({ amountType: 'percent', value: 100 });
    assert.deepEqual(r.value.limits, { perPayPeriodMax: null, annualMax: null, totalAmount: null });
    assert.match(G.NOTE, /Nothing here applies a legal limit/);
    assert.match(G.NOTE, /confirm with a US compliance advisor/i);
});

test('status by date, and what needs doing', () => {
    const g = { ...ok().value, id: 'g1', provider: { state: 'not_sent' } };
    assert.equal(G.statusOn(g, '2026-10-31'), 'scheduled');
    assert.equal(G.statusOn(g, '2026-11-01'), 'active');
    assert.equal(G.statusOn({ ...g, endDate: '2026-11-30' }, '2026-11-30'), 'active');
    assert.equal(G.statusOn({ ...g, endDate: '2026-11-30' }, '2026-12-01'), 'ended');
    assert.equal(G.statusOn({ ...g, endedAt: '2026-11-05T00:00:00Z' }, '2026-11-05'), 'ended');
    assert.match(G.attention(g, '2026-10-31').join(), /starts on 2026-11-01/);
    assert.match(G.attention(g, '2026-11-02').join(), /has not been sent/);
    assert.match(G.attention({ ...g, provider: { state: 'error', error: 'boom' } }, '2026-11-02').join(), /could not be sent.*boom/);
    assert.deepEqual(G.attention({ ...g, provider: { state: 'sent', active: true } }, '2026-11-02'), []);
    assert.match(G.attention({ ...g, endDate: '2026-11-30', provider: { state: 'sent', active: true } }, '2026-12-05').join(), /still switched on/);
    assert.deepEqual(G.attention({ ...g, endDate: '2026-11-30', endedAt: 'x', provider: { state: 'sent', active: false } }, '2026-12-05'), []);
});

test('ending: default is today, not before the start, not twice', () => {
    const g = { ...ok().value, id: 'g1' };
    assert.deepEqual(G.validateEnd(g, {}, '2026-11-12'), { errors: [], endDate: '2026-11-12', reason: '' });
    assert.equal(G.validateEnd(g, { endDate: '2026-12-31', reason: ' paid  in full ' }, '2026-11-12').reason, 'paid in full');
    assert.match(G.validateEnd(g, { endDate: '2026-10-01' }, '2026-11-12').errors.join(), /before the start date/);
    assert.match(G.validateEnd({ ...g, endedAt: 'x' }, {}, '2026-11-12').errors.join(), /already ended/);
});

test('the provider body: amounts as text, percent flag, limits, and the case number only for child support', () => {
    const cred = G.toGustoGarnishment({ ...ok({ limits: { perPayPeriodMax: 200, totalAmount: 3000 } }).value }, 'CV-2026-001234');
    assert.deepEqual(cred, { active: true, amount: '150.00', description: 'Creditor', court_ordered: true, garnishment_type: 'creditor_garnishment', times: null, recurring: true, deduct_as_percentage: false, pay_period_maximum: '200.00', annual_maximum: null, total_amount: '3000.00' });
    assert.ok(!JSON.stringify(cred).includes('CV-2026'), 'no field for it at the provider, so it stays here');
    assert.equal(G.toGustoGarnishment(ok({ type: 'tax_levy', levyAuthority: 'federal' }).value, 'X').garnishment_type, 'federal_tax_lien');
    assert.equal(G.toGustoGarnishment(ok({ type: 'tax_levy', levyAuthority: 'state' }).value, 'X').garnishment_type, 'state_tax_lien');
    const cs = G.toGustoGarnishment(ok({ type: 'child_support', issuingState: 'TX', amountType: 'percent', value: 20, fipsCode: '48453' }).value, 'CS-9', { active: false });
    assert.equal(cs.active, false); assert.equal(cs.amount, '20'); assert.equal(cs.deduct_as_percentage, true);
    assert.deepEqual(cs.child_support, { state: 'TX', payment_period: null, case_number: 'CS-9', remittance_number: null, fips_code: '48453' });
});

test('what a reader sees: the case number only with permission', () => {
    const g = { ...ok({ type: 'child_support', issuingState: 'TX', remittanceNumber: 'R-77' }).value, id: 'g1', name: 'Ann', caseNumberEnc: 'v1:secret', provider: { state: 'sent', active: true, gustoUuid: 'gg' } };
    const hidden = G.publicGarnishment(g, { today: '2026-11-12' });
    assert.equal(hidden.caseNumber, null); assert.equal(hidden.caseNumberHidden, true); assert.equal(hidden.remittanceNumber, null);
    const raw = JSON.stringify(hidden);
    assert.ok(!raw.includes('secret') && !raw.includes('1234') && !raw.includes('gg'), 'no encrypted value, no last 4, no provider id');
    const shown = G.publicGarnishment(g, { today: '2026-11-12', showCase: true, caseNumber: 'CV-2026-001234' });
    assert.equal(shown.caseNumber, 'CV-2026-001234'); assert.equal(shown.remittanceNumber, 'R-77');
    assert.equal(shown.status, 'active'); assert.equal(shown.provider.state, 'sent'); assert.equal(shown.typeLabel, 'Child support');
});
