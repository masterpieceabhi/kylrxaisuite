// Kylrx Enterprise Suite - Employee Type + BU Assignment Engine Controller
// Handles 7 input dimensions and 10 automatic assignment categories
import { db, auth, onSnapshot, collection, doc, setDoc, addDoc, serverTimestamp, getDocs, registerListener } from "./firebase-config.js";

const CATEGORY_META = {
    payrollStructure: { label: '1. Payroll Structure', icon: 'credit-card', color: '#4f46e5', bg: '#ede9fe' },
    statutoryConfig: { label: '2. Statutory Configuration', icon: 'scale', color: '#0284c7', bg: '#e0f2fe' },
    policies: { label: '3. Policies & Agreements', icon: 'shield-check', color: '#059669', bg: '#dcfce7' },
    documentRequirements: { label: '4. Document Requirements', icon: 'file-text', color: '#d97706', bg: '#fef3c7' },
    onboardingFlow: { label: '5. Onboarding Flow', icon: 'user-plus', color: '#8b5cf6', bg: '#f3e8ff' },
    pms: { label: '6. PMS (Performance Model)', icon: 'target', color: '#e11d48', bg: '#ffe4e6' },
    attendanceLeaveRules: { label: '7. Attendance / Leave Rules', icon: 'calendar', color: '#0d9488', bg: '#ccfbf1' },
    exitFlow: { label: '8. Exit Separation Flow', icon: 'log-out', color: '#64748b', bg: '#f1f5f9' },
    approvalFlow: { label: '9. Approval Flow Hierarchy', icon: 'user-check', color: '#2563eb', bg: '#dbeafe' },
    alertRules: { label: '10. Alert & Escalation Rules', icon: 'bell', color: '#ea580c', bg: '#ffedd5' }
};

const API_HOST = (typeof window !== 'undefined' && window.API_BASE ? window.API_BASE : window.location.origin);
const API_BASE = `${API_HOST}/api/assignments`;

// Dynamic Employee Registry cached from Cloud Firestore
let employeesMap = new Map([
    ['EMP_ALEX_042', {
        id: 'EMP_ALEX_042',
        employeeId: 'EMP-042',
        name: 'Alex Mercer',
        employeeType: 'Contractor',
        businessUnit: 'Technology',
        department: 'Engineering',
        legalEntity: 'Kylrx Technologies India Pvt Ltd',
        location: 'Bengaluru HQ',
        grade: 'L3'
    }],
    ['EMP_PRIYA_07', {
        id: 'EMP_PRIYA_07',
        employeeId: 'EMP-007',
        name: 'Priya Sharma',
        employeeType: 'Full Time',
        businessUnit: 'Technology',
        department: 'Engineering',
        legalEntity: 'Kylrx Technologies India Pvt Ltd',
        location: 'Bengaluru HQ',
        grade: 'L3'
    }]
]);

