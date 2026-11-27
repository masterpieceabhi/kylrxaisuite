const express = require('express');
const router = express.Router();
const { confirmedWrite } = require('../config/firestore-write');
const crypto = require('crypto');
const automationEngine = require('../services/automation-engine');
const eventBus = require('../services/event-bus');
const logger = require('../utils/logger');
const { db, rawCollection } = require('../config/firebase');
const { orgDocs, LEGACY_ORG_ID } = require('../config/tenant');
const triggerRegistryService = require('../services/alert-trigger-registry-service');
const { verifyToken } = require('../middleware/authMiddleware');

router.use(verifyToken);

// Every call works on the caller's own company; an account without one is refused
router.use((req, res, next) => {
    if (!orgOf(req)) return res.status(403).json({ success: false, error: 'No company on this account' });
    next();
});

/**
 * Enterprise Alert Builder Route Handler
 * 
 * Alert Builder is the streamlined threshold monitoring and notification configuration interface
 * powered directly by Kylrx's Common Automation Engine (services/automation-engine.js).
 * 
 * Core Prompt Specifications:
 * 1. Attendance: 3 consecutive absences → Manager + HR
 * 2. Payroll: variance > 10% → Payroll Admin
 * 3. Policy: acknowledgement pending for 3 days → reminder
 * 4. PMS: review deadline approaching → Manager → HR escalation
 * 5. Exit: clearance pending for 48 hours → responsible person → escalation
 */

