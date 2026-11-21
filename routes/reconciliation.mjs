/**
 * ============================================================================
 * KYLRX AI ENTERPRISE HRMS — RECONCILIATION REST API ROUTES
 * ============================================================================
 * Endpoints:
 *  POST   /api/reconciliation/ingest
 *         Ingest a bank response file (multipart upload or raw body).
 *         Triggers the full 6-guard reconciliation pipeline.
 *
 *  GET    /api/reconciliation/exceptions/:batchId
 *         List all exception queue entries for a batch.
 *
 *  GET    /api/reconciliation/exceptions/:batchId/summary
 *         Summary stats: totals, open count, auto-closure flag, Δ totals.
 *
 *  GET    /api/reconciliation/finance-ops/review-items
 *         Paginated list of pending Finance Ops review items (all batches).
 *
 *  GET    /api/reconciliation/finance-ops/review-items/:batchId
 *         Finance Ops review items scoped to a single batch.
 *
 *  PATCH  /api/reconciliation/exceptions/:exceptionId/resolve
 *         Mark an exception as RESOLVED with notes.
 *
 *  GET    /api/reconciliation/runs/:runId
 *         Retrieve a full reconciliation run manifest.
 *
 *  GET    /api/reconciliation/batches/:batchId/status
 *         Current reconciliation status of a batch.
 *
 * @version 1.0.0
 * @author  Kylrx AI Lead Backend Architecture Team
 */

import { Router } from 'express';
import multer from 'multer';
import { ReconciliationEngine } from '../services/reconciliation-engine.mjs';
import { InMemoryReconciliationStore } from '../services/reconciliation-exception-store.mjs';

// ─── In-memory store, one per company (swap with FirestoreReconciliationStore in prod) ─
// Runs, exceptions and review items of one company are never visible to another.
const orgStores = new Map(); // orgId -> { store, engine }
export function reconciliationFor(orgId) {
  if (!orgId) throw new Error('A company is required for reconciliation.');
  if (!orgStores.has(orgId)) {
    const store = new InMemoryReconciliationStore();
    orgStores.set(orgId, { store, engine: new ReconciliationEngine({ store, verbose: false }) });
  }
  return orgStores.get(orgId);
}

// ─── Multer: accept file uploads up to 10 MB in memory ───────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'text/csv',
      'text/plain',
      'application/json',
      'application/xml',
      'text/xml',
      'application/octet-stream',
    ];
    if (allowedMimes.includes(file.mimetype) || file.originalname.match(/\.(csv|txt|json|xml)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Accepted: .csv, .txt, .json, .xml'), false);
    }
  },
});

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware.js');

const router = Router();
router.use(verifyToken);
router.use(authorize(ADMIN_HR_ROLES));

// Every call works on the caller's own company store; the company never comes from the request body
router.use((req, res, next) => {
  const orgId = (req.user && req.user.orgId) || req.tenantOrgId;
  if (!orgId) return res.status(403).json({ success: false, error: 'No company on this account' });
  req.orgId = orgId;
  req.recon = reconciliationFor(orgId);
  next();
});

// ─── Helper: detect format from filename/mimetype ─────────────────────────────
function detectFormat(fileName = '', mimetype = '') {
  const name = fileName.toLowerCase();
  if (name.endsWith('.xml') || mimetype.includes('xml')) return 'XML';
  if (name.endsWith('.json') || mimetype.includes('json')) return 'JSON';
  if (name.endsWith('.txt')) return 'TXT';
  return 'CSV';
}

// ─── Helper: build a consistent error response ───────────────────────────────
function errorResponse(res, statusCode, errorCode, message, details = {}) {
  return res.status(statusCode).json({
    success: false,
    error: errorCode,
    message,
    details,
    timestamp: new Date().toISOString(),
  });
}

/* ============================================================================
 * POST /api/reconciliation/ingest
 * ============================================================================
 * Body options:
 *   (a) Multipart form: field "bank_response_file" + optional fields:
 *       batch_id, batch (JSON string), operator_id, file_format (the company is always the caller's own)
 *   (b) JSON body: { batch, file_content, file_format, file_name, operator_id }
 */
