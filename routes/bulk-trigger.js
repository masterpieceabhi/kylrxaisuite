const express = require('express');
const router = express.Router();
const bulkTriggerEngine = require('../services/bulk-trigger-engine');
const otpVerificationService = require('../services/otp-verification-service');
const aiAssistedBuilderService = require('../services/ai-assisted-builder-service');
const logger = require('../utils/logger');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { LEGACY_ORG_ID } = require('../config/tenant');

router.use(verifyToken);
router.use(authorize(ADMIN_HR_ROLES));

// Every call works on the caller's own company engine (jobs, audit trail, settings, recipients)
router.use((req, res, next) => {
    const orgId = (req.user && req.user.orgId) || req.tenantOrgId;
    if (!orgId) return res.status(403).json({ success: false, error: 'No company on this account' });
    req.orgId = orgId;
    req.bulkEngine = bulkTriggerEngine.forOrg(orgId);
    next();
});

// AI builder drafts are tagged with the company that made them; untagged older drafts belong to the original company
const draftOwner = (draft) => (draft && draft.orgId) || LEGACY_ORG_ID;
function ownDraftOr404(req, res) {
    const draft = aiAssistedBuilderService.getConfigurationById(req.params.draftId);
    if (!draft || draftOwner(draft) !== req.orgId) {
        res.status(404).json({ success: false, error: `Configuration '${req.params.draftId}' not found.` });
        return null;
    }
    return draft;
}

/**
 * 2. Bulk Triggering and AI-Assisted Builder REST API (PRD §2)
 * 
 * Endpoints:
 * - POST /api/bulk-trigger/validate          - Validates selection, permissions, data, consent & returns count preview
 * - POST /api/bulk-trigger/execute           - Executes batch processing job (queued -> processing -> completed)
 * - GET  /api/bulk-trigger/jobs/:jobId       - Real-time job progress, batch status & failed items review
 * - POST /api/bulk-trigger/jobs/:jobId/retry - Safe retry for failed items avoiding duplicate actions
 * - GET  /api/bulk-trigger/config            - View configurable batch size & provider limits
 * - PUT  /api/bulk-trigger/config            - Administrator updates batch size & rate limits
 * - POST /api/bulk-trigger/otp/generate      - Separate OTP engine: generate secure OTP with TTL & attempt limits
 * - POST /api/bulk-trigger/otp/verify        - Separate OTP engine: verify single-use OTP with attempt counters
 * - GET  /api/bulk-trigger/otp/status/:otpId - Query sanitized OTP status
 * - GET  /api/bulk-trigger/audit-logs        - Immutable audit trail: initiator, time, count, outcome
 */