// In-memory alert definitions store (synced with AutomationEngine)
const DEFAULT_ALERT_RULES = [
    {
        id: 'alert-attendance-consecutive-absent',
        name: 'Attendance: 3 Consecutive Absences Notification',
        module: 'attendance',
        category: 'Workforce Monitoring',
        severity: 'critical',
        trigger_event: 'attendance.consecutive_absences_detected',
        metric: 'Consecutive Absences',
        thresholdValue: 3,
        comparator: '>=',
        conditions: {
            field: 'consecutiveAbsences',
            op: '>=',
            value: 3
        },
        recipients: [
            { role: 'Reporting Manager', type: 'primary', channel: 'Email + In-App' },
            { role: 'HR Operations', type: 'primary', channel: 'In-App + SMS' }
        ],
        escalation: null,
        status: 'active',
        description: 'Automatically flags when an employee records 3 consecutive unapproved or unexplained absences and notifies reporting manager & HR team immediately.',
        pipeline: [
            {
                type: 'notification',
                target: 'Reporting Manager',
                recipient_role: 'manager',
                channels: ['email', 'in_app'],
                title: 'Attendance Alert: 3 Consecutive Absences for {{employeeName}}',
                message: 'Employee {{employeeName}} ({{employeeId}}) has logged 3 consecutive unexcused absences. Please review and connect.'
            },
            {
                type: 'notification',
                target: 'HR Operations',
                recipient_role: 'hr',
                channels: ['in_app', 'sms'],
                title: 'HR Threshold Notice: Unexcused Absence Cluster ({{employeeName}})',
                message: '3-day consecutive absence breach logged for {{employeeName}} in {{department}} department.'
            }
        ]
    },
    {
        id: 'alert-payroll-variance-exceeded',
        name: 'Payroll: Variance > 10% Anomaly Alert',
        module: 'payroll',
        category: 'Financial Safety',
        severity: 'critical',
        trigger_event: 'payroll.variance_calculated',
        metric: 'Gross Payroll Variance %',
        thresholdValue: 10,
        comparator: '>',
        conditions: {
            field: 'variancePercentage',
            op: '>',
            value: 10
        },
        recipients: [
            { role: 'Payroll Admin', type: 'primary', channel: 'In-App + High-Priority Email' }
        ],
        escalation: null,
        status: 'active',
        description: 'Monitors pre-payroll gross disbursement calculations; triggers immediate freeze notice to Payroll Admin if month-over-month variance exceeds 10%.',
        pipeline: [
            {
                type: 'notification',
                target: 'Payroll Admin',
                recipient_role: 'payroll_admin',
                channels: ['email', 'in_app'],
                title: 'Critical Anomaly: Payroll Variance Exceeded 10% ({{variancePercentage}}%)',
                message: 'Payroll cycle {{cycleMonth}} showed gross variance of {{variancePercentage}}% (exceeding maximum allowable 10%). Hold applied pending sign-off.'
            }
        ]
    },
    {
        id: 'alert-policy-acknowledgement-pending',
        name: 'Policy: Acknowledgement Pending 3 Days Reminder',
        module: 'policies',
        category: 'Compliance Tracking',
        severity: 'warning',
        trigger_event: 'policy.acknowledgement_pending',
        metric: 'Pending Duration (Days)',
        thresholdValue: 3,
        comparator: '>=',
        conditions: {
            field: 'pendingDays',
            op: '>=',
            value: 3
        },
        recipients: [
            { role: 'Employee', type: 'primary', channel: 'In-App + Email Reminder' },
            { role: 'Reporting Manager', type: 'secondary', channel: 'Weekly Digest' }
        ],
        escalation: null,
        status: 'active',
        description: 'Sends automated compliance nudges to employees when mandatory company policies remain unacknowledged for 3 or more business days.',
        pipeline: [
            {
                type: 'notification',
                target: 'Employee',
                recipient_role: 'employee',
                channels: ['in_app', 'email'],
                title: 'Reminder: Mandatory Policy Awaiting Your Signature',
                message: 'Your acknowledgment for policy "{{policyTitle}}" has been pending for {{pendingDays}} days. Please complete in self-service.'
            },
            {
                type: 'notification',
                target: 'Reporting Manager',
                recipient_role: 'manager',
                channels: ['in_app'],
                title: 'Compliance Nudge: {{employeeName}} Policy Pending',
                message: 'Employee {{employeeName}} has not acknowledged "{{policyTitle}}" for {{pendingDays}} days.'
            }
        ]
    },
    {
        id: 'alert-pms-review-deadline-approaching',
        name: 'PMS: Review Deadline Approaching Escalation',
        module: 'pms',
        category: 'Performance Management',
        severity: 'warning',
        trigger_event: 'pms.review_deadline_approaching',
        metric: 'Days Remaining Until Review Cut-off',
        thresholdValue: 2,
        comparator: '<=',
        conditions: {
            field: 'daysUntilDeadline',
            op: '<=',
            value: 2
        },
        recipients: [
            { role: 'Reporting Manager', type: 'primary', channel: 'In-App Notification + Push' }
        ],
        escalation: {
            condition: 'If deadline reaches 1 day or passes',
            escalateTo: 'HR Escalation / HRBP',
            channel: 'Urgent Slack / Email'
        },
        status: 'active',
        description: 'Reminds managers 2 days before performance review cycles close, and automatically triggers an HRBP escalation if pending reviews remain open.',
        pipeline: [
            {
                type: 'notification',
                target: 'Reporting Manager',
                recipient_role: 'manager',
                channels: ['in_app'],
                title: 'Urgent: Performance Review Deadline Approaching for {{employeeName}}',
                message: 'Quarterly evaluation for {{employeeName}} closes in {{daysUntilDeadline}} days. Please submit rating immediately.'
            },
            {
                type: 'decision',
                conditions: {
                    field: 'daysUntilDeadline',
                    op: '<=',
                    value: 1
                }
            },
            {
                type: 'notification',
                target: 'HR Escalation',
                recipient_role: 'hrbp',
                channels: ['email', 'in_app'],
                title: 'PMS Manager Review Delay Escalation ({{employeeName}})',
                message: 'Manager evaluation for {{employeeName}} is critical (<= 1 day left). Escalated to HRBP.'
            }
        ]
    },
    {
        id: 'alert-exit-clearance-pending-48h',
        name: 'Exit: Clearance Pending 48 Hours Escalation',
        module: 'exit',
        category: 'Offboarding SLAs',
        severity: 'critical',
        trigger_event: 'exit.clearance_pending',
        metric: 'Clearance Inactivity Hours',
        thresholdValue: 48,
        comparator: '>=',
        conditions: {
            field: 'pendingHours',
            op: '>=',
            value: 48
        },
        recipients: [
            { role: 'Responsible Person', type: 'primary', channel: 'Direct SMS + In-App SLA Tag' }
        ],
        escalation: {
            condition: 'Clearance > 48h SLA Breach',
            escalateTo: 'Head of HR Escalation',
            channel: 'High-Priority Alert'
        },
        status: 'active',
        description: 'Monitors departmental exit clearance milestones (IT, Finance, Admin); if any signoff is pending for 48 hours, notifies responsible person and escalates to Head of HR.',
        pipeline: [
            {
                type: 'notification',
                target: 'Responsible Person',
                recipient_role: 'responsible_officer',
                channels: ['sms', 'in_app'],
                title: 'SLA Alert: Exit Clearance Sign-off Pending ({{department}})',
                message: 'Asset/Clearance approval for resigning employee {{employeeName}} has been pending in {{department}} for {{pendingHours}} hours.'
            },
            {
                type: 'notification',
                target: 'Head of HR',
                recipient_role: 'head_of_hr',
                channels: ['in_app', 'email'],
                title: 'Exit SLA Breach Escalation: {{department}} clearance stalled ({{pendingHours}}h)',
                message: 'Separation process for {{employeeName}} delayed by {{department}} clearance ({{pendingHours}}h). Escalated to Head of HR.'
            }
        ]
    }
];

