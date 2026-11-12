/**
 * Custom report builder (US).
 *
 * Who may build and run a report: anyone holding reports.view, on the data sets their role may see
 *   (People for all of them; Equipment, Goals and Policy confirmations need people.read or people.write).
 * Pay columns need people.read_pay. Taxpayer numbers are in no data set.
 * Who may save, schedule and delete reports: HR, the owner and payroll admins.
 * A scheduled report gets a dated CSV copy each week or month; the newest 12 are kept.
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { can, requirePermission } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const B = require('../services/report-builder-rules');
const A = require('../services/asset-rules');
const G = require('../services/performance-rules');
const P = require('../services/policy-rules');
const peopleStore = require('../services/people-data-store');

router.use(verifyToken);
router.use('/report-builder', requirePermission('reports.view'), requireUsOrg);

const nowIso = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const todayFor = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const col = (n) => rawCollection(n);
const me = (req) => String(req.user.id || req.user.uid);
const who = (req) => req.user.name || req.user.email || 'someone';
const maySave = (req) => can(req.user, 'people.write') || can(req.user, 'payroll.run');
const allowedFor = (req) => B.datasetsFor((p) => can(req.user, p));
const day = (v) => (v ? String(v).slice(0, 10) : null);
const byOrg = async (name, orgId) => (await col(name).where('orgId', '==', orgId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

/* ------------------------------ the data sets ------------------------------ */

async function peopleRows(orgId) {
    const [users, roster, depts, locs] = await Promise.all([byOrg('users', orgId), byOrg('employees', orgId), byOrg('departments', orgId), byOrg('locations', orgId)]);
    const seen = new Set(users.map((u) => u.employeeId).filter(Boolean));
    const docs = [...users, ...roster.filter((r) => !r.employeeId || !seen.has(r.employeeId))].filter((p) => p.employeeId || p.usProfile);
    const dName = Object.fromEntries(depts.map((d) => [d.id, d.name])); const lName = Object.fromEntries(locs.map((l) => [l.id, l.name]));
    const nameOf = (p) => p.name || [p.usProfile && p.usProfile.legalFirstName, p.usProfile && p.usProfile.legalLastName].filter(Boolean).join(' ') || p.email || p.id;
    const names = Object.fromEntries(docs.map((p) => [p.id, nameOf(p)]));
    return docs.map((p) => {
        const up = p.usProfile || {};
        return { id: p.id, employeeId: p.employeeId || null, name: nameOf(p), email: p.email || null, status: p.status || 'Active', role: p.role || null, jobTitle: up.jobTitle || p.jobTitle || null,
            department: dName[up.departmentId] || p.departmentName || null, location: lName[up.workLocationId] || null, manager: names[up.managerId] || null, workState: up.workState || null,
            classification: up.classification || null, employmentType: up.employmentType || null, flsaStatus: up.flsaStatus || null, startDate: day(up.startDate || p.joiningDate), lastDay: day(up.termination && up.termination.lastDay),
            payType: up.payType || null, payRate: Number(up.payRate) || null, active: peopleStore.isActivePerson(p) };
    });
}
const LOADERS = {
    people: (orgId) => peopleRows(orgId),
    equipment: async (orgId) => (await byOrg('assets', orgId)).map((a) => ({ name: a.name, category: a.category, tag: a.tag || null, serial: a.serial || null, status: a.status, holder: a.assignedToName || null, givenOn: day(a.assignedAt), dueBack: a.dueBack || null,
        confirmed: a.status === 'assigned' ? (a.acknowledgedAt ? 'yes' : 'no') : null, condition: a.condition || null, cost: a.cost ?? null, purchaseDate: a.purchaseDate || null })),
    goals: async (orgId, today) => {
        const [goals, people] = await Promise.all([byOrg('performance_goals', orgId), peopleRows(orgId)]);
        const by = Object.fromEntries(people.map((p) => [p.id, p]));
        return goals.map((g) => { const p = by[g.userId] || {}; return { employeeId: p.employeeId || null, name: p.name || null, department: p.department || null, title: g.title, status: g.status, progress: g.progress || 0, dueDate: g.dueDate || null, late: G.isOverdue(g, today) ? 'yes' : 'no', setBy: g.createdByName || null, createdOn: day(g.createdAt) }; });
    },
    policy_confirmations: async (orgId) => {
        const [policies, acks, people] = await Promise.all([byOrg('policies', orgId), byOrg('policy_acks', orgId), peopleRows(orgId)]);
        const active = people.filter((p) => p.active).map((p) => ({ id: p.id, name: p.name, employeeId: p.employeeId }));
        const rows = [];
        for (const pol of policies) {
            const cur = P.currentVersion(pol); if (!cur || pol.status !== 'published' || !cur.requireAck) continue;
            for (const r of P.ackReport(pol, active, acks.filter((a) => a.policyId === pol.id)).rows) rows.push({ employeeId: r.employeeId, name: r.name, policy: cur.title, category: cur.category, version: cur.version, confirmed: r.done ? 'yes' : 'no', confirmedOn: day(r.at), versionRead: r.version });
        }
        return rows;
    }
};
async function execute(orgId, def, today) {
    const rows = await LOADERS[def.dataset](orgId, today || await todayFor(orgId));
    return B.runReport(def, rows);
}

