/** Job and compensation history, and direct deposit splits. Auth is applied by the parent router. */
const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const logger = require('../utils/logger');
const { requireUsOrg, findEmployee, audit } = require('./us-hr').helpers;
const { requirePermission, requireAnyPermission, can } = require('../services/permissions');
const { encryptField } = require('../services/pii-crypto');
const CH = require('../services/comp-history-rules');
const DD = require('../services/direct-deposit-rules');
const O = require('../services/org-rules');
const store = require('../services/people-data-store');

const now = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// --------------------------------------------------------- comp history
const COMP_VIEW = requireAnyPermission('people.read', 'people.read_pay');
const seesPay = (req) => can(req.user, 'people.read_pay');
const view = (req, r) => (seesPay(req) ? r : CH.stripPay(r));

async function recordsFor(orgId, userId) {
    return (await store.listByOrg('comp_history', orgId)).filter((r) => r.userId === userId);
}

/** Recomputes the state in force today from approved records and writes it to usProfile; marks due records applied */
async function syncPerson(orgId, emp, records, today) {
    const state = CH.stateAsOf(records, today);
    const due = records.filter((r) => (r.status || 'approved') === 'approved' && r.effectiveDate <= today && !r.applied);
    if (!due.length) return { applied: 0 };
    const patch = CH.profilePatch(state);
    let warning = null;
    if (patch.managerId) {
        const people = await store.loadPeople(orgId, { includeInactive: true });
        if (O.wouldCreateCycle(O.managerMap(people), emp.id, patch.managerId)) { warning = 'manager change skipped: it would create a reporting loop'; delete patch.managerId; }
    }
    await emp.ref.set({ usProfile: { ...patch, compSyncedAt: now() }, ...(patch.jobTitle ? { jobTitle: patch.jobTitle } : {}) }, { merge: true });
    await Promise.all(due.map((r) => rawCollection('comp_history').doc(r.id).set({ applied: true, appliedAt: now(), ...(warning ? { applyWarning: warning } : {}) }, { merge: true })));
    due.forEach((r) => { r.applied = true; });
    return { applied: due.length, warning };
}

/** Applies due scheduled changes for one person (used on read) */
async function applyDueFor(orgId, emp) {
    const records = await recordsFor(orgId, emp.id);
    if (!records.some((r) => !r.applied && (r.status || 'approved') === 'approved')) return records;
    await syncPerson(orgId, emp, records, await store.todayFor(orgId));
    return records;
}

/** The daily job: applies every approved record whose effective date has come, in all organizations */
async function applyDueAll() {
    const snap = await rawCollection('comp_history').where('applied', '==', false).get();
    const byPerson = new Map();
    snap.docs.forEach((d) => { const r = d.data(); if (r.status === 'approved' && r.orgId && r.userId) byPerson.set(`${r.orgId}|${r.userId}`, [r.orgId, r.userId]); });
    let applied = 0;
    for (const [orgId, userId] of byPerson.values()) {
        try {
            const today = await store.todayFor(orgId);
            const records = await recordsFor(orgId, userId);
            if (!records.some((r) => (r.status || 'approved') === 'approved' && !r.applied && r.effectiveDate <= today)) continue;
            const emp = await findEmployee(orgId, userId);
            if (!emp) continue;
            applied += (await syncPerson(orgId, emp, records, today)).applied;
        } catch (e) { logger.error(`Comp history job failed for ${userId}: ${e.message}`); }
    }
    return applied;
}

async function applyDueForOrg(orgId) {
    const today = await store.todayFor(orgId);
    const all = await store.listByOrg('comp_history', orgId);
    const ids = [...new Set(all.filter((r) => !r.applied && (r.status || 'approved') === 'approved' && r.effectiveDate <= today).map((r) => r.userId))];
    let applied = 0;
    for (const id of ids) { const emp = await findEmployee(orgId, id); if (emp) applied += (await syncPerson(orgId, emp, all.filter((r) => r.userId === id), today)).applied; }
    return applied;
}

