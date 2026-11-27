import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const N = require('../services/ip-match.js');
const R = require('../services/clock-compliance-rules.js');

test('IPv4 addresses are read strictly', () => {
    assert.equal(N.parseIpv4('203.0.113.7'), 0xcb007107n);
    assert.equal(N.parseIpv4('0.0.0.0'), 0n);
    assert.equal(N.parseIpv4('255.255.255.255'), 0xffffffffn);
    for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.-4', 'a.b.c.d', '', ' 1.2.3.4', '1.2.3.4/24', '1..3.4', '0x7f.0.0.1']) assert.equal(N.parseIpv4(bad), null, bad);
});

test('IPv6 addresses: full, shortened, with an IPv4 tail or a zone', () => {
    assert.equal(N.parseIpv6('::'), 0n);
    assert.equal(N.parseIpv6('::1'), 1n);
    assert.equal(N.parseIpv6('2001:db8::1'), (0x20010db8n << 96n) | 1n);
    assert.equal(N.parseIpv6('2001:0db8:0000:0000:0000:0000:0000:0001'), N.parseIpv6('2001:db8::1'));
    assert.equal(N.parseIpv6('2001:DB8::1'), N.parseIpv6('2001:db8::1'));
    assert.equal(N.parseIpv6('fe80::1%eth0'), N.parseIpv6('fe80::1'));
    assert.equal(N.parseIpv6('[2001:db8::1]'), N.parseIpv6('2001:db8::1'));
    assert.equal(N.parseIpv6('::ffff:203.0.113.7'), (0xffffn << 32n) | 0xcb007107n);
    assert.equal(N.parseIpv6('1:2:3:4:5:6:7::'), N.parseIpv6('1:2:3:4:5:6:7:0'));
    for (const bad of ['1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1::2::3', '2001:db8::g', '12345::1', '1:2:3:4:5:6:7:8::', '203.0.113.7', '', ':::', '::ffff:999.1.1.1']) assert.equal(N.parseIpv6(bad), null, bad);
});

test('an IPv4 address arriving in IPv6 clothing is treated as IPv4', () => {
    assert.deepEqual(N.parseAddress('::ffff:203.0.113.7'), { version: 4, value: 0xcb007107n });
    assert.deepEqual(N.parseAddress('::ffff:cb00:7107'), { version: 4, value: 0xcb007107n });
    assert.equal(N.tidyAddress('::ffff:127.0.0.1'), '127.0.0.1');
    assert.equal(N.tidyAddress('2001:0DB8:0000:0000:0000:0000:0000:0001'), '2001:db8::1');
    assert.equal(N.tidyAddress('::1'), '::1');
    assert.equal(N.tidyAddress('1:0:0:2:0:0:0:3'), '1:0:0:2::3');
    assert.equal(N.tidyAddress('garbage'), null);
    assert.equal(N.tidyAddress(undefined), null);
    assert.equal(N.parseAddress('::1').version, 6);
});

test('networks: single addresses and ranges, tidied to the start of the range', () => {
    assert.equal(N.parseNetwork('203.0.113.7').text, '203.0.113.7');
    assert.equal(N.parseNetwork('203.0.113.77/24').text, '203.0.113.0/24');
    assert.equal(N.parseNetwork('10.1.2.3/8').text, '10.0.0.0/8');
    assert.equal(N.parseNetwork('203.0.113.7/32').text, '203.0.113.7');
    assert.equal(N.parseNetwork('2001:db8:abcd:12::9/64').text, '2001:db8:abcd:12::/64');
    assert.equal(N.parseNetwork('2001:db8::1').text, '2001:db8::1');
    assert.equal(N.parseNetwork('::ffff:10.0.0.0/104').text, '10.0.0.0/8');
    assert.equal(N.parseNetwork(' 192.168.1.0/24 ').text, '192.168.1.0/24');
    for (const bad of ['203.0.113.0/33', '203.0.113.0/-1', '203.0.113.0/', '203.0.113.0/2x', '2001:db8::/129', 'office wifi', '', '10.0.0.0/8/8', '::ffff:10.0.0.0/64']) assert.equal(N.parseNetwork(bad), null, bad);
});

