const { db } = require('../config/firebase');
const eventBus = require('./event-bus');
const moduleRegistry = require('./automation-module-registry');
const logger = require('../utils/logger');
const crypto = require('crypto');

/**
 * Unified Enterprise HR Automation Engine
 * 
 * Core Engine executing the 8-stage pipeline:
 * Trigger → Conditions → Decision/Branch → Approval → Wait/Escalation → Action → Notification → Audit
 */
class AutomationEngine {
    constructor() {
        this.isInitialized = false;
        this.inMemoryRules = new Map(); // Fallback / dev cache
        this.inMemoryRuns = new Map(); // Fast local runs cache
        this.processedEventIds = new Set(); // In-memory idempotency cache
        this.auditLogs = []; // In-memory audit logs buffer
    }

    /**
     * Start the engine and bind to the central EventBus
     */
    start() {
        if (this.isInitialized) return;

        logger.info('[AutomationEngine] 🚀 Starting Unified Automation Engine & binding to EventBus...');

        // Listen to the catch-all event on the central event bus
        eventBus.on('*', async (eventData) => {
            try {
                await this.processEvent(eventData);
            } catch (error) {
                logger.error(`[AutomationEngine] Error processing event ${eventData?.eventId}:`, error);
            }
        });

        this.isInitialized = true;
    }

    /**
     * Register an in-memory rule (useful for fast-testing and bootstrapping)
     */
    registerRule(rule) {
        const trigger = rule?.trigger_event || rule?.triggerEvent;
        if (!rule || !rule.id || !trigger) {
            throw new Error('Rule must contain id and trigger_event');
        }
        this.inMemoryRules.set(rule.id, { ...rule, trigger_event: trigger, status: rule.status || 'active' });
    }

    /**
     * Clear in-memory rules
     */
    clearRules() {
        this.inMemoryRules.clear();
        this.processedEventIds.clear();
        this.auditLogs = [];
    }

