const express = require('express');
const router = express.Router();
const customTemplateEngine = require('../services/custom-template-engine');
const logger = require('../utils/logger');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');

router.use(verifyToken);
router.use(authorize(ADMIN_HR_ROLES));

// Every call works on the caller's own company engine (templates, personal copies, versions)
router.use((req, res, next) => {
    const orgId = (req.user && req.user.orgId) || req.tenantOrgId;
    if (!orgId) return res.status(403).json({ success: false, error: 'No company on this account' });
    req.templateEngine = customTemplateEngine.forOrg(orgId);
    next();
});

/**
 * Customisable Templates REST API Router
 * Requirement 1.2 Customisable Templates & 1.3 Module-level templates
 */

// GET /api/custom-templates - List templates with module, status, role, scope filtering
router.get('/', (req, res) => {
    try {
        const { module, status, role, search, scope, ownerId, forGeneralUse } = req.query;
        const templates = req.templateEngine.listTemplates({ 
            module, 
            status, 
            role, 
            search, 
            scope, 
            ownerId, 
            forGeneralUse: forGeneralUse === 'true' 
        });
        res.status(200).json({ success: true, data: templates, total: templates.length });
    } catch (error) {
        logger.error('[CustomTemplatesAPI] Error listing templates:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/custom-templates/module/:module - Get templates for specific module
router.get('/module/:module', (req, res) => {
    try {
        const { status, role, scope } = req.query;
        const templates = req.templateEngine.listTemplates({ 
            module: req.params.module, 
            status, 
            role, 
            scope 
        });
        res.status(200).json({ success: true, module: req.params.module, data: templates, total: templates.length });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error getting module ${req.params.module} templates:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/custom-templates/:id/versions - Get all versions of a template
router.get('/:id/versions', (req, res) => {
    try {
        const versions = req.templateEngine.getTemplateVersions(req.params.id);
        res.status(200).json({ success: true, templateId: req.params.id, data: versions, total: versions.length });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error getting versions for ${req.params.id}:`, error);
        res.status(404).json({ success: false, error: error.message });
    }
});

// GET /api/custom-templates/:id - Get single template
router.get('/:id', (req, res) => {
    try {
        const template = req.templateEngine.getTemplate(req.params.id);
        res.status(200).json({ success: true, data: template });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error getting template ${req.params.id}:`, error);
        res.status(404).json({ success: false, error: error.message });
    }
});

// POST /api/custom-templates/shared - Administrator provides a shared template (PRD 1.3)
router.post('/shared', (req, res) => {
    try {
        const { name, module, category, description, instructions, permittedFields, lockedFields, structure, status, permissions, actor } = req.body;
        if (!name || !module) {
            return res.status(400).json({ success: false, error: 'Template name and module are required.' });
        }

        const sharedTemplate = req.templateEngine.provideSharedTemplate(
            { name, module, category, description, instructions, permittedFields, lockedFields, structure, status, permissions },
            actor || { name: 'Super Admin', role: 'super_admin' }
        );

        res.status(201).json({
            success: true,
            data: sharedTemplate,
            message: `Shared administrator template "${sharedTemplate.name}" created (${sharedTemplate.status}).`
        });
    } catch (error) {
        logger.error('[CustomTemplatesAPI] Error providing shared template:', error);
        const isPermission = error.message.includes('Permission Denied') || error.message.includes('not authorized');
        res.status(isPermission ? 403 : 500).json({ success: false, error: error.message });
    }
});

// POST /api/custom-templates - Create new template
router.post('/', (req, res) => {
    try {
        const { name, module, category, description, instructions, permittedFields, lockedFields, structure, status, permissions, scope, isPersonal, actor } = req.body;
        if (!name || !module) {
            return res.status(400).json({ success: false, error: 'Template name and module are required.' });
        }

        const newTemplate = req.templateEngine.createTemplate(
            { name, module, category, description, instructions, permittedFields, lockedFields, structure, status, permissions, scope, isPersonal },
            actor || { name: 'Admin', role: 'hr_admin' }
        );

        res.status(201).json({
            success: true,
            data: newTemplate,
            message: `Template "${newTemplate.name}" created (${newTemplate.status}).`
        });
    } catch (error) {
        logger.error('[CustomTemplatesAPI] Error creating template:', error);
        res.status(error.message.includes('not authorized') ? 403 : 500).json({ success: false, error: error.message });
    }
});

// POST /api/custom-templates/:id/personal-copy - Manager creates personal copy (PRD 1.3)
router.post('/:id/personal-copy', (req, res) => {
    try {
        const { actor, overrides } = req.body;
        const personalCopy = req.templateEngine.createPersonalCopy(
            req.params.id,
            actor || { name: 'Manager', role: 'manager' },
            overrides || {}
        );

        res.status(201).json({
            success: true,
            data: personalCopy,
            message: `Personal copy "${personalCopy.name}" created successfully.`
        });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error creating personal copy of ${req.params.id}:`, error);
        const isForbidden = error.message.includes('Permission Denied') || error.message.includes('not permitted');
        const isArchived = error.message.includes('Archived');
        res.status(isForbidden ? 403 : (isArchived ? 400 : 500)).json({ success: false, error: error.message });
    }
});

// POST /api/custom-templates/:id/archive - Archive template (PRD 1.3: Retained for history; unavailable for new use)
router.post('/:id/archive', (req, res) => {
    try {
        const { actor, reason } = req.body;
        const archived = req.templateEngine.archiveTemplate(
            req.params.id,
            actor || { name: 'Admin', role: 'hr_admin' },
            reason
        );

        res.status(200).json({
            success: true,
            data: archived,
            message: `Template "${archived.name}" archived. Retained for history; unavailable for new use.`
        });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error archiving template ${req.params.id}:`, error);
        const isForbidden = error.message.includes('Permission Denied');
        res.status(isForbidden ? 403 : 500).json({ success: false, error: error.message });
    }
});

// POST /api/custom-templates/:id/version - Create new version of template (PRD 1.3)
router.post('/:id/version', (req, res) => {
    try {
        const { versionData, actor } = req.body;
        if (!versionData) {
            return res.status(400).json({ success: false, error: 'versionData payload is required.' });
        }

        const updated = req.templateEngine.createTemplateVersion(
            req.params.id,
            versionData,
            actor || { name: 'Admin', role: 'hr_admin' }
        );

        res.status(200).json({
            success: true,
            data: updated,
            version: updated.version,
            message: `Template updated to version ${updated.version}. Existing records remain unaffected.`
        });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error versioning template ${req.params.id}:`, error);
        const isForbidden = error.message.includes('Permission Denied');
        res.status(isForbidden ? 403 : 500).json({ success: false, error: error.message });
    }
});

// PUT /api/custom-templates/:id - Edit permitted fields and instructions
router.put('/:id', (req, res) => {
    try {
        const { name, description, instructions, permittedFields, lockedFields, structure, changeNotes, actor, status } = req.body;
        const updated = req.templateEngine.updateTemplate(
            req.params.id,
            { name, description, instructions, permittedFields, lockedFields, structure, changeNotes, status },
            actor || { name: 'User', role: 'manager' }
        );

        res.status(200).json({
            success: true,
            data: updated,
            message: `Template "${updated.name}" updated successfully.`
        });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error updating template ${req.params.id}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/custom-templates/:id/preview - Pre-save preview
router.post('/:id/preview', (req, res) => {
    try {
        const { customFieldValues } = req.body;
        const preview = req.templateEngine.previewTemplate(req.params.id, customFieldValues || {});
        res.status(200).json({ success: true, data: preview });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error previewing template ${req.params.id}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/custom-templates/:id/save-draft - Save as draft
router.post('/:id/save-draft', (req, res) => {
    try {
        const { updates, actor } = req.body;
        const template = req.templateEngine.saveAsDraft(req.params.id, updates || {}, actor);
        res.status(200).json({
            success: true,
            data: template,
            message: `Template saved as draft.`
        });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error saving draft ${req.params.id}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/custom-templates/:id/publish - Publish template
router.post('/:id/publish', (req, res) => {
    try {
        const { actor } = req.body;
        const template = req.templateEngine.publishTemplate(req.params.id, actor || { name: 'Admin', role: 'hr_admin' });
        res.status(200).json({
            success: true,
            data: template,
            message: `Template "${template.name}" published successfully.`
        });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error publishing template ${req.params.id}:`, error);
        res.status(error.message.includes('permission') ? 403 : 500).json({ success: false, error: error.message });
    }
});

// PUT /api/custom-templates/:id/permissions - Administrator manages template permissions
router.put('/:id/permissions', (req, res) => {
    try {
        const { permissions, actor } = req.body;
        if (!permissions) {
            return res.status(400).json({ success: false, error: 'Permissions payload is required.' });
        }

        const template = req.templateEngine.updateTemplatePermissions(
            req.params.id,
            permissions,
            actor || { name: 'Super Admin', role: 'super_admin' }
        );

        res.status(200).json({
            success: true,
            data: template,
            message: `Permissions updated for template "${template.name}".`
        });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error updating permissions on ${req.params.id}:`, error);
        res.status(error.message.includes('Access Denied') ? 403 : 500).json({ success: false, error: error.message });
    }
});

// POST /api/custom-templates/:id/instantiate - Instantiate template with permitted values
router.post('/:id/instantiate', (req, res) => {
    try {
        const { userInputs, actor } = req.body;
        const instantiated = req.templateEngine.instantiateTemplate(req.params.id, userInputs || {}, actor);
        res.status(200).json({
            success: true,
            data: instantiated,
            message: `Template "${instantiated.templateName}" instantiated successfully.`
        });
    } catch (error) {
        logger.error(`[CustomTemplatesAPI] Error instantiating template ${req.params.id}:`, error);
        const isForbidden = error.message.includes('Denied') || error.message.includes('not permitted');
        const isStatusError = error.message.includes('Archived') || error.message.includes('Draft');
        res.status(isForbidden ? 403 : (isStatusError ? 400 : 500)).json({ success: false, error: error.message });
    }
});

module.exports = router;
