import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const O = require('../services/org-rules.js');
const CF = require('../services/custom-fields-rules.js');
const PC = require('../services/profile-change-rules.js');
const CH = require('../services/comp-history-rules.js');
const DD = require('../services/direct-deposit-rules.js');
const CT = require('../services/contractor-rules.js');
const H = require('../services/holiday-rules.js');
const { federalHolidays } = require('../services/us-forms.js');

// ---------- org structure ----------
test('location validation keeps the shared field names', () => {
    const r = O.validateLocation({ name: 'HQ', address: { line1: '1 Main', city: 'Austin', state: 'tx', zip: '78701' }, lat: '30.27', lng: -97.74, timeZone: 'America/Chicago', isHeadquarters: true });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(Object.keys(r.value).sort(), ['active', 'address', 'city', 'county', 'isHeadquarters', 'lat', 'lng', 'name', 'radiusMeters', 'state', 'timeZone']);
    assert.equal(r.value.state, 'TX'); assert.equal(r.value.radiusMeters, 150); assert.equal(r.value.active, true);
});
test('location validation errors', () => {
    assert.ok(O.validateLocation({}).errors.length >= 2);
    assert.ok(O.validateLocation({ name: 'x', address: { line1: 'a', city: 'b', state: 'TX', zip: '78701' }, lat: 10 }).errors.some((e) => /together/.test(e)));
    assert.ok(O.validateLocation({ name: 'x', address: { line1: 'a', city: 'b', state: 'TX', zip: '78701' }, timeZone: 'Mars/Base' }).errors.some((e) => /time zone/.test(e)));
    assert.ok(O.validateLocation({ name: 'x', address: { line1: 'a', city: 'b', state: 'TX', zip: '78701' }, lat: 99, lng: 0 }).errors.some((e) => /lat/.test(e)));
});
test('department validation', () => {
    assert.equal(O.validateDepartment({ name: 'Ops', code: 'ops-1' }).value.code, 'OPS-1');
    assert.ok(O.validateDepartment({ name: '' }).errors.length);
    assert.ok(O.validateDepartment({ name: 'x', code: 'bad code!' }).errors.length);
});
const people = [
    { id: 'ceo', name: 'Ceo', managerId: null }, { id: 'a', name: 'A', managerId: 'ceo' }, { id: 'b', name: 'B', managerId: 'ceo' },
    { id: 'a1', name: 'A1', managerId: 'a' }, { id: 'a2', name: 'A2', managerId: 'a' }, { id: 'a11', name: 'A11', managerId: 'a1' }
];
test('manager cycles are detected', () => {
    const m = O.managerMap(people);
    assert.equal(O.wouldCreateCycle(m, 'a', 'a'), true);
    assert.equal(O.wouldCreateCycle(m, 'a', 'a11'), true);
    assert.equal(O.wouldCreateCycle(m, 'ceo', 'a2'), true);
    assert.equal(O.wouldCreateCycle(m, 'a2', 'b'), false);
    assert.equal(O.wouldCreateCycle(m, 'a', null), false);
});
test('direct reports, subtree and chain', () => {
    assert.deepEqual(O.directReports(people, 'a').map((p) => p.id), ['a1', 'a2']);
    const sub = O.subtree(people, 'ceo');
    assert.equal(sub.length, 5);
    assert.equal(sub.find((p) => p.id === 'a11').level, 3);
    assert.deepEqual(O.managerChain(people, 'a11').map((p) => p.id), ['a1', 'a', 'ceo']);
    assert.deepEqual(O.subtree(people, 'b'), []);
});
test('subtree and chain survive a loop in bad data', () => {
    const bad = [{ id: 'x', managerId: 'y' }, { id: 'y', managerId: 'x' }];
    assert.equal(O.subtree(bad, 'x').length, 1);
    assert.equal(O.managerChain(bad, 'x').length, 1);
    assert.equal(O.buildTree(bad).length, 1);
});
test('org chart tree nests', () => {
    const t = O.buildTree(people);
    assert.equal(t.length, 1);
    assert.equal(t[0].directReports, 2);
    assert.equal(t[0].children[0].children[0].children[0].id, 'a11');
});
test('csv parser and assign rows', () => {
    const rows = O.parseCsv('Employee ID,Manager,Location,Department\r\nE1,"Smith, Jo",HQ,Ops\nE2,none,,\n\n');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].manager, 'Smith, Jo');
    const n = O.normalizeAssignRow(rows[1]);
    assert.equal(n.person, 'E2'); assert.equal(n.manager, null); assert.equal(n.location, undefined);
});