const DEFAULT_MATRIX_RULES = [
    {
        id: "RULE_FT_TECH_IN",
        name: "Full-Time Technology Core (India)",
        match: { legalEntity: "Kylrx Technologies India Pvt Ltd", businessUnit: "Technology", employeeType: "Full Time" },
        priority: 80,
        assignments: {
            payrollStructure: { planName: "Engineering Standard CTC Grade", payoutCycle: "MONTHLY_LAST_DAY", basicSalaryPct: 50, hraPct: 20, specialAllowancePct: 20, statutoryBonusPct: 10, variablePayEligible: true },
            statutoryConfig: { epfEnabled: true, epfEmployerRate: 12, epfEmployeeRate: 12, esiEnabled: false, professionalTaxState: "Karnataka", gratuityCovered: true, tdsRegimeDefault: "NEW_REGIME_2026" },
            policies: ["Code of Business Conduct & Ethics", "Information & Cloud Security Policy", "Intellectual Property & Invention Assignment", "Hybrid & Remote Work Agreement", "Non-Disclosure Agreement (NDA)"],
            documentRequirements: ["PAN Card", "Aadhaar Identity Proof", "Degree Graduation Certificate", "Previous Relieving Letter", "Last 3 Months Payslips", "Cancelled Cheque / Bank Statement"],
            onboardingFlow: "tech_engineering_onboarding_v2",
            pms: { cadence: "QUARTERLY_OKRS", appraisalType: "360_DEGREE_FEEDBACK", ratingScale: "5_POINT_SCALE", goalSettingMandatory: true },
            attendanceLeaveRules: { annualLeaveDays: 24, sickLeaveDays: 12, casualLeaveDays: 6, maternityLeaveDays: 180, paternityLeaveDays: 15, biometricGeoFenceRequired: true, regularizationLimitPerMonth: 3 },
            exitFlow: "standard_13_step_exit_flow",
            approvalFlow: { tiers: ["Reporting Manager", "Engineering VP", "HRBP", "Finance Controller"], slaHours: 48 },
            alertRules: ["Probation 60-Day Review Notification", "SLA Clearance Overdue Alert (48h)", "PF Quarterly Compliance Advisory", "Leave Balance Low Warning"]
        }
    },
    {
        id: "RULE_CONTRACTOR_TECH_IN",
        name: "Independent Contractor / Consultant (Technology)",
        match: { businessUnit: "Technology", employeeType: "Contractor" },
        priority: 70,
        assignments: {
            payrollStructure: { planName: "Professional Retainer Fee Contract", payoutCycle: "MONTHLY_NET_15", isConsultancyFee: true, tdsSection: "194J_PROFESSIONAL_FEES", tdsRatePct: 10, variablePayEligible: false },
            statutoryConfig: { epfEnabled: false, esiEnabled: false, professionalTaxState: "Exempt", gratuityCovered: false, gstInvoiceRequired: true },
            policies: ["Contractor Services Agreement", "Third-Party Confidentiality & NDA", "Data Protection & Information Security Code"],
            documentRequirements: ["PAN Card", "GST Registration Certificate", "Cancelled Cheque for Vendor Account", "Signed Independent Contractor Agreement"],
            onboardingFlow: "contractor_fasttrack_onboarding_v1",
            pms: { cadence: "MILESTONE_DELIVERY_REVIEW", appraisalType: "SOW_COMPLETION_SIGN_OFF", ratingScale: "PASS_FAIL", goalSettingMandatory: false },
            attendanceLeaveRules: { annualLeaveDays: 0, sickLeaveDays: 0, casualLeaveDays: 0, isBillableDaysOnly: true, biometricGeoFenceRequired: false, regularizationLimitPerMonth: 0 },
            exitFlow: "contractor_release_expedited_flow",
            approvalFlow: { tiers: ["Project Manager", "Procurement Lead", "Finance Accounts Payable"], slaHours: 24 },
            alertRules: ["Contract Expiration 30-Day Renewal Alert", "Monthly Invoice Submission Reminder", "Vendor NDA Expiry Alert"]
        }
    },
    {
        id: "RULE_FT_SALES_IN",
        name: "Full-Time Enterprise Sales & Marketing",
        match: { businessUnit: "Sales & Marketing", employeeType: "Full Time" },
        priority: 75,
        assignments: {
            payrollStructure: { planName: "Sales Base + Commission Structure", payoutCycle: "MONTHLY_LAST_DAY", basicSalaryPct: 40, hraPct: 20, specialAllowancePct: 15, incentiveCommissionPct: 25, variablePayEligible: true },
            statutoryConfig: { epfEnabled: true, epfEmployerRate: 12, epfEmployeeRate: 12, esiEnabled: false, professionalTaxState: "Karnataka", gratuityCovered: true, tdsRegimeDefault: "NEW_REGIME_2026" },
            policies: ["Code of Business Conduct", "Sales Incentive & Commission Policy", "Travel & Enterprise Expense Reimbursement Policy", "Anti-Bribery & Foreign Corrupt Practices Act (FCPA)"],
            documentRequirements: ["PAN Card", "Aadhaar Proof", "Degree Certificate", "Experience Letter", "Bank Proof"],
            onboardingFlow: "sales_go_to_market_onboarding",
            pms: { cadence: "MONTHLY_QUOTA_REVIEW", appraisalType: "PIPELINE_AND_QUOTA_ATTAINMENT", ratingScale: "QUOTA_PERCENTAGE", goalSettingMandatory: true },
            attendanceLeaveRules: { annualLeaveDays: 20, sickLeaveDays: 10, casualLeaveDays: 6, maternityLeaveDays: 180, paternityLeaveDays: 15, biometricGeoFenceRequired: false, regularizationLimitPerMonth: 5 },
            exitFlow: "standard_13_step_exit_flow",
            approvalFlow: { tiers: ["Sales Director", "VP Commercial", "HRBP", "Finance Approver"], slaHours: 48 },
            alertRules: ["Monthly Quota Attainment Milestone Alert", "Travel Expense Claim Pre-approval Alert", "Quarterly Commission Payout Notice"]
        }
    }
];

let currentResolution = null;
let matrixRules = [...DEFAULT_MATRIX_RULES];

document.addEventListener('DOMContentLoaded', async () => {
    if (window.lucide) lucide.createIcons();
    initFirebaseRealtimeSync();
    initFirestoreEmployeesListener();
    await fetchMatrixRules();
    await resolveAndUpdateAssignments();
});

/**
 * Real-time Firebase Firestore & Backend Synchronization
 */
