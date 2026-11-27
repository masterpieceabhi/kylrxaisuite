// US-K05: field-mapping engine, the adapter base every connector is built on, and the catalog.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
const M = require('../services/connectors/mapping.js');
const { defineAdapter, oauthToken, clearTokens, xmlEscape } = require('../services/connectors/adapters/_base.js');
const { createHttp, mockTransport, HttpError } = require('../services/connectors/http.js');
const registry = require('../services/connectors/registry.js');

const person = {
    id: 'u1', employee_number: 'EMP0007', first_name: '  ada ', last_name: 'LOVELACE', work_email: 'Ada@Example.com', phone: '(555) 010-2030',
    hire_date: '2026-03-09', status: 'active', job: { title: 'Engineer', org_unit_name: 'R&D', manager_id: null }, hours: { worked: 41.256 }, tags: ['a', 'b']
};

test('paths: read and write nested and indexed values', () => {
    assert.equal(M.getPath(person, 'job.title'), 'Engineer');
    assert.equal(M.getPath(person, 'tags[1]'), 'b');
    assert.equal(M.getPath(person, 'job.missing.deeper'), undefined);
    assert.equal(M.getPath(person, ''), undefined);
    const out = {};
    M.setPath(out, 'Vendor.Name', 'x'); M.setPath(out, 'Lines[0].Amount', 5); M.setPath(out, 'Lines[1].Amount', 6);
    assert.deepEqual(out, { Vendor: { Name: 'x' }, Lines: [{ Amount: 5 }, { Amount: 6 }] });
});

test('transforms: text, numbers, dates, lookups, templates, chained in order', () => {
    const run = (v, t) => M.runTransforms(v, t, person);
    assert.equal(run('  ada ', ['trim', 'title']), 'Ada');
    assert.equal(run('Ada@Example.com', 'lower'), 'ada@example.com');
    assert.equal(run('41.256', ['number', { fn: 'round', digits: 1 }]), 41.3);
    assert.equal(run(41.256, { fn: 'round' }), 41.26);
    assert.equal(run(-5, 'abs'), 5);
    assert.equal(run(5, 'negate'), -5);
    assert.equal(run('active', 'bool'), true);
    assert.equal(run('no', 'bool'), false);
    assert.equal(run('2026-03-09', { fn: 'date', format: 'MM/DD/YYYY' }), '03/09/2026');
    assert.equal(run('2026-03-09T23:30:00Z', { fn: 'date' }), '2026-03-09');
    assert.equal(run('not a date', { fn: 'date' }), 'not a date');
    assert.equal(run(undefined, { fn: 'const', value: 'US' }), 'US');
    assert.equal(run('', { fn: 'default', value: 'n/a' }), 'n/a');
    assert.equal(run(null, { fn: 'template', value: '{{ last_name }}, {{first_name}} ({{job.title}})' }), 'LOVELACE,   ada  (Engineer)');
    assert.equal(run(null, { fn: 'join', paths: ['employee_number', 'job.manager_id', 'job.title'], sep: '-' }), 'EMP0007-Engineer');
    assert.equal(run('Ada Lovelace', { fn: 'split', index: 1 }), 'Lovelace');
    assert.equal(run('(555) 010-2030', 'digits'), '5550102030');
    assert.equal(run('7', { fn: 'padStart', length: 4 }), '0007');
    assert.equal(run('abcdef', { fn: 'truncate', length: 3 }), 'abc');
    assert.equal(run('a-b-c', { fn: 'replace', pattern: '-', with: '' }), 'abc');
    assert.equal(run('active', { fn: 'lookup', map: { active: 'A', terminated: 'T' } }), 'A');
    assert.equal(run('other', { fn: 'lookup', map: { active: 'A' }, default: '?' }), '?');
    assert.equal(run('other', { fn: 'lookup', map: { active: 'A' } }), 'other');
    assert.equal(run('toString', { fn: 'lookup', map: {} }), 'toString', 'lookup must not read inherited keys');
    assert.equal(run(null, 'upper'), null);
    assert.throws(() => run('x', 'explode'), /unknown transform/);
});

