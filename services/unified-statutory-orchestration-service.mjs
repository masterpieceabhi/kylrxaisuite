/**
 * ============================================================================
 * KYLRX AI ENTERPRISE HRMS - UNIFIED STATUTORY ORCHESTRATION SERVICE
 * ============================================================================
 * Connects all three statutory compliance schemes (ESIC, Gratuity, and NPS)
 * to the Kylrx AI HRMS Firebase backend:
 *
 * 1. Unified Event Listener:
 *    - Master trigger on the `payroll_runs` collection (status: 'FINALIZED') or
 *      EventBus PAYROLL_FINALIZED event.
 *    - Simultaneously initiates the ESIC, Gratuity, and NPS automation builders
 *      as independent worker pipelines (Promise.allSettled).
 *
 * 2. Firestore Staging Collections:
 *    - /esic_compliance_batches/{batch_id}
 *    - /gratuity_settlements/{batch_id}
 *    - /nps_compliance_batches/{batch_id}
 *    - /statutory_exceptions/{exception_id} (Shared cross-scheme collection)
 *
 * 3. Audit & Best Practices Compliance:
 *    - Captures rule versions (ESIC_RULE_V4.0, GRATUITY_RULE_V4.0, NPS_RULE_V4.0)
 *    - Execution timestamps (triggered_at, completed_at, duration_ms)
 *    - Source payroll IDs (source_payroll_id)
 *    - SHA-256 file checksums for all official portal files
 *
 * 4. Data Masking & PII Protection:
 *    - Enforces masking on sensitive master identifiers (UAN, ESIC No, PRAN,
 *      Nominee details) in front-end UI representations while preserving full
 *      unmasked values for file exports and secure databases.
 *
 * @version 4.0.0
 * @author Kylrx AI Lead Systems Architect & Compliance Team
 */

import crypto from 'node:crypto';
import EventEmitter from 'node:events';

// Import Pillar 1, 2, 3 Engines
import {
  globalEsicAutomationEngine,
  EsicAutomationEngine,
} from './esic-automation-engine.mjs';

import {
  globalGratuityAutomationEngine,
  GratuityAutomationEngine,
} from './gratuity-automation-engine.mjs';

import {
  globalCorporateNpsAutomationEngine,
  CorporateNpsAutomationEngine,
} from './corporate-nps-automation-engine.mjs';

import {
  globalPfEcrAutomationEngine,
  PfEcrAutomationEngine,
  EPFO_STATUTORY_RULE_VERSION,
} from './pf-ecr-automation-engine.mjs';

// Import Data Masking Service
import { DataMaskingService } from './authorization-guard-masking.mjs';

// Import Centralized Audit Logger
import { globalComplianceAuditStream, ComplianceAuditStream } from './compliance-audit-logger.mjs';

export const STATUTORY_RULE_VERSIONS = Object.freeze({
  ESIC: 'ESIC_STATUTORY_RULE_V4.0',
  GRATUITY: 'GRATUITY_STATUTORY_RULE_V4.0',
  NPS: 'NPS_STATUTORY_RULE_V4.0',
  PF: EPFO_STATUTORY_RULE_VERSION,
  ORCHESTRATOR: 'UNIFIED_COMPLIANCE_ORCHESTRATOR_V4.0',
});

export class UnifiedStatutoryOrchestrator {
  constructor(options = {}) {
    this.esicEngine = options.esicEngine || globalEsicAutomationEngine;
    this.gratuityEngine = options.gratuityEngine || globalGratuityAutomationEngine;
    this.npsEngine = options.npsEngine || globalCorporateNpsAutomationEngine;
    this.pfEngine = options.pfEngine || globalPfEcrAutomationEngine;
    this.firestoreDb = options.firestoreDb || null;
    this.eventBus = options.eventBus || null;
    // A company's own orchestrator (routes/unified-compliance.mjs keeps one per company): its documents carry
    // orgId and their ids are prefixed with it, so two companies never write the same document
    this.orgId = options.orgId || null;

    /** @type {Map<string, object>} Staging store for /esic_compliance_batches */
    this.esicStagingStore = new Map();

    /** @type {Map<string, object>} Staging store for /gratuity_settlements */
    this.gratuityStagingStore = new Map();

    /** @type {Map<string, object>} Staging store for /nps_compliance_batches */
    this.npsStagingStore = new Map();

    /** @type {Map<string, object>} Staging store for /pf_compliance_batches */
    this.pfStagingStore = new Map();

    /** @type {Map<string, object>} Staging store for /statutory_exceptions (Shared) */
    this.sharedExceptionsStore = new Map();

    /** @type {Map<string, object>} Staging store for /payroll_runs */
    this.payrollRunsStore = new Map();

    /** @type {Map<string, object>} Execution manifests keyed by orchestration_id or source_payroll_id */
    this.executionManifests = new Map();

    if (this.firestoreDb && options.listen !== false) {
      this.attachPayrollRunsListener(this.firestoreDb);
    }
    if (this.eventBus) {
      this.attachEventBusListener(this.eventBus);
    }
  }