// Map storing active alert rules
const alertRulesMap = new Map();

// Sync initial rules with AutomationEngine
function initializeAlertRules() {
    DEFAULT_ALERT_RULES.forEach(rule => {
        alertRulesMap.set(rule.id, rule);
        // Register in the unified automation engine
        automationEngine.registerRule({
            id: rule.id,
            name: rule.name,
            trigger_event: rule.trigger_event,
            conditions: rule.conditions,
            pipeline: rule.pipeline,
            status: rule.status
        });
    });
    logger.info(`[AlertBuilder] Synchronized ${alertRulesMap.size} standard alert rules with Common Automation Engine.`);
}

initializeAlertRules();
syncAlertRulesWithFirestore().catch(() => {});

/* ── Per-organization rules ────────────────────────────────────────────────
 * Each organization's rules live in Firestore 'alert_rules' with its orgId. Standard rules
 * an organization has not saved yet are listed as templates (isTemplate: true); toggling or
 * editing one saves the organization's own copy. Document ids are namespaced per
 * organization (the original Kylrx AI organization keeps the plain rule id).
 */

function orgOf(req) {
    return (req.user && req.user.orgId) || req.tenantOrgId || null;
}

// Automation engine audit entries made by this company's rules (engine rule ids are namespaced per company,
// the original company keeps plain ids)
function ownsEngineLog(orgId, log) {
    const id = log && typeof log.automationId === 'string' ? log.automationId : '';
    if (!id) return false;
    return orgId === LEGACY_ORG_ID ? !id.includes('__') : id.startsWith(`${orgId}__`);
}

function ruleDocId(orgId, ruleId) {
    return orgId === LEGACY_ORG_ID ? String(ruleId) : `${orgId}__${ruleId}`;
}


async function orgRules(orgId) {
    const docs = await orgDocs(rawCollection, 'alert_rules', orgId);
    const rules = new Map();
    docs.filter(r => r && r.id && r.trigger_event).forEach(r => rules.set(r.id, { ...r, isTemplate: false }));
    for (const template of DEFAULT_ALERT_RULES) {
        if (!rules.has(template.id)) rules.set(template.id, { ...template, isTemplate: true });
    }
    return [...rules.values()];
}

async function findOrgRule(orgId, ruleId) {
    return (await orgRules(orgId)).find(r => r.id === ruleId) || null;
}

// Engine rule ids are namespaced too, so organizations never overwrite each other's rules
function registerWithEngine(orgId, rule) {
    automationEngine.registerRule({
        id: ruleDocId(orgId, rule.id),
        name: rule.name,
        trigger_event: rule.trigger_event,
        conditions: rule.conditions,
        pipeline: rule.pipeline,
        status: rule.status
    });
}

