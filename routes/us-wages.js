const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, findEmployee, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { requirePermission, requireAnyPermission } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const W = require('../services/wage-rules');
const { loadPeople } = require('../services/us-people-loader');
const { parseIsoDate } = require('../services/us-forms');

router.use(verifyToken);

const VIEW = requireAnyPermission('time.manage_rules', 'people.read_pay');
const MANAGE = requirePermission('time.manage_rules');
const NOTE = 'Confirm every rate with a US compliance advisor. Only the federal rows are pre-filled; everything else is entered by your company.';

async function loadRules(orgId) {
    const col = rawCollection('wage_rules');
    let snap = await col.where('orgId', '==', orgId).get();
    if (snap.empty) {
        // First use: seed the two federal figures as editable rows
        for (const s of W.SEED_RULES) await col.add({ ...s, orgId, active: true, createdAt: new Date().toISOString(), createdBy: 'system', changeLog: [] });
        snap = await col.where('orgId', '==', orgId).get();
    }
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

const publicRule = (r) => ({
    id: r.id, jurisdiction: r.jurisdiction, state: r.state, name: r.name, effectiveDate: r.effectiveDate, hourlyMinimum: r.hourlyMinimum,
    tippedCashWage: r.tippedCashWage, notes: r.notes || '', verified: r.verified === true, active: r.active !== false, seed: r.seed === true,
    updatedAt: r.updatedAt || r.createdAt || null, changeLog: r.changeLog || []
});
const todayIn = (tz) => timeRules.localDate(new Date().toISOString(), tz);

router.get('/wages/rules', VIEW, requireUsOrg, async (req, res) => {
    const rules = (await loadRules(req.orgId)).filter((r) => req.query.archived === 'true' || r.active !== false)
        .sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || String(a.state).localeCompare(String(b.state)) || String(a.name).localeCompare(String(b.name)) || b.effectiveDate.localeCompare(a.effectiveDate));
    res.json({ success: true, note: NOTE, data: rules.map(publicRule) });
});

router.get('/wages/rules/history', VIEW, requireUsOrg, async (req, res) => {
    const rules = (await loadRules(req.orgId)).filter((r) => r.active !== false);
    const filter = { jurisdiction: req.query.jurisdiction, state: req.query.state, name: req.query.name };
    res.json({ success: true, data: W.history(rules, filter).map(publicRule) });
});

async function duplicate(orgId, value, exceptId) {
    const rules = await loadRules(orgId);
    return rules.find((r) => r.active !== false && r.id !== exceptId && W.scopeKey(r) === W.scopeKey(value) && r.effectiveDate === value.effectiveDate);
}

router.post('/wages/rules', MANAGE, requireUsOrg, async (req, res) => {
    const { errors, value } = W.validateRule(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    if (await duplicate(req.orgId, value)) return res.status(409).json({ success: false, error: 'A rule for this place and effective date already exists. Edit it instead.' });
    const doc = { ...value, orgId: req.orgId, active: true, createdAt: new Date().toISOString(), createdBy: req.user.id, changeLog: [] };
    const ref = await rawCollection('wage_rules').add(doc);
    audit(req.orgId, req, 'wage_rule_created', ref.id, { jurisdiction: value.jurisdiction, state: value.state, name: value.name, effectiveDate: value.effectiveDate, hourlyMinimum: value.hourlyMinimum });
    res.status(201).json({ success: true, rule: publicRule({ id: ref.id, ...doc }) });
});

router.put('/wages/rules/:id', MANAGE, requireUsOrg, async (req, res) => {
    const ref = rawCollection('wage_rules').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Rule not found' });
    const old = snap.data();
    const { errors, value } = W.validateRule({ ...old, ...req.body });
    if (errors.length) return res.status(400).json({ success: false, errors });
    if (await duplicate(req.orgId, value, req.params.id)) return res.status(409).json({ success: false, error: 'Another rule already has this place and effective date' });
    const entry = { at: new Date().toISOString(), by: req.user.id, before: { effectiveDate: old.effectiveDate, hourlyMinimum: old.hourlyMinimum, tippedCashWage: old.tippedCashWage, verified: old.verified === true } };
    const changeLog = [...(old.changeLog || []), entry].slice(-50);
    await ref.set({ ...value, changeLog, seed: false, updatedAt: entry.at, updatedBy: req.user.id }, { merge: true });
    audit(req.orgId, req, 'wage_rule_updated', ref.id, { before: entry.before, hourlyMinimum: value.hourlyMinimum, tippedCashWage: value.tippedCashWage });
    res.json({ success: true, rule: publicRule({ id: ref.id, ...old, ...value, changeLog }) });
});

router.delete('/wages/rules/:id', MANAGE, requireUsOrg, async (req, res) => {
    const ref = rawCollection('wage_rules').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Rule not found' });
    await ref.update({ active: false, archivedAt: new Date().toISOString(), archivedBy: req.user.id });
    audit(req.orgId, req, 'wage_rule_archived', ref.id);
    res.json({ success: true });
});

router.get('/wages/effective', VIEW, requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const date = req.query.date || todayIn(info.tz);
    if (!parseIsoDate(date)) return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
    const state = String(req.query.state || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) return res.status(400).json({ success: false, error: 'state must be a 2-letter code' });
    const rules = await loadRules(req.orgId);
    res.json({ success: true, note: NOTE, data: W.effectiveMinimum(rules, { state, city: req.query.city, county: req.query.county }, date) });
});

router.get('/wages/violations', requireAnyPermission('people.read_pay', 'time.manage_rules'), requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const date = req.query.date || todayIn(info.tz);
    if (!parseIsoDate(date)) return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
    const [rules, people] = await Promise.all([loadRules(req.orgId), loadPeople(req.orgId)]);
    const result = W.checkEmployees(rules, people.filter((p) => p.active && p.classification !== '1099'), date);
    audit(req.orgId, req, 'wage_violations_checked', null, { date, violations: result.violations.length });
    res.json({ success: true, note: NOTE, ...result });
});

/** Set the city/county used for the minimum wage check (and nothing else) */
router.put('/wages/employees/:id/location', MANAGE, requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const clean = (v) => String(v || '').trim().slice(0, 80);
    const patch = { workCity: clean(req.body && req.body.workCity), workCounty: clean(req.body && req.body.workCounty) };
    await emp.ref.set({ usProfile: patch }, { merge: true });
    audit(req.orgId, req, 'wage_location_updated', emp.id, patch);
    res.json({ success: true, workCity: patch.workCity, workCounty: patch.workCounty });
});

/** Hook for other modules: is this rate acceptable on this date? */
async function checkRateFor(orgId, loc, date, rate, opts) {
    return W.checkRate(await loadRules(orgId), loc, date, rate, opts);
}
async function effectiveMinimumFor(orgId, loc, date) {
    return W.effectiveMinimum(await loadRules(orgId), loc, date);
}

router.helpers = { loadRules, checkRateFor, effectiveMinimumFor };

module.exports = router;