// ---------- custom fields ----------
test('custom field definitions', () => {
    assert.deepEqual(CF.validateDefinition({ key: 'shirt', label: 'Shirt', type: 'select', options: ['S', 'M'] }).errors, []);
    assert.ok(CF.validateDefinition({ key: 'Bad Key', label: 'x', type: 'text' }).errors.length);
    assert.ok(CF.validateDefinition({ key: 'ok', label: 'x', type: 'select', options: ['S'] }).errors.length);
    assert.ok(CF.validateDefinition({ key: 'ok', label: 'x', type: 'text', visibility: 'everyone' }).errors.length);
});
test('custom field visibility and editing', () => {
    const d = (visibility) => ({ visibility });
    assert.equal(CF.canView(d('hr_only'), 'manager'), false);
    assert.equal(CF.canView(d('manager'), 'manager'), true);
    assert.equal(CF.canView(d('manager'), 'self'), false);
    assert.equal(CF.canView(d('employee_view'), 'self'), true);
    assert.equal(CF.canEdit(d('employee_view'), 'self'), false);
    assert.equal(CF.canEdit(d('employee_edit'), 'self'), true);
    assert.equal(CF.canEdit(d('employee_edit'), 'manager'), false);
    assert.equal(CF.canEdit(d('hr_only'), 'hr'), true);
});
test('custom field values by type', () => {
    const defs = [
        { key: 't', label: 'T', type: 'text', required: true, active: true, visibility: 'hr_only' },
        { key: 'n', label: 'N', type: 'number', active: true, visibility: 'hr_only' },
        { key: 'd', label: 'D', type: 'date', active: true, visibility: 'hr_only' },
        { key: 's', label: 'S', type: 'select', options: ['a', 'b'], active: true, visibility: 'hr_only' },
        { key: 'b', label: 'B', type: 'boolean', active: true, visibility: 'hr_only' }
    ];
    const ok = CF.validateValues(defs, { t: 'hi', n: '4.5', d: '2026-02-28', s: 'a', b: 'true' }, 'hr', { requireAll: true });
    assert.deepEqual(ok.errors, []); assert.deepEqual(ok.value, { t: 'hi', n: 4.5, d: '2026-02-28', s: 'a', b: true });
    const bad = CF.validateValues(defs, { n: 'x', d: '2026-02-30', s: 'z', b: 'maybe', nope: 1 }, 'hr', { requireAll: true });
    assert.equal(bad.errors.length, 6);
    assert.ok(CF.validateValues(defs, { t: 'x' }, 'self').errors[0].includes('cannot edit'));
    assert.equal(CF.maskSensitive('secret'), '••••');
});

// ---------- profile changes ----------
test('phone and direct edits', () => {
    assert.equal(PC.validatePhone('+1 512 555 0123').value, '(512) 555-0123');
    assert.ok(PC.validatePhone('123').error);
    assert.ok(PC.validatePhone('(012) 555-0123').error);
    const r = PC.validateDirectEdit({ preferredName: '  Jo  ', phone: '5125550123', maritalStatus: 'married' });
    assert.deepEqual(r.errors, []); assert.equal(r.value.preferredName, 'Jo');
    assert.ok(PC.validateDirectEdit({ maritalStatus: 'x' }).errors.length);
});
test('emergency contacts and primary', () => {
    assert.ok(PC.validateEmergencyContact({ name: 'a' }).errors.length >= 2);
    assert.deepEqual(PC.validateEmergencyContact({ name: 'Ann', relationship: 'Sister', phone: '5125550123' }).errors, []);
    const list = PC.normalizePrimary([{ id: '1', isPrimary: false }, { id: '2', isPrimary: true }, { id: '3', isPrimary: true }]);
    assert.deepEqual(list.map((c) => c.isPrimary), [false, true, false]);
    assert.equal(PC.normalizePrimary([{ id: '1' }])[0].isPrimary, true);
});
test('change requests and auto-approve settings', () => {
    assert.ok(PC.validateChange('legalName', { legalFirstName: 'A' }).errors.length);
    assert.deepEqual(PC.validateChange('homeAddress', { homeAddress: { line1: '1 St', city: 'Austin', state: 'TX', zip: '78701' } }).errors, []);
    assert.ok(PC.validateChange('salary', {}).errors.length);
    assert.ok(PC.validateSettings({ autoApprove: ['bankDetails'] }).errors.length);
    assert.deepEqual(PC.normalizeSettings({ autoApprove: ['bankDetails', 'homeAddress'] }).autoApprove, ['homeAddress']);
});

