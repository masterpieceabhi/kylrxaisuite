const express = require('express');
const router = express.Router();
const documentTemplateEngine = require('../services/document-template-engine');
const logger = require('../utils/logger');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);

// Every call works on the caller's own company engine (template versions, approvals, generated documents)
router.use((req, res, next) => {
    const orgId = (req.user && req.user.orgId) || req.tenantOrgId;
    if (!orgId) return res.status(403).json({ success: false, error: 'No company on this account' });
    req.docEngine = documentTemplateEngine.forOrg(orgId);
    next();
});

/**
 * 11. Document & Template Integration REST API
 * 
 * Centralizes all document generation via the Document/Template Engine.
 * Full Automation delegates document-generation logic to this engine.
 * 
 * IMPORTANT: Static routes (/generate, /generated) MUST be registered
 * BEFORE dynamic routes (/:key) to avoid Express matching them as :key params.
 * 
 * Supports:
 * - Versioning (draft -> pending_approval -> approved)
 * - Effective dates (effectiveFrom / effectiveTo)
 * - Approval lifecycle with audit
 * - Employee-field mapping with token interpolation
 * - Permitted modules security gating
 */

// GET /api/document-templates - List all 10 standard templates
router.get('/', (req, res) => {
    try {
        const templates = req.docEngine.listTemplates();
        res.status(200).json({ success: true, data: templates, total: templates.length });
    } catch (error) {
        logger.error('[DocumentTemplatesAPI] Error listing templates:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/document-templates/generate - Generate document from permitted module
// MUST be before /:key to avoid Express matching 'generate' as a key param
router.post('/generate', async (req, res) => {
    try {
        const { templateKey, dataContext, callerModule, actor, asOfDate } = req.body || {};
        if (!templateKey) {
            return res.status(400).json({ success: false, error: 'templateKey is required.' });
        }

        const docRecord = await req.docEngine.generateDocument(
            templateKey,
            dataContext || {},
            { callerModule: callerModule || 'hr_admin', actor: actor || 'HR Administrator', asOfDate }
        );

        res.status(200).json({
            success: true,
            data: {
                docId: docRecord.docId,
                templateName: docRecord.templateName,
                versionNumber: docRecord.versionNumber,
                sha256: docRecord.sha256,
                recipientName: docRecord.recipientName,
                generatedAt: docRecord.generatedAt
            },
            message: `Document '${docRecord.docId}' generated successfully.`
        });
    } catch (error) {
        const isPermissionError = error.message.includes('not permitted');
        logger.error(`[DocumentTemplatesAPI] Error generating document:`, error);
        res.status(isPermissionError ? 403 : 500).json({ success: false, error: error.message });
    }
});

// GET /api/document-templates/generated - List generated documents archive
// MUST be before /:key and /generated/:docId to avoid ambiguity
router.get('/generated', (req, res) => {
    try {
        const { templateKey, recipientId, limit } = req.query;
        const docs = req.docEngine.listGeneratedDocuments({
            templateKey,
            recipientId,
            limit: limit ? parseInt(limit, 10) : 50
        });
        res.status(200).json({ success: true, data: docs, total: docs.length });
    } catch (error) {
        logger.error('[DocumentTemplatesAPI] Error listing generated documents:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/document-templates/generated/:docId - View single generated document
router.get('/generated/:docId', (req, res) => {
    try {
        const doc = req.docEngine.getGeneratedDocument(req.params.docId);
        res.status(200).json({ success: true, data: doc });
    } catch (error) {
        logger.error(`[DocumentTemplatesAPI] Error fetching generated document '${req.params.docId}':`, error);
        res.status(404).json({ success: false, error: error.message });
    }
});

// GET /api/document-templates/:key - Full template detail with version history
router.get('/:key', (req, res) => {
    try {
        const template = req.docEngine.getTemplate(req.params.key);
        res.status(200).json({ success: true, data: template });
    } catch (error) {
        logger.error(`[DocumentTemplatesAPI] Error fetching template '${req.params.key}':`, error);
        res.status(404).json({ success: false, error: error.message });
    }
});

// POST /api/document-templates/:key/versions - Create new draft version
router.post('/:key/versions', authorize(ADMIN_HR_ROLES), (req, res) => {
    try {
        const { versionNumber, templateBody, effectiveFrom, changeNotes, createdBy, fieldMappings } = req.body || {};
        if (!versionNumber || !templateBody) {
            return res.status(400).json({ success: false, error: 'versionNumber and templateBody are required.' });
        }

        const newVersion = req.docEngine.createTemplateVersion(req.params.key, {
            versionNumber,
            templateBody,
            effectiveFrom,
            changeNotes,
            createdBy: createdBy || 'HR Admin',
            fieldMappings
        });

        res.status(201).json({ success: true, data: newVersion, message: `Version '${versionNumber}' created as draft.` });
    } catch (error) {
        logger.error(`[DocumentTemplatesAPI] Error creating version for '${req.params.key}':`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/document-templates/:key/versions/:versionNumber/approve - Approve a version
router.post('/:key/versions/:versionNumber/approve', authorize(ADMIN_HR_ROLES), (req, res) => {
    try {
        const { approvedBy, approvalRemarks } = req.body || {};
        const approved = req.docEngine.approveTemplateVersion(
            req.params.key,
            req.params.versionNumber,
            { approvedBy: approvedBy || 'HR Director', approvalRemarks: approvalRemarks || 'Approved for production use.' }
        );
        res.status(200).json({ success: true, data: approved, message: `Version '${req.params.versionNumber}' approved.` });
    } catch (error) {
        logger.error(`[DocumentTemplatesAPI] Error approving version '${req.params.versionNumber}' for '${req.params.key}':`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/document-templates/:key/preview - Render preview with sample or custom data
router.post('/:key/preview', (req, res) => {
    try {
        const { versionNumber, dataContext } = req.body || {};
        const preview = req.docEngine.previewTemplate(req.params.key, { versionNumber, dataContext: dataContext || {} });
        res.status(200).json({ success: true, data: preview });
    } catch (error) {
        logger.error(`[DocumentTemplatesAPI] Error previewing template '${req.params.key}':`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