test('matching: inside and outside, at the edges, never across IPv4 and IPv6', () => {
    const office = ['203.0.113.0/24', '198.51.100.7', '2001:db8:abcd::/48'];
    assert.equal(N.addressInNetworks('203.0.113.0', office), true);
    assert.equal(N.addressInNetworks('203.0.113.255', office), true);
    assert.equal(N.addressInNetworks('203.0.112.255', office), false);
    assert.equal(N.addressInNetworks('203.0.114.0', office), false);
    assert.equal(N.addressInNetworks('198.51.100.7', office), true);
    assert.equal(N.addressInNetworks('198.51.100.8', office), false);
    assert.equal(N.addressInNetworks('::ffff:203.0.113.20', office), true); // what a dual-stack server reports for an IPv4 caller
    assert.equal(N.addressInNetworks('2001:db8:abcd:ffff::1', office), true);
    assert.equal(N.addressInNetworks('2001:db8:abce::1', office), false);
    assert.equal(N.addressInNetworks('::1', ['127.0.0.1']), false);          // loopback v6 is not loopback v4
    assert.equal(N.addressInNetworks('127.0.0.1', ['::1']), false);
    assert.equal(N.addressInNetworks('::1', ['::1']), true);
    assert.equal(N.addressInNetworks('10.20.30.40', ['10.0.0.0/8']), true);
    assert.equal(N.addressInNetworks('11.0.0.0', ['10.0.0.0/8']), false);
    assert.equal(N.addressInNetworks('8.8.8.8', ['8.8.8.8/31']), true);
    assert.equal(N.addressInNetworks('8.8.8.9', ['8.8.8.8/31']), true);
    assert.equal(N.addressInNetworks('8.8.8.10', ['8.8.8.8/31']), false);
    // an address or list that cannot be read is never "inside"
    for (const bad of [undefined, null, '', 'unknown', '203.0.113']) assert.equal(N.addressInNetworks(bad, office), false);
    assert.equal(N.addressInNetworks('203.0.113.5', []), false);
    assert.equal(N.addressInNetworks('203.0.113.5', undefined), false);
    assert.equal(N.addressInNetworks('203.0.113.5', ['nonsense', '203.0.113.0/24']), true);
});

test('the list a company types is cleaned and checked', () => {
    assert.deepEqual(N.validateNetworks('203.0.113.9/24\n198.51.100.7, 2001:DB8::/32\n\n203.0.113.0/24'), { errors: [], value: ['203.0.113.0/24', '198.51.100.7', '2001:db8::/32'] });
    assert.deepEqual(N.validateNetworks(['10.0.0.0/8']), { errors: [], value: ['10.0.0.0/8'] });
    assert.deepEqual(N.validateNetworks(undefined), { errors: [], value: [] });
    assert.match(N.validateNetworks('office wifi').errors[0], /not a network address/);
    assert.match(N.validateNetworks('0.0.0.0/0').errors[0], /allows every address/);
    assert.match(N.validateNetworks('::/0').errors[0], /allows every address/);
    const many = Array.from({ length: 51 }, (_, i) => `10.0.${i}.1`);
    assert.match(N.validateNetworks(many).errors[0], /at most 50/);
});

test('clock rule: the network limit is off unless set, and needs a list when on', () => {
    assert.deepEqual(R.validatePolicy({}).value.network, { mode: 'off', allowed: [] });
    assert.deepEqual(R.validatePolicy({}).errors, []);
    const ok = R.validatePolicy({ network: { mode: 'block', allowed: '203.0.113.77/24\n2001:db8::1' } });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value.network, { mode: 'block', allowed: ['203.0.113.0/24', '2001:db8::1'] });
    assert.match(R.validatePolicy({ network: { mode: 'warn', allowed: [] } }).errors[0], /at least one allowed network/);
    assert.match(R.validatePolicy({ network: { mode: 'sometimes', allowed: ['10.0.0.0/8'] } }).errors[0], /off, warn or block/);
    assert.match(R.validatePolicy({ network: { mode: 'block', allowed: ['not-an-address'] } }).errors[0], /not a network address/);
    // a list may be kept while the limit is off
    assert.deepEqual(R.validatePolicy({ network: { mode: 'off', allowed: ['10.0.0.0/8'] } }).value.network, { mode: 'off', allowed: ['10.0.0.0/8'] });
    assert.deepEqual(R.NETWORK_MODES, ['off', 'warn', 'block']);
});