// ---------- comp history ----------
const recs = [
    { id: '1', effectiveDate: '2025-01-06', reason: 'hire', jobTitle: 'Clerk', payType: 'hourly', payRate: 20, payFrequency: 'biweekly', status: 'approved', createdAt: '1' },
    { id: '2', effectiveDate: '2025-07-01', reason: 'raise', payRate: 22, status: 'approved', createdAt: '2' },
    { id: '3', effectiveDate: '2026-01-05', reason: 'promotion', jobTitle: 'Lead', payType: 'salary', payRate: 60000, status: 'approved', createdAt: '3' },
    { id: '4', effectiveDate: '2026-06-01', reason: 'raise', payRate: 99000, status: 'pending_approval', createdAt: '4' }
];
test('comp record validation', () => {
    assert.deepEqual(CH.validateRecord({ effectiveDate: '2026-01-01', reason: 'raise', payRate: '25.555' }).errors, []);
    assert.ok(CH.validateRecord({ effectiveDate: '2026-02-30', reason: 'raise', payRate: 5 }).errors.length);
    assert.ok(CH.validateRecord({ effectiveDate: '2026-01-01', reason: 'hire', jobTitle: 'x' }).errors.some((e) => /payRate/.test(e)));
    assert.ok(CH.validateRecord({ effectiveDate: '2026-01-01', reason: 'raise' }).errors.length);
    assert.equal(CH.validateRecord({ effectiveDate: '2026-01-01', reason: 'transfer', managerId: null }).value.managerId, null);
});
test('state as of a date carries fields forward and ignores unapproved', () => {
    assert.equal(CH.stateAsOf(recs, '2025-01-05'), null);
    assert.deepEqual(CH.stateAsOf(recs, '2025-08-01'), { jobTitle: 'Clerk', payType: 'hourly', payRate: 22, payFrequency: 'biweekly', effectiveDate: '2025-07-01' });
    const now = CH.stateAsOf(recs, '2026-12-31');
    assert.equal(now.payRate, 60000); assert.equal(now.jobTitle, 'Lead'); assert.equal(now.payFrequency, 'biweekly');
});
test('percent change annualizes hourly pay', () => {
    assert.equal(CH.percentChange({ payType: 'hourly', payRate: 20 }, { payType: 'hourly', payRate: 22 }), 10);
    assert.equal(CH.percentChange({ payType: 'hourly', payRate: 20 }, { payType: 'salary', payRate: 62400 }), 50);
    assert.equal(CH.percentChange(null, { payRate: 5 }), null);
});
test('approval needed only above the threshold for pay changes', () => {
    const before = { payType: 'salary', payRate: 100000 };
    assert.equal(CH.needsApproval(before, { payRate: 105000 }, 10), false);
    assert.equal(CH.needsApproval(before, { payRate: 120000 }, 10), true);
    assert.equal(CH.needsApproval(before, { payRate: 80000 }, 10), true);
    assert.equal(CH.needsApproval(before, { jobTitle: 'x' }, 10), false);
    assert.equal(CH.needsApproval(before, { payRate: 110000 }, 10), false);
});
test('timeline marks future and pay changes; pay is strippable', () => {
    const t = CH.timeline(recs, '2026-03-01');
    assert.equal(t.find((r) => r.id === '4').future, true);
    assert.equal(t.find((r) => r.id === '2').payChangePercent, 10);
    const s = CH.stripPay(t[1]);
    assert.equal(s.payRate, undefined); assert.equal(s.payType, undefined); assert.equal(s.reason, 'raise');
    assert.deepEqual(CH.profilePatch({ payRate: 5, jobTitle: 'x', managerId: null }), { payRate: 5, jobTitle: 'x', managerId: null });
});