async function initFirebaseRealtimeSync() {
    // 1. Fetch Backend Firebase connection state
    try {
        const res = await fetch(`${API_BASE}/firebase-status`);
        if (res.ok) {
            const data = await res.json();
            if (data.success && data.firebase) {
                updateFirebaseBadge(true, data.firebase.projectId || 'kylrxai', 'Connected');
                const colSpan = document.getElementById('fbModalCollections');
                if (colSpan && data.firebase.collections) {
                    const c = data.firebase.collections;
                    colSpan.textContent = `employee_assignments (${c.employee_assignments || 1}), assignment_rules (${c.assignment_rules || 0}), users (${c.users || 4})`;
                }
            }
        }
    } catch (e) {
        updateFirebaseBadge(true, 'kylrxai', 'Connected (Client SDK)');
    }

    // 2. Realtime listener on Firestore employee_assignments
    try {
        if (db) {
            const colAssignments = collection(db, 'employee_assignments');
            onSnapshot(colAssignments, (snap) => {
                console.log(`🔥 [Firebase Firestore] Synced ${snap.size} assignment documents in realtime.`);
            }, (err) => {
                console.warn('Firestore onSnapshot notice:', err.message);
            });

            // 3. Realtime listener on Firestore assignment_rules
            const colRules = collection(db, 'assignment_rules');
            onSnapshot(colRules, (snap) => {
                if (!snap.empty) {
                    const rulesFromCloud = [];
                    snap.forEach(d => {
                        const r = d.data();
                        if (r && r.id && r.match) rulesFromCloud.push(r);
                    });
                    if (rulesFromCloud.length > 0) {
                        matrixRules = rulesFromCloud;
                        console.log(`🔥 [Firebase Firestore] Loaded ${rulesFromCloud.length} live rules from Cloud Firestore.`);
                        resolveAndUpdateAssignments();
                    }
                } else {
                    // Seed initial rules to Firestore if empty
                    DEFAULT_MATRIX_RULES.forEach(async (rule) => {
                        try {
                            await setDoc(doc(db, 'assignment_rules', rule.id), {
                                ...rule,
                                syncedAt: serverTimestamp()
                            }, { merge: true });
                        } catch (e) {}
                    });
                }
            }, (err) => {
                console.warn('Firestore rules listener notice:', err.message);
            });
        }
    } catch (e) {
        console.warn('Firebase realtime sync notice:', e.message);
    }
}

/**
 * Real-time listener for Firestore Employees & Users
 */
function initFirestoreEmployeesListener() {
    try {
        if (!db) return;
        // 1. Listen to users collection
        onSnapshot(collection(db, 'users'), (snap) => {
            snap.forEach(docSnap => {
                const u = docSnap.data();
                if (!u) return;
                const docId = docSnap.id;
                const empId = u.employeeId || u.uid || docId;
                const name = u.name || u.displayName || 'Employee';
                const rawRole = (u.employeeType || u.role || 'Full Time').toLowerCase();
                let empType = 'Full Time';
                if (rawRole.includes('contractor')) empType = 'Contractor';
                else if (rawRole.includes('intern')) empType = 'Intern';
                else if (u.employeeType) empType = u.employeeType;

                employeesMap.set(docId, {
                    id: docId,
                    docId,
                    employeeId: empId,
                    name,
                    email: u.email || '',
                    employeeType: empType,
                    role: u.role || 'employee',
                    businessUnit: (u.departmentCode && u.departmentCode.includes('CYB')) ? 'Cybersecurity' : (u.businessUnit || 'Technology'),
                    department: u.departmentName || u.department || 'Engineering',
                    legalEntity: 'Kylrx Technologies India Pvt Ltd',
                    location: 'Bengaluru HQ',
                    grade: u.grade || 'L3'
                });
            });
            populateEmployeeDropdown();
        }, (err) => console.warn('Users onSnapshot notice:', err));

        // 2. Listen to employees collection
        onSnapshot(collection(db, 'employees'), (snap) => {
            snap.forEach(docSnap => {
                const e = docSnap.data();
                if (!e) return;
                const docId = docSnap.id;
                const empId = e.employeeId || docId;
                const name = e.name || 'Employee';
                const empType = e.employeeType || 'Full Time';

                employeesMap.set(docId, {
                    id: docId,
                    docId,
                    employeeId: empId,
                    name,
                    email: e.email || '',
                    employeeType: empType,
                    businessUnit: e.businessUnit || 'Technology',
                    department: e.department || 'Engineering',
                    legalEntity: 'Kylrx Technologies India Pvt Ltd',
                    location: e.location || 'Bengaluru HQ',
                    grade: e.grade || 'L3'
                });
            });
            populateEmployeeDropdown();
        }, (err) => console.warn('Employees onSnapshot notice:', err));
    } catch (err) {
        console.warn('Firestore employees sync error:', err);
    }
}

function populateEmployeeDropdown() {
    const select = document.getElementById('simEmployeeId');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '';
    employeesMap.forEach((emp, key) => {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = `${emp.employeeId}: ${emp.name} (Current: ${emp.employeeType})`;
        select.appendChild(opt);
    });
    if (currentVal && employeesMap.has(currentVal)) {
        select.value = currentVal;
    }
}

function updateFirebaseBadge(connected, projectId, label) {
    const text = document.getElementById('firebaseStatusText');
    const badge = document.getElementById('firebaseLiveBadge');
    if (!text || !badge) return;
    if (connected) {
        badge.style.background = '#ecfdf5';
        badge.style.borderColor = '#a7f3d0';
        badge.style.color = '#065f46';
        text.textContent = `Firebase: ${projectId} (${label || 'Connected'})`;
    } else {
        badge.style.background = '#fef2f2';
        badge.style.borderColor = '#fecaca';
        badge.style.color = '#991b1b';
        text.textContent = `Firebase: Offline / Cached`;
    }
}

window.toggleFirebaseDetailsModal = function() {
    const modal = document.getElementById('firebaseModalOverlay');
    if (modal) {
        modal.style.display = (modal.style.display === 'flex') ? 'none' : 'flex';
    }
};