const policyWith = (network, extra = {}) => ({ ...R.validatePolicy({ network, ...extra }).value, id: 'p1' });
const punch = (policy, over = {}) => R.evaluatePunch({ policy, rules: [], workState: 'TX', type: 'in', source: 'web', statuses: {}, sites: [], nowIso: '2026-11-12T15:00:00Z', tz: 'America/Chicago', userId: 'u1', ...over });

test('clock rule: off does nothing, warn records a flag, block stops the punch', () => {
    const off = punch(policyWith({ mode: 'off', allowed: ['203.0.113.0/24'] }), { ip: '8.8.8.8' });
    assert.deepEqual([off.decision, off.network, off.reasons.length], ['allow', null, 0]);

    const warn = policyWith({ mode: 'warn', allowed: ['203.0.113.0/24'] });
    const inside = punch(warn, { ip: '::ffff:203.0.113.20' });
    assert.deepEqual([inside.decision, inside.network, inside.reasons.length], ['allow', 'inside', 0]);
    const outside = punch(warn, { ip: '8.8.8.8' });
    assert.deepEqual([outside.decision, outside.network, outside.reasons.map((r) => `${r.code}:${r.severity}`)], ['flag', 'outside', ['outside_network:flag']]);
    assert.ok(outside.reasons[0].en && outside.reasons[0].es);

    const block = policyWith({ mode: 'block', allowed: ['203.0.113.0/24'] });
    const stopped = punch(block, { ip: '8.8.8.8' });
    assert.deepEqual([stopped.decision, stopped.network, stopped.reasons.map((r) => `${r.code}:${r.severity}`), stopped.storeLocation], ['block', 'outside', ['outside_network:block'], false]);
    assert.equal(punch(block, { ip: '203.0.113.200' }).decision, 'allow');
    // an address the server could not read is treated as outside (never as a free pass)
    assert.equal(punch(block, { ip: undefined }).decision, 'block');
    assert.equal(punch(warn, { ip: 'unknown' }).decision, 'flag');
    // kiosk punches are checked the same way
    assert.equal(punch(block, { ip: '8.8.8.8', source: 'kiosk' }).decision, 'block');
});

test('clock rule: the network limit follows the punch types of the rule and comes before notices and photos', () => {
    const block = policyWith({ mode: 'block', allowed: ['203.0.113.0/24'] }); // punch types default to in and out
    assert.equal(punch(block, { ip: '8.8.8.8', type: 'out' }).decision, 'block');
    assert.equal(punch(block, { ip: '8.8.8.8', type: 'break_start' }).decision, 'allow');
    const all = policyWith({ mode: 'block', allowed: ['203.0.113.0/24'] }, { punchTypes: ['in', 'out', 'break_start', 'break_end'] });
    assert.equal(punch(all, { ip: '8.8.8.8', type: 'break_start' }).decision, 'block');
    // with a required photo as well: a blocked network is the only reason given, and no notice is asked for
    const both = policyWith({ mode: 'block', allowed: ['203.0.113.0/24'] }, { selfie: 'required', requireNotice: true });
    const out = punch(both, { ip: '8.8.8.8' });
    assert.deepEqual([out.reasons.map((r) => r.code), out.pendingTypes], [['outside_network'], []]);
    // in warn mode the other checks still run, and the flag is kept beside them
    const warnBoth = policyWith({ mode: 'warn', allowed: ['203.0.113.0/24'] }, { selfie: 'required' });
    const w = punch(warnBoth, { ip: '8.8.8.8' });
    assert.deepEqual([w.decision, w.reasons.map((r) => r.code)], ['block', ['outside_network', 'selfie_required']]);
    assert.deepEqual(punch(warnBoth, { ip: '8.8.8.8', hasPhoto: true }).reasons.map((r) => r.code), ['outside_network']);
    // rules saved before this setting existed have no network part and behave as before
    const old = { ...R.validatePolicy({}).value }; delete old.network;
    assert.deepEqual([punch(old, { ip: '8.8.8.8' }).decision, punch(old, { ip: '8.8.8.8' }).network], ['allow', null]);
});

test('a punch sent late has its own wording in English and Spanish', () => {
    assert.equal(R.MSG.sent_late.length, 2);
    assert.equal(R.MSG.outside_network.length, 2);
});
