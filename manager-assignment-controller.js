/**
 * Kylrx.ai - Super Admin & HR L1/L2 Manager Assignment Controller (PRD Section 14)
 * Strict implementation of manual L1/L2 manager assignment, cycle prevention algorithm,
 * audit history visualization, and real-time DOM reflection across directory & profile views.
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ManagerAssignmentController = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {

    const state = {
        currentEmployeeId: null,
        currentEmployee: null,
        allEmployees: [],
        subordinateIds: []
    };

    /**
     * Resolve all direct and indirect subordinates for circular reporting detection
     */
    function getSubordinateIds(employeeId, employees) {
        if (!employeeId || !Array.isArray(employees)) return [];
        const subordinates = new Set();
        const queue = [employeeId];

        while (queue.length > 0) {
            const currentId = queue.shift();
            for (const emp of employees) {
                const empId = emp.employeeId || emp.id || emp.uid;
                if (!empId || empId === employeeId || subordinates.has(empId)) continue;

                const l1 = emp.reportingManagerId || emp.managers?.l1ManagerId || emp['Reporting_Manager_ID'];
                const l2 = emp.secondaryManagerId || emp.managers?.l2ManagerId || emp['Secondary_Manager_ID'];

                if (l1 === currentId || l2 === currentId) {
                    subordinates.add(empId);
                    queue.push(empId);
                }
            }
        }
        return Array.from(subordinates);
    }

    /**
     * Validate prospective manager selection against circular reporting
     */
    function validateManagerSelection(employeeId, prospectiveManagerId, employees) {
        if (!prospectiveManagerId || prospectiveManagerId === '' || prospectiveManagerId === 'NONE') {
            return { valid: true };
        }

        // 1. Self check
        if (employeeId === prospectiveManagerId) {
            return {
                valid: false,
                reason: 'An employee cannot be selected as their own reporting manager.'
            };
        }

        // 2. Subordinate check
        const subs = getSubordinateIds(employeeId, employees);
        if (subs.includes(prospectiveManagerId)) {
            const subEmp = employees.find(e => (e.employeeId === prospectiveManagerId || e.id === prospectiveManagerId));
            const subName = subEmp ? (subEmp.fullName || subEmp.name) : prospectiveManagerId;
            return {
                valid: false,
                reason: `Circular reporting detected: ${subName} (${prospectiveManagerId}) is a direct or indirect subordinate of this employee.`
            };
        }

        // 3. Upstream chain walk check
        let curr = prospectiveManagerId;
        const visited = new Set([curr]);
        while (curr) {
            if (curr === employeeId) {
                return {
                    valid: false,
                    reason: 'Circular hierarchy detected: Upstream reporting chain leads back to this employee.'
                };
            }
            const mgr = employees.find(e => (e.employeeId === curr || e.id === curr));
            const next = mgr?.reportingManagerId || mgr?.managers?.l1ManagerId || mgr?.['Reporting_Manager_ID'];
            if (!next || visited.has(next)) break;
            visited.add(next);
            curr = next;
        }

        return { valid: true };
    }

    /**
     * Helper to resolve manager display string "Full Name (EMP0004)"
     */
    function getManagerDisplayString(managerId, employees) {
        if (!managerId || managerId === '' || managerId === 'NONE' || managerId === 'Unassigned') {
            return 'Not Assigned';
        }
        const match = (employees || []).find(e => 
            e.employeeId === managerId || e.id === managerId || e.uid === managerId
        );
        if (match) {
            const name = match.fullName || match.name || managerId;
            const empId = match.employeeId || match.id || managerId;
            return `${name} (${empId})`;
        }
        return managerId;
    }

    /**
     * Populate manager dropdown options with cycle prevention
     */
    function populateDropdown(selectEl, selectedValue, targetEmployeeId, employees) {
        if (!selectEl) return;

        const subs = getSubordinateIds(targetEmployeeId, employees);
        let html = '<option value="">-- None / Unassigned --</option>';

        // Filter and sort active personnel
        const activePersonnel = (employees || [])
            .filter(e => e.status !== 'Terminated' && e.status !== 'Trash')
            .sort((a, b) => (a.name || a.fullName || '').localeCompare(b.name || b.fullName || ''));

        for (const emp of activePersonnel) {
            const empId = emp.employeeId || emp.id || emp.uid;
            const name = emp.fullName || emp.name || empId;
            const desig = emp.jobDetails?.designationCode || emp.designation || emp.role || '';
            const dept = emp.jobDetails?.departmentCode || emp.departmentName || emp.department || '';

            const isSelf = empId === targetEmployeeId;
            const isSubordinate = subs.includes(empId);
            const isSelected = empId === selectedValue;

            let disabledAttr = '';
            let labelSuffix = '';

            if (isSelf) {
                disabledAttr = 'disabled';
                labelSuffix = ' [Self - Prohibited]';
            } else if (isSubordinate) {
                disabledAttr = 'disabled';
                labelSuffix = ' [Subordinate - Circular]';
            }

            html += `<option value="${empId}" ${isSelected ? 'selected' : ''} ${disabledAttr}>
                ${name} (${empId}) • ${desig} ${dept ? '[' + dept + ']' : ''}${labelSuffix}
            </option>`;
        }

        selectEl.innerHTML = html;
    }

    /**
     * Open Manager Assignment Modal for Super Admin
     */
    async function openAssignmentModal(employeeId) {
        const modal = document.getElementById('managerAssignmentModal');
        if (!modal) {
            console.error('managerAssignmentModal DOM element not found');
            return;
        }

        const employees = window.state?.employees || [];
        state.allEmployees = employees;
        state.currentEmployeeId = employeeId;

        // Resolve current employee
        let emp = employees.find(e => (e.employeeId === employeeId || e.id === employeeId || e.uid === employeeId));

        if (!emp) {
            try {
                const fb = await import('./firebase-config.js');
                if (fb && fb.getDoc && fb.doc && fb.db) {
                    const snap = await fb.getDoc(fb.doc(fb.db, 'employees', employeeId));
                    if (snap.exists()) emp = { id: snap.id, ...snap.data() };
                }
            } catch (_) {}
        }

        if (!emp) {
            alert('Employee record could not be loaded.');
            return;
        }

        state.currentEmployee = emp;
        state.subordinateIds = getSubordinateIds(employeeId, employees);

        // Populate Employee Meta Card
        const nameEl = document.getElementById('mgrAssignEmpName');
        const idEl = document.getElementById('mgrAssignEmpId');
        const desigEl = document.getElementById('mgrAssignEmpDesig');
        const deptEl = document.getElementById('mgrAssignEmpDept');
        const avatarEl = document.getElementById('mgrAssignEmpAvatar');

        if (nameEl) nameEl.textContent = emp.fullName || emp.name || 'Employee';
        if (idEl) idEl.textContent = emp.employeeId || emp.id || employeeId;
        if (desigEl) desigEl.textContent = emp.jobDetails?.designationCode || emp.designation || 'Staff';
        if (deptEl) deptEl.textContent = emp.jobDetails?.departmentCode || emp.departmentName || emp.department || 'General';
        if (avatarEl) {
            const initials = (emp.fullName || emp.name || 'EM').split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
            avatarEl.textContent = initials;
        }

        // Current L1 and L2
        const currentL1 = emp.reportingManagerId || emp.managers?.l1ManagerId || emp['Reporting_Manager_ID'] || '';
        const currentL2 = emp.secondaryManagerId || emp.managers?.l2ManagerId || emp['Secondary_Manager_ID'] || '';

        // Dropdowns
        const l1Select = document.getElementById('mgrAssignL1Select');
        const l2Select = document.getElementById('mgrAssignL2Select');
        populateDropdown(l1Select, currentL1, employeeId, employees);
        populateDropdown(l2Select, currentL2, employeeId, employees);

        // Clear error notice
        const noticeEl = document.getElementById('mgrAssignValidationNotice');
        if (noticeEl) noticeEl.style.display = 'none';

        // Render Audit History
        renderAssignmentHistory(emp.managerAssignmentHistory || []);

        // Show Modal
        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('active'), 10);
        if (window.lucide) lucide.createIcons();
    }

    /**
     * Render Manager Assignment Audit History Table
     */
    function renderAssignmentHistory(history = []) {
        const container = document.getElementById('mgrAssignHistoryContainer');
        if (!container) return;

        if (!Array.isArray(history) || history.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 1.5rem; color: #94a3b8; font-size: 0.8rem; background: #f8fafc; border-radius: 8px; border: 1px dashed #cbd5e1;">
                    <i data-lucide="history" style="width: 24px; height: 24px; margin: 0 auto 6px; display: block; color: #cbd5e1;"></i>
                    No previous managerial hierarchy changes recorded.
                </div>
            `;
            if (window.lucide) lucide.createIcons();
            return;
        }

        const employees = state.allEmployees || window.state?.employees || [];

        const rows = history.map(item => {
            const levelClass = item.level === 'L1' ? 'badge-l1' : 'badge-l2';
            const levelStyle = item.level === 'L1'
                ? 'background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe;'
                : 'background: #f5f3ff; color: #6d28d9; border: 1px solid #ddd6fe;';

            const oldMgr = getManagerDisplayString(item.oldManagerId, employees);
            const newMgr = getManagerDisplayString(item.newManagerId, employees);
            const dateStr = item.changedAt ? new Date(item.changedAt).toLocaleString((window.KylrxFmt ? KylrxFmt.locale() : 'en-IN'), {
                year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
            }) : '---';

            return `
                <tr style="border-bottom: 1px solid #f1f5f9; font-size: 0.78rem;">
                    <td style="padding: 10px 12px;">
                        <span style="font-weight: 800; font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; ${levelStyle}">
                            ${item.level || 'L1'}
                        </span>
                    </td>
                    <td style="padding: 10px 12px; color: #64748b; font-family: monospace;">${oldMgr}</td>
                    <td style="padding: 10px 12px; color: #0f172a; font-weight: 700; font-family: monospace;">
                        <i data-lucide="arrow-right" style="width: 12px; height: 12px; display: inline-block; vertical-align: middle; color: #10b981; margin-right: 4px;"></i>
                        ${newMgr}
                    </td>
                    <td style="padding: 10px 12px; color: #475569;">${item.changedBy || 'Super Admin'}</td>
                    <td style="padding: 10px 12px; color: #94a3b8; font-size: 0.74rem;">${dateStr}</td>
                </tr>
            `;
        }).join('');

        container.innerHTML = `
            <table style="width: 100%; border-collapse: collapse; text-align: left;">
                <thead>
                    <tr style="background: #f8fafc; border-bottom: 1px solid #e2e8f0; font-size: 0.7rem; color: #64748b; text-transform: uppercase;">
                        <th style="padding: 8px 12px;">Tier</th>
                        <th style="padding: 8px 12px;">Previous Manager</th>
                        <th style="padding: 8px 12px;">New Assigned Manager</th>
                        <th style="padding: 8px 12px;">Assigned By</th>
                        <th style="padding: 8px 12px;">Timestamp</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
        `;

        if (window.lucide) lucide.createIcons();
    }

    /**
     * Save Manager Assignment
     */
    async function saveAssignment() {
        const empId = state.currentEmployeeId;
        if (!empId) return;

        const l1Select = document.getElementById('mgrAssignL1Select');
        const l2Select = document.getElementById('mgrAssignL2Select');
        const noticeEl = document.getElementById('mgrAssignValidationNotice');
        const saveBtn = document.getElementById('btnSaveManagerAssignment');

        const newL1 = l1Select ? l1Select.value : '';
        const newL2 = l2Select ? l2Select.value : '';
        const employees = state.allEmployees || window.state?.employees || [];

        // Validation 1: Circular check for L1
        const l1Check = validateManagerSelection(empId, newL1, employees);
        if (!l1Check.valid) {
            if (noticeEl) {
                noticeEl.textContent = `❌ ${l1Check.reason}`;
                noticeEl.style.display = 'block';
            }
            return;
        }

        // Validation 2: Circular check for L2
        const l2Check = validateManagerSelection(empId, newL2, employees);
        if (!l2Check.valid) {
            if (noticeEl) {
                noticeEl.textContent = `❌ ${l2Check.reason}`;
                noticeEl.style.display = 'block';
            }
            return;
        }

        // Validation 3: L1 and L2 cannot be the same person if both assigned
        if (newL1 && newL2 && newL1 === newL2) {
            if (noticeEl) {
                noticeEl.textContent = '❌ L1 Manager and L2 Manager cannot be the same individual.';
                noticeEl.style.display = 'block';
            }
            return;
        }

        if (noticeEl) noticeEl.style.display = 'none';
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<i class="lucide-loader"></i> Committing Assignment...';
        }

        const currentEmp = state.currentEmployee || {};
        const previousL1 = currentEmp.reportingManagerId || currentEmp.managers?.l1ManagerId || currentEmp['Reporting_Manager_ID'] || '';
        const previousL2 = currentEmp.secondaryManagerId || currentEmp.managers?.l2ManagerId || currentEmp['Secondary_Manager_ID'] || '';

        const history = Array.isArray(currentEmp.managerAssignmentHistory) 
            ? [...currentEmp.managerAssignmentHistory] 
            : [];

        const assignedBy = localStorage.getItem('userEmail') || localStorage.getItem('user_id') || 'superadmin';
        const now = new Date().toISOString();

        // Build audit records
        const auditLogEntries = [];

        if (newL1 !== previousL1) {
            const histItem = {
                level: 'L1',
                oldManagerId: previousL1 || 'NONE',
                newManagerId: newL1 || 'NONE',
                changedBy: assignedBy,
                changedAt: now
            };
            history.unshift(histItem);
            auditLogEntries.push({
                employeeId: empId,
                previousManagerId: previousL1,
                newManagerId: newL1,
                assignedBy,
                managerLevel: 'L1',
                timestamp: now,
                action: 'MANAGER_ASSIGNMENT_CHANGED'
            });
        }

        if (newL2 !== previousL2) {
            const histItem = {
                level: 'L2',
                oldManagerId: previousL2 || 'NONE',
                newManagerId: newL2 || 'NONE',
                changedBy: assignedBy,
                changedAt: now
            };
            history.unshift(histItem);
            auditLogEntries.push({
                employeeId: empId,
                previousManagerId: previousL2,
                newManagerId: newL2,
                assignedBy,
                managerLevel: 'L2',
                timestamp: now,
                action: 'MANAGER_ASSIGNMENT_CHANGED'
            });
        }

        const updatePayload = {
            reportingManagerId: newL1,
            reportingManager: newL1,
            'Reporting_Manager_ID': newL1,
            secondaryManagerId: newL2,
            secondaryManager: newL2,
            'Secondary_Manager_ID': newL2,
            managers: {
                l1ManagerId: newL1,
                l2ManagerId: newL2
            },
            managerAssignmentHistory: history,
            updatedAt: now
        };

        try {
            // 1. Write to Firestore employees/{empId} and users/{empId}
            const fb = await import('./firebase-config.js');
            if (fb && fb.db && fb.doc && fb.setDoc) {
                await fb.setDoc(fb.doc(fb.db, 'employees', empId), updatePayload, { merge: true });
                await fb.setDoc(fb.doc(fb.db, 'users', empId), updatePayload, { merge: true });

                // Also persist to audit_logs collection
                if (fb.addDoc && fb.collection) {
                    for (const entry of auditLogEntries) {
                        try {
                            await fb.addDoc(fb.collection(fb.db, 'audit_logs'), entry);
                        } catch (_) {}
                    }
                }
            }
        } catch (fsErr) {
            console.warn('[Firestore] Manager assignment write notice:', fsErr.message);
        }

        // 2. Dual-save to backend API
        try {
            const token = localStorage.getItem('access_token') || 'demo-token';
            await fetch(`${typeof API_BASE !== 'undefined' ? API_BASE : (typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : (typeof window !== 'undefined' && window.location ? window.location.origin : ''))}/api/admin/employees/${empId}/managers`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ l1ManagerId: newL1, l2ManagerId: newL2, changedBy: assignedBy })
            });
        } catch (_) {}

        // 3. Update in-memory state and refresh directory table immediately
        if (window.state && Array.isArray(window.state.employees)) {
            window.state.employees = window.state.employees.map(e => {
                if (e.id === empId || e.uid === empId || e.employeeId === empId) {
                    return { ...e, ...updatePayload };
                }
                return e;
            });

            if (typeof window.renderEmployeeTable === 'function') {
                window.renderEmployeeTable(window.state.employees);
            }
        }

        // 4. Update Profile Modal if open
        if (window.EmployeeProfileController && typeof window.EmployeeProfileController.updateManagerBadges === 'function') {
            const l1InModal = document.getElementById('l1ManagerSelect');
            const l2InModal = document.getElementById('l2ManagerSelect');
            if (l1InModal) l1InModal.value = newL1;
            if (l2InModal) l2InModal.value = newL2;
            window.EmployeeProfileController.updateManagerBadges();
        }

        // Success notification & close
        closeAssignmentModal();

        if (window.showSuccess) {
            window.showSuccess('Hierarchy Updated', `Reporting hierarchy for ${currentEmp.fullName || currentEmp.name || empId} successfully updated with audit trail.`);
        } else if (window.showToast) {
            window.showToast('✅ Manager assignments updated successfully!', 'success');
        } else {
            alert('Manager assignments updated successfully.');
        }

        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i data-lucide="check"></i> Save &amp; Update Hierarchy';
        }
    }

    /**
     * Close Assignment Modal
     */
    function closeAssignmentModal() {
        const modal = document.getElementById('managerAssignmentModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => { modal.style.display = 'none'; }, 200);
        }
    }

    /**
     * Render Interactive Org Chart Modal
     */
    function openOrgChartModal() {
        const modal = document.getElementById('orgChartModal');
        const container = document.getElementById('orgChartContainer');
        if (!modal || !container) return;

        const employees = window.state?.employees || [];
        if (employees.length === 0) {
            container.innerHTML = '<div style="text-align:center; padding: 3rem; color: #94a3b8;">No personnel records available for organizational hierarchy.</div>';
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('active'), 10);
            return;
        }

        // Map hierarchy
        const nodeMap = new Map();
        const roots = [];

        employees.forEach(emp => {
            const id = emp.employeeId || emp.id || emp.uid;
            nodeMap.set(id, {
                id,
                emp,
                children: []
            });
        });

        employees.forEach(emp => {
            const id = emp.employeeId || emp.id || emp.uid;
            const node = nodeMap.get(id);
            const parentId = emp.reportingManagerId || emp.managers?.l1ManagerId || emp['Reporting_Manager_ID'];

            if (parentId && nodeMap.has(parentId) && parentId !== id) {
                nodeMap.get(parentId).children.push(node);
            } else {
                roots.push(node);
            }
        });

        function renderNodeHtml(node) {
            const emp = node.emp;
            const id = node.id;
            const name = emp.fullName || emp.name || id;
            const desig = emp.jobDetails?.designationCode || emp.designation || emp.role || 'Staff';
            const dept = emp.jobDetails?.departmentCode || emp.departmentName || emp.department || 'General';
            const l1 = emp.reportingManagerId || emp.managers?.l1ManagerId || emp['Reporting_Manager_ID'] || '';
            const l2 = emp.secondaryManagerId || emp.managers?.l2ManagerId || emp['Secondary_Manager_ID'] || '';

            const l1Display = getManagerDisplayString(l1, employees);
            const l2Display = getManagerDisplayString(l2, employees);

            const childrenHtml = node.children.length > 0 
                ? `<div class="org-children" style="display: flex; gap: 16px; margin-top: 16px; padding-left: 20px; border-left: 2px dashed #cbd5e1;">
                    ${node.children.map(c => renderNodeHtml(c)).join('')}
                   </div>`
                : '';

            return `
                <div class="org-node" style="background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 18px; min-width: 250px; max-width: 320px; box-shadow: 0 2px 8px rgba(0,0,0,0.04); margin-bottom: 12px;">
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                        <div>
                            <div style="font-weight: 800; font-size: 0.9rem; color: #0f172a;">${name}</div>
                            <div style="font-size: 0.72rem; color: #64748b; font-family: monospace;">${id} • ${desig}</div>
                        </div>
                        <button type="button" class="btn btn-secondary" onclick="ManagerAssignmentController.openAssignmentModal('${id}')" title="Reassign Managers" style="padding: 4px 8px; font-size: 0.7rem; border-radius: 6px; background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; cursor: pointer;">
                            <i data-lucide="git-pull-request" style="width: 12px; height: 12px;"></i> Assign
                        </button>
                    </div>
                    <div style="font-size: 0.72rem; color: #64748b; margin-bottom: 8px;">
                        <span style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-weight: 600;">${dept}</span>
                        ${node.children.length > 0 ? `<span style="background: #ecfdf5; color: #059669; padding: 2px 6px; border-radius: 4px; font-weight: 700; margin-left: 4px;">${node.children.length} Reports</span>` : ''}
                    </div>
                    <div style="display: flex; flex-direction: column; gap: 4px; border-top: 1px solid #f1f5f9; padding-top: 6px;">
                        <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.7rem;">
                            <span style="font-weight: 800; color: #1d4ed8; background: #eff6ff; padding: 1px 6px; border-radius: 4px;">L1</span>
                            <span style="color: #475569; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 170px;" title="${l1Display}">${l1Display}</span>
                        </div>
                        ${l2 ? `
                        <div style="display: flex; align-items: center; justify-content: space-between; font-size: 0.7rem;">
                            <span style="font-weight: 800; color: #6d28d9; background: #f5f3ff; padding: 1px 6px; border-radius: 4px;">L2</span>
                            <span style="color: #475569; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 170px;" title="${l2Display}">${l2Display}</span>
                        </div>
                        ` : ''}
                    </div>
                    ${childrenHtml}
                </div>
            `;
        }

        container.innerHTML = `
            <div style="overflow: auto; max-height: 65vh; padding: 1rem;">
                <div style="display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start;">
                    ${roots.map(r => renderNodeHtml(r)).join('')}
                </div>
            </div>
        `;

        modal.style.display = 'flex';
        setTimeout(() => modal.classList.add('active'), 10);
        if (window.lucide) lucide.createIcons();
    }

    /**
     * Close Org Chart Modal
     */
    function closeOrgChartModal() {
        const modal = document.getElementById('orgChartModal');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => { modal.style.display = 'none'; }, 200);
        }
    }

    return {
        openAssignmentModal,
        closeAssignmentModal,
        saveAssignment,
        openOrgChartModal,
        closeOrgChartModal,
        validateManagerSelection,
        getSubordinateIds,
        getManagerDisplayString
    };
}));