// ---------- direct deposit splits ----------
const acct = (over = {}) => ({ bankName: 'Bank', routingNumber: '021000021', accountNumber: '123456789', accountType: 'checking', allocation: { type: 'remainder' }, ...over });
test('valid split set', () => {
    const r = DD.validateSplits([acct({ allocation: { type: 'percent', value: 25 } }), acct({ accountNumber: '987654321', allocation: { type: 'amount', value: 100 } }), acct({ accountNumber: '555555555', accountType: 'savings' })]);
    assert.deepEqual(r.errors, []);
    assert.equal(r.value[2].accountLast4, '5555');
});
test('split rules', () => {
    const e = (list) => DD.validateSplits(list).errors.join('|');
    assert.match(e([acct({ allocation: { type: 'percent', value: 50 } })]), /exactly one account/);
    assert.match(e([acct(), acct({ accountNumber: '111111111' })]), /exactly one account/);
    assert.match(e([acct({ routingNumber: '123456789' })]), /Routing number is not valid/);
    assert.match(e([acct({ allocation: { type: 'percent', value: 60 } }), acct({ accountNumber: '2222', allocation: { type: 'percent', value: 40 } }), acct({ accountNumber: '3333' })]), /nothing is left/);
    assert.match(e([acct({ allocation: { type: 'percent', value: 0 } }), acct({ accountNumber: '3333' })]), /percent/);
    assert.match(e([acct({ allocation: { type: 'amount', value: -5 } }), acct({ accountNumber: '3333' })]), /fixed amount/);
    assert.match(e([acct(), acct({ allocation: { type: 'amount', value: 5 } })]), /repeats/);
    assert.match(e([]), /non-empty/);
    assert.match(e([acct({ accountNumber: '12' })]), /4 to 17/);
    assert.match(e(Array.from({ length: 6 }, (_, i) => acct({ accountNumber: `1000${i}` }))), /at most/);
});
test('stored account numbers can be kept by id', () => {
    const existing = new Map([['x1', { bankName: 'Bank', routingNumber: '021000021', accountType: 'checking', accountLast4: '6789' }]]);
    const r = DD.validateSplits([{ id: 'x1', allocation: { type: 'remainder' } }], existing);
    assert.deepEqual(r.errors, []); assert.equal(r.value[0].keepStoredNumber, true); assert.equal(r.value[0].accountLast4, '6789');
    assert.ok(DD.validateSplits([{ id: 'nope', allocation: { type: 'remainder' } }], existing).errors.length);
});
test('allocation of a net pay', () => {
    const accts = [{ allocation: { type: 'percent', value: 25 } }, { allocation: { type: 'amount', value: 100 } }, { allocation: { type: 'remainder' } }];
    const r = DD.allocate(1000, accts);
    assert.deepEqual(r.cents, [25000, 10000, 65000]);
    assert.equal(DD.allocate(50, accts).fixedShortfall, true);
    assert.deepEqual(DD.allocate(50, accts).cents, [0, 5000, 0].map((x, i) => (i === 0 ? 0 : x)));
    assert.equal(DD.allocate(333.33, [{ allocation: { type: 'percent', value: 33.33 } }, { allocation: { type: 'remainder' } }]).cents.reduce((a, b) => a + b), 33333);
    assert.equal(DD.maskAccount({ accountLast4: '1234', allocation: {} }).accountMasked, '••••1234');
});