/* ------------------------------ building and running ------------------------------ */

router.get('/report-builder/options', async (req, res) => {
    res.json({ success: true, datasets: allowedFor(req), ops: B.OPS, schedules: B.SCHEDULES, maxColumns: B.MAX_COLUMNS, maxFilters: B.MAX_FILTERS, maxRows: B.MAX_ROWS, canSave: maySave(req), canSeePay: can(req.user, 'people.read_pay') });
});

router.post('/report-builder/run', async (req, res) => {
    const { errors, value } = B.validateDefinition(req.body && req.body.definition, allowedFor(req));
    if (errors.length) return invalid(res, errors);
    const result = await execute(req.orgId, value);
    audit(req.orgId, req, 'report_run', value.dataset, { columns: value.columns, rows: result.total });
    res.json({ success: true, asOf: await todayFor(req.orgId), definition: value, result });
});

/* ------------------------------ saved reports ------------------------------ */

const usable = (req, r) => allowedFor(req).some((d) => d.key === r.dataset);
const hasPay = (r) => B.withoutPay(r).removed.length > 0;
const pubSaved = (r) => ({ id: r.id, name: r.name, dataset: r.dataset, columns: r.columns, filters: r.filters || [], sortBy: r.sortBy || null, sortDir: r.sortDir || 'asc', groupBy: r.groupBy || null, schedule: r.schedule || 'none', includesPay: hasPay(r), createdByName: r.createdByName || null, createdAt: r.createdAt, updatedAt: r.updatedAt || null, lastSnapshotDay: r.lastSnapshotDay || null });

async function ownedSaved(req, res) {
    const snap = await col('saved_reports').doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId || !usable(req, snap.data())) { fail(res, 404, 'Report not found'); return null; }
    return { ref: snap.ref, id: snap.id, data: { id: snap.id, ...snap.data() } };
}

router.get('/report-builder/saved', async (req, res) => {
    const data = (await byOrg('saved_reports', req.orgId)).filter((r) => usable(req, r)).map(pubSaved).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ success: true, canSave: maySave(req), data });
});

router.post('/report-builder/saved', async (req, res) => {
    if (!maySave(req)) return fail(res, 403, 'You do not have permission to save reports');
    const { errors, value } = B.validateDefinition({ ...(req.body || {}), requireName: true }, allowedFor(req));
    if (errors.length) return invalid(res, errors);
    const doc = { orgId: req.orgId, ...value, createdAt: nowIso(), createdBy: me(req), createdByName: who(req), lastSnapshotDay: null };
    const ref = await col('saved_reports').add(doc);
    audit(req.orgId, req, 'report_saved', ref.id, { name: value.name, dataset: value.dataset, schedule: value.schedule });
    res.status(201).json({ success: true, report: pubSaved({ id: ref.id, ...doc }) });
});

router.put('/report-builder/saved/:id', async (req, res) => {
    if (!maySave(req)) return fail(res, 403, 'You do not have permission to save reports');
    const r = await ownedSaved(req, res); if (!r) return;
    const { errors, value } = B.validateDefinition({ ...(req.body || {}), requireName: true }, allowedFor(req));
    if (errors.length) return invalid(res, errors);
    const patch = { ...value, updatedAt: nowIso(), updatedBy: me(req) };
    await r.ref.update(patch);
    audit(req.orgId, req, 'report_updated', r.id, { name: value.name, schedule: value.schedule });
    res.json({ success: true, report: pubSaved({ ...r.data, ...patch }) });
});

router.delete('/report-builder/saved/:id', async (req, res) => {
    if (!maySave(req)) return fail(res, 403, 'You do not have permission to delete reports');
    const r = await ownedSaved(req, res); if (!r) return;
    const snaps = await col('report_snapshots').where('reportId', '==', r.id).get();
    await Promise.all(snaps.docs.filter((d) => d.data().orgId === req.orgId).map((d) => d.ref.delete()));
    await r.ref.delete();
    audit(req.orgId, req, 'report_deleted', r.id, { name: r.data.name });
    res.json({ success: true });
});

/** The saved report as this person may run it: pay parts removed if they may not see pay */
function forViewer(req, res, saved) {
    if (can(req.user, 'people.read_pay')) return { def: saved, removed: [] };
    const cut = B.withoutPay(saved);
    if (cut.blocked) { fail(res, 403, 'This report filters or sorts on pay, which your role cannot see'); return null; }
    if (!cut.def.columns.length) { fail(res, 403, 'This report only has pay columns, which your role cannot see'); return null; }
    return cut;
}

