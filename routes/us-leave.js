const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { requireUsOrg, findEmployee, audit, exists } = require('./us-hr').helpers;
const { orgInfo, punchesSince } = require('./time').helpers;
const timeRules = require('../services/time-rules');
const L = require('../services/leave-rules');
const { parseIsoDate, isoDate } = require('../services/us-forms');
const perms = require('../services/permissions');
const teamScope = require('../services/team-scope');
const LEAVE_DECIDER = perms.requireAnyPermission('leave.decide', 'leave.decide_team');
const LEAVE_VIEWER = perms.requireAnyPermission('leave.decide', 'leave.decide_team', 'leave.view_all');

const MANAGER_ROLES = [...ADMIN_HR_ROLES, 'Manager', 'manager'];
const ACTIVE = ['pending', 'approved'];

router.use(verifyToken);

const norm = (r) => String(r || '').toLowerCase().replace(/[\s_-]+/g, '');
const hasRole = (user, list) => list.some((r) => norm(r) === norm(user.role));
const todayIn = (tz) => timeRules.localDate(new Date().toISOString(), tz);
const hireDateOf = (emp) => {
    const raw = (emp.data.usProfile && emp.data.usProfile.startDate) || emp.data.joiningDate || '';
    const d = String(raw).slice(0, 10);
    return parseIsoDate(d) ? d : null;
};

async function loadPolicies(orgId) {
    const snap = await rawCollection('leave_policies').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.active !== false);
}

async function loadRequests(orgId, field, value) {
    const snap = await rawCollection('leave_requests').where(field, '==', value).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.orgId === orgId);
}

/** Balance of one policy for one person as of today; `excludeRequestId` ignores that pending request */
async function balanceFor(orgId, emp, policy, info, { excludeRequestId } = {}) {
    const asOf = todayIn(info.tz);
    const hireDate = hireDateOf(emp);
    if (!hireDate) return { error: 'no_start_date' };
    const [requests, adjSnap] = await Promise.all([
        loadRequests(orgId, 'userId', emp.id),
        rawCollection('leave_adjustments').where('userId', '==', emp.id).get()
    ]);
    const mine = requests.filter((r) => r.policyId === policy.id && r.id !== excludeRequestId);
    const usage = mine.filter((r) => r.status === 'approved').flatMap((r) => r.dates.map((date) => ({ date, hours: r.hoursPerDay })));
    const pendingHours = mine.filter((r) => r.status === 'pending').reduce((s, r) => s + Number(r.hours), 0);
    const adjustments = adjSnap.docs.map((d) => d.data()).filter((a) => a.orgId === orgId && a.policyId === policy.id);

    const workedByDay = {};
    if (policy.accrual.method === 'hours_worked') {
        const profile = emp.data.usProfile || {};
        if (profile.flsaStatus === 'exempt') {
            // Exempt staff are not clocked; count 8 hours for each weekday since the start date
            for (let d = hireDate; d <= asOf; d = L.addDays(d, 1)) {
                const dow = parseIsoDate(d).getUTCDay();
                if (dow !== 0 && dow !== 6) workedByDay[d] = 8;
            }
        } else {
            const punches = await punchesSince(orgId, emp.id, new Date(`${hireDate}T00:00:00Z`).toISOString());
            const sheet = timeRules.timesheet(punches, info.tz, new Date().toISOString(), null);
            sheet.days.forEach((d) => { workedByDay[d.date] = d.workedMinutes / 60; });
        }
    }
    const balance = L.simulate(policy, { hireDate, asOf, workedByDay, usage, adjustments, pendingHours });
    return { balance, asOf };
}

const publicPolicy = (p) => ({
    id: p.id, name: p.name, type: p.type, accrual: p.accrual, annualAccrualCap: p.annualAccrualCap, annualUseCap: p.annualUseCap,
    maxBalance: p.maxBalance, carryoverCap: p.carryoverCap, usageWaitingDays: p.usageWaitingDays, accrualStartsAfterDays: p.accrualStartsAfterDays,
    minimumIncrementHours: p.minimumIncrementHours, allowNegative: p.allowNegative, payoutAtTermination: p.payoutAtTermination,
    skipHolidays: p.skipHolidays, policyYearStart: p.policyYearStart, appliesTo: p.appliesTo, notes: p.notes
});

