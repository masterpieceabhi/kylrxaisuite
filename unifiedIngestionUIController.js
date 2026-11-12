/**
 * ============================================================================
 * KYLRX.AI ENTERPRISE HRMS - UNIFIED INGESTION UI CONTROLLER
 * ============================================================================
 * 
 * Admin UI Controller script integrating:
 * 1. Multi-Template Tab Switching ("Job & Rosters", "Employee Finance & Compliance", "Organization Registrations")
 * 2. Drag & Drop File Upload Zones with SheetJS Integration
 * 3. High-Density Interactive Preview Grids with Search, Filtering & Error Highlights
 * 4. One-Click Ingestion Triggers with Transactional Batch Commits & Real-Time Progress Bar
 * 5. Decentro Penny Drop Verification indicators & Sample Template Generators
 * 
 * @version 2.0.0
 * @author Principal Full-Stack & Enterprise Systems Architect
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.KylrxUnifiedIngestionUIController = factory();
        root.unifiedIngestionUIController = root.KylrxUnifiedIngestionUIController;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // State management for uploaded datasets across the 3 tabs
    const state = {
        activeTab: 'jobRoster',
        jobRoster: {
            parsedResult: null,
            filter: 'all',
            searchQuery: ''
        },
        employeeFinance: {
            parsedResult: null,
            filter: 'all',
            searchQuery: ''
        },
        orgCompliance: {
            parsedResult: null,
            filter: 'all',
            searchQuery: ''
        }
    };

    /**
     * Show global toast notification
     */
    function showToast(message, type = 'info') {
        if (window.feedbackService && typeof window.feedbackService.showToast === 'function') {
            window.feedbackService.showToast(message, type);
            return;
        }

        const existingToast = document.getElementById('unifiedIngestionToast');
        if (existingToast) existingToast.remove();

        const toast = document.createElement('div');
        toast.id = 'unifiedIngestionToast';
        toast.style.position = 'fixed';
        toast.style.bottom = '24px';
        toast.style.right = '24px';
        toast.style.zIndex = '99999';
        toast.style.padding = '14px 22px';
        toast.style.borderRadius = '14px';
        toast.style.fontWeight = '700';
        toast.style.fontSize = '0.9rem';
        toast.style.color = '#ffffff';
        toast.style.boxShadow = '0 10px 25px rgba(0,0,0,0.15)';
        toast.style.display = 'flex';
        toast.style.alignItems = 'center';
        toast.style.gap = '10px';
        toast.style.animation = 'slideInRight 0.3s ease';

        if (type === 'success') {
            toast.style.backgroundColor = '#10b981';
            toast.innerHTML = `<i data-lucide="check-circle" style="width: 18px; height: 18px;"></i> ${message}`;
        } else if (type === 'error') {
            toast.style.backgroundColor = '#ef4444';
            toast.innerHTML = `<i data-lucide="alert-triangle" style="width: 18px; height: 18px;"></i> ${message}`;
        } else {
            toast.style.backgroundColor = '#3b82f6';
            toast.innerHTML = `<i data-lucide="info" style="width: 18px; height: 18px;"></i> ${message}`;
        }

        document.body.appendChild(toast);
        if (window.lucide) window.lucide.createIcons();

        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transition = 'opacity 0.4s ease';
            setTimeout(() => toast.remove(), 400);
        }, 4000);
    }

    /**
     * Download text/csv file
     */
    function downloadFile(content, fileName, mimeType = 'text/csv;charset=utf-8;') {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * Helper to hide all views and deactivate all tab buttons
     */
    function deactivateAllTabs() {
        const tabIds = [
            'tabManual', 'tabBulk', 'tabUnifiedJobRoster', 'tabUnifiedEmployeeFinance', 'tabUnifiedOrgCompliance',
            'tabBusinessUnits', 'tabCostCenters', 'tabSubDepartments', 'tabShifts', 'tabAttendancePolicies',
            'tabEmployeeTypes', 'tabEmployeeFinance', 'tabEpfoMaster', 'tabEsicMaster', 'tabPtMaster',
            'tabLwfMaster', 'tabNpsMaster', 'tabGratuityMaster', 'tabSalaryStructure', 'tabHolidayCalendar',
            'tabStatutoryCompliance', 'tabPayrollComponents'
        ];

        const viewIds = [
            'manualView', 'uploadView', 'unifiedJobRosterView', 'unifiedEmployeeFinanceView', 'unifiedOrgComplianceView',
            'buManagementView', 'ccManagementView', 'subDeptManagementView', 'shiftManagementView',
            'attendancePolicyManagementView', 'employeeTypeManagementView', 'employeeFinanceManagementView',
            'epfoMasterManagementView', 'esicMasterManagementView', 'ptMasterManagementView',
            'lwfMasterManagementView', 'npsMasterManagementView', 'gratuityMasterManagementView',
            'salaryStructureManagementView', 'holidayCalendarManagementView', 'statutoryComplianceManagementView',
            'payrollComponentsManagementView'
        ];

        tabIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.classList.remove('active');
        });

        viewIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
    }

    /**
     * Tab Switcher Handler
     */
    function switchTab(tabKey) {
        state.activeTab = tabKey;
        deactivateAllTabs();

        const tabBtnJob = document.getElementById('tabUnifiedJobRoster');
        const tabBtnFin = document.getElementById('tabUnifiedEmployeeFinance');
        const tabBtnOrg = document.getElementById('tabUnifiedOrgCompliance');

        const viewJob = document.getElementById('unifiedJobRosterView');
        const viewFin = document.getElementById('unifiedEmployeeFinanceView');
        const viewOrg = document.getElementById('unifiedOrgComplianceView');

        if (tabKey === 'jobRoster') {
            if (tabBtnJob) tabBtnJob.classList.add('active');
            if (viewJob) viewJob.style.display = 'block';
        } else if (tabKey === 'employeeFinance') {
            if (tabBtnFin) tabBtnFin.classList.add('active');
            if (viewFin) viewFin.style.display = 'block';
        } else if (tabKey === 'orgCompliance') {
            if (tabBtnOrg) tabBtnOrg.classList.add('active');
            if (viewOrg) viewOrg.style.display = 'block';
        }

        if (window.lucide) window.lucide.createIcons();
    }

    /** The signed-in company (never a hard-coded demo company) */
    function activeOrgId() {
        let fromStorage = null;
        try { fromStorage = localStorage.getItem('orgId') || localStorage.getItem('current_org_id') || localStorage.getItem('tenant_id'); } catch (_) {}
        return window.KylrxActiveOrgId || fromStorage || '';
    }

    /** Saves job and roster rows through the server, which stamps the company and creates missing people */
    async function importJobRosterOnServer(rows, onProgress) {
        const auth = window.auth || (window.firebaseAuth || null);
        const user = auth && auth.currentUser;
        if (!user) throw new Error('You are signed out. Sign in again and retry.');
        const token = await user.getIdToken();
        const res = await fetch('/api/admin/job-roster/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
            body: JSON.stringify({ rows })
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok && !body.errors) throw new Error(body.message || body.error || ('Import failed (' + res.status + ')'));
        if (onProgress) onProgress(body.successCount || 0, body.totalCount || rows.length);
        return body;
    }

    /**
     * File Upload Handler for Job Roster
     */
    function handleJobRosterFileUpload(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const parser = window.KylrxJobRosterParser || window.jobRosterParser;
                if (!parser) throw new Error("jobRosterParser script is not loaded.");
                
                const result = parser.parse(e.target.result, { orgId: activeOrgId() });
                state.jobRoster.parsedResult = result;
                renderJobRosterPreview(result, file.name);
                showToast(`Parsed ${result.count} records (${result.validCount} valid).`, result.validCount > 0 ? 'success' : 'error');
            } catch (err) {
                showToast(`Job Roster Parse Error: ${err.message}`, 'error');
            }
        };
        reader.readAsArrayBuffer(file);
    }

    /**
     * File Upload Handler for Employee Finance
     */
    function handleEmployeeFinanceFileUpload(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const parser = window.KylrxEmployeeFinanceParser || window.employeeFinanceParser;
                if (!parser) throw new Error("employeeFinanceParser script is not loaded.");
                
                const result = parser.parse(e.target.result);
                state.employeeFinance.parsedResult = result;
                renderEmployeeFinancePreview(result, file.name);
                showToast(`Parsed ${result.count} finance records (${result.validCount} valid).`, result.validCount > 0 ? 'success' : 'error');
            } catch (err) {
                showToast(`Employee Finance Parse Error: ${err.message}`, 'error');
            }
        };
        reader.readAsArrayBuffer(file);
    }

    /**
     * File Upload Handler for Organization Compliance
     */
    function handleOrgComplianceFileUpload(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const parser = window.KylrxOrgComplianceParser || window.orgComplianceParser;
                if (!parser) throw new Error("orgComplianceParser script is not loaded.");
                
                const result = parser.parse(e.target.result);
                state.orgCompliance.parsedResult = result;
                renderOrgCompliancePreview(result, file.name);
                showToast(`Parsed ${result.count} compliance records (${result.validCount} valid).`, result.validCount > 0 ? 'success' : 'error');
            } catch (err) {
                showToast(`Org Compliance Parse Error: ${err.message}`, 'error');
            }
        };
        reader.readAsArrayBuffer(file);
    }

    /**
     * Renders Job Roster Preview Grid
     */
    function renderJobRosterPreview(result, fileName = 'Spreadsheet.xlsx') {
        const container = document.getElementById('jobRosterPreviewContainer');
        if (!container) return;

        container.style.display = 'block';
        document.getElementById('jobRosterFileName').textContent = fileName;
        document.getElementById('jobRosterMeta').textContent = `Total: ${result.count} | Valid: ${result.validCount} | Rejected: ${result.invalidCount}`;
        
        const tbody = document.getElementById('jobRosterTableBody');
        if (!tbody) return;

        const rows = result.data || [];
        tbody.innerHTML = rows.map((r) => {
            const statusBadge = r.isValid 
                ? `<span style="background: #dcfce7; color: #166534; padding: 4px 10px; border-radius: 9999px; font-size: 0.72rem; font-weight: 700; border: 1px solid #bbf7d0;">✓ Valid</span>`
                : `<span style="background: #fee2e2; color: #991b1b; padding: 4px 10px; border-radius: 9999px; font-size: 0.72rem; font-weight: 700; border: 1px solid #fecaca;" title="${r.errors.join('; ')}">✕ ${r.errors[0] || 'Error'}</span>`;

            return `
                <tr style="${!r.isValid ? 'background-color: #fff5f5;' : ''}">
                    <td style="font-weight: 700;">${r.rowIndex}</td>
                    <td style="font-weight: 700; font-family: monospace; color: #1d4ed8;">${r.Employee_ID || '—'}</td>
                    <td><span class="schema-pill">${r.Department_Code || '—'}</span></td>
                    <td>${r.Designation_Title || '—'}</td>
                    <td style="font-weight: 700; color: #0f172a;">₹${Number(r.Annual_CTC || 0).toLocaleString('en-IN')}</td>
                    <td><span style="font-family: monospace; font-size: 0.75rem; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">${r.Shift_Roster_Code || '—'}</span></td>
                    <td><span style="font-size: 0.75rem; color: #475569;">${r.Week_Off_Pattern}</span></td>
                    <td style="font-size: 0.75rem; color: #64748b;">${r.Custom_Week_Off_Days || '—'}</td>
                    <td style="font-size: 0.75rem;">${r.Reason_For_Update}</td>
                    <td style="text-align: center;">${statusBadge}</td>
                </tr>
            `;
        }).join('');

        if (window.lucide) window.lucide.createIcons();
    }

    /**
     * Renders Employee Finance Preview Grid
     */
    function renderEmployeeFinancePreview(result, fileName = 'Spreadsheet.xlsx') {
        const container = document.getElementById('employeeFinancePreviewContainer');
        if (!container) return;

        container.style.display = 'block';
        document.getElementById('employeeFinanceFileName').textContent = fileName;
        document.getElementById('employeeFinanceMeta').textContent = `Total: ${result.count} | Valid: ${result.validCount} | Pending Penny Drop: ${result.pendingPennyDropCount || 0}`;

        const tbody = document.getElementById('employeeFinanceTableBody');
        if (!tbody) return;

        const rows = result.data || [];
        tbody.innerHTML = rows.map((r) => {
            const statusBadge = r.isValid 
                ? `<span style="background: #dcfce7; color: #166534; padding: 4px 10px; border-radius: 9999px; font-size: 0.72rem; font-weight: 700; border: 1px solid #bbf7d0;">✓ Valid</span>`
                : `<span style="background: #fee2e2; color: #991b1b; padding: 4px 10px; border-radius: 9999px; font-size: 0.72rem; font-weight: 700; border: 1px solid #fecaca;" title="${r.errors.join('; ')}">✕ ${r.errors[0] || 'Error'}</span>`;

            const pennyDropBadge = r.Requires_Penny_Drop
                ? `<span style="background: #eff6ff; color: #1d4ed8; padding: 2px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; border: 1px solid #bfdbfe;"><i data-lucide="zap" style="width: 12px; height: 12px; display: inline-block; vertical-align: -2px;"></i> Decentro Auto</span>`
                : `<span style="color: #64748b; font-size: 0.72rem;">${r.Verification_Status}</span>`;

            return `
                <tr style="${!r.isValid ? 'background-color: #fff5f5;' : ''}">
                    <td style="font-weight: 700;">${r.rowIndex}</td>
                    <td style="font-weight: 700; font-family: monospace; color: #1d4ed8;">${r.Employee_ID || '—'}</td>
                    <td>
                        <div style="font-weight: 700; font-size: 0.85rem;">${r.Account_Holder_Name || '—'}</div>
                        <div style="font-size: 0.72rem; color: #64748b;">${r.Bank_Name} • ${r.Masked_Account_Number}</div>
                    </td>
                    <td><span style="font-family: monospace; font-size: 0.75rem; background: #f8fafc; padding: 2px 6px; border-radius: 4px; border: 1px solid #e2e8f0;">${r.Bank_IFSC_Code}</span></td>
                    <td style="font-family: monospace; font-size: 0.75rem; font-weight: 700;">${r.Masked_PAN}</td>
                    <td style="font-family: monospace; font-size: 0.75rem; color: #475569;">${r.UAN || '—'}</td>
                    <td style="font-family: monospace; font-size: 0.75rem; color: #475569;">${r.ESIC_IP_Number || '—'}</td>
                    <td style="font-family: monospace; font-size: 0.75rem; color: #475569;">${r.PRAN || '—'}</td>
                    <td><span style="font-size: 0.72rem; font-weight: 600;">${r.Primary_Disbursement_Method}</span></td>
                    <td>${pennyDropBadge}</td>
                    <td style="text-align: center;">${statusBadge}</td>
                </tr>
            `;
        }).join('');

        if (window.lucide) window.lucide.createIcons();
    }

    /**
     * Renders Organization Compliance Preview Grid
     */
    function renderOrgCompliancePreview(result, fileName = 'Spreadsheet.xlsx') {
        const container = document.getElementById('orgCompliancePreviewContainer');
        if (!container) return;

        container.style.display = 'block';
        document.getElementById('orgComplianceFileName').textContent = fileName;
        document.getElementById('orgComplianceMeta').textContent = `Total: ${result.count} | Valid: ${result.validCount} | Rejected: ${result.invalidCount}`;

        const tbody = document.getElementById('orgComplianceTableBody');
        if (!tbody) return;

        const rows = result.data || [];
        tbody.innerHTML = rows.map((r) => {
            const statusBadge = r.isValid 
                ? `<span style="background: #dcfce7; color: #166534; padding: 4px 10px; border-radius: 9999px; font-size: 0.72rem; font-weight: 700; border: 1px solid #bbf7d0;">✓ Valid</span>`
                : `<span style="background: #fee2e2; color: #991b1b; padding: 4px 10px; border-radius: 9999px; font-size: 0.72rem; font-weight: 700; border: 1px solid #fecaca;" title="${r.errors.join('; ')}">✕ ${r.errors[0] || 'Error'}</span>`;

            return `
                <tr style="${!r.isValid ? 'background-color: #fff5f5;' : ''}">
                    <td style="font-weight: 700;">${r.rowIndex}</td>
                    <td style="font-weight: 700; font-family: monospace; color: #1d4ed8;">${r.Organization_ID || '—'}</td>
                    <td style="font-weight: 700;">${r.Legal_Entity_Name || '—'}</td>
                    <td><span style="font-family: monospace; font-size: 0.75rem; background: #eff6ff; color: #1e40af; padding: 2px 6px; border-radius: 4px;">${r.EPFO_Establishment_Code}</span></td>
                    <td><span style="font-family: monospace; font-size: 0.75rem; background: #fef2f2; color: #991b1b; padding: 2px 6px; border-radius: 4px;">${r.ESIC_Employer_Code}</span></td>
                    <td style="font-size: 0.72rem; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${r.State_PT_Registrations}">${r.State_PT_Registrations || '—'}</td>
                    <td style="font-size: 0.72rem; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${r.State_LWF_Registrations}">${r.State_LWF_Registrations || '—'}</td>
                    <td style="font-family: monospace; font-size: 0.75rem; font-weight: 700;">${r.Authorized_Signatory_PAN}</td>
                    <td style="font-size: 0.75rem;">${r.Effective_From}</td>
                    <td style="text-align: center;">${statusBadge}</td>
                </tr>
            `;
        }).join('');

        if (window.lucide) window.lucide.createIcons();
    }

    /**
     * Dispatches Ingestion Batch to Cloud Firestore
     */
    async function executeIngestion(tabKey) {
        const service = window.KylrxUnifiedIngestionService || window.unifiedIngestionService;
        if (!service) {
            showToast("unifiedIngestionService is not loaded.", "error");
            return;
        }

        let dataset = null;
        let templateType = '';
        let btnConfirm = null;

        if (tabKey === 'jobRoster') {
            dataset = state.jobRoster.parsedResult;
            templateType = 'JOB_ROSTER_UPDATES';
            btnConfirm = document.getElementById('btnConfirmJobRosterIngest');
        } else if (tabKey === 'employeeFinance') {
            dataset = state.employeeFinance.parsedResult;
            templateType = 'EMPLOYEE_FINANCE_COMPLIANCE';
            btnConfirm = document.getElementById('btnConfirmEmployeeFinanceIngest');
        } else if (tabKey === 'orgCompliance') {
            dataset = state.orgCompliance.parsedResult;
            templateType = 'ORG_COMPLIANCE_REGISTRATIONS';
            btnConfirm = document.getElementById('btnConfirmOrgComplianceIngest');
        }

        if (!dataset || !dataset.validRows || dataset.validRows.length === 0) {
            showToast("No valid records to ingest. Please upload a valid spreadsheet first.", "error");
            return;
        }

        const validRows = dataset.validRows;
        if (btnConfirm) {
            btnConfirm.disabled = true;
            btnConfirm.innerHTML = `<i data-lucide="loader-2" class="spin" style="width: 16px; height: 16px; animation: spin 1s linear infinite;"></i> Ingesting ${validRows.length} Records...`;
        }

        try {
            const orgId = activeOrgId();
            if (!orgId) throw new Error('Could not find your company. Sign in again.');
            const onProgress = (current, total) => {
                if (btnConfirm) {
                    btnConfirm.innerHTML = `<i data-lucide="loader-2" style="width: 16px; height: 16px;"></i> Ingesting ${current}/${total}...`;
                }
            };
            const result = tabKey === 'jobRoster'
                ? await importJobRosterOnServer(validRows, onProgress)
                : await service.dispatchUnifiedIngestion(templateType, validRows, {
                    actorId: localStorage.getItem('user_id') || 'SUPER_ADMIN',
                    orgId,
                    onProgress
                });

            if (result.success) {
                showToast(`Successfully committed ${result.successCount} records to Cloud Firestore!`, 'success');
                if (result.pennyDropTriggerCount) {
                    showToast(`Triggered ${result.pennyDropTriggerCount} Decentro Penny Drop verifications.`, 'info');
                }
            } else {
                showToast(`Batch completed with ${result.failureCount} errors. Check error log.`, 'error');
            }
        } catch (err) {
            showToast(`Ingestion Failed: ${err.message}`, 'error');
        } finally {
            if (btnConfirm) {
                btnConfirm.disabled = false;
                btnConfirm.innerHTML = `<i data-lucide="database"></i> Ingest to Cloud Firestore`;
                if (window.lucide) window.lucide.createIcons();
            }
        }
    }

    /**
     * Initialize Drag and Drop Zones & Event Listeners
     */
    function init() {
        // Tab buttons
        const tabJob = document.getElementById('tabUnifiedJobRoster');
        const tabFin = document.getElementById('tabUnifiedEmployeeFinance');
        const tabOrg = document.getElementById('tabUnifiedOrgCompliance');

        if (tabJob) tabJob.addEventListener('click', () => switchTab('jobRoster'));
        if (tabFin) tabFin.addEventListener('click', () => switchTab('employeeFinance'));
        if (tabOrg) tabOrg.addEventListener('click', () => switchTab('orgCompliance'));

        // 1. Job Roster File Upload
        const dropZoneJob = document.getElementById('jobRosterDropZone');
        const fileInputJob = document.getElementById('jobRosterFileInput');
        if (dropZoneJob && fileInputJob) {
            dropZoneJob.addEventListener('click', () => fileInputJob.click());
            fileInputJob.addEventListener('change', (e) => {
                if (e.target.files && e.target.files[0]) handleJobRosterFileUpload(e.target.files[0]);
            });
            dropZoneJob.addEventListener('dragover', (e) => { e.preventDefault(); dropZoneJob.style.borderColor = '#3b82f6'; });
            dropZoneJob.addEventListener('dragleave', (e) => { e.preventDefault(); dropZoneJob.style.borderColor = '#e2e8f0'; });
            dropZoneJob.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZoneJob.style.borderColor = '#e2e8f0';
                if (e.dataTransfer.files && e.dataTransfer.files[0]) handleJobRosterFileUpload(e.dataTransfer.files[0]);
            });
        }

        // 2. Employee Finance File Upload
        const dropZoneFin = document.getElementById('employeeFinanceDropZone');
        const fileInputFin = document.getElementById('employeeFinanceFileInput');
        if (dropZoneFin && fileInputFin) {
            dropZoneFin.addEventListener('click', () => fileInputFin.click());
            fileInputFin.addEventListener('change', (e) => {
                if (e.target.files && e.target.files[0]) handleEmployeeFinanceFileUpload(e.target.files[0]);
            });
            dropZoneFin.addEventListener('dragover', (e) => { e.preventDefault(); dropZoneFin.style.borderColor = '#3b82f6'; });
            dropZoneFin.addEventListener('dragleave', (e) => { e.preventDefault(); dropZoneFin.style.borderColor = '#e2e8f0'; });
            dropZoneFin.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZoneFin.style.borderColor = '#e2e8f0';
                if (e.dataTransfer.files && e.dataTransfer.files[0]) handleEmployeeFinanceFileUpload(e.dataTransfer.files[0]);
            });
        }

        // 3. Organization Compliance File Upload
        const dropZoneOrg = document.getElementById('orgComplianceDropZone');
        const fileInputOrg = document.getElementById('orgComplianceFileInput');
        if (dropZoneOrg && fileInputOrg) {
            dropZoneOrg.addEventListener('click', () => fileInputOrg.click());
            fileInputOrg.addEventListener('change', (e) => {
                if (e.target.files && e.target.files[0]) handleOrgComplianceFileUpload(e.target.files[0]);
            });
            dropZoneOrg.addEventListener('dragover', (e) => { e.preventDefault(); dropZoneOrg.style.borderColor = '#3b82f6'; });
            dropZoneOrg.addEventListener('dragleave', (e) => { e.preventDefault(); dropZoneOrg.style.borderColor = '#e2e8f0'; });
            dropZoneOrg.addEventListener('drop', (e) => {
                e.preventDefault();
                dropZoneOrg.style.borderColor = '#e2e8f0';
                if (e.dataTransfer.files && e.dataTransfer.files[0]) handleOrgComplianceFileUpload(e.dataTransfer.files[0]);
            });
        }

        // Action Buttons: Ingestion Triggers
        const btnConfirmJob = document.getElementById('btnConfirmJobRosterIngest');
        if (btnConfirmJob) btnConfirmJob.addEventListener('click', () => executeIngestion('jobRoster'));

        const btnConfirmFin = document.getElementById('btnConfirmEmployeeFinanceIngest');
        if (btnConfirmFin) btnConfirmFin.addEventListener('click', () => executeIngestion('employeeFinance'));

        const btnConfirmOrg = document.getElementById('btnConfirmOrgComplianceIngest');
        if (btnConfirmOrg) btnConfirmOrg.addEventListener('click', () => executeIngestion('orgCompliance'));

        // Sample Template Download Buttons
        const btnDownloadJobTpl = document.getElementById('btnDownloadJobRosterTemplate');
        if (btnDownloadJobTpl) {
            btnDownloadJobTpl.addEventListener('click', () => {
                const parser = window.KylrxJobRosterParser || window.jobRosterParser;
                if (parser && parser.generateTemplateCSV) {
                    downloadFile(parser.generateTemplateCSV(), 'Employee_Job_and_Roster_Template.csv');
                }
            });
        }

        const btnDownloadFinTpl = document.getElementById('btnDownloadEmployeeFinanceTemplate');
        if (btnDownloadFinTpl) {
            btnDownloadFinTpl.addEventListener('click', () => {
                const parser = window.KylrxEmployeeFinanceParser || window.employeeFinanceParser;
                if (parser && parser.generateTemplateCSV) {
                    downloadFile(parser.generateTemplateCSV(), 'Employee_Finance_and_Statutory_Template.csv');
                }
            });
        }

        const btnDownloadOrgTpl = document.getElementById('btnDownloadOrgComplianceTemplate');
        if (btnDownloadOrgTpl) {
            btnDownloadOrgTpl.addEventListener('click', () => {
                const parser = window.KylrxOrgComplianceParser || window.orgComplianceParser;
                if (parser && parser.generateTemplateCSV) {
                    downloadFile(parser.generateTemplateCSV(), 'Organization_Compliance_Registrations_Template.csv');
                }
            });
        }

        // 4. Standard tabs dismiss unified views
        const standardTabIds = [
            'tabManual', 'tabBulk', 'tabBusinessUnits', 'tabCostCenters', 'tabSubDepartments',
            'tabShifts', 'tabAttendancePolicies', 'tabEmployeeTypes', 'tabEmployeeFinance',
            'tabEpfoMaster', 'tabEsicMaster', 'tabPtMaster', 'tabLwfMaster', 'tabNpsMaster',
            'tabGratuityMaster', 'tabSalaryStructure', 'tabHolidayCalendar', 'tabStatutoryCompliance',
            'tabPayrollComponents'
        ];

        standardTabIds.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.addEventListener('click', () => {
                    const unifiedTabs = ['tabUnifiedJobRoster', 'tabUnifiedEmployeeFinance', 'tabUnifiedOrgCompliance'];
                    unifiedTabs.forEach(uId => {
                        const uBtn = document.getElementById(uId);
                        if (uBtn) uBtn.classList.remove('active');
                    });
                    const unifiedViews = ['unifiedJobRosterView', 'unifiedEmployeeFinanceView', 'unifiedOrgComplianceView'];
                    unifiedViews.forEach(vId => {
                        const v = document.getElementById(vId);
                        if (v) v.style.display = 'none';
                    });
                });
            }
        });

        if (window.lucide) window.lucide.createIcons();
    }

    return {
        init,
        switchTab,
        handleJobRosterFileUpload,
        handleEmployeeFinanceFileUpload,
        handleOrgComplianceFileUpload,
        executeIngestion,
        showToast,
        state
    };
}));
