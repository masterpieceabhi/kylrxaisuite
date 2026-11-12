const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, findEmployee, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { requirePermission, requireAnyPermission, can } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const T = require('../services/tips-rules');
const { loadPeople, loadPerson, loadWeeks } = require('../services/us-people-loader');
const { loadRules, effectiveMinimumFor } = require('./us-wages').helpers;
const { parseIsoDate } = require('../services/us-forms');

router.use(verifyToken);

const VIEW = requireAnyPermission('time.manage_rules', 'people.read_pay');
const MANAGE = requirePermission('time.manage_rules');
const NOTE = 'Tip rules differ by state. Confirm with a US compliance advisor.';
const todayIn = (tz) => timeRules.localDate(new Date().toISOString(), tz);
const addDays = (iso, n) => { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ''));
const round2 = (n) => Math.round(n * 100) / 100;

async function getSettings(orgId) {
    const snap = await rawCollection('tip_settings').doc(orgId).get();
    return { ...T.DEFAULT_SETTINGS, ...(exists(snap) ? snap.data() : {}) };
}
async function loadRecords(orgId, { userId, from, to } = {}) {
    const snap = await rawCollection('tip_records').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => (!userId || r.userId === userId) && (!from || r.date >= from) && (!to || r.date <= to));
}
const recId = (userId, date) => `${userId}_${date}`;
const pubRec = (r) => ({ id: r.id, userId: r.userId, date: r.date, cashTips: r.cashTips || 0, cardTips: r.cardTips || 0, total: round2((r.cashTips || 0) + (r.cardTips || 0)), note: r.note || '' });

/** Approved hours per user in [from, to] (weeks starting inside the range) */
async function approvedHours(orgId, from, to) {
    const weeks = (await loadWeeks(orgId)).filter((w) => w.status === 'approved' && w.weekStart >= from && w.weekStart <= to);
    const hours = {};
    weeks.forEach((w) => { hours[w.userId] = round2((hours[w.userId] || 0) + (Number(w.totals && w.totals.workedHours) || 0)); });
    return hours;
}

/* --------------------------------- employee --------------------------------- */

router.get('/tips/me', requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const month = isMonth(req.query.month) ? req.query.month : todayIn(info.tz).slice(0, 7);
    const [me, settings, records] = await Promise.all([loadPerson(req.orgId, req.user.id), getSettings(req.orgId), loadRecords(req.orgId, { userId: req.user.id })]);
    if (!me) return res.status(404).json({ success: false, error: 'No employee record for this login' });
    const mine = records.filter((r) => r.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, tipped: me.tipped, today: todayIn(info.tz), month, threshold: settings.monthlyReportingThreshold, summary: T.monthlyTotal(mine, month, settings.monthlyReportingThreshold), data: mine.map(pubRec) });
});

router.post('/tips/me', requireUsOrg, async (req, res) => {
    const me = await loadPerson(req.orgId, req.user.id);
    if (!me) return res.status(404).json({ success: false, error: 'No employee record for this login' });
    if (!me.tipped) return res.status(403).json({ success: false, error: 'You are not set up as a tipped employee. Ask HR.' });
    const info = await orgInfo(req.orgId);
    const body = req.body || {};
    const { errors, value } = T.validateEntry({ date: body.date, cashTips: body.cashTips, cardTips: 0, note: body.note }, todayIn(info.tz));
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ref = rawCollection('tip_records').doc(recId(req.user.id, value.date));
    const snap = await ref.get();
    const old = exists(snap) ? snap.data() : null;
    if (old && old.orgId !== req.orgId) return res.status(409).json({ success: false, error: 'Record conflict' });
    const doc = { orgId: req.orgId, userId: req.user.id, date: value.date, cashTips: value.cashTips, cardTips: old ? old.cardTips || 0 : 0, note: value.note, cashDeclaredAt: new Date().toISOString(), createdAt: old ? old.createdAt : new Date().toISOString() };
    await ref.set(doc);
    audit(req.orgId, req, 'tip_cash_declared', req.user.id, { date: value.date, cashTips: value.cashTips, replaced: Boolean(old) });
    res.status(old ? 200 : 201).json({ success: true, record: pubRec({ id: ref.id, ...doc }) });
});