  /**
   * 1. UNIFIED EVENT LISTENER: Firestore Snapshot on `payroll_runs` (status: 'FINALIZED')
   */
  attachPayrollRunsListener(firestoreDb) {
    if (!firestoreDb || typeof firestoreDb.collection !== 'function') return;
    this.firestoreDb = firestoreDb;

    try {
      const payrollRunsRef = firestoreDb.collection('payroll_runs');
      // If Firestore supports onSnapshot (live SDK)
      if (typeof payrollRunsRef.where === 'function' && typeof payrollRunsRef.onSnapshot === 'function') {
        payrollRunsRef.where('status', '==', 'FINALIZED').onSnapshot(
          (snapshot) => {
            snapshot.docChanges().forEach(async (change) => {
              if (change.type === 'added' || change.type === 'modified') {
                const payrollRunData = change.doc.data();
                const runId = change.doc.id || payrollRunData.payroll_run_id || payrollRunData.run_id;
                await this.orchestratePayrollRun({ ...payrollRunData, payroll_run_id: runId });
              }
            });
          },
          (err) => {
            console.warn('[UnifiedStatutoryOrchestrator] Firestore listener warning:', err.message);
          }
        );
      }
    } catch (e) {
      console.warn('[UnifiedStatutoryOrchestrator] Could not register Firestore onSnapshot:', e.message);
    }
  }

  /**
   * Centralized EventBus listener for PAYROLL_FINALIZED
   */
  attachEventBusListener(eventBus) {
    if (!eventBus || typeof eventBus.on !== 'function') return;
    this.eventBus = eventBus;

    eventBus.on('PAYROLL_FINALIZED', async (eventData) => {
      try {
        const payload = eventData?.payload || eventData || {};
        await this.orchestratePayrollRun(payload);
      } catch (err) {
        console.error('[UnifiedStatutoryOrchestrator] Error handling PAYROLL_FINALIZED:', err);
      }
    });
  }