test('applyMapping: defaults, required, disabled rules, one bad rule does not stop the rest', () => {
    const r = M.applyMapping([
        { target: 'Name.First', source: 'first_name', transform: ['trim', 'title'] },
        { target: 'Email', source: 'work_email', transform: 'lower', required: true },
        { target: 'Manager', source: 'job.manager_id', required: true },
        { target: 'Country', source: 'country', default: 'US' },
        { target: 'Skip', source: 'first_name', disabled: true },
        { target: 'Broken', source: 'first_name', transform: 'nope' },
        { target: 'Nothing', source: 'does.not.exist' }
    ], person);
    assert.deepEqual(r.value, { Name: { First: 'Ada' }, Email: 'ada@example.com', Country: 'US' });
    assert.equal(r.errors.length, 2);
    assert.match(r.errors[0], /^Manager: required value is missing/);
    assert.match(r.errors[1], /^Broken: unknown transform/);
    assert.deepEqual(M.applyMapping(undefined, person), { value: {}, errors: [] });
});

test('mergeMappings: company rules override, add and remove connector defaults by target', () => {
    const defaults = [{ target: 'a', source: 'x' }, { target: 'b', source: 'y', transform: 'trim' }, { target: 'c', source: 'z' }];
    const merged = M.mergeMappings(defaults, [{ target: 'b', source: 'yy' }, { target: 'c', disabled: true }, { target: 'd', source: 'w' }, null, { source: 'no target' }]);
    assert.deepEqual(merged, [{ target: 'a', source: 'x' }, { target: 'b', source: 'yy', transform: 'trim' }, { target: 'd', source: 'w' }]);
    assert.deepEqual(defaults[1], { target: 'b', source: 'y', transform: 'trim' }, 'defaults are not changed in place');
    assert.deepEqual(M.mergeMappings(defaults), defaults);
});

test('validateMapping: reports every structural problem with the rule number', () => {
    assert.deepEqual(M.validateMapping('nope'), ['mapping must be a list of rules']);
    assert.deepEqual(M.validateMapping([{ target: 'A.b[0]', source: 'x.y', transform: ['trim', { fn: 'date', format: 'YYYY' }] }]), []);
    const errs = M.validateMapping([
        { target: 'ok' }, { target: 'ok' }, { source: 'x' }, { target: 'bad target!' }, { target: 't2', source: 'bad source!' },
        { target: 't3', transform: 'explode' }, { target: 't4', transform: { fn: 'replace', pattern: '(' } }, 'not an object'
    ]);
    assert.ok(errs.some((e) => /^rule 2: duplicate target ok/.test(e)));
    assert.ok(errs.some((e) => /^rule 3: target is required/.test(e)));
    assert.ok(errs.some((e) => /^rule 4: target is required/.test(e)));
    assert.ok(errs.some((e) => /^rule 5: source path is not valid/.test(e)));
    assert.ok(errs.some((e) => /^rule 6: unknown transform "explode"/.test(e)));
    assert.ok(errs.some((e) => /^rule 7: replace pattern/.test(e)));
    assert.ok(errs.some((e) => /^rule 8: must be an object/.test(e)));
    assert.ok(M.validateMapping(Array.from({ length: 201 }, (_, i) => ({ target: `t${i}` }))).some((e) => /too many rules/.test(e)));
});

test('adapter base: map uses defaults merged with the company override, then the vendor shape', () => {
    const a = defineAdapter({
        key: 'demo', name: 'Demo', category: 'accounting', vendor: 'Demo Inc',
        entities: [{ key: 'vendor', direction: 'push', source: 'people' }],
        defaultMappings: { vendor: [{ target: 'DisplayName', source: 'first_name', transform: 'trim' }, { target: 'Mail', source: 'work_email', required: true }] },
        shape: { vendor: (flat, rec) => ({ Vendor: flat, sourceId: rec.id }) },
        validate: (entity, payload) => (payload.Vendor.DisplayName ? [] : ['DisplayName is empty']),
        push: async (entity, payload) => ({ remoteId: `r_${payload.sourceId}` })
    });
    assert.equal(a.eventDriven, false); assert.equal(a.batch, false);
    assert.deepEqual(a.credentialFields, []); assert.deepEqual(a.needsVerification, []);
    const plain = a.map('vendor', person, { conn: {} });
    assert.deepEqual(plain, { payload: { Vendor: { DisplayName: 'ada', Mail: 'Ada@Example.com' }, sourceId: 'u1' }, errors: [] });
    const custom = a.map('vendor', person, { conn: { mapping: { vendor: [{ target: 'Mail', transform: 'lower' }, { target: 'DisplayName', disabled: true }, { target: 'Ref', source: 'employee_number' }] } } });
    assert.deepEqual(custom.payload.Vendor, { Mail: 'ada@example.com', Ref: 'EMP0007' });
    assert.deepEqual(a.validate('vendor', custom.payload), ['DisplayName is empty']);
    assert.deepEqual(a.map('vendor', { id: 'u2' }, { conn: {} }).errors.length, 1, 'missing required field is reported, not thrown');
    assert.deepEqual(a.map('unknown_entity', person, { conn: {} }), { payload: {}, errors: [] });
});

