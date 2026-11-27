// "Read the employee handbook" and "Give HR an emergency contact" complete from real data, not from the person
// ticking them (staging 2026-11-21: both showed Done though the person was never shown a handbook or asked for a contact).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rules = require('../services/checklist-rules.js');
const store = require('../services/us-checklist-service.js');

const TODAY = '2026-11-22';
const oldList = [ // stored before these tasks were data-driven: auto is null
    { id: 'handbook', title: 'Read the employee handbook', assignee: 'employee', required: true, auto: null, dueDate: '2026-11-24', status: 'done', doneBy: 'jay' },
    { id: 'emergency_contact', title: 'Give HR an emergency contact', assignee: 'employee', required: false, auto: null, dueDate: '2026-11-24', status: 'done', doneBy: 'jay' }
];

test('a person ticking their own handbook or contact task does not count', () => {
    const ev = rules.evaluate(oldList, store.factsFor({}), TODAY, 'jay');
    assert.deepEqual(ev.tasks.map((t) => t.done), [false, false]);
    assert.deepEqual(ev.tasks.map((t) => t.link), ['my-policies.html', 'my-profile.html']);
});

test('they complete from data: acknowledged policies and a saved contact', () => {
    const facts = store.factsFor({ usProfile: { emergencyContacts: [{ name: 'A', phone: '1' }] } }, { handbook: true });
    const ev = rules.evaluate(oldList.map((t) => ({ ...t, status: 'open', doneBy: null })), facts, TODAY, 'jay');
    assert.deepEqual(ev.tasks.map((t) => t.done), [true, true]);
});

test('HR ticking them still counts as an override', () => {
    const ev = rules.evaluate(oldList.map((t) => ({ ...t, doneBy: 'hr-person' })), store.factsFor({}), TODAY, 'jay');
    assert.deepEqual(ev.tasks.map((t) => t.done), [true, true]);
});

test('the person cannot tick these two themselves, even as an owner; custom tasks are unchanged', () => {
    assert.equal(rules.canComplete(oldList[0], 'employee', true), false);
    assert.equal(rules.canComplete(oldList[1], 'super_admin', true), false);
    assert.equal(rules.canComplete(oldList[0], 'hr_admin', false), true);
    assert.equal(rules.canComplete({ id: 'handbook', custom: true, assignee: 'employee' }, 'employee', true), true);
});

test('new lists store the auto source and the link', () => {
    const t = rules.buildChecklist('onboarding', '2026-11-21', {}).find((x) => x.id === 'handbook');
    assert.equal(t.auto, 'handbook');
    assert.equal(t.link, 'my-policies.html');
});
