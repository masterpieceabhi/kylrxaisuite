/**
 * The owner's company data: download everything, and close the account (owner only: billing.manage).
 *   GET    /api/us/company/export      a ZIP of every record and file (see services/company-data.js)
 *   GET    /api/us/company/closure     the closing, if any
 *   POST   /api/us/company/closure     { companyName } schedules deletion in 30 days
 *   DELETE /api/us/company/closure     undoes it before the day
 */
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit } = require('./us-hr').helpers;
const { requirePermission } = require('../services/permissions');
const D = require('../services/company-data');
const R = require('../services/company-data-rules');

router.use(verifyToken);
const guard = [requirePermission('billing.manage'), requireUsOrg];
const fail = (res, e) => res.status(e.statusCode || 500).json({ success: false, error: e.statusCode ? e.message : 'That did not work. Try again.' });

const lastExport = new Map();
const EXPORT_GAP_MS = 2 * 60 * 1000;

router.get('/company/export', ...guard, async (req, res) => {
    const last = lastExport.get(req.orgId) || 0;
    if (Date.now() - last < EXPORT_GAP_MS) return res.status(429).json({ success: false, error: 'A download was just made. Wait two minutes, then try again.' });
    lastExport.set(req.orgId, Date.now());
    try {
        const out = await D.buildExport(req.orgId);
        audit(req.orgId, req, 'company_data_exported', req.orgId, { records: Object.values(out.counts).reduce((a, b) => a + b, 0), files: out.files, unreadable: out.unreadable });
        const day = new Date().toISOString().slice(0, 10);
        const slug = String(out.companyName).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'company';
        res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="onnhr-${slug}-${day}.zip"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.send(out.zip);
    } catch (e) { lastExport.delete(req.orgId); fail(res, e); }
});

const view = (c) => (c ? { state: c.state, deleteOn: c.deleteOn || null, requestedAt: c.requestedAt || null, withdrawnAt: c.withdrawnAt || null, waitDays: R.WAIT_DAYS } : { state: 'none', waitDays: R.WAIT_DAYS });

router.get('/company/closure', ...guard, async (req, res) => {
    try { res.json({ success: true, closure: view(await D.status(req.orgId)) }); } catch (e) { fail(res, e); }
});

router.post('/company/closure', ...guard, async (req, res) => {
    try {
        const c = await D.requestClosure(req.orgId, { typedName: String(req.body.companyName || '').slice(0, 200), by: req.user.id, byEmail: req.user.email || null });
        audit(req.orgId, req, 'company_closure_requested', req.orgId, { deleteOn: c.deleteOn });
        res.status(201).json({ success: true, closure: view(c) });
    } catch (e) { fail(res, e); }
});

router.delete('/company/closure', ...guard, async (req, res) => {
    try {
        const c = await D.withdrawClosure(req.orgId, { by: req.user.id });
        audit(req.orgId, req, 'company_closure_withdrawn', req.orgId, {});
        res.json({ success: true, closure: view(c) });
    } catch (e) { fail(res, e); }
});

module.exports = router;
