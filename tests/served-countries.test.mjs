// Which countries a server takes (SERVED_COUNTRIES, COUNTRY_ADDRESSES): services/served-countries.js.
// What this does NOT cover: the sign-up route itself and GET /api/auth/region, which were run by hand against a local
// server on 2026-11-18; and companies of another country that are already in a server's database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../services/served-countries.js');
const { checkProductionEnv } = require('../services/production-check.js');

const US = { SERVED_COUNTRIES: 'US', COUNTRY_ADDRESSES: 'US=https://us.onnhr.com, IN=https://in.onnhr.com' };

test('a country is recognised however it is written, and an unknown one is not taken for India', () => {
    for (const v of ['US', 'usa', 'United States', ' united states of america ', 'U.S.', 'America']) assert.equal(S.codeOf(v), 'US', v);
    for (const v of ['IN', 'india', 'India', 'IND']) assert.equal(S.codeOf(v), 'IN', v);
    for (const v of ['CA', 'Canada']) assert.equal(S.codeOf(v), 'CA', v);
    for (const v of ['Germany', 'Indiana', 'Indonesia', 'xx', '', null, undefined]) assert.equal(S.codeOf(v), null, String(v));
});

test('without the setting every country is taken, exactly as before', () => {
    assert.deepEqual(S.configured({}), { codes: [], addresses: {}, problems: [] });
    assert.deepEqual(S.checkSignup('United States', {}), { ok: true, code: 'US', country: 'United States' });
    assert.deepEqual(S.checkSignup('', {}), { ok: true, code: 'IN', country: '' }, 'no country still means India here, as before');
    assert.deepEqual(S.checkSignup('Germany', {}), { ok: true, code: 'IN', country: 'Germany' }, 'unchanged old behaviour when the setting is off');
    assert.equal(S.serves('IN', {}), true);
});

test('a US server takes US companies, gives its own country to a sign-up that names none, and sends India to its address', () => {
    assert.deepEqual(S.checkSignup('United States', US), { ok: true, code: 'US', country: 'United States' });
    assert.deepEqual(S.checkSignup('usa', US), { ok: true, code: 'US', country: 'usa' });
    assert.deepEqual(S.checkSignup('', US), { ok: true, code: 'US', country: 'United States' });
    const india = S.checkSignup('India', US);
    assert.deepEqual([india.ok, india.status, india.code, india.country, india.address], [false, 409, 'wrong_address', 'IN', 'https://in.onnhr.com']);
    assert.match(india.error, /Companies in India sign up at https:\/\/in\.onnhr\.com/);
    const canada = S.checkSignup('Canada', US);
    assert.deepEqual([canada.status, canada.code, canada.address], [409, 'wrong_address', null]);
    assert.match(canada.error, /Companies in Canada are not served here/);
    const unknown = S.checkSignup('Germany', US);
    assert.deepEqual([unknown.ok, unknown.status, unknown.code], [false, 400, 'country_unknown']);
    assert.equal(S.serves('US', US), true); assert.equal(S.serves('IN', US), false);
});

test('a server for two countries asks which one when a sign-up names none', () => {
    const both = { SERVED_COUNTRIES: 'us, ca' };
    assert.deepEqual(S.configured(both).codes, ['US', 'CA']);
    assert.deepEqual([S.checkSignup('', both).status, S.checkSignup('', both).code], [400, 'country_required']);
    assert.equal(S.checkSignup('Canada', both).ok, true);
    assert.equal(S.checkSignup('India', both).code, 'wrong_address');
});

test('what the front door is told: what is served here and where the rest go', () => {
    assert.deepEqual(S.publicInfo(US), { restricted: true, serves: [{ code: 'US', name: 'United States' }], elsewhere: [{ code: 'IN', name: 'India', address: 'https://in.onnhr.com' }] });
    const open = S.publicInfo({});
    assert.equal(open.restricted, false); assert.deepEqual(open.serves.map((c) => c.code), ['IN', 'US', 'CA']); assert.deepEqual(open.elsewhere, []);
});

test('settings that would be ignored are reported, and a production server is told when the setting is missing', () => {
    const bad = S.configured({ SERVED_COUNTRIES: 'US, Mars, us', COUNTRY_ADDRESSES: 'US=https://us.onnhr.com, IN=http://in.onnhr.com, XX=https://x.example, IN=https://in.onnhr.com/path, nonsense' });
    assert.deepEqual(bad.codes, ['US']); assert.deepEqual(bad.addresses, { US: 'https://us.onnhr.com' });
    assert.equal(bad.problems.length, 5, bad.problems.join(' | '));
    const prod = { NODE_ENV: 'production' };
    assert.ok(checkProductionEnv(prod, {}).warnings.some((w) => /SERVED_COUNTRIES is not set/.test(w)));
    assert.ok(!checkProductionEnv({ ...prod, SERVED_COUNTRIES: 'US' }, {}).warnings.some((w) => /SERVED_COUNTRIES/.test(w)));
    assert.ok(checkProductionEnv({ ...prod, SERVED_COUNTRIES: 'Mars' }, {}).problems.some((p) => /SERVED_COUNTRIES: "Mars"/.test(p)));
});
