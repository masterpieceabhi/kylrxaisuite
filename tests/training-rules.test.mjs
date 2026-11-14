import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../services/training-rules.js');

const TODAY = '2026-11-12';
const training = (over = {}) => ({ id: 't1', name: 'Safe food handling', audience: { type: 'everyone', values: [] }, repeatMonths: null, dueWithinDays: 30, link: null, active: true, createdAt: '2026-01-01T10:00:00.000Z', ...over });
const person = (over = {}) => ({ id: 'u1', name: 'Ann Alpha', employeeId: 'E1', role: 'employee', jobTitle: 'Cook', departmentId: 'dep_kitchen', department: 'Kitchen', workLocationId: 'loc_main', startDate: '2026-03-01', active: true, ...over });
const done = (on, over = {}) => ({ trainingId: 't1', userId: 'u1', completedOn: on, status: 'confirmed', ...over });

test('a training needs a name; everything else has a sensible default', () => {
    assert.equal(T.validateTraining({}).errors.length, 1);
    const { errors, value } = T.validateTraining({ name: 'Safe food handling' });
    assert.deepEqual(errors, []);
    assert.deepEqual(value, { name: 'Safe food handling', audience: { type: 'everyone', values: [] }, repeatMonths: null, dueWithinDays: 30, link: null });
});

test('who must take it: a group needs at least one choice, and unknown kinds are refused', () => {
    assert.equal(T.validateTraining({ name: 'Ladders', audience: { type: 'department', values: [] } }).errors.length, 1);
    assert.equal(T.validateTraining({ name: 'Ladders', audience: { type: 'shoe size', values: ['9'] } }).errors.length, 1);
    const v = T.validateTraining({ name: 'Ladders', audience: { type: 'department', values: ['dep_a', 'dep_a', ' dep_b '] } }).value;
    assert.deepEqual(v.audience, { type: 'department', values: ['dep_a', 'dep_b'] });
});

test('repeat is whole months or once; days to finish is 0 to 365', () => {
    assert.equal(T.validateTraining({ name: 'Ladders', repeatMonths: 12 }).value.repeatMonths, 12);
    assert.equal(T.validateTraining({ name: 'Ladders', repeatMonths: '' }).value.repeatMonths, null);
    assert.equal(T.validateTraining({ name: 'Ladders', repeatMonths: 0 }).value.repeatMonths, null);
    assert.equal(T.validateTraining({ name: 'Ladders', repeatMonths: 1.5 }).errors.length, 1);
    assert.equal(T.validateTraining({ name: 'Ladders', repeatMonths: 121 }).errors.length, 1);
    assert.equal(T.validateTraining({ name: 'Ladders', dueWithinDays: -1 }).errors.length, 1);
    assert.equal(T.validateTraining({ name: 'Ladders', dueWithinDays: 0 }).value.dueWithinDays, 0);
});

test('only web links are kept', () => {
    assert.equal(T.validateTraining({ name: 'Ladders', link: 'https://example.com/course' }).value.link, 'https://example.com/course');
    assert.equal(T.validateTraining({ name: 'Ladders', link: 'javascript:alert(1)' }).errors.length, 1);
    assert.equal(T.validateTraining({ name: 'Ladders', link: 'not a link' }).errors.length, 1);
    assert.equal(T.validateTraining({ name: 'Ladders', link: '' }).value.link, null);
});

test('a partial change only carries what was sent, and an empty change is refused', () => {
    assert.deepEqual(T.validateTraining({ repeatMonths: 6 }, { partial: true }).value, { repeatMonths: 6 });
    assert.deepEqual(T.validateTraining({ active: false }, { partial: true }).value, { active: false });
    assert.equal(T.validateTraining({}, { partial: true }).errors[0], 'Nothing to change');
});

test('angle brackets are stripped from names and notes', () => {
    assert.equal(T.validateTraining({ name: '<b>Ladders</b>' }).value.name, 'bLadders/b');
    assert.equal(T.validateCompletion({ userId: 'u1', note: '<script>x</script>' }, TODAY).value.note, 'scriptx/script');
});

test('a completion needs a person and a real date that is not in the future', () => {
    assert.equal(T.validateCompletion({}, TODAY).errors.length, 1);
    assert.equal(T.validateCompletion({ userId: 'u1', completedOn: '2026-13-40' }, TODAY).errors.length, 1);
    assert.equal(T.validateCompletion({ userId: 'u1', completedOn: '2026-11-13' }, TODAY).errors.length, 1);
    assert.deepEqual(T.validateCompletion({ userId: 'u1' }, TODAY).value, { userId: 'u1', completedOn: TODAY, note: '' });
    assert.deepEqual(T.validateCompletion({ completedOn: '2026-11-01', note: 'Card 123' }, TODAY, { byEmployee: true }).value, { completedOn: '2026-11-01', note: 'Card 123' });
});

