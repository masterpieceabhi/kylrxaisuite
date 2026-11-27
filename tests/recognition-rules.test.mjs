import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../services/recognition-rules.js');

const VALUES = R.DEFAULT_SETTINGS.values;
const ann = (over = {}) => ({ id: 'a1', status: 'published', title: 'Store closes early', body: 'We close at 3 on Friday.', audience: { type: 'everyone', id: null }, pinned: false, endDate: null, publishedAt: '2026-11-01T10:00:00.000Z', ...over });
const thanks = (over = {}) => ({ id: 't1', fromId: 'u1', fromName: 'Ana', toId: 'u2', toName: 'Ben', valueId: 'teamwork', valueName: 'Teamwork', message: 'Thanks for covering my shift', at: '2026-11-10T15:00:00.000Z', day: '2026-11-10', ...over });

test('settings fall back to the defaults and HR can change them', () => {
    assert.equal(R.settingsOf(null).dailyLimit, 5);
    assert.equal(R.settingsOf({ dailyLimit: 0 }).dailyLimit, 5);
    assert.equal(R.settingsOf({ dailyLimit: 3, values: [{ id: 'x', name: 'X-ray' }] }).values[0].name, 'X-ray');
    assert.equal(R.settingsOf({ values: [] }).values.length, VALUES.length);
    assert.deepEqual(R.validateSettings({}).errors, ['Nothing to change']);
    assert.equal(R.validateSettings({ dailyLimit: 2.5 }).errors.length, 1);
    assert.equal(R.validateSettings({ dailyLimit: 51 }).errors.length, 1);
    assert.equal(R.validateSettings({ values: [] }).errors.length, 1);
    assert.equal(R.validateSettings({ values: Array.from({ length: 13 }, (_, i) => `Value ${i}`) }).errors.length, 1);
    assert.match(R.validateSettings({ values: ['Teamwork', ' teamwork '] }).errors[0], /twice/);
    assert.match(R.validateSettings({ values: ['x'] }).errors[0], /at least 2/);
    const ok = R.validateSettings({ dailyLimit: '3', values: [{ id: 'teamwork', name: 'Working <b>together</b>' }, 'Kind to customers'] });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.dailyLimit, 3);
    assert.deepEqual(ok.value.values, [{ id: 'teamwork', name: 'Working btogether/b' }, { id: 'kind_to_customers', name: 'Kind to customers' }]);
});

test('an announcement needs a title, text and a known audience', () => {
    assert.equal(R.validateAnnouncement({}).errors.length, 2);
    assert.equal(R.validateAnnouncement({ title: 'Hi all', body: 'Text', audience: { type: 'planet' } }).errors.length, 1);
    assert.match(R.validateAnnouncement({ title: 'Hi all', body: 'Text', audience: { type: 'location' } }).errors[0], /Choose the location/);
    assert.match(R.validateAnnouncement({ title: 'Hi all', body: 'Text', audience: { type: 'department', id: '' } }).errors[0], /Choose the department/);
    assert.match(R.validateAnnouncement({ title: 'Hi all', body: 'x'.repeat(R.BODY_MAX + 1) }).errors[0], /too long/);
    assert.equal(R.validateAnnouncement({ title: 'Hi all', body: 'Text', endDate: '2026-02-30' }).errors.length, 1);
    assert.match(R.validateAnnouncement({ title: 'Hi all', body: 'Text', endDate: '2026-11-01' }, { today: '2026-11-12' }).errors[0], /already passed/);
    const ok = R.validateAnnouncement({ title: ' Holiday  <i>hours</i> ', body: 'Line one.  \r\nLine two.', audience: { type: 'location', id: 'loc1' }, pinned: 1, endDate: '2026-11-12' }, { today: '2026-11-12' });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value, { title: 'Holiday ihours/i', body: 'Line one.\nLine two.', audience: { type: 'location', id: 'loc1' }, pinned: true, endDate: '2026-11-12' });
    assert.deepEqual(R.validateAnnouncement({ title: 'Hi all', body: 'Text' }).value.audience, { type: 'everyone', id: null });
    assert.deepEqual(R.validateAnnouncement({}, { partial: true }).errors, ['Nothing to change']);
    assert.deepEqual(R.validateAnnouncement({ endDate: '' }, { partial: true }).value, { endDate: null });
});