test('adapter base: health check reports failures instead of throwing; pull defaults to nothing', async () => {
    const good = defineAdapter({ key: 'g', name: 'G', authenticate: async () => ({ token: 't' }), healthCheck: async () => 'company Demo', push: async () => ({}) });
    const ctx = { conn: {} };
    const h = await good.healthCheck(ctx);
    assert.equal(h.ok, true); assert.equal(h.detail, 'company Demo'); assert.equal(typeof h.latencyMs, 'number');
    assert.deepEqual(ctx.auth, { token: 't' });
    const bad = defineAdapter({ key: 'b', name: 'B', authenticate: async () => { throw new Error('bad credentials'); }, push: async () => ({}) });
    assert.deepEqual({ ...(await bad.healthCheck({ conn: {} })), latencyMs: 0 }, { ok: false, detail: 'bad credentials', latencyMs: 0 });
    assert.deepEqual(await good.pull('x', ctx), { records: [], cursor: null });
    const ev = defineAdapter({ key: 'e', name: 'E', handleEvent: async (e) => ({ sent: e.type }) });
    assert.equal(ev.eventDriven, true);
    assert.deepEqual(await ev.handleEvent({ type: 'person.created' }, ctx), { sent: 'person.created' });
});

test('adapter base: OAuth token is fetched once per connection and cached; a bad token response is an error', async () => {
    clearTokens();
    const transport = mockTransport(() => ({ body: { access_token: 'tok_1', expires_in: 3600 } }));
    const ctx = { conn: { id: 'c1' }, http: createHttp({ transport }) };
    const t1 = await oauthToken(ctx, { url: 'https://id.example.com/token', form: { grant_type: 'client_credentials' }, basic: { id: 'abc', secret: 'shh' } });
    const t2 = await oauthToken(ctx, { url: 'https://id.example.com/token', form: { grant_type: 'client_credentials' }, basic: { id: 'abc', secret: 'shh' } });
    assert.equal(t1.token, 'tok_1'); assert.equal(t2.token, 'tok_1');
    assert.equal(transport.calls.length, 1, 'second call is served from the cache');
    assert.equal(transport.calls[0].headers.Authorization, `Basic ${Buffer.from('abc:shh').toString('base64')}`);
    assert.equal(transport.calls[0].body, 'grant_type=client_credentials');
    await oauthToken({ conn: { id: 'c2' }, http: ctx.http }, { url: 'https://id.example.com/token', form: {} });
    assert.equal(transport.calls.length, 2, 'another connection gets its own token');
    const empty = { conn: { id: 'c3' }, http: createHttp({ transport: mockTransport(() => ({ body: { nope: 1 } })) }) };
    await assert.rejects(() => oauthToken(empty, { url: 'https://id.example.com/token', form: {} }), /did not return an access_token/);
    clearTokens();
});

test('http client: JSON errors carry the status, 429 and 5xx are retryable, 4xx are not', async () => {
    const http = createHttp({ transport: mockTransport((call) => {
        if (call.url.includes('/limit')) return { status: 429, body: { message: 'slow down' } };
        if (call.url.includes('/down')) return { status: 503, body: 'oops' };
        if (call.url.includes('/bad')) return { status: 400, body: { error: { message: 'name is required' } } };
        return { body: { ok: true, q: call.url.split('?')[1] || null } };
    }) });
    const ok = await http.request({ url: 'https://api.example.com/x', query: { a: 1, b: undefined, c: 'x y' } });
    assert.deepEqual(ok.json, { ok: true, q: 'a=1&c=x+y' });
    const e429 = await http.request({ url: 'https://api.example.com/limit' }).catch((e) => e);
    assert.ok(e429 instanceof HttpError); assert.equal(e429.status, 429); assert.equal(e429.retryable, true); assert.match(e429.message, /slow down/);
    assert.equal((await http.request({ url: 'https://api.example.com/down' }).catch((e) => e)).retryable, true);
    const e400 = await http.request({ url: 'https://api.example.com/bad' }).catch((e) => e);
    assert.equal(e400.retryable, false); assert.match(e400.message, /HTTP 400: name is required/);
    assert.equal((await http.request({ url: 'https://api.example.com/bad', expect: false })).status, 400);
    const net = createHttp({ transport: async () => { const e = new Error('blocked'); e.code = 'SSRF_BLOCKED'; throw e; } });
    assert.equal((await net.request({ url: 'https://api.example.com/x' }).catch((e) => e)).retryable, false, 'a blocked address is never retried');
});