router.delete('/tips/me/:date', requireUsOrg, async (req, res) => {
    if (!parseIsoDate(req.params.date)) return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
    const ref = rawCollection('tip_records').doc(recId(req.user.id, req.params.date));
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'No tips declared for that day' });
    if (snap.data().cardTips > 0) await ref.update({ cashTips: 0, cashDeclaredAt: new Date().toISOString() }); else await ref.delete();
    audit(req.orgId, req, 'tip_cash_removed', req.user.id, { date: req.params.date });
    res.json({ success: true });
});

/* ----------------------------------- admin ----------------------------------- */

router.get('/tips/settings', VIEW, requireUsOrg, async (req, res) => {
    res.json({ success: true, note: NOTE, data: await getSettings(req.orgId) });
});
router.put('/tips/settings', MANAGE, requireUsOrg, async (req, res) => {
    const th = Number(req.body && req.body.monthlyReportingThreshold);
    if (!(th >= 0 && th <= 10000)) return res.status(400).json({ success: false, errors: ['monthlyReportingThreshold must be an amount from 0 to 10000'] });
    await rawCollection('tip_settings').doc(req.orgId).set({ orgId: req.orgId, monthlyReportingThreshold: th, updatedAt: new Date().toISOString(), updatedBy: req.user.id }, { merge: true });
    audit(req.orgId, req, 'tip_settings_updated', req.orgId, { monthlyReportingThreshold: th });
    res.json({ success: true, data: await getSettings(req.orgId) });
});

router.get('/tips/employees', VIEW, requireUsOrg, async (req, res) => {
    const people = (await loadPeople(req.orgId)).filter((p) => p.active);
    res.json({ success: true, data: people.map((p) => ({ id: p.id, employeeId: p.employeeId, name: p.name, tipped: p.tipped, payType: p.payType, payRate: p.payRate, workState: p.workState, workCity: p.workCity })) });
});

router.put('/tips/employees/:id/tipped', MANAGE, requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const tipped = req.body && (req.body.tipped === true || req.body.tipped === 'true');
    await emp.ref.set({ usProfile: { tipped } }, { merge: true });
    audit(req.orgId, req, 'tipped_flag_updated', emp.id, { tipped });
    res.json({ success: true, tipped });
});

router.post('/tips/card', MANAGE, requireUsOrg, async (req, res) => {
    const body = req.body || {};
    const emp = await findEmployee(req.orgId, String(body.userId || ''));
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const info = await orgInfo(req.orgId);
    const { errors, value } = T.validateEntry({ date: body.date, cashTips: 0, cardTips: body.cardTips, note: body.note }, todayIn(info.tz));
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ref = rawCollection('tip_records').doc(recId(emp.id, value.date));
    const snap = await ref.get(); const old = exists(snap) ? snap.data() : null;
    const doc = { orgId: req.orgId, userId: emp.id, date: value.date, cashTips: old ? old.cashTips || 0 : 0, cardTips: value.cardTips, note: old && old.note ? old.note : value.note, cardEnteredBy: req.user.id, cardEnteredAt: new Date().toISOString(), createdAt: old ? old.createdAt : new Date().toISOString() };
    await ref.set(doc);
    audit(req.orgId, req, 'tip_card_entered', emp.id, { date: value.date, cardTips: value.cardTips });
    res.status(201).json({ success: true, record: pubRec({ id: ref.id, ...doc }) });
});

router.get('/tips/records', VIEW, requireUsOrg, async (req, res) => {
    const { from, to, userId } = req.query;
    if ((from && !parseIsoDate(from)) || (to && !parseIsoDate(to))) return res.status(400).json({ success: false, error: 'from and to must be YYYY-MM-DD' });
    const [records, people] = await Promise.all([loadRecords(req.orgId, { from, to, userId }), loadPeople(req.orgId)]);
    const names = Object.fromEntries(people.map((p) => [p.id, p.name]));
    res.json({ success: true, data: records.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 500).map((r) => ({ ...pubRec(r), name: names[r.userId] || '' })) });
});

router.get('/tips/monthly', VIEW, requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const month = isMonth(req.query.month) ? req.query.month : todayIn(info.tz).slice(0, 7);
    const [records, people, settings] = await Promise.all([loadRecords(req.orgId), loadPeople(req.orgId), getSettings(req.orgId)]);
    const by = {};
    records.filter((r) => r.date.startsWith(month)).forEach((r) => { (by[r.userId] = by[r.userId] || []).push(r); });
    const names = Object.fromEntries(people.map((p) => [p.id, p]));
    const rows = Object.entries(by).map(([uid, recs]) => ({ userId: uid, name: (names[uid] || {}).name || '', employeeId: (names[uid] || {}).employeeId || '', ...T.monthlyTotal(recs, month, settings.monthlyReportingThreshold) }))
        .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, note: NOTE, month, threshold: settings.monthlyReportingThreshold, data: rows });
});