// ---------- contractors ----------
const w9 = (over = {}) => ({ legalName: 'Jane Roe', taxClassification: 'individual', tinType: 'SSN', tin: '123-45-6789', address: { line1: '1 St', city: 'Austin', state: 'TX', zip: '78701' }, certified: true, signature: 'jane roe', ...over });
test('W-9 validation', () => {
    const r = CT.validateW9(w9());
    assert.deepEqual(r.errors, []); assert.equal(r.value.tinLast4, '6789'); assert.equal(JSON.stringify(r.value).includes('123456789'), false);
    assert.ok(CT.validateW9(w9({ signature: 'Someone Else' })).errors.some((e) => /match/.test(e)));
    assert.ok(CT.validateW9(w9({ certified: false })).errors.length);
    assert.ok(CT.validateW9(w9({ tin: '000-12-3456' })).errors.length);
    assert.deepEqual(CT.validateW9(w9({ tinType: 'EIN', tin: '12-3456789', taxClassification: 's_corp' })).errors, []);
    assert.equal(CT.validateW9(w9({ taxClassification: 'c_corp' })).value.likelyExemptFrom1099, true);
    assert.ok(CT.validateW9(w9({ taxClassification: 'sole' })).errors.length);
});
test('1099 payments and totals', () => {
    assert.deepEqual(CT.validatePayment({ date: '2026-01-10', amount: '250.10', method: 'ach' }, '2026-06-01').errors, []);
    assert.ok(CT.validatePayment({ date: '2027-01-10', amount: 5, method: 'ach' }, '2026-06-01').errors.length);
    assert.ok(CT.validatePayment({ date: '2026-01-10', amount: 5.123, method: 'ach' }).errors.length);
    const contractors = [{ id: 'c1', name: 'A', w9Status: 'received', tinLast4: '1111' }, { id: 'c2', name: 'B', w9Status: 'missing' }, { id: 'c3', name: 'C', w9Status: 'received', backupWithholding: true }];
    const pays = [
        { contractorId: 'c1', date: '2026-02-01', amount: 400, method: 'ach', category: 'nonemployee_compensation' },
        { contractorId: 'c1', date: '2026-03-01', amount: 200.5, method: 'check', category: 'nonemployee_compensation' },
        { contractorId: 'c1', date: '2025-12-31', amount: 9999, method: 'ach', category: 'nonemployee_compensation' },
        { contractorId: 'c1', date: '2026-04-01', amount: 5000, method: 'card', category: 'nonemployee_compensation' },
        { contractorId: 'c2', date: '2026-02-01', amount: 599.99, method: 'ach', category: 'nonemployee_compensation' },
        { contractorId: 'c3', date: '2026-02-01', amount: 100, method: 'ach', category: 'reimbursement' }
    ];
    const t = CT.annualTotals(contractors, pays, 2026);
    assert.equal(t[0].necTotal, 600.5); assert.equal(t[0].over1099Threshold, true); assert.equal(t[0].totalPaid, 5600.5);
    assert.equal(t[1].over1099Threshold, false); assert.equal(t[1].backupWithholdingSuggested, true); // paid, no W-9 on file
    assert.equal(t[2].necTotal, 0);
    assert.equal(CT.annualTotals(contractors, pays, 2026, { necThreshold: 500 })[1].over1099Threshold, true);
    assert.equal(CT.annualTotals(contractors, pays, 2026, { necThreshold: 500 })[1].backupWithholdingSuggested, true);
    assert.equal(CT.annualTotals(contractors, pays, 2025)[0].necTotal, 9999);
});
test('summary csv hides TIN unless asked and defuses formulas', () => {
    const rows = [{ name: '=cmd()', legalName: 'A, B', tin: '123456789', tinLast4: '6789', paymentCount: 1, totalPaid: 5, necTotal: 5, over1099Threshold: false, backupWithholding: false, w9Status: 'received', address: { line1: '1 St', city: 'X' } }];
    const masked = CT.summaryCsv(rows);
    assert.ok(masked.includes('***6789')); assert.ok(!masked.includes('123456789')); assert.ok(masked.includes("'=cmd()")); assert.ok(masked.includes('"A, B"'));
    assert.ok(CT.summaryCsv(rows, { fullTin: true }).includes('123456789'));
    assert.deepEqual(CT.validateSettings({ necThreshold: 2000 }).value, { necThreshold: 2000 });
    assert.ok(CT.validateSettings({ necThreshold: -1 }).errors.length);
});