router.get('/employees/:id/comp-history', COMP_VIEW, requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    const today = await store.todayFor(req.orgId);
    const records = await applyDueFor(req.orgId, emp);
    const asOf = req.query.asOf ? String(req.query.asOf) : null;
    if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return invalid(res, ['asOf must be YYYY-MM-DD']);
    const state = (d) => { const s = CH.stateAsOf(records, d); return s ? (seesPay(req) ? s : CH.stripPay(s)) : null; };
    const tl = CH.timeline(records, today).map((r) => view(req, r));
    audit(req.orgId, req, seesPay(req) ? 'comp_history_viewed' : 'comp_history_viewed_no_pay', emp.id, {});
    res.json({ success: true, employeeId: emp.data.employeeId || emp.id, today, current: state(today), ...(asOf ? { asOf, asOfState: state(asOf) } : {}), timeline: tl, canSeePay: seesPay(req) });
});

async function referencesOk(orgId, value) {
    const errors = [];
    if (value.departmentId) { if (!(await store.getOwned('departments', orgId, value.departmentId))) errors.push('departmentId is not a department of this company'); }
    if (value.workLocationId) { const l = await store.getOwned('locations', orgId, value.workLocationId); if (!l || l.active === false) errors.push('workLocationId is not an active location of this company'); }
    return errors;
}

router.post('/employees/:id/comp-history', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    const { errors, value } = CH.validateRecord(req.body);
    if (errors.length) return invalid(res, errors);
    const touchesPay = CH.PAY_FIELDS.some((f) => value[f] !== undefined);
    if (touchesPay && !seesPay(req)) return fail(res, 403, 'Changing pay needs the permission to see pay (people.read_pay)');
    errors.push(...(await referencesOk(req.orgId, value)));
    if (value.managerId) {
        const mgr = await findEmployee(req.orgId, value.managerId);
        if (!mgr) errors.push('managerId is not a person in this company');
        else if (mgr.id === emp.id) errors.push('A person cannot manage themselves');
        else {
            value.managerId = mgr.id;
            const people = await store.loadPeople(req.orgId, { includeInactive: true });
            if (O.wouldCreateCycle(O.managerMap(people), emp.id, mgr.id)) errors.push('That manager change would create a reporting loop');
        }
    }
    if (errors.length) return invalid(res, errors);

    const [records, settings, today] = await Promise.all([recordsFor(req.orgId, emp.id), store.getSettings(req.orgId), store.todayFor(req.orgId)]);
    const p = emp.data.usProfile || {};
    const base = { payType: p.payType, payRate: p.payRate, ...(CH.stateAsOf(records, addDays(value.effectiveDate, -1)) || {}) };
    const pending = CH.needsApproval(base, value, settings.compApprovalPercent);
    const doc = {
        ...value, orgId: req.orgId, userId: emp.id, employeeId: emp.data.employeeId || null, status: pending ? 'pending_approval' : 'approved', applied: false,
        createdAt: now(), createdBy: req.user.id || null,
        approverId: pending ? null : (req.user.id || null), approvedAt: pending ? null : now(), autoApproved: !pending && touchesPay,
        ...(touchesPay ? { payChangePercent: CH.percentChange(base, { ...base, ...value }) } : {})
    };
    const ref = await rawCollection('comp_history').add(doc);
    audit(req.orgId, req, 'comp_history_added', emp.id, { recordId: ref.id, reason: value.reason, effectiveDate: value.effectiveDate, status: doc.status, fields: Object.keys(value).filter((k) => CH.STATE_FIELDS.includes(k)) });
    let applied = 0;
    if (!pending) applied = (await syncPerson(req.orgId, emp, [...records, { id: ref.id, ...doc }], today)).applied;
    res.status(201).json({ success: true, record: view(req, { id: ref.id, ...doc, applied: applied > 0 }), needsApproval: pending, scheduled: !pending && value.effectiveDate > today, approvalThresholdPercent: settings.compApprovalPercent });
});

