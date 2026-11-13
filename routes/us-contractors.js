/** Contractors: W-9, 1099 payment ledger, annual summary. Auth is applied by the parent router. */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { requireUsOrg, audit } = require('./us-hr').helpers;
const { requirePermission, requireAnyPermission } = require('../services/permissions');
const { encryptField, decryptField } = require('../services/pii-crypto');
const CT = require('../services/contractor-rules');
const store = require('../services/people-data-store');

const now = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });

const LIST = requireAnyPermission('people.read', 'people.read_pay');
const WRITE = requirePermission('people.write');
const PAYMENTS_WRITE = requireAnyPermission('people.write', 'payroll.run');
const tinContext = (orgId, id) => `${orgId}:${id}:contractor-tin`;

const publicW9 = (w) => (w ? { ...w, tinEncrypted: undefined, history: undefined, historyCount: (w.history || []).length, tinMasked: w.tinLast4 ? `***${w.tinLast4}` : null } : null);
const publicContractor = (c, w9) => ({ ...c, orgId: undefined, w9Status: w9 && w9.status === 'received' ? 'received' : 'missing', tinLast4: w9 ? w9.tinLast4 : null, taxClassification: w9 ? w9.taxClassification : null });

async function w9Map(orgId) {
    const list = await store.listByOrg('contractor_w9', orgId);
    return Object.fromEntries(list.map((w) => [w.id, w]));
}
const validPayments = async (orgId) => (await store.listByOrg('contractor_payments', orgId)).filter((p) => !p.voided);

router.get('/contractors', LIST, requireUsOrg, async (req, res) => {
    const [list, w9s] = await Promise.all([store.listByOrg('contractors', req.orgId), w9Map(req.orgId)]);
    res.json({ success: true, data: list.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((c) => publicContractor(c, w9s[c.id])) });
});

router.post('/contractors', WRITE, requireUsOrg, async (req, res) => {
    const { errors, value } = CT.validateContractor(req.body);
    if (errors.length) return invalid(res, errors);
    const list = await store.listByOrg('contractors', req.orgId);
    if (list.some((c) => String(c.name).toLowerCase() === value.name.toLowerCase() && c.active !== false)) return fail(res, 409, 'A contractor with this name already exists');
    const doc = { ...value, orgId: req.orgId, createdAt: now(), createdBy: req.user.id || null };
    const ref = await rawCollection('contractors').add(doc);
    audit(req.orgId, req, 'contractor_created', ref.id, { name: value.name });
    res.status(201).json({ success: true, contractor: publicContractor({ id: ref.id, ...doc }, null) });
});

// Fixed paths first so they are not read as a contractor id
router.get('/contractors/settings', LIST, requireUsOrg, async (req, res) => {
    res.json({ success: true, settings: (await store.getSettings(req.orgId)).contractors, note: 'Confirm the reporting threshold and withholding rate with a US tax advisor.' });
});

router.put('/contractors/settings', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const { errors, value } = CT.validateSettings(req.body);
    if (errors.length) return invalid(res, errors);
    if (!Object.keys(value).length) return invalid(res, ['send necThreshold and/or backupWithholdingRate']);
    const cur = (await store.getSettings(req.orgId)).contractors;
    const s = await store.patchSettings(req.orgId, { contractors: { ...cur, ...value } });
    audit(req.orgId, req, 'contractor_settings_updated', req.orgId, value);
    res.json({ success: true, settings: s.contractors });
});

async function summaryRows(orgId, year) {
    const [list, w9s, payments, settings] = await Promise.all([store.listByOrg('contractors', orgId), w9Map(orgId), validPayments(orgId), store.getSettings(orgId)]);
    const base = list.map((c) => ({ id: c.id, name: c.name, backupWithholding: c.backupWithholding, w9Status: w9s[c.id] && w9s[c.id].status === 'received' ? 'received' : 'missing', tinLast4: w9s[c.id] ? w9s[c.id].tinLast4 : null }));
    const totals = CT.annualTotals(base, payments, year, settings.contractors).filter((t) => t.paymentCount > 0 || list.find((c) => c.id === t.contractorId).active !== false);
    return { totals, w9s, settings: settings.contractors };
}

const yearOf = (req) => { const y = Number(req.query.year); return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : new Date().getUTCFullYear(); };

router.get('/contractors/summary', requirePermission('people.read_pay'), requireUsOrg, async (req, res) => {
    const year = yearOf(req);
    const { totals, settings } = await summaryRows(req.orgId, year);
    res.json({ success: true, year, settings, data: totals, reportableCount: totals.filter((t) => t.over1099Threshold).length });
});

/** 1099 summary CSV. TIN shows last 4 only, unless the caller may reveal IDs and asks for fullTin=true (audited). */
router.get('/contractors/summary.csv', requirePermission('people.read_pay'), requireUsOrg, async (req, res) => {
    const year = yearOf(req);
    const full = req.query.fullTin === 'true';
    if (full && !requirePermissionCheck(req)) return fail(res, 403, 'Only a super admin or HR admin can download full taxpayer IDs');
    const { totals, w9s } = await summaryRows(req.orgId, year);
    const rows = totals.map((t) => {
        const w = w9s[t.contractorId];
        let tin = '';
        if (full && w && w.tinEncrypted) { try { tin = decryptField(w.tinEncrypted, tinContext(req.orgId, t.contractorId)); } catch (_) { tin = '(could not decrypt)'; } }
        return { ...t, legalName: w ? w.legalName : '', taxClassification: w ? w.taxClassification : '', address: w ? w.address : null, tin };
    });
    await audit(req.orgId, req, full ? 'contractor_1099_csv_full_tin' : 'contractor_1099_csv', null, { year, rows: rows.length });
    res.set('Cache-Control', 'no-store').set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', `attachment; filename="1099-summary-${year}${full ? '-full' : ''}.csv"`).send(CT.summaryCsv(rows, { fullTin: full }));
});
const { can } = require('../services/permissions');
const requirePermissionCheck = (req) => can(req.user, 'pii.reveal');