// ---------- holidays ----------
test('named federal holidays match the observed set from us-forms', () => {
    for (const y of [2024, 2025, 2026, 2027, 2028, 2032]) {
        const set = new Set(H.namedFederalHolidays(y).map((h) => h.date).filter((d) => d.startsWith(String(y))));
        const ref = [...federalHolidays(y)];
        assert.deepEqual([...set].sort(), ref.filter((d) => d.startsWith(String(y))).sort(), `year ${y}`);
    }
});
test('calendar for a year includes a Dec 31 observance of next New Year', () => {
    const cal = H.buildCalendar(2027, []); // 1 Jan 2028 is a Saturday, observed Friday 31 Dec 2027
    assert.ok(cal.some((h) => h.date === '2027-12-31' && h.federalKey === 'new_years_day'));
    assert.equal(H.buildCalendar(2028, []).filter((h) => h.federalKey === 'new_years_day').length, 0);
});
test('observed shifts and custom days', () => {
    assert.equal(H.observed('2026-07-04'), '2026-07-03'); // Saturday
    assert.equal(H.observed('2027-07-04'), '2027-07-05'); // Sunday
    assert.equal(H.observed('2026-07-04', 'none'), '2026-07-04');
    const cal = H.buildCalendar(2026, [{ kind: 'custom', date: '2026-11-27', name: 'Day after Thanksgiving', paid: true, observedRule: 'none' }, { kind: 'custom', date: '2026-08-01', name: 'Founders Day', observedRule: 'nearest_weekday', locationIds: ['L1'] }]);
    assert.ok(cal.some((h) => h.date === '2026-11-27'));
    assert.equal(H.holidayOn(cal, '2026-07-03').name, 'Independence Day');
    assert.equal(H.holidayOn(cal, '2026-07-04'), null);
    assert.equal(H.holidayOn(cal, '2026-07-31', 'L1').name, 'Founders Day'); // Aug 1 2026 is Saturday -> Friday
    assert.equal(H.holidayOn(cal, '2026-07-31', 'L2'), null);
});
test('federal overrides switch off or unpay', () => {
    const cal = H.buildCalendar(2026, [{ kind: 'federal', federalKey: 'columbus_day', year: 2026, active: false, paid: true }, { kind: 'federal', federalKey: 'juneteenth', year: 2026, paid: false }]);
    assert.equal(H.holidayOn(cal, '2026-10-12'), null);
    assert.equal(cal.find((h) => h.federalKey === 'juneteenth').paid, false);
    assert.ok(H.holidayDateSet(cal).has('2026-12-25'));
    assert.ok(H.validateHoliday({ kind: 'custom', date: '2026-13-01', name: 'x' }).errors.length);
    assert.ok(H.validateHoliday({ kind: 'federal', federalKey: 'nope', year: 2026 }).errors.length);
    assert.deepEqual(H.validateHoliday({ kind: 'federal', federalKey: 'labor_day', year: 2026, paid: false }).errors, []);
});

test('same ignores key order', () => {
    assert.equal(PC.same({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }), true);
    assert.equal(PC.same({ a: 1 }, { a: 2 }), false);
    assert.equal(PC.same(null, null), true);
});

test('two accounts that share the last 4 digits are allowed, true repeats are not', () => {
    const existing = new Map([['x1', { bankName: 'Bank', routingNumber: '021000021', accountType: 'checking', accountLast4: '3333' }]]);
    const ok = DD.validateSplits([{ id: 'x1', allocation: { type: 'remainder' } }, acct({ accountNumber: '555544443333', allocation: { type: 'percent', value: 10 } })], existing);
    assert.deepEqual(ok.errors, []);
    assert.ok(DD.validateSplits([{ id: 'x1', allocation: { type: 'remainder' } }, { id: 'x1', allocation: { type: 'percent', value: 10 } }], existing).errors.some((e) => /repeats/.test(e)));
});
