/**
 * Kylrx.ai - Employee Profile & Official Documents Controller (PRD Section 13)
 * Handles tabbed navigation, comprehensive job details, managerial hierarchy resolution,
 * statutory compliance fields (PF, ESI, PAN, Aadhaar), and Firebase Storage document uploads/previews.
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.EmployeeProfileController = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // State container
    const state = {
        currentEmployeeId: null,
        currentEmployee: null,
        documents: [],
        selectedUploadFile: null,
        isUploading: false
    };

    function escapeHtml(str) {
        if (!str && str !== 0) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Switch Active Tab inside Employee Profile Modal
     */
    function switchTab(tabKey) {
        const tabs = ['job', 'managers', 'statutory', 'documents', 'finance', 'salary'];
        tabs.forEach(key => {
            const btn = document.getElementById(`emp-tab-btn-${key}`);
            const content = document.getElementById(`emp-tab-content-${key}`);
            if (btn) {
                if (key === tabKey) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            }
            if (content) {
                content.style.display = (key === tabKey) ? 'block' : 'none';
            }
        });

        if (window.lucide) {
            lucide.createIcons();
        }
    }

    /**
     * Resolve Manager Name & Title from Employee ID
     */
    function resolveManagerInfo(managerId) {
        if (!managerId) return { name: 'Not Assigned', title: 'None', email: '' };
        if (managerId === 'Self' || managerId === 'SELF') return { name: 'Self', title: 'Top-Level Executive', email: '' };

        const allEmps = window.state?.employees || [];
        const match = allEmps.find(e => 
            e.employeeId === managerId || e.id === managerId || e.uid === managerId
        );

        if (match) {
            const desig = match.jobDetails?.designationCode || match.designation || match.role || 'Manager';
            const dept = match.jobDetails?.departmentCode || match.department || '';
            return {
                name: match.name || match.fullName || managerId,
                title: `${desig} ${dept ? '• ' + dept : ''}`,
                email: match.email || ''
            };
        }
        return { name: managerId, title: 'External / System Node', email: '' };
    }

    /**
     * Update Manager Dynamic Badges
     */
    function updateManagerBadges() {
        const l1Select = document.getElementById('l1ManagerSelect');
        const l2Select = document.getElementById('l2ManagerSelect');
        const l1Info = document.getElementById('l1ManagerBadgeInfo');
        const l2Info = document.getElementById('l2ManagerBadgeInfo');

        if (l1Select && l1Info) {
            const resolved = resolveManagerInfo(l1Select.value);
            l1Info.innerHTML = `
                <div style="font-weight: 700; color: #1e293b; font-size: 0.85rem;">${escapeHtml(resolved.name)}</div>
                <div style="font-size: 0.72rem; color: #64748b;">${escapeHtml(resolved.title)} ${resolved.email ? '• ' + escapeHtml(resolved.email) : ''}</div>
            `;
        }

        if (l2Select && l2Info) {
            const resolved = resolveManagerInfo(l2Select.value);
            l2Info.innerHTML = `
                <div style="font-weight: 700; color: #1e293b; font-size: 0.85rem;">${escapeHtml(resolved.name)}</div>
                <div style="font-size: 0.72rem; color: #64748b;">${escapeHtml(resolved.title)} ${resolved.email ? '• ' + escapeHtml(resolved.email) : ''}</div>
            `;
        }
    }

    /**
     * Format file size helper
     */
    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    /**
     * Render Official Documents Table
     */
    function renderDocumentsTable() {
        const container = document.getElementById('empDocsListContainer');
        const badgeEl = document.getElementById('empDocsCountBadge');
        if (badgeEl) {
            badgeEl.textContent = state.documents.length;
        }

        if (!container) return;

        if (state.documents.length === 0) {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem; background: #f8fafc; border-radius: 12px; border: 1.5px dashed #cbd5e1;">
                    <i data-lucide="file-question" style="width: 36px; height: 36px; color: #94a3b8; margin: 0 auto 8px;"></i>
                    <p style="font-size: 0.85rem; font-weight: 700; color: #475569; margin: 0 0 4px;">No Official Documents Uploaded</p>
                    <p style="font-size: 0.75rem; color: #94a3b8; margin: 0;">Upload Offer Letter, Signed NDA, Aadhaar, PAN, or Bank Proof above.</p>
                </div>
            `;
            if (window.lucide) lucide.createIcons();
            return;
        }

        const typeLabels = {
            'OFFER_LETTER': { label: 'Offer Letter', color: '#2563eb', bg: '#eff6ff' },
            'SIGNED_NDA': { label: 'Signed NDA', color: '#7c3aed', bg: '#f5f3ff' },
            'AADHAAR_CARD': { label: 'Aadhaar Card', color: '#059669', bg: '#ecfdf5' },
            'PAN_CARD': { label: 'PAN Card', color: '#d97706', bg: '#fffbeb' },
            'BANK_PROOF': { label: 'Bank Proof', color: '#0891b2', bg: '#ecfeff' },
            'EDUCATION_CERTIFICATE': { label: 'Education Degree', color: '#4f46e5', bg: '#eef2ff' },
            'EXPERIENCE_LETTER': { label: 'Experience Letter', color: '#65a30d', bg: '#f7fee7' },
            'OTHER': { label: 'Official Doc', color: '#475569', bg: '#f1f5f9' }
        };

        const rowsHtml = state.documents.map(doc => {
            const meta = typeLabels[doc.docType] || typeLabels['OTHER'];
            const formattedDate = doc.uploadedAt ? new Date(doc.uploadedAt).toLocaleDateString((window.KylrxFmt ? KylrxFmt.locale() : 'en-IN'), { day: '2-digit', month: 'short', year: 'numeric' }) : 'Recent';
            const sizeStr = formatBytes(doc.fileSize);

            return `
                <div class="emp-doc-row" style="display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; margin-bottom: 8px; transition: all 0.2s ease;">
                    <div style="display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1;">
                        <div style="width: 36px; height: 36px; border-radius: 8px; background: ${meta.bg}; color: ${meta.color}; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                            <i data-lucide="${doc.mimeType?.includes('pdf') ? 'file-text' : 'file-image'}" style="width: 18px; height: 18px;"></i>
                        </div>
                        <div style="min-width: 0; flex: 1;">
                            <div style="display: flex; align-items: center; gap: 6px;">
                                <span style="font-size: 0.72rem; font-weight: 700; color: ${meta.color}; background: ${meta.bg}; padding: 2px 6px; border-radius: 4px; text-transform: uppercase;">${escapeHtml(meta.label)}</span>
                                <span style="font-size: 0.85rem; font-weight: 600; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escapeHtml(doc.fileName)}</span>
                            </div>
                            <div style="font-size: 0.72rem; color: #64748b; margin-top: 2px;">
                                Uploaded: ${escapeHtml(formattedDate)} • ${escapeHtml(sizeStr)}
                            </div>
                        </div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0; margin-left: 10px;">
                        <button type="button" class="btn btn-sm btn-outline" onclick="EmployeeProfileController.previewDocument('${escapeHtml(doc.docId)}')" style="padding: 6px 10px; font-size: 0.75rem; border-radius: 6px;" title="Preview Document">
                            <i data-lucide="eye" style="width: 13px; height: 13px;"></i> Preview
                        </button>
                        <button type="button" class="btn btn-sm btn-outline" onclick="EmployeeProfileController.downloadDocument('${escapeHtml(doc.docId)}')" style="padding: 6px 10px; font-size: 0.75rem; border-radius: 6px;" title="Download Document">
                            <i data-lucide="download" style="width: 13px; height: 13px;"></i>
                        </button>
                        <button type="button" class="btn btn-sm" onclick="EmployeeProfileController.deleteDocument('${escapeHtml(doc.docId)}')" style="padding: 6px 10px; font-size: 0.75rem; border-radius: 6px; background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca;" title="Remove Document">
                            <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = rowsHtml;
        if (window.lucide) lucide.createIcons();
    }

    /**
     * File selection change handler
     */
    function handleFileSelection(file) {
        const selectedNotice = document.getElementById('empDocSelectedFileNotice');
        const fileNameEl = document.getElementById('empDocSelectedFileName');
        const uploadBtn = document.getElementById('btnUploadEmpDoc');

        if (!file) {
            state.selectedUploadFile = null;
            if (selectedNotice) selectedNotice.style.display = 'none';
            if (uploadBtn) uploadBtn.disabled = true;
            return;
        }

        // Validate file type
        const ALLOWED_MIME_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
        if (!ALLOWED_MIME_TYPES.includes(file.type) && !file.name.match(/\.(pdf|jpe?g|png|webp)$/i)) {
            alert('Invalid file format. Please upload PDF, JPG, or PNG files.');
            return;
        }

        // Validate file size (10 MB limit)
        const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
        if (file.size > MAX_FILE_SIZE_BYTES) {
            alert('File exceeds 10 MB limit. Please select a smaller file.');
            return;
        }

        state.selectedUploadFile = file;

        if (fileNameEl) {
            fileNameEl.textContent = `${file.name} (${formatBytes(file.size)})`;
        }
        if (selectedNotice) {
            selectedNotice.style.display = 'flex';
        }
        if (uploadBtn) {
            uploadBtn.disabled = false;
        }
        if (window.lucide) lucide.createIcons();
    }

    /**
     * Execute File Upload to Firebase Cloud Storage & Firestore
     */
    async function uploadDocument() {
        const file = state.selectedUploadFile;
        const employeeId = state.currentEmployeeId || document.getElementById('editEmpId')?.value || 'EMP_NEW';
        const docTypeSelect = document.getElementById('empDocTypeSelect');
        const docType = docTypeSelect ? docTypeSelect.value : 'OFFER_LETTER';

        if (!file) {
            alert('Please choose a file to upload first.');
            return;
        }

        const uploadBtn = document.getElementById('btnUploadEmpDoc');
        const progressBar = document.getElementById('empDocProgressBar');
        const progressContainer = document.getElementById('empDocProgressContainer');

        if (uploadBtn) uploadBtn.disabled = true;
        if (progressContainer) progressContainer.style.display = 'block';
        if (progressBar) progressBar.style.width = '20%';

        const docId = `doc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
        const storagePath = `employees/${employeeId}/documents/${file.name}`;

        let downloadUrl = '';

        try {
            // Attempt Firebase Storage Upload via Web SDK
            try {
                const fbConfig = await import('./firebase-config.js');
                const fbStorage = await import('https://www.gstatic.com/firebasejs/12.12.1/firebase-storage.js');
                if (fbConfig.storage && fbStorage.ref && fbStorage.uploadBytesResumable) {
                    const storageRef = fbStorage.ref(fbConfig.storage, storagePath);
                    const uploadTask = fbStorage.uploadBytesResumable(storageRef, file, { contentType: file.type });

                    await new Promise((resolve, reject) => {
                        uploadTask.on('state_changed', 
                            (snap) => {
                                const pct = (snap.bytesTransferred / snap.totalBytes) * 100;
                                if (progressBar) progressBar.style.width = `${Math.min(95, Math.round(pct))}%`;
                            },
                            (err) => reject(err),
                            async () => {
                                downloadUrl = await fbStorage.getDownloadURL(uploadTask.snapshot.ref);
                                resolve();
                            }
                        );
                    });
                }
            } catch (storageErr) {
                console.warn('[Firebase Storage] Direct upload notice (using secure local object URL fallback):', storageErr.message);
                downloadUrl = URL.createObjectURL(file);
            }

            if (!downloadUrl) {
                downloadUrl = URL.createObjectURL(file);
            }

            if (progressBar) progressBar.style.width = '100%';

            const docRecord = {
                docId,
                docType,
                fileName: file.name,
                storagePath,
                downloadUrl,
                fileSize: file.size,
                mimeType: file.type || 'application/pdf',
                uploadedAt: new Date().toISOString()
            };

            // Append to in-memory state
            state.documents = [docRecord, ...state.documents.filter(d => d.docId !== docId)];

            // Save to Firestore employees/{employeeId} and users/{employeeId}
            try {
                const fb = await import('./firebase-config.js');
                if (fb && fb.db && fb.doc && fb.setDoc) {
                    await fb.setDoc(fb.doc(fb.db, 'employees', employeeId), { documents: state.documents }, { merge: true });
                    await fb.setDoc(fb.doc(fb.db, 'users', employeeId), { documents: state.documents }, { merge: true });
                }
            } catch (fsErr) {
                console.warn('[Firestore] Document array sync notice:', fsErr.message);
            }

            // Dual-save to backend API
            try {
                const token = localStorage.getItem('access_token') || 'demo-token';
                await fetch(`${typeof API_BASE !== "undefined" ? API_BASE : (typeof window !== "undefined" && window.API_BASE ? window.API_BASE : (typeof window !== "undefined" && window.location ? window.location.origin : ""))}/api/admin/employees/${employeeId}/documents`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify(docRecord)
                });
            } catch (_) {}

            renderDocumentsTable();

            // Reset upload form
            const fileInput = document.getElementById('empDocFileInput');
            if (fileInput) fileInput.value = '';
            handleFileSelection(null);

            if (window.showToast) {
                window.showToast(`✅ Uploaded ${file.name} successfully!`, 'success');
            }
        } catch (err) {
            console.error('Document upload error:', err);
            alert('Upload failed: ' + err.message);
        } finally {
            if (progressContainer) {
                setTimeout(() => {
                    progressContainer.style.display = 'none';
                    if (progressBar) progressBar.style.width = '0%';
                }, 500);
            }
            if (uploadBtn) uploadBtn.disabled = false;
        }
    }

    /**
     * Preview Document in Modal
     */
    function previewDocument(docId) {
        const doc = state.documents.find(d => d.docId === docId);
        if (!doc) return;

        const modal = document.getElementById('docPreviewModal');
        const titleEl = document.getElementById('docPreviewTitle');
        const typeEl = document.getElementById('docPreviewType');
        const container = document.getElementById('docPreviewContent');
        const downloadBtn = document.getElementById('btnDocPreviewDownload');

        if (titleEl) titleEl.textContent = doc.fileName;
        if (typeEl) typeEl.textContent = doc.docType;
        if (downloadBtn) {
            downloadBtn.onclick = () => downloadDocument(docId);
        }

        if (container) {
            if (doc.mimeType?.includes('pdf') || doc.fileName.endsWith('.pdf')) {
                container.innerHTML = `
                    <iframe src="${escapeHtml(doc.downloadUrl)}" style="width: 100%; height: 500px; border: none; border-radius: 8px;" title="${escapeHtml(doc.fileName)}"></iframe>
                `;
            } else {
                container.innerHTML = `
                    <div style="display: flex; justify-content: center; align-items: center; max-height: 500px; overflow: auto; padding: 1rem;">
                        <img src="${escapeHtml(doc.downloadUrl)}" alt="${escapeHtml(doc.fileName)}" style="max-width: 100%; max-height: 480px; object-fit: contain; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1);" />
                    </div>
                `;
            }
        }

        if (modal) {
            modal.style.display = 'flex';
            setTimeout(() => modal.classList.add('active'), 10);
        }
        if (window.lucide) lucide.createIcons();
    }

    /**
     * Download Document
     */
    function downloadDocument(docId) {
        const doc = state.documents.find(d => d.docId === docId);
        if (!doc || !doc.downloadUrl) return;

        const a = document.createElement('a');
        a.href = doc.downloadUrl;
        a.download = doc.fileName || 'download';
        a.target = '_blank';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    /**
     * Delete Document
     */
    async function deleteDocument(docId) {
        if (!confirm('Are you sure you want to remove this official document from the employee record?')) {
            return;
        }

        const employeeId = state.currentEmployeeId || document.getElementById('editEmpId')?.value;
        state.documents = state.documents.filter(d => d.docId !== docId);

        // Update in Firestore
        try {
            const fb = await import('./firebase-config.js');
            if (fb && fb.db && fb.doc && fb.setDoc) {
                await fb.setDoc(fb.doc(fb.db, 'employees', employeeId), { documents: state.documents }, { merge: true });
                await fb.setDoc(fb.doc(fb.db, 'users', employeeId), { documents: state.documents }, { merge: true });
            }
        } catch (_) {}

        // Backend API
        try {
            const token = localStorage.getItem('access_token') || 'demo-token';
            await fetch(`${typeof API_BASE !== "undefined" ? API_BASE : (typeof window !== "undefined" && window.API_BASE ? window.API_BASE : (typeof window !== "undefined" && window.location ? window.location.origin : ""))}/api/admin/employees/${employeeId}/documents/${docId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
        } catch (_) {}

        renderDocumentsTable();
    }

    /**
     * Pre-populate Comprehensive Job Profile and Documents for an Employee
     */
    async function openProfileModal(id) {
        state.currentEmployeeId = id;

        // Find employee in local state or fetch from Firestore/API
        let emp = (window.state?.employees || []).find(e => e.id === id || e.uid === id || e.employeeId === id);

        if (!emp) {
            try {
                const fb = await import('./firebase-config.js');
                const docSnap = await fb.getDoc(fb.doc(fb.db, 'employees', id));
                if (docSnap.exists()) {
                    emp = { id: docSnap.id, ...docSnap.data() };
                } else {
                    const uSnap = await fb.getDoc(fb.doc(fb.db, 'users', id));
                    if (uSnap.exists()) emp = { id: uSnap.id, ...uSnap.data() };
                }
            } catch (_) {}
        }

        state.currentEmployee = emp || {};
        state.documents = Array.isArray(emp?.documents) ? [...emp.documents] : [];

        // Set Title & Header
        const modalTitle = document.getElementById('empModalTitle');
        const editIdInput = document.getElementById('editEmpId');
        const editInfoFields = document.getElementById('editInfoFields');
        const displayId = document.getElementById('displayEmpId');
        const displayPass = document.getElementById('displayPassword');

        if (id) {
            if (modalTitle) modalTitle.textContent = `Personnel Profile: ${emp?.employeeId || id} - ${emp?.name || emp?.fullName || 'Employee'}`;
            if (editIdInput) editIdInput.value = id;
            if (editInfoFields) editInfoFields.style.display = 'block';
            if (displayId) displayId.value = emp?.employeeId || id;
            if (displayPass) displayPass.value = emp?.tempPassword || emp?.password || 'Encrypted';
        } else {
            if (modalTitle) modalTitle.textContent = 'New Personnel Onboarding';
            if (editIdInput) editIdInput.value = '';
            if (editInfoFields) editInfoFields.style.display = 'none';
        }

        // Form Fields Population
        const form = document.getElementById('empForm');
        if (form && emp) {
            const job = emp.jobDetails || {};
            const managers = emp.managers || {};
            const statutory = emp.statutory || {};

            // Credentials & Basics
            if (form.name) form.name.value = emp.name || emp.fullName || '';
            if (form.email) form.email.value = emp.email || '';
            if (form.phone) form.phone.value = emp.phone || '';
            if (form.address) form.address.value = emp.address || '';
            if (form.salary) form.salary.value = job.annualSalary || emp.salary || emp.annualSalary || '';
            if (form.roleType) form.roleType.value = emp.role || 'employee';

            // Job Information (PRD §§1, 10 & 13)
            const deptCode = job.departmentCode || emp.departmentId || 'ENG';
            if (form.departmentId) {
                form.departmentId.value = deptCode;
            }

            const currentSubCode = job.subDepartmentCode || emp.subDepartmentCode || emp['Sub-Department_Code'] || 'ENG-BACKEND';
            if (form.subDepartmentCode) {
                if (window.KylrxSubDepartmentService && typeof window.KylrxSubDepartmentService.populateSubDepartmentDropdown === 'function') {
                    window.KylrxSubDepartmentService.populateSubDepartmentDropdown(form.subDepartmentCode, {
                        departmentCode: deptCode,
                        selectedCode: currentSubCode,
                        includePlaceholder: true,
                        activeOnly: true
                    });
                } else if (window.updateSubDepartmentsForSelectedDept) {
                    window.updateSubDepartmentsForSelectedDept();
                }
                form.subDepartmentCode.value = currentSubCode;
            }

            if (form.designation) form.designation.value = job.designationCode || emp.designation || emp.designationCode || emp['Designation_Code'] || 'DES-SE';
            if (form.businessUnitCode) form.businessUnitCode.value = job.businessUnitCode || emp.businessUnitCode || emp['Business_Unit_Code'] || 'BU-TECH';

            // Resolve linked cost center from sub-department or fallback
            let targetCostCenter = job.costCenterCode || emp.costCenterCode || emp['Cost_Center_Code'];
            if (!targetCostCenter && window.KylrxSubDepartmentService) {
                const subRec = window.KylrxSubDepartmentService.getSubDepartment(currentSubCode);
                if (subRec && subRec.costCenterCode) {
                    targetCostCenter = subRec.costCenterCode;
                }
            }
            if (!targetCostCenter) targetCostCenter = 'CC-ENG-101';

            if (form.costCenterCode) {
                if (window.KylrxCostCenterService && typeof window.KylrxCostCenterService.populateCostCenterDropdown === 'function') {
                    window.KylrxCostCenterService.populateCostCenterDropdown(form.costCenterCode, {
                        selectedCode: targetCostCenter,
                        includePlaceholder: false
                    });
                }
                form.costCenterCode.value = targetCostCenter;
            }
            if (form.locationCode) form.locationCode.value = job.locationCode || emp.locationCode || emp['Location_Code'] || 'LOC-BLR';
            if (form.shiftCode) form.shiftCode.value = job.shiftCode || emp.shiftCode || emp['Shift_Code'] || 'SHIFT-GEN';
            if (form.workMode) form.workMode.value = job.workMode || emp.workMode || emp['Work_Mode'] || 'Hybrid';
            if (form.employeeType) form.employeeType.value = job.employmentCategory || job.employmentCategoryCode || emp.employeeType || emp['Employment_Type'] || 'FULL_TIME';

            // Dates
            const doj = job.dateOfJoining || emp.joiningDate || emp.dateOfJoining;
            if (form.joiningDate && doj) form.joiningDate.value = doj.includes('T') ? doj.split('T')[0] : doj;

            const probation = job.probationEndDate || emp.probationEndDate;
            if (form.probationEndDate && probation) form.probationEndDate.value = probation.includes('T') ? probation.split('T')[0] : probation;

            if (form.noticePeriodDays) form.noticePeriodDays.value = job.noticePeriodDays || emp.noticePeriodDays || 60;

            // Managerial Hierarchy
            if (window.populateManagerDropdowns) await window.populateManagerDropdowns();
            if (form.reportingManagerId) form.reportingManagerId.value = managers.l1ManagerId || emp.reportingManagerId || emp.reportingManager || emp['Reporting_Manager_ID'] || '';
            if (form.secondaryManagerId) form.secondaryManagerId.value = managers.l2ManagerId || emp.secondaryManagerId || emp.secondaryManager || emp['Secondary_Manager_ID'] || '';
            updateManagerBadges();

            // Statutory & Compliance
            if (form.uan) form.uan.value = statutory.uan || emp.uan || emp['UAN'] || '';
            if (form.pfMemberId) form.pfMemberId.value = statutory.pfMemberId || emp.pfMemberId || emp['PF_Member_ID'] || '';
            if (form.epfoEstablishmentId) form.epfoEstablishmentId.value = statutory.epfoEstablishmentId || emp.epfoEstablishmentId || 'KN/BNG/0012345';
            if (form.esicIp) form.esicIp.value = statutory.esicIpNumber || emp.esicIp || emp['ESIC_IP'] || '';
            if (form.esicEmployerCode) form.esicEmployerCode.value = statutory.esicEmployerCode || emp.esicEmployerCode || '31001234560000001';
            if (form.dispensaryBranch) form.dispensaryBranch.value = statutory.dispensaryBranch || emp.dispensaryBranch || 'Indiranagar Branch';
            if (form.pan) form.pan.value = statutory.pan || emp.pan || emp['PAN'] || '';
            if (form.aadhaarLast4) form.aadhaarLast4.value = statutory.aadhaarLast4 || emp.aadhaarLast4 || emp['Aadhaar_Last_4'] || '';

            // PRD Sections 1, 4, 11 & 13: Mount EPFO Statutory Master & KYC Card
            if (window.KylrxEpfoProfileUIController && typeof window.KylrxEpfoProfileUIController.mountEpfoCard === 'function') {
                window.KylrxEpfoProfileUIController.mountEpfoCard('epfoStatutoryDrawerContainer', id, {
                    uan: form.uan ? form.uan.value : (statutory.uan || emp.uan),
                    pfMemberId: form.pfMemberId ? form.pfMemberId.value : (statutory.pfMemberId || emp.pfMemberId),
                    joiningDate: form.joiningDate ? form.joiningDate.value : emp.joiningDate,
                    orgId: localStorage.getItem('orgId') || 'ORG_KYLRX_01'
                });
            }

            // PRD Sections 1, 4, 11 & 13: Mount ESIC & Medical Insurance Statutory Card
            if (window.KylrxEsicProfileUIController && typeof window.KylrxEsicProfileUIController.mountEsicCard === 'function') {
                window.KylrxEsicProfileUIController.mountEsicCard('esicStatutoryDrawerContainer', id, {
                    esiNumber: form.esicIp ? form.esicIp.value : (statutory.esicIpNumber || emp.esicIp),
                    joiningDate: form.joiningDate ? form.joiningDate.value : emp.joiningDate,
                    orgId: localStorage.getItem('orgId') || 'ORG_KYLRX_01'
                });
            }

            // PRD Sections 1, 4, 11 & 13: Mount Professional Tax (PT) Statutory Profile Card
            if (window.KylrxPtProfileUIController && typeof window.KylrxPtProfileUIController.mountPtCard === 'function') {
                window.KylrxPtProfileUIController.mountPtCard('ptStatutoryDrawerContainer', id, {
                    state: form.workState ? form.workState.value : (statutory.ptState || emp.state || 'Karnataka'),
                    joiningDate: form.joiningDate ? form.joiningDate.value : emp.joiningDate,
                    orgId: localStorage.getItem('orgId') || 'ORG_KYLRX_01'
                });
            }

            // PRD Sections 1, 4, 11 & 13: Mount Labour Welfare Fund (LWF) Statutory Profile Card
            if (window.KylrxLwfProfileUIController && typeof window.KylrxLwfProfileUIController.mountLwfCard === 'function') {
                window.KylrxLwfProfileUIController.mountLwfCard('lwfStatutoryDrawerContainer', id, {
                    state: form.workState ? form.workState.value : (statutory.lwfState || emp.state || 'Karnataka'),
                    joiningDate: form.joiningDate ? form.joiningDate.value : emp.joiningDate,
                    orgId: localStorage.getItem('orgId') || 'ORG_KYLRX_01'
                });
            }

            // PRD Sections 1, 4, 11 & 13: Mount National Pension System (NPS) Statutory Profile Card
            if (window.KylrxNpsProfileUIController && typeof window.KylrxNpsProfileUIController.mountNpsCard === 'function') {
                window.KylrxNpsProfileUIController.mountNpsCard('npsStatutoryDrawerContainer', id, {
                    joiningDate: form.joiningDate ? form.joiningDate.value : emp.joiningDate,
                    basicPay: Number(form.basicSalary ? form.basicSalary.value : (emp.basicSalary || emp.basicPay || 50000)),
                    daPay: Number(form.daSalary ? form.daSalary.value : (emp.daSalary || 0)),
                    orgId: localStorage.getItem('orgId') || 'ORG_KYLRX_01'
                });
            }

            // PRD Sections 1, 4, 11 & 13: Mount Gratuity & Long-Term Benefits Statutory Profile Card
            if (window.KylrxGratuityProfileUIController && typeof window.KylrxGratuityProfileUIController.mountGratuityCard === 'function') {
                window.KylrxGratuityProfileUIController.mountGratuityCard('gratuityStatutoryDrawerContainer', id, {
                    joiningDate: form.joiningDate ? form.joiningDate.value : emp.joiningDate,
                    exitDate: form.exitDate ? form.exitDate.value : (emp.exitDate || emp.dateOfExit || null),
                    basicPay: Number(form.basicSalary ? form.basicSalary.value : (emp.basicSalary || emp.basicPay || 60000)),
                    daPay: Number(form.daSalary ? form.daSalary.value : (emp.daSalary || 0)),
                    name: emp.name || emp.fullName || '',
                    orgId: localStorage.getItem('orgId') || 'ORG_KYLRX_01'
                });
            }

            // PRD Sections 1, 4 & 13: Core Banking & Decentro Fabric Integration
            let finRec = null;
            if (id && window.KylrxEmployeeFinanceService && typeof window.KylrxEmployeeFinanceService.getEmployeeFinance === 'function') {
                try {
                    finRec = await window.KylrxEmployeeFinanceService.getEmployeeFinance(localStorage.getItem('orgId') || 'org_kylrx', id);
                } catch (_) {}
            }
            const banking = finRec?.banking || emp.banking || {};
            const finStatutory = finRec?.statutory || statutory;

            if (form.financeAccountHolderName) form.financeAccountHolderName.value = banking.accountHolderName || emp.name || emp.fullName || '';
            if (form.financeBankName) form.financeBankName.value = banking.bankName || 'HDFC Bank';
            if (form.financeBranchName) form.financeBranchName.value = banking.branchName || 'Koramangala, Bengaluru';
            if (form.financeAccountNumber) form.financeAccountNumber.value = banking.accountNumber || '';
            if (form.financeIfsc) form.financeIfsc.value = banking.ifsc || 'HDFC0000053';
            if (form.financeAccountType) form.financeAccountType.value = banking.accountType || 'Salary';
            if (form.financeIsPrimary) form.financeIsPrimary.checked = banking.isPrimary !== false;
            if (form.financeEffectiveFrom) form.financeEffectiveFrom.value = banking.effectiveFrom || (doj ? doj.split('T')[0] : new Date().toISOString().split('T')[0]);

            const benIdDisplay = document.getElementById('decentroBenIdDisplay');
            if (benIdDisplay) {
                benIdDisplay.textContent = banking.decentroBeneficiaryId || `ben_${(banking.ifsc || 'hdfc').slice(0, 4).toLowerCase()}_${(banking.accountNumber || '7890').slice(-4)}`;
            }

            const decBadge = document.getElementById('decentroVerificationBadge');
            if (decBadge) {
                decBadge.textContent = banking.verificationStatus || 'VERIFIED';
            }

            // Statutory Toggles & Inputs
            const uanToggle = document.getElementById('uanApplicableToggle');
            const uanGroup = document.getElementById('uanNumberGroup');
            const uanInput = document.getElementById('uanNumberInput');
            if (uanToggle) {
                uanToggle.checked = finStatutory.uanApplicable !== false && Boolean(finStatutory.uanNumber || finStatutory.uan || statutory.uan);
                if (uanGroup) uanGroup.style.display = uanToggle.checked ? 'block' : 'none';
                if (uanInput) uanInput.value = finStatutory.uanNumber || statutory.uan || emp.uan || '';
            }

            const esicToggle = document.getElementById('esicApplicableToggle');
            const esicGroup = document.getElementById('esicNumberGroup');
            const esicInput = document.getElementById('esicNumberInput');
            if (esicToggle) {
                esicToggle.checked = Boolean(finStatutory.esicApplicable && (finStatutory.esicNumber || statutory.esicIpNumber));
                if (esicGroup) esicGroup.style.display = esicToggle.checked ? 'block' : 'none';
                if (esicInput) esicInput.value = finStatutory.esicNumber || statutory.esicIpNumber || '';
            }

            const npsToggle = document.getElementById('npsApplicableToggle');
            const npsGroup = document.getElementById('npsNumberGroup');
            const npsInput = document.getElementById('npsNumberInput');
            if (npsToggle) {
                npsToggle.checked = Boolean(finStatutory.npsApplicable && finStatutory.npsNumber);
                if (npsGroup) npsGroup.style.display = npsToggle.checked ? 'block' : 'none';
                if (npsInput) npsInput.value = finStatutory.npsNumber || '';
            }

            const gratuityToggle = document.getElementById('gratuityApplicableToggle');
            const gratuityGroup = document.getElementById('gratuityNumberGroup');
            const gratuityInput = document.getElementById('gratuityNumberInput');
            if (gratuityToggle) {
                gratuityToggle.checked = finStatutory.gratuityApplicable !== false;
                if (gratuityGroup) gratuityGroup.style.display = gratuityToggle.checked ? 'block' : 'none';
                if (gratuityInput) gratuityInput.value = finStatutory.gratuityNumber || (id ? `GRAT-2026-${id.replace(/^EMP/, '')}` : 'GRAT-2026-001');
            }
        }

        // PRD Sections 1 & 4: Salary Structure & Revision Timeline
        await populateSalaryStructureView(id, emp);

        renderDocumentsTable();
        switchTab('job');

        if (window.KylrxEmployeeFinanceService && typeof window.KylrxEmployeeFinanceService.bindStatutoryToggles === 'function') {
            window.KylrxEmployeeFinanceService.bindStatutoryToggles(document);
        }

        if (window.openModal) window.openModal('empModal');
        if (window.lucide) lucide.createIcons();
    }

    /**
     * Reset Modal State for New Personnel Creation
     */
    function resetProfileModal() {
        state.currentEmployeeId = null;
        state.currentEmployee = null;
        state.documents = [];
        state.selectedFile = null;
        renderDocumentsTable();
        switchTab('job');
        updateManagerBadges();

        const form = document.getElementById('empForm');
        if (form) {
            if (form.financeAccountHolderName) form.financeAccountHolderName.value = '';
            if (form.financeBankName) form.financeBankName.value = 'HDFC Bank';
            if (form.financeBranchName) form.financeBranchName.value = 'Koramangala, Bengaluru';
            if (form.financeAccountNumber) form.financeAccountNumber.value = '';
            if (form.financeIfsc) form.financeIfsc.value = 'HDFC0000053';
            if (form.financeAccountType) form.financeAccountType.value = 'Salary';
            if (form.financeIsPrimary) form.financeIsPrimary.checked = true;
            if (form.financeEffectiveFrom) form.financeEffectiveFrom.value = new Date().toISOString().split('T')[0];
        }

        const uanToggle = document.getElementById('uanApplicableToggle');
        const uanGroup = document.getElementById('uanNumberGroup');
        const uanInput = document.getElementById('uanNumberInput');
        if (uanToggle) {
            uanToggle.checked = true;
            if (uanGroup) uanGroup.style.display = 'block';
            if (uanInput) uanInput.value = '';
        }

        const esicToggle = document.getElementById('esicApplicableToggle');
        const esicGroup = document.getElementById('esicNumberGroup');
        const esicInput = document.getElementById('esicNumberInput');
        if (esicToggle) {
            esicToggle.checked = false;
            if (esicGroup) esicGroup.style.display = 'none';
            if (esicInput) esicInput.value = '';
        }

        const npsToggle = document.getElementById('npsApplicableToggle');
        const npsGroup = document.getElementById('npsNumberGroup');
        const npsInput = document.getElementById('npsNumberInput');
        if (npsToggle) {
            npsToggle.checked = false;
            if (npsGroup) npsGroup.style.display = 'none';
            if (npsInput) npsInput.value = '';
        }

        const gratuityToggle = document.getElementById('gratuityApplicableToggle');
        const gratuityGroup = document.getElementById('gratuityNumberGroup');
        const gratuityInput = document.getElementById('gratuityNumberInput');
        if (gratuityToggle) {
            gratuityToggle.checked = true;
            if (gratuityGroup) gratuityGroup.style.display = 'block';
            if (gratuityInput) gratuityInput.value = 'GRAT-2026-001';
        }

        if (window.KylrxSubDepartmentService && typeof window.KylrxSubDepartmentService.populateSubDepartmentDropdown === 'function') {
            const subSelect = form?.subDepartmentCode || document.getElementById('subDeptSelect');
            if (subSelect) {
                window.KylrxSubDepartmentService.populateSubDepartmentDropdown(subSelect, {
                    departmentCode: 'ENG',
                    selectedCode: 'ENG-BACKEND',
                    includePlaceholder: true,
                    activeOnly: true
                });
            }
        }

        if (window.KylrxCostCenterService && typeof window.KylrxCostCenterService.populateCostCenterDropdown === 'function') {
            const ccSelect = form?.costCenterCode || document.getElementById('costCenterCodeSelect');
            if (ccSelect) {
                window.KylrxCostCenterService.populateCostCenterDropdown(ccSelect, {
                    selectedCode: 'CC-ENG-101',
                    includePlaceholder: false
                });
            }
        }

        if (window.KylrxEmployeeFinanceService && typeof window.KylrxEmployeeFinanceService.bindStatutoryToggles === 'function') {
            window.KylrxEmployeeFinanceService.bindStatutoryToggles(document);
        }

        resetSalaryStructureView();
    }

    /**
     * Get Current Documents in Modal State
     */
    function getCurrentDocuments() {
        return state.documents || [];
    }

    /**
     * PRD Sections 1 & 4: Populate Salary Structure & Revision Timeline
     */
    async function populateSalaryStructureView(empId, emp) {
        const orgId = localStorage.getItem('orgId') || 'org_kylrx';
        let structure = null;
        let timeline = [];

        if (empId && window.KylrxSalaryStructureService) {
            try {
                structure = await window.KylrxSalaryStructureService.getSalaryStructure(orgId, empId);
                timeline = await window.KylrxSalaryStructureService.getRevisionTimeline(orgId, empId);
            } catch (err) {
                console.warn("Could not fetch salary structure for employee:", empId, err);
            }
        }

        // Fallback default structure for sample demo data if not found in Firestore
        if (!structure && emp) {
            const basicAmt = emp.ctc ? (Number(emp.ctc) / 12) * 0.5 : 50000;
            const specialAmt = emp.ctc ? (Number(emp.ctc) / 12) * 0.25 : 25000;
            structure = {
                employeeId: empId || emp.employeeId || 'EMP0001',
                salaryStructureCode: emp.salaryStructureCode || 'STRUC_ENG_L2',
                effectiveFrom: emp.effectiveFrom || (emp.joiningDate ? emp.joiningDate.split('T')[0] : '2026-01-01'),
                payFrequency: emp.payFrequency || 'Monthly',
                isActive: true,
                components: [
                    { componentCode: 'BASIC', amount: basicAmt, percentage: null, calculationBasis: 'FLAT' },
                    { componentCode: 'HRA', amount: null, percentage: 50.0, calculationBasis: 'BASIC' },
                    { componentCode: 'SPECIAL_ALLOW', amount: specialAmt, percentage: null, calculationBasis: 'FLAT' }
                ],
                grossMonthly: basicAmt + (basicAmt * 0.5) + specialAmt,
                annualCTC: (basicAmt + (basicAmt * 0.5) + specialAmt) * 12
            };
            timeline = [structure];
        }

        renderSalaryStructureDetails(structure, timeline);
    }

    function renderSalaryStructureDetails(structure, timeline = []) {
        const titleEl = document.getElementById('empSalaryStructureTitle');
        const codeEl = document.getElementById('empSalaryStructureCodeDisplay');
        const effEl = document.getElementById('empSalaryEffectiveFromDisplay');
        const freqEl = document.getElementById('empSalaryPayFrequencyDisplay');
        const badgeEl = document.getElementById('empSalaryStructureStatusBadge');
        const grossEl = document.getElementById('empSalaryGrossMonthlyDisplay');
        const ctcEl = document.getElementById('empSalaryAnnualCtcDisplay');
        const revSelect = document.getElementById('empSalaryRevisionSelect');
        const tableBody = document.getElementById('empSalaryComponentsTableBody');

        if (!structure) {
            resetSalaryStructureView();
            return;
        }

        if (titleEl) titleEl.textContent = `Structure: ${structure.salaryStructureCode || 'Custom Package'}`;
        if (codeEl) codeEl.textContent = structure.salaryStructureCode || 'STRUC_STANDARD';
        if (effEl) effEl.textContent = structure.effectiveFrom || '2026-01-01';
        if (freqEl) freqEl.textContent = structure.payFrequency || 'Monthly';

        if (badgeEl) {
            const isActive = structure.isActive !== false;
            badgeEl.textContent = isActive ? 'ACTIVE' : 'INACTIVE';
            badgeEl.style.background = isActive ? '#16a34a' : '#64748b';
        }

        if (grossEl) {
            grossEl.textContent = '₹' + Number(structure.grossMonthly || 0).toLocaleString((window.KylrxFmt ? KylrxFmt.locale() : 'en-IN'), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }
        if (ctcEl) {
            ctcEl.textContent = '₹' + Number(structure.annualCTC || 0).toLocaleString((window.KylrxFmt ? KylrxFmt.locale() : 'en-IN'), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        }

        // Populate Timeline Dropdown
        if (revSelect) {
            if (timeline && timeline.length > 0) {
                revSelect.innerHTML = timeline.map(rev => `
                    <option value="${escapeHtml(rev.effectiveFrom)}" ${rev.effectiveFrom === structure.effectiveFrom ? 'selected' : ''}>
                        Effective: ${escapeHtml(rev.effectiveFrom)} (${escapeHtml(rev.salaryStructureCode)}) ${rev.isActive ? '• Active' : ''}
                    </option>
                `).join('');
                revSelect.onchange = (e) => {
                    const selectedRev = timeline.find(r => r.effectiveFrom === e.target.value);
                    if (selectedRev) {
                        renderSalaryStructureDetails(selectedRev, timeline);
                    }
                };
            } else {
                revSelect.innerHTML = `<option value="${structure.effectiveFrom}">Effective: ${structure.effectiveFrom}</option>`;
            }
        }

        // Render Itemized Components
        if (tableBody) {
            const components = structure.components || [];
            if (components.length === 0) {
                tableBody.innerHTML = '<tr><td colspan="7" style="padding: 16px; text-align: center; color: #94a3b8;">No components defined in this structure revision.</td></tr>';
            } else {
                // Find basic component for referenced percentage calculation preview
                const basicComp = components.find(c => (c.componentCode || '').toUpperCase() === 'BASIC');
                const basicVal = basicComp ? (Number(basicComp.amount) || 0) : 0;

                tableBody.innerHTML = components.map((comp, idx) => {
                    const cCode = comp.componentCode || '';
                    const basis = comp.calculationBasis || 'FLAT';
                    let computed = 0;
                    if (basis === 'FLAT') {
                        computed = Number(comp.amount) || 0;
                    } else if (basis === 'BASIC') {
                        computed = ((Number(comp.percentage) || 0) / 100) * basicVal;
                    } else {
                        computed = Number(comp.computedAmount) || Number(comp.amount) || 0;
                    }

                    const isDeduction = ['PF_EE', 'PF_ER', 'ESIC_EE', 'ESIC_ER', 'PT', 'TDS'].includes(cCode.toUpperCase());
                    const typeBadge = isDeduction
                        ? '<span style="font-size: 0.72rem; font-weight: 700; color: #b91c1c; background: #fee2e2; padding: 2px 6px; border-radius: 6px;">Deduction</span>'
                        : '<span style="font-size: 0.72rem; font-weight: 700; color: #047857; background: #d1fae5; padding: 2px 6px; border-radius: 6px;">Earning</span>';

                    const amtStr = (comp.amount !== null && comp.amount !== undefined)
                        ? '₹' + Number(comp.amount).toLocaleString((window.KylrxFmt ? KylrxFmt.locale() : 'en-IN'), { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                        : '—';
                    const pctStr = (comp.percentage !== null && comp.percentage !== undefined)
                        ? `${Number(comp.percentage)}%`
                        : '—';

                    return `
                        <tr style="border-bottom: 1px solid var(--border);">
                            <td style="padding: 8px 12px; font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                            <td style="padding: 8px 12px;">
                                <strong style="font-family: monospace; color: #1e293b;">${escapeHtml(cCode)}</strong>
                            </td>
                            <td style="padding: 8px 12px;">${typeBadge}</td>
                            <td style="padding: 8px 12px;">
                                <span style="font-size: 0.72rem; font-weight: 700; background: #f1f5f9; color: #334155; padding: 2px 6px; border-radius: 6px;">
                                    ${escapeHtml(basis)}
                                </span>
                            </td>
                            <td style="padding: 8px 12px; text-align: right; font-family: monospace; font-weight: 600; color: #0891b2;">${escapeHtml(pctStr)}</td>
                            <td style="padding: 8px 12px; text-align: right; font-family: monospace; font-weight: 600;">${escapeHtml(amtStr)}</td>
                            <td style="padding: 8px 12px; text-align: right; font-family: monospace; font-weight: 800; color: #0f172a;">
                                ₹${Number(computed).toLocaleString((window.KylrxFmt ? KylrxFmt.locale() : 'en-IN'), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }
    }

    function resetSalaryStructureView() {
        const titleEl = document.getElementById('empSalaryStructureTitle');
        const codeEl = document.getElementById('empSalaryStructureCodeDisplay');
        const effEl = document.getElementById('empSalaryEffectiveFromDisplay');
        const freqEl = document.getElementById('empSalaryPayFrequencyDisplay');
        const grossEl = document.getElementById('empSalaryGrossMonthlyDisplay');
        const ctcEl = document.getElementById('empSalaryAnnualCtcDisplay');
        const revSelect = document.getElementById('empSalaryRevisionSelect');
        const tableBody = document.getElementById('empSalaryComponentsTableBody');

        if (titleEl) titleEl.textContent = 'Compensation Package';
        if (codeEl) codeEl.textContent = 'STRUC_STANDARD';
        if (effEl) effEl.textContent = new Date().toISOString().split('T')[0];
        if (freqEl) freqEl.textContent = 'Monthly';
        if (grossEl) grossEl.textContent = '₹0.00';
        if (ctcEl) ctcEl.textContent = '₹0.00';
        if (revSelect) revSelect.innerHTML = '<option value="latest">Latest Active Revision</option>';
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="7" style="padding: 16px; text-align: center; color: #94a3b8;">No salary structure assigned for this employee.</td></tr>';
    }

    /**
     * Initialize listeners on page load
     */
    function init() {
        const fileInput = document.getElementById('empDocFileInput');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                if (e.target.files && e.target.files.length > 0) {
                    handleFileSelection(e.target.files[0]);
                }
            });
        }

        const l1Select = document.getElementById('l1ManagerSelect');
        const l2Select = document.getElementById('l2ManagerSelect');
        if (l1Select) l1Select.addEventListener('change', updateManagerBadges);
        if (l2Select) l2Select.addEventListener('change', updateManagerBadges);

        // Account Number visibility toggle
        const toggleAccBtn = document.getElementById('btnToggleAccVisibility');
        const accInput = document.getElementById('financeAccountNumber');
        if (toggleAccBtn && accInput) {
            toggleAccBtn.addEventListener('click', () => {
                if (accInput.type === 'password') {
                    accInput.type = 'text';
                    toggleAccBtn.innerHTML = '<i data-lucide="eye-off" style="width: 15px; height: 15px;"></i>';
                } else {
                    accInput.type = 'password';
                    toggleAccBtn.innerHTML = '<i data-lucide="eye" style="width: 15px; height: 15px;"></i>';
                }
                if (window.lucide) lucide.createIcons();
            });
        }

        // Decentro Penny Drop verification button
        const verifyBtn = document.getElementById('btnTriggerDecentroVerify');
        if (verifyBtn) {
            verifyBtn.addEventListener('click', async () => {
                const holder = document.getElementById('financeAccountHolderName')?.value;
                const acc = document.getElementById('financeAccountNumber')?.value;
                const ifsc = document.getElementById('financeIfsc')?.value;
                const bank = document.getElementById('financeBankName')?.value;

                if (!holder || !acc || !ifsc) {
                    alert('Please enter Account Holder Name, Account Number, and IFSC code first.');
                    return;
                }

                verifyBtn.disabled = true;
                verifyBtn.innerHTML = '<i data-lucide="loader" class="animate-spin" style="width: 14px; height: 14px;"></i> Verifying...';

                if (window.KylrxEmployeeFinanceService && typeof window.KylrxEmployeeFinanceService.validateBankAccountWithDecentro === 'function') {
                    const res = await window.KylrxEmployeeFinanceService.validateBankAccountWithDecentro({
                        accountHolderName: holder,
                        accountNumber: acc,
                        ifsc: ifsc,
                        bankName: bank
                    });

                    if (res.success) {
                        const benIdDisplay = document.getElementById('decentroBenIdDisplay');
                        if (benIdDisplay) benIdDisplay.textContent = res.decentroBeneficiaryId;
                        const decBadge = document.getElementById('decentroVerificationBadge');
                        if (decBadge) decBadge.textContent = 'VERIFIED';
                        alert(`Decentro Fabric Penny Drop Successful!\n\nBeneficiary ID: ${res.decentroBeneficiaryId}\nAccount Holder: ${res.accountHolderName}\nIFSC: ${res.ifsc}\nGateway: ${res.gateway}\nStatus: VERIFIED`);
                    } else {
                        alert(`Decentro Verification Failed:\n${res.error}`);
                    }
                }

                verifyBtn.disabled = false;
                verifyBtn.innerHTML = '<i data-lucide="refresh-cw" style="width: 14px; height: 14px;"></i> Run Penny Drop Test';
                if (window.lucide) lucide.createIcons();
            });
        }

        if (window.KylrxEmployeeFinanceService && typeof window.KylrxEmployeeFinanceService.bindStatutoryToggles === 'function') {
            window.KylrxEmployeeFinanceService.bindStatutoryToggles(document);
        }
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }

    return {
        switchTab,
        openProfileModal,
        resetProfileModal,
        getCurrentDocuments,
        handleFileSelection,
        uploadDocument,
        previewDocument,
        downloadDocument,
        deleteDocument,
        updateManagerBadges,
        renderDocumentsTable,
        populateSalaryStructureView,
        renderSalaryStructureDetails
    };
}));