  /**
   * Master Orchestration Pipeline: Initiates ESIC, Gratuity, and NPS workers simultaneously
   */
  async orchestratePayrollRun(payrollRunData = {}, options = {}) {
    const startTime = Date.now();
    const sourcePayrollId = String(
      payrollRunData.payroll_run_id ||
      payrollRunData.run_id ||
      payrollRunData.source_payroll_id ||
      `PR_${Date.now()}`
    ).trim();

    const period = String(payrollRunData.period || payrollRunData.wage_period || '2026-09').slice(0, 7);
    const orchestrationId = `ORCH_${sourcePayrollId}_${Date.now()}`;
    const auditCorrelationId = `CORR_${crypto.randomBytes(4).toString('hex')}`;

    // 1. Stage trigger document in /payroll_runs
    const triggerDoc = {
      payroll_run_id: sourcePayrollId,
      run_id: sourcePayrollId,
      period,
      status: 'FINALIZED',
      finalized_at: payrollRunData.finalized_at || new Date().toISOString(),
      finalized_by: payrollRunData.finalized_by || options.triggered_by || 'system-payroll-engine',
      total_gross: Number(payrollRunData.total_gross || 0),
      total_net: Number(payrollRunData.total_net || 0),
      currency: payrollRunData.currency || 'INR',
      orchestration_id: orchestrationId,
      audit_correlation_id: auditCorrelationId,
      employees: payrollRunData.employees || payrollRunData.payroll_records || [],
      created_at: new Date().toISOString(),
    };
    await this.writeToFirestore('payroll_runs', sourcePayrollId, triggerDoc);
    this.payrollRunsStore.set(sourcePayrollId, triggerDoc);

    const employees = triggerDoc.employees;

    // 2. SIMULTANEOUS INDEPENDENT WORKER PIPELINES (Promise.allSettled)
    const [esicResult, gratuityResult, npsResult, pfResult] = await Promise.allSettled([
      this.runEsicWorker(sourcePayrollId, period, employees, triggerDoc),
      this.runGratuityWorker(sourcePayrollId, period, employees, triggerDoc),
      this.runNpsWorker(sourcePayrollId, period, employees, triggerDoc),
      this.runPfWorker(sourcePayrollId, period, employees, triggerDoc),
    ]);

    const durationMs = Date.now() - startTime;
    const completedAt = new Date().toISOString();

    // 3. Compile Shared Statutory Exceptions
    const collectedExceptions = [];

    // Helper to stage and route exceptions
    const routeException = async (exc) => {
      const exceptionId = exc.exception_id || `EXC_${exc.scheme}_${sourcePayrollId}_${exc.employee_id}_${crypto.randomBytes(2).toString('hex')}`;
      const doc = {
        exception_id: exceptionId,
        scheme: exc.scheme,
        source_payroll_id: sourcePayrollId,
        batch_id: exc.batch_id,
        employee_id: exc.employee_id,
        employee_name: exc.employee_name || `Employee ${exc.employee_id}`,
        error_code: exc.code === 'EMP004' ? 'ESIC_MISSING_IP_NUMBER' : (exc.code || exc.error_code),
        code: exc.code || exc.error_code,
        severity: exc.severity || 'BLOCK',
        message: exc.message,
        suggested_fix: exc.suggested_fix || exc.suggestedFix || null,
        actual_value: exc.actual_value !== undefined ? exc.actual_value : null,
        resolved: Boolean(exc.resolved),
        resolved_at: exc.resolved_at || null,
        resolved_by: exc.resolved_by || null,
        rule_version_applied: STATUTORY_RULE_VERSIONS[exc.scheme] || 'V4.0',
        created_at: exc.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      await this.writeToFirestore('statutory_exceptions', exceptionId, doc);
      this.sharedExceptionsStore.set(exceptionId, doc);
      collectedExceptions.push(doc);
    };

    if (esicResult.status === 'fulfilled' && esicResult.value?.exceptions) {
      for (const e of esicResult.value.exceptions) {
        await routeException({ ...e, scheme: 'ESIC' });
      }
    }
    if (gratuityResult.status === 'fulfilled' && gratuityResult.value?.exceptions) {
      for (const e of gratuityResult.value.exceptions) {
        await routeException({ ...e, scheme: 'GRATUITY' });
      }
    }
    if (npsResult.status === 'fulfilled' && npsResult.value?.exceptions) {
      for (const e of npsResult.value.exceptions) {
        await routeException({ ...e, scheme: 'NPS' });
      }
    }
    if (pfResult.status === 'fulfilled' && pfResult.value?.exceptions) {
      for (const e of pfResult.value.exceptions) {
        await routeException({ ...e, scheme: 'PF' });
      }
    }

    const blockingCount = collectedExceptions.filter((e) => e.severity === 'BLOCK' && !e.resolved).length;

    // 4. Build Full Execution Manifest
    const executionManifest = {
      orchestration_id: orchestrationId,
      source_payroll_id: sourcePayrollId,
      period,
      rule_versions: STATUTORY_RULE_VERSIONS,
      triggered_at: triggerDoc.finalized_at,
      completed_at: completedAt,
      duration_ms: durationMs,
      workers: {
        esic: {
          success: esicResult.status === 'fulfilled',
          batch_id: esicResult.value?.batch_id || `ESIC_${sourcePayrollId}`,
          subscribers_count: esicResult.value?.total_subscribers || 0,
          total_wages: esicResult.value?.total_wages || 0,
          total_amount: esicResult.value?.total_contribution_amount || 0,
          checksum_sha256: esicResult.value?.file_manifest?.txt_checksum_sha256 || null,
          rule_version: STATUTORY_RULE_VERSIONS.ESIC,
          error: esicResult.status === 'rejected' ? esicResult.reason?.message : null,
        },
        gratuity: {
          success: gratuityResult.status === 'fulfilled',
          batch_id: gratuityResult.value?.batch_id || `GRAT_${sourcePayrollId}`,
          candidates_count: gratuityResult.value?.total_candidates || 0,
          eligible_count: gratuityResult.value?.total_eligible_count || 0,
          total_amount: gratuityResult.value?.total_gratuity_payable || 0,
          checksum_sha256: gratuityResult.value?.file_manifest?.checksum_sha256 || null,
          rule_version: STATUTORY_RULE_VERSIONS.GRATUITY,
          error: gratuityResult.status === 'rejected' ? gratuityResult.reason?.message : null,
        },
        nps: {
          success: npsResult.status === 'fulfilled',
          batch_id: npsResult.value?.batch_id || `NPS_${sourcePayrollId}`,
          subscribers_count: npsResult.value?.total_subscribers || 0,
          total_amount: npsResult.value?.total_contribution_amount || 0,
          checksum_sha256: npsResult.value?.file_manifest?.checksum_sha256 || null,
          rule_version: STATUTORY_RULE_VERSIONS.NPS,
          error: npsResult.status === 'rejected' ? npsResult.reason?.message : null,
        },
        pf: {
          success: pfResult.status === 'fulfilled',
          batch_id: pfResult.value?.batch_id || `PF_${sourcePayrollId}`,
          subscribers_count: pfResult.value?.total_subscribers || 0,
          total_amount: pfResult.value?.total_challan_amount || 0,
          checksum_sha256: pfResult.value?.file_manifest?.checksum_sha256 || null,
          rule_version: STATUTORY_RULE_VERSIONS.PF,
          error: pfResult.status === 'rejected' ? pfResult.reason?.message : null,
        },
      },
      total_exceptions_count: collectedExceptions.length,
      blocking_exceptions_count: blockingCount,
      is_blocked: blockingCount > 0,
      audit_correlation_id: auditCorrelationId,
    };

    this.executionManifests.set(orchestrationId, executionManifest);
    this.executionManifests.set(sourcePayrollId, executionManifest);

    // 5. Centralized Compliance Audit Logger Integration
    try {
      globalComplianceAuditStream.appendEvent({
        entity_type: 'PayrollRun',
        entity_id: sourcePayrollId,
        from_state: 'RUNNING',
        to_state: 'FINALIZED',
        actor_id: triggerDoc.finalized_by,
        actor_role: 'SYSTEM_ORCHESTRATOR',
        rule_version_applied: STATUTORY_RULE_VERSIONS.ORCHESTRATOR,
        correlation_id: auditCorrelationId,
        metadata: {
          orchestration_id: orchestrationId,
          duration_ms: durationMs,
          total_exceptions: collectedExceptions.length,
          blocking_exceptions: blockingCount,
          workers: {
            esic_amount: executionManifest.workers.esic.total_amount,
            gratuity_amount: executionManifest.workers.gratuity.total_amount,
            nps_amount: executionManifest.workers.nps.total_amount,
          },
        },
      });
    } catch (auditErr) {
      console.warn('[UnifiedStatutoryOrchestrator] Audit logger notice:', auditErr.message);
    }

    return executionManifest;
  }

  /**
   * Worker 1: ESIC Automation Builder Pipeline
   */
  async runEsicWorker(sourcePayrollId, period, employees, triggerDoc) {
    const batchId = `ESIC_BATCH_${sourcePayrollId}`;
    this.esicEngine.initStepper(batchId, sourcePayrollId, period);

    // Execute ESIC calculation
    const calcResult = this.esicEngine.calculateEsicBatch({
      batch_id: batchId,
      run_id: sourcePayrollId,
      period,
      payroll_records: employees,
    });

    // Compile official exports
    let fileManifest = null;
    try {
      const exportFiles = this.esicEngine.generateExportFiles(batchId);
      fileManifest = {
        txt_file_name: exportFiles.txt.file_name,
        txt_checksum_sha256: exportFiles.txt.checksum || exportFiles.manifest?.txt_file?.checksum,
        xls_file_name: exportFiles.xls.file_name,
        xls_checksum_sha256: exportFiles.xls.checksum || exportFiles.manifest?.xls_file?.checksum,
        generated_at: exportFiles.manifest?.generated_at,
      };
    } catch (e) {
      // Export could be blocked by defects
    }

    const stageDoc = {
      batch_id: batchId,
      source_payroll_id: sourcePayrollId,
      period,
      scheme: 'ESIC',
      rule_version: STATUTORY_RULE_VERSIONS.ESIC,
      status: calcResult.exceptions?.length > 0 ? 'BLOCKED_ON_DEFECTS' : 'PROCESSED',
      total_subscribers: calcResult.summary.total_compliant_records,
      total_wages: calcResult.summary.total_wages,
      total_employee_amount: calcResult.summary.total_employee_share,
      total_employer_amount: calcResult.summary.total_employer_share,
      total_contribution_amount: calcResult.summary.total_challan_amount,
      unresolved_blocking_count: calcResult.summary.total_exceptions || 0,
      is_blocked: calcResult.exceptions?.length > 0,
      file_manifest: fileManifest,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await this.writeToFirestore('esic_compliance_batches', batchId, stageDoc);
    this.esicStagingStore.set(batchId, stageDoc);

    return {
      ...stageDoc,
      exceptions: calcResult.exceptions || [],
    };
  }

  /**
   * Worker 2: Statutory Gratuity Provisioning Pipeline
   */
  async runGratuityWorker(sourcePayrollId, period, employees, triggerDoc) {
    const batchId = `GRAT_BATCH_${sourcePayrollId}`;

    // Map employees to exit candidates or provisioning candidates
    let exitCandidates = employees.filter((e) => e.date_of_exit || e.exit_date);
    if (exitCandidates.length === 0) {
      // Check master profiles or provide eligible set
      exitCandidates = employees.map((e) => ({
        employee_id: e.employee_id,
        employee_name: e.employee_name,
        date_of_joining: e.date_of_joining || '2019-01-01',
        date_of_exit: e.date_of_exit || null,
        exit_reason: e.exit_reason || null,
        last_drawn_salary: e.last_drawn_salary || e.basic || 30000,
        nominee_details: e.nominee_details,
      }));
    }

    const calcResult = await this.gratuityEngine.triggerProvisioningAndSettlement({
      batch_id: batchId,
      trigger_source: 'PAYROLL_FINALIZED',
      period,
      maker_id: triggerDoc?.finalized_by || 'SYSTEM',
      exit_records: exitCandidates,
    });

    let fileManifest = null;
    try {
      const statement = this.gratuityEngine.statementFiles.get(batchId) || this.gratuityEngine.generateGratuityStatement(batchId, period);
      fileManifest = {
        file_name: statement.manifest?.file_name || statement.manifest?.xlsx_file?.file_name || statement.xlsx?.file_name,
        checksum_sha256: statement.manifest?.xlsx_file?.checksum || statement.xlsx?.checksum,
        row_count: statement.manifest?.total_records || calcResult.total_eligible || 0,
        generated_at: statement.manifest?.generated_at,
      };
    } catch (e) {
      // Statement compilation error
    }

    const stageDoc = {
      batch_id: batchId,
      source_payroll_id: sourcePayrollId,
      period,
      scheme: 'GRATUITY',
      rule_version: STATUTORY_RULE_VERSIONS.GRATUITY,
      status: calcResult.total_eligible > 0 ? 'CALCULATED' : 'PROVISIONED',
      total_candidates: calcResult.total_candidates,
      total_eligible_count: calcResult.total_eligible,
      total_ineligible_count: calcResult.total_ineligible,
      total_gratuity_payable: calcResult.total_gratuity_amount,
      is_maker_checker_approved: false,
      approved_by: null,
      file_manifest: fileManifest,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await this.writeToFirestore('gratuity_settlements', batchId, stageDoc);
    this.gratuityStagingStore.set(batchId, stageDoc);

    const exceptions = (calcResult.ineligible_candidates || []).map((c) => ({
      code: 'GRATUITY_UNVESTED_SERVICE',
      severity: 'WARNING',
      employee_id: c.profile?.employee_id || c.employee_id,
      employee_name: c.profile?.employee_name || c.employee_name,
      message: typeof c.reason === 'string' ? c.reason : 'Gratuity vesting requirement not met.',
      suggested_fix: 'Review statutory service tenure and continuous employment records.',
    }));

    return {
      ...stageDoc,
      exceptions,
    };
  }

  /**
   * Worker 3: Corporate NPS Automation Builder Pipeline
   */
  async runNpsWorker(sourcePayrollId, period, employees, triggerDoc) {
    const batchId = `NPS_BATCH_${sourcePayrollId}`;

    const calcResult = this.npsEngine.calculateNpsBatch({
      batch_id: batchId,
      run_id: sourcePayrollId,
      period,
      payroll_records: employees,
    });

    let fileManifest = null;
    try {
      const nsdlExport = this.npsEngine.compileNsdlUploadFile(batchId);
      fileManifest = {
        file_name: nsdlExport.manifest.file_name,
        checksum_sha256: nsdlExport.manifest.checksum_sha256,
        row_count: nsdlExport.manifest.total_subscribers,
        generated_at: nsdlExport.manifest.generated_at,
      };
    } catch (e) {
      // Export blocked by defects
    }

    const stageDoc = {
      batch_id: batchId,
      source_payroll_id: sourcePayrollId,
      period,
      scheme: 'NPS',
      rule_version: STATUTORY_RULE_VERSIONS.NPS,
      status: calcResult.is_blocked ? 'BLOCKED_ON_DEFECTS' : 'PROCESSED',
      total_subscribers: calcResult.summary.total_compliant_subscribers,
      total_employee_amount: calcResult.summary.total_employee_amount,
      total_employer_amount: calcResult.summary.total_employer_amount,
      total_contribution_amount: calcResult.summary.total_contribution_amount,
      unresolved_blocking_count: calcResult.unresolved_blocking_defects_count,
      is_blocked: calcResult.is_blocked,
      prn_acknowledgement_token: null,
      file_manifest: fileManifest,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await this.writeToFirestore('nps_compliance_batches', batchId, stageDoc);
    this.npsStagingStore.set(batchId, stageDoc);

    return {
      ...stageDoc,
      exceptions: calcResult.validation_issues || [],
    };
  }

  /**
   * Worker 4: Statutory PF & EPFO ECR Pipeline
   */
  async runPfWorker(sourcePayrollId, period, employees, triggerDoc) {
    const batchId = `PF_BATCH_${sourcePayrollId}`;

    const calcResult = this.pfEngine.calculatePfBatch({
      batch_id: batchId,
      run_id: sourcePayrollId,
      period,
      payroll_records: employees,
    });

    let fileManifest = null;
    try {
      const ecrExport = this.pfEngine.exportFiles.get(batchId) || this.pfEngine.generateEcrExport(batchId);
      fileManifest = {
        file_name: ecrExport.manifest.file_name,
        checksum_sha256: ecrExport.manifest.checksum_sha256,
        row_count: ecrExport.manifest.total_subscribers,
        total_challan_amount: ecrExport.manifest.total_challan_amount,
        generated_at: ecrExport.manifest.generated_at,
      };
    } catch (e) {
      // Export blocked by defects
    }

    const stageDoc = {
      batch_id: batchId,
      source_payroll_id: sourcePayrollId,
      period,
      scheme: 'PF',
      rule_version: STATUTORY_RULE_VERSIONS.PF || 'EPFO_PF_STATUTORY_RULE_V4.0',
      status: calcResult.exceptions?.length > 0 ? 'BLOCKED_ON_DEFECTS' : 'PROCESSED',
      total_subscribers: calcResult.summary.total_compliant_records,
      total_epf_wages: calcResult.summary.total_epf_wages,
      total_ee_share: calcResult.summary.total_ee_share,
      total_er_epf_share: calcResult.summary.total_er_epf_share,
      total_eps_share: calcResult.summary.total_eps_share,
      total_edli_charges: calcResult.summary.total_edli_charges,
      total_admin_charges: calcResult.summary.total_admin_charges,
      total_challan_amount: calcResult.summary.total_challan_amount,
      unresolved_blocking_count: calcResult.summary.total_exceptions || 0,
      is_blocked: calcResult.exceptions?.length > 0,
      file_manifest: fileManifest,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    await this.writeToFirestore('pf_compliance_batches', batchId, stageDoc);
    this.pfStagingStore.set(batchId, stageDoc);

    return {
      ...stageDoc,
      exceptions: calcResult.exceptions || [],
    };
  }

  /**
   * Safe Firestore Document Writer (works with live Firestore or memory fallback)
   */
  async writeToFirestore(collectionName, docId, data) {
    if (this.firestoreDb && typeof this.firestoreDb.collection === 'function') {
      try {
        if (this.orgId) {
          await this.firestoreDb.collection(collectionName).doc(`${this.orgId}__${docId}`).set({ ...data, orgId: this.orgId }, { merge: true });
          return;
        }
        await this.firestoreDb.collection(collectionName).doc(docId).set(data, { merge: true });
      } catch (err) {
        // Fallback gracefully without throwing
      }
    }
  }

  /**
   * 4. DATA MASKING & PII ENFORCEMENT:
   * Returns a copy of data with sensitive identifiers (UAN, ESIC No, PRAN, Nominee details)
   * masked for front-end UI serialization, preserving full values in underlying engines/exports.
   */
  maskForUiPresentation(data) {
    return DataMaskingService.maskSensitivePayload(data);
  }

  /**
   * Query staging data for a source payroll run
   */
  getStagingRecords(sourcePayrollId, options = {}) {
    const esic = this.esicStagingStore.get(`ESIC_BATCH_${sourcePayrollId}`) || null;
    const gratuity = this.gratuityStagingStore.get(`GRAT_BATCH_${sourcePayrollId}`) || null;
    const nps = this.npsStagingStore.get(`NPS_BATCH_${sourcePayrollId}`) || null;
    const exceptions = Array.from(this.sharedExceptionsStore.values()).filter(
      (e) => e.source_payroll_id === sourcePayrollId
    );

    const result = {
      source_payroll_id: sourcePayrollId,
      esic_compliance_batch: esic,
      gratuity_settlement: gratuity,
      nps_compliance_batch: nps,
      statutory_exceptions: exceptions,
      total_exceptions: exceptions.length,
      blocking_exceptions: exceptions.filter((e) => e.severity === 'BLOCK' && !e.resolved).length,
    };

    if (options.mask !== false) {
      return this.maskForUiPresentation(result);
    }
    return result;
  }

  /**
   * Query all shared statutory exceptions
   */
  getSharedExceptions(filter = {}, options = {}) {
    let list = Array.from(this.sharedExceptionsStore.values());

    if (filter.scheme) {
      list = list.filter((e) => String(e.scheme).toUpperCase() === String(filter.scheme).toUpperCase());
    }
    if (filter.source_payroll_id) {
      list = list.filter((e) => e.source_payroll_id === filter.source_payroll_id);
    }
    if (filter.unresolved_only) {
      list = list.filter((e) => !e.resolved);
    }

    const payload = {
      total_count: list.length,
      unresolved_count: list.filter((e) => !e.resolved).length,
      exceptions: list,
    };

    if (options.mask !== false) {
      return this.maskForUiPresentation(payload);
    }
    return payload;
  }

  /**
   * Resolves a shared statutory exception
   */
  async resolveSharedException(exceptionId, resolutionData = {}) {
    const doc = this.sharedExceptionsStore.get(exceptionId);
    if (!doc) {
      return { success: false, error: `Exception ${exceptionId} not found in statutory_exceptions.` };
    }

    doc.resolved = true;
    doc.resolved_at = new Date().toISOString();
    doc.resolved_by = resolutionData.resolved_by || 'compliance-officer';
    doc.fix_applied = resolutionData.fix_applied || resolutionData.corrected_value || 'Resolved via Unified Compliance Hub';
    doc.updated_at = new Date().toISOString();

    // Propagate to underlying scheme engines
    if (doc.scheme === 'ESIC') {
      this.esicEngine.resolveException(exceptionId, resolutionData);
    } else if (doc.scheme === 'NPS') {
      this.npsEngine.resolveValidationIssue(exceptionId, resolutionData);
    }

    await this.writeToFirestore('statutory_exceptions', exceptionId, doc);
    return { success: true, exception: doc };
  }
}

export const globalUnifiedStatutoryOrchestrator = new UnifiedStatutoryOrchestrator();
