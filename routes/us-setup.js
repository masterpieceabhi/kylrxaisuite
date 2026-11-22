/**
 * Getting started: the few things a new US company sets up once, each checked from its own data, so Home can show
 * the owner (or HR) a short list with a button for each step that is not done yet. Nothing is stored here.
 *
 *   GET /api/us/setup/status -> { steps: [{ key, title, why, href, done, optional }], done, required }
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { requireUsOrg } = require('./us-hr').helpers;
const { requireAnyPermission } = require('../services/permissions');
const P = require('./../services/policy-rules');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const byOrg = async (name, orgId) => {
    try { return (await rawCollection(name).where('orgId', '==', orgId).get()).docs.map((d) => ({ id: d.id, ...d.data() })); } catch (_) { return []; }
};

/** The steps, in the order they are best done; pure so it can be tested with plain data */
function setupSteps(d) {
    const org = d.org || {};
    const us = org.usProfile || {};
    const activeUsers = (d.users || []).filter((u) => !/^(terminated|inactive|offboarded)$/i.test(String(u.status || 'Active')));
    const handbook = (d.policies || []).some((p) => p.status === 'published' && P.ackState(p, []).needed);
    const steps = [
        { key: 'company', title: 'Company details and EIN', why: 'Your legal name, EIN and address go on tax forms and notices.', href: 'admin-us-people.html', done: Boolean(us.ein && us.legalName) },
        { key: 'location', title: 'Your work location', why: 'Sets the time zone, state rules and the clock-in area.', href: 'admin-us-org.html', done: (d.locations || []).some((l) => l.active !== false) },
        { key: 'pay_schedule', title: 'Pay schedule', why: 'How often people are paid; pay periods and timesheets follow it.', href: 'admin-us-pay-schedule.html', done: (d.paySchedules || []).length > 0 },
        { key: 'team', title: 'Add your team', why: 'Each person gets a set-up link to sign in and fill in their own forms.', href: 'admin-us-team-import.html', done: activeUsers.length > 1 },
        { key: 'time_off', title: 'Time off policy', why: 'Lets people ask for days off and see their balance.', href: 'admin-us-leave.html', done: (d.leavePolicies || []).some((p) => p.active !== false) },
        { key: 'handbook', title: 'Publish your handbook', why: 'New hires read and confirm it as part of their onboarding.', href: 'admin-us-policies.html', done: handbook },
        { key: 'payroll', title: 'Connect Gusto for payroll', why: 'Approved hours go to Gusto, where payroll is run.', href: 'admin-us-payroll.html', done: Boolean(d.gusto && d.gusto.status === 'connected') },
        { key: 'benefits', title: 'Benefit plans', why: 'Only if you offer benefits: new hires can then choose them in their first 30 days.', href: 'admin-us-benefits.html', done: (d.benefitPlans || []).some((p) => p.active !== false), optional: true }
    ];
    const required = steps.filter((s) => !s.optional);
    return { steps, done: required.filter((s) => s.done).length, required: required.length };
}

router.get('/setup/status', requireAnyPermission('org.settings', 'people.write', 'security.manage'), requireUsOrg, async (req, res) => {
    const orgId = req.orgId;
    const [users, locations, paySchedules, leavePolicies, policies, benefitPlans, gustoSnap] = await Promise.all([
        byOrg('users', orgId), byOrg('locations', orgId), byOrg('pay_schedules', orgId), byOrg('leave_policies', orgId),
        byOrg('policies', orgId), byOrg('benefit_plans', orgId),
        rawCollection('gusto_connections').doc(String(orgId)).get().catch(() => null)
    ]);
    const gusto = gustoSnap && exists(gustoSnap) ? gustoSnap.data() : null;
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...setupSteps({ org: req.org, users, locations, paySchedules, leavePolicies, policies, benefitPlans, gusto }) });
});

module.exports = router;
module.exports.setupSteps = setupSteps;
