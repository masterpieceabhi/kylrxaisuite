import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../services/asset-rules.js');

test('an item needs a name and a known category; cost and dates are checked', () => {
    assert.equal(A.validateAsset({}).errors.length, 2);
    assert.equal(A.validateAsset({ name: 'Laptop 12', category: 'Spaceship' }).errors.length, 1);
    assert.equal(A.validateAsset({ name: 'Laptop 12', category: 'Laptop or computer', cost: -5 }).errors.length, 1);
    assert.equal(A.validateAsset({ name: 'Laptop 12', category: 'Laptop or computer', purchaseDate: '2026-02-31' }).errors.length, 1);
    assert.equal(A.validateAsset({ name: 'Laptop 12', category: 'Laptop or computer', condition: 'shiny' }).errors.length, 1);
    const ok = A.validateAsset({ name: '  Dell <b>Latitude</b>  ', category: 'Laptop or computer', tag: ' KX-0012 ', serial: 'SN 99', cost: '899.999', purchaseDate: '2026-01-15', condition: 'new', notes: 'Charger included' });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value, { name: 'Dell bLatitude/b', category: 'Laptop or computer', tag: 'KX-0012', serial: 'SN 99', condition: 'new', purchaseDate: '2026-01-15', cost: 900, notes: 'Charger included' });
    assert.deepEqual(A.validateAsset({ cost: '' }, { partial: true }).value, { cost: null });
    assert.deepEqual(A.validateAsset({}, { partial: true }).errors, ['Nothing to change']);
});

test('a hand-over needs a person; a due-back date cannot be in the past', () => {
    assert.deepEqual(A.validateAssignment({}, '2026-11-11').errors, ['Choose who gets the item']);
    assert.equal(A.validateAssignment({ userId: 'u1', dueBack: '2026-11-10' }, '2026-11-11').errors.length, 1);
    assert.equal(A.validateAssignment({ userId: 'u1', dueBack: 'soon' }, '2026-11-11').errors.length, 1);
    assert.deepEqual(A.validateAssignment({ userId: 'u1', dueBack: '2026-11-11', condition: 'good', note: ' With  charger ' }, '2026-11-11').value, { userId: 'u1', dueBack: '2026-11-11', condition: 'good', note: 'With charger' });
    assert.equal(A.validateAssignment({ userId: 'u1' }, '2026-11-11').value.dueBack, null);
});

test('an item moves between states only in sensible ways', () => {
    const is = (status, extra = {}) => ({ status, ...extra });
    assert.equal(A.changeError(is('available'), 'assign'), null);
    assert.match(A.changeError(is('assigned'), 'assign'), /already with someone/);
    assert.match(A.changeError(is('lost'), 'assign'), /marked lost/);
    assert.equal(A.changeError(is('assigned'), 'return'), null);
    assert.match(A.changeError(is('available'), 'return'), /not with anyone/);
    assert.match(A.changeError(is('assigned'), 'repair'), /Take the item back/);
    assert.equal(A.changeError(is('assigned'), 'lost'), null);
    assert.match(A.changeError(is('assigned'), 'retired'), /Take the item back/);
    assert.equal(A.changeError(is('lost'), 'available'), null);
    assert.match(A.changeError(is('assigned'), 'available'), /take back/);
    assert.match(A.changeError(is('available'), 'available'), /already available/);
    assert.match(A.changeError(is('available'), 'explode'), /Unknown action/);
});

test('an item that was ever given out cannot be deleted', () => {
    assert.equal(A.changeError({ status: 'available', history: [{ type: 'created' }] }, 'delete'), null);
    assert.match(A.changeError({ status: 'available', history: [{ type: 'created' }, { type: 'assigned' }, { type: 'returned' }] }, 'delete'), /cannot be deleted/);
});

test('the holder confirms once, and can report a problem only while holding the item', () => {
    assert.equal(A.changeError({ status: 'assigned' }, 'acknowledge'), null);
    assert.match(A.changeError({ status: 'assigned', acknowledgedAt: '2026-11-11T10:00:00Z' }, 'acknowledge'), /already confirmed/);
    assert.match(A.changeError({ status: 'available' }, 'acknowledge'), /not with you/);
    assert.equal(A.changeError({ status: 'assigned' }, 'problem'), null);
    assert.match(A.changeError({ status: 'repair' }, 'problem'), /not with you/);
});

test('history keeps the newest lines and drops empty fields', () => {
    assert.deepEqual(A.historyEntry('returned', { at: 't', by: 'HR', condition: 'good', note: '' }), { type: 'returned', at: 't', by: 'HR', condition: 'good' });
    const long = { history: Array.from({ length: A.HISTORY_MAX }, (_, i) => ({ type: 'x', at: String(i) })) };
    const next = A.addHistory(long, { type: 'assigned', at: 'new' });
    assert.equal(next.length, A.HISTORY_MAX);
    assert.equal(next[next.length - 1].at, 'new');
    assert.equal(next[0].at, '1');
});

test('the summary counts states, late returns, unconfirmed items and value with people', () => {
    const assets = [
        { status: 'available', cost: 100 },
        { status: 'assigned', cost: 899.5, dueBack: '2026-11-01', acknowledgedAt: 't' },
        { status: 'assigned', cost: 50.25, dueBack: '2026-12-01', problem: { at: 't', text: 'Cracked' } },
        { status: 'assigned' },
        { status: 'repair', cost: 10 }, { status: 'lost' }, { status: 'retired' }
    ];
    assert.deepEqual(A.summary(assets, '2026-11-11'), { total: 7, available: 1, assigned: 3, repair: 1, lost: 1, retired: 1, overdue: 1, notConfirmed: 2, problems: 1, valueWithPeople: 949.75 });
    assert.equal(A.isOverdue({ status: 'assigned', dueBack: '2026-11-11' }, '2026-11-11'), false);
    assert.equal(A.isOverdue({ status: 'available', dueBack: '2026-11-01' }, '2026-11-11'), false);
});

test('items still with people who left are listed', () => {
    const people = [{ id: 'u1', name: 'Ana', active: true }, { id: 'u2', name: 'Ben', active: false }];
    const assets = [
        { id: 'a1', name: 'Laptop', category: 'Laptop or computer', status: 'assigned', assignedTo: 'u1' },
        { id: 'a2', name: 'Keys', category: 'Keys', status: 'assigned', assignedTo: 'u2', assignedToName: 'Ben R', cost: 15 },
        { id: 'a3', name: 'Badge', category: 'Badge or access card', status: 'assigned', assignedTo: 'gone' },
        { id: 'a4', name: 'Phone', category: 'Phone', status: 'available', assignedTo: 'u2' }
    ];
    const out = A.unreturned(assets, people);
    assert.deepEqual(out.map((a) => a.id), ['a2', 'a3']);
    assert.equal(out[0].assignedToName, 'Ben R');
    assert.equal(out[1].assignedToName, null);
});

test('the holder never sees cost, internal notes or history', () => {
    const v = A.holderView({ id: 'a1', name: 'Laptop', category: 'Laptop or computer', tag: 'KX-1', status: 'assigned', cost: 900, notes: 'Bought used', history: [{ type: 'assigned', name: 'Someone else' }], assignedAt: 't', dueBack: '2026-11-01', problem: { at: 't2', text: 'Cracked', by: 'u1' } }, '2026-11-11');
    assert.equal(v.cost, undefined);
    assert.equal(v.notes, undefined);
    assert.equal(v.history, undefined);
    assert.equal(v.overdue, true);
    assert.deepEqual(v.problem, { at: 't2', text: 'Cracked' });
});