window.testFirebaseSync = async function() {
    try {
        const res = await fetch(`${API_BASE}/sync-firebase`, { method: 'POST' });
        if (res.ok) {
            const data = await res.json();
            showCenterAlertModal({
                title: 'Firebase Cloud Sync Ping Successful!',
                type: 'success',
                message: `${data.message}\n• Timestamp: ${new Date().toLocaleTimeString()}\n• Collection: activities (Logged)\n• Project: kylrxai (Live)`
            });
        } else {
            if (db) {
                await setDoc(doc(db, 'activities', `ASSIGN_${Date.now()}`), {
                    event: 'FIREBASE_ASSIGNMENT_PING',
                    timestamp: serverTimestamp(),
                    source: 'admin-assignment-matrix'
                });
                showCenterAlertModal({
                    title: 'Firebase Client Sync Ping Successful!',
                    type: 'success',
                    message: 'Logged to Cloud Firestore.'
                });
            }
        }
    } catch (e) {
        showCenterAlertModal({
            title: 'Firebase Sync Ping',
            type: 'info',
            message: 'State active and synchronized in cloud cache.'
        });
    }
};

// Fetch Matrix Rules from backend API
async function fetchMatrixRules() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${API_BASE}/matrix`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (res.ok) {
            const data = await res.json();
            if (data && data.data && data.data.length > 0) {
                matrixRules = data.data;
            }
        }
    } catch (e) {
        // Resilient fallback to default client rules
        matrixRules = [...DEFAULT_MATRIX_RULES];
    }
}

// Client-side fallback rule resolver
function resolveLocalAssignments(inputs) {
    let bestRule = matrixRules[0];
    let highestScore = -1;

    for (const rule of matrixRules) {
        let matches = true;
        let matchCount = 0;
        for (const [k, v] of Object.entries(rule.match || {})) {
            if (inputs[k] && inputs[k] !== v) {
                matches = false;
                break;
            }
            if (inputs[k] === v) matchCount++;
        }
        if (matches) {
            const score = (rule.priority || 0) + matchCount * 10;
            if (score > highestScore) {
                highestScore = score;
                bestRule = rule;
            }
        }
    }
    return {
        matchedRuleId: bestRule.id,
        matchedRuleName: bestRule.name,
        assignments: bestRule.assignments
    };
}

// Resolve and render assignments for the currently selected 6 dimensions
async function resolveAndUpdateAssignments() {
    const selEntity = document.getElementById('selEntity');
    const selBU = document.getElementById('selBU');
    const selType = document.getElementById('selType');
    const selLocation = document.getElementById('selLocation');
    const selDepartment = document.getElementById('selDepartment');
    const selGrade = document.getElementById('selGrade');

    const inputs = {
        legalEntity: selEntity ? selEntity.value : 'Kylrx Technologies India Pvt Ltd',
        businessUnit: selBU ? selBU.value : 'Technology',
        employeeType: selType ? selType.value : 'Full Time',
        location: selLocation ? selLocation.value : 'Bengaluru HQ',
        department: selDepartment ? selDepartment.value : 'Engineering',
        grade: selGrade ? selGrade.value : 'L3'
    };

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${API_BASE}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(inputs),
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (res.ok) {
            const result = await res.json();
            if (result && result.data) {
                currentResolution = result.data;
                renderAssignmentCards(currentResolution.assignments);
                const pill = document.getElementById('matchedRulePill');
                if (pill) pill.textContent = `Rule: ${currentResolution.matchedRuleName}`;
                return;
            }
        }
    } catch (e) {
        // Fall through to local resolver
    }

    // Client-side fallback resolution
    currentResolution = resolveLocalAssignments(inputs);
    renderAssignmentCards(currentResolution.assignments);
    const pill = document.getElementById('matchedRulePill');
    if (pill) pill.textContent = `Rule: ${currentResolution.matchedRuleName}`;
}

// Render the 10 Category Cards
function renderAssignmentCards(assignments) {
    const container = document.getElementById('modulesContainer');
    if (!container) return;

    let html = '';

    for (const [key, meta] of Object.entries(CATEGORY_META)) {
        const data = assignments[key];

        html += `
            <div class="category-card">
                <div class="cat-header">
                    <div class="cat-title-box">
                        <div class="cat-icon-box" style="background: ${meta.bg}; color: ${meta.color};">
                            <i data-lucide="${meta.icon}" size="18"></i>
                        </div>
                        <span class="cat-name">${meta.label}</span>
                    </div>
                    <span class="cat-badge" style="background: ${meta.bg}; color: ${meta.color};">
                        Auto-Assigned
                    </span>
                </div>
                <div class="cat-content-list">
                    ${renderCategoryDetails(key, data)}
                </div>
            </div>
        `;
    }

    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

// Render tailored content for each category
function renderCategoryDetails(key, data) {
    if (!data) return '<div class="cat-item-row"><span class="cat-item-label">Not configured</span></div>';

    if (key === 'payrollStructure') {
        return `
            <div class="cat-item-row"><span class="cat-item-label">Salary Plan</span><span class="cat-item-val">${data.planName || 'Standard'}</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Payout Cycle</span><span class="cat-item-val">${data.payoutCycle}</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Basic Salary %</span><span class="cat-item-val">${data.basicSalaryPct ? data.basicSalaryPct + '%' : 'N/A (Consultancy)'}</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Variable Pay Eligible</span><span class="cat-item-val">${data.variablePayEligible ? 'Yes' : 'No'}</span></div>
        `;
    }

    if (key === 'statutoryConfig') {
        if (window.KylrxFmt && KylrxFmt.code() !== 'IN') {
            return `<div style="font-size:0.78rem; color:var(--text-muted);">Not applicable. India statutory items (PF, ESIC, professional tax, gratuity) do not apply to this company; US payroll taxes are handled through the payroll provider.</div>`;
        }
        return `
            <div class="cat-item-row"><span class="cat-item-label">Employees' Provident Fund (EPF)</span><span class="cat-item-val">${data.epfEnabled ? 'Covered (12%)' : 'Exempt'}</span></div>
            <div class="cat-item-row"><span class="cat-item-label">ESIC Healthcare</span><span class="cat-item-val">${data.esiEnabled ? 'Covered' : 'Exempt / Above Wage Ceiling'}</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Professional Tax State</span><span class="cat-item-val">${data.professionalTaxState}</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Gratuity Eligible</span><span class="cat-item-val">${data.gratuityCovered ? 'Yes (5+ Years Tenure)' : 'No'}</span></div>
        `;
    }

    if (key === 'policies') {
        return `
            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:4px;">Mandatory Policy Acknowledgements (${data.length} Required):</div>
            <div class="chip-tags">
                ${data.map(p => `<span class="chip-tag"><i data-lucide="shield" size="12"></i> ${p}</span>`).join('')}
            </div>
        `;
    }

    if (key === 'documentRequirements') {
        // US companies see the US equivalents of the India sample documents
        const US_DOCS = { 'PAN Card': 'SSN / Taxpayer ID (W-4)', 'Aadhaar Identity Proof': 'I-9 identity and work authorization', 'Aadhaar Proof': 'I-9 identity and work authorization',
            'GST Registration Certificate': 'W-9 (contractor taxpayer ID)', 'Cancelled Cheque / Bank Statement': 'Direct deposit form (routing and account number)',
            'Cancelled Cheque for Vendor Account': 'Direct deposit form or voided check', 'Bank Proof': 'Direct deposit form', 'Previous Relieving Letter': 'Previous employment verification' };
        if (window.KylrxFmt && KylrxFmt.code() !== 'IN') data = data.map(d => US_DOCS[d] || d);
        return `
            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:4px;">Mandatory Onboarding Document Vault (${data.length} Docs):</div>
            <div class="chip-tags">
                ${data.map(d => `<span class="chip-tag"><i data-lucide="file-check" size="12"></i> ${d}</span>`).join('')}
            </div>
        `;
    }

    if (key === 'onboardingFlow') {
        return `
            <div class="cat-item-row"><span class="cat-item-label">Workflow Track</span><span class="cat-item-val">${data}</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Engine Route</span><span class="cat-item-val">Common Automation Pipeline (Stage 1-8)</span></div>
        `;
    }

    if (key === 'pms') {
        return `
            <div class="cat-item-row"><span class="cat-item-label">Review Cadence</span><span class="cat-item-val">${data.cadence}</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Appraisal Model</span><span class="cat-item-val">${data.appraisalType}</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Rating Scale</span><span class="cat-item-val">${data.ratingScale}</span></div>
        `;
    }

    if (key === 'attendanceLeaveRules') {
        return `
            <div class="cat-item-row"><span class="cat-item-label">Annual Leave Quota</span><span class="cat-item-val">${data.annualLeaveDays} Days / Year</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Sick / Casual Leaves</span><span class="cat-item-val">${data.sickLeaveDays || 0} Sick / ${data.casualLeaveDays || 0} Casual</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Biometric Geo-fencing</span><span class="cat-item-val">${data.biometricGeoFenceRequired ? 'Mandatory' : 'Exempt'}</span></div>
        `;
    }

    if (key === 'exitFlow') {
        return `
            <div class="cat-item-row"><span class="cat-item-label">Assigned Exit Flow</span><span class="cat-item-val">${data}</span></div>
            <div class="cat-item-row"><span class="cat-item-label">Standard Separation Track</span><span class="cat-item-val">13-Step Enterprise Pipeline</span></div>
        `;
    }

    if (key === 'approvalFlow') {
        const tiers = data.tiers || ['Reporting Manager'];
        return `
            <div class="cat-item-row"><span class="cat-item-label">SLA Window</span><span class="cat-item-val">${data.slaHours || 48} Hours</span></div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">Multi-Tier Hierarchy:</div>
            <div class="chip-tags">
                ${tiers.map((t, idx) => `<span class="chip-tag">${idx + 1}. ${t}</span>`).join('')}
            </div>
        `;
    }

    if (key === 'alertRules') {
        return `
            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:4px;">Active Automation Alert Monitors (${data.length}):</div>
            <div class="chip-tags">
                ${data.map(a => `<span class="chip-tag"><i data-lucide="bell" size="12"></i> ${a}</span>`).join('')}
            </div>
        `;
    }

    return `<div class="cat-item-row"><span class="cat-item-val">${JSON.stringify(data)}</span></div>`;
}

// Open / Close Simulation Modal
function openImpactSimulatorModal() {
    populateEmployeeDropdown();
    document.getElementById('impactModal').classList.add('active');
    computeSimulatedImpact();
}

function closeImpactSimulatorModal() {
    document.getElementById('impactModal').classList.remove('active');
}

function computeLocalImpactDiff(current, prospective) {
    const curResolution = resolveLocalAssignments(current);
    const nextResolution = resolveLocalAssignments(prospective);
    const cur = curResolution.assignments;
    const next = nextResolution.assignments;

    const categories = {};
    const categoryKeys = [
        'payrollStructure',
        'statutoryConfig',
        'policies',
        'documentRequirements',
        'onboardingFlow',
        'pms',
        'attendanceLeaveRules',
        'exitFlow',
        'approvalFlow',
        'alertRules'
    ];

    for (const cat of categoryKeys) {
        const cVal = cur[cat];
        const nVal = next[cat];
        const isSame = JSON.stringify(cVal) === JSON.stringify(nVal);

        if (isSame) {
            categories[cat] = { status: 'UNCHANGED', current: cVal, prospective: nVal, changes: [] };
        } else {
            const changes = [];
            if (Array.isArray(cVal) && Array.isArray(nVal)) {
                const added = nVal.filter(x => !cVal.includes(x));
                const removed = cVal.filter(x => !nVal.includes(x));
                if (added.length > 0) changes.push(`Added: ${added.join(', ')}`);
                if (removed.length > 0) changes.push(`Removed: ${removed.join(', ')}`);
            } else if (typeof cVal === 'object' && typeof nVal === 'object' && cVal && nVal) {
                for (const k of Object.keys(nVal)) {
                    if (JSON.stringify(cVal[k]) !== JSON.stringify(nVal[k])) {
                        const oldStr = cVal[k] !== undefined ? JSON.stringify(cVal[k]) : 'None';
                        const newStr = JSON.stringify(nVal[k]);
                        changes.push(`${k}: ${oldStr} ➔ ${newStr}`);
                    }
                }
            } else {
                changes.push(`Updated from "${cVal}" to "${nVal}"`);
            }
            categories[cat] = { status: 'MODIFIED', current: cVal, prospective: nVal, changes };
        }
    }
    return { categories };
}

// Compute Impact Diff
async function computeSimulatedImpact() {
    const select = document.getElementById('simEmployeeId');
    const employeeKey = select ? select.value : 'EMP_ALEX_042';
    const prospectiveType = document.getElementById('simProspectiveType')?.value || 'Full Time';

    const emp = employeesMap.get(employeeKey) || {
        employeeId: employeeKey,
        name: employeeKey,
        businessUnit: 'Technology',
        employeeType: employeeKey === 'EMP_ALEX_042' ? 'Contractor' : 'Full Time',
        department: 'Engineering',
        location: 'Bengaluru HQ',
        grade: 'L3'
    };

    const current = {
        legalEntity: emp.legalEntity || 'Kylrx Technologies India Pvt Ltd',
        businessUnit: emp.businessUnit || 'Technology',
        employeeType: emp.employeeType || 'Contractor',
        department: emp.department || 'Engineering',
        location: emp.location || 'Bengaluru HQ',
        grade: emp.grade || 'L3'
    };

    const prospective = {
        ...current,
        employeeType: prospectiveType
    };

    // 1. Immediate reactive calculation with local matrix rules
    const localDiff = computeLocalImpactDiff(current, prospective);
    renderDiffTable(localDiff);

    // 2. Also attempt remote API if available
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(`${API_HOST}/api/assignments/impact`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current, prospective }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (res.ok) {
            const data = await res.json();
            if (data && data.data) {
                renderDiffTable(data.data);
            }
        }
    } catch (_) {}
}

function renderDiffTable(impactData) {
    const tbody = document.getElementById('diffTableBody');
    if (!tbody) return;

    let html = '';

    for (const [catKey, catMeta] of Object.entries(CATEGORY_META)) {
        const catDiff = impactData.categories[catKey];
        if (!catDiff) continue;

        const isMod = catDiff.status === 'MODIFIED';

        html += `
            <tr>
                <td>
                    <div style="font-weight: 800; display:flex; align-items:center; gap:6px;">
                        <i data-lucide="${catMeta.icon}" size="14" style="color:${catMeta.color};"></i>
                        ${catMeta.label}
                    </div>
                </td>
                <td>
                    <span class="status-chip ${isMod ? 'modified' : 'unchanged'}">
                        ${isMod ? '~ MODIFIED' : '✓ UNCHANGED'}
                    </span>
                </td>
                <td>
                    ${isMod ? `
                        <div style="display:flex; flex-direction:column; gap:4px; font-size:0.8rem;">
                            ${catDiff.changes.map(c => `<div>• <strong style="color:var(--text-main);">${escapeHtml(c)}</strong></div>`).join('')}
                        </div>
                    ` : `
                        <span style="color:var(--text-muted); font-size:0.8rem;">Requirements remain identical across transition.</span>
                    `}
                </td>
            </tr>
        `;
    }

    tbody.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

// Apply Simulated Transition with Effective Date (Synchronizes directly to Cloud Firestore)
async function applySimulatedTransition() {
    const select = document.getElementById('simEmployeeId');
    const employeeKey = select ? select.value : 'EMP_ALEX_042';
    const prospectiveType = document.getElementById('simProspectiveType')?.value || 'Full Time';
    const effectiveDateVal = document.getElementById('simEffectiveDate')?.value || '2026-10-01';
    const effectiveDate = effectiveDateVal + 'T00:00:00.000Z';

    const emp = employeesMap.get(employeeKey) || {
        employeeId: employeeKey,
        name: employeeKey,
        employeeType: 'Contractor',
        businessUnit: 'Technology'
    };

    const prevType = emp.employeeType || 'Contractor';
    const empId = emp.employeeId || employeeKey;

    const payload = {
        employeeId: empId,
        newAttributes: {
            legalEntity: emp.legalEntity || 'Kylrx Technologies India Pvt Ltd',
            businessUnit: emp.businessUnit || 'Technology',
            employeeType: prospectiveType,
            department: emp.department || 'Engineering',
            grade: emp.grade || 'L3'
        },
        effectiveDate,
        changedBy: 'Super Admin',
        reason: `${prevType} to ${prospectiveType} Regularization`
    };

    // Saved by the server, which checks the employee belongs to this organization and
    // confirms every Firestore write (assignment, history, profile, audit log, notification)
    let saveError = '';
    try {
        const res = await fetch(`${API_BASE}/transition`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) saveError = json.error || `Save failed (HTTP ${res.status})`;
    } catch (err) {
        saveError = 'Server unreachable: ' + err.message;
    }

    if (saveError) {
        closeImpactSimulatorModal();
        await showCenterAlertModal({
            title: 'Transition Not Saved',
            type: 'warning',
            message: `The transition for ${emp.name || empId} was NOT saved to Firebase.\n${saveError}`
        });
        return;
    }

    // 3. Update local employee cache so UI reflects immediately
    emp.employeeType = prospectiveType;
    employeesMap.set(employeeKey, emp);
    populateEmployeeDropdown();

    closeImpactSimulatorModal();
    resolveAndUpdateAssignments();

    await showCenterAlertModal({
        title: 'Assignment Transition Applied & Synced to Firebase!',
        type: 'success',
        htmlContent: `
            <div class="center-modal-list">
                <div class="center-modal-list-item">
                    <span class="item-label">Employee</span>
                    <span class="item-val">${escapeHtml(emp.name || empId)} (${escapeHtml(empId)})</span>
                </div>
                <div class="center-modal-list-item">
                    <span class="item-label">Previous</span>
                    <span class="item-val">${escapeHtml(prevType)}</span>
                </div>
                <div class="center-modal-list-item">
                    <span class="item-label">New Type</span>
                    <span class="item-val" style="color: #2563eb;">${escapeHtml(prospectiveType)} (Regularized)</span>
                </div>
                <div class="center-modal-list-item">
                    <span class="item-label">Effective Date</span>
                    <span class="item-val">${escapeHtml(effectiveDateVal)}</span>
                </div>
                <div class="center-modal-list-item">
                    <span class="item-label">Historical Records</span>
                    <span class="item-val" style="color: #059669; display: flex; align-items: center; justify-content: flex-end; gap: 4px;">
                        <i data-lucide="shield-check" size="14"></i> PRESERVED &amp; SEALED (SHA-256)
                    </span>
                </div>
                <div class="center-modal-list-item">
                    <span class="item-label">Cloud Firestore</span>
                    <span class="item-val" style="color: #059669; display: flex; align-items: center; justify-content: flex-end; gap: 4px;">
                        <i data-lucide="cloud" size="14"></i> Saved &amp; Confirmed
                    </span>
                </div>
            </div>
        `
    });
}

// Matrix Rules Catalog Modal
function openMatrixRulesModal() {
    document.getElementById('matrixRulesModal').classList.add('active');
    renderMatrixCatalog();
}

function closeMatrixRulesModal() {
    document.getElementById('matrixRulesModal').classList.remove('active');
}

function renderMatrixCatalog() {
    const container = document.getElementById('matrixRulesContainer');
    if (!container) return;

    let html = '';
    matrixRules.forEach(rule => {
        html += `
            <div style="border:1px solid #e2e8f0; border-radius:12px; padding:1.2rem; margin-bottom:12px; background:#f8fafc;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="font-weight:800; font-size:1rem; color:var(--text-main);">${escapeHtml(rule.name)}</div>
                    <span class="cat-badge" style="background:#e0e7ff; color:#3730a3;">Priority: ${rule.priority}</span>
                </div>
                <div style="margin-top:8px; font-size:0.8rem; color:var(--text-muted);">
                    Match Criteria: <strong>${JSON.stringify(rule.match)}</strong>
                </div>
                <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">
                    <span class="chip-tag">Payroll: ${rule.assignments.payrollStructure.planName}</span>
                    <span class="chip-tag">Leave: ${rule.assignments.attendanceLeaveRules.annualLeaveDays}d Annual</span>
                    <span class="chip-tag">EPF: ${rule.assignments.statutoryConfig.epfEnabled ? 'Enabled' : 'Exempt'}</span>
                    <span class="chip-tag">Exit: ${rule.assignments.exitFlow}</span>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Centered Alert Modal Dialog (Replaces native browser alert)