test('who a training applies to', () => {
    assert.equal(T.appliesTo(training(), person()), true);
    assert.equal(T.appliesTo(training({ active: false }), person()), false);
    assert.equal(T.appliesTo(training(), person({ active: false })), false);
    assert.equal(T.appliesTo(training({ audience: { type: 'department', values: ['dep_kitchen'] } }), person()), true);
    assert.equal(T.appliesTo(training({ audience: { type: 'department', values: ['kitchen'] } }), person()), true, 'the department name works too');
    assert.equal(T.appliesTo(training({ audience: { type: 'department', values: ['dep_bar'] } }), person()), false);
    assert.equal(T.appliesTo(training({ audience: { type: 'location', values: ['loc_main'] } }), person()), true);
    assert.equal(T.appliesTo(training({ audience: { type: 'location', values: ['loc_main'] } }), person({ workLocationId: null })), false);
    assert.equal(T.appliesTo(training({ audience: { type: 'role', values: ['manager'] } }), person()), false);
    assert.equal(T.appliesTo(training({ audience: { type: 'role', values: ['manager'] } }), person({ role: 'manager' })), true);
    assert.equal(T.appliesTo(training({ audience: { type: 'job_title', values: ['COOK'] } }), person()), true);
    assert.equal(T.appliesTo(training({ audience: { type: 'mystery', values: ['x'] } }), person()), false);
});

test('first due date counts from the later of the first day and the day the training was added', () => {
    assert.equal(T.firstDueDate(training(), person()), '2026-03-31');
    assert.equal(T.firstDueDate(training({ createdAt: '2026-06-01T09:00:00.000Z' }), person()), '2026-07-01');
    assert.equal(T.firstDueDate(training({ dueWithinDays: 0 }), person()), '2026-03-01');
    assert.equal(T.firstDueDate(training({ createdAt: null }), person({ startDate: null })), null);
});

test('never done: due until the due date, overdue after it', () => {
    const fresh = person({ startDate: '2026-11-01' });
    assert.deepEqual(T.personStatus(training(), fresh, [], TODAY), { status: 'due', lastCompletedOn: null, dueDate: '2026-12-01', nextDueDate: null, waitingForHr: false, reportedOn: null, daysLate: 0 });
    const late = T.personStatus(training(), person(), [], TODAY);
    assert.equal(late.status, 'overdue'); assert.equal(late.dueDate, '2026-03-31'); assert.equal(late.daysLate, 226);
    assert.equal(T.personStatus(training(), person({ startDate: '2026-10-13' }), [], TODAY).status, 'due', 'due on the day itself is not late yet');
});

test('a one-time training is done once a confirmed completion exists', () => {
    const s = T.personStatus(training(), person(), [done('2026-03-10')], TODAY);
    assert.equal(s.status, 'done'); assert.equal(s.lastCompletedOn, '2026-03-10'); assert.equal(s.nextDueDate, null);
});

test('a repeating training: done, then due within 30 days of the next date, then overdue', () => {
    const yearly = training({ repeatMonths: 12 });
    assert.equal(T.personStatus(yearly, person(), [done('2026-06-01')], TODAY).status, 'done');
    const soon = T.personStatus(yearly, person(), [done('2025-12-01')], TODAY);
    assert.equal(soon.status, 'due'); assert.equal(soon.nextDueDate, '2026-12-01');
    const late = T.personStatus(yearly, person(), [done('2025-11-01')], TODAY);
    assert.equal(late.status, 'overdue'); assert.equal(late.daysLate, 11);
    assert.equal(T.personStatus(yearly, person(), [done('2025-11-12')], TODAY).status, 'due', 'the due day itself is not late');
    assert.equal(T.personStatus(yearly, person(), [done('2024-01-01'), done('2026-06-01')], TODAY).lastCompletedOn, '2026-06-01', 'the newest completion counts');
});