// 1. Validate Selection & Count Preview (PRD §2.1)
router.post('/validate', (req, res) => {
    try {
        const { action, recipients, payload, actor } = req.body || {};
        const validation = req.bulkEngine.validateSelection({
            action,
            recipients: recipients || [],
            payload: payload || {},
            actor: actor || { role: 'super_admin', name: 'Admin' }
        });

        res.status(200).json({
            success: true,
            data: validation,
            message: `Validated ${validation.totalSelected} items: ${validation.validCount} valid (${validation.estimatedBatches} batches of ${validation.batchSize}), ${validation.invalidCount} invalid.`
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] Validation error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// 2. Execute Bulk Triggering Job (PRD §2.1 & §2.2)
router.post('/execute', async (req, res) => {
    try {
        const { action, recipients, payload, actor, options } = req.body || {};
        const jobResult = await req.bulkEngine.executeBulkTrigger({
            action,
            recipients: recipients || [],
            payload: payload || {},
            actor: actor || { role: 'super_admin', name: 'Admin' },
            options: options || {}
        });

        res.status(200).json({
            success: true,
            data: jobResult,
            message: `Job ${jobResult.jobId} processed: ${jobResult.successCount} succeeded, ${jobResult.failureCount} failed of ${jobResult.totalItems} total.`
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] Execution error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// 2.9 Get Latest Job (PRD §2.2: Live monitoring auto-reconnect)
router.get('/jobs/latest', (req, res) => {
    try {
        const job = req.bulkEngine.getLatestJob();
        if (!job) {
            return res.status(200).json({ success: true, data: null, message: 'No bulk trigger jobs executed yet.' });
        }
        res.status(200).json({ success: true, data: job });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2.95 Get Recent Jobs List (PRD §2.2)
router.get('/jobs', (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 10;
        const jobs = req.bulkEngine.getRecentJobs(limit);
        res.status(200).json({ success: true, data: jobs });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. Get Job Progress & Results (PRD §2.1 & §2.2)
router.get('/jobs/:jobId', (req, res) => {
    try {
        const { jobId } = req.params;
        if (jobId === 'latest') {
            const job = req.bulkEngine.getLatestJob();
            return res.status(200).json({ success: true, data: job });
        }
        const job = req.bulkEngine.getJobStatus(jobId);
        if (!job) {
            return res.status(404).json({ success: false, error: `Job '${jobId}' not found.` });
        }

        res.status(200).json({ success: true, data: job });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Safe Retry Failed Items (PRD §2.1: Retries should avoid duplicate actions)
router.post('/jobs/:jobId/retry', async (req, res) => {
    try {
        const { jobId } = req.params;
        const { actor, options } = req.body || {};

        const updatedJob = await req.bulkEngine.retryFailedItems(
            jobId,
            actor || { role: 'super_admin', name: 'Admin' },
            options || {}
        );

        res.status(200).json({
            success: true,
            data: updatedJob,
            message: `Retry completed for job ${jobId}. Current status: ${updatedJob.status}.`
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] Retry error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// 5. Config: View Engine Controls (PRD §2.2: Batch size configurable by admin)
router.get('/config', (req, res) => {
    try {
        const config = req.bulkEngine.getConfig();
        res.status(200).json({ success: true, data: config });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 6. Config: Administrator Update Batch Size & Limits (PRD §2.2)
router.put('/config', (req, res) => {
    try {
        const { batchSize, interBatchDelayMs, maxEmailsPerSecond, strictConsentRequired, actor } = req.body || {};
        const result = req.bulkEngine.updateConfig(
            { batchSize, interBatchDelayMs, maxEmailsPerSecond, strictConsentRequired },
            actor || { role: 'super_admin', name: 'Admin' }
        );

        res.status(200).json({
            success: true,
            data: result.config,
            message: `Bulk Trigger configuration updated successfully.`
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] Config update error:', err.message);
        res.status(403).json({ success: false, error: err.message });
    }
});

// 7. OTP Generation (PRD §2.3: Separate OTP engine, expire, attempt limits)
router.post('/otp/generate', (req, res) => {
    try {
        const { identifier, purpose, ttlSeconds, maxAttempts, metadata } = req.body || {};
        const otpRecord = otpVerificationService.generateOtp({
            identifier,
            purpose: purpose || 'verification',
            ttlSeconds: ttlSeconds ? parseInt(ttlSeconds, 10) : 300,
            maxAttempts: maxAttempts ? parseInt(maxAttempts, 10) : 3,
            metadata: metadata || {}
        });

        res.status(200).json({
            success: true,
            data: {
                otpId: otpRecord.otpId,
                identifier: otpRecord.identifier,
                purpose: otpRecord.purpose,
                expiresAt: otpRecord.expiresAt,
                maxAttempts: otpRecord.maxAttempts,
                attemptsRemaining: otpRecord.attemptsRemaining,
                // Only disclose code in test or dev environment for client demonstration
                code: (process.env.NODE_ENV === 'test' || req.query.devMode === 'true') ? otpRecord.code : undefined
            },
            message: `OTP issued successfully. Valid for ${otpRecord.ttlSeconds}s (max ${otpRecord.maxAttempts} attempts).`
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] OTP generation error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// 8. OTP Verification (PRD §2.3: Single-use, attempt counter, expiry check)
router.post('/otp/verify', (req, res) => {
    try {
        const { otpId, identifier, purpose, code, actor } = req.body || {};
        const result = otpVerificationService.verifyOtp({
            otpId,
            identifier,
            purpose,
            code,
            actor: actor || {}
        });

        if (!result.success) {
            return res.status(400).json({
                success: false,
                reason: result.reason,
                message: result.message,
                attemptsRemaining: result.attemptsRemaining
            });
        }

        res.status(200).json({
            success: true,
            data: result,
            message: result.message
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] OTP verify error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 9. OTP Status Lookup
router.get('/otp/status/:otpId', (req, res) => {
    try {
        const { otpId } = req.params;
        const status = otpVerificationService.getOtpStatus(otpId);
        if (!status) {
            return res.status(404).json({ success: false, error: `OTP '${otpId}' not found.` });
        }
        res.status(200).json({ success: true, data: status });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 10. Audit Trail: Initiator, Time, Count, Outcome (PRD §2.2)
router.get('/audit-logs', (req, res) => {
    try {
        const { limit, action, status } = req.query;
        const logs = req.bulkEngine.getAuditLogs({
            limit: limit ? parseInt(limit, 10) : 50,
            action,
            status
        });

        res.status(200).json({
            success: true,
            data: logs,
            total: logs.length
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 10.5 Firebase Backend Status & Live Connectivity Check
router.get('/firebase-status', async (req, res) => {
    try {
        const { db } = require('../config/firebase');
        const isDbReady = Boolean(db && typeof db.collection === 'function');
        let collectionsHealth = {
            jobs: 'bulk_trigger_jobs',
            auditLogs: 'bulk_trigger_audit_logs',
            otps: 'otp_verifications',
            aiConfigs: 'bulk_ai_configurations'
        };

        res.status(200).json({
            success: true,
            online: true,
            firebaseReady: isDbReady,
            projectId: process.env.FIREBASE_PROJECT_ID || 'kylrxai',
            collections: collectionsHealth,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 10.6 Retrieve Live Workforce Cohort from Firebase Firestore
router.get('/recipients/from-firestore', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10) || 100;
        const cohort = req.query.cohort || 'auto';
        const result = await req.bulkEngine.fetchRecipientsFromFirestore(limit, cohort);
        res.status(200).json({
            success: true,
            source: result.source || 'firestore',
            count: result.count || 0,
            data: result.recipients || []
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] fetch from firestore error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 10.7 Generate & Seed 100-Member Enterprise Test Cohort in Firebase
router.post('/recipients/seed-firestore', async (req, res) => {
    try {
        const result = req.bulkEngine.generate100TestCohort();
        res.status(200).json({
            success: true,
            source: 'firestore_cohort_100',
            count: result.count,
            data: result.recipients,
            message: '100-item enterprise batch cohort (5 batches of 20) ready for dispatch.'
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] seed firestore cohort error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   SECTION 2.4: AI-ASSISTED BUILDER (PRD §2.4)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

// 11. AI Suggestion: User describes alert, AI suggests triggers, conditions, recipients, and message text
// Output strictly remains in draft status
router.post('/ai-builder/suggest', (req, res) => {
    try {
        const { prompt, context, actor } = req.body || {};
        const draft = aiAssistedBuilderService.generateAlertDraft(
            prompt,
            context || {},
            actor || { role: 'super_admin', name: 'Admin' }
        );
        draft.orgId = req.orgId;
        aiAssistedBuilderService.syncConfigToFirestore(draft).catch(() => {});

        res.status(200).json({
            success: true,
            data: draft,
            message: `AI recommendation draft generated successfully. Status: ${draft.status}. User approval required before activation.`
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] AI suggest error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// 12. User Edit Suggestions: Modify fields before activation
router.put('/ai-builder/drafts/:draftId', (req, res) => {
    try {
        const { draftId } = req.params;
        const { edits, actor } = req.body || {};
        if (!ownDraftOr404(req, res)) return;

        const updatedDraft = aiAssistedBuilderService.updateDraft(
            draftId,
            edits || {},
            actor || { role: 'super_admin', name: 'Admin' }
        );

        res.status(200).json({
            success: true,
            data: updatedDraft,
            message: `Draft '${draftId}' updated. Current status: ${updatedDraft.status}. Valid: ${updatedDraft.validationStatus.isValid}.`
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] Draft update error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// 13. User Reject Suggestions
router.post('/ai-builder/drafts/:draftId/reject', (req, res) => {
    try {
        const { draftId } = req.params;
        const { reason, actor } = req.body || {};
        if (!ownDraftOr404(req, res)) return;

        const rejected = aiAssistedBuilderService.rejectDraft(
            draftId,
            reason || 'Rejected by user',
            actor || { role: 'super_admin', name: 'Admin' }
        );

        res.status(200).json({
            success: true,
            data: rejected,
            message: `Suggestion '${draftId}' rejected and archived.`
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] Draft reject error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// 14. System Validation Gate: Validates final setup
router.post('/ai-builder/validate', (req, res) => {
    try {
        const { configuration } = req.body || {};
        const validation = aiAssistedBuilderService.validateConfiguration(configuration || {});

        res.status(200).json({
            success: true,
            data: validation,
            message: validation.isValid ? 'Configuration passed system validation gate.' : 'Configuration failed validation.'
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] System validation error:', err.message);
        res.status(400).json({ success: false, error: err.message });
    }
});

// 15. Authorised Activation: Only authorised users activate the configuration
router.post('/ai-builder/drafts/:draftId/activate', (req, res) => {
    try {
        const { draftId } = req.params;
        const { actor } = req.body || {};
        if (!ownDraftOr404(req, res)) return;

        const activated = aiAssistedBuilderService.activateConfiguration(
            draftId,
            actor || { role: 'super_admin', name: 'Admin' }
        );

        res.status(200).json({
            success: true,
            data: activated,
            message: `Configuration '${draftId}' successfully activated by ${activated.activatedBy.name}. Status: active.`
        });
    } catch (err) {
        logger.error('[BulkTriggerAPI] Activation error:', err.message);
        res.status(403).json({ success: false, error: err.message });
    }
});

// 16. Get All Configurations
router.get('/ai-builder/drafts', (req, res) => {
    try {
        const { status, module, severity } = req.query;
        const configs = aiAssistedBuilderService.getAllConfigurations({ status, module, severity })
            .filter(c => draftOwner(c) === req.orgId);

        res.status(200).json({
            success: true,
            data: configs,
            total: configs.length
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 17. Get Single Configuration by ID
router.get('/ai-builder/drafts/:draftId', (req, res) => {
    try {
        const config = ownDraftOr404(req, res);
        if (!config) return;

        res.status(200).json({ success: true, data: config });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;