/** Tip credit check for one pay week (Monday) for every tipped employee, or for one with ?userId= */
router.get('/tips/credit-check', VIEW, requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const weekStart = req.query.weekStart || timeRules.weekStart(todayIn(info.tz));
    if (!parseIsoDate(weekStart) || timeRules.weekStart(weekStart) !== weekStart) return res.status(400).json({ success: false, error: 'weekStart must be a Monday (YYYY-MM-DD)' });
    const weekEnd = addDays(weekStart, 6);
    const [people, records, rules, hours] = await Promise.all([loadPeople(req.orgId), loadRecords(req.orgId, { from: weekStart, to: weekEnd }), loadRules(req.orgId), approvedHours(req.orgId, weekStart, weekStart)]);
    const W = require('../services/wage-rules');
    const rows = [];
    for (const p of people.filter((x) => x.active && x.tipped && (!req.query.userId || x.id === req.query.userId))) {
        const eff = W.effectiveMinimum(rules, { state: p.workState, city: p.workCity, county: p.workCounty }, weekEnd);
        const tips = round2(records.filter((r) => r.userId === p.id).reduce((s, r) => s + (r.cashTips || 0) + (r.cardTips || 0), 0));
        const h = hours[p.id] || 0;
        const row = { userId: p.id, name: p.name, workState: p.workState, weekStart, hours: h, tips, cashWage: p.payRate };
        if (!h) { rows.push({ ...row, status: 'no_approved_hours' }); continue; }
        if (eff.hourlyMinimum === null) { rows.push({ ...row, status: 'no_minimum_rule' }); continue; }
        const r = T.tipCreditCheck({ cashWage: Number(p.payRate) || 0, tips, hours: h, minimum: eff.hourlyMinimum, tippedCashWage: eff.tippedCashWage });
        rows.push({ ...row, status: r.ok ? 'ok' : 'shortfall', minimum: eff.hourlyMinimum, tippedCashWage: eff.tippedCashWage, ...r });
    }
    audit(req.orgId, req, 'tip_credit_checked', null, { weekStart, rows: rows.length });
    res.json({ success: true, note: NOTE, weekStart, weekEnd, data: rows });
});

/* ----------------------------------- pools ----------------------------------- */

const pubPool = (p) => ({ id: p.id, name: p.name, shareMethod: p.shareMethod, excludeManagers: p.excludeManagers, participants: p.participants, active: p.active !== false });

router.get('/tips/pools', VIEW, requireUsOrg, async (req, res) => {
    const snap = await rawCollection('tip_pools').where('orgId', '==', req.orgId).get();
    res.json({ success: true, data: snap.docs.map((d) => pubPool({ id: d.id, ...d.data() })).filter((p) => p.active) });
});

async function checkParticipants(orgId, participants) {
    const people = await loadPeople(orgId);
    const ids = new Set(people.map((p) => p.id));
    const bad = participants.filter((p) => !ids.has(p.userId));
    const byId = Object.fromEntries(people.map((p) => [p.id, p]));
    participants.forEach((p) => { if (byId[p.userId]) p.name = byId[p.userId].name; });
    return bad.map((p) => `participant ${p.userId} is not in your company`);
}

router.post('/tips/pools', MANAGE, requireUsOrg, async (req, res) => {
    const { errors, value } = T.validatePool(req.body);
    if (!errors.length) errors.push(...await checkParticipants(req.orgId, value.participants));
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ref = await rawCollection('tip_pools').add({ ...value, orgId: req.orgId, active: true, createdAt: new Date().toISOString(), createdBy: req.user.id });
    audit(req.orgId, req, 'tip_pool_created', ref.id, { name: value.name, participants: value.participants.length });
    res.status(201).json({ success: true, pool: pubPool({ id: ref.id, ...value }) });
});

