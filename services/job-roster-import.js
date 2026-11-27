/**
 * Server side of the "Job & Rosters" bulk importer (admin-onboarding-upload.html).
 * Rows are validated again here, always written to the SIGNED-IN company, and people who do not exist
 * yet get a profile (no login; an invite can claim it later). The browser never decides the company.
 *
 * POST /api/admin/job-roster/import   { rows: [...], dryRun?: boolean }
 */
const { admin, rawCollection } = require('../config/firebase');
const parser = require('../jobRosterParser');
const ingestion = require('../unifiedIngestionService');
const { getCountryConfig } = require('../country-config');

const MAX_ROWS = 2000;

async function importJobRoster(req, res, next) {
    try {
        const orgId = req.user && req.user.orgId;
        if (!orgId) return res.status(403).json({ success: false, error: 'No company is linked to this account.' });
        const rows = req.body && req.body.rows;
        if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ success: false, error: 'rows must be a non-empty array.' });
        if (rows.length > MAX_ROWS) return res.status(400).json({ success: false, error: `At most ${MAX_ROWS} rows per import.` });

        const parsed = parser.parseArray(rows, { orgId });
        if (!parsed.validRows.length) {
            return res.status(400).json({ success: false, error: 'No valid rows.', errors: parsed.errors });
        }

        let country = 'IN';
        try {
            const org = await rawCollection('organizations').doc(orgId).get();
            if (org.exists) country = org.data().country || 'IN';
        } catch (_) { /* default */ }

        const result = await ingestion.ingestJobRosterBatch(parsed.validRows, {
            db: admin.firestore(),
            orgId,
            actorId: req.user.id || req.user.email || 'admin',
            currency: getCountryConfig(country).currency,
            dryRun: Boolean(req.body.dryRun)
        });
        const errors = (result.errors || []).concat(parsed.invalidRows.map((r) => ({ rowIndex: r.rowIndex, employeeId: r.Employee_ID, error: r.errors.join('; ') })));
        return res.status(result.successCount ? 200 : 400).json({
            success: result.success && !parsed.invalidRows.length,
            totalCount: rows.length,
            successCount: result.successCount,
            failureCount: errors.length,
            errors
        });
    } catch (e) { next(e); }
}

module.exports = { importJobRoster, MAX_ROWS };