router.post('/report-builder/saved/:id/run', async (req, res) => {
    const r = await ownedSaved(req, res); if (!r) return;
    const v = forViewer(req, res, r.data); if (!v) return;
    const result = await execute(req.orgId, v.def);
    audit(req.orgId, req, 'report_run', r.id, { name: r.data.name, rows: result.total });
    res.json({ success: true, asOf: await todayFor(req.orgId), report: pubSaved(r.data), removedColumns: v.removed, result });
});

/* ------------------------------ dated copies ------------------------------ */

/** Make and store a dated CSV copy of a saved report, and drop the oldest beyond the limit */
async function makeSnapshot(saved, today, by) {
    const result = await execute(saved.orgId, saved, today);
    const out = B.toCsv(result.columns, result.rows, B.CSV_MAX_CHARS);
    const doc = { orgId: saved.orgId, reportId: saved.id, name: saved.name, day: today, createdAt: nowIso(), by: by || 'schedule', total: result.total, rows: out.rows, cut: out.cut || result.truncated, includesPay: hasPay(saved), csv: out.csv };
    const ref = await col('report_snapshots').add(doc);
    await col('saved_reports').doc(saved.id).update({ lastSnapshotDay: today });
    const all = (await col('report_snapshots').where('reportId', '==', saved.id).get()).docs.filter((d) => d.data().orgId === saved.orgId).sort((a, b) => String(b.data().createdAt).localeCompare(String(a.data().createdAt)));
    await Promise.all(all.slice(B.SNAPSHOTS_KEPT).map((d) => d.ref.delete()));
    return { id: ref.id, ...doc };
}
const pubSnap = (s) => ({ id: s.id, day: s.day, createdAt: s.createdAt, by: s.by, total: s.total, rows: s.rows, cut: Boolean(s.cut), includesPay: Boolean(s.includesPay) });

router.get('/report-builder/saved/:id/copies', async (req, res) => {
    const r = await ownedSaved(req, res); if (!r) return;
    const snaps = (await col('report_snapshots').where('reportId', '==', r.id).get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.orgId === req.orgId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, report: pubSaved(r.data), kept: B.SNAPSHOTS_KEPT, data: snaps.map(pubSnap) });
});

router.post('/report-builder/saved/:id/copies', async (req, res) => {
    if (!maySave(req)) return fail(res, 403, 'You do not have permission to do this');
    const r = await ownedSaved(req, res); if (!r) return;
    if (hasPay(r.data) && !can(req.user, 'people.read_pay')) return fail(res, 403, 'This report includes pay, which your role cannot see');
    const snap = await makeSnapshot(r.data, await todayFor(req.orgId), who(req));
    audit(req.orgId, req, 'report_copy_made', r.id, { rows: snap.rows });
    res.status(201).json({ success: true, copy: pubSnap(snap) });
});

router.get('/report-builder/saved/:id/copies/:copyId', async (req, res) => {
    const r = await ownedSaved(req, res); if (!r) return;
    const snap = await col('report_snapshots').doc(String(req.params.copyId)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId || snap.data().reportId !== r.id) return fail(res, 404, 'Copy not found');
    if (snap.data().includesPay && !can(req.user, 'people.read_pay')) return fail(res, 403, 'This copy includes pay, which your role cannot see');
    audit(req.orgId, req, 'report_copy_downloaded', r.id, { copyId: snap.id, day: snap.data().day });
    res.json({ success: true, copy: pubSnap({ id: snap.id, ...snap.data() }), fileName: `${String(r.data.name).replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '-') || 'report'}-${snap.data().day}.csv`, csv: snap.data().csv });
});

/* ------------------------------ the schedule ------------------------------ */

/** Make the copies that are due, for every company. Returns how many were made. */
async function runDue() {
    const snap = await col('saved_reports').where('schedule', 'in', ['weekly', 'monthly']).get();
    let made = 0;
    for (const d of snap.docs) {
        const saved = { id: d.id, ...d.data() };
        try {
            const today = await todayFor(saved.orgId);
            if (!B.isDue(saved.schedule, saved.lastSnapshotDay || null, today)) continue;
            await makeSnapshot(saved, today, 'schedule'); made += 1;
        } catch (err) { console.error(`[ReportBuilder] scheduled copy failed for ${saved.id}: ${err.message}`); }
    }
    return made;
}
let timer = null;
function startJobs() {
    if (timer) return false;
    const tick = () => runDue().catch((err) => console.error(`[ReportBuilder] schedule check failed: ${err.message}`));
    setTimeout(tick, 60 * 1000).unref();
    timer = setInterval(tick, 60 * 60 * 1000); timer.unref();
    return true;
}

module.exports = router;
module.exports.startJobs = startJobs;
module.exports.runDue = runDue;