async function decideComp(req, res, status) {
    const rec = await store.getOwned('comp_history', req.orgId, req.params.id);
    if (!rec) return fail(res, 404, 'Record not found');
    if (rec.status !== 'pending_approval') return fail(res, 409, `This record is already ${rec.status}`);
    if (rec.createdBy === req.user.id) return fail(res, 409, 'A different person must approve this change');
    const note = String((req.body && req.body.note) || '').trim();
    if (status === 'rejected' && note.length < 3) return invalid(res, ['A reason for rejecting is required']);
    await rec.ref.set({ status, approverId: req.user.id || null, approvedAt: now(), decisionNote: note }, { merge: true });
    audit(req.orgId, req, status === 'approved' ? 'comp_history_approved' : 'comp_history_rejected', rec.userId, { recordId: rec.id });
    let applied = 0;
    if (status === 'approved') {
        const emp = await findEmployee(req.orgId, rec.userId);
        if (emp) applied = (await syncPerson(req.orgId, emp, await recordsFor(req.orgId, rec.userId), await store.todayFor(req.orgId))).applied;
    }
    res.json({ success: true, status, applied: applied > 0 });
}
const PAY_ADMIN = [requirePermission('people.write'), requirePermission('people.read_pay')];
router.post('/comp-history/:id/approve', ...PAY_ADMIN, requireUsOrg, (req, res) => decideComp(req, res, 'approved'));
router.post('/comp-history/:id/reject', ...PAY_ADMIN, requireUsOrg, (req, res) => decideComp(req, res, 'rejected'));

/** A scheduled change that has not taken effect yet can be withdrawn; applied history is never edited (use a correction record) */
router.post('/comp-history/:id/cancel', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const rec = await store.getOwned('comp_history', req.orgId, req.params.id);
    if (!rec) return fail(res, 404, 'Record not found');
    if (rec.applied) return fail(res, 409, 'This change is already in effect. Add a correction record instead.');
    if (['cancelled', 'rejected'].includes(rec.status)) return fail(res, 409, `This record is already ${rec.status}`);
    await rec.ref.set({ status: 'cancelled', cancelledBy: req.user.id || null, cancelledAt: now() }, { merge: true });
    audit(req.orgId, req, 'comp_history_cancelled', rec.userId, { recordId: rec.id });
    res.json({ success: true });
});

/** Everything waiting: approvals and future-dated changes across the company */
router.get('/comp-history/queue', requirePermission('people.read_pay'), requirePermission('people.read'), requireUsOrg, async (req, res) => {
    const today = await store.todayFor(req.orgId);
    const all = await store.listByOrg('comp_history', req.orgId);
    const people = Object.fromEntries((await store.loadPeople(req.orgId, { includeInactive: true })).map((p) => [p.id, p.name]));
    const row = (r) => ({ ...r, name: people[r.userId] || r.userId });
    res.json({
        success: true, today,
        pending: all.filter((r) => r.status === 'pending_approval').map(row).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
        scheduled: all.filter((r) => r.status === 'approved' && !r.applied && r.effectiveDate > today).map(row).sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
    });
});

router.post('/comp-history/apply-due', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const applied = await applyDueForOrg(req.orgId);
    audit(req.orgId, req, 'comp_history_apply_due', null, { applied });
    res.json({ success: true, applied });
});

let jobTimer = null;
function startDailyJob() {
    if (jobTimer || process.env.COMP_HISTORY_JOB === 'off') return;
    const run = () => applyDueAll().then((n) => n && logger.info(`Comp history job applied ${n} change(s)`)).catch((e) => logger.error(`Comp history job failed: ${e.message}`));
    jobTimer = setInterval(run, 24 * 60 * 60 * 1000); jobTimer.unref();
    setTimeout(run, 90 * 1000).unref();
}
startDailyJob();

// -------------------------------------------------- direct deposit splits
const canRead = (req, emp) => emp.id === req.user.id || can(req.user, 'people.write') || can(req.user, 'people.read_pay');
const canWrite = (req, emp) => emp.id === req.user.id || can(req.user, 'people.write');
const bankContext = (orgId, empId) => `${orgId}:${empId}:bank`;