/* ---------------------------------- policies ---------------------------------- */

router.get('/leave/policies/presets', requireUsOrg, (req, res) => {
    res.json({ success: true, note: 'Starting points only. Paid sick leave rules differ by state and city: confirm every number with a US compliance advisor.', data: L.PRESETS });
});

router.get('/leave/policies', requireUsOrg, async (req, res) => {
    res.json({ success: true, data: (await loadPolicies(req.orgId)).map(publicPolicy) });
});

router.post('/leave/policies', perms.requirePermission('leave.policies'), requireUsOrg, async (req, res) => {
    const { errors, value } = L.validatePolicy(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ref = await rawCollection('leave_policies').add({ ...value, orgId: req.orgId, active: true, createdAt: new Date().toISOString(), createdBy: req.user.id });
    audit(req.orgId, req, 'leave_policy_created', ref.id, { name: value.name, type: value.type });
    res.status(201).json({ success: true, policy: publicPolicy({ id: ref.id, ...value }) });
});

router.put('/leave/policies/:id', perms.requirePermission('leave.policies'), requireUsOrg, async (req, res) => {
    const ref = rawCollection('leave_policies').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Policy not found' });
    const { errors, value } = L.validatePolicy({ ...snap.data(), ...req.body });
    if (errors.length) return res.status(400).json({ success: false, errors });
    await ref.set({ ...value, updatedAt: new Date().toISOString(), updatedBy: req.user.id }, { merge: true });
    audit(req.orgId, req, 'leave_policy_updated', ref.id, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, policy: publicPolicy({ id: ref.id, ...value }) });
});

router.delete('/leave/policies/:id', perms.requirePermission('leave.policies'), requireUsOrg, async (req, res) => {
    const ref = rawCollection('leave_policies').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Policy not found' });
    await ref.update({ active: false, archivedAt: new Date().toISOString() });
    audit(req.orgId, req, 'leave_policy_archived', ref.id);
    res.json({ success: true });
});

/* ---------------------------------- balances ---------------------------------- */

async function balancesResponse(req, res, targetId) {
    const emp = await findEmployee(req.orgId, targetId);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const info = await orgInfo(req.orgId);
    const profile = emp.data.usProfile || {};
    const policies = (await loadPolicies(req.orgId)).filter((p) => L.appliesTo(p, profile));
    const rows = [];
    for (const p of policies) {
        const r = await balanceFor(req.orgId, emp, p, info);
        rows.push({ policy: publicPolicy(p), ...(r.error ? { error: r.error } : { balance: r.balance }) });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, userId: emp.id, name: emp.data.name || null, asOf: todayIn(info.tz), data: rows });
}

router.get('/leave/balances', requireUsOrg, (req, res) => balancesResponse(req, res, req.user.id));

router.get('/leave/balances/:userId', requireUsOrg, async (req, res) => {
    if (req.params.userId !== req.user.id && !perms.can(req.user, 'leave.view_all')) {
        const person = await findEmployee(req.orgId, req.params.userId);
        if (!person || !perms.canManage(req.user, { ...person.data, id: person.id }, 'leave')) return res.status(403).json({ success: false, error: 'Not allowed' });
    }
    return balancesResponse(req, res, req.params.userId);
});

/* ---------------------------------- requests ---------------------------------- */

