/**
 * Who may reach platform-operator endpoints (billing summary across customers, status page edits, deep health, metrics).
 * Never customers. Two ways in:
 *   - header  x-platform-token: <PLATFORM_OPERATOR_TOKEN>   (automation, runbooks)
 *   - a signed-in super_admin of the platform's own organization (PLATFORM_ORG_ID). When PLATFORM_ORG_ID is not set
 *     (local development) any super_admin passes, so set it in production.
 * Monitoring systems use x-monitoring-token / Bearer <MONITORING_TOKEN>, which only opens health and metrics.
 */
const crypto = require('crypto');
const { verifyToken } = require('../middleware/authMiddleware');
const { canonicalRole } = require('./permissions');

function safeEqual(a, b) {
    const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

const headerToken = (req) => req.headers['x-platform-token'];
function monitoringToken(req) {
    const h = req.headers.authorization;
    return req.headers['x-monitoring-token'] || (typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7).trim() : null);
}

const operatorTokenOk = (req) => Boolean(process.env.PLATFORM_OPERATOR_TOKEN) && safeEqual(headerToken(req), process.env.PLATFORM_OPERATOR_TOKEN);
const monitoringTokenOk = (req) => Boolean(process.env.MONITORING_TOKEN) && safeEqual(monitoringToken(req), process.env.MONITORING_TOKEN);

function isOperatorUser(user) {
    if (!user || canonicalRole(user.role) !== 'super_admin') return false;
    const platformOrg = process.env.PLATFORM_ORG_ID;
    return !platformOrg || user.orgId === platformOrg;
}

/** Middleware: platform operator only. allowMonitoring also accepts the monitoring token. */
function requireOperator({ allowMonitoring = false } = {}) {
    return (req, res, next) => {
        if (operatorTokenOk(req) || (allowMonitoring && monitoringTokenOk(req))) { req.operator = { via: 'token' }; return next(); }
        if (!req.headers.authorization || /^Bearer\s*$/.test(req.headers.authorization)) return res.status(401).json({ success: false, error: 'Platform operator access required' });
        return verifyToken(req, res, () => {
            if (!isOperatorUser(req.user)) return res.status(403).json({ success: false, error: 'Platform operator access required' });
            req.operator = { via: 'user', id: req.user.id };
            next();
        });
    };
}

module.exports = { requireOperator, operatorTokenOk, monitoringTokenOk, isOperatorUser, safeEqual };
