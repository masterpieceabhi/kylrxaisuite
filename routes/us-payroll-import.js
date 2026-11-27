/**
 * Historical payroll import (US): bring past pay in from a CSV, mounted under /api/us/payroll-import.
 *
 * Everything here needs payroll.run (the owner and payroll admins).
 *   POST   /payroll-import/preview       checks a file and returns the rows, problems and totals; nothing is saved
 *   POST   /payroll-import/commit        saves the file as one batch, or nothing at all when any row has a problem
 *   GET    /payroll-import/batches       the imports made so far
 *   GET    /payroll-import/batches/:id   one import with its rows
 *   DELETE /payroll-import/batches/:id   undo: removes only the rows of that import
 *
 * Rows go into `pay_results`, the collection the payroll cost report, the accounting journal and the public API
 * already read, marked `source: 'import'` with a payroll id that starts with `import_`.
 */
const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { requirePermission } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const I = require('../services/payroll-import-rules');
const peopleStore = require('../services/people-data-store');

router.use(verifyToken);

const RUN = [requirePermission('payroll.run'), requireUsOrg];
const RESULTS = 'pay_results';
const BATCHES = 'payroll_import_batches';
const CHUNK = 400; // a Firestore write batch takes at most 500 writes
const nowIso = () => new Date().toISOString();
const fail = (res, code, error, extra = {}) => res.status(code).json({ success: false, error, ...extra });
const today = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const col = (n) => rawCollection(n);
const me = (req) => String(req.user.id || req.user.uid);
const who = (req) => req.user.name || req.user.email || 'someone';
const taken = (err) => Boolean(err && (err.code === 6 || /already exists/i.test(String(err.message))));
const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const chunks = (list) => { const out = []; for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK)); return out; };

/** Checks the file against this company's people and the pay it already has */
async function checkFor(orgId, csv) {
    const [people, departments, existing, t] = await Promise.all([peopleStore.loadPeople(orgId, { includeInactive: true }), peopleStore.listByOrg('departments', orgId), peopleStore.listByOrg(RESULTS, orgId), today(orgId)]);
    const dept = new Map(departments.map((d) => [d.id, d.name || d.code || null]));
    return I.checkFile(csv, { today: t, existing: existing.map((r) => ({ userId: r.userId, payDate: r.payDate, source: r.source })),
        people: people.map((p) => ({ id: p.id, employeeId: p.employeeId, name: p.name, department: dept.get(p.departmentId) || null })) });
}
/** What the page shows of a checked file */
const previewOf = (c) => ({ ok: c.ok, fileErrors: c.fileErrors, errorCount: c.errorCount, errorRows: c.errorRows, warningCount: c.warningCount, totals: c.totals,
    rows: c.rows.map((r) => ({ row: r.row, errors: r.errors, warnings: r.warnings, name: r.value ? r.value.name : null, ...(r.value ? { employeeNumber: r.value.employeeId, payDate: r.value.payDate, periodStart: r.value.periodStart, periodEnd: r.value.periodEnd, gross: r.value.gross, net: r.value.net, employeeTaxes: r.value.employeeTaxes, employerTaxes: r.value.employerTaxes, deductions: r.value.deductions, hours: r.value.hours, checkNumber: r.value.checkNumber } : r.raw) })) });
/** Every problem as one plain line */
const errorLines = (c) => [...c.fileErrors, ...c.rows.flatMap((r) => r.errors.map((e) => `Row ${r.row}: ${e}`))];
const batchView = (b) => ({ id: b.id, status: b.status, fileName: b.fileName || null, note: b.note || null, rows: b.rows, people: b.people, firstPayDate: b.firstPayDate || null, lastPayDate: b.lastPayDate || null, totals: b.totals || null, warningCount: b.warningCount || 0,
    createdAt: b.createdAt, createdByName: b.createdByName || null, undoneAt: b.undoneAt || null, undoneByName: b.undoneByName || null });
const csvOf = (req) => (req.body && typeof req.body.csv === 'string' ? req.body.csv : '');

async function ownedBatch(req, res) {
    const snap = await col(BATCHES).doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { fail(res, 404, 'Import not found'); return null; }
    return { ref: snap.ref, id: snap.id, data: { id: snap.id, ...snap.data() } };
}
/** The saved rows of one import, of this company only */
async function rowsOf(orgId, batchId) {
    const snap = await col(RESULTS).where('importBatchId', '==', batchId).get();
    return snap.docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() })).filter((r) => r.orgId === orgId && r.source === I.SOURCE);
}
async function removeRows(rows) {
    for (const part of chunks(rows)) { const b = db.batch(); part.forEach((r) => b.delete(r.ref)); await b.commit(); }
}

router.get('/payroll-import/options', ...RUN, async (req, res) => {
    res.json({ success: true, note: I.NOTE, columns: I.COLUMNS.map((c) => ({ key: c.key, label: c.label, required: c.required })), maxRows: I.MAX_ROWS, maxChars: I.MAX_CHARS, template: I.templateCsv(), today: await today(req.orgId) });
});

router.post('/payroll-import/preview', ...RUN, async (req, res) => {
    const checked = await checkFor(req.orgId, csvOf(req));
    audit(req.orgId, req, 'payroll_import_previewed', null, { rows: checked.rows.length, errorRows: checked.errorRows, fileErrors: checked.fileErrors.length });
    res.json({ success: true, note: I.NOTE, ...previewOf(checked), errorsCsv: checked.ok ? null : I.errorsCsv(checked) });
});