router.post('/ingest', upload.single('bank_response_file'), async (req, res) => {
  try {
    let fileContent  = null;
    let fileFormat   = (req.body?.file_format || '').toUpperCase() || 'CSV';
    let fileName     = 'bank_response';
    let batchPayload = null;
    let operatorId   = req.body?.operator_id || req.user?.id || 'SYSTEM_RECON_BOT';
    const orgId      = req.orgId;

    // ── Case A: Multipart upload ──────────────────────────────────────────
    if (req.file) {
      fileContent = req.file.buffer.toString('utf-8');
      fileName    = req.file.originalname || 'bank_response';
      fileFormat  = fileFormat || detectFormat(fileName, req.file.mimetype);

      // batch can be sent as JSON string in form field
      if (req.body?.batch) {
        try { batchPayload = JSON.parse(req.body.batch); } catch { /* ignored */ }
      }
      if (req.body?.batch_id && !batchPayload) {
        batchPayload = { batch_id: req.body.batch_id, records: [] };
      }
    }
    // ── Case B: JSON body ─────────────────────────────────────────────────
    else if (req.body?.file_content) {
      fileContent  = req.body.file_content;
      fileFormat   = fileFormat || (req.body.file_format || 'CSV').toUpperCase();
      fileName     = req.body.file_name || 'bank_response';
      batchPayload = req.body.batch || null;
    } else {
      return errorResponse(res, 400, 'MISSING_FILE_CONTENT',
        'Provide a bank response file via multipart upload (field: bank_response_file) ' +
        'or a JSON body with file_content.');
    }

    if (!batchPayload || !batchPayload.batch_id) {
      return errorResponse(res, 400, 'MISSING_BATCH',
        'A valid batch object with batch_id is required. ' +
        'Send as a JSON body field "batch" or multipart form field "batch".');
    }

    if (!fileContent || fileContent.trim().length === 0) {
      return errorResponse(res, 400, 'EMPTY_FILE', 'The bank response file is empty.');
    }

    // Run the reconciliation engine
    const result = await req.recon.engine.ingestBankFile({
      batch:          batchPayload,
      fileContent,
      fileFormat,
      fileName,
      operatorId,
      organizationId: orgId,
    });

    return res.status(200).json({
      success:               true,
      message:               `Reconciliation complete. ` +
                             `${result.exception_queue_entries.length} exception(s) raised. ` +
                             `Batch status: ${result.batch.status}.`,
      reconciliation_run_id: result.reconciliation_run_id,
      batch_status:          result.batch.status,
      auto_closure_blocked:  result.batch.auto_closure_blocked,
      exception_count:       result.exception_queue_entries.length,
      settled_count:         result.settled_instructions.length,
      failed_count:          result.failed_instructions.length,
      manifest:              result.manifest,
      timestamp:             new Date().toISOString(),
    });

  } catch (err) {
    console.error('[RECONCILIATION_ROUTE] /ingest error:', err);
    if (err.message?.includes('ANTI-ASSUMPTION GUARD VIOLATION')) {
      return errorResponse(res, 500, 'ANTI_ASSUMPTION_GUARD_VIOLATION', err.message);
    }
    return errorResponse(res, 500, 'INTERNAL_SERVER_ERROR', err.message || 'Unexpected error during reconciliation.');
  }
});

/* ============================================================================
 * GET /api/reconciliation/exceptions/:batchId
 * ============================================================================ */
