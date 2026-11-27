const express = require('express');
const router = express.Router();
const controlsAcceptanceService = require('../services/controls-acceptance-service');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);

// Every call works on the caller's own company (decisions, sign-offs, and the template and bulk engines it checks)
router.use((req, res, next) => {
    const orgId = (req.user && req.user.orgId) || req.tenantOrgId;
    if (!orgId) return res.status(403).json({ success: false, error: 'No company on this account' });
    req.controls = controlsAcceptanceService.forOrg(orgId);
    next();
});

/**
 * 4.1 Common Platform Requirements Overview & Telemetry
 * GET /api/controls-acceptance/platform-controls
 */
router.get('/platform-controls', (req, res) => {
    try {
        const summary = req.controls.getPlatformRequirementsSummary();
        res.json({
            success: true,
            data: summary
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 4.2 Acceptance Criteria Live Verification Matrix
 * GET /api/controls-acceptance/criteria-matrix
 */
router.get('/criteria-matrix', async (req, res) => {
    try {
        const results = await req.controls.verifyAcceptanceCriteria();
        res.json({
            success: true,
            data: results
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 4.3 Client Decisions Required Management
 * GET /api/controls-acceptance/decisions
 */
router.get('/decisions', (req, res) => {
    try {
        const decisions = req.controls.getAllClientDecisions();
        res.json({
            success: true,
            data: decisions
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/controls-acceptance/decisions/:id
 */
router.get('/decisions/:id', (req, res) => {
    try {
        const decision = req.controls.getClientDecisionById(req.params.id);
        if (!decision) {
            return res.status(404).json({ success: false, error: `Decision '${req.params.id}' not found.` });
        }
        res.json({ success: true, data: decision });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/controls-acceptance/decisions/:id
 */
router.post('/decisions/:id', authorize(ADMIN_HR_ROLES), (req, res) => {
    try {
        const actor = req.body.actor || {
            id: req.headers['x-user-id'] || 'client-rep-1',
            name: req.headers['x-user-name'] || 'Client Representative',
            role: req.headers['x-user-role'] || 'client_executive',
            organization: req.body.organization || 'Client Organization'
        };

        const updated = req.controls.recordClientDecision(req.params.id, req.body, actor);
        res.json({
            success: true,
            message: `Decision '${req.params.id}' confirmed successfully.`,
            data: updated
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/controls-acceptance/decisions/batch-confirm
 */
router.post('/decisions/batch-confirm', authorize(ADMIN_HR_ROLES), (req, res) => {
    try {
        const actor = req.body.actor || {
            id: req.headers['x-user-id'] || 'client-rep-batch',
            name: req.body.representativeName || req.headers['x-user-name'] || 'Client Representative',
            role: 'client_executive'
        };

        const confirmed = req.controls.batchConfirmAllRecommendations(actor);
        res.json({
            success: true,
            message: `All ${confirmed.length} recommendations batch-confirmed successfully.`,
            data: confirmed
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * 4.4 Delivery Phasing & Recommended Next Steps
 * GET /api/controls-acceptance/delivery-roadmap
 */
router.get('/delivery-roadmap', (req, res) => {
    try {
        const roadmap = req.controls.getDeliveryRoadmap();
        res.json({
            success: true,
            data: roadmap
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/controls-acceptance/sign-off
 * Records formal client approval and generates tamper-evident certificate
 */
router.post('/sign-off', authorize(ADMIN_HR_ROLES), (req, res) => {
    try {
        const approvalRecord = req.controls.recordClientApproval(req.body);
        res.status(201).json({
            success: true,
            message: 'Formal client scope sign-off successfully registered and sealed.',
            data: approvalRecord
        });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/controls-acceptance/sign-off/status
 */
router.get('/sign-off/status', (req, res) => {
    try {
        const latest = req.controls.getLatestSignOff();
        const all = req.controls.getAllSignOffRecords();
        res.json({
            success: true,
            data: {
                isSigned: Boolean(latest),
                latestCertificate: latest,
                allSignOffs: all
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