router.post('/payroll-import/commit', ...RUN, async (req, res) => {
    const b = req.body || {};
    const checked = await checkFor(req.orgId, csvOf(req));
    if (!checked.ok) {
        audit(req.orgId, req, 'payroll_import_refused', null, { rows: checked.rows.length, errorRows: checked.errorRows, fileErrors: checked.fileErrors.length });
        return res.status(400).json({ success: false, error: 'Nothing was saved. Fix the problems in the file and try again.', errors: errorLines(checked).slice(0, 200), ...previewOf(checked) });
    }
    // the person confirms the totals they saw in the preview; if the file or the company's data changed since, they look again
    if (b.expectRows !== undefined && Number(b.expectRows) !== checked.totals.rows) return fail(res, 409, 'The file is not the one you previewed. Preview it again, then confirm.');
    if (b.expectGross !== undefined && Math.round(Number(b.expectGross) * 100) !== Math.round(checked.totals.gross * 100)) return fail(res, 409, 'The totals are not the ones you previewed. Preview the file again, then confirm.');

    const at = nowIso();
    const ref = col(BATCHES).doc();
    const { rows: rowCount, people, firstPayDate, lastPayDate, ...sums } = checked.totals;
    const batch = { orgId: req.orgId, status: 'saving', fileName: clean(b.fileName, 120) || null, note: clean(b.note, 300) || null, rows: rowCount, people, firstPayDate, lastPayDate, totals: sums, warningCount: checked.warningCount, createdAt: at, createdBy: me(req), createdByName: who(req) };
    await ref.set(batch);
    const docs = I.toPayResults(checked, { orgId: req.orgId, batchId: ref.id, nowIso: at });
    const saved = [];
    try {
        // .create() refuses a row whose id (company + person + pay date) is already there, so two people importing the same pay cannot both succeed
        for (const part of chunks(docs)) {
            const w = db.batch();
            part.forEach(({ id, ...doc }) => w.create(col(RESULTS).doc(id), doc));
            await w.commit();
            saved.push(...part);
        }
    } catch (err) {
        // all or nothing: take back whatever this import already wrote, and only that
        try { await removeRows(await rowsOf(req.orgId, ref.id)); await ref.delete(); } catch (_) { await ref.set({ status: 'failed', failedAt: nowIso() }, { merge: true }).catch(() => {}); }
        audit(req.orgId, req, 'payroll_import_failed', ref.id, { rows: docs.length, savedBeforeFailure: saved.length, duplicate: taken(err) });
        if (taken(err)) return fail(res, 409, 'Nothing was saved. Some of this pay was imported a moment ago. Preview the file again.');
        throw err;
    }
    await ref.set({ status: 'saved', savedAt: nowIso() }, { merge: true });
    audit(req.orgId, req, 'payroll_import_saved', ref.id, { rows: rowCount, people, firstPayDate, lastPayDate, gross: sums.gross, net: sums.net, fileName: batch.fileName });
    res.status(201).json({ success: true, batch: batchView({ id: ref.id, ...batch, status: 'saved' }) });
});

router.get('/payroll-import/batches', ...RUN, async (req, res) => {
    const rows = (await peopleStore.listByOrg(BATCHES, req.orgId)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, data: rows.map(batchView) });
});

router.get('/payroll-import/batches/:id', ...RUN, async (req, res) => {
    const b = await ownedBatch(req, res); if (!b) return;
    const rows = (await rowsOf(req.orgId, b.id)).sort((x, y) => (x.importRow || 0) - (y.importRow || 0));
    audit(req.orgId, req, 'payroll_import_viewed', b.id, { rows: rows.length });
    res.json({ success: true, batch: batchView(b.data), payrollUuid: I.payrollIdOf(b.id), totals: I.totalsOf(rows),
        rows: rows.map((r) => ({ id: r.id, source: r.source, row: r.importRow || null, userId: r.userId, employeeId: r.employeeId || null, name: r.name || null, department: r.department || null, payDate: r.payDate, periodStart: r.periodStart, periodEnd: r.periodEnd, gross: r.gross, net: r.net, employeeTaxes: r.employeeTaxes, employerTaxes: r.employerTaxes, deductions: r.deductions, hours: r.hours, checkNumber: r.checkNumber || null })) });
});

router.delete('/payroll-import/batches/:id', ...RUN, async (req, res) => {
    const b = await ownedBatch(req, res); if (!b) return;
    const blocked = I.undoError(b.data);
    if (blocked) return fail(res, 409, blocked);
    const rows = await rowsOf(req.orgId, b.id);
    await removeRows(rows);
    // the record of the import stays, marked undone, so the history of what was brought in and taken out is kept
    const patch = { status: 'undone', undoneAt: nowIso(), undoneBy: me(req), undoneByName: who(req), removedRows: rows.length };
    await b.ref.set(patch, { merge: true });
    audit(req.orgId, req, 'payroll_import_undone', b.id, { removedRows: rows.length, gross: (b.data.totals || {}).gross });
    res.json({ success: true, removedRows: rows.length, batch: batchView({ ...b.data, ...patch }) });
});

module.exports = router;