router.post('/leave/requests', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.user.id);
    if (!emp) return res.status(404).json({ success: false, error: 'No employee record for this login' });
    const pSnap = await rawCollection('leave_policies').doc(String((req.body && req.body.policyId) || '_')).get();
    if (!exists(pSnap) || pSnap.data().orgId !== req.orgId || pSnap.data().active === false) return res.status(404).json({ success: false, error: 'Policy not found' });
    const policy = { id: pSnap.id, ...pSnap.data() };
    if (!L.appliesTo(policy, emp.data.usProfile)) return res.status(403).json({ success: false, error: 'This leave does not apply to you' });

    const info = await orgInfo(req.orgId);
    const bal = await balanceFor(req.orgId, emp, policy, info);
    if (bal.error) return res.status(409).json({ success: false, error: 'Your start date is not on file. Ask HR.' });
    const mine = (await loadRequests(req.orgId, 'userId', emp.id)).filter((r) => ACTIVE.includes(r.status));
    const { errors, value } = L.validateRequest(policy, req.body, bal.balance, bal.asOf, mine.flatMap((r) => r.dates));
    if (errors.length) return res.status(400).json({ success: false, errors });

    const doc = {
        orgId: req.orgId, userId: emp.id, employeeId: emp.data.employeeId || null, name: emp.data.name || null,
        policyId: policy.id, policyName: policy.name, type: policy.type,
        startDate: value.dates[0], endDate: value.dates[value.dates.length - 1], dates: value.dates,
        hoursPerDay: value.hoursPerDay, hours: value.hours, reason: String((req.body && req.body.reason) || '').slice(0, 300),
        status: 'pending', createdAt: new Date().toISOString()
    };
    const ref = await rawCollection('leave_requests').add(doc);
    audit(req.orgId, req, 'leave_requested', ref.id, { policy: policy.name, hours: value.hours });
    res.status(201).json({ success: true, request: { id: ref.id, ...doc } });
});

router.get('/leave/requests', requireUsOrg, async (req, res) => {
    const scope = String(req.query.scope || 'mine');
    let rows;
    if (scope === 'mine') rows = await loadRequests(req.orgId, 'userId', req.user.id);
    else {
        if (!perms.can(req.user, 'leave.decide') && !perms.can(req.user, 'leave.decide_team') && !perms.can(req.user, 'leave.view_all')) return res.status(403).json({ success: false, error: 'Not allowed' });
        const snap = await rawCollection('leave_requests').where('orgId', '==', req.orgId).get();
        rows = await teamScope.filterRows(req.user, req.orgId, snap.docs.map((d) => ({ id: d.id, ...d.data() })), 'leave');
    }
    if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, count: rows.length, data: rows.slice(0, 300) });
});

router.put('/leave/requests/:id/decision', LEAVE_DECIDER, requireUsOrg, async (req, res) => {
    const decision = String((req.body && req.body.decision) || '');
    if (!['approve', 'deny'].includes(decision)) return res.status(400).json({ success: false, error: 'decision must be approve or deny' });
    const ref = rawCollection('leave_requests').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Request not found' });
    const r = { id: snap.id, ...snap.data() };
    if (r.userId === req.user.id) return res.status(403).json({ success: false, error: 'You cannot decide your own request' });
    const owner = await findEmployee(req.orgId, r.userId);
    if (!owner || !perms.canManage(req.user, { ...owner.data, id: owner.id }, 'leave')) return res.status(403).json({ success: false, error: 'You can only decide time off for people who report to you' });
    if (r.status !== 'pending') return res.status(409).json({ success: false, error: `This request is already ${r.status}` });

    if (decision === 'approve') {
        const emp = await findEmployee(req.orgId, r.userId);
        const pSnap = await rawCollection('leave_policies').doc(r.policyId).get();
        if (emp && exists(pSnap)) {
            const policy = { id: pSnap.id, ...pSnap.data() };
            const info = await orgInfo(req.orgId);
            const bal = await balanceFor(req.orgId, emp, policy, info, { excludeRequestId: r.id });
            if (!bal.error && !policy.allowNegative && r.hours > bal.balance.availableBalance + 1e-9) {
                return res.status(409).json({ success: false, error: `Not enough balance any more: ${bal.balance.availableBalance} hours available, ${r.hours} requested` });
            }
        }
    }
    const patch = { status: decision === 'approve' ? 'approved' : 'denied', decidedBy: req.user.id, decidedAt: new Date().toISOString(), decisionNote: String((req.body && req.body.note) || '').slice(0, 300) };
    await ref.update(patch);
    audit(req.orgId, req, decision === 'approve' ? 'leave_approved' : 'leave_denied', r.id, { userId: r.userId, hours: r.hours });
    res.json({ success: true, request: { ...r, ...patch } });
});

