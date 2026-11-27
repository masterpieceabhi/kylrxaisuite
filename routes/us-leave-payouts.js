/**
 * Paying out unused time off (PTO) into pay. Mounted from routes/us-leave.js (which checks the sign-in).
 *
 *   HR or payroll asks for a payout for a person (a leaver, or anyone chosen)  -> pending
 *   someone with payroll.run approves it (never the person being paid)        -> approved
 *   payroll reads the approved list (JSON or CSV), pays it, marks it paid      -> paid (the hours come off the balance)
 *
 * Whether unused time must be paid is state law plus company policy: each leave policy has its own "paid out" switch
 * and the company sets the salary divisor here. Collections: leave_payouts, leave_payout_settings (every doc has orgId).
 */
const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const { requireUsOrg, findEmployee, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const timeRules = require('../services/time-rules');
const L = require('../services/leave-rules');
const R = require('../services/leave-payout-rules');
const perms = require('../services/permissions');

const VIEW = perms.requireAnyPermission('payroll.view');
const ASK = perms.requireAnyPermission('leave.decide', 'payroll.run');
const PAYROLL = perms.requirePermission('payroll.run');

const now = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
// routes/us-leave.js loads this file, so its helpers are looked up when a request arrives, not at load time
const leaveHelpers = () => require('./us-leave').helpers;

async function getSettings(orgId) {
    const snap = await rawCollection('leave_payout_settings').doc(orgId).get();
    const d = exists(snap) && snap.data().orgId === orgId ? snap.data() : {};
    return { ...R.normalizeSettings(d), updatedAt: d.updatedAt || null };
}

/** The payout numbers for a person as of today */
async function compute(orgId, emp) {
    const { balanceFor, loadPolicies } = leaveHelpers();
    const info = await orgInfo(orgId);
    const profile = emp.data.usProfile || {};
    const policies = (await loadPolicies(orgId)).filter((p) => L.appliesTo(p, profile));
    const balances = []; const skipped = [];
    for (const p of policies) {
        const r = await balanceFor(orgId, emp, p, info);
        if (r.error) { skipped.push({ policyId: p.id, policyName: p.name, reason: r.error === 'no_start_date' ? 'The start date is not on file' : r.error }); continue; }
        balances.push({ policyId: p.id, policyName: p.name, type: p.type, payoutAtTermination: p.payoutAtTermination, balanceHours: r.balance.balance });
    }
    const settings = await getSettings(orgId);
    const out = R.computePayout({ balances, profile, settings });
    return { ...out, skipped, settings, asOf: timeRules.localDate(now(), info.tz) };
}

async function listPayouts(orgId) {
    const snap = await rawCollection('leave_payouts').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.orgId === orgId);
}

async function ownPayout(orgId, id) {
    const ref = rawCollection('leave_payouts').doc(String(id));
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== orgId) return null;
    return { ref, data: { id: snap.id, ...snap.data() } };
}

const personLabel = (emp) => ({ userId: emp.id, employeeId: emp.data.employeeId || null, name: emp.data.name || null, leaving: Boolean(emp.data.usProfile && emp.data.usProfile.termination), lastDay: (emp.data.usProfile && emp.data.usProfile.termination && emp.data.usProfile.termination.lastDay) || null });

// ------------------------------------------------------------------ settings
router.get('/leave/payout-settings', VIEW, requireUsOrg, async (req, res) => {
    res.json({ success: true, settings: await getSettings(req.orgId), defaults: { salaryHoursPerYear: R.DEFAULT_SALARY_HOURS_PER_YEAR }, note: R.ADVISOR_NOTE });
});

router.put('/leave/payout-settings', perms.requirePermission('leave.policies'), requireUsOrg, async (req, res) => {
    const { errors, value } = R.validateSettings(req.body);
    if (errors.length) return invalid(res, errors);
    const cur = await getSettings(req.orgId);
    const expected = req.body && req.body.expectedUpdatedAt;
    if (expected && cur.updatedAt && expected !== cur.updatedAt) return fail(res, 409, 'Someone else changed this setting. Reload and try again.');
    const updatedAt = now();
    await rawCollection('leave_payout_settings').doc(req.orgId).set({ orgId: req.orgId, ...value, updatedAt, updatedBy: req.user.id || null }, { merge: true });
    audit(req.orgId, req, 'leave_payout_settings_updated', req.orgId, { from: cur.salaryHoursPerYear, to: value.salaryHoursPerYear });
    res.json({ success: true, settings: { ...R.normalizeSettings(value), updatedAt }, note: R.ADVISOR_NOTE });
});