test('an announcement goes draft, published, archived and never back', () => {
    const d = ann({ status: 'draft' }); const p = ann(); const a = ann({ status: 'archived' });
    assert.equal(R.announcementChangeError(d, 'publish'), null);
    assert.equal(R.announcementChangeError(d, 'edit'), null);
    assert.equal(R.announcementChangeError(d, 'delete'), null);
    assert.match(R.announcementChangeError(d, 'archive'), /deleted instead/);
    assert.match(R.announcementChangeError(p, 'publish'), /already published/);
    assert.equal(R.announcementChangeError(p, 'edit'), null);
    assert.equal(R.announcementChangeError(p, 'archive'), null);
    assert.match(R.announcementChangeError(p, 'delete'), /Archive it instead/);
    assert.match(R.announcementChangeError(a, 'publish'), /Write a new one/);
    assert.match(R.announcementChangeError(a, 'edit'), /cannot be changed/);
    assert.match(R.announcementChangeError(a, 'archive'), /already archived/);
    assert.match(R.announcementChangeError(a, 'delete'), /Archive it instead/);
    assert.match(R.announcementChangeError(p, 'explode'), /Unknown action/);
});

test('people see only published announcements meant for them, until the end date', () => {
    const me = { departmentId: 'd1', workLocationId: 'l1' };
    assert.equal(R.isVisibleTo(ann(), me, '2026-11-12'), true);
    assert.equal(R.isVisibleTo(ann({ status: 'draft' }), me, '2026-11-12'), false);
    assert.equal(R.isVisibleTo(ann({ status: 'archived' }), me, '2026-11-12'), false);
    assert.equal(R.isVisibleTo(ann({ audience: { type: 'location', id: 'l1' } }), me, '2026-11-12'), true);
    assert.equal(R.isVisibleTo(ann({ audience: { type: 'location', id: 'l2' } }), me, '2026-11-12'), false);
    assert.equal(R.isVisibleTo(ann({ audience: { type: 'department', id: 'd1' } }), me, '2026-11-12'), true);
    assert.equal(R.isVisibleTo(ann({ audience: { type: 'department', id: 'd2' } }), me, '2026-11-12'), false);
    // someone with no location or department on file sees only the ones for everyone
    assert.equal(R.isVisibleTo(ann({ audience: { type: 'department', id: 'd1' } }), {}, '2026-11-12'), false);
    assert.equal(R.isVisibleTo(ann({ audience: { type: 'location', id: undefined } }), {}, '2026-11-12'), false);
    assert.equal(R.isVisibleTo(ann(), null, '2026-11-12'), true);
    // the end date is the last day it shows
    assert.equal(R.isVisibleTo(ann({ endDate: '2026-11-12' }), me, '2026-11-12'), true);
    assert.equal(R.isVisibleTo(ann({ endDate: '2026-11-11' }), me, '2026-11-12'), false);
    assert.equal(R.audienceCount(ann({ audience: { type: 'department', id: 'd1' } }), [me, { departmentId: 'd2' }, { departmentId: 'd1' }]), 2);
    assert.equal(R.audienceCount(ann(), [me, {}, {}]), 3);
});

test('pinned announcements come first, then the newest', () => {
    const list = [ann({ id: 'old', publishedAt: '2026-10-01T00:00:00Z' }), ann({ id: 'new', publishedAt: '2026-11-05T00:00:00Z' }), ann({ id: 'pin', pinned: true, publishedAt: '2026-09-01T00:00:00Z' }), ann({ id: 'pin2', pinned: true, publishedAt: '2026-09-15T00:00:00Z' })];
    assert.deepEqual(R.sortForReading(list).map((a) => a.id), ['pin2', 'pin', 'new', 'old']);
    assert.equal(list[0].id, 'old');
    assert.equal(R.readId('a1', 'u/1'), 'a1_u_1');
});

test('a thanks needs a coworker, a value and a short message', () => {
    const ctx = { fromId: 'u1', peopleIds: ['u1', 'u2'], values: VALUES };
    assert.equal(R.validateThanks({}, ctx).errors.length, 3);
    assert.match(R.validateThanks({ toUserId: 'u1', valueId: 'teamwork', message: 'Well done me' }, ctx).errors[0], /cannot thank yourself/);
    assert.match(R.validateThanks({ toUserId: 'other-company', valueId: 'teamwork', message: 'Well done' }, ctx).errors[0], /not in your company/);
    assert.match(R.validateThanks({ toUserId: { $ne: '' }, valueId: 'teamwork', message: 'Well done' }, ctx).errors[0], /Choose the person/);
    assert.match(R.validateThanks({ toUserId: 'u2', valueId: 'made_up', message: 'Well done' }, ctx).errors[0], /what the thanks is for/);
    assert.match(R.validateThanks({ toUserId: 'u2', valueId: 'teamwork', message: ' a ' }, ctx).errors[0], /short message/);
    assert.match(R.validateThanks({ toUserId: 'u2', valueId: 'teamwork', message: 'x'.repeat(501) }, ctx).errors[0], /too long/);
    assert.equal(R.validateThanks({ toUserId: 'u2', valueId: 'teamwork', message: 'x'.repeat(500) }, ctx).errors.length, 0);
    const ok = R.validateThanks({ toUserId: ' u2 ', valueId: 'safety', message: ' Thanks for <b>mopping</b> the spill ' }, { ...ctx, peopleIds: new Set(['u2']) });
    assert.deepEqual(ok.value, { toUserId: 'u2', valueId: 'safety', valueName: 'Safety', message: 'Thanks for bmopping/b the spill' });
});

