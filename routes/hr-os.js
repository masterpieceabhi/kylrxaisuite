const express = require('express');
const router = express.Router();
const kylrxHROS = require('../services/kylrx-hr-os');
const logger = require('../utils/logger');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { LEGACY_ORG_ID } = require('../config/tenant');

router.use(verifyToken);

const callerOrgOf = (req) => (req.user && req.user.orgId) || req.tenantOrgId || null;

// The conversion store (codes, audit events, people) is per company; an account without one is refused
function requireOrg(req, res, next) {
    if (!callerOrgOf(req)) return res.status(403).json({ success: false, error: 'No company on this account' });
    next();
}

/**
 * GET /api/hr-os/manifest
 * Returns complete OS architecture manifest, 4 pillars, and 6 capabilities
 */
router.get('/manifest', (req, res) => {
    try {
        const manifest = kylrxHROS.getOperatingSystemManifest();
        res.json({
            success: true,
            manifest
        });
    } catch (error) {
        logger.error('[HR-OS API] Error fetching manifest:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/hr-os/status
 * Real-time operational health check and metrics
 */
router.get('/status', (req, res) => {
    try {
        const manifest = kylrxHROS.getOperatingSystemManifest();
        res.json({
            success: true,
            system: manifest.system,
            version: manifest.version,
            motto: manifest.motto,
            status: manifest.status,
            activeModulesCount: manifest.modules.count,
            registeredModules: manifest.modules.registered,
            subsystems: manifest.subsystems,
            timestamp: manifest.timestamp
        });
    } catch (error) {
        logger.error('[HR-OS API] Error fetching status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/hr-os/verify-pillars
 * Verifies compliance with Configure Once → Automate Everything → Track Everything → Preserve History
 */
router.get('/verify-pillars', (req, res) => {
    try {
        const verification = kylrxHROS.verifyPillars();
        res.json({
            success: true,
            ...verification
        });
    } catch (error) {
        logger.error('[HR-OS API] Error verifying pillars:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/hr-os/event
 * Ingest standardized HR event from ANY module into the central engine
 */
router.post('/event', async (req, res) => {
    try {
        const { eventName, payload, metadata } = req.body;
        if (!eventName) {
            return res.status(400).json({ success: false, error: 'eventName is required' });
        }

        const result = await kylrxHROS.dispatchHREvent(eventName, payload || {}, metadata || {});
        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        logger.error('[HR-OS API] Error dispatching event:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/hr-os/lifecycle-demo
 * Executes unified HR lifecycle demonstrating all 6 subsystems operating in tandem
 */
router.post('/lifecycle-demo', async (req, res) => {
    try {
        const employeeProfile = req.body || {};
        const result = await kylrxHROS.executeUnifiedHRLifecycle(employeeProfile);
        res.json(result);
    } catch (error) {
        logger.error('[HR-OS API] Error executing unified lifecycle demo:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/hr-os/generate-code
 * Generates an employee code via Firebase Admin SDK (bypasses browser 429 rate limit)
 */
const fs = require('fs');
const path = require('path');
const storePath = path.join(__dirname, '..', 'data', 'conversion_store.json');

const DEFAULT_COUNTERS = {
    emp_code_full_time: 1050,
    emp_code_intern: 205,
    emp_code_consultant: 500,
    emp_code_contractor: 8000,
    emp_code_contracting: 8000
};

/**
 * The store file keeps one section per company: { orgs: { [orgId]: { counters, auditLogs, users } } }.
 * A file in the older shared shape (counters/auditLogs/users at the top) belonged to the original company and is
 * moved under it the first time it is read.
 */
function readAllStores() {
    let all = {};
    try {
        if (fs.existsSync(storePath)) all = JSON.parse(fs.readFileSync(storePath, 'utf8')) || {};
    } catch (e) {
        all = {};
    }
    if (!all.orgs || typeof all.orgs !== 'object') {
        const legacy = (all.counters || all.auditLogs || all.users)
            ? { counters: all.counters || {}, auditLogs: all.auditLogs || [], users: all.users || {} }
            : null;
        all = { orgs: legacy ? { [LEGACY_ORG_ID]: legacy } : {} };
    }
    return all;
}

/** One company's section of the store; `all` is what writeStore saves back */
function readStore(orgId) {
    const all = readAllStores();
    if (!all.orgs[orgId]) all.orgs[orgId] = { counters: { ...DEFAULT_COUNTERS }, auditLogs: [], users: {} };
    const store = all.orgs[orgId];
    Object.defineProperty(store, '__all', { value: all, enumerable: false });
    return store;
}

// The Firestore copy of a company's counter (the original company keeps the old shared id)
const counterDocId = (orgId, counterKey) => (orgId === LEGACY_ORG_ID ? counterKey : `${orgId}__${counterKey}`);

function writeStore(store) {
    try {
        fs.mkdirSync(path.dirname(storePath), { recursive: true });
        fs.writeFileSync(storePath, JSON.stringify(store.__all, null, 2));
    } catch (e) {
        logger.warn('[HR-OS API] Failed writing conversion store:', e);
    }
}

function withTimeout(promise, ms = 1200) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Operation timed out')), ms))
    ]);
}

/**
 * GET /api/hr-os/audit-events
 * Returns recent conversion audit trail
 */
router.get('/audit-events', requireOrg, async (req, res) => {
    try {
        const store = readStore(callerOrgOf(req));
        res.json({
            success: true,
            events: store.auditLogs || []
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/hr-os/generate-code
 * Generates an employee code via resilient sequence engine (immune to 429 quota limits)
 */
router.post('/generate-code', requireOrg, async (req, res) => {
    try {
        const { type, department } = req.body;
        const normalizedType = String(type || 'full-time').toLowerCase().trim();
        const cleanDept = department ? department.replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase() : 'GEN';
        const year = new Date().getFullYear();

        const DEFAULT_CONFIGS = {
            'full-time': { prefix: 'FTE', seqStart: 1050, deptEnabled: true, entity: 'CORP' },
            'intern': { prefix: 'INT', seqStart: 205, deptEnabled: true, entity: 'CORP' },
            'consultant': { prefix: 'CNS', seqStart: 500, deptEnabled: true, entity: 'CORP' },
            'contractor': { prefix: 'CON', seqStart: 8000, deptEnabled: true, entity: 'CORP' },
            'contracting': { prefix: 'CON', seqStart: 8000, deptEnabled: true, entity: 'CORP' }
        };

        const engineConfig = DEFAULT_CONFIGS[normalizedType] || DEFAULT_CONFIGS['full-time'];
        const counterKey = `emp_code_${normalizedType.replace(/[^a-z0-9]/g, '_')}`;

        const orgId = callerOrgOf(req);
        const store = readStore(orgId);
        store.counters = store.counters || {};
        let currentSeq = typeof store.counters[counterKey] === 'number' ? store.counters[counterKey] : (engineConfig.seqStart || 1000);

        const prefix = engineConfig.prefix || 'EMP';
        const deptCode = engineConfig.deptEnabled !== false ? (cleanDept || 'GEN') : '';
        const entity = engineConfig.entity ? `-${engineConfig.entity}` : '';
        const paddedSeq = String(currentSeq).padStart(4, '0');

        const newEmpId = `${prefix}${deptCode ? '-' + deptCode : ''}${entity}-${year}-${paddedSeq}`;

        store.counters[counterKey] = currentSeq + 1;
        writeStore(store);

        // Non-blocking Firestore background sync
        try {
            const { db, admin } = require('../config/firebase');
            const seqRef = db.collection('system_counters').doc(counterDocId(orgId, counterKey));
            withTimeout(seqRef.set({
                orgId,
                current: currentSeq + 1,
                lastAssigned: newEmpId,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true }), 1200).catch(() => {});
        } catch (_) {}

        res.json({ success: true, newEmpId });
    } catch (error) {
        logger.error('[HR-OS API] Error in generate-code:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/hr-os/convert-employee
 * Converts employee role & employment type with instant response and resilient persistence
 */
// Changes a person's role, type, department and pay: owner and HR only, and only for a person of the caller's own company
// (before 2026-11-20 any signed-in user could rewrite any user record, including making themselves an admin).
router.post('/convert-employee', authorize(ADMIN_HR_ROLES), requireOrg, async (req, res) => {
    try {
        const { employeeId, targetType, targetRole, targetDept, targetSalary, effectiveDate, targetManager } = req.body;

        if (!employeeId || !targetType) {
            return res.status(400).json({ success: false, error: 'employeeId and targetType are required' });
        }
        {
            const { rawCollection } = require('../config/firebase');
            const target = await rawCollection('users').doc(String(employeeId)).get();
            const callerOrg = (req.user && req.user.orgId) || req.tenantOrgId || null;
            const found = typeof target.exists === 'function' ? target.exists() : target.exists;
            if (!found || !callerOrg || target.data().orgId !== callerOrg) {
                return res.status(404).json({ success: false, error: 'No such person in your company' });
            }
        }

        const normalizedType = String(targetType).toLowerCase().trim();
        const cleanDept = targetDept ? targetDept.replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase() : 'GEN';
        const year = new Date().getFullYear();

        const DEFAULT_CONFIGS = {
            'full-time': { prefix: 'FTE', seqStart: 1050, deptEnabled: true, entity: 'CORP' },
            'intern': { prefix: 'INT', seqStart: 205, deptEnabled: true, entity: 'CORP' },
            'consultant': { prefix: 'CNS', seqStart: 500, deptEnabled: true, entity: 'CORP' },
            'contractor': { prefix: 'CON', seqStart: 8000, deptEnabled: true, entity: 'CORP' },
            'contracting': { prefix: 'CON', seqStart: 8000, deptEnabled: true, entity: 'CORP' }
        };

        const engineConfig = DEFAULT_CONFIGS[normalizedType] || DEFAULT_CONFIGS['full-time'];
        const counterKey = `emp_code_${normalizedType.replace(/[^a-z0-9]/g, '_')}`;

        const orgId = callerOrgOf(req);
        const store = readStore(orgId);
        store.counters = store.counters || {};
        let currentSeq = typeof store.counters[counterKey] === 'number' ? store.counters[counterKey] : (engineConfig.seqStart || 1000);

        const prefix = engineConfig.prefix || 'EMP';
        const deptCode = engineConfig.deptEnabled !== false ? (cleanDept || 'GEN') : '';
        const entity = engineConfig.entity ? `-${engineConfig.entity}` : '';
        const paddedSeq = String(currentSeq).padStart(4, '0');

        const newEmpId = `${prefix}${deptCode ? '-' + deptCode : ''}${entity}-${year}-${paddedSeq}`;
        store.counters[counterKey] = currentSeq + 1;

        // Retrieve existing user data with timeout protection
        let userData = {
            name: req.body.name || 'Staff Member',
            employeeId: employeeId,
            employmentType: 'full-time',
            role: targetRole || 'Staff',
            department: targetDept || 'General',
            salary: targetSalary || '0'
        };

        const { db, admin } = require('../config/firebase');

        try {
            const userSnap = await withTimeout(db.collection('users').doc(employeeId).get(), 1200);
            if (userSnap && userSnap.exists) {
                userData = userSnap.data();
            } else if (store.users && store.users[employeeId]) {
                userData = store.users[employeeId];
            }
        } catch (_) {
            if (store.users && store.users[employeeId]) {
                userData = store.users[employeeId];
            }
        }

        const oldId = userData.employeeId || employeeId;
        const oldType = userData.employmentType || userData.type || 'employee';
        const auditId = `aud_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

        const auditData = {
            id: auditId,
            employeeId,
            name: userData.name || req.body.name || 'Staff Member',
            oldId,
            newId: newEmpId,
            oldType,
            newType: targetType,
            effectiveDate: effectiveDate || new Date().toISOString().split('T')[0],
            revisedSalary: targetSalary || userData.salary || '0',
            role: targetRole || userData.role || 'Staff',
            department: targetDept || userData.department || 'General',
            manager: targetManager || userData.reportingManager || 'Not specified',
            timestamp: new Date().toISOString()
        };

        // Update local persistent store
        store.auditLogs = store.auditLogs || [];
        store.auditLogs.unshift(auditData);
        if (store.auditLogs.length > 100) store.auditLogs = store.auditLogs.slice(0, 100);

        store.users = store.users || {};
        store.users[employeeId] = {
            ...userData,
            employeeId: newEmpId,
            employmentType: targetType,
            role: targetRole || userData.role,
            department: targetDept || userData.department,
            salary: targetSalary || userData.salary || '0',
            reportingManager: targetManager || userData.reportingManager || '',
            lastConvertedAt: new Date().toISOString()
        };

        writeStore(store);

        // Non-blocking Firestore background sync (never blocks response)
        try {
            withTimeout(db.collection('conversion_audit').add({
                ...auditData,
                orgId,
                timestamp: admin.firestore.FieldValue.serverTimestamp()
            }), 1200).catch(() => {});

            withTimeout(db.collection('users').doc(employeeId).set({
                employeeId: newEmpId,
                employmentType: targetType,
                role: targetRole || userData.role,
                department: targetDept || userData.department,
                departmentName: targetDept || userData.departmentName || targetDept,
                salary: targetSalary || userData.salary || '0',
                reportingManager: targetManager || userData.reportingManager || '',
                conversionHistory: admin.firestore.FieldValue.arrayUnion({
                    from: oldType,
                    to: targetType,
                    oldId,
                    newId: newEmpId,
                    date: effectiveDate || new Date().toISOString().split('T')[0],
                    revisedSalary: targetSalary || '0',
                    timestamp: new Date().toISOString()
                }),
                lastConvertedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true }), 1200).catch(() => {});
        } catch (_) {}

        // Dispatch to central HR-OS
        try {
            await kylrxHROS.dispatchHREvent('EMPLOYEE_LIFECYCLE_CONVERTED', {
                employeeId,
                name: userData.name,
                oldId,
                newId: newEmpId,
                fromType: oldType,
                toType: targetType,
                role: targetRole,
                salary: targetSalary,
                effectiveDate
            }, { source: 'LifecycleConversionHub', operator: 'SuperAdmin' });
        } catch (_) {}

        res.json({
            success: true,
            message: `Employee ${userData.name || 'profile'} successfully converted to ${targetType}`,
            newEmpId,
            auditId,
            auditData,
            employeeId
        });

    } catch (error) {
        logger.error('[HR-OS API] Error in convert-employee:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;