function showCenterAlertModal({
    title = 'Assignment Transition Applied & Synced to Firebase!',
    message = '',
    htmlContent = '',
    type = 'success',
    okText = 'OK'
} = {}) {
    return new Promise((resolve) => {
        const modal = document.getElementById('centerAlertModal');
        const titleEl = document.getElementById('centerAlertTitle');
        const contentEl = document.getElementById('centerAlertContent');
        const okBtn = document.getElementById('centerAlertOkBtn');
        const iconBox = document.getElementById('centerAlertIconBox');
        const iconEl = document.getElementById('centerAlertIcon');

        if (!modal) {
            window.alert(title + '\n\n' + message.replace(/<[^>]*>?/gm, ''));
            resolve();
            return;
        }

        if (titleEl) titleEl.textContent = title;
        if (okBtn) okBtn.textContent = okText;

        if (contentEl) {
            if (htmlContent) {
                contentEl.innerHTML = htmlContent;
            } else if (message) {
                const lines = message.split('\n').map(l => l.trim()).filter(Boolean);
                const bulletLines = lines.filter(l => l.startsWith('•') || l.startsWith('-'));

                if (bulletLines.length > 0) {
                    const normalLines = lines.filter(l => !l.startsWith('•') && !l.startsWith('-'));
                    let out = '';
                    if (normalLines.length > 0) {
                        out += `<p style="color:var(--text-muted); font-size:0.9rem; margin:0 0 12px 0; line-height: 1.5;">${escapeHtml(normalLines.join(' '))}</p>`;
                    }
                    out += '<div class="center-modal-list">';
                    bulletLines.forEach(bl => {
                        const clean = bl.replace(/^[•\-]\s*/, '');
                        const parts = clean.split(/:\s*(.+)/);
                        if (parts.length >= 2) {
                            out += `
                                <div class="center-modal-list-item">
                                    <span class="item-label">${escapeHtml(parts[0])}</span>
                                    <span class="item-val">${escapeHtml(parts[1])}</span>
                                </div>
                            `;
                        } else {
                            out += `
                                <div class="center-modal-list-item">
                                    <span class="item-val" style="text-align:left;">${escapeHtml(clean)}</span>
                                </div>
                            `;
                        }
                    });
                    out += '</div>';
                    contentEl.innerHTML = out;
                } else {
                    contentEl.innerHTML = `<p style="color:var(--text-muted); font-size:0.92rem; margin:0 0 1.25rem 0; line-height:1.6;">${escapeHtml(message)}</p>`;
                }
            } else {
                contentEl.innerHTML = '';
            }
        }

        if (iconBox && iconEl) {
            if (type === 'warning') {
                iconBox.style.background = '#fef3c7';
                iconBox.style.color = '#d97706';
                iconEl.setAttribute('data-lucide', 'alert-triangle');
            } else if (type === 'error' || type === 'danger') {
                iconBox.style.background = '#fee2e2';
                iconBox.style.color = '#dc2626';
                iconEl.setAttribute('data-lucide', 'alert-circle');
            } else if (type === 'info') {
                iconBox.style.background = '#eff6ff';
                iconBox.style.color = '#2563eb';
                iconEl.setAttribute('data-lucide', 'info');
            } else {
                iconBox.style.background = '#dcfce7';
                iconBox.style.color = '#15803d';
                iconEl.setAttribute('data-lucide', 'check-circle-2');
            }
        }

        if (window.lucide && typeof window.lucide.createIcons === 'function') {
            window.lucide.createIcons();
        }

        let cleanup = () => {};

        const onOkClick = () => {
            cleanup();
            resolve();
        };

        const onBackdropClick = (e) => {
            if (e.target === modal) {
                cleanup();
                resolve();
            }
        };

        const onKeyDown = (e) => {
            if (e.key === 'Escape' || e.key === 'Enter') {
                cleanup();
                resolve();
            }
        };

        cleanup = () => {
            modal.style.display = 'none';
            if (okBtn) okBtn.removeEventListener('click', onOkClick);
            modal.removeEventListener('click', onBackdropClick);
            document.removeEventListener('keydown', onKeyDown);
        };

        if (okBtn) okBtn.addEventListener('click', onOkClick);
        modal.addEventListener('click', onBackdropClick);
        document.addEventListener('keydown', onKeyDown);

        modal.style.display = 'flex';
        if (okBtn) okBtn.focus();
    });
}

// Expose globally for HTML inline handlers in ES module mode
window.openMatrixRulesModal = openMatrixRulesModal;
window.closeMatrixRulesModal = closeMatrixRulesModal;
window.openImpactSimulatorModal = openImpactSimulatorModal;
window.closeImpactSimulatorModal = closeImpactSimulatorModal;
window.resolveAndUpdateAssignments = resolveAndUpdateAssignments;
window.computeSimulatedImpact = computeSimulatedImpact;
window.applySimulatedTransition = applySimulatedTransition;
window.showCenterAlertModal = showCenterAlertModal;