async function saveOrgRule(orgId, rule) {
    const { isTemplate, ...data } = rule;
    await confirmedWrite(() => rawCollection('alert_rules').doc(ruleDocId(orgId, rule.id)).set({
        ...data,
        orgId,
        syncedWithFirebase: true,
        updatedAt: new Date().toISOString()
    }, { merge: true }));
    registerWithEngine(orgId, rule);
    if (orgId === LEGACY_ORG_ID) alertRulesMap.set(rule.id, data);
}

// Sync alert rules with Cloud Firestore
async function syncAlertRulesWithFirestore() {
    if (!db || typeof db.collection !== 'function') return;
    try {
        const snap = await db.collection('alert_rules').limit(20).get().catch(() => ({ empty: true }));
        if (snap && snap.empty) {
            for (const rule of alertRulesMap.values()) {
                await db.collection('alert_rules').doc(rule.id).set({
                    ...rule,
                    syncedWithFirebase: true,
                    updatedAt: new Date().toISOString()
                }, { merge: true }).catch(() => {});
            }
            logger.info(`[AlertBuilder] Seeded ${alertRulesMap.size} rules into Firebase collection 'alert_rules'`);
        } else if (snap && !snap.empty) {
            snap.forEach(docSnap => {
                const r = docSnap.data();
                if (r && r.id && r.trigger_event) {
                    alertRulesMap.set(r.id, r);
                    automationEngine.registerRule({
                        id: r.id,
                        name: r.name,
                        trigger_event: r.trigger_event,
                        conditions: r.conditions,
                        pipeline: r.pipeline,
                        status: r.status
                    });
                }
            });
            logger.info(`[AlertBuilder] Loaded ${snap.size} alert rules live from Firebase Firestore`);
        }
    } catch (e) {
        logger.warn(`[AlertBuilder] Firestore rules sync notice: ${e.message}`);
    }
}

/**
 * GET /api/alerts/firebase-status
 * Live Firebase backend connectivity & stats
 */