router.get('/exceptions/:batchId', async (req, res) => {
  try {
    const { batchId } = req.params;
    const showAll = req.query.show_all === 'true';

    const entries = showAll
      ? await req.recon.store.listAllExceptionsByBatch(batchId)
      : await req.recon.store.listOpenExceptionsByBatch(batchId);

    return res.status(200).json({
      success:   true,
      batch_id:  batchId,
      count:     entries.length,
      filter:    showAll ? 'ALL' : 'OPEN',
      exceptions: entries,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[RECONCILIATION_ROUTE] /exceptions/:batchId error:', err);
    return errorResponse(res, 500, 'INTERNAL_SERVER_ERROR', err.message);
  }
});

/* ============================================================================
 * GET /api/reconciliation/exceptions/:batchId/summary
 * ============================================================================ */
router.get('/exceptions/:batchId/summary', async (req, res) => {
  try {
    const { batchId } = req.params;
    const summary = await req.recon.store.getExceptionSummary(batchId);
    return res.status(200).json({
      success:   true,
      ...summary,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[RECONCILIATION_ROUTE] /exceptions/:batchId/summary error:', err);
    return errorResponse(res, 500, 'INTERNAL_SERVER_ERROR', err.message);
  }
});

/* ============================================================================
 * GET /api/reconciliation/finance-ops/review-items
 * Finance Ops pending review items across all batches
 * ============================================================================ */
router.get('/finance-ops/review-items', async (req, res) => {
  try {
    const batchIdFilter = req.query.batch_id || null;
    const items = await req.recon.store.listPendingReviewItems(batchIdFilter);

    // Optional priority filter
    const priority = (req.query.priority || '').toUpperCase();
    const filtered = priority ? items.filter((i) => i.priority === priority) : items;

    return res.status(200).json({
      success:   true,
      count:     filtered.length,
      filter: {
        batch_id: batchIdFilter,
        priority: priority || 'ALL',
      },
      review_items: filtered,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[RECONCILIATION_ROUTE] /finance-ops/review-items error:', err);
    return errorResponse(res, 500, 'INTERNAL_SERVER_ERROR', err.message);
  }
});

/* ============================================================================
 * GET /api/reconciliation/finance-ops/review-items/:batchId
 * Finance Ops review items for a specific batch
 * ============================================================================ */
router.get('/finance-ops/review-items/:batchId', async (req, res) => {
  try {
    const { batchId } = req.params;
    const items = await req.recon.store.listPendingReviewItems(batchId);
    return res.status(200).json({
      success:      true,
      batch_id:     batchId,
      count:        items.length,
      review_items: items,
      timestamp:    new Date().toISOString(),
    });
  } catch (err) {
    console.error('[RECONCILIATION_ROUTE] /finance-ops/review-items/:batchId error:', err);
    return errorResponse(res, 500, 'INTERNAL_SERVER_ERROR', err.message);
  }
});

/* ============================================================================
 * PATCH /api/reconciliation/exceptions/:exceptionId/resolve
 * Body: { resolved_by, notes, waiver_justification? }
 * ============================================================================ */
router.patch('/exceptions/:exceptionId/resolve', async (req, res) => {
  try {
    const { exceptionId } = req.params;
    const {
      resolved_by,
      notes,
      waiver_justification,
    } = req.body || {};

    const resolvedBy = resolved_by || req.user?.id || 'FINANCE_OPS';

    if (!exceptionId) {
      return errorResponse(res, 400, 'MISSING_EXCEPTION_ID', 'exceptionId is required.');
    }

    const existing = await req.recon.store.getExceptionById(exceptionId);
    if (!existing) {
      return errorResponse(res, 404, 'EXCEPTION_NOT_FOUND',
        `ExceptionQueueEntry '${exceptionId}' not found.`);
    }

    if (existing.status === 'RESOLVED' || existing.status === 'WAIVED') {
      return errorResponse(res, 409, 'ALREADY_RESOLVED',
        `Exception '${exceptionId}' has already been ${existing.status.toLowerCase()}.`,
        { resolved_at: existing.resolved_at, resolved_by: existing.resolved_by });
    }

    const resolveNotes = notes || waiver_justification ||
      'Resolved via Finance Ops exception resolution endpoint.';

    const updated = await req.recon.store.resolveException(exceptionId, resolvedBy, resolveNotes);

    // Re-check batch closure block
    const openExceptions = await req.recon.store.listOpenExceptionsByBatch(existing.batch_id);

    return res.status(200).json({
      success:              true,
      message:              `Exception '${exceptionId}' resolved successfully.`,
      exception:            updated,
      remaining_open_exceptions_in_batch: openExceptions.length,
      batch_auto_closure_blocked: openExceptions.length > 0,
      timestamp:            new Date().toISOString(),
    });

  } catch (err) {
    console.error('[RECONCILIATION_ROUTE] /exceptions/:exceptionId/resolve error:', err);
    return errorResponse(res, 500, 'INTERNAL_SERVER_ERROR', err.message);
  }
});

/* ============================================================================
 * GET /api/reconciliation/runs/:runId
 * ============================================================================ */
router.get('/runs/:runId', async (req, res) => {
  try {
    const { runId } = req.params;
    const manifest = await req.recon.store.getReconciliationRun(runId);
    if (!manifest) {
      return errorResponse(res, 404, 'RUN_NOT_FOUND',
        `Reconciliation run '${runId}' not found.`);
    }
    return res.status(200).json({
      success:   true,
      manifest,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[RECONCILIATION_ROUTE] /runs/:runId error:', err);
    return errorResponse(res, 500, 'INTERNAL_SERVER_ERROR', err.message);
  }
});

/* ============================================================================
 * GET /api/reconciliation/batches/:batchId/status
 * ============================================================================ */
router.get('/batches/:batchId/status', async (req, res) => {
  try {
    const { batchId } = req.params;
    const summary = await req.recon.store.getExceptionSummary(batchId);
    const openItems = await req.recon.store.listOpenExceptionsByBatch(batchId);
    const pendingReview = await req.recon.store.listPendingReviewItems(batchId);

    return res.status(200).json({
      success:                     true,
      batch_id:                    batchId,
      open_exceptions_count:       summary.open_exceptions,
      total_exceptions_count:      summary.total_exceptions,
      batch_auto_closure_blocked:  summary.batch_auto_closure_blocked,
      total_difference_amount:     summary.total_difference_amount,
      exception_breakdown:         summary.breakdown_by_type,
      pending_finance_ops_items:   pendingReview.length,
      open_exceptions:             openItems,
      timestamp:                   new Date().toISOString(),
    });
  } catch (err) {
    console.error('[RECONCILIATION_ROUTE] /batches/:batchId/status error:', err);
    return errorResponse(res, 500, 'INTERNAL_SERVER_ERROR', err.message);
  }
});

export default router;
