import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { encryptField, decryptField } = require('../services/pii-crypto.js');
const v = require('../services/us-validation.js');

const goodProfile = () => ({
    legalFirstName: 'Jamie', legalLastName: 'Rivera', dateOfBirth: '1990-04-12',
    homeAddress: { line1: '1 Main St', city: 'Austin', state: 'tx', zip: '78701' },
    workState: 'tx', classification: 'W2', flsaStatus: 'non_exempt', employmentType: 'full_time',
    payType: 'hourly', payFrequency: 'biweekly', payRate: 22.5
});

test('SSN rules: 9 digits, no 000/666/9xx area, no 00 group, no 0000 serial', () => {
    assert.equal(validateOk('123-45-6789'), true);
    assert.equal(v.validateSsn('123456789').last4, '6789');
    for (const bad of ['000-12-3456', '666-12-3456', '912-34-5678', '123-00-4567', '123-45-0000', '12345678', 'abc']) {
        assert.equal(v.validateSsn(bad).valid, false, bad);
    }
    function validateOk(x) { return v.validateSsn(x).valid; }
});

test('ITIN rules', () => {
    assert.equal(v.validateItin('912-70-1234').valid, true);
    assert.equal(v.validateItin('912-69-1234').valid, false);
    assert.equal(v.validateItin('123-70-1234').valid, false);
    assert.equal(v.validateTaxpayerId('912-70-1234', 'ITIN').idType, 'ITIN');
});

test('EIN is formatted NN-NNNNNNN and 00 prefix is rejected', () => {
    assert.equal(v.validateEin('123456789').formatted, '12-3456789');
    assert.equal(v.validateEin('00-1234567').valid, false);
    assert.equal(v.validateEin('12345').valid, false);
});

test('mask shows only the last 4', () => {
    assert.equal(v.maskTaxpayerId('6789'), 'XXX-XX-6789');
    assert.equal(v.maskTaxpayerId(null), null);
});

test('valid W2 hourly profile passes and normalizes state codes', () => {
    const { errors, value } = v.validateEmployeeProfile(goodProfile());
    assert.deepEqual(errors, []);
    assert.equal(value.workState, 'TX');
    assert.equal(value.homeAddress.state, 'TX');
    assert.equal(value.taxpayerIdType, 'SSN');
});

test('profile rules: exempt cannot be hourly, 1099 has no FLSA status, bad enums rejected', () => {
    assert.ok(v.validateEmployeeProfile({ ...goodProfile(), flsaStatus: 'exempt' }).errors.some((e) => /exempt/.test(e)));
    assert.ok(v.validateEmployeeProfile({ ...goodProfile(), classification: '1099' }).errors.some((e) => /W2 employees only/.test(e)));
    assert.ok(v.validateEmployeeProfile({ ...goodProfile(), payFrequency: 'daily' }).errors.some((e) => /payFrequency/.test(e)));
    assert.ok(v.validateEmployeeProfile({ ...goodProfile(), payRate: 0 }).errors.some((e) => /payRate/.test(e)));
    assert.ok(v.validateEmployeeProfile({ ...goodProfile(), workState: 'XX' }).errors.some((e) => /workState/.test(e)));
    assert.ok(v.validateEmployeeProfile({ ...goodProfile(), homeAddress: { line1: 'x', city: 'y', state: 'TX', zip: '123' } }).errors.some((e) => /zip/.test(e)));
});

test('date of birth must be a real past date for someone at least 14', () => {
    assert.ok(v.validateEmployeeProfile({ ...goodProfile(), dateOfBirth: '2999-01-01' }).errors.some((e) => /dateOfBirth/.test(e)));
    assert.ok(v.validateEmployeeProfile({ ...goodProfile(), dateOfBirth: '1990-02-30' }).errors.some((e) => /dateOfBirth/.test(e)));
    const young = new Date(); young.setUTCFullYear(young.getUTCFullYear() - 10);
    assert.ok(v.validateEmployeeProfile({ ...goodProfile(), dateOfBirth: young.toISOString().slice(0, 10) }).errors.some((e) => /dateOfBirth/.test(e)));
});

test('company profile validation', () => {
    const ok = v.validateCompanyProfile({
        ein: '12-3456789', entityType: 'llc', legalName: 'Acme LLC',
        businessAddress: { line1: '5 Elm', city: 'Dallas', state: 'TX', zip: '75001' }, workStates: ['tx', 'TX', 'ok']
    });
    assert.deepEqual(ok.errors, []);
    assert.deepEqual(ok.value.workStates, ['TX', 'OK']);
    assert.ok(v.validateCompanyProfile({}).errors.length >= 4);
});

test('encryption round trip; ciphertext differs each time and hides the value', () => {
    const a = encryptField('123456789', 'org1:emp1');
    const b = encryptField('123456789', 'org1:emp1');
    assert.notEqual(a, b);
    assert.ok(!a.includes('123456789'));
    assert.equal(decryptField(a, 'org1:emp1'), '123456789');
    assert.equal(encryptField('', 'x'), null);
});

test('ciphertext cannot be moved to another record or tampered with', () => {
    const a = encryptField('123456789', 'org1:emp1');
    assert.throws(() => decryptField(a, 'org1:emp2'));
    const parts = a.split(':'); parts[3] = Buffer.from('tampered').toString('base64');
    assert.throws(() => decryptField(parts.join(':'), 'org1:emp1'));
    assert.throws(() => decryptField('garbage', 'x'));
});

test('production refuses to run without a real key', () => {
    const prevEnv = process.env.NODE_ENV; const prevKey = process.env.PII_ENCRYPTION_KEY;
    process.env.NODE_ENV = 'production'; delete process.env.PII_ENCRYPTION_KEY;
    assert.throws(() => encryptField('123456789', 'x'), /required in production/);
    process.env.PII_ENCRYPTION_KEY = Buffer.alloc(16).toString('base64');
    assert.throws(() => encryptField('123456789', 'x'), /32 bytes/);
    process.env.NODE_ENV = prevEnv; if (prevKey === undefined) delete process.env.PII_ENCRYPTION_KEY; else process.env.PII_ENCRYPTION_KEY = prevKey;
});