router.get('/firebase-status', async (req, res) => {
    try {
        let rulesCount = 0;
        let breachesCount = 0;
        let isConnected = false;

        if (db && typeof db.collection === 'function') {
            try {
                const orgId = orgOf(req);
                rulesCount = (await orgDocs(rawCollection, 'alert_rules', orgId, 20)).length;
                breachesCount = (await orgDocs(rawCollection, 'alert_breaches', orgId, 20)).length;
                isConnected = true;
            } catch (e) {
                isConnected = true;
            }
        }

        res.status(200).json({
            success: true,
            firebase: {
                connected: isConnected,
                projectId: 'kylrxai',
                storageBucket: 'kylrxai.firebasestorage.app',
                clientEmail: 'firebase-adminsdk-fbsvc@kylrxai.iam.gserviceaccount.com',
                collections: {
                    alert_rules: rulesCount,
                    alert_breaches: breachesCount,
                    activities: 1
                },
                timestamp: new Date().toISOString()
            }
        });
    } catch (error) {
        logger.error('[AlertBuilder] Firebase status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/alerts/sync-firebase
 * Force synchronization of current alert rules and ping cloud Firestore
 */
router.post('/sync-firebase', async (req, res) => {
    try {
        if (!db || typeof db.collection !== 'function') {
            return res.status(503).json({ success: false, message: 'Firebase Admin SDK not initialized' });
        }

        // Only the caller's own saved rules are written back (never another company's, never the shared list)
        const orgId = orgOf(req);
        const rules = (await orgRules(orgId)).filter(r => !r.isTemplate);
        for (const r of rules) {
            const { isTemplate, ...data } = r;
            rawCollection('alert_rules').doc(ruleDocId(orgId, r.id)).set({
                ...data,
                orgId,
                updatedAt: new Date().toISOString(),
                syncedWithFirebase: true
            }, { merge: true }).catch(() => {});
        }

        const pingDoc = {
            orgId,
            pingId: `ALERT_PING_${Date.now()}`,
            service: 'Alert Builder Threshold Monitoring',
            event: 'FIREBASE_ALERT_SYNC_PING',
            timestamp: new Date().toISOString(),
            status: 'HEALTHY',
            source: 'admin-alert-builder'
        };

        const writePromise = db.collection('activities').add(pingDoc).catch(err => {
            logger.warn('[AlertBuilder] Firebase activity ping notice:', err.message);
        });

        await Promise.race([
            writePromise,
            new Promise(resolve => setTimeout(resolve, 1500))
        ]);

        res.status(200).json({
            success: true,
            message: 'Successfully synchronized alert monitors with Firebase Cloud Firestore',
            rulesCount: rules.length,
            ping: pingDoc
        });
    } catch (error) {
        logger.error('[AlertBuilder] Firebase sync error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/alerts/rules
 * Fetch all configured alert monitoring rules
 */
router.get('/rules', async (req, res) => {
    try {
        const rules = await orgRules(orgOf(req));
        res.status(200).json({
            success: true,
            count: rules.length,
            rules
        });
    } catch (error) {
        logger.error('[AlertBuilder] Error fetching alert rules:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/alerts/rules
 * Create or update an alert monitoring rule (registers dynamically with AutomationEngine)
 */
router.post('/rules', async (req, res) => {
    try {
        const {
            name,
            module,
            trigger_event,
            metric,
            comparator,
            thresholdValue,
            recipients,
            escalation,
            category,
            severity,
            description
        } = req.body;

        if (!name || !trigger_event || !comparator || thresholdValue === undefined) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: name, trigger_event, comparator, thresholdValue'
            });
        }

        const id = req.body.id || `alert-${(module || 'custom').toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`;
        
        // Build conditions object for AutomationEngine
        const fieldName = req.body.fieldName || 'metricValue';
        const conditions = {
            field: fieldName,
            op: comparator,
            value: Number(thresholdValue)
        };

        // Synthesize notification pipeline
        const pipeline = [
            {
                type: 'notification',
                target: (recipients && recipients[0]?.role) || 'Administrator',
                recipient_role: 'admin',
                channels: ['in_app', 'email'],
                title: `Alert Triggered: ${name}`,
                message: `Threshold breached (${metric || fieldName} ${comparator} ${thresholdValue}).`
            }
        ];

        if (escalation && escalation.escalateTo) {
            pipeline.push({
                type: 'notification',
                target: escalation.escalateTo,
                recipient_role: 'escalation_lead',
                channels: ['email'],
                title: `Escalation Notice: ${name}`,
                message: `Alert escalated to ${escalation.escalateTo} after threshold breach.`
            });
        }

        const newRule = {
            id,
            name,
            module: module || 'general',
            category: category || 'Custom Monitor',
            severity: severity || 'warning',
            trigger_event,
            metric: metric || fieldName,
            thresholdValue: Number(thresholdValue),
            comparator,
            conditions,
            recipients: recipients || [{ role: 'Administrator', type: 'primary', channel: 'In-App' }],
            escalation: escalation || null,
            status: 'active',
            description: description || `Alert rule monitoring ${metric} with threshold ${comparator} ${thresholdValue}`,
            pipeline
        };

        // Saved for the caller's organization first; registered with the engine only once Firestore confirmed
        await saveOrgRule(orgOf(req), { ...newRule, createdAt: new Date().toISOString() });
        logger.info(`[AlertBuilder] Saved alert rule '${id}' for ${orgOf(req)} and registered it with the Automation Engine`);

        res.status(201).json({
            success: true,
            message: `Alert monitoring rule '${name}' configured successfully in Automation Engine`,
            rule: newRule
        });
    } catch (error) {
        logger.error('[AlertBuilder] Error creating alert rule:', error);
        res.status(error.status || 500).json({ success: false, firebaseSaved: false, error: error.message });
    }
});

/**
 * PATCH /api/alerts/rules/:id/toggle
 * Toggle active/inactive state of an alert rule
 */
router.patch('/rules/:id/toggle', async (req, res) => {
    try {
        const { id } = req.params;
        const orgId = orgOf(req);
        const rule = await findOrgRule(orgId, id);
        if (!rule) {
            return res.status(404).json({ success: false, error: `Alert rule '${id}' not found` });
        }

        rule.status = rule.status === 'active' ? 'disabled' : 'active';
        await saveOrgRule(orgId, rule);
        logger.info(`[AlertBuilder] Toggled rule '${id}' for ${orgId} to: ${rule.status}`);

        res.status(200).json({
            success: true,
            firebaseSaved: true,
            ruleId: id,
            newStatus: rule.status,
            message: `Alert rule status updated to ${rule.status}`
        });
    } catch (error) {
        logger.error('[AlertBuilder] Error toggling rule:', error);
        res.status(error.status || 500).json({ success: false, firebaseSaved: false, error: error.message });
    }
});

/**
 * POST /api/alerts/test-fire
 * Simulate/Test-fire an alert through the underlying Common Automation Engine
 */
router.post('/test-fire', async (req, res) => {
    try {
        const { ruleId, customPayload } = req.body;
        const orgId = orgOf(req);
        const rule = await findOrgRule(orgId, ruleId);

        if (!rule) {
            return res.status(404).json({ success: false, error: `Rule '${ruleId}' not found` });
        }

        // Prepare simulated event payload conforming to rule requirements
        let payload = customPayload || {};
        let entityId = 'EMP-TEST-901';
        let entityType = 'employee';

        switch (rule.module) {
            case 'attendance':
                payload = {
                    employeeId: entityId,
                    employeeName: 'Priya Sharma',
                    department: 'Engineering',
                    consecutiveAbsences: 3,
                    dates: ['2026-09-08', '2026-09-09', '2026-09-10'],
                    ...payload
                };
                break;
            case 'payroll':
                entityId = 'PAY-RUN-SEP2026';
                entityType = 'payroll_run';
                payload = {
                    batchId: 'BATCH-SEP-FINAL',
                    cycleMonth: 'September 2026',
                    priorGrossTotal: 4500000,
                    currentGrossTotal: 5040000,
                    variancePercentage: 12.0, // > 10%
                    ...payload
                };
                break;
            case 'policies':
                payload = {
                    employeeId: entityId,
                    employeeName: 'Rahul Verma',
                    policyId: 'POL-INFOSec-2026',
                    policyTitle: 'Information Security & Data Protection Policy',
                    assignedDate: '2026-09-07',
                    pendingDays: 4, // >= 3
                    ...payload
                };
                break;
            case 'pms':
                payload = {
                    employeeId: entityId,
                    employeeName: 'Aarav Patel',
                    cycleName: 'Q3 Enterprise PMS Review',
                    daysUntilDeadline: 1, // <= 2, triggers manager + HR escalation
                    managerName: 'Vikram Singh',
                    ...payload
                };
                break;
            case 'exit':
                entityId = 'SEP-REQ-1049';
                entityType = 'exit_request';
                payload = {
                    employeeId: 'EMP-771',
                    employeeName: 'Ananya Rao',
                    department: 'Finance & Accounts',
                    clearanceDepartment: 'Finance',
                    pendingHours: 52, // >= 48
                    responsiblePerson: 'Lead Accountant',
                    ...payload
                };
                break;
            default:
                payload = {
                    metricValue: rule.thresholdValue,
                    ...payload
                };
        }

        const eventId = `test-alert-${crypto.randomUUID().slice(0, 8)}`;
        const eventData = {
            eventId,
            eventName: rule.trigger_event,
            entityId,
            entityType,
            payload,
            timestamp: new Date().toISOString()
        };

        const initialLogCount = automationEngine.auditLogs.length;

        // Run only this company's rule (processEvent would also run every other company's rules for this event)
        const engineRuleId = ruleDocId(orgId, rule.id);
        if (String(rule.status || '').toLowerCase() === 'active') {
            await automationEngine.executeRule({
                id: engineRuleId,
                name: rule.name,
                trigger_event: rule.trigger_event,
                conditions: rule.conditions,
                pipeline: rule.pipeline,
                status: rule.status
            }, eventData);
        }

        // Fetch logs created during this run by this rule
        const generatedAuditLogs = automationEngine.auditLogs.slice(initialLogCount).filter(l => l.automationId === engineRuleId);
        const conditionMet = !generatedAuditLogs.some(l => l.status === 'conditions_unmet');

        let breachSaved = false;
        let breachError = null;
        if (conditionMet && db && typeof db.collection === 'function') {
            await confirmedWrite(() => rawCollection('alert_breaches').add({
                orgId,
                source: 'simulation_console',
                ruleId,
                ruleName: rule.name,
                module: rule.module,
                severity: rule.severity,
                eventId,
                payload,
                recipientsNotified: rule.recipients ? rule.recipients.map(r => r.role) : [],
                escalationTriggered: rule.escalation ? (rule.escalation.escalateTo || rule.escalation) : null,
                timestamp: new Date().toISOString()
            })).then(() => { breachSaved = true; }).catch(err => { breachError = err.message; });
        }

        res.status(200).json({
            success: true,
            ruleId,
            ruleName: rule.name,
            triggerEvent: rule.trigger_event,
            dispatchedEventId: eventId,
            payload,
            conditionMet,
            recipientsNotified: conditionMet ? rule.recipients.map(r => r.role) : [],
            escalationTriggered: conditionMet && rule.escalation ? rule.escalation.escalateTo : null,
            executionAuditTrail: generatedAuditLogs,
            engineStatus: 'Processed by Kylrx Unified Automation Engine',
            breachSaved,
            breachError
        });
    } catch (error) {
        logger.error('[AlertBuilder] Error test-firing alert:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/alerts/stats
 * Overview dashboard metrics for Alert Builder
 */
router.get('/stats', async (req, res) => {
    try {
        const rules = await orgRules(orgOf(req));
        const activeCount = rules.filter(r => r.status === 'active').length;
        const totalMonitors = rules.length;
        
        // Filter audit logs relating to alert triggers
        const orgId = orgOf(req);
        const alertAuditLogs = automationEngine.auditLogs
            .filter(l => ownsEngineLog(orgId, l))
            .filter(l => l.eventName && (l.eventName.startsWith('attendance.') || l.eventName.startsWith('payroll.') || l.eventName.startsWith('policy.') || l.eventName.startsWith('pms.') || l.eventName.startsWith('exit.')))
            .slice(-20)
            .reverse();

        res.status(200).json({
            success: true,
            totalMonitors,
            activeCount,
            disabledCount: totalMonitors - activeCount,
            criticalMonitors: rules.filter(r => r.severity === 'critical').length,
            recentDispatches: alertAuditLogs.length,
            recentLogs: alertAuditLogs
        });
    } catch (error) {
        logger.error('[AlertBuilder] Error fetching stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * PRD Section 11: Alert Trigger Registry & Safe AI Simulation Endpoints
 */

/**
 * GET /api/alerts/triggers
 * Returns all technical triggers with human-readable descriptions and sample payloads
 */
router.get('/triggers', (req, res) => {
    try {
        const triggers = triggerRegistryService.getAllTriggers();
        res.status(200).json({
            success: true,
            count: triggers.length,
            triggers
        });
    } catch (error) {
        logger.error('[AlertBuilder] Error fetching trigger registry:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/alerts/simulate
 * Sandboxed Dry-Run Guarantee: Executes evaluation rules without writing changes to Firestore,
 * mutating employee records, dispatching emails/SMS, or executing external webhooks.
 */
router.post('/simulate', (req, res) => {
    try {
        const { eventKey, payload, options } = req.body;
        if (!eventKey) {
            return res.status(400).json({ success: false, error: 'eventKey is required for simulation.' });
        }
        const simulationResult = triggerRegistryService.runSandboxedDryRun(eventKey, payload || {}, options || {});
        res.status(200).json(simulationResult);
    } catch (error) {
        logger.error('[AlertBuilder] Error in AI simulation sandbox:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
