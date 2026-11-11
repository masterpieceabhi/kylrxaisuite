import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../services/checklist-rules.js');
const v = require('../services/us-validation.js');

test('routing number checksum accepts real-looking numbers and rejects typos', () => {
    assert.equal(v.validateRoutingNumber('021000021').valid, true); // a published bank routing number
    assert.equal(v.validateRoutingNumber('011401533').valid, true);
    assert.equal(v.validateRoutingNumber('021000022').valid, false);
    assert.equal(v.validateRoutingNumber('12345').valid, false);
});

test('direct deposit: needs bank, valid routing, account digits, type and consent', () => {
    const ok = { bankName: 'Chase', routingNumber: '021000021', accountNumber: '000123456789', accountType: 'checking', authorization: true };
    const r = v.validateDirectDeposit(ok);
    assert.deepEqual(r.errors, []); assert.equal(r.value.accountLast4, '6789');
    assert.ok(v.validateDirectDeposit({ ...ok, accountNumber: '12' }).errors.some((e) => /Account number/.test(e)));
    assert.ok(v.validateDirectDeposit({ ...ok, accountType: 'credit' }).errors.some((e) => /accountType/.test(e)));
    assert.ok(v.validateDirectDeposit({ ...ok, authorization: false }).errors.some((e) => /authorization/.test(e)));
    assert.ok(v.validateDirectDeposit({}).errors.length >= 4);
});

test('onboarding tasks get due dates from the start date', () => {
    const tasks = C.buildChecklist('onboarding', '2026-11-09'); // Monday
    const by = Object.fromEntries(tasks.map((t) => [t.id, t]));
    assert.equal(by.w4.dueDate, '2026-11-09');
    assert.equal(by.direct_deposit.dueDate, '2026-11-14');
    assert.equal(by.i9_section2.dueDate, '2026-11-12'); // 3 business days
    assert.equal(by.new_hire_report.dueDate, '2026-11-29');
    assert.ok(tasks.every((t) => t.status === 'open' && ['employee', 'hr', 'manager'].includes(t.assignee)));
});

test('offboarding tasks count back and forward from the last day', () => {
    const by = Object.fromEntries(C.buildChecklist('offboarding', '2026-12-18').map((t) => [t.id, t]));
    assert.equal(by.handover.dueDate, '2026-12-15');
    assert.equal(by.final_pay.dueDate, '2026-12-18');
    assert.equal(by.benefits_notice.dueDate, '2026-12-23');
});

test('rehire checklist exists and rejects unknown kinds and bad dates', () => {
    assert.ok(C.buildChecklist('rehire', '2026-11-09').some((t) => t.id === 'i9_review'));
    assert.throws(() => C.buildChecklist('vacation', '2026-11-09'));
    assert.throws(() => C.buildChecklist('onboarding', 'soon'));
});

test('evaluate: data completes auto tasks, overdue and due-soon are flagged, progress counts required only', () => {
    const tasks = C.buildChecklist('onboarding', '2026-11-02');
    const ev = C.evaluate(tasks, { w4: true, i9_section1: true }, '2026-11-04');
    const by = Object.fromEntries(ev.tasks.map((t) => [t.id, t]));
    assert.equal(by.w4.done, true); assert.equal(by.w4.doneByData, true);
    assert.equal(by.handbook.done, false); assert.equal(by.handbook.dueSoon, true); // due 11-05
    assert.equal(by.manager_told.overdue, true); // due 11-02
    assert.equal(by.equipment.overdue, true); assert.equal(by.equipment.required, false);
    assert.ok(ev.summary.percent < 100 && ev.summary.overdue >= 2);
    const manual = tasks.map((t) => ({ ...t, status: 'done' }));
    assert.equal(C.evaluate(manual, {}, '2026-11-04').summary.complete, true);
    const skipped = tasks.map((t) => ({ ...t, status: t.required ? 'done' : 'skipped' }));
    assert.equal(C.evaluate(skipped, {}, '2026-11-04').summary.percent, 100);
});

test('custom tasks are validated and marked custom', () => {
    const ok = C.validateCustomTask({ title: 'Order name tag', assignee: 'hr', dueDate: '2026-11-20' }, '2026-11-09');
    assert.deepEqual(ok.errors, []); assert.equal(ok.value.custom, true); assert.equal(ok.value.dueDate, '2026-11-20');
    assert.ok(C.validateCustomTask({ title: '', assignee: 'boss' }, '2026-11-09').errors.length >= 2);
    assert.equal(C.validateCustomTask({ title: 'x', assignee: 'hr' }, '2026-11-09').value.dueDate, '2026-11-09');
});

test('who can tick a task', () => {
    const emp = { assignee: 'employee' }; const hr = { assignee: 'hr' }; const mgr = { assignee: 'manager' };
    assert.equal(C.canComplete(emp, 'employee', true), true);
    assert.equal(C.canComplete(emp, 'employee', false), false);
    assert.equal(C.canComplete(hr, 'employee', true), false);
    assert.equal(C.canComplete(hr, 'hr_admin', false), true);
    assert.equal(C.canComplete(mgr, 'manager', false), true);
    assert.equal(C.canComplete(mgr, 'employee', false), false);
    assert.equal(C.canComplete(emp, 'super_admin', false), true);
});