// ------------------------------------------------------- list for the payroll side
/** Approved and not yet paid. `?format=csv` gives a file. This is what payroll adds to the next pay run. */
async function approvedList(req, res, asCsv) {
    const rows = (await listPayouts(req.orgId)).filter((p) => p.status === 'approved').sort((a, b) => String(a.approvedAt).localeCompare(String(b.approvedAt))).map(R.payrollRow);
    const total = Math.round(rows.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100;
    audit(req.orgId, req, asCsv ? 'leave_payouts_exported' : 'leave_payouts_approved_viewed', null, { rows: rows.length });
    res.set('Cache-Control', 'no-store');
    if (asCsv) return res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="pto-payouts-to-pay.csv"').send(R.toCsv(rows));
    return res.json({ success: true, count: rows.length, totalAmount: total, data: rows, note: R.ADVISOR_NOTE });
}
router.get('/leave/payouts/approved', VIEW, requireUsOrg, (req, res) => approvedList(req, res, req.query.format === 'csv'));
router.get('/leave/payouts/approved.csv', VIEW, requireUsOrg, (req, res) => approvedList(req, res, true));

// ------------------------------------------------------------------ preview
router.get('/leave/payouts/preview/:userId', VIEW, requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.userId);
    if (!emp) return fail(res, 404, 'Employee not found');
    const c = await compute(req.orgId, emp);
    audit(req.orgId, req, 'leave_payout_previewed', emp.id, {});
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, person: personLabel(emp), asOf: c.asOf, canRequest: c.errors.length === 0, problems: c.errors, skipped: c.skipped, ...c.value, salaryHoursPerYear: c.settings.salaryHoursPerYear, note: R.ADVISOR_NOTE });
});

// ----------------------------------------------------------------- requests
router.get('/leave/payouts', VIEW, requireUsOrg, async (req, res) => {
    let rows = await listPayouts(req.orgId);
    if (req.query.status) rows = rows.filter((p) => p.status === req.query.status);
    if (req.query.userId) rows = rows.filter((p) => p.userId === req.query.userId);
    rows.sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, count: rows.length, data: rows.slice(0, 300), canAsk: perms.can(req.user, 'leave.decide') || perms.can(req.user, 'payroll.run'), canApprove: perms.can(req.user, 'payroll.run'), note: R.ADVISOR_NOTE });
});

router.post('/leave/payouts', ASK, requireUsOrg, async (req, res) => {
    const { errors, value } = R.validateRequest(req.body);
    if (errors.length) return invalid(res, errors);
    const emp = await findEmployee(req.orgId, value.userId);
    if (!emp) return fail(res, 404, 'Employee not found');
    if (emp.id === req.user.id) return fail(res, 403, 'You cannot ask for your own payout');
    const c = await compute(req.orgId, emp);
    if (c.errors.length) return fail(res, 409, c.errors.join('; '));
    const doc = {
        orgId: req.orgId, userId: emp.id, employeeId: emp.data.employeeId || null, name: emp.data.name || null,
        reason: value.reason, note: value.note, asOf: c.asOf, lines: c.value.lines, hours: c.value.hours, hourlyRate: c.value.hourlyRate,
        rateBasis: c.value.rateBasis, amount: c.value.amount, status: 'pending', requestedBy: req.user.id || null, requestedAt: now()
    };
    // One open payout per person: the lock doc is taken in a transaction so two people asking at once cannot both succeed
    const lockRef = rawCollection('leave_payout_locks').doc(`${req.orgId}__${emp.id}`);
    const ref = rawCollection('leave_payouts').doc();
    const taken = await db.runTransaction(async (tx) => {
        const lock = await tx.get(lockRef);
        if (lock.exists && lock.data().payoutId) {
            const open = await tx.get(rawCollection('leave_payouts').doc(lock.data().payoutId));
            if (open.exists && open.data().orgId === req.orgId && R.OPEN_STATUSES.includes(open.data().status)) return true;
        }
        tx.set(ref, doc);
        tx.set(lockRef, { orgId: req.orgId, userId: emp.id, payoutId: ref.id, at: doc.requestedAt });
        return false;
    });
    if (taken) return fail(res, 409, 'This person already has a payout waiting. Finish or cancel it first.');
    audit(req.orgId, req, 'leave_payout_requested', ref.id, { userId: emp.id, hours: doc.hours, amount: doc.amount, reason: doc.reason });
    res.status(201).json({ success: true, payout: { id: ref.id, ...doc }, note: R.ADVISOR_NOTE });
});

