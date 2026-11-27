const admin = require('../config/firebase-admin');
const logger = require('../utils/logger');

const auditLogger = async (req, res, next) => {
    const originalSend = res.send;
    
    res.send = function (data) {
        res.send = originalSend;
        
        // Asynchronously log to firestore
        try {
            if (req.user) {
                const db = admin.firestore();
                db.collection('audit_logs').add({
                    userId: req.user.uid || req.user.id,
                    email: req.user.email,
                    role: req.user.role,
                    action: req.method,
                    endpoint: req.originalUrl,
                    ip: req.ip,
                    status: res.statusCode,
                    timestamp: admin.firestore.FieldValue.serverTimestamp()
                });
            }
        } catch (error) {
            logger.error(`Audit Log Error: ${error.message}`);
        }
        
        return res.send(data);
    };
    
    next();
};

module.exports = auditLogger;
