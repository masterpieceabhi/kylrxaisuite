/**
 * Gate for the older India-era API modules (bulk trigger, document and custom templates, alerts, assignment rules,
 * employee conversion, central dashboard, reconciliation, unified compliance, controls sign-off, free-form email).
 *
 * Several of them keep one store in server memory or in one shared file for every company, take the company or the
 * actor from the request, or have no role check (found in the 2026-11-20 audit). US and Canada companies have their
 * own modules (/api/us/...) and never use these, so:
 *   - a server that does not serve India (SERVED_COUNTRIES without IN, e.g. the US server) refuses them for everyone;
 *   - otherwise a company whose country is not India is refused.
 * India companies keep working as before; making these modules safe between India companies is separate work.
 */
const { verifyToken } = require('./authMiddleware');
const { rawCollection } = require('../config/firebase');
const { resolveCountryCode } = require('../country-config');
const served = require('../services/served-countries');
const logger = require('../utils/logger');

const REFUSED = { success: false, code: 'not_for_this_country', error: 'This part of Onn HR is not available for your company.' };
const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);

/** Is this company an India company? Unknown or missing country counts as India, as everywhere else in the app. */
async function isIndiaOrg(orgId) {
    if (!orgId) return false;
    const snap = await rawCollection('organizations').doc(orgId).get();
    const data = exists(snap) ? snap.data() : {};
    return resolveCountryCode(data.country || data.Country) === 'IN';
}

async function indiaOnlyCheck(req, res, next) {
    if (!served.serves('IN')) return res.status(403).json(REFUSED);
    try {
        const orgId = (req.user && req.user.orgId) || req.tenantOrgId || null;
        if (!(await isIndiaOrg(orgId))) return res.status(403).json(REFUSED);
        return next();
    } catch (e) {
        logger.error(`India-only gate: company lookup failed: ${e.message}`);
        return res.status(500).json({ success: false, error: 'Could not load your company' });
    }
}

/** Sign-in first (these routers verify the token again; that is harmless), then the country check */
const indiaOnly = [verifyToken, indiaOnlyCheck];

module.exports = { indiaOnly, indiaOnlyCheck, isIndiaOrg };
