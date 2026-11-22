// Getting started on Home: each one-time setup step is ticked off from the company's own data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const { setupSteps } = require('../routes/us-setup.js');

test('a new company has every step to do', () => {
    const s = setupSteps({ org: {}, users: [{ status: 'Active' }] });
    assert.equal(s.done, 0);
    assert.equal(s.required, 7);
    assert.equal(s.steps.find((x) => x.key === 'benefits').optional, true);
    assert.ok(s.steps.every((x) => x.href && x.title && x.why));
});

test('each step follows its own data', () => {
    const published = { status: 'published', versions: [{ version: 1, requireAck: true, publishedAt: '2026-11-01' }], currentVersion: 1 };
    const s = setupSteps({
        org: { usProfile: { ein: '12-3456789', legalName: 'Acme LLC' } }, users: [{}, {}, { status: 'Terminated' }],
        locations: [{ active: true }], paySchedules: [{}], leavePolicies: [{}], policies: [published], benefitPlans: [], gusto: { status: 'connected' }
    });
    const done = Object.fromEntries(s.steps.map((x) => [x.key, x.done]));
    assert.equal(done.company, true); assert.equal(done.location, true); assert.equal(done.pay_schedule, true);
    assert.equal(done.team, true); assert.equal(done.time_off, true); assert.equal(done.payroll, true); assert.equal(done.handbook, true); assert.equal(done.benefits, false);
    assert.equal(setupSteps({ org: { usProfile: { legalName: 'Acme LLC' } } }).steps[0].done, false, 'no EIN yet');
    assert.equal(setupSteps({ gusto: { status: 'disconnected' } }).steps.find((x) => x.key === 'payroll').done, false);
});

test('Home shows the card for the owner and HR, and the install script updates itself', () => {
    const home = fs.readFileSync(new URL('../us-home.html', import.meta.url), 'utf8');
    assert.match(home, /\/api\/us\/setup\/status/);
    assert.match(fs.readFileSync(new URL('../routes/us-people-data.js', import.meta.url), 'utf8'), /require\('\.\/us-setup'\)/);
    assert.match(fs.readFileSync(new URL('../deploy/install-release.sh', import.meta.url), 'utf8'), /cmp -s "\$fresh" "\$self"/);
});
