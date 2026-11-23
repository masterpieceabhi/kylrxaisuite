// Fill-in and checking helpers used on My details (us-smart-fill.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPhone, stateForZip, routingLooksRight, CHOICES } from '../us-smart-fill.js';

test('a US phone number is shown as (414) 213-4642 however it is typed', () => {
    for (const typed of ['4142134642', '414-213-4642', '(414)2134642', '+1 414 213 4642', '1-414-213-4642']) assert.equal(formatPhone(typed), '(414) 213-4642', typed);
    assert.equal(formatPhone('414'), '414');
    assert.equal(formatPhone('41421'), '(414) 21');
    assert.equal(formatPhone('+44 20 7946 0958'), '+44 20 7946 0958', 'a number that is not a US one is left as typed');
    assert.equal(formatPhone('call me'), 'call me');
    assert.equal(formatPhone(''), '');
});

test('a ZIP code fills in its state', () => {
    for (const [zip, st] of [['95113', 'CA'], ['53202', 'WI'], ['78701', 'TX'], ['73301', 'TX'], ['10001', 'NY'], ['02108', 'MA'], ['20500', 'DC'], ['20166', 'VA'], ['96813', 'HI'], ['99501', 'AK'], ['00901', 'PR'], ['60601-1234', 'IL'], ['88510', 'TX']]) {
        assert.equal(stateForZip(zip), st, zip);
    }
    for (const unknown of ['', '1234', '09012', '96201', 'abcde', '999999']) assert.equal(stateForZip(unknown), '', unknown);
});

test('a routing number is checked with its check digit', () => {
    for (const good of ['021000021', '026009593', '121000248', '011000015']) assert.equal(routingLooksRight(good), true, good);
    for (const bad of ['021000022', '123456789', '000000000', '02100002', '', 'abcdefghi']) assert.equal(routingLooksRight(bad), false, bad);
});

test('choices exist in English and Spanish for every box that offers them', () => {
    for (const k of ['relationship', 'legalName', 'homeAddress', 'bankDetails']) {
        assert.ok(CHOICES.en[k].length >= 3, k);
        assert.ok(CHOICES.es[k].length >= 3, k);
    }
});