    /**
     * STAGE 1: TRIGGER INGESTION & IDEMPOTENCY
     */
    async processEvent(eventData) {
        if (!eventData || !eventData.eventName) return;

        const { eventName, eventId } = eventData;

        // Idempotency check: avoid double execution of identical eventId
        if (eventId) {
            if (this.processedEventIds.has(eventId)) {
                logger.warn(`[AutomationEngine] Duplicate event skipped by idempotency filter: ${eventId}`);
                return;
            }
            this.processedEventIds.add(eventId);
            // Evict old IDs after cache exceeds 5000 items
            if (this.processedEventIds.size > 5000) {
                const first = this.processedEventIds.values().next().value;
                this.processedEventIds.delete(first);
            }
        }

        logger.info(`[AutomationEngine] [STAGE 1: TRIGGER] Ingested event: ${eventName} (ID: ${eventId})`);
        let automations = [];

        // 1. Check matching in-memory rules first (instantaneous local evaluation)
        for (const rule of this.inMemoryRules.values()) {
            if (rule.trigger_event === eventName && String(rule.status || '').toLowerCase() === 'active') {
                if (!automations.find(a => a.id === rule.id)) {
                    automations.push(rule);
                }
            }
        }

        // 2. If no in-memory rules matched and db is connected, check Firestore
        if (automations.length === 0 && db) {
            try {
                const snapshot = await Promise.race([
                    // Builder saves status as 'ACTIVE'; compare case-insensitively below
                    db.collection('automations')
                        .where('trigger_event', '==', eventName)
                        .get(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Firestore timeout')), 1000))
                ]);

                if (!snapshot.empty) {
                    automations = snapshot.docs
                        .map(doc => ({ id: doc.id, ...doc.data() }))
                        .filter(rule => String(rule.status || '').toLowerCase() === 'active');
                }
            } catch (error) {
                logger.warn(`[AutomationEngine] Could not query Firestore automations (${error.message}).`);
            }
        }

        if (automations.length === 0) {
            logger.info(`[AutomationEngine] No active automation rules found for event: ${eventName}`);
            return;
        }

        // Execute matching rules
        for (const rule of automations) {
            await this.executeRule(rule, eventData);
        }
    }

    /**
     * STAGE 2: CONDITIONS EVALUATION
     */
    async executeRule(rule, eventData) {
        logger.info(`[AutomationEngine] Evaluating rule '${rule.name || rule.id}' for trigger ${eventData.eventName}`);

        // Resolve dynamic module data if specified
        let enrichedContext = { ...eventData.payload };
        if (rule.module_key && eventData.entityType && eventData.entityId) {
            try {
                const resolved = await moduleRegistry.resolveData(
                    rule.module_key, 
                    eventData.entityType, 
                    eventData.entityId, 
                    eventData.payload
                );
                if (resolved) {
                    enrichedContext[eventData.entityType] = resolved;
                }
            } catch (e) {
                logger.warn(`[AutomationEngine] Error resolving module data: ${e.message}`);
            }
        }

        // Evaluate Rule Conditions
        const isMatch = this.evaluateCondition(rule.conditions, enrichedContext);
        
        if (!isMatch) {
            logger.info(`[AutomationEngine] [STAGE 2: CONDITIONS] Conditions NOT met for rule: ${rule.id}`);
            await this.recordAuditLog({
                runId: null,
                automationId: rule.id,
                eventId: eventData.eventId,
                eventName: eventData.eventName,
                stage: 'Conditions',
                status: 'conditions_unmet',
                details: { conditions: rule.conditions, payload: eventData.payload }
            });
            return;
        }

        logger.info(`[AutomationEngine] [STAGE 2: CONDITIONS] Conditions MET. Starting execution run.`);

        // Initialize execution run
        const runId = crypto.randomUUID();
        const runRecord = {
            run_id: runId,
            automation_id: rule.id,
            automation_name: rule.name || rule.id,
            event_id: eventData.eventId,
            event_name: eventData.eventName,
            entity_id: eventData.entityId,
            entity_type: eventData.entityType,
            status: 'in_progress',
            started_at: new Date().toISOString(),
            current_step: 0,
            payload_snapshot: eventData.payload,
            enriched_context: enrichedContext,
            logs: []
        };

        this.inMemoryRuns.set(runId, runRecord);

        if (db) {
            try {
                db.collection('automation_runs').doc(runId).set(runRecord).catch(() => {});
            } catch (e) {
                logger.warn(`[AutomationEngine] Could not persist run ${runId} to Firestore: ${e.message}`);
            }
        }

        await this.recordAuditLog({
            runId,
            automationId: rule.id,
            eventId: eventData.eventId,
            eventName: eventData.eventName,
            stage: 'Trigger & Conditions',
            status: 'started',
            details: { conditions: rule.conditions }
        });

        // Begin pipeline sequence
        await this.processPipelineStep(rule, rule.pipeline || [], 0, runId, eventData, enrichedContext);
    }

    /**
     * EXECUTES THE REMAINING STAGES:
     * 3. Decision/Branch -> 4. Approval -> 5. Wait/Escalation -> 6. Action -> 7. Notification -> 8. Audit
     */
    async processPipelineStep(rule, pipeline, stepIndex, runId, eventData, context) {
        if (stepIndex >= pipeline.length) {
            // All steps completed successfully
            logger.info(`[AutomationEngine] ✅ Pipeline completed successfully for Run ${runId}`);
            
            if (db) {
                try {
                    db.collection('automation_runs').doc(runId).update({
                        status: 'completed',
                        completed_at: new Date().toISOString()
                    }).catch(() => {});
                } catch (e) {}
            }

            await this.recordAuditLog({
                runId,
                automationId: rule.id,
                eventId: eventData.eventId,
                eventName: eventData.eventName,
                stage: 'Pipeline Completed',
                status: 'completed',
                details: { totalStepsExecuted: pipeline.length }
            });
            return;
        }

        const step = pipeline[stepIndex];
        logger.info(`[AutomationEngine] Run ${runId} -> Processing Step ${stepIndex} (${step.type})`);

        if (db) {
            try {
                db.collection('automation_runs').doc(runId).update({ current_step: stepIndex }).catch(() => {});
            } catch (e) {}
        }

        try {
            switch (step.type) {
                // STAGE 3: DECISION / BRANCH
                case 'decision':
                case 'branch': {
                    const branchDecision = this.evaluateCondition(step.conditions, context);
                    logger.info(`[AutomationEngine] [STAGE 3: DECISION/BRANCH] Evaluated to: ${branchDecision}`);
                    
                    await this.recordAuditLog({
                        runId,
                        automationId: rule.id,
                        stage: 'Decision/Branch',
                        status: 'evaluated',
                        details: { decision: branchDecision, conditions: step.conditions }
                    });

                    // If branch matches, execute sub-pipeline or select branch path
                    const branchPipeline = branchDecision 
                        ? (step.ifTrue || step.then || []) 
                        : (step.ifFalse || step.else || []);

                    if (branchPipeline.length > 0) {
                        await this.processPipelineStep(rule, branchPipeline, 0, runId, eventData, context);
                    }
                    break;
                }

                // STAGE 4: APPROVAL GATE (Maker-Checker)
                case 'approval': {
                    logger.info(`[AutomationEngine] [STAGE 4: APPROVAL] Creating approval gate for Run ${runId}`);
                    const taskId = await this.createApprovalTask(step, runId, eventData, rule);
                    
                    if (db) {
                        try {
                            db.collection('automation_runs').doc(runId).update({
                                status: 'waiting_on_task',
                                active_task_id: taskId
                            }).catch(() => {});
                        } catch (e) {}
                    }

                    await this.recordAuditLog({
                        runId,
                        automationId: rule.id,
                        stage: 'Approval',
                        status: 'paused_for_approval',
                        details: { taskId, role: step.assignee_role, title: step.title }
                    });

                    // Pause execution until approved or rejected via API
                    return;
                }

                // STAGE 5: WAIT & ESCALATION
                case 'wait': {
                    logger.info(`[AutomationEngine] [STAGE 5: WAIT/ESCALATION] Step configured wait: ${step.durationMinutes || 0}m`);
                    await this.recordAuditLog({
                        runId,
                        automationId: rule.id,
                        stage: 'Wait/Escalation',
                        status: 'wait_registered',
                        details: { durationMinutes: step.durationMinutes, escalationAssignee: step.escalation_assignee }
                    });
                    break;
                }

                // STAGE 6: ACTION EXECUTION
                case 'action': {
                    logger.info(`[AutomationEngine] [STAGE 6: ACTION] Executing action: '${step.action}'`);
                    const interpolatedParams = this.interpolateObject(step.params || {}, context);
                    
                    let actionResult = null;
                    if (step.action === 'update_firestore') {
                        const { collection, documentId, updates } = interpolatedParams;
                        const docId = documentId === '{entityId}' ? eventData.entityId : documentId;
                        if (db && collection && docId) {
                            await db.collection(collection).doc(docId).set(updates, { merge: true });
                            actionResult = { updated: true, collection, docId };
                        }
                    } else {
                        // Dispatch directly to the registered HR module action handler
                        actionResult = await moduleRegistry.executeAction(step.action, interpolatedParams, {
                            runId,
                            eventId: eventData.eventId,
                            entityId: eventData.entityId,
                            entityType: eventData.entityType,
                            ruleId: rule.id
                        });
                    }

                    // Merge result into context for downstream steps
                    context[`action_${stepIndex}_result`] = actionResult;

                    await this.recordAuditLog({
                        runId,
                        automationId: rule.id,
                        stage: 'Action',
                        status: 'executed',
                        details: { action: step.action, params: interpolatedParams, result: actionResult }
                    });
                    break;
                }

                // STAGE 7: NOTIFICATION
                case 'notification': {
                    logger.info(`[AutomationEngine] [STAGE 7: NOTIFICATION] Dispatching alert to ${step.target || 'target'}`);
                    const message = this.interpolateTemplate(step.message || '', context);
                    const title = this.interpolateTemplate(step.title || 'Automation Notification', context);
                    
                    await this.sendNotification({
                        target: step.target,
                        recipientRole: step.recipient_role,
                        title,
                        message,
                        channels: step.channels || ['in_app']
                    }, eventData);

                    await this.recordAuditLog({
                        runId,
                        automationId: rule.id,
                        stage: 'Notification',
                        status: 'dispatched',
                        details: { target: step.target, title, message }
                    });
                    break;
                }

                default:
                    logger.warn(`[AutomationEngine] Unrecognized pipeline step type: ${step.type}`);
            }

            // Proceed to next step
            await this.processPipelineStep(rule, pipeline, stepIndex + 1, runId, eventData, context);

        } catch (error) {
            logger.error(`[AutomationEngine] ❌ Error in step ${stepIndex} (${step.type}) for Run ${runId}:`, error);
            
            if (db) {
                try {
                    await db.collection('automation_runs').doc(runId).update({
                        status: 'failed',
                        error_message: error.message,
                        failed_at: new Date().toISOString()
                    });
                } catch (e) {}
            }

            // STAGE 8: AUDIT FAILURE RECORDING
            await this.recordAuditLog({
                runId,
                automationId: rule.id,
                stage: `Step ${stepIndex} (${step.type})`,
                status: 'failed',
                details: { error: error.message, stack: error.stack }
            });
        }
    }

    /**
     * Create an approval task in Firestore (STAGE 4 & 5)
     */
    async createApprovalTask(stepConfig, runId, eventData, rule) {
        const taskId = crypto.randomUUID();
        const escalationMetadata = {};
        
        if (stepConfig.escalation_hours) {
            const escalationAt = new Date();
            escalationAt.setHours(escalationAt.getHours() + stepConfig.escalation_hours);
            escalationMetadata.escalation_at = escalationAt.toISOString();
            escalationMetadata.escalation_assignee = stepConfig.escalation_assignee || 'superadmin';
        }

        const taskData = {
            task_id: taskId,
            run_id: runId,
            automation_id: rule.id || 'unknown',
            assignee_role: stepConfig.assignee_role || 'hr_admin',
            assignee_id: stepConfig.assignee_id || null,
            entity_id: eventData.entityId || null,
            entity_type: eventData.entityType || null,
            title: stepConfig.title || 'Pending Approval Gate',
            description: stepConfig.description || `Approval required for workflow: ${rule.name || rule.id}`,
            status: 'pending',
            created_at: new Date().toISOString(),
            payload: eventData.payload || {},
            ...escalationMetadata
        };

        if (db) {
            try {
                db.collection('tasks').doc(taskId).set(taskData).catch(() => {});
            } catch (e) {
                logger.warn(`[AutomationEngine] Could not persist task ${taskId}: ${e.message}`);
            }
        }

        return taskId;
    }

    /**
     * Resume a paused pipeline after approval/task resolution
     */
    async resumePipeline(runId, actionData = {}) {
        logger.info(`[AutomationEngine] Resuming Run ${runId} following task resolution: ${actionData.action}`);

        let runData = this.inMemoryRuns.get(runId);
        if (!runData && db) {
            try {
                const runDoc = await db.collection('automation_runs').doc(runId).get();
                if (runDoc.exists) {
                    runData = runDoc.data();
                }
            } catch (e) {}
        }

        if (!runData) {
            throw new Error(`Automation run '${runId}' not found`);
        }

        if (runData.status !== 'waiting_on_task') {
            throw new Error(`Run ${runId} is not currently waiting on a task (status: ${runData.status})`);
        }

        // Audit the task approval
        await this.recordAuditLog({
            runId,
            automationId: runData.automation_id,
            stage: 'Approval Resolution',
            status: actionData.action,
            details: actionData
        });

        if (actionData.action === 'rejected') {
            logger.info(`[AutomationEngine] Task rejected for Run ${runId}. Terminating pipeline.`);
            if (db) {
                await db.collection('automation_runs').doc(runId).update({
                    status: 'rejected',
                    resolved_at: new Date().toISOString()
                });
            }
            return { resumed: false, status: 'rejected' };
        }

        // Load rule
        let rule = this.inMemoryRules.get(runData.automation_id);
        if (!rule && db) {
            const ruleDoc = await db.collection('automations').doc(runData.automation_id).get();
            if (ruleDoc.exists) rule = ruleDoc.data();
        }

        if (!rule) {
            throw new Error(`Original automation rule '${runData.automation_id}' not found`);
        }

        if (db) {
            await db.collection('automation_runs').doc(runId).update({ status: 'in_progress' });
        }

        // Resume next step in pipeline
        await this.processPipelineStep(
            rule,
            rule.pipeline || [],
            (runData.current_step || 0) + 1,
            runId,
            {
                eventId: runData.event_id,
                eventName: runData.event_name,
                entityId: runData.entity_id,
                entityType: runData.entity_type,
                payload: runData.payload_snapshot
            },
            {
                ...runData.enriched_context,
                approval_resolution: actionData
            }
        );

        return { resumed: true, status: 'completed' };
    }

    /**
     * STAGE 7: DISPATCH NOTIFICATION
     */
    async sendNotification(notificationData, eventData) {
        logger.info(`[AutomationEngine] 📨 Dispatching notification: "${notificationData.title}"`);
        
        if (db) {
            try {
                const notifId = crypto.randomUUID();
                db.collection('notifications').doc(notifId).set({
                    id: notifId,
                    title: notificationData.title,
                    message: notificationData.message,
                    target: notificationData.target || 'admin',
                    recipient_role: notificationData.recipientRole || null,
                    entity_id: eventData.entityId || null,
                    created_at: new Date().toISOString(),
                    read: false
                }).catch(() => {});
            } catch (e) {
                logger.warn(`[AutomationEngine] Could not persist notification to Firestore: ${e.message}`);
            }
        }
    }

    /**
     * STAGE 8: IMMUTABLE AUDIT LOGGING
     */
    async recordAuditLog(logData) {
        const auditEntry = {
            audit_id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            ...logData
        };

        this.auditLogs.push(auditEntry);
        if (this.auditLogs.length > 5000) this.auditLogs.shift();

        logger.info(`[AutomationEngine] [STAGE 8: AUDIT] ${auditEntry.stage} - ${auditEntry.status} (Run: ${auditEntry.runId || 'N/A'})`);

        if (db) {
            try {
                // Write to centralized immutable audit log collection
                db.collection('automation_audit_logs').doc(auditEntry.audit_id).set(auditEntry).catch(() => {});
                
                // Also append to automation run logs array if run exists
                if (auditEntry.runId) {
                    const admin = require('../config/firebase-admin');
                    db.collection('automation_runs').doc(auditEntry.runId).set({
                        logs: admin.firestore.FieldValue.arrayUnion(auditEntry)
                    }, { merge: true }).catch(() => {});
                }
            } catch (e) {
                // Firestore offline/mock
            }
        }
        return auditEntry;
    }

    /**
     * Dynamic Condition Evaluator
     */
    evaluateCondition(conditionBlock, context) {
        if (!conditionBlock || Object.keys(conditionBlock).length === 0) return true;

        if (conditionBlock.operator === 'AND') {
            return (conditionBlock.rules || []).every(rule => this.evaluateCondition(rule, context));
        }

        if (conditionBlock.operator === 'OR') {
            return (conditionBlock.rules || []).some(rule => this.evaluateCondition(rule, context));
        }

        const { field, op, value } = conditionBlock;
        if (!field || !op) return true;

        const resolvedValue = this.resolveFieldPath(context, field);

        switch (op) {
            case '==': return resolvedValue == value;
            case '===': return resolvedValue === value;
            case '!=': return resolvedValue != value;
            case '!==': return resolvedValue !== value;
            case '>': return Number(resolvedValue) > Number(value);
            case '>=': return Number(resolvedValue) >= Number(value);
            case '<': return Number(resolvedValue) < Number(value);
            case '<=': return Number(resolvedValue) <= Number(value);
            case 'in': return Array.isArray(value) && value.includes(resolvedValue);
            case 'contains': 
                if (Array.isArray(resolvedValue)) return resolvedValue.includes(value);
                if (typeof resolvedValue === 'string') return resolvedValue.includes(String(value));
                return false;
            default: return false;
        }
    }

    /**
     * Resolve nested dot notation, e.g. 'candidate.department'
     */
    resolveFieldPath(obj, path) {
        if (!obj || !path) return undefined;
        return path.split('.').reduce((curr, key) => (curr ? curr[key] : undefined), obj);
    }

    /**
     * Interpolate template strings with {{variable}}
     */
    interpolateTemplate(template, context) {
        if (typeof template !== 'string') return template;
        return template.replace(/\{\{([^}]+)\}\}/g, (_, path) => {
            const val = this.resolveFieldPath(context, path.trim());
            return val !== undefined ? val : '';
        });
    }

    /**
     * Recursively interpolate an object's string values
     */
    interpolateObject(obj, context) {
        if (!obj || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(i => this.interpolateObject(i, context));

        const result = {};
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string') {
                result[k] = this.interpolateTemplate(v, context);
            } else if (typeof v === 'object' && v !== null) {
                result[k] = this.interpolateObject(v, context);
            } else {
                result[k] = v;
            }
        }
        return result;
    }
}

const engine = new AutomationEngine();
module.exports = engine;