test('xmlEscape covers the five special characters', () => {
    assert.equal(xmlEscape(`<a href="x">Tom & 'Jerry'</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; &apos;Jerry&apos;&lt;/a&gt;');
    assert.equal(xmlEscape(null), '');
});

test('catalog: every connector is complete, unique, has valid default mappings and exposes no functions', () => {
    const keys = registry.adapters.map((a) => a.key);
    assert.equal(new Set(keys).size, keys.length, 'connector keys are unique');
    assert.ok(keys.length >= 13);
    for (const a of registry.adapters) {
        assert.ok(a.name && a.category, `${a.key} has a name and a category`);
        assert.equal(registry.get(a.key), a);
        assert.ok(a.eventDriven || a.entities.length, `${a.key} either syncs something or handles events`);
        for (const e of a.entities) {
            assert.ok(['push', 'pull'].includes(e.direction), `${a.key}.${e.key} has a direction`);
            if (e.direction === 'push') assert.ok(['people', 'payroll_journal', 'time_weeks'].includes(e.source), `${a.key}.${e.key} reads from a known source`);
        }
        for (const [entity, rules] of Object.entries(a.defaultMappings)) assert.deepEqual(M.validateMapping(rules), [], `${a.key}.${entity} default mapping is valid`);
        for (const f of a.credentialFields) assert.ok(f.key && f.label, `${a.key} credential fields are labelled`);
    }
    const described = registry.catalog();
    assert.equal(described.length, keys.length);
    assert.doesNotThrow(() => JSON.stringify(described));
    for (const d of described) for (const v of Object.values(d)) assert.notEqual(typeof v, 'function');
    assert.equal(registry.get('nope'), null);
});

test('a mapping can never read or write the prototype shared by all objects', () => {
    assert.deepEqual(M.validateMapping([{ target: '__proto__.polluted', source: 'id' }, { target: 'a.constructor.prototype.x', source: 'id' }, { target: 'ok', source: 'constructor.name' }]),
        ['rule 1: target "__proto__.polluted" is not allowed', 'rule 2: target "a.constructor.prototype.x" is not allowed', 'rule 3: source "constructor.name" is not allowed']);
    const r = M.applyMapping([{ target: '__proto__.polluted', source: 'id' }, { target: 'constructor.prototype.polluted', source: 'id' }, { target: 'safe', source: 'id' }, { target: 'leak', source: 'constructor.name' }], person);
    assert.deepEqual(r.value, { safe: 'u1' });
    assert.equal(r.errors.length, 2);
    assert.equal({}.polluted, undefined);
    assert.throws(() => M.setPath({}, 'a.__proto__.b', 1), /not an allowed path/);
    assert.equal(M.getPath(person, '__proto__'), undefined);
    assert.equal(M.runTransforms(null, { fn: 'template', value: '{{constructor.name}}!' }, person), '!');
});

test('mapping editor: the text form of a change reads and writes back', () => {
    assert.equal(M.transformToText(undefined), ''); assert.equal(M.transformToText('trim'), 'trim'); assert.equal(M.transformToText(['trim', 'upper']), 'trim, upper');
    assert.equal(M.transformToText({ fn: 'date', format: 'MM/DD/YYYY' }), '{"fn":"date","format":"MM/DD/YYYY"}');
    assert.deepEqual(M.parseTransformText(''), { value: undefined }); assert.deepEqual(M.parseTransformText(' trim '), { value: 'trim' });
    assert.deepEqual(M.parseTransformText('trim, upper,'), { value: ['trim', 'upper'] });
    assert.deepEqual(M.parseTransformText('{"fn":"date","format":"MM/DD/YYYY"}'), { value: { fn: 'date', format: 'MM/DD/YYYY' } });
    assert.deepEqual(M.parseTransformText('["trim",{"fn":"truncate","length":3}]'), { value: ['trim', { fn: 'truncate', length: 3 }] });
    assert.ok(M.parseTransformText('{oops').error);
    for (const t of ['trim', ['trim', 'upper'], { fn: 'lookup', map: { a: 'b' } }]) assert.deepEqual(M.parseTransformText(M.transformToText(t)).value, t);
});

test('mapping editor: only the company\'s changes are stored, and they rebuild exactly what was edited', () => {
    const defaults = [{ target: 'a', source: 'x' }, { target: 'b', source: 'y', transform: 'trim', default: 'N' }, { target: 'c', source: 'z', required: true }, { target: 'e', source: 'v' }];
    assert.deepEqual(M.describeMapping(defaults, []).map((r) => r.origin), ['default', 'default', 'default', 'default']);
    assert.deepEqual(M.overridesFromEdited(defaults, M.describeMapping(defaults, [])), { overrides: [], errors: [] }, 'saving without edits stores nothing');
    const edited = [
        { target: 'a', source: 'x', transform_text: '' },                                 // untouched
        { target: 'b', source: 'y', transform_text: '', default: '' },                    // change and default cleared
        { target: 'c', source: 'z', required: true, removed: true },                      // switched off
        { target: 'd', source: 'w', transform_text: 'trim, upper', required: true }       // new; "e" was deleted from the list
    ];
    const { overrides, errors } = M.overridesFromEdited(defaults, edited);
    assert.deepEqual(errors, []);
    assert.deepEqual(overrides, [{ target: 'b', source: 'y', replace: true }, { target: 'c', disabled: true }, { target: 'd', source: 'w', transform: ['trim', 'upper'], required: true }, { target: 'e', disabled: true }]);
    const stored = JSON.parse(JSON.stringify(overrides)); // what the database keeps
    assert.deepEqual(M.mergeMappings(defaults, stored), [{ target: 'a', source: 'x' }, { target: 'b', source: 'y' }, { target: 'd', source: 'w', transform: ['trim', 'upper'], required: true }]);
    const rows = M.describeMapping(defaults, stored);
    assert.deepEqual(rows.map((r) => [r.target, r.origin]), [['a', 'default'], ['b', 'changed'], ['d', 'added'], ['c', 'removed'], ['e', 'removed']]);
    assert.equal(rows[2].transform_text, 'trim, upper');
    assert.deepEqual(M.overridesFromEdited(defaults, rows.map((r) => ({ ...r, removed: r.origin === 'removed' }))).overrides.map((o) => o.target).sort(), ['b', 'c', 'd', 'e'], 'opening and saving again changes nothing');
    assert.deepEqual(M.overridesFromEdited(defaults, rows.filter((r) => r.target !== 'b').concat([{ target: 'b', source: 'y', transform_text: 'trim', default: 'N' }]).map((r) => ({ ...r, removed: r.origin === 'removed' }))).overrides.some((o) => o.target === 'b'), false, 'putting a rule back to its default removes the stored change');
    assert.deepEqual(M.applyMapping(M.mergeMappings(defaults, stored), { x: 1, y: '', w: ' hi ' }).value, { a: 1, b: '', d: 'HI' }, 'the cleared default no longer fills in "N"');
});

test('mapping editor: bad edits are reported and nothing unsafe gets through', () => {
    const defaults = [{ target: 'a', source: 'x' }];
    assert.deepEqual(M.overridesFromEdited(defaults, 'nope').errors, ['rules must be a list']);
    const r = M.overridesFromEdited(defaults, [{ target: 'a', source: 'x' }, { target: 'a', source: 'y' }, { source: 'no target' }, { target: 'j', transform_text: '{bad' }, null]);
    assert.deepEqual(r.errors, ['rule 2: duplicate target a', 'rule 3: the output field is required', 'rule 4: the change is not valid JSON', 'rule 5: must be an object']);
    assert.ok(M.overridesFromEdited(defaults, [{ target: 'a', source: 'x' }, { target: '__proto__.x', source: 'x' }]).errors[0].includes('not allowed'));
    assert.ok(M.overridesFromEdited(defaults, [{ target: 'a', source: 'x', transform_text: 'explode' }]).errors[0].includes('unknown transform'));
    assert.deepEqual(M.mergeMappings(defaults, [{ target: 'a', transform: 'trim' }]), [{ target: 'a', source: 'x', transform: 'trim' }], 'older stored overrides without replace still layer on the default');
});
