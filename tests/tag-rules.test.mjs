import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../services/tag-rules.js');

const company = [{ id: 't1', name: 'Bilingual' }, { id: 't2', name: 'Keyholder' }, { id: 't3', name: 'Night shift' }];

test('tag names: short, trimmed, single spaces, plain characters', () => {
    const ok = T.validateTag({ name: '  Night   shift ' });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.value.name, 'Night shift');
    assert.equal(ok.value.key, 'night shift');
    assert.equal(ok.value.color, 'grey');
    assert.deepEqual(T.validateTag({ name: 'CPR/First-aid #2', color: 'red' }).errors, []);
    assert.deepEqual(T.validateTag({ name: 'Español' }).errors, []);
    assert.ok(T.validateTag({}).errors.some((e) => /name is required/.test(e)));
    assert.ok(T.validateTag({ name: '   ' }).errors.some((e) => /required/.test(e)));
    assert.ok(T.validateTag({ name: 'x'.repeat(T.MAX_NAME_LENGTH + 1) }).errors.some((e) => /too long/.test(e)));
    assert.deepEqual(T.validateTag({ name: 'x'.repeat(T.MAX_NAME_LENGTH) }).errors, []);
    for (const bad of ['<script>', '=SUM(A1)', '-lead', 'a,b', '"quoted"']) assert.ok(T.validateTag({ name: bad }).errors.length > 0, bad);
    assert.ok(T.validateTag({ name: 'Ok', color: 'pink' }).errors.some((e) => /color/.test(e)));
});

test('company list: no duplicates whatever the capitals, at most 50', () => {
    assert.match(T.listConflict(company, T.validateTag({ name: 'BILINGUAL' }).value), /already exists/);
    assert.match(T.listConflict(company, T.validateTag({ name: 'night  SHIFT' }).value), /already exists/);
    assert.equal(T.listConflict(company, T.validateTag({ name: 'Forklift' }).value), null);
    // renaming a tag to its own name (new capitals) is fine; to another tag's name is not
    assert.equal(T.listConflict(company, T.validateTag({ name: 'bilingual' }).value, 't1'), null);
    assert.match(T.listConflict(company, T.validateTag({ name: 'keyholder' }).value, 't1'), /already exists/);
    const full = Array.from({ length: T.MAX_TAGS }, (_, i) => ({ id: `x${i}`, name: `Tag ${i}` }));
    assert.equal(T.MAX_TAGS, 50);
    assert.match(T.listConflict(full, T.validateTag({ name: 'One more' }).value), /At most 50/);
    assert.equal(T.listConflict(full.slice(1), T.validateTag({ name: 'One more' }).value), null);
    assert.equal(T.listConflict(full, T.validateTag({ name: 'Renamed' }).value, 'x3'), null); // a rename does not count against the limit
});

test('cleanTagIds drops tags that no longer exist and repeats', () => {
    assert.deepEqual(T.cleanTagIds(['t2', 'gone', 't1', 't2'], company), ['t2', 't1']);
    assert.deepEqual(T.cleanTagIds(undefined, company), []);
    assert.deepEqual(T.cleanTagIds('t1', company), []);
});

test('assign and remove tags on a person', () => {
    let r = T.applyChange([], company, { add: ['t1', 't3'] });
    assert.deepEqual(r.errors, []); assert.deepEqual(r.value, ['t1', 't3']); assert.deepEqual(r.added, ['t1', 't3']);
    r = T.applyChange(['t1', 't3'], company, { add: ['t1', 't2'], remove: ['t3'] });
    assert.deepEqual(r.value, ['t1', 't2']); assert.deepEqual(r.added, ['t2']); assert.deepEqual(r.removed, ['t3']);
    r = T.applyChange(['t1'], company, { remove: 't2' }); // not on the person: nothing happens, no error
    assert.deepEqual(r.errors, []); assert.deepEqual(r.value, ['t1']); assert.deepEqual(r.removed, []);
    r = T.applyChange(['t1'], company, { add: ['nope'] });
    assert.ok(r.errors.some((e) => /not a tag of this company: nope/.test(e))); assert.deepEqual(r.value, ['t1']); assert.deepEqual(r.added, []);
    assert.ok(T.applyChange(['t1'], company, {}).errors.some((e) => /add and\/or remove/.test(e)));
    assert.ok(T.applyChange(['t1'], company, { add: ['t2'], remove: ['t2'] }).errors.some((e) => /added and removed/.test(e)));
    // a stale id on the person is cleaned out as a side effect of any change
    assert.deepEqual(T.applyChange(['gone', 't1'], company, { add: ['t2'] }).value, ['t1', 't2']);
});

test('a person can carry at most 20 tags', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, name: `M ${i}` }));
    const twenty = many.slice(0, T.MAX_TAGS_PER_PERSON).map((t) => t.id);
    assert.deepEqual(T.applyChange([], many, { add: twenty }).errors, []);
    const over = T.applyChange(twenty, many, { add: ['m20'] });
    assert.ok(over.errors.some((e) => /at most 20/.test(e))); assert.equal(over.value.length, 20);
    assert.deepEqual(T.applyChange(twenty, many, { add: ['m20'], remove: ['m0'] }).errors, []); // swap is fine
});

test('filter people by tag: any, all, empty filter', () => {
    const people = [{ id: 'a', tags: ['t1', 't2'] }, { id: 'b', tags: ['t2'] }, { id: 'c', tags: [] }, { id: 'd' }];
    const ids = (rows) => rows.map((p) => p.id);
    assert.deepEqual(ids(T.filterByTags(people, ['t2'])), ['a', 'b']);
    assert.deepEqual(ids(T.filterByTags(people, ['t1', 't3'], 'any')), ['a']);
    assert.deepEqual(ids(T.filterByTags(people, ['t1', 't2'], 'all')), ['a']);
    assert.deepEqual(ids(T.filterByTags(people, ['t1', 't3'], 'all')), []);
    assert.deepEqual(ids(T.filterByTags(people, [])), ['a', 'b', 'c', 'd']);
    assert.deepEqual(ids(T.filterByTags(people, 't1')), ['a']);
});

test('filter text from the address bar: ids or names, comma separated or repeated', () => {
    assert.deepEqual(T.resolveFilter('t1,keyholder', company), { ids: ['t1', 't2'], unknown: [] });
    assert.deepEqual(T.resolveFilter(['NIGHT SHIFT', 't1', 't1'], company), { ids: ['t3', 't1'], unknown: [] });
    assert.deepEqual(T.resolveFilter('t1, nothing', company), { ids: ['t1'], unknown: ['nothing'] });
    assert.deepEqual(T.resolveFilter(undefined, company), { ids: [], unknown: [] });
});

test('counts per tag and sorting', () => {
    assert.deepEqual(T.countByTag([{ tags: ['t1', 't2', 't1'] }, { tags: ['t2', 'gone'] }, {}], company), { t1: 1, t2: 2, t3: 0 });
    assert.deepEqual(T.sortTags([{ name: 'b' }, { name: 'A' }, { name: 'c' }]).map((t) => t.name), ['A', 'b', 'c']);
});