router.get('/contractors/:id', LIST, requireUsOrg, async (req, res) => {
    const c = await store.getOwned('contractors', req.orgId, req.params.id);
    if (!c) return fail(res, 404, 'Contractor not found');
    const w = await store.getOwned('contractor_w9', req.orgId, c.id);
    res.json({ success: true, contractor: publicContractor({ id: c.id, ...stripRef(c) }, w), w9: publicW9(w ? stripRef(w) : null) });
});
const stripRef = (o) => { const { ref, ...rest } = o; return rest; };

router.put('/contractors/:id', WRITE, requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('contractors', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Contractor not found');
    const { errors, value } = CT.validateContractor({ ...stripRef(cur), ...req.body });
    if (errors.length) return invalid(res, errors);
    await cur.ref.set({ ...value, updatedAt: now() }, { merge: true });
    audit(req.orgId, req, 'contractor_updated', cur.id, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, contractor: publicContractor({ id: cur.id, ...value }, await store.getOwned('contractor_w9', req.orgId, cur.id)) });
});

// W-9
router.put('/contractors/:id/w9', WRITE, requireUsOrg, async (req, res) => {
    const c = await store.getOwned('contractors', req.orgId, req.params.id);
    if (!c) return fail(res, 404, 'Contractor not found');
    const { errors, value, tin } = CT.validateW9(req.body);
    if (errors.length) return invalid(res, errors);
    const prior = await store.getOwned('contractor_w9', req.orgId, c.id);
    const history = prior ? [...(prior.history || []), { ...stripRef(prior), history: undefined, supersededAt: now() }].slice(-10) : [];
    const doc = { ...value, orgId: req.orgId, contractorId: c.id, tinEncrypted: encryptField(tin.digits, tinContext(req.orgId, c.id)), status: 'received', certifiedAt: now(), certifiedIp: req.ip || null, recordedBy: req.user.id || null, history };
    await rawCollection('contractor_w9').doc(c.id).set(doc);
    audit(req.orgId, req, 'contractor_w9_saved', c.id, { tinType: value.tinType, last4: value.tinLast4, taxClassification: value.taxClassification });
    res.json({ success: true, w9: publicW9({ id: c.id, ...doc }) });
});

router.post('/contractors/:id/w9/void', WRITE, requireUsOrg, async (req, res) => {
    const w = await store.getOwned('contractor_w9', req.orgId, req.params.id);
    if (!w) return fail(res, 404, 'No W-9 on file');
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 3) return invalid(res, ['A reason is required']);
    await w.ref.set({ status: 'void', voidedAt: now(), voidedBy: req.user.id || null, voidReason: reason }, { merge: true });
    audit(req.orgId, req, 'contractor_w9_voided', w.id, { reason });
    res.json({ success: true });
});

// 1099 payments ledger
router.get('/contractors/:id/payments', requirePermission('people.read_pay'), requireUsOrg, async (req, res) => {
    const c = await store.getOwned('contractors', req.orgId, req.params.id);
    if (!c) return fail(res, 404, 'Contractor not found');
    const year = req.query.year ? yearOf(req) : null;
    const list = (await store.listByOrg('contractor_payments', req.orgId)).filter((p) => p.contractorId === c.id && (!year || String(p.date).startsWith(String(year))));
    res.json({ success: true, data: list.sort((a, b) => String(b.date).localeCompare(String(a.date))) });
});

router.post('/contractors/:id/payments', PAYMENTS_WRITE, requireUsOrg, async (req, res) => {
    const c = await store.getOwned('contractors', req.orgId, req.params.id);
    if (!c) return fail(res, 404, 'Contractor not found');
    if (c.active === false) return fail(res, 409, 'This contractor is inactive');
    const { errors, value } = CT.validatePayment(req.body, await store.todayFor(req.orgId));
    if (errors.length) return invalid(res, errors);
    const doc = { ...value, orgId: req.orgId, contractorId: c.id, voided: false, createdAt: now(), createdBy: req.user.id || null };
    const ref = await rawCollection('contractor_payments').add(doc);
    audit(req.orgId, req, 'contractor_payment_added', c.id, { paymentId: ref.id, amount: value.amount, date: value.date });
    res.status(201).json({ success: true, payment: { id: ref.id, ...doc }, countsForNec: CT.countsForNec(value) });
});

router.post('/contractor-payments/:id/void', PAYMENTS_WRITE, requireUsOrg, async (req, res) => {
    const p = await store.getOwned('contractor_payments', req.orgId, req.params.id);
    if (!p) return fail(res, 404, 'Payment not found');
    if (p.voided) return fail(res, 409, 'This payment is already voided');
    const reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 3) return invalid(res, ['A reason is required']);
    await p.ref.set({ voided: true, voidedAt: now(), voidedBy: req.user.id || null, voidReason: reason }, { merge: true });
    audit(req.orgId, req, 'contractor_payment_voided', p.contractorId, { paymentId: p.id, reason });
    res.json({ success: true });
});

module.exports = router;
