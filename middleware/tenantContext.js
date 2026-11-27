/**
 * Resolves the calling organization for every API request and runs the rest of the
 * request inside that tenant context (config/tenant.js), so all Firestore access made
 * while handling it is limited to the caller's organization.
 *
 *   Firebase ID token  -> orgId custom claim, else users/{uid}.orgId
 *   backend JWT        -> users/{id}.orgId
 *   no / dev token     -> DEV_DEFAULT_ORG_ID outside production (the Kylrx AI demo org),
 *                         no organization (reads nothing) in production
 */
const jwt = require('jsonwebtoken');
const { admin, rawCollection } = require('../config/firebase');
const { runWithTenant, LEGACY_ORG_ID } = require('../config/tenant');

const DEV_DEFAULT_ORG_ID = process.env.DEV_DEFAULT_ORG_ID || 'org_kylrx_ai';
const CACHE_TTL_MS = 5 * 60 * 1000;
const orgCache = new Map(); // uid -> { orgId, expires }

async function orgIdForUser(uid) {
    const cached = orgCache.get(uid);
    if (cached && cached.expires > Date.now()) return cached.orgId;
    let orgId = null;
    try {
        const snap = await rawCollection('users').doc(uid).get();
        orgId = snap.exists ? (snap.get('orgId') || null) : null;
    } catch (_) {}
    orgCache.set(uid, { orgId, expires: Date.now() + CACHE_TTL_MS });
    return orgId;
}

function isDevToken(token) {
    return !token || token === 'undefined' || token === 'null' || token === 'super_admin_dev_token' || token.startsWith('dev_');
}

async function resolveOrgId(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

    if (!isDevToken(token)) {
        if (admin.apps.length) {
            try {
                const decoded = await admin.auth().verifyIdToken(token);
                // Accounts from before multi-tenancy have no org yet; they belong to the original org
                return decoded.orgId || await orgIdForUser(decoded.uid) || LEGACY_ORG_ID;
            } catch (_) {}
        }
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (decoded && decoded.type === 'support_session' && decoded.orgId) return decoded.orgId;
            if (decoded && decoded.id) return await orgIdForUser(decoded.id) || LEGACY_ORG_ID;
        } catch (_) {}
    }
    const devAuth = process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_AUTH === 'true';
    return devAuth ? DEV_DEFAULT_ORG_ID : null;
}

module.exports = async function tenantContext(req, res, next) {
    let orgId = null;
    try {
        orgId = await resolveOrgId(req);
    } catch (_) {}
    req.tenantOrgId = orgId;
    runWithTenant(orgId, next);
};