router.post('/leave/requests/:id/cancel', requireUsOrg, async (req, res) => {
    const ref = rawCollection('leave_requests').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Request not found' });
    const r = { id: snap.id, ...snap.data() };
    const isOwner = r.userId === req.user.id;
    if (!isOwner && !hasRole(req.user, ADMIN_HR_ROLES)) return res.status(403).json({ success: false, error: 'Not allowed' });
    if (!ACTIVE.includes(r.status)) return res.status(409).json({ success: false, error: `This request is already ${r.status}` });
    const info = await orgInfo(req.orgId);
    if (isOwner && r.status === 'approved' && r.startDate <= todayIn(info.tz)) {
        return res.status(409).json({ success: false, error: 'This time off has already started. Ask HR to change it.' });
    }
    await ref.update({ status: 'cancelled', cancelledBy: req.user.id, cancelledAt: new Date().toISOString() });
    audit(req.orgId, req, 'leave_cancelled', r.id, { userId: r.userId });
    res.json({ success: true });
});

/* ------------------------------ adjustments and calendar ------------------------------ */

router.post('/leave/adjustments', perms.requirePermission('leave.decide'), requireUsOrg, async (req, res) => {
    const { userId, policyId, hours, reason } = req.body || {};
    const h = Number(hours);
    if (!Number.isFinite(h) || h === 0 || Math.abs(h) > 400) return res.status(400).json({ success: false, error: 'hours must be a non-zero number (negative removes time)' });
    if (String(reason || '').trim().length < 5) return res.status(400).json({ success: false, error: 'A reason of at least 5 characters is required' });
    const emp = await findEmployee(req.orgId, String(userId || ''));
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const pSnap = await rawCollection('leave_policies').doc(String(policyId || '_')).get();
    if (!exists(pSnap) || pSnap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Policy not found' });
    const info = await orgInfo(req.orgId);
    await rawCollection('leave_adjustments').add({
        orgId: req.orgId, userId: emp.id, policyId: pSnap.id, hours: h, date: todayIn(info.tz), reason: String(reason).slice(0, 300),
        createdBy: req.user.id, createdAt: new Date().toISOString()
    });
    audit(req.orgId, req, 'leave_balance_adjusted', emp.id, { policy: pSnap.data().name, hours: h, reason: String(reason).slice(0, 200) });
    res.status(201).json({ success: true });
});

/** Who is off on which days (approved and pending), for coverage planning */
router.get('/leave/calendar', LEAVE_VIEWER, requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const today = todayIn(info.tz);
    const from = parseIsoDate(req.query.from) ? req.query.from : today;
    const to = parseIsoDate(req.query.to) ? req.query.to : isoDate(new Date(new Date(`${from}T00:00:00Z`).getTime() + 30 * 86400000));
    const snap = await rawCollection('leave_requests').where('orgId', '==', req.orgId).get();
    const rows = (await teamScope.filterRows(req.user, req.orgId, snap.docs.map((d) => ({ id: d.id, ...d.data() })), 'leave'))
        .filter((r) => ACTIVE.includes(r.status) && r.endDate >= from && r.startDate <= to)
        .map((r) => ({ id: r.id, name: r.name, employeeId: r.employeeId, type: r.type, policyName: r.policyName, status: r.status, startDate: r.startDate, endDate: r.endDate, hours: r.hours }))
        .sort((a, b) => a.startDate.localeCompare(b.startDate));
    res.json({ success: true, from, to, data: rows });
});

// Shared with offboarding (final leave balances)
router.helpers = { balanceFor, loadPolicies, hireDateOf };

module.exports = router;
