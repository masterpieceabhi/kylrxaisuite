const { admin, db } = require('../config/firebase');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is missing');
}
const JWT_SECRET = process.env.JWT_SECRET;

// Development-only shortcut: lets the local demo run without real logins (dev tokens and ?role=
// act as a super admin). It needs an explicit opt-in and can never be on in production.
const DEV_AUTH = process.env.NODE_ENV !== 'production' && process.env.ALLOW_DEV_AUTH === 'true';
if (DEV_AUTH) {
    logger.warn('ALLOW_DEV_AUTH is on: dev tokens and ?role= grant super admin access. Local use only.');
}
const devUser = (req) => ({
    id: 'superadmin_dev',
    uid: 'superadmin_dev',
    email: 'superadmin@kylrx.ai',
    role: req.query.role || 'super_admin'
});

const ALLOWED_ROLES = [
    'Super Admin',
    'Admin',
    'Manager',
    'Employee',
    'HRMS',
    'hr_payroll',
    'hr_admin',
    'super_admin',
    'client_executive'
];

const verifyToken = async (req, res, next) => {
    try {
        let token;
        let decoded;
        let userId;

        const authHeader = req.headers && (req.headers.authorization || req.headers.Authorization);
        if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
            const candidateToken = authHeader.slice(7).trim();
            if (candidateToken && candidateToken !== 'undefined' && candidateToken !== 'null') {
                token = candidateToken;
            }
        }

        if (!token || token === 'super_admin_dev_token' || token.startsWith('dev_')) {
            if (DEV_AUTH) {
                req.user = devUser(req);
                return next();
            }
            return res.status(401).json({ success: false, error: 'Authentication token required' });
        }

        try {
            // First try to verify as custom JWT
            decoded = jwt.verify(token, JWT_SECRET);
            if (decoded && decoded.type === 'mfa_pending') {
                return res.status(401).json({
                    success: false,
                    error: 'Unauthorized: MFA verification pending. Please verify OTP to obtain access token.',
                    mfaRequired: true
                });
            }
            userId = decoded.id;
        } catch (jwtError) {
            try {
                // Fallback to Firebase ID Token
                if (!admin || !admin.auth) {
                    throw new Error('Firebase Auth not available');
                }
                decoded = await admin.auth().verifyIdToken(token);
                userId = decoded.uid;
            } catch (firebaseError) {
                if (DEV_AUTH) {
                    req.user = devUser(req);
                    return next();
                }
                logger.error(`Auth Error: Token verification failed for both JWT and Firebase`);
                return res.status(401).json({ success: false, error: 'Token is invalid or expired' });
            }
        }
        
        // Fetch full user details from Firestore
        let userData = {};
        try {
            if (db && typeof db.collection === 'function') {
                const userDoc = await db.collection('users').doc(userId).get();
                const exists = typeof userDoc.exists === 'function' ? userDoc.exists() : userDoc.exists;
                userData = exists ? userDoc.data() : {};
            } else if (admin && admin.firestore && admin.apps && admin.apps.length) {
                const userDoc = await admin.firestore().collection('users').doc(userId).get();
                userData = userDoc.exists ? userDoc.data() : {};
            }
        } catch (dbErr) {
            logger.warn(`Firestore user fetch warning: ${dbErr.message}`);
        }
        
        // Derive role only from verified token or Firestore users doc and compare against explicit allow-list
        // Server-assigned custom claims in the verified token win over the editable profile doc
        const candidateRole = (decoded && decoded.role) || (userData && userData.role);
        const matchedRole = ALLOWED_ROLES.find(
            allowed => typeof candidateRole === 'string' && allowed.toLowerCase() === candidateRole.trim().toLowerCase()
        );
        const effectiveRole = matchedRole || 'Employee';

        const userEmail = ((decoded && decoded.email) || (userData && userData.email) || '').toLowerCase();

        userData = {
            ...userData,
            id: userId,
            email: userEmail,
            // Fall back to the verified token's custom claim when the profile doc lacks it
            orgId: userData.orgId || (decoded && decoded.orgId) || req.tenantOrgId || undefined,
            department: userData.department || 'General Operations',
            managerAssigned: userData.managerAssigned || 'default-manager-queue',
            role: effectiveRole
        };

        req.user = userData;
        next();
    } catch (error) {
        logger.error(`Auth Error: ${error.message}`);
        return res.status(401).json({ success: false, error: 'Token is invalid or expired' });
    }
};

const ADMIN_HR_ROLES = [
    'Admin',
    'Super Admin',
    'super_admin',
    'HRMS',
    'hr_admin',
    'hr_payroll'
];

// Roles are spelled several ways across the app ('Super Admin', 'super_admin', 'SUPER_ADMIN',
// 'hr_admin' / 'HR Admin'); compare them ignoring case, spaces, underscores and hyphens
const normalizeRole = (role) => String(role || '').toLowerCase().replace(/[\s_-]+/g, '');

const authorize = (...roles) => {
    const flatRoles = roles.flat();
    return (req, res, next) => {
        const allowedRoles = flatRoles.map(normalizeRole);
        const userRole = normalizeRole(req.user && req.user.role);

        if (!allowedRoles.includes(userRole)) {
            return res.status(403).json({
                success: false,
                error: `User role '${req.user ? req.user.role : ''}' is not authorized to access this route`
            });
        }
        next();
    };
};

module.exports = { verifyToken, authorize, ALLOWED_ROLES, ADMIN_HR_ROLES };