test('a person may send only so many thanks in a day', () => {
    const list = [thanks(), thanks({ id: 't2', hidden: true }), thanks({ id: 't3', day: '2026-11-09' }), thanks({ id: 't4', fromId: 'u2', toId: 'u1' })];
    assert.equal(R.sentOn(list, 'u1', '2026-11-10'), 2);
    assert.equal(R.sentOn(list, 'u1', '2026-11-11'), 0);
    assert.equal(R.limitError(4, null), null);
    assert.match(R.limitError(5, null), /sent 5 thanks today/);
    assert.equal(R.limitError(5, { dailyLimit: 6 }), null);
    assert.match(R.limitError(2, { dailyLimit: 2 }), /sent 2 thanks today/);
    assert.equal(R.slotId('org_a', 'u1', '2026-11-10', 3), 'org_a_u1_2026-11-10_3');
    assert.notEqual(R.slotId('org_a', 'u1', '2026-11-10', 3), R.slotId('org_a', 'u1', '2026-11-11', 3));
});

test('hidden thanks are shown only to HR', () => {
    const t = thanks({ hidden: true, hiddenReason: 'rude', hiddenByName: 'HR Admin', hiddenAt: 'x' });
    assert.equal(R.thanksView(t), null);
    assert.equal(R.thanksView(t, { forHr: true }).hidden, true);
    assert.equal(R.thanksView(t, { forHr: true }).hiddenReason, 'rude');
    const plain = R.thanksView(thanks());
    assert.equal(plain.message, 'Thanks for covering my shift');
    assert.equal('hidden' in plain, false);
    assert.deepEqual(R.newestFirst([thanks({ id: 'a', at: '2026-11-01T00:00:00Z' }), thanks({ id: 'b', at: '2026-11-03T00:00:00Z' })]).map((x) => x.id), ['b', 'a']);
});

test('the report counts by person and by value inside the dates and leaves hidden ones out', () => {
    assert.match(R.validateRange('2026-11-01', ''), /needed as dates/);
    assert.match(R.validateRange('2026-11-10', '2026-11-01'), /must not be after/);
    assert.equal(R.validateRange('2026-11-01', '2026-11-01'), null);
    const list = [thanks(), thanks({ id: 't2', valueId: 'safety', valueName: 'Safety' }), thanks({ id: 't3', fromId: 'u2', fromName: 'Ben', toId: 'u3', toName: 'Cy' }),
        thanks({ id: 't4', hidden: true }), thanks({ id: 't5', day: '2026-10-31' }), thanks({ id: 't6', valueId: 'retired', valueName: 'Old value', toId: 'u3', toName: 'Cy' })];
    const s = R.summarize(list, { from: '2026-11-01', to: '2026-11-30', values: VALUES });
    assert.equal(s.total, 4);
    assert.equal(s.hidden, 1);
    assert.deepEqual(s.byPerson.map((p) => [p.name, p.received, p.given]), [['Ben', 2, 1], ['Cy', 2, 0], ['Ana', 0, 3]]);
    assert.deepEqual(s.byValue.slice(0, 3).map((v) => [v.name, v.count]), [['Teamwork', 2], ['Old value', 1], ['Safety', 1]]);
    // values nobody chose are still listed, with zero
    assert.equal(s.byValue.length, VALUES.length + 1);
    assert.equal(s.byValue.find((v) => v.valueId === 'great_idea').count, 0);
    assert.equal(R.summarize([], { from: '2026-11-01', to: '2026-11-30' }).total, 0);
});

test('the CSV cannot run as a spreadsheet formula', () => {
    assert.equal(R.csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
    assert.equal(R.csvCell('@cmd'), '"\'@cmd"');
    assert.equal(R.csvCell('-2+3'), '"\'-2+3"');
    assert.equal(R.csvCell(-2), '-2');
    assert.equal(R.csvCell('Ana "Annie" Diaz, Jr'), '"Ana ""Annie"" Diaz, Jr"');
    assert.equal(R.csvCell(null), '');
    const csv = R.reportCsv(R.summarize([thanks({ toName: '=HYPERLINK("x")' })], { from: '2026-11-01', to: '2026-11-30', values: VALUES }));
    assert.ok(csv.includes('"\'=HYPERLINK(""x"")",1,0'));
    assert.ok(csv.includes('Teamwork,1'));
    assert.ok(csv.endsWith('\r\n'));
});