/** Splits as stored, or the single legacy account shown as one account taking everything */
function storedSplits(emp) {
    const f = emp.data.usForms || {};
    const d = f.directDeposit;
    // the older single-account endpoint (or an approved bank change) rewrites directDeposit without the split marker: that newer account wins
    if (Array.isArray(f.directDepositSplits) && f.directDepositSplits.length && !(d && !d.split)) return f.directDepositSplits;
    if (d && d.accountLast4) return [{ id: 'legacy', bankName: d.bankName, routingNumber: d.routingNumber, accountType: d.accountType, accountLast4: d.accountLast4, allocation: { type: 'remainder', value: null }, legacy: true }];
    return [];
}

router.get('/employees/:id/direct-deposit/splits', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    if (!canRead(req, emp)) return fail(res, 403, 'You do not have permission to do this');
    const list = storedSplits(emp);
    const s = (emp.data.usForms && emp.data.usForms.directDepositSplitsMeta) || {};
    audit(req.orgId, req, 'direct_deposit_splits_viewed', emp.id, {});
    res.json({ success: true, accounts: list.map(DD.maskAccount), updatedAt: s.updatedAt || null, legacy: list.length === 1 && Boolean(list[0].legacy) });
});

router.put('/employees/:id/direct-deposit/splits', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    if (!canWrite(req, emp)) return fail(res, 403, 'You do not have permission to do this');
    if (!(req.body && req.body.authorization)) return invalid(res, ['authorization is required (the employee allows payroll to deposit pay into these accounts)']);
    const stored = (emp.data.usForms && Array.isArray(emp.data.usForms.directDepositSplits)) ? emp.data.usForms.directDepositSplits : [];
    const existing = new Map(stored.map((a) => [a.id, a]));
    const { errors, value } = DD.validateSplits(req.body.accounts, existing);
    if (errors.length) return invalid(res, errors);
    const accounts = value.map((a) => {
        const prior = a.id ? existing.get(a.id) : null;
        return {
            id: a.id || crypto.randomUUID(), bankName: a.bankName, routingNumber: a.routingNumber, accountType: a.accountType,
            accountNumberEncrypted: a.keepStoredNumber ? prior.accountNumberEncrypted : encryptField(a.accountNumber, bankContext(req.orgId, emp.id)),
            accountLast4: a.accountLast4, allocation: a.allocation
        };
    });
    const primary = accounts.find((a) => a.allocation.type === 'remainder');
    const stamp = now();
    // `directDeposit` stays a valid single-account summary (the remainder account) so existing screens and the onboarding checklist keep working
    const directDeposit = {
        bankName: primary.bankName, routingNumber: primary.routingNumber, accountType: primary.accountType, accountNumberEncrypted: primary.accountNumberEncrypted, accountLast4: primary.accountLast4,
        updatedAt: stamp, updatedBy: req.user.id || null, authorizedAt: stamp, authorizedIp: req.ip || null, split: true, accountCount: accounts.length
    };
    await emp.ref.set({ usForms: { directDepositSplits: accounts, directDepositSplitsMeta: { updatedAt: stamp, updatedBy: req.user.id || null }, directDeposit } }, { merge: true });
    audit(req.orgId, req, 'us_direct_deposit_splits_updated', emp.id, { accounts: accounts.map((a) => ({ last4: a.accountLast4, type: a.allocation.type })) });
    res.json({ success: true, accounts: accounts.map(DD.maskAccount), updatedAt: stamp });
});

/** How a net pay would be divided (?net=1000.00), for the screen to show the effect */
router.get('/employees/:id/direct-deposit/splits/preview', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    if (!canRead(req, emp)) return fail(res, 403, 'You do not have permission to do this');
    const net = Number(req.query.net);
    if (!(net > 0) || net > 10000000) return invalid(res, ['net must be a positive amount']);
    const list = storedSplits(emp);
    if (!list.length) return fail(res, 404, 'No direct deposit on file');
    const r = DD.allocate(net, list);
    res.json({ success: true, net, fixedShortfall: r.fixedShortfall, accounts: list.map((a, i) => ({ ...DD.maskAccount(a), amount: r.cents[i] / 100 })) });
});

router.helpers = { applyDueAll, applyDueForOrg, syncPerson };
module.exports = router;