/**
 * Moves a payout to its next status inside a transaction, so two people clicking at once cannot both win.
 * Returns the updated payout, or null when it could not be moved (the error answer has then already been sent).
 */
async function move(req, res, action, { extra = {}, check } = {}) {
    const found = await ownPayout(req.orgId, req.params.id);
    if (!found) { fail(res, 404, 'Payout not found'); return null; }
    if (check) { const stop = await check(found.data); if (stop) { fail(res, stop.code, stop.error); return null; } }
    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(found.ref);
        const cur = snap.data();
        const t = R.transition(cur.status, action);
        if (t.error) return { error: t.error };
        const patch = { status: t.to, ...extra };
        tx.set(found.ref, patch, { merge: true });
        return { payout: { id: snap.id, ...cur, ...patch } };
    });
    if (result.error) { fail(res, 409, result.error); return null; }
    return result.payout;
}

router.post('/leave/payouts/:id/approve', PAYROLL, requireUsOrg, async (req, res) => {
    const payout = await move(req, res, 'approve', {
        extra: { approvedBy: req.user.id || null, approvedAt: now() },
        check: async (p) => {
            if (p.userId === req.user.id) return { code: 403, error: 'You cannot approve your own payout' };
            if (p.status !== 'pending') return null; // the transaction gives the exact message
            const emp = await findEmployee(req.orgId, p.userId);
            if (!emp) return { code: 409, error: 'This person is no longer on file' };
            const c = await compute(req.orgId, emp);
            if (c.errors.length || !R.sameNumbers(p, c.value)) return { code: 409, error: 'The balance or pay rate changed since this was asked for. Reject it and ask again so the numbers are right.' };
            return null;
        }
    });
    if (!payout) return undefined;
    audit(req.orgId, req, 'leave_payout_approved', payout.id, { userId: payout.userId, hours: payout.hours, amount: payout.amount });
    return res.json({ success: true, payout });
});

router.post('/leave/payouts/:id/reject', PAYROLL, requireUsOrg, async (req, res) => {
    const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
    if (note.length < 5) return invalid(res, ['A note of at least 5 characters is required when rejecting']);
    const payout = await move(req, res, 'reject', { extra: { rejectedBy: req.user.id || null, rejectedAt: now(), decisionNote: note } });
    if (!payout) return undefined;
    audit(req.orgId, req, 'leave_payout_rejected', payout.id, { userId: payout.userId });
    return res.json({ success: true, payout });
});

/** HR or payroll can withdraw a payout that has not been paid yet */
router.post('/leave/payouts/:id/cancel', ASK, requireUsOrg, async (req, res) => {
    const payout = await move(req, res, 'cancel', { extra: { cancelledBy: req.user.id || null, cancelledAt: now() } });
    if (!payout) return undefined;
    audit(req.orgId, req, 'leave_payout_cancelled', payout.id, { userId: payout.userId });
    return res.json({ success: true, payout });
});

/** Payroll has paid it. The paid hours come off the leave balance so they cannot be paid again. */
router.post('/leave/payouts/:id/paid', PAYROLL, requireUsOrg, async (req, res) => {
    const b = req.body || {};
    const payDate = b.payDate === undefined || b.payDate === '' ? null : String(b.payDate);
    if (payDate && !/^\d{4}-\d{2}-\d{2}$/.test(payDate)) return invalid(res, ['payDate must be YYYY-MM-DD']);
    const payReference = String(b.payReference || '').trim().slice(0, 80);
    const payout = await move(req, res, 'paid', { extra: { paidBy: req.user.id || null, paidAt: now(), payDate, payReference } });
    if (!payout) return undefined;
    const info = await orgInfo(req.orgId);
    const date = timeRules.localDate(now(), info.tz);
    await Promise.all(R.adjustmentsFor(payout).map((a) => rawCollection('leave_adjustments').add({
        orgId: req.orgId, userId: payout.userId, policyId: a.policyId, hours: a.hours, date, reason: `Paid out with pay (payout ${payout.id})`, payoutId: payout.id,
        createdBy: req.user.id || null, createdAt: now()
    })));
    audit(req.orgId, req, 'leave_payout_paid', payout.id, { userId: payout.userId, hours: payout.hours, amount: payout.amount, payDate, payReference: payReference || null });
    return res.json({ success: true, payout });
});

module.exports = router;
