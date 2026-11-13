/** Data retention jobs for the caller's company: list, preview (dry run, default) and run. compliance.manage. */
const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit } = require('./us-hr').helpers;
const { requirePermission } = require('../services/permissions');
const jobs = require('../services/retention-jobs');

router.use(verifyToken);
const guard = [requirePermission('compliance.manage'), requireUsOrg];

router.get('/retention/jobs', ...guard, (req, res) => {
    res.json({ success: true, data: jobs.list(), note: 'Retention periods are suggestions. Confirm them with a US compliance advisor.' });
});

router.post('/retention/jobs/:key/run', ...guard, async (req, res) => {
    const dryRun = req.body.dryRun !== false;
    if (!dryRun && req.body.confirm !== 'DELETE') return res.status(400).json({ success: false, error: 'This permanently deletes data. Send dryRun:false and confirm:"DELETE" to run it for real.' });
    if (!jobs.list().some((j) => j.key === req.params.key)) return res.status(404).json({ success: false, error: 'Unknown job' });
    const r = await jobs.runJob(req.params.key, { orgId: req.orgId, dryRun, actor: req.user.id });
    audit(req.orgId, req, dryRun ? 'retention_job_previewed' : 'retention_job_run', req.params.key, { eligible: r.eligible, affected: r.affected, scanned: r.scanned });
    res.json({ success: true, result: r });
});

module.exports = router;