router.put('/tips/pools/:id', MANAGE, requireUsOrg, async (req, res) => {
    const ref = rawCollection('tip_pools').doc(req.params.id); const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().active === false) return res.status(404).json({ success: false, error: 'Pool not found' });
    const { errors, value } = T.validatePool({ ...snap.data(), ...req.body });
    if (!errors.length) errors.push(...await checkParticipants(req.orgId, value.participants));
    if (errors.length) return res.status(400).json({ success: false, errors });
    await ref.set({ ...value, updatedAt: new Date().toISOString(), updatedBy: req.user.id }, { merge: true });
    audit(req.orgId, req, 'tip_pool_updated', ref.id);
    res.json({ success: true, pool: pubPool({ id: ref.id, ...value }) });
});

router.delete('/tips/pools/:id', MANAGE, requireUsOrg, async (req, res) => {
    const ref = rawCollection('tip_pools').doc(req.params.id); const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Pool not found' });
    await ref.update({ active: false, archivedAt: new Date().toISOString() });
    audit(req.orgId, req, 'tip_pool_archived', ref.id);
    res.json({ success: true });
});

/** Split an amount across a pool. Hours come from approved weeks between from and to (or an hours map in the body). */
router.post('/tips/pools/:id/distribute', MANAGE, requireUsOrg, async (req, res) => {
    const ref = rawCollection('tip_pools').doc(req.params.id); const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().active === false) return res.status(404).json({ success: false, error: 'Pool not found' });
    const pool = { id: ref.id, ...snap.data() };
    const b = req.body || {};
    const amount = Number(b.amount);
    if (!(amount > 0 && amount <= 1000000)) return res.status(400).json({ success: false, errors: ['amount must be greater than zero'] });
    if (!parseIsoDate(b.from) || !parseIsoDate(b.to) || b.to < b.from) return res.status(400).json({ success: false, errors: ['from and to must be valid dates, to on or after from'] });
    let hours = {};
    if (pool.shareMethod === 'hours') {
        hours = b.hours && typeof b.hours === 'object' ? b.hours : await approvedHours(req.orgId, timeRules.weekStart(b.from), b.to);
    }
    const result = T.distribute(pool, amount, hours);
    if (result.errors.length) return res.status(400).json({ success: false, errors: result.errors });
    const doc = { orgId: req.orgId, poolId: pool.id, poolName: pool.name, shareMethod: pool.shareMethod, from: b.from, to: b.to, amount: result.total, shares: result.shares, createdAt: new Date().toISOString(), createdBy: req.user.id };
    const out = await rawCollection('tip_distributions').add(doc);
    audit(req.orgId, req, 'tip_pool_distributed', pool.id, { distributionId: out.id, amount: result.total, from: b.from, to: b.to });
    res.status(201).json({ success: true, distribution: { id: out.id, ...doc } });
});

router.get('/tips/distributions', VIEW, requireUsOrg, async (req, res) => {
    const snap = await rawCollection('tip_distributions').where('orgId', '==', req.orgId).get();
    res.json({ success: true, data: snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100) });
});

/* ----------------------------------- report ----------------------------------- */

router.get('/tips/report', requireAnyPermission('people.read_pay', 'time.manage_rules'), requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    let { from, to } = req.query;
    if (req.query.month) {
        if (!isMonth(req.query.month)) return res.status(400).json({ success: false, error: 'month must be YYYY-MM' });
        from = `${req.query.month}-01`; to = new Date(Date.UTC(+req.query.month.slice(0, 4), +req.query.month.slice(5), 0)).toISOString().slice(0, 10);
    } else if (!from && !to) { from = timeRules.weekStart(todayIn(info.tz)); to = addDays(from, 6); }
    if (!parseIsoDate(from) || !parseIsoDate(to) || to < from) return res.status(400).json({ success: false, error: 'from and to must be valid dates (YYYY-MM-DD), to on or after from' });
    const [records, people, settings] = await Promise.all([loadRecords(req.orgId, { from, to }), loadPeople(req.orgId), getSettings(req.orgId)]);
    const rows = T.tipReportRows(records, Object.fromEntries(people.map((p) => [p.id, p])), from, to, settings.monthlyReportingThreshold);
    audit(req.orgId, req, 'tip_report_exported', null, { from, to, rows: rows.length, format: req.query.format || 'json' });
    if (req.query.format === 'csv') {
        res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', `attachment; filename="tips_${from}_${to}.csv"`); res.set('Cache-Control', 'no-store');
        return res.send(T.toCsv(T.TIP_REPORT_HEADER, rows));
    }
    res.json({ success: true, note: NOTE, from, to, threshold: settings.monthlyReportingThreshold, data: rows });
});

router.helpers = { getSettings, loadRecords };
module.exports = router;