test('adding months keeps the day, or uses the last day of a shorter month', () => {
    assert.equal(T.addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(T.addMonths('2024-01-31', 1), '2024-02-29');
    assert.equal(T.addMonths('2026-11-15', 3), '2027-02-15');
    assert.equal(T.addMonths('2026-03-31', 12), '2027-03-31');
});

test('only confirmed completions count; a reported one shows as waiting for HR', () => {
    const s = T.personStatus(training(), person(), [done('2026-11-10', { status: 'reported' })], TODAY);
    assert.equal(s.status, 'overdue'); assert.equal(s.waitingForHr, true); assert.equal(s.reportedOn, '2026-11-10');
    assert.equal(T.personStatus(training(), person(), [done('2026-11-10', { status: 'rejected' })], TODAY).waitingForHr, false);
    assert.equal(T.personStatus(training(), person(), [done('2026-11-10', { status: 'removed' })], TODAY).status, 'overdue');
    const after = T.personStatus(training({ repeatMonths: 12 }), person(), [done('2026-11-11'), done('2026-11-01', { status: 'reported' })], TODAY);
    assert.equal(after.waitingForHr, false, 'an older report is not waiting once a newer completion is confirmed');
});

test('the report has one row per person per training that applies, worst first', () => {
    const trainings = [training(), training({ id: 't2', name: 'Manager basics', audience: { type: 'role', values: ['manager'] } }), training({ id: 't3', name: 'Old', active: false })];
    const people = [person(), person({ id: 'u2', name: 'Bob Beta', employeeId: 'E2', role: 'manager', startDate: '2026-11-01' }), person({ id: 'u3', name: 'Cy Gone', active: false })];
    const rows = T.reportRows(trainings, people, [done('2026-03-10')], TODAY);
    assert.deepEqual(rows.map((r) => [r.training, r.name, r.status]), [['Safe food handling', 'Bob Beta', 'due'], ['Manager basics', 'Bob Beta', 'due'], ['Safe food handling', 'Ann Alpha', 'done']]);
    assert.deepEqual(T.summarize(rows), { total: 3, overdue: 0, due: 2, done: 1, waitingForHr: 0 });
    assert.equal(rows[0].repeats, 'once');
    const late = T.reportRows(trainings, people, [], TODAY);
    assert.equal(late[0].status, 'overdue'); assert.equal(late[0].name, 'Ann Alpha');
});

test('a completion of another training or another person is not counted', () => {
    const rows = T.reportRows([training()], [person()], [done('2026-03-10', { trainingId: 'other' }), done('2026-03-10', { userId: 'u9' })], TODAY);
    assert.equal(rows[0].status, 'overdue');
});

test('for the compliance report: overdue and due training names per person, nothing for people who are done', () => {
    const rows = T.reportRows([training(), training({ id: 't2', name: 'Ladders', createdAt: '2026-11-01T00:00:00.000Z' })], [person(), person({ id: 'u2', name: 'Bob' })], [done('2026-03-10', { userId: 'u2' }), done('2026-11-05', { userId: 'u2', trainingId: 't2' })], TODAY);
    const m = T.byPerson(rows);
    assert.deepEqual(m.get('u1'), { overdue: ['Safe food handling'], due: ['Ladders'] });
    assert.equal(m.has('u2'), false);
});

test('an employee can report a training that applies and is not done, once', () => {
    assert.equal(T.reportError(training(), person(), [], TODAY), null);
    assert.match(T.reportError(training({ audience: { type: 'role', values: ['manager'] } }), person(), [], TODAY), /not on your list/);
    assert.match(T.reportError(training(), person(), [done('2026-11-10', { status: 'reported' })], TODAY), /already told HR/);
    assert.match(T.reportError(training(), person(), [done('2026-03-10')], TODAY), /already recorded as done/);
    assert.equal(T.reportError(training(), person(), [done('2026-11-10', { status: 'rejected' })], TODAY), null, 'after HR says no, the person can report again');
    assert.equal(T.reportError(training({ repeatMonths: 12 }), person(), [done('2025-12-01')], TODAY), null, 'a repeat that is coming due can be reported');
});

test('CSV has a header, plain status words and is safe to open in a spreadsheet', () => {
    const rows = T.reportRows([training({ name: '=SUM(A1), "quoted"' })], [person({ name: 'Ann, Alpha' })], [], TODAY);
    const lines = T.toCsv(rows).split('\r\n');
    assert.equal(lines[0], 'Employee ID,Name,Department,Training,Repeats,Status,Last completed,Due,Days late,Waiting for HR to confirm');
    assert.equal(lines[1], 'E1,"Ann, Alpha",Kitchen,"\'=SUM(A1), ""quoted""",once,Overdue,,2026-03-31,226,');
    assert.equal(lines[2], '');
});

test('the paperwork report shows an overdue training on a current employee, and is unchanged without training data', () => {
    const R = require('../services/us-reports.js');
    const asOf = TODAY;
    const full = (id, name) => R.normalizePerson(id, { employeeId: `E${id}`, name, usForms: { w4: { current: {} }, i9: { section1: {}, section2: {} }, directDeposit: {} }, usProfile: { startDate: '2025-02-01', classification: 'W2', workState: 'TX', payRate: 20, taxpayerIdLast4: '1111' } });
    const gone = R.normalizePerson('9', { employeeId: 'E9', name: 'Gone', usProfile: { startDate: '2020-01-01', termination: { lastDay: '2026-02-01', type: 'resignation' } } });
    const people = [full('1', 'Ann'), full('2', 'Bob'), gone];
    assert.equal(R.complianceReport(people, asOf).peopleWithIssues, 0);
    const training = new Map([['1', { overdue: ['Safe food handling', 'Ladders'], due: [] }], ['2', { overdue: [], due: ['Ladders'] }], ['9', { overdue: ['Ladders'], due: [] }]]);
    const r = R.complianceReport(people, asOf, { training });
    assert.equal(r.peopleWithIssues, 1, 'only an overdue training on a current employee is a problem');
    assert.deepEqual(r.list[0].issues, ['training_overdue']);
    assert.deepEqual(r.list[0].issueText, ['Training overdue: Safe food handling, Ladders']);
    assert.deepEqual(r.list[0].trainingOverdue, ['Safe food handling', 'Ladders']);
    assert.deepEqual(r.counts, [{ key: 'training_overdue', label: 'Training overdue', count: 1 }]);
    assert.equal(R.complianceReport(people, asOf, { training: 'not a map' }).peopleWithIssues, 0);
});

test('the note says the company must confirm what the law requires', () => {
    assert.match(T.NOTE, /compliance advisor/);
});
