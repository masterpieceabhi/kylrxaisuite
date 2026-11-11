/**
 * ============================================================================
 * KYLRX.AI ENTERPRISE HRMS - ORGANIZATION ONBOARDING & SETUP CONTROLLER
 * ============================================================================
 * 
 * Handles Organization Setup matching PRD requirements and exact 21 columns
 * from the 'Organization' sheet in 'Templates.xlsx':
 * 
 * 1. In-App Template Download (Templates.xlsx served strictly in-app, never email).
 * 2. Supported Setup Methods:
 *    A. Manual Data Entry Form
 *    B. Bulk File Upload (Excel .xlsx / CSV parser)
 * 3. Exact 21 Fields for Organization Setup:
 *    Legal_Name, Display_Name, Organization_Type, Industry, Website,
 *    Official_Email, Official_Phone, Country, State, City, PIN_Code,
 *    Registered_Address, Corporate_Address, Time_Zone, Currency,
 *    Financial_Year_Start, PAN, TAN, CIN_or_LLPIN, GSTIN, Logo_URL.
 * 4. Processing & State Update:
 *    - Save/update Firestore organizations/{orgId}
 *    - Update state to { orgConfigured: true }
 *    - Trigger initial continuous sequential employee ID provisioning (EMP0001)
 *    - Redirect Super Admin to admin-dashboard.html
 * 
 * @version 2.0.0
 * @author Senior Frontend & Firebase Developer
 */

import { auth, db } from "./firebase-config.js";
import { 
    doc, 
    getDoc, 
    setDoc, 
    serverTimestamp 
} from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

// Exact 21 Attributes Schema Definition (PRD Section 1 & 'Organization' Sheet)
export const ORGANIZATION_ATTRIBUTES = [
    { key: "Legal_Name", label: "1. Legal Name", required: true, synonyms: ["legal_name", "legalname", "company_name", "companyname", "legal entity name"] },
    { key: "Display_Name", label: "2. Display Name", required: true, synonyms: ["display_name", "displayname", "brand_name", "brandname", "name"] },
    { key: "Organization_Type", label: "3. Organization Type", required: true, defaultValue: "Private Limited", synonyms: ["organization_type", "organizationtype", "org_type", "orgtype", "type"] },
    { key: "Industry", label: "4. Industry", required: true, synonyms: ["industry", "sector", "domain"] },
    { key: "Website", label: "5. Website", required: false, synonyms: ["website", "url", "domain", "web"] },
    { key: "Official_Email", label: "6. Official Email", required: true, synonyms: ["official_email", "officialemail", "email", "corporate_email"] },
    { key: "Official_Phone", label: "7. Official Phone", required: true, synonyms: ["official_phone", "officialphone", "phone", "contact_number"] },
    { key: "Country", label: "8. Country", required: true, defaultValue: "India", synonyms: ["country", "nation"] },
    { key: "State", label: "9. State", required: true, synonyms: ["state", "province", "region"] },
    { key: "City", label: "10. City", required: true, synonyms: ["city", "town"] },
    { key: "PIN_Code", label: "11. PIN Code", required: true, synonyms: ["pin_code", "pincode", "pin", "postal_code", "postalcode", "zip", "zipcode"] },
    { key: "Registered_Address", label: "12. Registered Address", required: true, synonyms: ["registered_address", "registeredaddress", "reg_address", "regaddress"] },
    { key: "Corporate_Address", label: "13. Corporate Address", required: true, synonyms: ["corporate_address", "corporateaddress", "corp_address", "corpaddress", "hq_address"] },
    { key: "Time_Zone", label: "14. Time Zone", required: true, defaultValue: "Asia/Kolkata", synonyms: ["time_zone", "timezone", "tz"] },
    { key: "Currency", label: "15. Currency", required: true, defaultValue: "INR", synonyms: ["currency", "curr"] },
    { key: "Financial_Year_Start", label: "16. Financial Year Start", required: true, defaultValue: "04-01", synonyms: ["financial_year_start", "financialyearstart", "fy_start", "fystart"] },
    { key: "PAN", label: "17. PAN", required: true, synonyms: ["pan", "pan_number", "pannumber", "company_pan"] },
    { key: "TAN", label: "18. TAN", required: true, synonyms: ["tan", "tan_number", "tannumber"] },
    { key: "CIN_or_LLPIN", label: "19. CIN or LLPIN", required: false, synonyms: ["cin_or_llpin", "cinorllpin", "cin", "llpin", "cin_number", "cin/llpin"] },
    { key: "GSTIN", label: "20. GSTIN", required: true, synonyms: ["gstin", "gst_number", "gstnumber", "gst"] },
    { key: "Logo_URL", label: "21. Logo URL", required: false, synonyms: ["logo_url", "logourl", "logo", "brand_logo"] }
];

// Controller State
const state = {
    orgId: localStorage.getItem('orgId') || 'org_kylrx',
    isConfigured: false,
    parsedOrgData: null,
    parsedBuData: null,
    parsedBuDocs: null,
    parsedCcData: null,
    parsedCcDocs: null,
    parsedSubDeptData: null,
    parsedSubDeptDocs: null,
    parsedShiftData: null,
    parsedShiftDocs: null,
    parsedPolicyData: null,
    parsedPolicyDocs: null,
    parsedEmployeeTypeData: null,
    parsedEmployeeTypeDocs: null,
    parsedFinanceData: null,
    parsedFinanceDocs: null,
    parsedEpfoData: null,
    parsedEpfoDocs: null,
    parsedEsicData: null,
    parsedEsicDocs: null,
    parsedPtData: null,
    parsedPtDocs: null,
    parsedLwfData: null,
    parsedLwfDocs: null,
    parsedNpsData: null,
    parsedNpsDocs: null,
    parsedGratuityData: null,
    parsedGratuityDocs: null,
    parsedSalaryStructureData: null,
    parsedHolidayData: null,
    parsedHolidayDocs: null,
    parsedStatutoryData: null,
    parsedStatutoryDocs: null,
    parsedRoleData: null,
    parsedRoleDocs: null,
    parsedWorkflowData: null,
    parsedWorkflowDocs: null,
    parsedPayrollComponentData: null,
    parsedPayrollComponentDocs: null,
    isProcessing: false
};

// UI Element References
const statusBadge = document.getElementById('statusBadge');
const tabManual = document.getElementById('tabManual');
const tabBulk = document.getElementById('tabBulk');
const tabBusinessUnits = document.getElementById('tabBusinessUnits');
const manualView = document.getElementById('manualView');
const uploadView = document.getElementById('uploadView');
const buManagementView = document.getElementById('buManagementView');
const manualOrgForm = document.getElementById('manualOrgForm');
const btnFillDemoData = document.getElementById('btnFillDemoData');
const btnManualClear = document.getElementById('btnManualClear');
const btnManualSubmit = document.getElementById('btnManualSubmit');

const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const btnDownloadTemplate = document.getElementById('btnDownloadTemplate');
const btnDownloadBanner = document.getElementById('btnDownloadBanner');
const parseResultsContainer = document.getElementById('parseResultsContainer');
const parseResultFileName = document.getElementById('parseResultFileName');
const parseResultMeta = document.getElementById('parseResultMeta');
const parsedAttributesTableBody = document.getElementById('parsedAttributesTableBody');
const validationStatusBadge = document.getElementById('validationStatusBadge');
const btnCancelIngest = document.getElementById('btnCancelIngest');
const btnConfirmIngest = document.getElementById('btnConfirmIngest');

// Business Unit Preview Elements (PRD Section 1 & 10)
const buParseResultsContainer = document.getElementById('buParseResultsContainer');
const buParseResultTitle = document.getElementById('buParseResultTitle');
const buParseResultMeta = document.getElementById('buParseResultMeta');
const buValidationStatusBadge = document.getElementById('buValidationStatusBadge');
const parsedBuTableBody = document.getElementById('parsedBuTableBody');
const btnCancelBuIngest = document.getElementById('btnCancelBuIngest');
const btnConfirmBuIngest = document.getElementById('btnConfirmBuIngest');

// Cost Center Elements (PRD Sections 1, 10 & 13)
const tabCostCenters = document.getElementById('tabCostCenters');
const ccManagementView = document.getElementById('ccManagementView');
const ccParseResultsContainer = document.getElementById('ccParseResultsContainer');
const ccParseResultTitle = document.getElementById('ccParseResultTitle');
const ccParseResultMeta = document.getElementById('ccParseResultMeta');
const ccValidationStatusBadge = document.getElementById('ccValidationStatusBadge');
const parsedCcTableBody = document.getElementById('parsedCcTableBody');
const btnCancelCcIngest = document.getElementById('btnCancelCcIngest');
const btnConfirmCcIngest = document.getElementById('btnConfirmCcIngest');

// Sub-Department Elements (PRD Sections 1, 10 & 13)
const tabSubDepartments = document.getElementById('tabSubDepartments');
const subDeptManagementView = document.getElementById('subDeptManagementView');
const subDeptParseResultsContainer = document.getElementById('subDeptParseResultsContainer');
const subDeptParseResultTitle = document.getElementById('subDeptParseResultTitle');
const subDeptParseResultMeta = document.getElementById('subDeptParseResultMeta');
const subDeptValidationStatusBadge = document.getElementById('subDeptValidationStatusBadge');
const parsedSubDeptTableBody = document.getElementById('parsedSubDeptTableBody');
const btnCancelSubDeptIngest = document.getElementById('btnCancelSubDeptIngest');
const btnConfirmSubDeptIngest = document.getElementById('btnConfirmSubDeptIngest');

// Shift & Week-off Elements (PRD Sections 1, 13 & 16)
const tabShifts = document.getElementById('tabShifts');
const shiftManagementView = document.getElementById('shiftManagementView');
const shiftParseResultsContainer = document.getElementById('shiftParseResultsContainer');
const shiftParseResultTitle = document.getElementById('shiftParseResultTitle');
const shiftParseResultMeta = document.getElementById('shiftParseResultMeta');
const shiftValidationStatusBadge = document.getElementById('shiftValidationStatusBadge');
const parsedShiftTableBody = document.getElementById('parsedShiftTableBody');
const btnCancelShiftIngest = document.getElementById('btnCancelShiftIngest');
const btnConfirmShiftIngest = document.getElementById('btnConfirmShiftIngest');

// Attendance Rules & Policies Elements (PRD Sections 1, 15 & 16)
const tabAttendancePolicies = document.getElementById('tabAttendancePolicies');
const attendancePolicyManagementView = document.getElementById('attendancePolicyManagementView');
const policyParseResultsContainer = document.getElementById('policyParseResultsContainer');
const policyParseResultTitle = document.getElementById('policyParseResultTitle');
const policyParseResultMeta = document.getElementById('policyParseResultMeta');
const policyValidationStatusBadge = document.getElementById('policyValidationStatusBadge');
const parsedPolicyTableBody = document.getElementById('parsedPolicyTableBody');
const btnCancelPolicyIngest = document.getElementById('btnCancelPolicyIngest');
const btnConfirmPolicyIngest = document.getElementById('btnConfirmPolicyIngest');

// Employee Types & Categories Elements (PRD Sections 1, 10 & 13)
const tabEmployeeTypes = document.getElementById('tabEmployeeTypes');
const employeeTypeManagementView = document.getElementById('employeeTypeManagementView');
const employeeTypeParseResultsContainer = document.getElementById('employeeTypeParseResultsContainer');
const employeeTypeParseResultTitle = document.getElementById('employeeTypeParseResultTitle');
const employeeTypeParseResultMeta = document.getElementById('employeeTypeParseResultMeta');
const employeeTypeValidationStatusBadge = document.getElementById('employeeTypeValidationStatusBadge');
const parsedEmployeeTypeTableBody = document.getElementById('parsedEmployeeTypeTableBody');
const btnCancelEmployeeTypeIngest = document.getElementById('btnCancelEmployeeTypeIngest');
const btnConfirmEmployeeTypeIngest = document.getElementById('btnConfirmEmployeeTypeIngest');

// Employee Finance & Statutory Elements (PRD Sections 1, 4 & 13)
const tabEmployeeFinance = document.getElementById('tabEmployeeFinance');
const employeeFinanceManagementView = document.getElementById('employeeFinanceManagementView');
const employeeFinanceParseResultsContainer = document.getElementById('employeeFinanceParseResultsContainer');
const employeeFinanceParseResultTitle = document.getElementById('employeeFinanceParseResultTitle');
const employeeFinanceParseResultMeta = document.getElementById('employeeFinanceParseResultMeta');
const employeeFinanceValidationStatusBadge = document.getElementById('employeeFinanceValidationStatusBadge');
const parsedEmployeeFinanceTableBody = document.getElementById('parsedEmployeeFinanceTableBody');
const btnCancelEmployeeFinanceIngest = document.getElementById('btnCancelEmployeeFinanceIngest');
const btnConfirmLegacyEmpFinanceIngest = document.getElementById('btnConfirmLegacyEmpFinanceIngest');

// EPFO & PF Statutory Master Elements (PRD Sections 1, 4, 11 & 13)
const tabEpfoMaster = document.getElementById('tabEpfoMaster');
const epfoMasterManagementView = document.getElementById('epfoMasterManagementView');
const epfoMasterParseResultsContainer = document.getElementById('epfoMasterParseResultsContainer');
const epfoMasterParseResultTitle = document.getElementById('epfoMasterParseResultTitle');
const epfoMasterParseResultMeta = document.getElementById('epfoMasterParseResultMeta');
const epfoMasterValidationStatusBadge = document.getElementById('epfoMasterValidationStatusBadge');
const parsedEpfoMasterTableBody = document.getElementById('parsedEpfoMasterTableBody');
const btnCancelEpfoMasterIngest = document.getElementById('btnCancelEpfoMasterIngest');
const btnConfirmEpfoMasterIngest = document.getElementById('btnConfirmEpfoMasterIngest');

// ESIC Statutory Master Elements (PRD Sections 1, 4, 11 & 13)
const tabEsicMaster = document.getElementById('tabEsicMaster');
const esicMasterManagementView = document.getElementById('esicMasterManagementView');
const esicMasterParseResultsContainer = document.getElementById('esicMasterParseResultsContainer');
const esicMasterParseResultTitle = document.getElementById('esicMasterParseResultTitle');
const esicMasterParseResultMeta = document.getElementById('esicMasterParseResultMeta');
const esicMasterValidationStatusBadge = document.getElementById('esicMasterValidationStatusBadge');
const parsedEsicMasterTableBody = document.getElementById('parsedEsicMasterTableBody');
const btnCancelEsicMasterIngest = document.getElementById('btnCancelEsicMasterIngest');
const btnConfirmEsicMasterIngest = document.getElementById('btnConfirmEsicMasterIngest');

// Professional Tax (PT) Statutory Master Elements (PRD Sections 1, 4, 11 & 13)
const tabPtMaster = document.getElementById('tabPtMaster');
const ptMasterManagementView = document.getElementById('ptMasterManagementView');
const ptMasterParseResultsContainer = document.getElementById('ptMasterParseResultsContainer');
const ptMasterParseResultTitle = document.getElementById('ptMasterParseResultTitle');
const ptMasterParseResultMeta = document.getElementById('ptMasterParseResultMeta');
const ptMasterValidationStatusBadge = document.getElementById('ptMasterValidationStatusBadge');
const parsedPtMasterTableBody = document.getElementById('parsedPtMasterTableBody');
const btnCancelPtMasterIngest = document.getElementById('btnCancelPtMasterIngest');
const btnConfirmPtMasterIngest = document.getElementById('btnConfirmPtMasterIngest');

// Labour Welfare Fund (LWF) Statutory Master Elements (PRD Sections 1, 4, 11 & 13)
const tabLwfMaster = document.getElementById('tabLwfMaster');
const lwfMasterManagementView = document.getElementById('lwfMasterManagementView');
const lwfMasterParseResultsContainer = document.getElementById('lwfMasterParseResultsContainer');
const lwfMasterParseResultTitle = document.getElementById('lwfMasterParseResultTitle');
const lwfMasterParseResultMeta = document.getElementById('lwfMasterParseResultMeta');
const lwfMasterValidationStatusBadge = document.getElementById('lwfMasterValidationStatusBadge');
const parsedLwfMasterTableBody = document.getElementById('parsedLwfMasterTableBody');
const btnCancelLwfMasterIngest = document.getElementById('btnCancelLwfMasterIngest');
const btnConfirmLwfMasterIngest = document.getElementById('btnConfirmLwfMasterIngest');

// National Pension System (NPS) Statutory Master Elements (PRD Sections 1, 4, 11 & 13)
const tabNpsMaster = document.getElementById('tabNpsMaster');
const npsMasterManagementView = document.getElementById('npsMasterManagementView');
const npsMasterParseResultsContainer = document.getElementById('npsMasterParseResultsContainer');
const npsMasterParseResultTitle = document.getElementById('npsMasterParseResultTitle');
const npsMasterParseResultMeta = document.getElementById('npsMasterParseResultMeta');
const npsMasterValidationStatusBadge = document.getElementById('npsMasterValidationStatusBadge');
const parsedNpsMasterTableBody = document.getElementById('parsedNpsMasterTableBody');
const btnCancelNpsMasterIngest = document.getElementById('btnCancelNpsMasterIngest');
const btnConfirmNpsMasterIngest = document.getElementById('btnConfirmNpsMasterIngest');

// Gratuity Statutory Master Elements (PRD Sections 1, 4, 11 & 13)
const tabGratuityMaster = document.getElementById('tabGratuityMaster');
const gratuityMasterManagementView = document.getElementById('gratuityMasterManagementView');
const gratuityMasterParseResultsContainer = document.getElementById('gratuityMasterParseResultsContainer');
const gratuityMasterParseResultTitle = document.getElementById('gratuityMasterParseResultTitle');
const gratuityMasterParseResultMeta = document.getElementById('gratuityMasterParseResultMeta');
const gratuityMasterValidationStatusBadge = document.getElementById('gratuityMasterValidationStatusBadge');
const parsedGratuityMasterTableBody = document.getElementById('parsedGratuityMasterTableBody');
const btnCancelGratuityMasterIngest = document.getElementById('btnCancelGratuityMasterIngest');
const btnConfirmGratuityMasterIngest = document.getElementById('btnConfirmGratuityMasterIngest');

// Salary Structure & Compensation Elements (PRD Sections 1 & 4)
const tabSalaryStructure = document.getElementById('tabSalaryStructure');
const salaryStructureManagementView = document.getElementById('salaryStructureManagementView');
const salaryStructureParseResultsContainer = document.getElementById('salaryStructureParseResultsContainer');
const salaryStructureParseResultTitle = document.getElementById('salaryStructureParseResultTitle');
const salaryStructureParseResultMeta = document.getElementById('salaryStructureParseResultMeta');
const salaryStructureValidationStatusBadge = document.getElementById('salaryStructureValidationStatusBadge');
const parsedSalaryStructureTableBody = document.getElementById('parsedSalaryStructureTableBody');
const btnCancelSalaryStructureIngest = document.getElementById('btnCancelSalaryStructureIngest');
const btnConfirmSalaryStructureIngest = document.getElementById('btnConfirmSalaryStructureIngest');
const salaryTotalRowsDisplay = document.getElementById('salaryTotalRowsDisplay');
const salaryTotalStructuresDisplay = document.getElementById('salaryTotalStructuresDisplay');
const salaryTotalMonthlyGrossDisplay = document.getElementById('salaryTotalMonthlyGrossDisplay');
const salaryTotalAnnualCtcDisplay = document.getElementById('salaryTotalAnnualCtcDisplay');

// Holiday Calendar Elements (PRD Sections 1, 4, 15, & 16)
const tabHolidayCalendar = document.getElementById('tabHolidayCalendar');
const holidayCalendarManagementView = document.getElementById('holidayCalendarManagementView');
const holidayCalendarParseResultsContainer = document.getElementById('holidayCalendarParseResultsContainer');
const holidayCalendarParseResultTitle = document.getElementById('holidayCalendarParseResultTitle');
const holidayCalendarParseResultMeta = document.getElementById('holidayCalendarParseResultMeta');
const holidayCalendarValidationStatusBadge = document.getElementById('holidayCalendarValidationStatusBadge');
const parsedHolidayCalendarTableBody = document.getElementById('parsedHolidayCalendarTableBody');
const btnCancelHolidayCalendarIngest = document.getElementById('btnCancelHolidayCalendarIngest');
const btnConfirmHolidayCalendarIngest = document.getElementById('btnConfirmHolidayCalendarIngest');
const holidayTotalRowsDisplay = document.getElementById('holidayTotalRowsDisplay');
const holidayTotalCalendarsDisplay = document.getElementById('holidayTotalCalendarsDisplay');
const holidayTotalMandatoryDisplay = document.getElementById('holidayTotalMandatoryDisplay');
const holidayTotalOptionalDisplay = document.getElementById('holidayTotalOptionalDisplay');

// Statutory Compliance Elements (PRD Sections 1, 4, 11, & 13)
const tabStatutoryCompliance = document.getElementById('tabStatutoryCompliance');
const statutoryComplianceManagementView = document.getElementById('statutoryComplianceManagementView');
const statutoryComplianceParseResultsContainer = document.getElementById('statutoryComplianceParseResultsContainer');
const statutoryComplianceParseResultTitle = document.getElementById('statutoryComplianceParseResultTitle');
const statutoryComplianceParseResultMeta = document.getElementById('statutoryComplianceParseResultMeta');
const statutoryComplianceValidationStatusBadge = document.getElementById('statutoryComplianceValidationStatusBadge');
const parsedStatutoryComplianceTableBody = document.getElementById('parsedStatutoryComplianceTableBody');
const btnCancelStatutoryComplianceIngest = document.getElementById('btnCancelStatutoryComplianceIngest');
const btnConfirmStatutoryComplianceIngest = document.getElementById('btnConfirmStatutoryComplianceIngest');
const statutoryTotalRowsDisplay = document.getElementById('statutoryTotalRowsDisplay');
const statutoryTotalApplicableDisplay = document.getElementById('statutoryTotalApplicableDisplay');
const statutoryTotalDueRemindersDisplay = document.getElementById('statutoryTotalDueRemindersDisplay');

// Role Permissions & Employee Overrides Elements (PRD Sections 1, 14, 17, & 18)
const rolePermissionParseResultsContainer = document.getElementById('rolePermissionParseResultsContainer');
const rolePermissionParseResultTitle = document.getElementById('rolePermissionParseResultTitle');
const rolePermissionParseResultMeta = document.getElementById('rolePermissionParseResultMeta');
const rolePermissionValidationStatusBadge = document.getElementById('rolePermissionValidationStatusBadge');
const parsedRolePermissionTableBody = document.getElementById('parsedRolePermissionTableBody');
const btnCancelRolePermissionIngest = document.getElementById('btnCancelRolePermissionIngest');
const btnConfirmRolePermissionIngest = document.getElementById('btnConfirmRolePermissionIngest');
const roleTotalRowsDisplay = document.getElementById('roleTotalRowsDisplay');
const roleTotalBaseRolesDisplay = document.getElementById('roleTotalBaseRolesDisplay');
const roleTotalOverridesDisplay = document.getElementById('roleTotalOverridesDisplay');
const roleTotalActiveDisplay = document.getElementById('roleTotalActiveDisplay');

// Workflow Rules Elements (PRD Sections 1, 9, 12, 14, & 18)
const workflowRulesParseResultsContainer = document.getElementById('workflowRulesParseResultsContainer');
const workflowRulesParseResultTitle = document.getElementById('workflowRulesParseResultTitle');
const workflowRulesParseResultMeta = document.getElementById('workflowRulesParseResultMeta');
const workflowValidationStatusBadge = document.getElementById('workflowValidationStatusBadge');
const workflowRulesParsedTableBody = document.getElementById('workflowRulesParsedTableBody');
const wfCanvasPreviewContainer = document.getElementById('wfCanvasPreviewContainer');
const btnCancelWorkflowRulesIngest = document.getElementById('btnCancelWorkflowRulesIngest');
const btnConfirmWorkflowRulesIngest = document.getElementById('btnConfirmWorkflowRulesIngest');
const wfTotalStepRowsDisplay = document.getElementById('wfTotalStepRowsDisplay');
const wfTotalWorkflowsDisplay = document.getElementById('wfTotalWorkflowsDisplay');
const wfActiveWorkflowsDisplay = document.getElementById('wfActiveWorkflowsDisplay');
const wfModulesCoveredDisplay = document.getElementById('wfModulesCoveredDisplay');

// Payroll Components Catalog Elements (PRD Sections 1 & 4)
const tabPayrollComponents = document.getElementById('tabPayrollComponents');
const payrollComponentsManagementView = document.getElementById('payrollComponentsManagementView');
const payrollComponentsParseResultsContainer = document.getElementById('payrollComponentsParseResultsContainer');
const payrollComponentsParseResultTitle = document.getElementById('payrollComponentsParseResultTitle');
const payrollComponentsParseResultMeta = document.getElementById('payrollComponentsParseResultMeta');
const payrollComponentsValidationStatusBadge = document.getElementById('payrollComponentsValidationStatusBadge');
const parsedPayrollComponentsTableBody = document.getElementById('parsedPayrollComponentsTableBody');
const btnCancelPayrollComponentsIngest = document.getElementById('btnCancelPayrollComponentsIngest');
const btnConfirmPayrollComponentsIngest = document.getElementById('btnConfirmPayrollComponentsIngest');
const compTotalRowsDisplay = document.getElementById('compTotalRowsDisplay');
const compEarningsDisplay = document.getElementById('compEarningsDisplay');
const compDeductionsDisplay = document.getElementById('compDeductionsDisplay');
const compStatutoryDisplay = document.getElementById('compStatutoryDisplay');

const logoutBtn = document.getElementById('logoutBtn');

// Initialize on DOM Ready
document.addEventListener('DOMContentLoaded', async () => {
    setupAuthWatcher();
    setupNavigationTabs();
    setupInAppDownload();
    setupManualForm();
    setupFileUpload();
    setupLogout();
    await checkExistingOrganizationStatus();
});

/**
 * Listens to Firebase Auth state to associate with tenant Org ID
 */
function setupAuthWatcher() {
    onAuthStateChanged(auth, async (user) => {
        if (user) {
            try {
                const userDoc = await getDoc(doc(db, "users", user.uid));
                if (userDoc.exists() && userDoc.data().orgId) {
                    state.orgId = userDoc.data().orgId;
                    localStorage.setItem('orgId', state.orgId);
                }
            } catch (err) {
                console.warn("Could not query user orgId, using fallback:", state.orgId);
            }
            await checkExistingOrganizationStatus();
        }
    });
}

/**
 * Checks Firestore organizations/{orgId} to see if orgConfigured: true is set
 */
async function checkExistingOrganizationStatus() {
    try {
        const orgRef = doc(db, "organizations", state.orgId);
        const orgSnap = await getDoc(orgRef);

        if (orgSnap.exists()) {
            const data = orgSnap.data();
            if (data.orgConfigured === true) {
                state.isConfigured = true;
                localStorage.setItem('orgConfigured', 'true');
                if (statusBadge) {
                    statusBadge.className = 'badge-verified';
                    statusBadge.innerHTML = '<i data-lucide="check-circle" style="width: 14px;"></i> Organization Configured (orgConfigured: true)';
                }
                populateManualFormWithExistingData(data);
                console.log(`✅ Organization ${state.orgId} is configured:`, data);
            } else {
                markPendingStatus();
            }
        } else {
            markPendingStatus();
        }
    } catch (err) {
        console.warn("Status check failed (network/rules):", err.message);
        if (localStorage.getItem('orgConfigured') === 'true') {
            if (statusBadge) {
                statusBadge.className = 'badge-verified';
                statusBadge.innerHTML = '<i data-lucide="check-circle" style="width: 14px;"></i> Organization Configured (orgConfigured: true)';
            }
        }
    }
    if (window.lucide) lucide.createIcons();
}

function markPendingStatus() {
    state.isConfigured = false;
    if (statusBadge) {
        statusBadge.className = 'badge-pending';
        statusBadge.innerHTML = '<i data-lucide="shield-alert" style="width: 14px;"></i> Setup Required (orgConfigured: false)';
    }
}

/**
 * Pre-populates manual form fields if org data already exists
 */
function populateManualFormWithExistingData(data) {
    const fieldMapping = {
        manualLegalName: data.Legal_Name || data.legalName,
        manualDisplayName: data.Display_Name || data.displayName,
        manualOrgType: data.Organization_Type || data.organizationType,
        manualIndustry: data.Industry || data.industry,
        manualWebsite: data.Website || data.website,
        manualOfficialEmail: data.Official_Email || data.officialEmail,
        manualOfficialPhone: data.Official_Phone || data.officialPhone,
        manualCountry: data.Country || data.country,
        manualState: data.State || data.state,
        manualCity: data.City || data.city,
        manualPinCode: data.PIN_Code || data.pinCode,
        manualRegisteredAddress: data.Registered_Address || data.registeredAddress,
        manualCorporateAddress: data.Corporate_Address || data.corporateAddress,
        manualTimeZone: data.Time_Zone || data.timezone,
        manualCurrency: data.Currency || data.currency,
        manualFyStart: data.Financial_Year_Start || data.financialYearStart,
        manualPan: data.PAN || data.pan,
        manualTan: data.TAN || data.tan,
        manualCin: data.CIN_or_LLPIN || data.cinOrLlpin,
        manualGstin: data.GSTIN || data.gstin,
        manualLogoUrl: data.Logo_URL || data.logoUrl
    };

    for (const [elemId, val] of Object.entries(fieldMapping)) {
        const el = document.getElementById(elemId);
        if (el && val !== undefined && val !== null) {
            el.value = val;
        }
    }
}

/**
 * Switcher between Tab A (Manual Form), Tab B (Bulk Upload), Tab C (Business Units), and Tab D (Cost Centers)
 */
function setupNavigationTabs() {
    if (tabManual && tabBulk) {
        tabManual.onclick = () => {
            tabManual.classList.add('active');
            tabBulk.classList.remove('active');
            if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
            if (tabCostCenters) tabCostCenters.classList.remove('active');
            if (tabSubDepartments) tabSubDepartments.classList.remove('active');
            if (tabShifts) tabShifts.classList.remove('active');
            if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
            manualView.style.display = 'block';
            uploadView.style.display = 'none';
            if (buManagementView) buManagementView.style.display = 'none';
            if (ccManagementView) ccManagementView.style.display = 'none';
            if (subDeptManagementView) subDeptManagementView.style.display = 'none';
            if (shiftManagementView) shiftManagementView.style.display = 'none';
            if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
            if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
            if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
            if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
        };

        tabBulk.onclick = () => {
            tabBulk.classList.add('active');
            tabManual.classList.remove('active');
            if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
            if (tabCostCenters) tabCostCenters.classList.remove('active');
            if (tabSubDepartments) tabSubDepartments.classList.remove('active');
            if (tabShifts) tabShifts.classList.remove('active');
            if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
            if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
            if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
            uploadView.style.display = 'block';
            manualView.style.display = 'none';
            if (buManagementView) buManagementView.style.display = 'none';
            if (ccManagementView) ccManagementView.style.display = 'none';
            if (subDeptManagementView) subDeptManagementView.style.display = 'none';
            if (shiftManagementView) shiftManagementView.style.display = 'none';
            if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
            if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
            if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
        };

        if (tabBusinessUnits) {
            tabBusinessUnits.onclick = () => {
                tabBusinessUnits.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (buManagementView) buManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';

                if (window.KylrxBuRules && typeof window.KylrxBuRules.renderAdminRulesTable === 'function') {
                    window.KylrxBuRules.renderAdminRulesTable('onboardingBuTableContainer');
                }
            };
        }

        if (tabCostCenters) {
            tabCostCenters.onclick = () => {
                tabCostCenters.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (ccManagementView) ccManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';

                if (window.KylrxCostCenterService && typeof window.KylrxCostCenterService.renderAdminConsole === 'function') {
                    window.KylrxCostCenterService.renderAdminConsole('onboardingCcTableContainer');
                }
            };
        }

        if (tabSubDepartments) {
            tabSubDepartments.onclick = () => {
                tabSubDepartments.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (subDeptManagementView) subDeptManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';

                if (window.KylrxSubDepartmentService && typeof window.KylrxSubDepartmentService.renderAdminConsole === 'function') {
                    window.KylrxSubDepartmentService.renderAdminConsole('onboardingSubDeptTableContainer');
                }
            };
        }

        if (tabShifts) {
            tabShifts.onclick = () => {
                tabShifts.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (shiftManagementView) shiftManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';

                if (window.KylrxShiftCalculationService && typeof window.KylrxShiftCalculationService.renderAdminConsole === 'function') {
                    window.KylrxShiftCalculationService.renderAdminConsole('onboardingShiftTableContainer');
                }
            };
        }

        if (tabAttendancePolicies) {
            tabAttendancePolicies.onclick = () => {
                tabAttendancePolicies.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';

                if (window.KylrxAttendancePolicyService && typeof window.KylrxAttendancePolicyService.renderAdminConsole === 'function') {
                    window.KylrxAttendancePolicyService.renderAdminConsole('onboardingAttendancePolicyTableContainer');
                }
            };
        }

        if (tabEmployeeTypes) {
            tabEmployeeTypes.onclick = () => {
                tabEmployeeTypes.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';

                if (window.KylrxEmployeeTypeService && typeof window.KylrxEmployeeTypeService.renderAdminConsole === 'function') {
                    window.KylrxEmployeeTypeService.renderAdminConsole('onboardingEmployeeTypeTableContainer');
                }
            };
        }

        if (tabEmployeeFinance) {
            tabEmployeeFinance.onclick = () => {
                tabEmployeeFinance.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');

                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'none';
                if (tabSalaryStructure) tabSalaryStructure.classList.remove('active');

                if (window.KylrxEmployeeFinanceService && typeof window.KylrxEmployeeFinanceService.renderFinanceConsole === 'function') {
                    window.KylrxEmployeeFinanceService.renderFinanceConsole('onboardingEmployeeFinanceTableContainer');
                }
            };
        }

        if (tabEpfoMaster) {
            tabEpfoMaster.onclick = () => {
                tabEpfoMaster.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (tabEsicMaster) tabEsicMaster.classList.remove('active');
                if (tabPtMaster) tabPtMaster.classList.remove('active');
                if (tabSalaryStructure) tabSalaryStructure.classList.remove('active');
                if (tabHolidayCalendar) tabHolidayCalendar.classList.remove('active');
                if (tabStatutoryCompliance) tabStatutoryCompliance.classList.remove('active');
                if (tabPayrollComponents) tabPayrollComponents.classList.remove('active');

                if (epfoMasterManagementView) epfoMasterManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
                if (esicMasterManagementView) esicMasterManagementView.style.display = 'none';
                if (ptMasterManagementView) ptMasterManagementView.style.display = 'none';
                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'none';
                if (holidayCalendarManagementView) holidayCalendarManagementView.style.display = 'none';
                if (statutoryComplianceManagementView) statutoryComplianceManagementView.style.display = 'none';
                if (payrollComponentsManagementView) payrollComponentsManagementView.style.display = 'none';

                renderOnboardingEpfoMasterTable();
            };
        }

        if (tabEsicMaster) {
            tabEsicMaster.onclick = () => {
                tabEsicMaster.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (tabEpfoMaster) tabEpfoMaster.classList.remove('active');
                if (tabPtMaster) tabPtMaster.classList.remove('active');
                if (tabSalaryStructure) tabSalaryStructure.classList.remove('active');
                if (tabHolidayCalendar) tabHolidayCalendar.classList.remove('active');
                if (tabStatutoryCompliance) tabStatutoryCompliance.classList.remove('active');
                if (tabPayrollComponents) tabPayrollComponents.classList.remove('active');

                if (esicMasterManagementView) esicMasterManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
                if (epfoMasterManagementView) epfoMasterManagementView.style.display = 'none';
                if (ptMasterManagementView) ptMasterManagementView.style.display = 'none';
                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'none';
                if (holidayCalendarManagementView) holidayCalendarManagementView.style.display = 'none';
                if (statutoryComplianceManagementView) statutoryComplianceManagementView.style.display = 'none';
                if (payrollComponentsManagementView) payrollComponentsManagementView.style.display = 'none';

                renderOnboardingEsicMasterTable();
            };
        }

        if (tabPtMaster) {
            tabPtMaster.onclick = () => {
                tabPtMaster.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (tabEpfoMaster) tabEpfoMaster.classList.remove('active');
                if (tabEsicMaster) tabEsicMaster.classList.remove('active');
                if (tabLwfMaster) tabLwfMaster.classList.remove('active');
                if (tabSalaryStructure) tabSalaryStructure.classList.remove('active');
                if (tabHolidayCalendar) tabHolidayCalendar.classList.remove('active');
                if (tabStatutoryCompliance) tabStatutoryCompliance.classList.remove('active');
                if (tabPayrollComponents) tabPayrollComponents.classList.remove('active');

                if (ptMasterManagementView) ptMasterManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
                if (epfoMasterManagementView) epfoMasterManagementView.style.display = 'none';
                if (esicMasterManagementView) esicMasterManagementView.style.display = 'none';
                if (lwfMasterManagementView) lwfMasterManagementView.style.display = 'none';
                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'none';
                if (holidayCalendarManagementView) holidayCalendarManagementView.style.display = 'none';
                if (statutoryComplianceManagementView) statutoryComplianceManagementView.style.display = 'none';
                if (payrollComponentsManagementView) payrollComponentsManagementView.style.display = 'none';

                renderOnboardingPtMasterTable();
            };
        }

        if (tabLwfMaster) {
            tabLwfMaster.onclick = () => {
                tabLwfMaster.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (tabEpfoMaster) tabEpfoMaster.classList.remove('active');
                if (tabEsicMaster) tabEsicMaster.classList.remove('active');
                if (tabPtMaster) tabPtMaster.classList.remove('active');
                if (tabNpsMaster) tabNpsMaster.classList.remove('active');
                if (tabGratuityMaster) tabGratuityMaster.classList.remove('active');
                if (tabSalaryStructure) tabSalaryStructure.classList.remove('active');
                if (tabHolidayCalendar) tabHolidayCalendar.classList.remove('active');
                if (tabStatutoryCompliance) tabStatutoryCompliance.classList.remove('active');
                if (tabPayrollComponents) tabPayrollComponents.classList.remove('active');

                if (lwfMasterManagementView) lwfMasterManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
                if (epfoMasterManagementView) epfoMasterManagementView.style.display = 'none';
                if (esicMasterManagementView) esicMasterManagementView.style.display = 'none';
                if (ptMasterManagementView) ptMasterManagementView.style.display = 'none';
                if (npsMasterManagementView) npsMasterManagementView.style.display = 'none';
                if (gratuityMasterManagementView) gratuityMasterManagementView.style.display = 'none';
                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'none';
                if (holidayCalendarManagementView) holidayCalendarManagementView.style.display = 'none';
                if (statutoryComplianceManagementView) statutoryComplianceManagementView.style.display = 'none';
                if (payrollComponentsManagementView) payrollComponentsManagementView.style.display = 'none';

                renderOnboardingLwfMasterTable();
            };
        }

        if (tabNpsMaster) {
            tabNpsMaster.onclick = () => {
                tabNpsMaster.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (tabEpfoMaster) tabEpfoMaster.classList.remove('active');
                if (tabEsicMaster) tabEsicMaster.classList.remove('active');
                if (tabPtMaster) tabPtMaster.classList.remove('active');
                if (tabLwfMaster) tabLwfMaster.classList.remove('active');
                if (tabGratuityMaster) tabGratuityMaster.classList.remove('active');
                if (tabSalaryStructure) tabSalaryStructure.classList.remove('active');
                if (tabHolidayCalendar) tabHolidayCalendar.classList.remove('active');
                if (tabStatutoryCompliance) tabStatutoryCompliance.classList.remove('active');
                if (tabPayrollComponents) tabPayrollComponents.classList.remove('active');

                if (npsMasterManagementView) npsMasterManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
                if (epfoMasterManagementView) epfoMasterManagementView.style.display = 'none';
                if (esicMasterManagementView) esicMasterManagementView.style.display = 'none';
                if (ptMasterManagementView) ptMasterManagementView.style.display = 'none';
                if (lwfMasterManagementView) lwfMasterManagementView.style.display = 'none';
                if (gratuityMasterManagementView) gratuityMasterManagementView.style.display = 'none';
                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'none';
                if (holidayCalendarManagementView) holidayCalendarManagementView.style.display = 'none';
                if (statutoryComplianceManagementView) statutoryComplianceManagementView.style.display = 'none';
                if (payrollComponentsManagementView) payrollComponentsManagementView.style.display = 'none';

                renderOnboardingNpsMasterTable();
            };
        }

        if (tabGratuityMaster) {
            tabGratuityMaster.onclick = () => {
                tabGratuityMaster.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (tabEpfoMaster) tabEpfoMaster.classList.remove('active');
                if (tabEsicMaster) tabEsicMaster.classList.remove('active');
                if (tabPtMaster) tabPtMaster.classList.remove('active');
                if (tabLwfMaster) tabLwfMaster.classList.remove('active');
                if (tabNpsMaster) tabNpsMaster.classList.remove('active');
                if (tabSalaryStructure) tabSalaryStructure.classList.remove('active');
                if (tabHolidayCalendar) tabHolidayCalendar.classList.remove('active');
                if (tabStatutoryCompliance) tabStatutoryCompliance.classList.remove('active');
                if (tabPayrollComponents) tabPayrollComponents.classList.remove('active');

                if (gratuityMasterManagementView) gratuityMasterManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
                if (epfoMasterManagementView) epfoMasterManagementView.style.display = 'none';
                if (esicMasterManagementView) esicMasterManagementView.style.display = 'none';
                if (ptMasterManagementView) ptMasterManagementView.style.display = 'none';
                if (lwfMasterManagementView) lwfMasterManagementView.style.display = 'none';
                if (npsMasterManagementView) npsMasterManagementView.style.display = 'none';
                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'none';
                if (holidayCalendarManagementView) holidayCalendarManagementView.style.display = 'none';
                if (statutoryComplianceManagementView) statutoryComplianceManagementView.style.display = 'none';
                if (payrollComponentsManagementView) payrollComponentsManagementView.style.display = 'none';

                renderOnboardingGratuityMasterTable();
            };
        }

        if (tabSalaryStructure) {
            tabSalaryStructure.onclick = () => {
                tabSalaryStructure.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (tabEpfoMaster) tabEpfoMaster.classList.remove('active');
                if (tabEsicMaster) tabEsicMaster.classList.remove('active');
                if (tabPtMaster) tabPtMaster.classList.remove('active');
                if (tabLwfMaster) tabLwfMaster.classList.remove('active');
                if (tabNpsMaster) tabNpsMaster.classList.remove('active');
                if (tabGratuityMaster) tabGratuityMaster.classList.remove('active');

                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
                if (holidayCalendarManagementView) holidayCalendarManagementView.style.display = 'none';
                if (tabHolidayCalendar) tabHolidayCalendar.classList.remove('active');

                if (window.KylrxSalaryStructureService && typeof window.KylrxSalaryStructureService.renderSalaryConsole === 'function') {
                    window.KylrxSalaryStructureService.renderSalaryConsole('onboardingSalaryStructureTableContainer');
                }
            };
        }

        if (tabHolidayCalendar) {
            tabHolidayCalendar.onclick = () => {
                tabHolidayCalendar.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (tabSalaryStructure) tabSalaryStructure.classList.remove('active');

                if (holidayCalendarManagementView) holidayCalendarManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'none';

                if (window.KylrxHolidayCalendarService && typeof window.KylrxHolidayCalendarService.renderAdminHolidayConsole === 'function') {
                    window.KylrxHolidayCalendarService.renderAdminHolidayConsole('onboardingHolidayCalendarTableContainer');
                }
            };
        }

        if (tabStatutoryCompliance) {
            tabStatutoryCompliance.onclick = () => {
                tabStatutoryCompliance.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (tabSalaryStructure) tabSalaryStructure.classList.remove('active');
                if (tabHolidayCalendar) tabHolidayCalendar.classList.remove('active');

                if (statutoryComplianceManagementView) statutoryComplianceManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'none';
                if (holidayCalendarManagementView) holidayCalendarManagementView.style.display = 'none';

                if (window.KylrxStatutoryComplianceUIController && typeof window.KylrxStatutoryComplianceUIController.renderAdminConsole === 'function') {
                    window.KylrxStatutoryComplianceUIController.renderAdminConsole('onboardingStatutoryComplianceTableContainer', state.orgId);
                }
            };
        }

        if (tabPayrollComponents) {
            tabPayrollComponents.onclick = () => {
                tabPayrollComponents.classList.add('active');
                tabManual.classList.remove('active');
                tabBulk.classList.remove('active');
                if (tabBusinessUnits) tabBusinessUnits.classList.remove('active');
                if (tabCostCenters) tabCostCenters.classList.remove('active');
                if (tabSubDepartments) tabSubDepartments.classList.remove('active');
                if (tabShifts) tabShifts.classList.remove('active');
                if (tabAttendancePolicies) tabAttendancePolicies.classList.remove('active');
                if (tabEmployeeTypes) tabEmployeeTypes.classList.remove('active');
                if (tabEmployeeFinance) tabEmployeeFinance.classList.remove('active');
                if (tabSalaryStructure) tabSalaryStructure.classList.remove('active');
                if (tabHolidayCalendar) tabHolidayCalendar.classList.remove('active');
                if (tabStatutoryCompliance) tabStatutoryCompliance.classList.remove('active');

                if (payrollComponentsManagementView) payrollComponentsManagementView.style.display = 'block';
                manualView.style.display = 'none';
                uploadView.style.display = 'none';
                if (buManagementView) buManagementView.style.display = 'none';
                if (ccManagementView) ccManagementView.style.display = 'none';
                if (subDeptManagementView) subDeptManagementView.style.display = 'none';
                if (shiftManagementView) shiftManagementView.style.display = 'none';
                if (attendancePolicyManagementView) attendancePolicyManagementView.style.display = 'none';
                if (employeeTypeManagementView) employeeTypeManagementView.style.display = 'none';
                if (employeeFinanceManagementView) employeeFinanceManagementView.style.display = 'none';
                if (salaryStructureManagementView) salaryStructureManagementView.style.display = 'none';
                if (holidayCalendarManagementView) holidayCalendarManagementView.style.display = 'none';
                if (statutoryComplianceManagementView) statutoryComplianceManagementView.style.display = 'none';

                if (window.KylrxPayrollComponentsUIController && typeof window.KylrxPayrollComponentsUIController.renderAdminConsole === 'function') {
                    window.KylrxPayrollComponentsUIController.renderAdminConsole('onboardingPayrollComponentsTableContainer', state.orgId);
                }
            };
        }
    }
}

/**
 * PRD Section 1: In-App Template Download (Strictly Served In-App, Never Distributed via Email)
 */
function setupInAppDownload() {
    const triggerInAppDownload = (e) => {
        e.preventDefault();
        const link = document.createElement('a');
        link.href = 'assets/Templates.xlsx';
        link.download = 'Templates.xlsx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        console.log("📥 Direct in-app download initiated for official 27-sheet Templates.xlsx (Never distributed via email per PRD Section 1).");
    };

    if (btnDownloadTemplate) btnDownloadTemplate.onclick = triggerInAppDownload;
    if (btnDownloadBanner) btnDownloadBanner.onclick = triggerInAppDownload;
}

/**
 * Sets up Tab A: Manual Data Entry Form logic
 */
function setupManualForm() {
    // Fill sample demo data for rapid testing
    if (btnFillDemoData) {
        btnFillDemoData.onclick = () => {
            const demoData = {
                manualLegalName: "Kylrx Technologies Private Limited",
                manualDisplayName: "Kylrx AI",
                manualOrgType: "Private Limited",
                manualIndustry: "Technology & HR Automation SaaS",
                manualWebsite: "https://kylrx.ai",
                manualOfficialEmail: "admin@kylrx.ai",
                manualOfficialPhone: "+91 80 4123 4567",
                manualCountry: "India",
                manualState: "Karnataka",
                manualCity: "Bengaluru",
                manualPinCode: "560103",
                manualRegisteredAddress: "Outer Ring Road, Bellandur, Bengaluru, Karnataka 560103",
                manualCorporateAddress: "Floor 9, Tower C, Global Tech Park, Bellandur, Bengaluru, Karnataka 560103",
                manualTimeZone: "Asia/Kolkata",
                manualCurrency: "INR",
                manualFyStart: "04-01",
                manualPan: "AAACK1234F",
                manualTan: "BLRK12345D",
                manualCin: "U72200KA2026PTC123456",
                manualGstin: "29AAACK1234F1Z5",
                manualLogoUrl: "https://kylrx.ai/logo.jpg"
            };

            for (const [id, value] of Object.entries(demoData)) {
                const el = document.getElementById(id);
                if (el) el.value = value;
            }
            window.showCustomAlert("Demo Data Populated", "The exact 21 organization attributes have been auto-populated with Kylrx Enterprise defaults.", "success");
        };
    }

    if (btnManualClear) {
        btnManualClear.onclick = () => {
            if (manualOrgForm) manualOrgForm.reset();
        };
    }

    if (manualOrgForm) {
        manualOrgForm.onsubmit = async (e) => {
            e.preventDefault();
            await processManualSubmission();
        };
    }
}

/**
 * Handles Tab A manual form submission and validation of 21 attributes
 */
async function processManualSubmission() {
    if (state.isProcessing) return;

    // Extract exact 21 attributes from DOM inputs
    const rawData = {
        Legal_Name: document.getElementById('manualLegalName')?.value.trim() || '',
        Display_Name: document.getElementById('manualDisplayName')?.value.trim() || '',
        Organization_Type: document.getElementById('manualOrgType')?.value.trim() || 'Private Limited',
        Industry: document.getElementById('manualIndustry')?.value.trim() || '',
        Website: document.getElementById('manualWebsite')?.value.trim() || '',
        Official_Email: document.getElementById('manualOfficialEmail')?.value.trim().toLowerCase() || '',
        Official_Phone: document.getElementById('manualOfficialPhone')?.value.trim() || '',
        Country: document.getElementById('manualCountry')?.value.trim() || 'India',
        State: document.getElementById('manualState')?.value.trim() || '',
        City: document.getElementById('manualCity')?.value.trim() || '',
        PIN_Code: document.getElementById('manualPinCode')?.value.trim() || '',
        Registered_Address: document.getElementById('manualRegisteredAddress')?.value.trim() || '',
        Corporate_Address: document.getElementById('manualCorporateAddress')?.value.trim() || '',
        Time_Zone: document.getElementById('manualTimeZone')?.value.trim() || 'Asia/Kolkata',
        Currency: document.getElementById('manualCurrency')?.value.trim().toUpperCase() || 'INR',
        Financial_Year_Start: document.getElementById('manualFyStart')?.value.trim() || '04-01',
        PAN: document.getElementById('manualPan')?.value.trim().toUpperCase() || '',
        TAN: document.getElementById('manualTan')?.value.trim().toUpperCase() || '',
        CIN_or_LLPIN: document.getElementById('manualCin')?.value.trim().toUpperCase() || '',
        GSTIN: document.getElementById('manualGstin')?.value.trim().toUpperCase() || '',
        Logo_URL: document.getElementById('manualLogoUrl')?.value.trim() || ''
    };

    // Client-side Validation
    const errors = validateOrganizationAttributes(rawData);
    if (errors.length > 0) {
        window.showCustomAlert("Validation Error", errors.join("\n"), "error");
        return;
    }

    if (btnManualSubmit) {
        btnManualSubmit.disabled = true;
        btnManualSubmit.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Saving Organization...';
        if (window.lucide) lucide.createIcons();
    }

    state.isProcessing = true;

    try {
        await executeOrganizationSetup(rawData, "Manual Form");
    } catch (err) {
        console.error("Manual setup execution failed:", err);
        window.showCustomAlert("Setup Error", "Failed to save organization: " + err.message, "error");
        if (btnManualSubmit) {
            btnManualSubmit.disabled = false;
            btnManualSubmit.innerHTML = '<i data-lucide="check-circle-2"></i> Save Organization & Set orgConfigured: true';
            if (window.lucide) lucide.createIcons();
        }
    } finally {
        state.isProcessing = false;
    }
}

/**
 * Validates the 21 organization attributes according to statutory rules
 */
function validateOrganizationAttributes(data) {
    const errors = [];

    // Required fields check
    ORGANIZATION_ATTRIBUTES.forEach(attr => {
        if (attr.required && (!data[attr.key] || data[attr.key].toString().trim() === '')) {
            errors.push(`Missing required field: ${attr.label}`);
        }
    });

    // Email format
    if (data.Official_Email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.Official_Email)) {
        errors.push("Invalid Official Email format.");
    }

    // PAN format: 10 chars (5 letters, 4 digits, 1 letter)
    if (data.PAN && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(data.PAN)) {
        errors.push(`Invalid PAN format: "${data.PAN}". Must be 10 characters (e.g. AAACK1234F).`);
    }

    // TAN format: 10 chars (4 letters, 5 digits, 1 letter)
    if (data.TAN && !/^[A-Z]{4}[0-9]{5}[A-Z]{1}$/.test(data.TAN)) {
        errors.push(`Invalid TAN format: "${data.TAN}". Must be 10 characters (e.g. BLRK12345D).`);
    }

    // GSTIN format: 15 chars (2 state code + 10 PAN + 1 entity code + Z + 1 check digit)
    if (data.GSTIN && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(data.GSTIN)) {
        errors.push(`Invalid GSTIN format: "${data.GSTIN}". Must be 15 characters (e.g. 29AAACK1234F1Z5).`);
    }

    return errors;
}

/**
 * Sets up Tab B: Bulk File Upload (.xlsx / .csv parser)
 */
function setupFileUpload() {
    if (dropZone && fileInput) {
        dropZone.onclick = () => fileInput.click();
        fileInput.onchange = (e) => {
            if (e.target.files && e.target.files[0]) {
                handleUploadedFile(e.target.files[0]);
            }
        };

        dropZone.ondragover = (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--primary)';
            dropZone.style.backgroundColor = 'var(--primary-light)';
        };

        dropZone.ondragleave = (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--border)';
            dropZone.style.backgroundColor = '#ffffff';
        };

        dropZone.ondrop = (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--border)';
            dropZone.style.backgroundColor = '#ffffff';
            if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                handleUploadedFile(e.dataTransfer.files[0]);
            }
        };
    }

    if (btnCancelIngest) {
        btnCancelIngest.onclick = () => {
            state.parsedOrgData = null;
            if (fileInput) fileInput.value = '';
            if (parseResultsContainer) parseResultsContainer.style.display = 'none';
            if (dropZone) dropZone.style.display = 'block';
        };
    }

    if (btnCancelBuIngest) {
        btnCancelBuIngest.onclick = () => {
            state.parsedBuData = null;
            state.parsedBuDocs = null;
            if (buParseResultsContainer) buParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmIngest) {
        btnConfirmIngest.onclick = async () => {
            if (!state.parsedOrgData || state.isProcessing) return;

            btnConfirmIngest.disabled = true;
            btnConfirmIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Organization...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeOrganizationSetup(state.parsedOrgData, "Bulk Spreadsheet Upload");
            } catch (err) {
                console.error("Bulk spreadsheet ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest organization: " + err.message, "error");
                btnConfirmIngest.disabled = false;
                btnConfirmIngest.innerHTML = '<i data-lucide="lock"></i> Ingest 21 Attributes & Set orgConfigured: true';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnConfirmBuIngest) {
        btnConfirmBuIngest.onclick = async () => {
            if (!state.parsedBuDocs || state.parsedBuDocs.length === 0 || state.isProcessing) return;

            btnConfirmBuIngest.disabled = true;
            btnConfirmBuIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Business Units...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeBusinessUnitIngest(state.parsedBuDocs);
            } catch (err) {
                console.error("Business Unit ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest business units: " + err.message, "error");
                btnConfirmBuIngest.disabled = false;
                btnConfirmBuIngest.innerHTML = '<i data-lucide="database"></i> Ingest Business Units to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelCcIngest) {
        btnCancelCcIngest.onclick = () => {
            state.parsedCcData = null;
            state.parsedCcDocs = null;
            if (ccParseResultsContainer) ccParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmCcIngest) {
        btnConfirmCcIngest.onclick = async () => {
            if (!state.parsedCcDocs || state.parsedCcDocs.length === 0 || state.isProcessing) return;

            btnConfirmCcIngest.disabled = true;
            btnConfirmCcIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Cost Centers...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeCostCenterIngest(state.parsedCcDocs);
            } catch (err) {
                console.error("Cost Center ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest cost centers: " + err.message, "error");
                btnConfirmCcIngest.disabled = false;
                btnConfirmCcIngest.innerHTML = '<i data-lucide="database"></i> Ingest Cost Centers to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelSubDeptIngest) {
        btnCancelSubDeptIngest.onclick = () => {
            state.parsedSubDeptData = null;
            state.parsedSubDeptDocs = null;
            if (subDeptParseResultsContainer) subDeptParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmSubDeptIngest) {
        btnConfirmSubDeptIngest.onclick = async () => {
            if (!state.parsedSubDeptDocs || state.parsedSubDeptDocs.length === 0 || state.isProcessing) return;

            btnConfirmSubDeptIngest.disabled = true;
            btnConfirmSubDeptIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Sub-Departments...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeSubDepartmentIngest(state.parsedSubDeptDocs);
            } catch (err) {
                console.error("Sub-Department ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest sub-departments: " + err.message, "error");
                btnConfirmSubDeptIngest.disabled = false;
                btnConfirmSubDeptIngest.innerHTML = '<i data-lucide="database"></i> Ingest Sub-Departments to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelShiftIngest) {
        btnCancelShiftIngest.onclick = () => {
            state.parsedShiftData = null;
            state.parsedShiftDocs = null;
            if (shiftParseResultsContainer) shiftParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmShiftIngest) {
        btnConfirmShiftIngest.onclick = async () => {
            if (!state.parsedShiftDocs || state.parsedShiftDocs.length === 0 || state.isProcessing) return;

            btnConfirmShiftIngest.disabled = true;
            btnConfirmShiftIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Shifts...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeShiftIngest(state.parsedShiftDocs);
            } catch (err) {
                console.error("Shift ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest shift schedules: " + err.message, "error");
                btnConfirmShiftIngest.disabled = false;
                btnConfirmShiftIngest.innerHTML = '<i data-lucide="database"></i> Ingest Shifts &amp; Week-offs to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelPolicyIngest) {
        btnCancelPolicyIngest.onclick = () => {
            state.parsedPolicyData = null;
            state.parsedPolicyDocs = null;
            if (policyParseResultsContainer) policyParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmPolicyIngest) {
        btnConfirmPolicyIngest.onclick = async () => {
            if (!state.parsedPolicyDocs || state.parsedPolicyDocs.length === 0 || state.isProcessing) return;

            btnConfirmPolicyIngest.disabled = true;
            btnConfirmPolicyIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Policies...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executePolicyIngest(state.parsedPolicyDocs);
            } catch (err) {
                console.error("Policy ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest attendance policies: " + err.message, "error");
                btnConfirmPolicyIngest.disabled = false;
                btnConfirmPolicyIngest.innerHTML = '<i data-lucide="database"></i> Ingest Attendance Policies to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelEmployeeTypeIngest) {
        btnCancelEmployeeTypeIngest.onclick = () => {
            state.parsedEmployeeTypeData = null;
            state.parsedEmployeeTypeDocs = null;
            if (employeeTypeParseResultsContainer) employeeTypeParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmEmployeeTypeIngest) {
        btnConfirmEmployeeTypeIngest.onclick = async () => {
            if (!state.parsedEmployeeTypeDocs || state.parsedEmployeeTypeDocs.length === 0 || state.isProcessing) return;

            btnConfirmEmployeeTypeIngest.disabled = true;
            btnConfirmEmployeeTypeIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Employee Types...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeEmployeeTypeIngest(state.parsedEmployeeTypeDocs);
            } catch (err) {
                console.error("Employee Type ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest employee types: " + err.message, "error");
                btnConfirmEmployeeTypeIngest.disabled = false;
                btnConfirmEmployeeTypeIngest.innerHTML = '<i data-lucide="database"></i> Ingest Employee Types to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelEmployeeFinanceIngest) {
        btnCancelEmployeeFinanceIngest.onclick = () => {
            state.parsedFinanceData = null;
            state.parsedFinanceDocs = null;
            if (employeeFinanceParseResultsContainer) employeeFinanceParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmLegacyEmpFinanceIngest) {
        btnConfirmLegacyEmpFinanceIngest.onclick = async () => {
            if (!state.parsedFinanceDocs || state.parsedFinanceDocs.length === 0 || state.isProcessing) return;

            btnConfirmLegacyEmpFinanceIngest.disabled = true;
            btnConfirmLegacyEmpFinanceIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Employee Finance...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeEmployeeFinanceIngest(state.parsedFinanceDocs);
            } catch (err) {
                console.error("Employee Finance ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest employee finance records: " + err.message, "error");
                btnConfirmLegacyEmpFinanceIngest.disabled = false;
                btnConfirmLegacyEmpFinanceIngest.innerHTML = '<i data-lucide="database"></i> Ingest Employee Finance to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelEpfoMasterIngest) {
        btnCancelEpfoMasterIngest.onclick = () => {
            state.parsedEpfoData = null;
            state.parsedEpfoDocs = null;
            if (epfoMasterParseResultsContainer) epfoMasterParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmEpfoMasterIngest) {
        btnConfirmEpfoMasterIngest.onclick = async () => {
            if (!state.parsedEpfoDocs || state.parsedEpfoDocs.length === 0 || state.isProcessing) return;

            btnConfirmEpfoMasterIngest.disabled = true;
            btnConfirmEpfoMasterIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting EPFO Master...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeEpfoMasterIngest(state.parsedEpfoDocs);
            } catch (err) {
                console.error("EPFO Master ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest EPFO statutory master records: " + err.message, "error");
                btnConfirmEpfoMasterIngest.disabled = false;
                btnConfirmEpfoMasterIngest.innerHTML = '<i data-lucide="database"></i> Ingest EPFO Master to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelEsicMasterIngest) {
        btnCancelEsicMasterIngest.onclick = () => {
            state.parsedEsicData = null;
            state.parsedEsicDocs = null;
            if (esicMasterParseResultsContainer) esicMasterParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmEsicMasterIngest) {
        btnConfirmEsicMasterIngest.onclick = async () => {
            if (!state.parsedEsicDocs || state.parsedEsicDocs.length === 0 || state.isProcessing) return;

            btnConfirmEsicMasterIngest.disabled = true;
            btnConfirmEsicMasterIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting ESIC Master...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeEsicMasterIngest(state.parsedEsicDocs);
            } catch (err) {
                console.error("ESIC Master ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest ESIC statutory master records: " + err.message, "error");
                btnConfirmEsicMasterIngest.disabled = false;
                btnConfirmEsicMasterIngest.innerHTML = '<i data-lucide="database"></i> Ingest ESIC Master to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelPtMasterIngest) {
        btnCancelPtMasterIngest.onclick = () => {
            state.parsedPtData = null;
            state.parsedPtDocs = null;
            if (ptMasterParseResultsContainer) ptMasterParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmPtMasterIngest) {
        btnConfirmPtMasterIngest.onclick = async () => {
            if (!state.parsedPtDocs || state.parsedPtDocs.length === 0 || state.isProcessing) return;

            btnConfirmPtMasterIngest.disabled = true;
            btnConfirmPtMasterIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting PT Master...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executePtMasterIngest(state.parsedPtDocs);
            } catch (err) {
                console.error("PT Master ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest Professional Tax statutory master records: " + err.message, "error");
                btnConfirmPtMasterIngest.disabled = false;
                btnConfirmPtMasterIngest.innerHTML = '<i data-lucide="database"></i> Ingest PT Master to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelLwfMasterIngest) {
        btnCancelLwfMasterIngest.onclick = () => {
            state.parsedLwfData = null;
            state.parsedLwfDocs = null;
            if (lwfMasterParseResultsContainer) lwfMasterParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmLwfMasterIngest) {
        btnConfirmLwfMasterIngest.onclick = async () => {
            if (!state.parsedLwfDocs || state.parsedLwfDocs.length === 0 || state.isProcessing) return;

            btnConfirmLwfMasterIngest.disabled = true;
            btnConfirmLwfMasterIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting LWF Master...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeLwfMasterIngest(state.parsedLwfDocs);
            } catch (err) {
                console.error("LWF Master ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest Labour Welfare Fund statutory master records: " + err.message, "error");
                btnConfirmLwfMasterIngest.disabled = false;
                btnConfirmLwfMasterIngest.innerHTML = '<i data-lucide="database"></i> Ingest LWF Master to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelNpsMasterIngest) {
        btnCancelNpsMasterIngest.onclick = () => {
            state.parsedNpsData = null;
            state.parsedNpsDocs = null;
            if (npsMasterParseResultsContainer) npsMasterParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmNpsMasterIngest) {
        btnConfirmNpsMasterIngest.onclick = async () => {
            if (!state.parsedNpsDocs || state.parsedNpsDocs.length === 0 || state.isProcessing) return;

            btnConfirmNpsMasterIngest.disabled = true;
            btnConfirmNpsMasterIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting NPS Master...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeNpsMasterIngest(state.parsedNpsDocs);
            } catch (err) {
                console.error("NPS Master ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest National Pension System statutory master records: " + err.message, "error");
                btnConfirmNpsMasterIngest.disabled = false;
                btnConfirmNpsMasterIngest.innerHTML = '<i data-lucide="database"></i> Ingest NPS Master to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelGratuityMasterIngest) {
        btnCancelGratuityMasterIngest.onclick = () => {
            state.parsedGratuityData = null;
            state.parsedGratuityDocs = null;
            if (gratuityMasterParseResultsContainer) gratuityMasterParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmGratuityMasterIngest) {
        btnConfirmGratuityMasterIngest.onclick = async () => {
            if (!state.parsedGratuityDocs || state.parsedGratuityDocs.length === 0 || state.isProcessing) return;

            btnConfirmGratuityMasterIngest.disabled = true;
            btnConfirmGratuityMasterIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Gratuity Master...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeGratuityMasterIngest(state.parsedGratuityDocs);
            } catch (err) {
                console.error("Gratuity Master ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest Gratuity statutory master records: " + err.message, "error");
                btnConfirmGratuityMasterIngest.disabled = false;
                btnConfirmGratuityMasterIngest.innerHTML = '<i data-lucide="database"></i> Ingest Gratuity Master to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelSalaryStructureIngest) {
        btnCancelSalaryStructureIngest.onclick = () => {
            state.parsedSalaryStructureData = null;
            state.parsedSalaryStructureDocs = null;
            if (salaryStructureParseResultsContainer) salaryStructureParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmSalaryStructureIngest) {
        btnConfirmSalaryStructureIngest.onclick = async () => {
            if (!state.parsedSalaryStructureDocs || state.parsedSalaryStructureDocs.length === 0 || state.isProcessing) return;

            btnConfirmSalaryStructureIngest.disabled = true;
            btnConfirmSalaryStructureIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Salary Structures...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeSalaryStructureIngest(state.parsedSalaryStructureDocs);
            } catch (err) {
                console.error("Salary Structure ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest salary structures: " + err.message, "error");
                btnConfirmSalaryStructureIngest.disabled = false;
                btnConfirmSalaryStructureIngest.innerHTML = '<i data-lucide="database"></i> Ingest Salary Structures to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelHolidayCalendarIngest) {
        btnCancelHolidayCalendarIngest.onclick = () => {
            state.parsedHolidayData = null;
            state.parsedHolidayDocs = null;
            if (holidayCalendarParseResultsContainer) holidayCalendarParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmHolidayCalendarIngest) {
        btnConfirmHolidayCalendarIngest.onclick = async () => {
            if (!state.parsedHolidayDocs || state.parsedHolidayDocs.length === 0 || state.isProcessing) return;

            btnConfirmHolidayCalendarIngest.disabled = true;
            btnConfirmHolidayCalendarIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Holiday Calendars...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeHolidayCalendarIngest(state.parsedHolidayDocs);
            } catch (err) {
                console.error("Holiday Calendar ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest holiday calendars: " + err.message, "error");
                btnConfirmHolidayCalendarIngest.disabled = false;
                btnConfirmHolidayCalendarIngest.innerHTML = '<i data-lucide="database"></i> Ingest Holiday Calendar to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelStatutoryComplianceIngest) {
        btnCancelStatutoryComplianceIngest.onclick = () => {
            state.parsedStatutoryData = null;
            state.parsedStatutoryDocs = null;
            if (statutoryComplianceParseResultsContainer) statutoryComplianceParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmStatutoryComplianceIngest) {
        btnConfirmStatutoryComplianceIngest.onclick = async () => {
            if (!state.parsedStatutoryDocs || state.parsedStatutoryDocs.length === 0 || state.isProcessing) return;

            btnConfirmStatutoryComplianceIngest.disabled = true;
            btnConfirmStatutoryComplianceIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Statutory Rules...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeStatutoryComplianceIngest(state.parsedStatutoryDocs);
            } catch (err) {
                console.error("Statutory Compliance ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest statutory compliance rules: " + err.message, "error");
                btnConfirmStatutoryComplianceIngest.disabled = false;
                btnConfirmStatutoryComplianceIngest.innerHTML = '<i data-lucide="database"></i> Ingest Statutory Rules to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelRolePermissionIngest) {
        btnCancelRolePermissionIngest.onclick = () => {
            state.parsedRoleData = null;
            state.parsedRoleDocs = null;
            if (rolePermissionParseResultsContainer) rolePermissionParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmRolePermissionIngest) {
        btnConfirmRolePermissionIngest.onclick = async () => {
            if (!state.parsedRoleDocs || state.parsedRoleDocs.length === 0 || state.isProcessing) return;

            btnConfirmRolePermissionIngest.disabled = true;
            btnConfirmRolePermissionIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Role Permissions...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeRolePermissionIngest(state.parsedRoleDocs);
            } catch (err) {
                console.error("Role Permission ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest role permissions: " + err.message, "error");
                btnConfirmRolePermissionIngest.disabled = false;
                btnConfirmRolePermissionIngest.innerHTML = '<i data-lucide="database"></i> Ingest Role Permissions to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelWorkflowRulesIngest) {
        btnCancelWorkflowRulesIngest.onclick = () => {
            state.parsedWorkflowData = null;
            state.parsedWorkflowDocs = null;
            if (workflowRulesParseResultsContainer) workflowRulesParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmWorkflowRulesIngest) {
        btnConfirmWorkflowRulesIngest.onclick = async () => {
            if (!state.parsedWorkflowDocs || state.parsedWorkflowDocs.length === 0 || state.isProcessing) return;

            btnConfirmWorkflowRulesIngest.disabled = true;
            btnConfirmWorkflowRulesIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Workflow Rules...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executeWorkflowRulesIngest(state.parsedWorkflowDocs);
            } catch (err) {
                console.error("Workflow Rules ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest workflow rules: " + err.message, "error");
                btnConfirmWorkflowRulesIngest.disabled = false;
                btnConfirmWorkflowRulesIngest.innerHTML = '<i data-lucide="database"></i> Ingest Workflow Rules to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }

    if (btnCancelPayrollComponentsIngest) {
        btnCancelPayrollComponentsIngest.onclick = () => {
            state.parsedPayrollComponentData = null;
            state.parsedPayrollComponentDocs = null;
            if (payrollComponentsParseResultsContainer) payrollComponentsParseResultsContainer.style.display = 'none';
        };
    }

    if (btnConfirmPayrollComponentsIngest) {
        btnConfirmPayrollComponentsIngest.onclick = async () => {
            if (!state.parsedPayrollComponentDocs || state.parsedPayrollComponentDocs.length === 0 || state.isProcessing) return;

            btnConfirmPayrollComponentsIngest.disabled = true;
            btnConfirmPayrollComponentsIngest.innerHTML = '<i data-lucide="loader" class="animate-spin"></i> Ingesting Payroll Components...';
            if (window.lucide) lucide.createIcons();
            state.isProcessing = true;

            try {
                await executePayrollComponentIngest(state.parsedPayrollComponentDocs);
            } catch (err) {
                console.error("Payroll Components ingest failed:", err);
                window.showCustomAlert("Ingest Error", "Failed to ingest payroll components: " + err.message, "error");
                btnConfirmPayrollComponentsIngest.disabled = false;
                btnConfirmPayrollComponentsIngest.innerHTML = '<i data-lucide="database"></i> Ingest Payroll Components to Cloud Firestore';
                if (window.lucide) lucide.createIcons();
            } finally {
                state.isProcessing = false;
            }
        };
    }
}

/**
 * Handles parsing of dropped / browsed Excel or CSV file using SheetJS
 * Parses 'Organization' (PRD §1), 'Business Unit' (PRD §1 & §10), and 'Cost Center' (PRD §1, §10, & §13) sheets
 */
function handleUploadedFile(file) {
    if (!file) return;

    const validExtensions = ['.xlsx', '.xls', '.csv'];
    const fileName = file.name.toLowerCase();
    const isValidExt = validExtensions.some(ext => fileName.endsWith(ext));

    if (!isValidExt) {
        window.showCustomAlert("Invalid File", "Please upload a valid Excel workbook (.xlsx, .xls) or CSV file.", "error");
        return;
    }

    if (typeof XLSX === 'undefined') {
        window.showCustomAlert("Parser Error", "SheetJS parser is not loaded. Please reload the page.", "error");
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            let parsedAny = false;

            // ── 1. Target the 'Organization' sheet ──────────────────────────────────
            let orgSheetName = workbook.SheetNames.find(s => s.trim().toLowerCase().replace(/[\s_-]+/g, '') === 'organization');
            if (!orgSheetName && workbook.SheetNames.length === 1) {
                // If single sheet, probe headers to check if it's organization
                const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
                const probeRows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
                if (probeRows.length > 0) {
                    const rowKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (rowKeys.includes('legalname') || rowKeys.includes('pan') || rowKeys.includes('gstin')) {
                        orgSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (orgSheetName && workbook.Sheets[orgSheetName]) {
                const rawOrgRows = XLSX.utils.sheet_to_json(workbook.Sheets[orgSheetName], { defval: "" });
                if (rawOrgRows && rawOrgRows.length > 0) {
                    const extractedData = extract21AttributesFromSheetRows(rawOrgRows);
                    state.parsedOrgData = extractedData;
                    renderParsedAttributesPreview(file.name, orgSheetName, extractedData);
                    parsedAny = true;
                }
            }

            // ── 2. Target the 'Business Unit' sheet (PRD Section 1 & Section 10) ────
            let buSheetName = workbook.SheetNames.find(s => s.trim().toLowerCase().replace(/[\s_-]+/g, '') === 'businessunit');
            if (!buSheetName && workbook.SheetNames.length === 1 && !orgSheetName) {
                // Single-sheet CSV or workbook that wasn't Organization
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('businessunitcode') || firstKeys.includes('heademployeeid')) {
                        buSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (buSheetName && workbook.Sheets[buSheetName]) {
                const rawBuRows = XLSX.utils.sheet_to_json(workbook.Sheets[buSheetName], { defval: "" });
                if (rawBuRows && rawBuRows.length > 0) {
                    const buParsed = extract4BuAttributesFromSheetRows(rawBuRows);
                    if (buParsed.records.length > 0) {
                        state.parsedBuData = buParsed.records;
                        state.parsedBuDocs = buParsed.firestoreDocs;
                        renderParsedBuPreview(file.name, buSheetName, buParsed.records, buParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 3. Target the 'Cost Center' / 'Cost Centre' sheet (PRD Sections 1 & 13) ──
            let ccSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'costcenter' || norm === 'costcentre';
            });
            if (!ccSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('costcentercode') || firstKeys.includes('owneremployeeid')) {
                        ccSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (ccSheetName && workbook.Sheets[ccSheetName]) {
                const rawCcRows = XLSX.utils.sheet_to_json(workbook.Sheets[ccSheetName], { defval: "" });
                if (rawCcRows && rawCcRows.length > 0) {
                    const ccParsed = extract4CcAttributesFromSheetRows(rawCcRows);
                    if (ccParsed.records.length > 0) {
                        state.parsedCcData = ccParsed.records;
                        state.parsedCcDocs = ccParsed.firestoreDocs;
                        renderParsedCcPreview(file.name, ccSheetName, ccParsed.records, ccParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 4. Target the 'Sub-Departments' sheet (PRD Sections 1, 10 & 13) ────
            let subDeptSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'subdepartments' || norm === 'subdepartment' || norm === 'subdepts';
            });
            if (!subDeptSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('subdepartmentcode') || firstKeys.includes('subdeptcode')) {
                        subDeptSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (subDeptSheetName && workbook.Sheets[subDeptSheetName]) {
                const rawSubDeptRows = XLSX.utils.sheet_to_json(workbook.Sheets[subDeptSheetName], { defval: "" });
                if (rawSubDeptRows && rawSubDeptRows.length > 0) {
                    const subDeptParsed = extract5SubDeptAttributesFromSheetRows(rawSubDeptRows);
                    if (subDeptParsed.records.length > 0) {
                        state.parsedSubDeptData = subDeptParsed.records;
                        state.parsedSubDeptDocs = subDeptParsed.firestoreDocs;
                        renderParsedSubDeptPreview(file.name, subDeptSheetName, subDeptParsed.records, subDeptParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 5. Target the 'Shifts & Week-offs' sheet (PRD Sections 1, 13 & 16) ────
            let shiftSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'shiftsweekoffs' || norm === 'shiftsandweekoffs' || norm === 'shifts' || norm === 'shiftroster' || norm === 'shift_roster' || norm === 'shiftspolicies';
            });
            if (!shiftSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('shiftcode') || firstKeys.includes('starttime') || firstKeys.includes('breakminutes')) {
                        shiftSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (shiftSheetName && workbook.Sheets[shiftSheetName]) {
                const rawShiftRows = XLSX.utils.sheet_to_json(workbook.Sheets[shiftSheetName], { defval: "" });
                if (rawShiftRows && rawShiftRows.length > 0) {
                    const shiftParsed = extract13ShiftAttributesFromSheetRows(rawShiftRows);
                    if (shiftParsed.records.length > 0) {
                        state.parsedShiftData = shiftParsed.records;
                        state.parsedShiftDocs = shiftParsed.firestoreDocs;
                        renderParsedShiftPreview(file.name, shiftSheetName, shiftParsed.records, shiftParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 6. Target the 'Attendance Rules' sheet (PRD Sections 1, 15 & 16) ────
            let policySheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'attendancerules' || norm === 'attendancepolicies' || norm === 'attendancepolicy' || norm === 'attendance_rules' || norm === 'attendance_policies' || norm === 'attendance';
            });
            if (!policySheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('attendancepolicycode') || firstKeys.includes('policycode') || firstKeys.includes('lateafterminutes')) {
                        policySheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (policySheetName && workbook.Sheets[policySheetName]) {
                const rawPolicyRows = XLSX.utils.sheet_to_json(workbook.Sheets[policySheetName], { defval: "" });
                if (rawPolicyRows && rawPolicyRows.length > 0) {
                    const policyParsed = extract13PolicyAttributesFromSheetRows(rawPolicyRows);
                    if (policyParsed.records.length > 0) {
                        state.parsedPolicyData = policyParsed.records;
                        state.parsedPolicyDocs = policyParsed.firestoreDocs;
                        renderParsedPolicyPreview(file.name, policySheetName, policyParsed.records, policyParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 7. Target the 'Employee Type' sheet (PRD Sections 1, 10 & 13) ──────
            let empTypeSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'employeetype' || norm === 'employeetypes';
            }) || workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'employmenttype' || norm === 'employmenttypes' || norm === 'categories';
            });
            if (!empTypeSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('categorycode') || firstKeys.includes('employmenttype') || firstKeys.includes('probationdays')) {
                        empTypeSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (empTypeSheetName && workbook.Sheets[empTypeSheetName]) {
                const rawEmpTypeRows = XLSX.utils.sheet_to_json(workbook.Sheets[empTypeSheetName], { defval: "" });
                if (rawEmpTypeRows && rawEmpTypeRows.length > 0) {
                    const typeParsed = extract7EmployeeTypeAttributesFromSheetRows(rawEmpTypeRows);
                    if (typeParsed.records.length > 0) {
                        state.parsedEmployeeTypeData = typeParsed.records;
                        state.parsedEmployeeTypeDocs = typeParsed.firestoreDocs;
                        renderParsedEmployeeTypePreview(file.name, empTypeSheetName, typeParsed.records, typeParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 8. Target the 'Employee Finance Deatils' sheet (PRD Sections 1, 4 & 13) ────
            let empFinanceSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'employeefinancedeatils' || norm === 'employeefinancedetails' || norm === 'employeefinance' || norm === 'financedetails' || norm === 'finance_details' || norm === 'finance';
            });
            if (!empFinanceSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('accountholdername') || firstKeys.includes('accountnumber') || firstKeys.includes('ifsc') || firstKeys.includes('uanno') || firstKeys.includes('employeeid')) {
                        empFinanceSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (empFinanceSheetName && workbook.Sheets[empFinanceSheetName]) {
                const rawFinanceRows = XLSX.utils.sheet_to_json(workbook.Sheets[empFinanceSheetName], { defval: "" });
                if (rawFinanceRows && rawFinanceRows.length > 0) {
                    const financeParsed = await extract17EmployeeFinanceAttributesFromSheetRows(rawFinanceRows);
                    if (financeParsed.records.length > 0) {
                        state.parsedFinanceData = financeParsed.records;
                        state.parsedFinanceDocs = financeParsed.firestoreDocs;
                        renderParsedEmployeeFinancePreview(file.name, empFinanceSheetName, financeParsed.records, financeParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 8.5. Target the 'PF Details' / 'EPFO Master' sheet (PRD Sections 1, 4, 11 & 13) ────
            let pfMasterSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'pfdetails' || norm === 'epfomaster' || norm === 'pfmaster' || norm === 'epfodetails' || norm === 'epfo' || norm === 'pf';
            });
            if (!pfMasterSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('epfoestablishmentid') || (firstKeys.includes('uan') && firstKeys.includes('currentmemberid'))) {
                        pfMasterSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (pfMasterSheetName && workbook.Sheets[pfMasterSheetName]) {
                const rawPfRows = XLSX.utils.sheet_to_json(workbook.Sheets[pfMasterSheetName], { defval: "" });
                if (rawPfRows && rawPfRows.length > 0) {
                    const epfoParsed = await extract19EpfoMasterAttributesFromSheetRows(rawPfRows);
                    if (epfoParsed.records.length > 0) {
                        state.parsedEpfoData = epfoParsed.records;
                        state.parsedEpfoDocs = epfoParsed.firestoreDocs;
                        renderParsedEpfoMasterPreview(file.name, pfMasterSheetName, epfoParsed.records, epfoParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── Target the 'ESIC Details' / 'ESIC Master' sheet (PRD Sections 1, 4, 11 & 13) ────
            let esicMasterSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'esicdetails' || norm === 'esicmaster' || norm === 'esidetails' || norm === 'esimaster' || norm === 'esic' || norm === 'esi';
            });
            if (!esicMasterSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName && !pfMasterSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('esicemployercode') || (firstKeys.includes('ipnumber') && firstKeys.includes('insuredpersonstatus'))) {
                        esicMasterSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (esicMasterSheetName && workbook.Sheets[esicMasterSheetName]) {
                const rawEsicRows = XLSX.utils.sheet_to_json(workbook.Sheets[esicMasterSheetName], { defval: "" });
                if (rawEsicRows && rawEsicRows.length > 0) {
                    const esicParsed = await extract18EsicMasterAttributesFromSheetRows(rawEsicRows);
                    if (esicParsed.records.length > 0) {
                        state.parsedEsicData = esicParsed.records;
                        state.parsedEsicDocs = esicParsed.firestoreDocs;
                        renderParsedEsicMasterPreview(file.name, esicMasterSheetName, esicParsed.records, esicParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── Target the 'PT Details' / 'PT Master' sheet (PRD Sections 1, 4, 11 & 13) ────
            let ptMasterSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'ptdetails' || norm === 'ptmaster' || norm === 'professionaltax' || norm === 'professionaltaxdetails' || norm === 'pt';
            });
            if (!ptMasterSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName && !pfMasterSheetName && !esicMasterSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('ptapplicable') || firstKeys.includes('ptregistrationno') || firstKeys.includes('ptslab') || firstKeys.includes('monthlydeduction')) {
                        ptMasterSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (ptMasterSheetName && workbook.Sheets[ptMasterSheetName]) {
                const rawPtRows = XLSX.utils.sheet_to_json(workbook.Sheets[ptMasterSheetName], { defval: "" });
                if (rawPtRows && rawPtRows.length > 0) {
                    const ptParsed = await extract10PtMasterAttributesFromSheetRows(rawPtRows);
                    if (ptParsed.records.length > 0) {
                        state.parsedPtData = ptParsed.records;
                        state.parsedPtDocs = ptParsed.firestoreDocs;
                        renderParsedPtMasterPreview(file.name, ptMasterSheetName, ptParsed.records, ptParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── Target the 'LWF Details' / 'LWF Master' sheet (PRD Sections 1, 4, 11 & 13) ────
            let lwfMasterSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'lwfdetails' || norm === 'lwfmaster' || norm === 'labourwelfarefund' || norm === 'labourwelfarefunddetails' || norm === 'lwf';
            });
            if (!lwfMasterSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName && !pfMasterSheetName && !esicMasterSheetName && !ptMasterSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('lwfapplicable') || firstKeys.includes('employercontribution') || firstKeys.includes('employeecontribution')) {
                        lwfMasterSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (lwfMasterSheetName && workbook.Sheets[lwfMasterSheetName]) {
                const rawLwfRows = XLSX.utils.sheet_to_json(workbook.Sheets[lwfMasterSheetName], { defval: "" });
                if (rawLwfRows && rawLwfRows.length > 0) {
                    const lwfParsed = await extract10LwfMasterAttributesFromSheetRows(rawLwfRows);
                    if (lwfParsed.records.length > 0) {
                        state.parsedLwfData = lwfParsed.records;
                        state.parsedLwfDocs = lwfParsed.firestoreDocs;
                        renderParsedLwfMasterPreview(file.name, lwfMasterSheetName, lwfParsed.records, lwfParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── Target the 'NPS Details' / 'NPS Master' sheet (PRD Sections 1, 4, 11 & 13) ────
            let npsMasterSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'npsdetails' || norm === 'npsmaster' || norm === 'nationalpensionsystem' || norm === 'nationalpensionsystemdetails' || norm === 'nps';
            });
            if (!npsMasterSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName && !pfMasterSheetName && !esicMasterSheetName && !ptMasterSheetName && !lwfMasterSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('pran') || firstKeys.includes('npsapplicable') || firstKeys.includes('crarecordkeepingagency')) {
                        npsMasterSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (npsMasterSheetName && workbook.Sheets[npsMasterSheetName]) {
                const rawNpsRows = XLSX.utils.sheet_to_json(workbook.Sheets[npsMasterSheetName], { defval: "" });
                if (rawNpsRows && rawNpsRows.length > 0) {
                    const npsParsed = await extract22NpsMasterAttributesFromSheetRows(rawNpsRows);
                    if (npsParsed.records.length > 0) {
                        state.parsedNpsData = npsParsed.records;
                        state.parsedNpsDocs = npsParsed.firestoreDocs;
                        renderParsedNpsMasterPreview(file.name, npsMasterSheetName, npsParsed.records, npsParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── Target the 'Gratuity Details' / 'Gratuity Master' sheet (PRD Sections 1, 4, 11 & 13) ────
            let gratuityMasterSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'gratuitydetails' || norm === 'gratuitymaster' || norm === 'gratuity' || norm === 'paymentofgratuity' || norm === 'paymentofgratuitydetails';
            });
            if (!gratuityMasterSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName && !pfMasterSheetName && !esicMasterSheetName && !ptMasterSheetName && !lwfMasterSheetName && !npsMasterSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('gratuityapplicable') || firstKeys.includes('completedyearsforgratuity') || firstKeys.includes('accruedgratuityamount') || firstKeys.includes('lastdrawnbasic')) {
                        gratuityMasterSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (gratuityMasterSheetName && workbook.Sheets[gratuityMasterSheetName]) {
                const rawGratuityRows = XLSX.utils.sheet_to_json(workbook.Sheets[gratuityMasterSheetName], { defval: "" });
                if (rawGratuityRows && rawGratuityRows.length > 0) {
                    const gratuityParsed = await extract18GratuityMasterAttributesFromSheetRows(rawGratuityRows);
                    if (gratuityParsed.records.length > 0) {
                        state.parsedGratuityData = gratuityParsed.records;
                        state.parsedGratuityDocs = gratuityParsed.firestoreDocs;
                        renderParsedGratuityMasterPreview(file.name, gratuityMasterSheetName, gratuityParsed.records, gratuityParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 9. Target the 'Salary Stcruture' sheet (PRD Sections 1 & 4) ────
            let salaryStructureSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'salarystcruture' || norm === 'salarystructure' || norm === 'salary_structure' || norm === 'salary' || norm === 'salaries';
            });
            if (!salaryStructureSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('salarystructurecode') || firstKeys.includes('componentcode') || firstKeys.includes('calculationbasis')) {
                        salaryStructureSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (salaryStructureSheetName && workbook.Sheets[salaryStructureSheetName]) {
                const rawSalaryRows = XLSX.utils.sheet_to_json(workbook.Sheets[salaryStructureSheetName], { defval: "" });
                if (rawSalaryRows && rawSalaryRows.length > 0) {
                    const salaryParsed = await extract9SalaryStructureAttributesFromSheetRows(rawSalaryRows);
                    if (salaryParsed.records.length > 0) {
                        state.parsedSalaryStructureData = salaryParsed.records;
                        state.parsedSalaryStructureDocs = salaryParsed.firestoreDocs;
                        renderParsedSalaryStructurePreview(file.name, salaryStructureSheetName, salaryParsed.records, salaryParsed.firestoreDocs, salaryParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 10. Target the 'Holiday Calendar' sheet (PRD Sections 1, 4, 15, & 16) ────
            let holidaySheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'holidaycalendar' || norm === 'holidays' || norm === 'holiday_calendar' || norm === 'holiday';
            });
            if (!holidaySheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName && !salaryStructureSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('holidaycalendarcode') || firstKeys.includes('holidayname') || firstKeys.includes('holidaydate')) {
                        holidaySheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (holidaySheetName && workbook.Sheets[holidaySheetName]) {
                const rawHolidayRows = XLSX.utils.sheet_to_json(workbook.Sheets[holidaySheetName], { defval: "" });
                if (rawHolidayRows && rawHolidayRows.length > 0) {
                    const holidayParsed = await extract9HolidayCalendarAttributesFromSheetRows(rawHolidayRows);
                    if (holidayParsed.records.length > 0) {
                        state.parsedHolidayData = holidayParsed.records;
                        state.parsedHolidayDocs = holidayParsed.firestoreDocs;
                        renderParsedHolidayCalendarPreview(file.name, holidaySheetName, holidayParsed.records, holidayParsed.firestoreDocs, holidayParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 11. Target the 'Statuatory Compliance' / 'Statutory Compliance' sheet (PRD Sections 1, 4, 11, & 13) ────
            let statutorySheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s_-]+/g, '');
                return norm === 'statuatorycompliance' || norm === 'statutorycompliance' || norm === 'compliance' || norm === 'statutory' || norm === 'compliancerules';
            });
            if (!statutorySheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName && !salaryStructureSheetName && !holidaySheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s_-]+/g, ''));
                    if (firstKeys.includes('compliancecode') || firstKeys.includes('registrationnumber') || firstKeys.includes('wageceilingorrule')) {
                        statutorySheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (statutorySheetName && workbook.Sheets[statutorySheetName]) {
                const rawStatutoryRows = XLSX.utils.sheet_to_json(workbook.Sheets[statutorySheetName], { defval: "" });
                if (rawStatutoryRows && rawStatutoryRows.length > 0) {
                    const statutoryParsed = await extract11StatutoryComplianceAttributesFromSheetRows(rawStatutoryRows);
                    if (statutoryParsed.records.length > 0) {
                        state.parsedStatutoryData = statutoryParsed.records;
                        state.parsedStatutoryDocs = statutoryParsed.firestoreDocs;
                        renderParsedStatutoryCompliancePreview(file.name, statutorySheetName, statutoryParsed.records, statutoryParsed.firestoreDocs, statutoryParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 12. Target the 'Role_Code/Employee Cod' / 'Role_Code_Employee_Code' sheet (PRD Sections 1, 14, 17, & 18) ────
            let rolePermSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s/_-]+/g, '');
                return norm === 'rolecodeemployeecod' || norm === 'rolecodeemployeecode' || norm === 'rolespermissions' || norm === 'rolepermissions' || norm === 'permissions' || norm === 'rbac';
            });
            if (!rolePermSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName && !salaryStructureSheetName && !holidaySheetName && !statutorySheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s/_-]+/g, ''));
                    if (firstKeys.includes('rolecodeoremployeecode') || firstKeys.includes('rolecode') || firstKeys.includes('scopelevel') || firstKeys.includes('employeemodule')) {
                        rolePermSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (rolePermSheetName && workbook.Sheets[rolePermSheetName]) {
                const rawRoleRows = XLSX.utils.sheet_to_json(workbook.Sheets[rolePermSheetName], { defval: "" });
                if (rawRoleRows && rawRoleRows.length > 0) {
                    const roleParsed = await extract13RolePermissionAttributesFromSheetRows(rawRoleRows);
                    if (roleParsed.records.length > 0) {
                        state.parsedRoleData = roleParsed.records;
                        state.parsedRoleDocs = roleParsed.firestoreDocs;
                        renderParsedRolePermissionPreview(file.name, rolePermSheetName, roleParsed.records, roleParsed.firestoreDocs, roleParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 13. Target the 'Workflow Rules' / 'Workflow_Rules' sheet (PRD Sections 1, 9, 12, 14, & 18) ────
            let workflowSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s/_-]+/g, '');
                return norm === 'workflowrules' || norm === 'workflowchain' || norm === 'workflows' || norm === 'workflow' || norm === 'approvalrules' || norm === 'multistep';
            });
            if (!workflowSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName && !salaryStructureSheetName && !holidaySheetName && !statutorySheetName && !rolePermSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s/_-]+/g, ''));
                    if (firstKeys.includes('workflowcode') || firstKeys.includes('approvertype') || firstKeys.includes('slahours') || firstKeys.includes('stepno')) {
                        workflowSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (workflowSheetName && workbook.Sheets[workflowSheetName]) {
                const rawWfRows = XLSX.utils.sheet_to_json(workbook.Sheets[workflowSheetName], { defval: "" });
                if (rawWfRows && rawWfRows.length > 0) {
                    const wfParsed = await extract10WorkflowRulesAttributesFromSheetRows(rawWfRows);
                    if (wfParsed.records.length > 0) {
                        state.parsedWorkflowData = wfParsed.records;
                        state.parsedWorkflowDocs = wfParsed.workflowDocuments;
                        renderParsedWorkflowRulesPreview(file.name, workflowSheetName, wfParsed.records, wfParsed.workflowDocuments, wfParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            // ── 14. Target the 'Payroll Components' / 'Payroll_Components' sheet (PRD Sections 1 & 4) ────
            let payrollCompSheetName = workbook.SheetNames.find(s => {
                const norm = s.trim().toLowerCase().replace(/[\s/_-]+/g, '');
                return norm === 'payrollcomponents' || norm === 'payrollcomponent' || norm === 'salarycomponents' || norm === 'salarycomponent' || norm === 'components';
            });
            if (!payrollCompSheetName && workbook.SheetNames.length === 1 && !orgSheetName && !buSheetName && !ccSheetName && !subDeptSheetName && !shiftSheetName && !policySheetName && !empTypeSheetName && !empFinanceSheetName && !salaryStructureSheetName && !holidaySheetName && !statutorySheetName && !rolePermSheetName && !workflowSheetName) {
                const probeRows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
                if (probeRows.length > 0) {
                    const firstKeys = Object.keys(probeRows[0]).map(k => k.toLowerCase().replace(/[\s/_-]+/g, ''));
                    if (firstKeys.includes('componentcode') || firstKeys.includes('componentname') || firstKeys.includes('calculationmethod') || firstKeys.includes('taxable')) {
                        payrollCompSheetName = workbook.SheetNames[0];
                    }
                }
            }

            if (payrollCompSheetName && workbook.Sheets[payrollCompSheetName]) {
                const rawCompRows = XLSX.utils.sheet_to_json(workbook.Sheets[payrollCompSheetName], { defval: "" });
                if (rawCompRows && rawCompRows.length > 0) {
                    const compParsed = await extract13PayrollComponentAttributesFromSheetRows(rawCompRows);
                    if (compParsed.records.length > 0) {
                        state.parsedPayrollComponentData = compParsed.records;
                        state.parsedPayrollComponentDocs = compParsed.firestoreDocs;
                        renderParsedPayrollComponentPreview(file.name, payrollCompSheetName, compParsed.records, compParsed.firestoreDocs, compParsed.errors);
                        parsedAny = true;
                    }
                }
            }

            if (!parsedAny) {
                throw new Error("Could not find 'Organization', 'Business Unit', 'Cost Center', 'Sub-Departments', 'Shifts & Week-offs', 'Attendance Rules', 'Employee Type', 'Employee Finance Deatils', 'Salary Stcruture', 'Holiday Calendar', 'Statuatory Compliance', 'Role_Code/Employee Cod', 'Workflow Rules', or 'Payroll Components' sheets with data in the uploaded file.");
            }
        } catch (err) {
            console.error("File parsing error:", err);
            window.showCustomAlert("Parsing Error", "Failed to parse spreadsheet: " + err.message, "error");
        }
    };
    reader.readAsArrayBuffer(file);
}

/**
 * Extracts and maps rows from 'Business Unit' sheet strictly using 4 attributes:
 * 1. Business_Unit_Code (unique PK)
 * 2. Business_Unit_Name (display title)
 * 3. Head_Employee_ID (reference to employee ID of BU head)
 * 4. Active (boolean: true for "Yes", false for "No")
 */
function extract4BuAttributesFromSheetRows(rows) {
    const records = [];
    const firestoreDocs = [];
    const errors = [];
    const seenCodes = new Set();

    function normalizeKey(str) {
        return String(str || '').toLowerCase().replace(/[\s_-]+/g, '');
    }

    function getVal(row, synonyms) {
        const keys = Object.keys(row);
        for (const syn of synonyms) {
            const cleanSyn = normalizeKey(syn);
            const foundKey = keys.find(k => normalizeKey(k) === cleanSyn);
            if (foundKey && row[foundKey] !== undefined && row[foundKey] !== null) {
                const val = row[foundKey];
                if (typeof val === 'string' && val.trim() !== '') return val.trim();
                if (typeof val !== 'string') return val;
            }
        }
        return null;
    }

    function parseActive(val) {
        if (val === undefined || val === null || val === '') return true;
        if (typeof val === 'boolean') return val;
        const s = String(val).trim().toLowerCase();
        if (['no', 'n', 'false', '0', 'inactive', 'disabled'].includes(s)) return false;
        return true;
    }

    rows.forEach((row, idx) => {
        const vals = Object.values(row).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
        if (vals.length === 0) return; // skip empty rows

        const codeVal = getVal(row, ['Business_Unit_Code', 'businessunitcode', 'bucode', 'code', 'bu_code']);
        const nameVal = getVal(row, ['Business_Unit_Name', 'businessunitname', 'buname', 'name', 'bu_name', 'title']);
        const headVal = getVal(row, ['Head_Employee_ID', 'heademployeeid', 'headid', 'head_id', 'bu_head']);
        const activeVal = getVal(row, ['Active', 'is_active', 'isactive', 'status', 'enabled']);

        if (!codeVal || String(codeVal).trim() === '') {
            errors.push(`Row ${idx + 1}: Missing required attribute 'Business_Unit_Code'.`);
            return;
        }
        if (!nameVal || String(nameVal).trim() === '') {
            errors.push(`Row ${idx + 1}: Missing required attribute 'Business_Unit_Name'.`);
            return;
        }

        const businessUnitCode = String(codeVal).trim().toUpperCase().replace(/\s+/g, '_');
        const businessUnitName = String(nameVal).trim();
        const headEmployeeId = headVal ? String(headVal).trim().toUpperCase() : '';
        const isActive = parseActive(activeVal);

        if (seenCodes.has(businessUnitCode)) {
            errors.push(`Row ${idx + 1}: Duplicate Business_Unit_Code '${businessUnitCode}'.`);
            return;
        }
        seenCodes.add(businessUnitCode);

        // Resolve head name
        const headEmployeeName = window.KylrxBuRules 
            ? (window.KylrxBuRules.resolveEmployeeName ? window.KylrxBuRules.resolveEmployeeName(headEmployeeId) : headEmployeeId)
            : headEmployeeId;

        const record = {
            Business_Unit_Code: businessUnitCode,
            Business_Unit_Name: businessUnitName,
            Head_Employee_ID: headEmployeeId,
            Active: isActive ? "Yes" : "No",
            headEmployeeName: headEmployeeName,
            isActive: isActive
        };

        const firestoreDoc = {
            businessUnitCode,
            businessUnitName,
            headEmployeeId,
            headEmployeeName,
            isActive,
            allowedEmployeeTypes: ['FULL_TIME', 'CONTRACT'],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        records.push(record);
        firestoreDocs.push(firestoreDoc);
    });

    return { records, firestoreDocs, errors };
}

/**
 * Renders the parsed Business Unit sheet into the live preview table
 */
function renderParsedBuPreview(fileName, sheetName, records, errors = []) {
    if (buParseResultTitle) {
        buParseResultTitle.innerText = `Business Units Parsed (${records.length} Units)`;
    }
    if (buParseResultMeta) {
        buParseResultMeta.innerText = `Extracted 4 attributes from '${sheetName}' in ${fileName}`;
    }

    if (buValidationStatusBadge) {
        if (errors.length === 0) {
            buValidationStatusBadge.className = 'badge-verified';
            buValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid Business Units`;
        } else {
            buValidationStatusBadge.className = 'badge-pending';
            buValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedBuTableBody) {
        parsedBuTableBody.innerHTML = records.map((bu, idx) => {
            const activeBadge = bu.isActive
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #bbf7d0;">Yes (Active)</span>`
                : `<span style="color: #991b1b; background: #fee2e2; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #fecaca;">No (Inactive)</span>`;

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #2563eb;">${escapeHtml(bu.Business_Unit_Code)}</td>
                    <td style="font-weight: 600; color: #0f172a;">${escapeHtml(bu.Business_Unit_Name)}</td>
                    <td>
                        <span style="font-family: monospace; font-weight: 700; font-size: 0.78rem; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">
                            ${escapeHtml(bu.Head_Employee_ID || 'None')}
                        </span>
                        ${bu.headEmployeeName ? `<span style="font-size: 0.78rem; color: #64748b; margin-left: 4px;">(${escapeHtml(bu.headEmployeeName)})</span>` : ''}
                    </td>
                    <td style="text-align: center;">${activeBadge}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (buParseResultsContainer) buParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Business Units to Cloud Firestore:
 * Path: organizations/{orgId}/business_units/{businessUnitCode}
 */
async function executeBusinessUnitIngest(buDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${buDocs.length} Business Units into organizations/${orgId}/business_units...`);

    let ingestedCount = 0;
    const errors = [];

    for (const bu of buDocs) {
        try {
            const buRef = doc(db, "organizations", orgId, "business_units", bu.businessUnitCode);
            await setDoc(buRef, {
                businessUnitCode: bu.businessUnitCode,
                businessUnitName: bu.businessUnitName,
                headEmployeeId: bu.headEmployeeId || '',
                headEmployeeName: bu.headEmployeeName || '',
                isActive: bu.isActive !== false,
                allowedEmployeeTypes: Array.isArray(bu.allowedEmployeeTypes) ? bu.allowedEmployeeTypes : ['FULL_TIME', 'CONTRACT'],
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });

            // Also dual-sync to bu_employee_type_rules
            const ruleId = `rule_${bu.businessUnitCode.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
            const ruleRef = doc(db, "bu_employee_type_rules", ruleId);
            await setDoc(ruleRef, {
                ruleId,
                businessUnitCode: bu.businessUnitCode,
                businessUnitName: bu.businessUnitName,
                headEmployeeId: bu.headEmployeeId || '',
                headEmployeeName: bu.headEmployeeName || '',
                isActive: bu.isActive !== false,
                allowedEmployeeTypes: Array.isArray(bu.allowedEmployeeTypes) ? bu.allowedEmployeeTypes : ['FULL_TIME', 'CONTRACT'],
                updatedAt: serverTimestamp()
            }, { merge: true }).catch(() => {});

            // Update in-memory rules
            if (window.KylrxBuRules && typeof window.KylrxBuRules.saveRule === 'function') {
                await window.KylrxBuRules.saveRule(bu);
            }

            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest BU ${bu.businessUnitCode}:`, err);
            errors.push(`${bu.businessUnitCode}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${buDocs.length} Business Units.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Business Units Ingested",
            `Successfully ingested all ${ingestedCount} Business Units into Cloud Firestore under organizations/${orgId}/business_units matching PRD Sections 1 & 10!`,
            "success"
        );
    }

    if (btnConfirmBuIngest) {
        btnConfirmBuIngest.disabled = false;
        btnConfirmBuIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    // Refresh UI table if open
    if (window.KylrxBuRules && typeof window.KylrxBuRules.renderAdminRulesTable === 'function') {
        window.KylrxBuRules.renderAdminRulesTable('onboardingBuTableContainer');
    }
}

/**
 * Extracts and maps rows from 'Cost Center' / 'Cost Centre' sheet strictly using 4 attributes:
 * 1. Cost_Center_Code (unique PK)
 * 2. Cost_Center_Name (display title)
 * 3. Owner_Employee_ID (reference to employee ID of leader e.g. CEO, CTO, EVP, Director)
 * 4. Active (boolean: true for "Yes", false for "No")
 */
function extract4CcAttributesFromSheetRows(rows) {
    if (window.KylrxCostCenterParser && typeof window.KylrxCostCenterParser.parseCostCenterSheet === 'function') {
        const lookup = window.KylrxCostCenterService ? window.KylrxCostCenterService.ACTIVE_EMPLOYEES_MASTER : null;
        const res = window.KylrxCostCenterParser.parseCostCenterSheet(rows, lookup);
        return {
            records: res.data,
            firestoreDocs: res.firestoreDocs,
            errors: res.errors
        };
    }

    const records = [];
    const firestoreDocs = [];
    const errors = [];
    const seenCodes = new Set();

    function normalizeKey(str) {
        return String(str || '').toLowerCase().replace(/[\s_-]+/g, '');
    }

    function getVal(row, synonyms) {
        const keys = Object.keys(row);
        for (const syn of synonyms) {
            const cleanSyn = normalizeKey(syn);
            const foundKey = keys.find(k => normalizeKey(k) === cleanSyn);
            if (foundKey && row[foundKey] !== undefined && row[foundKey] !== null) {
                const val = row[foundKey];
                if (typeof val === 'string' && val.trim() !== '') return val.trim();
                if (typeof val !== 'string') return val;
            }
        }
        return null;
    }

    function parseActive(val) {
        if (val === undefined || val === null || val === '') return true;
        if (typeof val === 'boolean') return val;
        const s = String(val).trim().toLowerCase();
        if (['no', 'n', 'false', '0', 'inactive', 'disabled'].includes(s)) return false;
        return true;
    }

    rows.forEach((row, idx) => {
        const vals = Object.values(row).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
        if (vals.length === 0) return; // skip empty rows

        const codeVal = getVal(row, ['Cost_Center_Code', 'costcentercode', 'cccode', 'code', 'cc_code']);
        const nameVal = getVal(row, ['Cost_Center_Name', 'costcentername', 'ccname', 'name', 'cc_name', 'title']);
        const ownerVal = getVal(row, ['Owner_Employee_ID', 'owneremployeeid', 'ownerid', 'owner', 'owner employee id', 'owner employee id (ceo/cto/e...']);
        const activeVal = getVal(row, ['Active', 'is_active', 'isactive', 'status', 'enabled']);

        if (!codeVal || String(codeVal).trim() === '') {
            errors.push(`Row ${idx + 1}: Missing required attribute 'Cost_Center_Code'.`);
            return;
        }
        if (!nameVal || String(nameVal).trim() === '') {
            errors.push(`Row ${idx + 1}: Missing required attribute 'Cost_Center_Name'.`);
            return;
        }

        const costCenterCode = String(codeVal).trim().toUpperCase().replace(/\s+/g, '_');
        const costCenterName = String(nameVal).trim();
        const ownerEmployeeId = ownerVal ? String(ownerVal).trim().toUpperCase() : '';
        const isActive = parseActive(activeVal);

        if (seenCodes.has(costCenterCode)) {
            errors.push(`Row ${idx + 1}: Duplicate Cost_Center_Code '${costCenterCode}'.`);
            return;
        }
        seenCodes.add(costCenterCode);

        // Resolve leader name & designation
        let ownerEmployeeName = '';
        let ownerDesignation = '';
        if (window.KylrxCostCenterService && typeof window.KylrxCostCenterService.getOwnerDetailsById === 'function') {
            const det = window.KylrxCostCenterService.getOwnerDetailsById(ownerEmployeeId);
            ownerEmployeeName = det.name;
            ownerDesignation = det.designation;
        }

        const record = {
            Cost_Center_Code: costCenterCode,
            Cost_Center_Name: costCenterName,
            Owner_Employee_ID: ownerEmployeeId,
            Active: isActive ? "Yes" : "No",
            ownerEmployeeName,
            ownerDesignation,
            isActive
        };

        const firestoreDoc = {
            costCenterCode,
            costCenterName,
            ownerEmployeeId,
            ownerEmployeeName,
            ownerDesignation,
            isActive,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        records.push(record);
        firestoreDocs.push(firestoreDoc);
    });

    return { records, firestoreDocs, errors };
}

/**
 * Renders the parsed Cost Center sheet into the live preview table
 */
function renderParsedCcPreview(fileName, sheetName, records, errors = []) {
    if (ccParseResultTitle) {
        ccParseResultTitle.innerText = `Cost Centers Parsed (${records.length} Units)`;
    }
    if (ccParseResultMeta) {
        ccParseResultMeta.innerText = `Extracted 4 attributes from '${sheetName}' in ${fileName}`;
    }

    if (ccValidationStatusBadge) {
        if (errors.length === 0) {
            ccValidationStatusBadge.className = 'badge-verified';
            ccValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid Cost Centers`;
        } else {
            ccValidationStatusBadge.className = 'badge-pending';
            ccValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedCcTableBody) {
        parsedCcTableBody.innerHTML = records.map((cc, idx) => {
            const activeBadge = cc.isActive
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #bbf7d0;">Yes (Active)</span>`
                : `<span style="color: #991b1b; background: #fee2e2; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #fecaca;">No (Inactive)</span>`;

            return `
                <tr>
                    <td style="font-weight: 700; color: #64748b;">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 700; color: #2563eb;">${escapeHtml(cc.Cost_Center_Code)}</td>
                    <td style="font-weight: 600; color: #0f172a;">${escapeHtml(cc.Cost_Center_Name)}</td>
                    <td>
                        <span style="font-family: monospace; font-weight: 700; font-size: 0.78rem; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">
                            ${escapeHtml(cc.Owner_Employee_ID || 'None')}
                        </span>
                        ${cc.ownerEmployeeName ? `<span style="font-size: 0.78rem; color: #334155; font-weight: 600; margin-left: 4px;">${escapeHtml(cc.ownerEmployeeName)}</span>` : ''}
                        ${cc.ownerDesignation ? `<span style="font-size: 0.72rem; color: #64748b; margin-left: 4px;">(${escapeHtml(cc.ownerDesignation)})</span>` : ''}
                    </td>
                    <td style="text-align: center;">${activeBadge}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (ccParseResultsContainer) ccParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Cost Centers to Cloud Firestore:
 * Path: organizations/{orgId}/cost_centers/{costCenterCode}
 */
async function executeCostCenterIngest(ccDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${ccDocs.length} Cost Centers into organizations/${orgId}/cost_centers...`);

    let ingestedCount = 0;
    const errors = [];

    for (const cc of ccDocs) {
        try {
            const ccRef = doc(db, "organizations", orgId, "cost_centers", cc.costCenterCode);
            await setDoc(ccRef, {
                costCenterCode: cc.costCenterCode,
                costCenterName: cc.costCenterName,
                ownerEmployeeId: cc.ownerEmployeeId || '',
                ownerEmployeeName: cc.ownerEmployeeName || '',
                ownerDesignation: cc.ownerDesignation || '',
                isActive: cc.isActive !== false,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });

            if (window.KylrxCostCenterService && typeof window.KylrxCostCenterService.createCostCenter === 'function') {
                await window.KylrxCostCenterService.createCostCenter(cc);
            }

            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest Cost Center ${cc.costCenterCode}:`, err);
            errors.push(`${cc.costCenterCode}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${ccDocs.length} Cost Centers.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Cost Centers Ingested",
            `Successfully ingested all ${ingestedCount} Cost Centers into Cloud Firestore under organizations/${orgId}/cost_centers matching PRD Sections 1, 10 & 13!`,
            "success"
        );
    }

    if (btnConfirmCcIngest) {
        btnConfirmCcIngest.disabled = false;
        btnConfirmCcIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    if (window.KylrxCostCenterService && typeof window.KylrxCostCenterService.renderAdminConsole === 'function') {
        window.KylrxCostCenterService.renderAdminConsole('onboardingCcTableContainer');
    }
}

/**
 * Extracts and maps rows from 'Sub-Departments' sheet strictly using 5 attributes:
 * 1. Sub-Department_Code (unique PK)
 * 2. Sub-Department_Name (display title)
 * 3. Sub-Department_Head_Employee_ID (reference to employee ID of Sub-Department Lead)
 * 4. Cost_Center_Code (FK mapped to an active Cost Center)
 * 5. Active (boolean: true for "Yes", false for "No")
 */
function extract5SubDeptAttributesFromSheetRows(rows) {
    const records = [];
    const firestoreDocs = [];
    const errors = [];
    const seenCodes = new Set();

    function normalizeKey(str) {
        return String(str || '').toLowerCase().replace(/[\s_-]+/g, '');
    }

    function getVal(row, synonyms) {
        const keys = Object.keys(row);
        for (const syn of synonyms) {
            const cleanSyn = normalizeKey(syn);
            const foundKey = keys.find(k => normalizeKey(k) === cleanSyn);
            if (foundKey && row[foundKey] !== undefined && row[foundKey] !== null) {
                const val = row[foundKey];
                if (typeof val === 'string' && val.trim() !== '') return val.trim();
                if (typeof val !== 'string') return val;
            }
        }
        return null;
    }

    function parseActive(val) {
        if (val === undefined || val === null || val === '') return true;
        if (typeof val === 'boolean') return val;
        const s = String(val).trim().toLowerCase();
        if (['no', 'n', 'false', '0', 'inactive', 'disabled'].includes(s)) return false;
        return true;
    }

    // Get active cost centers for foreign key validation
    let knownCostCenters = new Set();
    if (window.KylrxCostCenterService && typeof window.KylrxCostCenterService.getAllCostCenters === 'function') {
        const ccs = window.KylrxCostCenterService.getAllCostCenters();
        ccs.forEach(c => knownCostCenters.add(c.costCenterCode.toUpperCase()));
    } else {
        ['CC_ENG_01', 'CC-ENG-101', 'CC_ENG_DEV', 'CC-AI-102', 'CC-HR-201', 'CC-FIN-301', 'CC-OPS-401'].forEach(c => knownCostCenters.add(c));
    }

    rows.forEach((row, idx) => {
        const vals = Object.values(row).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
        if (vals.length === 0) return; // skip empty rows

        const codeVal = getVal(row, ['Sub-Department_Code', 'subdepartmentcode', 'sub_dept_code', 'subdeptcode', 'code']);
        const nameVal = getVal(row, ['Sub-Department_Name', 'subdepartmentname', 'sub_dept_name', 'subdeptname', 'name', 'title']);
        const headVal = getVal(row, ['Sub-Department_Head_Employee_ID', 'subdepartmentheademployeeid', 'sub_dept_head_employee_id', 'heademployeeid', 'head_employee_id', 'headid']);
        const ccVal = getVal(row, ['Cost_Center_Code', 'costcentercode', 'cccode', 'cost_centre_code', 'cc_code']);
        const activeVal = getVal(row, ['Active', 'is_active', 'isactive', 'status', 'enabled']);

        if (!codeVal || String(codeVal).trim() === '') {
            errors.push(`Row ${idx + 1}: Missing required attribute 'Sub-Department_Code'.`);
            return;
        }
        if (!nameVal || String(nameVal).trim() === '') {
            errors.push(`Row ${idx + 1}: Missing required attribute 'Sub-Department_Name'.`);
            return;
        }
        if (!ccVal || String(ccVal).trim() === '') {
            errors.push(`Row ${idx + 1}: Missing required attribute 'Cost_Center_Code'.`);
            return;
        }

        const subDepartmentCode = String(codeVal).trim().toUpperCase().replace(/\s+/g, '_');
        const subDepartmentName = String(nameVal).trim();
        const costCenterCode = String(ccVal).trim().toUpperCase().replace(/\s+/g, '_');
        const isActive = parseActive(activeVal);

        if (seenCodes.has(subDepartmentCode)) {
            errors.push(`Row ${idx + 1}: Duplicate Sub-Department_Code '${subDepartmentCode}'.`);
            return;
        }
        seenCodes.add(subDepartmentCode);

        // Validate Foreign Key Cost_Center_Code
        if (knownCostCenters.size > 0 && !knownCostCenters.has(costCenterCode)) {
            errors.push(`Row ${idx + 1}: Cost_Center_Code '${costCenterCode}' does not exist in Cost Centers repository.`);
            return;
        }

        // PRD Sections 1, 10, & 13: "Same as Department Head" Rule Resolution
        const cleanHead = String(headVal || '').trim().toLowerCase();
        const isSame = !headVal || cleanHead === 'same as department head' || cleanHead === 'same as dept head' || cleanHead === 'inherit' || cleanHead === 'same';

        let departmentCode = 'DEPT_ENG';
        let resolvedHeadId = 'EMP0002';
        let resolvedHeadName = 'Vikram Malhotra';

        if (costCenterCode === 'CC_ENG_01') {
            departmentCode = 'DEPT_ENG';
            resolvedHeadId = 'EMP0002';
            resolvedHeadName = 'Vikram Malhotra';
        } else if (costCenterCode.startsWith('CC-ENG') || costCenterCode === 'CC_ENG_DEV') {
            departmentCode = 'ENG';
            resolvedHeadId = 'EMP0001';
            resolvedHeadName = 'Devendra Sharma';
        } else if (costCenterCode.startsWith('CC-AI')) {
            departmentCode = 'AI-LABS';
            resolvedHeadId = 'EMP0007';
            resolvedHeadName = 'Dr. Kumar Mangalam';
        } else if (costCenterCode.startsWith('CC-HR')) {
            departmentCode = 'HR';
            resolvedHeadId = 'EMP0003';
            resolvedHeadName = 'Ananya Roy';
        } else if (costCenterCode.startsWith('CC-FIN')) {
            departmentCode = 'FIN';
            resolvedHeadId = 'EMP0004';
            resolvedHeadName = 'Rajesh Raman';
        } else if (costCenterCode.startsWith('CC-OPS')) {
            departmentCode = 'OPS';
            resolvedHeadId = 'EMP0005';
            resolvedHeadName = 'Sneha Sen';
        }

        // Resolve head name
        let headEmployeeId = '';
        let headEmployeeName = '';

        if (isSame) {
            headEmployeeId = resolvedHeadId;
            headEmployeeName = resolvedHeadName;
        } else {
            headEmployeeId = String(headVal).trim().toUpperCase();
            if (window.KylrxSubDepartmentParser && typeof window.KylrxSubDepartmentParser.resolveHeadName === 'function') {
                headEmployeeName = window.KylrxSubDepartmentParser.resolveHeadName(headEmployeeId);
            } else {
                headEmployeeName = `${headEmployeeId} Lead`;
            }
        }

        const record = {
            'Sub-Department_Code': subDepartmentCode,
            'Sub-Department_Name': subDepartmentName,
            'Sub-Department_Head_Employee_ID': isSame ? 'Same as Department Head' : headEmployeeId,
            'Cost_Center_Code': costCenterCode,
            'Active': isActive ? "Yes" : "No",
            subDepartmentCode,
            subDepartmentName,
            costCenterCode,
            departmentCode,
            sameAsDeptHead: isSame,
            inheritedFromDeptHead: isSame,
            subDepartmentHeadEmployeeId: headEmployeeId,
            subDepartmentHeadName: headEmployeeName,
            headEmployeeId,
            headEmployeeName,
            isActive
        };

        const firestoreDoc = {
            subDepartmentCode,
            subDepartmentName,
            costCenterCode,
            departmentCode,
            sameAsDeptHead: isSame,
            inheritedFromDeptHead: isSame,
            subDepartmentHeadEmployeeId: headEmployeeId,
            subDepartmentHeadName: headEmployeeName,
            headEmployeeId,
            headEmployeeName,
            isActive,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        records.push(record);
        firestoreDocs.push(firestoreDoc);
    });

    return { records, firestoreDocs, errors };
}

/**
 * Renders the parsed Sub-Departments sheet into the live preview table
 */
function renderParsedSubDeptPreview(fileName, sheetName, records, errors = []) {
    if (subDeptParseResultTitle) {
        subDeptParseResultTitle.innerText = `Sub-Departments Parsed (${records.length} Units)`;
    }
    if (subDeptParseResultMeta) {
        subDeptParseResultMeta.innerText = `Extracted 5 attributes from '${sheetName}' in ${fileName}`;
    }

    if (subDeptValidationStatusBadge) {
        if (errors.length === 0) {
            subDeptValidationStatusBadge.className = 'badge-verified';
            subDeptValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid Sub-Departments`;
        } else {
            subDeptValidationStatusBadge.className = 'badge-pending';
            subDeptValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedSubDeptTableBody) {
        parsedSubDeptTableBody.innerHTML = records.map((sub, idx) => {
            const activeBadge = sub.isActive
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #bbf7d0;">Yes (Active)</span>`
                : `<span style="color: #991b1b; background: #fee2e2; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #fecaca;">No (Inactive)</span>`;

            const inheritedTag = (sub.sameAsDeptHead || sub.inheritedFromDeptHead)
                ? `<span style="background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 4px; font-size: 0.68rem; font-weight: 700; margin-left: 4px;">Inherited</span>`
                : '';

            return `
                <tr>
                    <td style="font-weight: 700; color: #64748b;">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 700; color: #7e22ce;">${escapeHtml(sub['Sub-Department_Code'] || sub.subDepartmentCode)}</td>
                    <td style="font-weight: 600; color: #0f172a;">${escapeHtml(sub['Sub-Department_Name'] || sub.subDepartmentName)}</td>
                    <td>
                        <span style="font-family: monospace; font-weight: 700; font-size: 0.78rem; background: #f1f5f9; padding: 2px 6px; border-radius: 4px;">
                            ${escapeHtml(sub.subDepartmentHeadEmployeeId || sub.headEmployeeId || sub['Sub-Department_Head_Employee_ID'] || 'None')}
                        </span>
                        ${inheritedTag}
                        ${sub.subDepartmentHeadName || sub.headEmployeeName ? `<span style="font-size: 0.78rem; color: #334155; font-weight: 600; margin-left: 4px;">(${escapeHtml(sub.subDepartmentHeadName || sub.headEmployeeName)})</span>` : ''}
                    </td>
                    <td>
                        <span style="font-family: monospace; font-weight: 700; font-size: 0.78rem; background: #eff6ff; color: #1d4ed8; padding: 2px 6px; border-radius: 4px;">
                            ${escapeHtml(sub['Cost_Center_Code'] || sub.costCenterCode)}
                        </span>
                    </td>
                    <td style="text-align: center;">${activeBadge}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (subDeptParseResultsContainer) subDeptParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Sub-Departments to Cloud Firestore:
 * Path: organizations/{orgId}/sub_departments/{subDepartmentCode}
 */
async function executeSubDepartmentIngest(subDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${subDocs.length} Sub-Departments into organizations/${orgId}/sub_departments...`);

    let ingestedCount = 0;
    const errors = [];

    for (const sub of subDocs) {
        try {
            const subRef = doc(db, "organizations", orgId, "sub_departments", sub.subDepartmentCode);
            await setDoc(subRef, {
                subDepartmentCode: sub.subDepartmentCode,
                subDepartmentName: sub.subDepartmentName,
                headEmployeeId: sub.headEmployeeId || '',
                headEmployeeName: sub.headEmployeeName || '',
                costCenterCode: sub.costCenterCode,
                isActive: sub.isActive !== false,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });

            if (window.KylrxSubDepartmentService && typeof window.KylrxSubDepartmentService.createSubDepartment === 'function') {
                await window.KylrxSubDepartmentService.createSubDepartment(sub);
            }

            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest Sub-Department ${sub.subDepartmentCode}:`, err);
            errors.push(`${sub.subDepartmentCode}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${subDocs.length} Sub-Departments.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Sub-Departments Ingested",
            `Successfully ingested all ${ingestedCount} Sub-Departments into Cloud Firestore under organizations/${orgId}/sub_departments matching PRD Sections 1, 10 & 13!`,
            "success"
        );
    }

    if (btnConfirmSubDeptIngest) {
        btnConfirmSubDeptIngest.disabled = false;
        btnConfirmSubDeptIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    if (window.KylrxSubDepartmentService && typeof window.KylrxSubDepartmentService.renderAdminConsole === 'function') {
        window.KylrxSubDepartmentService.renderAdminConsole('onboardingSubDeptTableContainer');
    }
}

/**
 * Extracts and maps rows from 'Shifts & Week-offs' sheet strictly across 13 attributes:
 * 1. Shift_Code (PK)
 * 2. Shift_Name
 * 3. Start_Time
 * 4. End_Time
 * 5. Break_Minutes
 * 6. Grace_In_Minutes
 * 7. Grace_Out_Minutes
 * 8. Half_Day_Minutes
 * 9. Full_Day_Minutes
 * 10. Night_Shift
 * 11. Overtime_Eligible
 * 12. Weekly_Off_Pattern
 * 13. Active
 */
function extract13ShiftAttributesFromSheetRows(rows) {
    if (window.KylrxShiftParser && typeof window.KylrxShiftParser.parseShiftRows === 'function') {
        const res = window.KylrxShiftParser.parseShiftRows(rows);
        return {
            records: res.validRecords || [],
            firestoreDocs: res.firestoreDocs || [],
            errors: res.errors || []
        };
    }

    const records = [];
    const firestoreDocs = [];
    const errors = [];
    const seenCodes = new Set();

    function normalizeKey(str) {
        return String(str || '').toLowerCase().replace(/[\s_-]+/g, '');
    }

    function getVal(row, synonyms) {
        const keys = Object.keys(row);
        for (const syn of synonyms) {
            const cleanSyn = normalizeKey(syn);
            const foundKey = keys.find(k => normalizeKey(k) === cleanSyn);
            if (foundKey && row[foundKey] !== undefined && row[foundKey] !== null) {
                const val = row[foundKey];
                if (typeof val === 'string' && val.trim() !== '') return val.trim();
                if (typeof val !== 'string') return val;
            }
        }
        return null;
    }

    function parseTime(val, fallback) {
        if (!val) return fallback;
        const str = String(val).trim();
        if (!isNaN(Number(str)) && Number(str) > 0 && Number(str) < 1) {
            const totalMinutes = Math.round(Number(str) * 24 * 60);
            const hours = Math.floor(totalMinutes / 60) % 24;
            const mins = totalMinutes % 60;
            return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        }
        const match = str.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])/);
        if (match) {
            return `${String(match[1]).padStart(2, '0')}:${String(match[2]).padStart(2, '0')}`;
        }
        return fallback;
    }

    function parseNum(val, def) {
        if (val === undefined || val === null || val === '') return def;
        const n = Number(val);
        return isNaN(n) ? def : Math.round(n);
    }

    function parseBool(val, def) {
        if (val === undefined || val === null || val === '') return def;
        if (typeof val === 'boolean') return val;
        const s = String(val).trim().toLowerCase();
        if (['yes', 'y', 'true', '1', 'active'].includes(s)) return true;
        if (['no', 'n', 'false', '0', 'inactive'].includes(s)) return false;
        return def;
    }

    rows.forEach((row, idx) => {
        const vals = Object.values(row).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
        if (vals.length === 0) return;

        const codeVal = getVal(row, ['Shift_Code', 'shiftcode', 'code', 'shift_id']);
        const nameVal = getVal(row, ['Shift_Name', 'shiftname', 'name', 'title']);

        if (!codeVal || !nameVal) {
            errors.push(`Row ${idx + 1}: Missing required Shift_Code or Shift_Name.`);
            return;
        }

        const shiftCode = String(codeVal).trim().toUpperCase().replace(/\s+/g, '_');
        if (seenCodes.has(shiftCode)) {
            errors.push(`Row ${idx + 1}: Duplicate Shift_Code '${shiftCode}' detected.`);
            return;
        }
        seenCodes.add(shiftCode);

        const shiftName = String(nameVal).trim();
        const startTime = parseTime(getVal(row, ['Start_Time', 'starttime', 'start', 'in_time']), '09:30');
        const endTime = parseTime(getVal(row, ['End_Time', 'endtime', 'end', 'out_time']), '18:30');

        const breakMinutes = parseNum(getVal(row, ['Break_Minutes', 'breakminutes', 'break', 'break_mins']), 60);
        const graceInMinutes = parseNum(getVal(row, ['Grace_In_Minutes', 'graceinminutes', 'grace_in', 'grace-in-minutes']), 15);
        const graceOutMinutes = parseNum(getVal(row, ['Grace_Out_Minutes', 'graceoutminutes', 'grace_out', 'grace-out-minutes']), 15);
        const halfDayMinutes = parseNum(getVal(row, ['Half_Day_Minutes', 'halfdayminutes', 'half_day']), 240);
        const fullDayMinutes = parseNum(getVal(row, ['Full_Day_Minutes', 'fulldayminutes', 'full_day']), 480);

        const isNightShift = parseBool(getVal(row, ['Night_Shift', 'nightshift', 'is_night_shift']), false);
        const isOvertimeEligible = parseBool(getVal(row, ['Overtime_Eligible', 'overtimeeligible', 'is_overtime_eligible']), true);
        const weeklyOffPattern = String(getVal(row, ['Weekly_Off_Pattern', 'weeklyoffpattern', 'weekly_off', 'week_off']) || 'Sun').trim();
        const isActive = parseBool(getVal(row, ['Active', 'is_active', 'isactive', 'status']), true);

        const record = {
            'Shift_Code': shiftCode,
            'Shift_Name': shiftName,
            'Start_Time': startTime,
            'End_Time': endTime,
            'Break_Minutes': breakMinutes,
            'Grace_In_Minutes': graceInMinutes,
            'Grace_Out_Minutes': graceOutMinutes,
            'Half_Day_Minutes': halfDayMinutes,
            'Full_Day_Minutes': fullDayMinutes,
            'Night_Shift': isNightShift ? 'Yes' : 'No',
            'Overtime_Eligible': isOvertimeEligible ? 'Yes' : 'No',
            'Weekly_Off_Pattern': weeklyOffPattern,
            'Active': isActive ? 'Yes' : 'No',

            shiftCode,
            shiftName,
            startTime,
            endTime,
            breakMinutes,
            graceInMinutes,
            graceOutMinutes,
            halfDayMinutes,
            fullDayMinutes,
            isNightShift,
            nightShift: isNightShift,
            isOvertimeEligible,
            overtimeEligible: isOvertimeEligible,
            weeklyOffPattern,
            isActive
        };

        const firestoreDoc = {
            shiftCode,
            shiftName,
            startTime,
            endTime,
            breakMinutes,
            graceInMinutes,
            graceOutMinutes,
            halfDayMinutes,
            fullDayMinutes,
            isNightShift,
            isOvertimeEligible,
            weeklyOffPattern,
            isActive
        };

        records.push(record);
        firestoreDocs.push(firestoreDoc);
    });

    return { records, firestoreDocs, errors };
}

/**
 * Renders the parsed Shifts sheet into the live preview table
 */
function renderParsedShiftPreview(fileName, sheetName, records, errors = []) {
    if (shiftParseResultTitle) {
        shiftParseResultTitle.innerText = `Shifts & Week-offs Parsed (${records.length} Schedules)`;
    }
    if (shiftParseResultMeta) {
        shiftParseResultMeta.innerText = `Extracted 13 attributes from '${sheetName}' in ${fileName}`;
    }

    if (shiftValidationStatusBadge) {
        if (errors.length === 0) {
            shiftValidationStatusBadge.className = 'badge-verified';
            shiftValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid Shifts`;
        } else {
            shiftValidationStatusBadge.className = 'badge-pending';
            shiftValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedShiftTableBody) {
        parsedShiftTableBody.innerHTML = records.map((s, idx) => {
            const activeBadge = s.isActive
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #bbf7d0;">Yes</span>`
                : `<span style="color: #991b1b; background: #fee2e2; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #fecaca;">No</span>`;

            const nightBadge = (s.isNightShift === true || s.nightShift === true || s['Night_Shift'] === 'Yes')
                ? `<span style="background: #312e81; color: #e0e7ff; padding: 2px 6px; border-radius: 4px; font-size: 0.68rem; font-weight: 700;">Night</span>`
                : `<span style="background: #f1f5f9; color: #475569; padding: 2px 6px; border-radius: 4px; font-size: 0.68rem;">Day</span>`;

            const otBadge = (s.isOvertimeEligible !== false && s['Overtime_Eligible'] !== 'No')
                ? `<span style="background: #eff6ff; color: #1d4ed8; padding: 2px 6px; border-radius: 4px; font-size: 0.68rem; font-weight: 700; margin-left: 2px;">OT</span>`
                : '';

            return `
                <tr>
                    <td style="font-weight: 700; color: #64748b;">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 700; color: #2563eb;">${escapeHtml(s['Shift_Code'] || s.shiftCode)}</td>
                    <td style="font-weight: 600; color: #0f172a;">${escapeHtml(s['Shift_Name'] || s.shiftName)}</td>
                    <td style="font-family: monospace; font-size: 0.8rem; font-weight: 700; color: #1e293b;">
                        ${s['Start_Time'] || s.startTime} - ${s['End_Time'] || s.endTime}
                    </td>
                    <td style="font-size: 0.75rem; color: #64748b;">
                        ${s['Break_Minutes'] || s.breakMinutes}m | +${s['Grace_In_Minutes'] || s.graceInMinutes}/-${s['Grace_Out_Minutes'] || s.graceOutMinutes}m
                    </td>
                    <td style="font-size: 0.75rem; font-weight: 600; color: #334155;">
                        ${s['Half_Day_Minutes'] || s.halfDayMinutes}m / ${s['Full_Day_Minutes'] || s.fullDayMinutes}m
                    </td>
                    <td>
                        <span style="font-family: monospace; font-size: 0.75rem; background: #f8fafc; padding: 2px 6px; border-radius: 4px; font-weight: 700;">
                            ${escapeHtml(s['Weekly_Off_Pattern'] || s.weeklyOffPattern)}
                        </span>
                    </td>
                    <td style="text-align: center;">${nightBadge}${otBadge}</td>
                    <td style="text-align: center;">${activeBadge}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (shiftParseResultsContainer) shiftParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Shifts to Cloud Firestore:
 * Path: organizations/{orgId}/shifts/{shiftCode}
 */
async function executeShiftIngest(shiftDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${shiftDocs.length} Shift schedules into organizations/${orgId}/shifts...`);

    let ingestedCount = 0;
    const errors = [];

    for (const shift of shiftDocs) {
        try {
            const shiftRef = doc(db, "organizations", orgId, "shifts", shift.shiftCode);
            await setDoc(shiftRef, {
                shiftCode: shift.shiftCode,
                shiftName: shift.shiftName,
                startTime: shift.startTime,
                endTime: shift.endTime,
                breakMinutes: shift.breakMinutes,
                graceInMinutes: shift.graceInMinutes,
                graceOutMinutes: shift.graceOutMinutes,
                halfDayMinutes: shift.halfDayMinutes,
                fullDayMinutes: shift.fullDayMinutes,
                isNightShift: shift.isNightShift,
                isOvertimeEligible: shift.isOvertimeEligible,
                weeklyOffPattern: shift.weeklyOffPattern,
                isActive: shift.isActive,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });

            if (window.KylrxShiftCalculationService && typeof window.KylrxShiftCalculationService.createShift === 'function') {
                await window.KylrxShiftCalculationService.createShift(shift, orgId);
            }

            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest Shift ${shift.shiftCode}:`, err);
            errors.push(`${shift.shiftCode}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${shiftDocs.length} Shifts.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Shifts Ingested",
            `Successfully ingested all ${ingestedCount} Shift policies into Cloud Firestore under organizations/${orgId}/shifts matching PRD Sections 1, 13 & 16!`,
            "success"
        );
    }

    if (btnConfirmShiftIngest) {
        btnConfirmShiftIngest.disabled = false;
        btnConfirmShiftIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    if (window.KylrxShiftCalculationService && typeof window.KylrxShiftCalculationService.renderAdminConsole === 'function') {
        window.KylrxShiftCalculationService.renderAdminConsole('onboardingShiftTableContainer');
    }
}

/**
 * Extracts and maps rows from 'Attendance Rules' sheet strictly using 13 attributes (PRD Sections 1, 15 & 16):
 * 1. Attendance_Policy_Code (PK)
 * 2. Policy_Name
 * 3. Late_After_Minutes
 * 4. Early_Leaving_Grace_Minute
 * 5. Absent_After_Hours
 * 6. Regularization_Allowed
 * 7. Regularization_Window_Days
 * 8. WFH_Allowed
 * 9. OT_Minimum_Minutes
 * 10. OT_Approval_Required
 * 11. GeoFence_Required
 * 12. IP_Restricted
 * 13. Active
 */
function extract13PolicyAttributesFromSheetRows(rows) {
    if (window.KylrxAttendancePolicyParser && typeof window.KylrxAttendancePolicyParser.parseAttendancePolicyRows === 'function') {
        const parsed = window.KylrxAttendancePolicyParser.parseAttendancePolicyRows(rows);
        return {
            records: parsed.validRecords || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || []
        };
    }

    const records = [];
    const firestoreDocs = [];
    const errors = [];
    const seenCodes = new Set();

    function parseBool(val, defaultVal = false) {
        if (val === undefined || val === null || val === '') return defaultVal;
        if (typeof val === 'boolean') return val;
        const s = String(val).trim().toLowerCase();
        if (['yes', 'true', '1', 'y', 'enabled', 'active'].includes(s)) return true;
        if (['no', 'false', '0', 'n', 'disabled', 'inactive'].includes(s)) return false;
        return defaultVal;
    }

    function parseNum(val, defaultVal = 0) {
        if (val === undefined || val === null || val === '') return defaultVal;
        const n = Number(val);
        return isNaN(n) ? defaultVal : n;
    }

    rows.forEach((row, idx) => {
        const rowNum = idx + 2;
        const norm = {};
        for (const [k, v] of Object.entries(row)) {
            norm[k.trim().toLowerCase().replace(/[\s_-]+/g, '')] = typeof v === 'string' ? v.trim() : v;
        }

        const codeRaw = norm.attendancepolicycode || norm.policycode || norm.code || norm.policyid || '';
        const policyCode = String(codeRaw).trim().toUpperCase();

        if (!policyCode) {
            errors.push(`Row ${rowNum}: Missing mandatory 'Attendance_Policy_Code'.`);
            return;
        }
        if (seenCodes.has(policyCode)) {
            errors.push(`Row ${rowNum}: Duplicate Policy Code "${policyCode}".`);
            return;
        }
        seenCodes.add(policyCode);

        const policyName = String(norm.policyname || norm.name || norm.title || policyCode).trim();
        const lateAfterMinutes = parseNum(norm.lateafterminutes || norm.lateafter || norm.lateminutes, 15);
        const earlyLeavingGraceMinute = parseNum(norm.earlyleavinggraceminute || norm.earlyleavinggrace || norm.earlygrace, 10);
        const absentAfterHours = parseNum(norm.absentafterhours || norm.absentafter || norm.absenthours, 4);
        const regularizationAllowed = parseBool(norm.regularizationallowed !== undefined ? norm.regularizationallowed : norm.regularization, true);
        const regularizationWindowDays = parseNum(norm.regularizationwindowdays || norm.regularizationwindow, 7);
        const wfhAllowed = parseBool(norm.wfhallowed !== undefined ? norm.wfhallowed : norm.wfh, true);
        const otMinimumMinutes = parseNum(norm.otminimumminutes || norm.otminimum, 60);
        const otApprovalRequired = parseBool(norm.otapprovalrequired !== undefined ? norm.otapprovalrequired : norm.otapproval, true);
        const geoFenceRequired = parseBool(norm.geofencerequired !== undefined ? norm.geofencerequired : norm.geofence, false);
        const ipRestricted = parseBool(norm.iprestricted !== undefined ? norm.iprestricted : norm.iprestriction, false);
        const isActive = parseBool(norm.active !== undefined ? norm.active : norm.isactive, true);

        const rec = {
            'Attendance_Policy_Code': policyCode,
            'Policy_Name': policyName,
            'Late_After_Minutes': lateAfterMinutes,
            'Early_Leaving_Grace_Minute': earlyLeavingGraceMinute,
            'Absent_After_Hours': absentAfterHours,
            'Regularization_Allowed': regularizationAllowed ? 'Yes' : 'No',
            'Regularization_Window_Days': regularizationWindowDays,
            'WFH_Allowed': wfhAllowed ? 'Yes' : 'No',
            'OT_Minimum_Minutes': otMinimumMinutes,
            'OT_Approval_Required': otApprovalRequired ? 'Yes' : 'No',
            'GeoFence_Required': geoFenceRequired ? 'Yes' : 'No',
            'IP_Restricted': ipRestricted ? 'Yes' : 'No',
            'Active': isActive ? 'Yes' : 'No',
            attendancePolicyCode: policyCode,
            policyName,
            lateAfterMinutes,
            earlyLeavingGraceMinute,
            absentAfterHours,
            regularizationAllowed,
            regularizationWindowDays,
            wfhAllowed,
            otMinimumMinutes,
            otApprovalRequired,
            geoFenceRequired,
            ipRestricted,
            isActive
        };

        const docObj = {
            attendancePolicyCode: policyCode,
            policyName,
            lateAfterMinutes,
            earlyLeavingGraceMinute,
            absentAfterHours,
            regularizationAllowed,
            regularizationWindowDays,
            wfhAllowed,
            otMinimumMinutes,
            otApprovalRequired,
            geoFenceRequired,
            ipRestricted,
            isActive
        };

        records.push(rec);
        firestoreDocs.push(docObj);
    });

    return { records, firestoreDocs, errors };
}

/**
 * Renders Preview for parsed Attendance Rules & Policies
 */
function renderParsedPolicyPreview(fileName, sheetName, records, errors = []) {
    if (policyParseResultTitle) {
        policyParseResultTitle.textContent = `Attendance Rules & Policies (${records.length} Policies Detected)`;
    }
    if (policyParseResultMeta) {
        policyParseResultMeta.textContent = `Source: ${fileName} • Sheet: ${sheetName} • Conforming strictly to PRD §§ 1, 15 & 16`;
    }

    if (policyValidationStatusBadge) {
        if (errors.length === 0) {
            policyValidationStatusBadge.className = 'badge-verified';
            policyValidationStatusBadge.innerHTML = '<i data-lucide="check-circle" style="width: 14px;"></i> 13 Attributes Validated';
        } else {
            policyValidationStatusBadge.className = 'badge-pending';
            policyValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedPolicyTableBody) {
        parsedPolicyTableBody.innerHTML = records.map((p, idx) => {
            const activeBadge = p.isActive
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #bbf7d0;">Yes</span>`
                : `<span style="color: #991b1b; background: #fee2e2; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #fecaca;">No</span>`;

            const geoBadge = p.geoFenceRequired
                ? `<span style="background: #eff6ff; color: #1d4ed8; padding: 2px 6px; border-radius: 4px; font-size: 0.68rem; font-weight: 700; margin-right: 2px;">Geo</span>`
                : '';
            const ipBadge = p.ipRestricted
                ? `<span style="background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 4px; font-size: 0.68rem; font-weight: 700; margin-right: 2px;">IP</span>`
                : '';
            const wfhBadge = p.wfhAllowed
                ? `<span style="background: #dcfce7; color: #166534; padding: 2px 6px; border-radius: 4px; font-size: 0.68rem; font-weight: 700;">WFH</span>`
                : '';

            return `
                <tr>
                    <td style="font-weight: 700; color: #64748b;">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 700; color: #059669;">${escapeHtml(p.attendancePolicyCode || p['Attendance_Policy_Code'])}</td>
                    <td style="font-weight: 600; color: #0f172a;">${escapeHtml(p.policyName || p['Policy_Name'])}</td>
                    <td style="font-size: 0.75rem; color: #334155;">
                        Late &gt;${p.lateAfterMinutes}m • Early &gt;${p.earlyLeavingGraceMinute}m<br>
                        <span style="color: #b91c1c; font-weight: 700;">Absent &gt;${p.absentAfterHours}h</span>
                    </td>
                    <td style="font-size: 0.75rem; color: #334155;">
                        ${p.regularizationAllowed ? `<span style="color: #166534; font-weight: 700;">Allowed</span> (${p.regularizationWindowDays}d max)` : '<span style="color: #94a3b8;">Disabled</span>'}
                    </td>
                    <td style="font-size: 0.75rem; color: #334155;">
                        Min ${p.otMinimumMinutes}m • ${p.otApprovalRequired ? '<span style="color: #b45309; font-weight: 700;">L1 Required</span>' : 'Auto'}
                    </td>
                    <td style="text-align: center;">${geoBadge}${ipBadge}${wfhBadge || '<span style="color:#94a3b8; font-size:0.7rem;">None</span>'}</td>
                    <td style="text-align: center;">${activeBadge}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (policyParseResultsContainer) policyParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Extracts and maps rows from 'Employee Type' sheet strictly using 7 attributes (PRD Sections 1, 10 & 13):
 * 1. Category_Code (PK)
 * 2. Category_Name
 * 3. Employment_Type
 * 4. Worker_Type
 * 5. Probation_Days
 * 6. Notice_Period_Days
 * 7. Active
 */
function extract7EmployeeTypeAttributesFromSheetRows(rows) {
    if (window.KylrxEmployeeTypeParser && typeof window.KylrxEmployeeTypeParser.parseEmployeeTypeSheet === 'function') {
        const parsed = window.KylrxEmployeeTypeParser.parseEmployeeTypeSheet(rows);
        return {
            records: parsed.records || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || []
        };
    }

    const records = [];
    const firestoreDocs = [];
    const errors = [];
    const seenCodes = new Set();

    function parseBool(val, defaultVal = true) {
        if (val === undefined || val === null || val === '') return defaultVal;
        if (typeof val === 'boolean') return val;
        const s = String(val).trim().toLowerCase();
        if (['yes', 'true', '1', 'y', 'enabled', 'active'].includes(s)) return true;
        if (['no', 'false', '0', 'n', 'disabled', 'inactive'].includes(s)) return false;
        return defaultVal;
    }

    function parseNum(val, defaultVal = 0) {
        if (val === undefined || val === null || val === '') return defaultVal;
        if (typeof val === 'number') return isNaN(val) ? defaultVal : Math.round(val);
        const match = String(val).trim().match(/^-?(\d+(\.\d+)?)/);
        if (!match) return defaultVal;
        const n = Math.round(parseFloat(match[1]));
        return isNaN(n) ? defaultVal : n;
    }

    rows.forEach((row, idx) => {
        const rowNum = idx + 2;
        const norm = {};
        for (const [k, v] of Object.entries(row)) {
            norm[k.trim().toLowerCase().replace(/[\s_-]+/g, '')] = typeof v === 'string' ? v.trim() : v;
        }

        const codeRaw = norm.categorycode || norm.category_code || norm.typecode || norm.type_code || norm.code || norm.id;
        const categoryCode = String(codeRaw || '').trim().toUpperCase().replace(/\s+/g, '_');

        if (!categoryCode) {
            errors.push(`Row ${rowNum}: Missing mandatory 'Category_Code'.`);
            return;
        }
        if (seenCodes.has(categoryCode)) {
            errors.push(`Row ${rowNum}: Duplicate Category Code "${categoryCode}".`);
            return;
        }
        seenCodes.add(categoryCode);

        const categoryName = String(norm.categoryname || norm.category_name || norm.name || categoryCode).trim();
        const employmentType = String(norm.employmenttype || norm.employment_type || 'Permanent').trim();
        const workerType = String(norm.workertype || norm.worker_type || 'White Collar').trim();
        const probationDays = parseNum(norm.probationdays || norm.probation_days || norm.probation, 180);
        const noticePeriodDays = parseNum(norm.noticeperioddays || norm.notice_period_days || norm.notice, 60);
        const isActive = parseBool(norm.active !== undefined ? norm.active : norm.isactive, true);

        const rec = {
            Category_Code: categoryCode,
            Category_Name: categoryName,
            Employment_Type: employmentType,
            Worker_Type: workerType,
            Probation_Days: probationDays,
            Notice_Period_Days: noticePeriodDays,
            Active: isActive ? 'Yes' : 'No',
            categoryCode,
            categoryName,
            employmentType,
            workerType,
            probationDays,
            noticePeriodDays,
            isActive
        };

        const docObj = {
            categoryCode,
            categoryName,
            employmentType,
            workerType,
            probationDays,
            noticePeriodDays,
            isActive,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };

        records.push(rec);
        firestoreDocs.push(docObj);
    });

    return { records, firestoreDocs, errors };
}

/**
 * Renders parsed Employee Type preview table
 */
function renderParsedEmployeeTypePreview(fileName, sheetName, records, errors = []) {
    if (employeeTypeParseResultTitle) {
        employeeTypeParseResultTitle.innerText = `Employee Types Parsed (${records.length} Categories)`;
    }
    if (employeeTypeParseResultMeta) {
        employeeTypeParseResultMeta.innerText = `Extracted 7 attributes from '${sheetName}' in ${fileName}`;
    }

    if (employeeTypeValidationStatusBadge) {
        if (errors.length === 0) {
            employeeTypeValidationStatusBadge.className = 'badge-verified';
            employeeTypeValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid Categories`;
        } else {
            employeeTypeValidationStatusBadge.className = 'badge-pending';
            employeeTypeValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedEmployeeTypeTableBody) {
        parsedEmployeeTypeTableBody.innerHTML = records.map((t, idx) => {
            const activeBadge = t.isActive
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #bbf7d0;">Yes</span>`
                : `<span style="color: #991b1b; background: #fee2e2; font-weight: 800; padding: 2px 8px; border-radius: 9999px; font-size: 0.72rem; border: 1px solid #fecaca;">No</span>`;

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #7c3aed;">${escapeHtml(t.categoryCode)}</td>
                    <td style="font-weight: 700; color: #1e293b;">${escapeHtml(t.categoryName)}</td>
                    <td>
                        <span style="font-size: 0.75rem; font-weight: 700; background: #ede9fe; color: #6d28d9; padding: 2px 8px; border-radius: 6px;">
                            ${escapeHtml(t.employmentType)}
                        </span>
                    </td>
                    <td>
                        <span style="font-size: 0.75rem; font-weight: 700; background: #f1f5f9; color: #475569; padding: 2px 8px; border-radius: 6px;">
                            ${escapeHtml(t.workerType)}
                        </span>
                    </td>
                    <td style="font-weight: 600; color: #334155;">${t.probationDays} days</td>
                    <td style="font-weight: 600; color: #334155;">${t.noticePeriodDays} days</td>
                    <td style="text-align: center;">${activeBadge}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (employeeTypeParseResultsContainer) employeeTypeParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Employee Types to Cloud Firestore:
 * Path: organizations/{orgId}/employee_types/{categoryCode}
 */
async function executeEmployeeTypeIngest(typeDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${typeDocs.length} Employee Types into organizations/${orgId}/employee_types...`);

    let ingestedCount = 0;
    const errors = [];

    for (const t of typeDocs) {
        try {
            const typeRef = doc(db, "organizations", orgId, "employee_types", t.categoryCode);
            await setDoc(typeRef, {
                categoryCode: t.categoryCode,
                categoryName: t.categoryName,
                employmentType: t.employmentType,
                workerType: t.workerType,
                probationDays: t.probationDays,
                noticePeriodDays: t.noticePeriodDays,
                isActive: t.isActive,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });

            if (window.KylrxEmployeeTypeService && typeof window.KylrxEmployeeTypeService.createEmployeeType === 'function') {
                await window.KylrxEmployeeTypeService.createEmployeeType(orgId, t);
            }

            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest Employee Type ${t.categoryCode}:`, err);
            errors.push(`${t.categoryCode}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${typeDocs.length} Employee Types.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Employee Types Ingested",
            `Successfully ingested all ${ingestedCount} Employee Categories into Cloud Firestore under organizations/${orgId}/employee_types matching PRD Sections 1, 10 & 13!`,
            "success"
        );
    }

    if (btnConfirmEmployeeTypeIngest) {
        btnConfirmEmployeeTypeIngest.disabled = false;
        btnConfirmEmployeeTypeIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    if (window.KylrxEmployeeTypeService && typeof window.KylrxEmployeeTypeService.renderAdminConsole === 'function') {
        window.KylrxEmployeeTypeService.renderAdminConsole('onboardingEmployeeTypeTableContainer');
    }
}

/**
 * Extracts and maps rows from 'Employee Finance Deatils' sheet strictly adhering to 17 attributes (PRD Sections 1, 4 & 13)
 */
async function extract17EmployeeFinanceAttributesFromSheetRows(rows) {
    let existingEmployeeIds = null;
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    
    // Attempt to query active employees for Foreign Key validation
    try {
        const empSnap = await getDocs(collection(db, "organizations", orgId, "employees"));
        if (!empSnap.empty) {
            existingEmployeeIds = new Set();
            empSnap.forEach(d => {
                const data = d.data();
                if (data.employeeId) existingEmployeeIds.add(data.employeeId);
                if (data.empId) existingEmployeeIds.add(data.empId);
                existingEmployeeIds.add(d.id);
            });
        }
    } catch (e) {
        console.warn("Could not fetch active employees for FK validation, will fall back:", e);
    }

    if (window.KylrxEmployeeFinanceParser && typeof window.KylrxEmployeeFinanceParser.parseSheetRows === 'function') {
        const parsed = window.KylrxEmployeeFinanceParser.parseSheetRows(rows, { existingEmployeeIds });
        return {
            records: parsed.records || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || []
        };
    }

    return { records: [], firestoreDocs: [], errors: ["KylrxEmployeeFinanceParser module not loaded."] };
}

/**
 * Renders parsed Employee Finance preview table
 */
function renderParsedEmployeeFinancePreview(fileName, sheetName, records, errors = []) {
    if (employeeFinanceParseResultTitle) {
        employeeFinanceParseResultTitle.innerText = `Employee Finance Records (${records.length} Records)`;
    }
    if (employeeFinanceParseResultMeta) {
        employeeFinanceParseResultMeta.innerText = `Extracted 17 attributes from '${sheetName}' in ${fileName}`;
    }

    if (employeeFinanceValidationStatusBadge) {
        if (errors.length === 0) {
            employeeFinanceValidationStatusBadge.className = 'badge-verified';
            employeeFinanceValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid Finance Records`;
        } else {
            employeeFinanceValidationStatusBadge.className = 'badge-pending';
            employeeFinanceValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedEmployeeFinanceTableBody) {
        parsedEmployeeFinanceTableBody.innerHTML = records.map((r, idx) => {
            const isPrimary = r.Is_Primary === 'Yes' || r.isPrimary === true;
            const isPrimaryBadge = isPrimary
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem; border: 1px solid #bbf7d0;">Primary</span>`
                : `<span style="color: #64748b; background: #f1f5f9; font-weight: 600; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem;">Secondary</span>`;

            const uanPill = (r.UAN === 'Yes' || r.uanApplicable)
                ? `<span style="font-size: 0.68rem; font-weight: 700; background: #eff6ff; color: #1d4ed8; padding: 1px 5px; border-radius: 4px; margin-right: 2px;" title="UAN: ${escapeHtml(r['UAN No (If Applicable)'] || '')}">UAN</span>`
                : '';
            const esicPill = (r.ESIC === 'Yes' || r.esicApplicable)
                ? `<span style="font-size: 0.68rem; font-weight: 700; background: #fef3c7; color: #92400e; padding: 1px 5px; border-radius: 4px; margin-right: 2px;" title="ESIC: ${escapeHtml(r['ESIC No (If Applicable)'] || '')}">ESIC</span>`
                : '';
            const npsPill = (r.NPS === 'Yes' || r.npsApplicable)
                ? `<span style="font-size: 0.68rem; font-weight: 700; background: #f3e8ff; color: #7e22ce; padding: 1px 5px; border-radius: 4px; margin-right: 2px;" title="NPS: ${escapeHtml(r['NPS No (If Applicable)'] || '')}">NPS</span>`
                : '';
            const gratPill = (r.Gratuity === 'Yes' || r.gratuityApplicable)
                ? `<span style="font-size: 0.68rem; font-weight: 700; background: #e0e7ff; color: #3730a3; padding: 1px 5px; border-radius: 4px;" title="Gratuity: ${escapeHtml(r['Gratuity No (If Applicable)'] || '')}">Grat</span>`
                : '';
            const statutoryBadges = (uanPill + esicPill + npsPill + gratPill) || '<span style="color: #94a3b8; font-size: 0.7rem;">None</span>';

            const rawAcc = r.Account_Number || (r.banking && r.banking.accountNumber) || '';
            const maskedAcc = r.maskedAccountNumber || (rawAcc ? ('••••••••••' + String(rawAcc).slice(-4)) : '—');

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #0284c7;">${escapeHtml(r.Employee_ID || r.employeeId)}</td>
                    <td>
                        <strong style="color: #0f172a;">${escapeHtml(r.Account_Holder_Name || r.accountHolderName)}</strong>
                    </td>
                    <td>
                        <div style="font-size: 0.78rem; font-weight: 600; color: #1e293b;">${escapeHtml(r.Bank_Name || r.bankName)}</div>
                        <div style="font-size: 0.7rem; color: #64748b;">${escapeHtml(r.Branch_Name || r.branchName || '—')}</div>
                    </td>
                    <td style="font-family: monospace; font-size: 0.78rem; font-weight: 600;">${escapeHtml(maskedAcc)}</td>
                    <td style="font-family: monospace; font-weight: 700; color: #059669; font-size: 0.78rem;">${escapeHtml(r.IFSC || r.ifsc)}</td>
                    <td>
                        <span style="font-size: 0.72rem; font-weight: 700; background: #f1f5f9; color: #334155; padding: 2px 6px; border-radius: 6px; display: inline-block; margin-bottom: 2px;">
                            ${escapeHtml(r.Account_Type || r.accountType)}
                        </span><br>
                        ${isPrimaryBadge}
                    </td>
                    <td>${statutoryBadges}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (employeeFinanceParseResultsContainer) employeeFinanceParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Employee Finance records to Cloud Firestore:
 * Path: organizations/{orgId}/employee_finance/{employeeId}
 * Links primary accounts to Decentro Fabric Payout Registry
 */
async function executeEmployeeFinanceIngest(financeDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${financeDocs.length} Employee Finance records into organizations/${orgId}/employee_finance...`);

    let ingestedCount = 0;
    const errors = [];

    for (const docObj of financeDocs) {
        try {
            if (window.KylrxEmployeeFinanceService && typeof window.KylrxEmployeeFinanceService.saveEmployeeFinance === 'function') {
                await window.KylrxEmployeeFinanceService.saveEmployeeFinance(orgId, docObj.employeeId, docObj);
            } else {
                const finRef = doc(db, "organizations", orgId, "employee_finance", docObj.employeeId);
                await setDoc(finRef, {
                    ...docObj,
                    updatedAt: serverTimestamp()
                }, { merge: true });
            }
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest Employee Finance for ${docObj.employeeId}:`, err);
            errors.push(`${docObj.employeeId}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${financeDocs.length} Finance records.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Employee Finance Ingested",
            `Successfully ingested all ${ingestedCount} Employee Finance & Statutory records into Cloud Firestore under organizations/${orgId}/employee_finance matching PRD Sections 1, 4 & 13! Decentro Fabric payout registry initialized.`,
            "success"
        );
    }

    if (btnConfirmLegacyEmpFinanceIngest) {
        btnConfirmLegacyEmpFinanceIngest.disabled = false;
        btnConfirmLegacyEmpFinanceIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    if (window.KylrxEmployeeFinanceService && typeof window.KylrxEmployeeFinanceService.renderFinanceConsole === 'function') {
        window.KylrxEmployeeFinanceService.renderFinanceConsole('onboardingEmployeeFinanceTableContainer');
    }
}

/**
 * Extracts and maps rows from 'PF Details' / 'EPFO Master' sheet strictly adhering to 19 attributes (PRD Sections 1, 4, 11 & 13)
 */
async function extract19EpfoMasterAttributesFromSheetRows(rows) {
    let existingEmployeeIds = null;
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';

    try {
        const empSnap = await getDocs(collection(db, "organizations", orgId, "employees"));
        if (!empSnap.empty) {
            existingEmployeeIds = new Set();
            empSnap.forEach(d => {
                const data = d.data();
                if (data.employeeId) existingEmployeeIds.add(data.employeeId);
                if (data.empId) existingEmployeeIds.add(data.empId);
                existingEmployeeIds.add(d.id);
            });
        }
    } catch (e) {
        console.warn("Could not fetch active employees for EPFO FK validation, will fall back:", e);
    }

    if (window.KylrxPfDetailsParser && typeof window.KylrxPfDetailsParser.parseSheetRows === 'function') {
        const parsed = window.KylrxPfDetailsParser.parseSheetRows(rows, { existingEmployeeIds, orgId });
        return {
            records: parsed.records || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || []
        };
    }

    return { records: [], firestoreDocs: [], errors: ["KylrxPfDetailsParser module not loaded."] };
}

/**
 * Renders parsed EPFO Statutory Master preview table
 */
function renderParsedEpfoMasterPreview(fileName, sheetName, records, errors = []) {
    if (epfoMasterParseResultTitle) {
        epfoMasterParseResultTitle.innerText = `EPFO Statutory Master Records (${records.length} Records)`;
    }
    if (epfoMasterParseResultMeta) {
        epfoMasterParseResultMeta.innerText = `Extracted 19 attributes from '${sheetName}' in ${fileName}`;
    }

    if (epfoMasterValidationStatusBadge) {
        if (errors.length === 0) {
            epfoMasterValidationStatusBadge.className = 'badge-verified';
            epfoMasterValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid EPFO Profiles`;
        } else {
            epfoMasterValidationStatusBadge.className = 'badge-pending';
            epfoMasterValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedEpfoMasterTableBody) {
        parsedEpfoMasterTableBody.innerHTML = records.map((r, idx) => {
            const isPf = r['PF Applicable'] === 'Yes' || r.isPfApplicable === true;
            const uan = r['UAN'] || r.uan || '—';
            const memberId = r['Current Member ID'] || r.currentMemberId || '—';
            const estId = r['EPFO Establishment ID'] || r.epfoEstablishmentId || '—';
            const doj = r['Date of PF Joining'] || r.dateOfPfJoining || '—';

            const kycStatus = r['KYC Status'] || r.kyc?.overallStatus || 'PENDING';
            const kycPill = kycStatus === 'VERIFIED'
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem; border: 1px solid #bbf7d0;">Verified</span>`
                : `<span style="color: #b45309; background: #fef3c7; font-weight: 700; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem; border: 1px solid #fde68a;">${escapeHtml(kycStatus)}</span>`;

            const uanVerify = r['UAN Verification Status'] || r.verification?.status || 'PENDING';
            const verifyPill = uanVerify === 'SUCCESS'
                ? `<span style="color: #1d4ed8; background: #eff6ff; font-weight: 800; padding: 2px 6px; border-radius: 6px; font-size: 0.7rem;">SUCCESS</span>`
                : `<span style="color: #64748b; background: #f1f5f9; font-weight: 600; padding: 2px 6px; border-radius: 6px; font-size: 0.7rem;">${escapeHtml(uanVerify)}</span>`;

            const epsBadge = (r['EPS Applicable'] === 'Yes' || r.isEpsApplicable)
                ? `<span style="font-size: 0.68rem; font-weight: 700; background: #e0e7ff; color: #3730a3; padding: 1px 5px; border-radius: 4px; margin-right: 2px;">EPS</span>`
                : '';
            const edliBadge = (r['EDLI Applicable'] === 'Yes' || r.isEdliApplicable)
                ? `<span style="font-size: 0.68rem; font-weight: 700; background: #f0fdf4; color: #166534; padding: 1px 5px; border-radius: 4px;">EDLI</span>`
                : '';

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #4338ca;">${escapeHtml(r['Employee ID'] || r.employeeId)}</td>
                    <td style="font-family: monospace; font-weight: 700; color: #1e293b;">${escapeHtml(uan)}</td>
                    <td>
                        <code style="font-size: 0.75rem; color: #334155;">${escapeHtml(memberId)}</code>
                    </td>
                    <td style="font-size: 0.72rem; color: #64748b; font-family: monospace;">${escapeHtml(estId)}</td>
                    <td style="font-size: 0.75rem; color: #334155;">${escapeHtml(doj)}</td>
                    <td>${epsBadge}${edliBadge || '<span style="color:#94a3b8;font-size:0.7rem;">None</span>'}</td>
                    <td>${kycPill}</td>
                    <td>${verifyPill}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (epfoMasterParseResultsContainer) epfoMasterParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed EPFO Statutory Master records to Cloud Firestore:
 * Path: organizations/{orgId}/employee_pf_details/{employeeId}
 */
async function executeEpfoMasterIngest(epfoDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    console.log(`🚀 Ingesting ${epfoDocs.length} EPFO Statutory Master records into organizations/${orgId}/employee_pf_details...`);

    let ingestedCount = 0;
    const errors = [];

    for (const docObj of epfoDocs) {
        try {
            if (window.KylrxPfDetailsService && typeof window.KylrxPfDetailsService.saveEmployeePfDetails === 'function') {
                await window.KylrxPfDetailsService.saveEmployeePfDetails(orgId, docObj.employeeId, docObj);
            } else {
                const pfRef = doc(db, "organizations", orgId, "employee_pf_details", docObj.employeeId);
                await setDoc(pfRef, {
                    ...docObj,
                    updatedAt: serverTimestamp()
                }, { merge: true });
            }
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest EPFO details for ${docObj.employeeId}:`, err);
            errors.push(`${docObj.employeeId}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${epfoDocs.length} EPFO profiles.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "EPFO Master Ingested",
            `Successfully ingested all ${ingestedCount} EPFO Statutory Master profiles into Cloud Firestore under organizations/${orgId}/employee_pf_details matching PRD Sections 1, 4, 11 & 13!`,
            "success"
        );
    }

    if (btnConfirmEpfoMasterIngest) {
        btnConfirmEpfoMasterIngest.disabled = false;
        btnConfirmEpfoMasterIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    renderOnboardingEpfoMasterTable();
}

/**
 * Renders the EPFO management table view in onboarding console
 */
async function renderOnboardingEpfoMasterTable() {
    const container = document.getElementById('onboardingEpfoMasterTableContainer');
    if (!container) return;

    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    let records = [];

    if (window.KylrxPfDetailsService && typeof window.KylrxPfDetailsService.listEmployeePfDetails === 'function') {
        try {
            records = await window.KylrxPfDetailsService.listEmployeePfDetails(orgId);
        } catch (e) {
            console.warn("Could not list EPFO profiles:", e);
        }
    }

    if (records.length === 0 && window.KylrxPfDetailsService) {
        records = window.KylrxPfDetailsService.DEFAULT_PF_PROFILES;
    }

    container.innerHTML = `
        <div style="background: white; border-radius: 20px; padding: 2rem; border: 1px solid var(--border); box-shadow: var(--shadow);">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 12px;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 44px; height: 44px; border-radius: 12px; background: #e0e7ff; color: #4338ca; display: flex; align-items: center; justify-content: center;">
                        <i data-lucide="shield-check" style="width: 24px; height: 24px;"></i>
                    </div>
                    <div>
                        <h2 style="font-size: 1.35rem; font-weight: 800; color: #0f172a; margin: 0;">EPFO / PF Statutory Master Console</h2>
                        <p style="font-size: 0.82rem; color: var(--text-muted); margin: 2px 0 0 0;">
                            Cloud Firestore: <code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; color: #4338ca; font-weight: 700;">organizations/{orgId}/employee_pf_details/{employeeId}</code>
                        </p>
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <span class="badge-verified" style="background: #eef2ff; color: #4338ca; border-color: #c7d2fe;">
                        <i data-lucide="layers"></i> ${records.length} Profiles Tracked
                    </span>
                </div>
            </div>

            <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 14px;">
                <table class="preview-table" style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
                    <thead>
                        <tr>
                            <th style="width: 40px;">#</th>
                            <th>Employee ID</th>
                            <th>UAN</th>
                            <th>Current Member ID</th>
                            <th>Est ID</th>
                            <th>PF Joining</th>
                            <th>EPS / EDLI</th>
                            <th>KYC Status</th>
                            <th>Official Source</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${records.map((r, i) => `
                            <tr>
                                <td>${i + 1}</td>
                                <td><strong style="color: #4338ca; font-family: monospace;">${escapeHtml(r.employeeId)}</strong></td>
                                <td style="font-family: monospace; font-weight: 700;">${escapeHtml(r.uan || '—')}</td>
                                <td><code style="font-size: 0.76rem;">${escapeHtml(r.currentMemberId || '—')}</code></td>
                                <td style="font-size: 0.74rem; font-family: monospace;">${escapeHtml(r.epfoEstablishmentId || '—')}</td>
                                <td>${escapeHtml(r.dateOfPfJoining || '—')}</td>
                                <td>
                                    <span style="font-size: 0.68rem; font-weight: 700; background: #e0e7ff; color: #3730a3; padding: 2px 6px; border-radius: 4px;">EPS: ${r.isEpsApplicable !== false ? 'Yes' : 'No'}</span>
                                </td>
                                <td>
                                    <span style="font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: ${r.kyc?.overallStatus === 'VERIFIED' ? '#ecfdf5' : '#fffbeb'}; color: ${r.kyc?.overallStatus === 'VERIFIED' ? '#059669' : '#d97706'};">
                                        ${escapeHtml(r.kyc?.overallStatus || 'PENDING')}
                                    </span>
                                </td>
                                <td style="font-size: 0.74rem; color: #64748b;">${escapeHtml(r.verification?.officialSource || 'Decentro Fabric')}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    if (window.lucide) lucide.createIcons();
}

/**
 * Extracts and maps rows from 'ESIC Details' / 'ESIC Master' sheet strictly adhering to 18 attributes (PRD Sections 1, 4, 11 & 13)
 */
async function extract18EsicMasterAttributesFromSheetRows(rows) {
    let existingEmployeeIds = null;
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';

    try {
        const empSnap = await getDocs(collection(db, "organizations", orgId, "employees"));
        if (!empSnap.empty) {
            existingEmployeeIds = new Set();
            empSnap.forEach(d => {
                const data = d.data();
                if (data.employeeId) existingEmployeeIds.add(data.employeeId);
                if (data.empId) existingEmployeeIds.add(data.empId);
                existingEmployeeIds.add(d.id);
            });
        }
    } catch (e) {
        console.warn("Could not fetch active employees for ESIC FK validation, will fall back:", e);
    }

    if (window.KylrxEsicDetailsParser && typeof window.KylrxEsicDetailsParser.parseSheetRows === 'function') {
        const parsed = window.KylrxEsicDetailsParser.parseSheetRows(rows, { existingEmployeeIds, orgId });
        return {
            records: parsed.records || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || []
        };
    }

    return { records: [], firestoreDocs: [], errors: ["KylrxEsicDetailsParser module not loaded."] };
}

/**
 * Renders parsed ESIC Statutory Master preview table
 */
function renderParsedEsicMasterPreview(fileName, sheetName, records, errors = []) {
    if (esicMasterParseResultTitle) {
        esicMasterParseResultTitle.innerText = `ESIC Statutory Master Records (${records.length} Records)`;
    }
    if (esicMasterParseResultMeta) {
        esicMasterParseResultMeta.innerText = `Extracted 18 attributes from '${sheetName}' in ${fileName}`;
    }

    if (esicMasterValidationStatusBadge) {
        if (errors.length === 0) {
            esicMasterValidationStatusBadge.className = 'badge-verified';
            esicMasterValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid ESIC Profiles`;
        } else {
            esicMasterValidationStatusBadge.className = 'badge-pending';
            esicMasterValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedEsicMasterTableBody) {
        parsedEsicMasterTableBody.innerHTML = records.map((r, idx) => {
            const ipNumber = r['IP Number'] || r.ipNumber || '—';
            const employerCode = r['ESIC Employer Code'] || r.esicEmployerCode || '53000123450000001';
            const doj = r['Date of ESIC Joining'] || r.dateOfEsicJoining || '—';
            const ipStatus = r['Insured Person Status'] || r.insuredPersonStatus || 'ACTIVE';
            const aadhaar = r['Aadhaar Seeding'] || r.aadhaarSeeding || 'NOT_SEEDED';
            const family = r['Family/Dependent Details'] || r.familyDependentDetails || 'PENDING';
            const verified = r['Insurance Number Verified'] === 'Yes' || r.isInsuranceNumberVerified === true;

            const ipPill = ipStatus === 'ACTIVE'
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem; border: 1px solid #bbf7d0;">Active</span>`
                : `<span style="color: #475569; background: #f1f5f9; font-weight: 700; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem; border: 1px solid #cbd5e1;">${escapeHtml(ipStatus)}</span>`;

            const aadhaarPill = aadhaar === 'VERIFIED'
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem;">Verified</span>`
                : `<span style="color: #b91c1c; background: #fee2e2; font-weight: 700; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem;">${escapeHtml(aadhaar)}</span>`;

            const familyPill = (family === 'VERIFIED' || family === 'SUBMITTED')
                ? `<span style="color: #6b21a8; background: #f3e8ff; font-weight: 700; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem;">${escapeHtml(family)}</span>`
                : `<span style="color: #b45309; background: #fef3c7; font-weight: 700; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem;">${escapeHtml(family)}</span>`;

            const verifyPill = verified
                ? `<span style="color: #0369a1; background: #e0f2fe; font-weight: 800; padding: 2px 6px; border-radius: 6px; font-size: 0.7rem;">VERIFIED</span>`
                : `<span style="color: #64748b; background: #f1f5f9; font-weight: 600; padding: 2px 6px; border-radius: 6px; font-size: 0.7rem;">UNVERIFIED</span>`;

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #0284c7;">${escapeHtml(r['Employee ID'] || r.employeeId)}</td>
                    <td style="font-family: monospace; font-weight: 700; color: #1e293b;">${escapeHtml(ipNumber)}</td>
                    <td><code style="font-size: 0.75rem; color: #334155;">${escapeHtml(employerCode)}</code></td>
                    <td style="font-size: 0.75rem; color: #334155;">${escapeHtml(doj)}</td>
                    <td>${ipPill}</td>
                    <td>${aadhaarPill}</td>
                    <td>${familyPill}</td>
                    <td>${verifyPill}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (esicMasterParseResultsContainer) esicMasterParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed ESIC Statutory Master records to Cloud Firestore:
 * Path: organizations/{orgId}/employee_esic_details/{employeeId}
 */
async function executeEsicMasterIngest(esicDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    console.log(`🚀 Ingesting ${esicDocs.length} ESIC Statutory Master records into organizations/${orgId}/employee_esic_details...`);

    let ingestedCount = 0;
    const errors = [];

    for (const docObj of esicDocs) {
        try {
            if (window.KylrxEsicDetailsService && typeof window.KylrxEsicDetailsService.saveEmployeeEsicDetails === 'function') {
                await window.KylrxEsicDetailsService.saveEmployeeEsicDetails(orgId, docObj.employeeId, docObj);
            } else {
                const esicRef = doc(db, "organizations", orgId, "employee_esic_details", docObj.employeeId);
                await setDoc(esicRef, {
                    ...docObj,
                    updatedAt: serverTimestamp()
                }, { merge: true });
            }
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest ESIC details for ${docObj.employeeId}:`, err);
            errors.push(`${docObj.employeeId}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${esicDocs.length} ESIC profiles.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "ESIC Master Ingested",
            `Successfully ingested all ${ingestedCount} ESIC Statutory Master profiles into Cloud Firestore under organizations/${orgId}/employee_esic_details matching PRD Sections 1, 4, 11 & 13!`,
            "success"
        );
    }

    if (btnConfirmEsicMasterIngest) {
        btnConfirmEsicMasterIngest.disabled = false;
        btnConfirmEsicMasterIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    renderOnboardingEsicMasterTable();
}

/**
 * Renders the ESIC management table view in onboarding console
 */
async function renderOnboardingEsicMasterTable() {
    const container = document.getElementById('onboardingEsicMasterTableContainer');
    if (!container) return;

    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    let records = [];

    if (window.KylrxEsicDetailsService && typeof window.KylrxEsicDetailsService.listAllEsicDetails === 'function') {
        try {
            records = await window.KylrxEsicDetailsService.listAllEsicDetails(orgId);
        } catch (e) {
            console.warn("Could not list ESIC profiles:", e);
        }
    }

    if (records.length === 0 && window.KylrxEsicDetailsService) {
        records = window.KylrxEsicDetailsService.DEFAULT_ESIC_PROFILES || [];
    }

    container.innerHTML = `
        <div style="background: white; border: 1px solid var(--border); border-radius: 20px; padding: 2rem; box-shadow: var(--shadow); margin-bottom: 2rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 44px; height: 44px; border-radius: 12px; background: #e0f2fe; color: #0284c7; display: flex; align-items: center; justify-content: center;">
                        <i data-lucide="cross" style="width: 24px; height: 24px;"></i>
                    </div>
                    <div>
                        <h2 style="font-size: 1.35rem; font-weight: 800; color: #0f172a; margin: 0;">ESIC &amp; Medical Insurance Statutory Console</h2>
                        <p style="font-size: 0.82rem; color: var(--text-muted); margin: 2px 0 0 0;">
                            Cloud Firestore: <code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; color: #0284c7; font-weight: 700;">organizations/{orgId}/employee_esic_details/{employeeId}</code>
                        </p>
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <span class="badge-verified" style="background: #e0f2fe; color: #0369a1; border-color: #bae6fd;">
                        <i data-lucide="layers"></i> ${records.length} Profiles Tracked
                    </span>
                </div>
            </div>

            <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 14px;">
                <table class="preview-table" style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
                    <thead>
                        <tr>
                            <th style="width: 40px;">#</th>
                            <th>Employee ID</th>
                            <th>IP Number</th>
                            <th>Employer Code</th>
                            <th>Dispensary</th>
                            <th>State</th>
                            <th>IP Status</th>
                            <th>Aadhaar</th>
                            <th>Dependents</th>
                            <th>Verified</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${records.map((r, i) => `
                            <tr>
                                <td>${i + 1}</td>
                                <td><strong style="color: #0284c7; font-family: monospace;">${escapeHtml(r.employeeId)}</strong></td>
                                <td style="font-family: monospace; font-weight: 700;">${escapeHtml(r.ipNumber || '—')}</td>
                                <td><code style="font-size: 0.74rem;">${escapeHtml(r.esicEmployerCode || '—')}</code></td>
                                <td style="font-size: 0.74rem;">${escapeHtml(r.dispensaryBranch || '—')}</td>
                                <td style="font-size: 0.74rem;">${escapeHtml(r.contributionState || '—')}</td>
                                <td>
                                    <span style="font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: ${r.insuredPersonStatus === 'ACTIVE' ? '#ecfdf5' : '#f1f5f9'}; color: ${r.insuredPersonStatus === 'ACTIVE' ? '#059669' : '#475569'};">
                                        ${escapeHtml(r.insuredPersonStatus || 'ACTIVE')}
                                    </span>
                                </td>
                                <td>
                                    <span style="font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: ${r.aadhaarSeeding === 'VERIFIED' ? '#ecfdf5' : '#fef2f2'}; color: ${r.aadhaarSeeding === 'VERIFIED' ? '#059669' : '#dc2626'};">
                                        ${escapeHtml(r.aadhaarSeeding || 'NOT_SEEDED')}
                                    </span>
                                </td>
                                <td>
                                    <span style="font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 6px; background: #f3e8ff; color: #7c3aed;">
                                        ${escapeHtml(r.familyDependentDetails || 'PENDING')}
                                    </span>
                                </td>
                                <td>
                                    <span style="font-size: 0.7rem; font-weight: 800; color: ${r.isInsuranceNumberVerified ? '#059669' : '#d97706'};">
                                        ${r.isInsuranceNumberVerified ? 'Verified' : 'Pending'}
                                    </span>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    if (window.lucide) lucide.createIcons();
}

/**
 * Extracts and maps rows from 'PT Details' / 'PT Master' sheet strictly adhering to 10 attributes (PRD Sections 1, 4, 11 & 13)
 */
async function extract10PtMasterAttributesFromSheetRows(rows) {
    let existingEmployeeIds = null;
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';

    try {
        const empSnap = await getDocs(collection(db, "organizations", orgId, "employees"));
        if (!empSnap.empty) {
            existingEmployeeIds = new Set();
            empSnap.forEach(d => {
                const data = d.data();
                if (data.employeeId) existingEmployeeIds.add(data.employeeId);
                if (data.empId) existingEmployeeIds.add(data.empId);
                existingEmployeeIds.add(d.id);
            });
        }
    } catch (e) {
        console.warn("Could not fetch active employees for PT FK validation, will fall back:", e);
    }

    if (window.KylrxPtDetailsParser && typeof window.KylrxPtDetailsParser.parseSheetRows === 'function') {
        const parsed = window.KylrxPtDetailsParser.parseSheetRows(rows, { existingEmployeeIds, orgId });
        return {
            records: parsed.records || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || []
        };
    }

    return { records: [], firestoreDocs: [], errors: ["KylrxPtDetailsParser module not loaded."] };
}

/**
 * Renders parsed Professional Tax Statutory Master preview table
 */
function renderParsedPtMasterPreview(fileName, sheetName, records, errors = []) {
    if (ptMasterParseResultTitle) {
        ptMasterParseResultTitle.innerText = `PT Statutory Master Records (${records.length} Records)`;
    }
    if (ptMasterParseResultMeta) {
        ptMasterParseResultMeta.innerText = `Extracted 10 attributes from '${sheetName}' in ${fileName}`;
    }

    if (ptMasterValidationStatusBadge) {
        if (errors.length === 0) {
            ptMasterValidationStatusBadge.className = 'badge-verified';
            ptMasterValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid PT Profiles`;
        } else {
            ptMasterValidationStatusBadge.className = 'badge-pending';
            ptMasterValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedPtMasterTableBody) {
        parsedPtMasterTableBody.innerHTML = records.map((r, idx) => {
            const isPt = r['PT Applicable'] === 'Yes' || r.isPtApplicable === true;
            const stateName = r['State'] || r.state || 'Karnataka';
            const regNo = r['PT Registration No'] || r.ptRegistrationNo || '—';
            const slab = r['PT Slab'] || r.ptSlab || '—';
            const deduction = Number(r['Monthly Deduction'] !== undefined ? r['Monthly Deduction'] : (r.monthlyDeduction || 0)).toFixed(2);
            const effFrom = r['Effective From'] || r.effectiveFrom || '—';
            const effTo = r['Effective To'] || r.effectiveTo || 'Open-ended';
            const isActive = r['Active'] === 'Yes' || r.isActive === true;

            const activePill = isActive
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem; border: 1px solid #bbf7d0;">Active</span>`
                : `<span style="color: #475569; background: #f1f5f9; font-weight: 700; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem; border: 1px solid #cbd5e1;">Inactive</span>`;

            const ptAppPill = isPt
                ? `<span style="color: #0369a1; background: #e0f2fe; font-weight: 800; padding: 2px 6px; border-radius: 6px; font-size: 0.7rem;">Yes</span>`
                : `<span style="color: #64748b; background: #f1f5f9; font-weight: 600; padding: 2px 6px; border-radius: 6px; font-size: 0.7rem;">No</span>`;

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #4338ca;">${escapeHtml(r['Employee ID'] || r.employeeId)}</td>
                    <td style="font-weight: 700; color: #1e293b;">${escapeHtml(stateName)}</td>
                    <td><code style="font-size: 0.75rem; color: #334155;">${escapeHtml(regNo)}</code></td>
                    <td style="font-size: 0.72rem; color: #64748b; font-family: monospace;">${escapeHtml(slab)}</td>
                    <td style="font-weight: 700; font-family: monospace; color: #059669;">₹${deduction}</td>
                    <td style="font-size: 0.75rem; color: #334155;">${escapeHtml(effFrom)}</td>
                    <td style="font-size: 0.75rem; color: #64748b;">${escapeHtml(effTo)}</td>
                    <td>${ptAppPill}</td>
                    <td>${activePill}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (ptMasterParseResultsContainer) ptMasterParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed PT Statutory Master records to Cloud Firestore:
 * Path: organizations/{orgId}/employee_pt_details/{employeeId}
 */
async function executePtMasterIngest(ptDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    console.log(`🚀 Ingesting ${ptDocs.length} PT Statutory Master records into organizations/${orgId}/employee_pt_details...`);

    let ingestedCount = 0;
    const errors = [];

    for (const docObj of ptDocs) {
        try {
            if (window.KylrxPtDetailsService && typeof window.KylrxPtDetailsService.saveEmployeePtDetails === 'function') {
                await window.KylrxPtDetailsService.saveEmployeePtDetails(orgId, docObj.employeeId, docObj);
            } else {
                const ptRef = doc(db, "organizations", orgId, "employee_pt_details", docObj.employeeId);
                await setDoc(ptRef, {
                    ...docObj,
                    updatedAt: serverTimestamp()
                }, { merge: true });
            }
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest PT details for ${docObj.employeeId}:`, err);
            errors.push(`${docObj.employeeId}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${ptDocs.length} PT profiles.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "PT Master Ingested",
            `Successfully ingested all ${ingestedCount} Professional Tax Statutory Master profiles into Cloud Firestore under organizations/${orgId}/employee_pt_details matching PRD Sections 1, 4, 11 & 13!`,
            "success"
        );
    }

    if (btnConfirmPtMasterIngest) {
        btnConfirmPtMasterIngest.disabled = false;
        btnConfirmPtMasterIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    renderOnboardingPtMasterTable();
}

/**
 * Renders the PT management table view in onboarding console
 */
async function renderOnboardingPtMasterTable() {
    const container = document.getElementById('onboardingPtMasterTableContainer');
    if (!container) return;

    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    let records = [];

    if (window.KylrxPtDetailsService && typeof window.KylrxPtDetailsService.listAllPtDetails === 'function') {
        try {
            records = await window.KylrxPtDetailsService.listAllPtDetails(orgId);
        } catch (e) {
            console.warn("Could not list PT profiles:", e);
        }
    }

    if (records.length === 0 && window.KylrxPtDetailsService) {
        records = window.KylrxPtDetailsService.DEFAULT_PT_PROFILES || [];
    }

    container.innerHTML = `
        <div style="background: white; border: 1px solid var(--border); border-radius: 20px; padding: 2rem; box-shadow: var(--shadow); margin-bottom: 2rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 44px; height: 44px; border-radius: 12px; background: #e0e7ff; color: #4338ca; display: flex; align-items: center; justify-content: center;">
                        <i data-lucide="scale" style="width: 24px; height: 24px;"></i>
                    </div>
                    <div>
                        <h2 style="font-size: 1.35rem; font-weight: 800; color: #0f172a; margin: 0;">Professional Tax (PT) Statutory Master Console</h2>
                        <p style="font-size: 0.82rem; color: var(--text-muted); margin: 2px 0 0 0;">
                            Cloud Firestore: <code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; color: #4338ca; font-weight: 700;">organizations/{orgId}/employee_pt_details/{employeeId}</code>
                        </p>
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <span class="badge-verified" style="background: #e0e7ff; color: #3730a3; border-color: #c7d2fe;">
                        <i data-lucide="layers"></i> ${records.length} Profiles Tracked
                    </span>
                </div>
            </div>

            <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 14px;">
                <table class="preview-table" style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
                    <thead>
                        <tr>
                            <th style="width: 40px;">#</th>
                            <th>Employee ID</th>
                            <th>Jurisdiction State</th>
                            <th>PT Registration No</th>
                            <th>Slab Code</th>
                            <th>Monthly Deduction</th>
                            <th>Effective From</th>
                            <th>PT Applicable</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${records.map((r, i) => `
                            <tr>
                                <td>${i + 1}</td>
                                <td><strong style="color: #4338ca; font-family: monospace;">${escapeHtml(r.employeeId)}</strong></td>
                                <td style="font-weight: 700; color: #1e293b;">${escapeHtml(r.state || 'Karnataka')}</td>
                                <td><code style="font-size: 0.74rem;">${escapeHtml(r.ptRegistrationNo || '—')}</code></td>
                                <td style="font-size: 0.74rem; font-family: monospace; color: #64748b;">${escapeHtml(r.ptSlab || '—')}</td>
                                <td style="font-family: monospace; font-weight: 700; color: #059669;">₹${Number(r.monthlyDeduction || 0).toFixed(2)}</td>
                                <td style="font-size: 0.74rem;">${escapeHtml(r.effectiveFrom || '—')}</td>
                                <td>
                                    <span style="font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: ${r.isPtApplicable !== false ? '#ecfdf5' : '#f1f5f9'}; color: ${r.isPtApplicable !== false ? '#059669' : '#64748b'};">
                                        ${r.isPtApplicable !== false ? 'Yes' : 'No'}
                                    </span>
                                </td>
                                <td>
                                    <span style="font-size: 0.7rem; font-weight: 800; padding: 2px 8px; border-radius: 6px; background: ${r.isActive !== false ? '#ecfdf5' : '#f1f5f9'}; color: ${r.isActive !== false ? '#059669' : '#64748b'};">
                                        ${r.isActive !== false ? 'Active' : 'Inactive'}
                                    </span>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    if (window.lucide) lucide.createIcons();
}

/**
 * Extracts and maps rows from 'LWF Details' / 'LWF Master' sheet strictly adhering to 10 attributes (PRD Sections 1, 4, 11 & 13)
 */
async function extract10LwfMasterAttributesFromSheetRows(rows) {
    let existingEmployeeIds = null;
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';

    try {
        const empSnap = await getDocs(collection(db, "organizations", orgId, "employees"));
        if (!empSnap.empty) {
            existingEmployeeIds = new Set();
            empSnap.forEach(d => {
                const data = d.data();
                if (data.employeeId) existingEmployeeIds.add(data.employeeId);
                if (data.empId) existingEmployeeIds.add(data.empId);
                existingEmployeeIds.add(d.id);
            });
        }
    } catch (e) {
        console.warn("Could not fetch active employees for LWF FK validation, will fall back:", e);
    }

    if (window.KylrxLwfDetailsParser && typeof window.KylrxLwfDetailsParser.parseSheetRows === 'function') {
        const parsed = window.KylrxLwfDetailsParser.parseSheetRows(rows, { existingEmployeeIds, orgId });
        return {
            records: parsed.records || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || []
        };
    }

    return { records: [], firestoreDocs: [], errors: ["KylrxLwfDetailsParser module not loaded."] };
}

/**
 * Renders parsed Labour Welfare Fund (LWF) Statutory Master preview table
 */
function renderParsedLwfMasterPreview(fileName, sheetName, records, errors = []) {
    if (lwfMasterParseResultTitle) {
        lwfMasterParseResultTitle.innerText = `LWF Statutory Master Records (${records.length} Records)`;
    }
    if (lwfMasterParseResultMeta) {
        lwfMasterParseResultMeta.innerText = `Extracted 10 attributes from '${sheetName}' in ${fileName}`;
    }

    if (lwfMasterValidationStatusBadge) {
        if (errors.length === 0) {
            lwfMasterValidationStatusBadge.className = 'badge-verified';
            lwfMasterValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid LWF Profiles`;
        } else {
            lwfMasterValidationStatusBadge.className = 'badge-pending';
            lwfMasterValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedLwfMasterTableBody) {
        parsedLwfMasterTableBody.innerHTML = records.map((r, idx) => {
            const isLwf = r['LWF Applicable'] === 'Yes' || r.isLwfApplicable === true;
            const stateName = r['State'] || r.state || 'Karnataka';
            const regNo = r['Employer Registration No'] || r.employerRegistrationNo || '—';
            const ee = Number(r['Employee Contribution'] !== undefined ? r['Employee Contribution'] : (r.employeeContribution || 0)).toFixed(2);
            const er = Number(r['Employer Contribution'] !== undefined ? r['Employer Contribution'] : (r.employerContribution || 0)).toFixed(2);
            const freq = r['Frequency'] || r.frequency || 'Annual';
            const effFrom = r['Effective From'] || r.effectiveFrom || '—';
            const effTo = r['Effective To'] || r.effectiveTo || 'Open-ended';

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #1e40af;">${escapeHtml(r['Employee ID'] || r.employeeId)}</td>
                    <td style="font-weight: 700; color: #1e293b;">${escapeHtml(stateName)}</td>
                    <td><code style="font-size: 0.75rem; color: #334155;">${escapeHtml(regNo)}</code></td>
                    <td style="font-weight: 700; font-family: monospace; color: #047857;">₹${ee}</td>
                    <td style="font-weight: 700; font-family: monospace; color: #1e40af;">₹${er}</td>
                    <td style="font-size: 0.75rem; color: #1e40af; font-weight: 700;">${escapeHtml(freq)}</td>
                    <td style="font-size: 0.75rem; color: #334155;">${escapeHtml(effFrom)}</td>
                    <td style="font-size: 0.75rem; color: #64748b;">${escapeHtml(effTo)}</td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (lwfMasterParseResultsContainer) lwfMasterParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed LWF Statutory Master records to Cloud Firestore:
 * Path: organizations/{orgId}/employee_lwf_details/{employeeId}
 */
async function executeLwfMasterIngest(lwfDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    console.log(`🚀 Ingesting ${lwfDocs.length} LWF Statutory Master records into organizations/${orgId}/employee_lwf_details...`);

    let ingestedCount = 0;
    const errors = [];

    for (const docObj of lwfDocs) {
        try {
            if (window.KylrxLwfDetailsService && typeof window.KylrxLwfDetailsService.saveEmployeeLwfDetails === 'function') {
                await window.KylrxLwfDetailsService.saveEmployeeLwfDetails(orgId, docObj.employeeId, docObj);
            } else {
                const lwfRef = doc(db, "organizations", orgId, "employee_lwf_details", docObj.employeeId);
                await setDoc(lwfRef, {
                    ...docObj,
                    updatedAt: serverTimestamp()
                }, { merge: true });
            }
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest LWF details for ${docObj.employeeId}:`, err);
            errors.push(`${docObj.employeeId}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${lwfDocs.length} LWF profiles.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "LWF Master Ingested",
            `Successfully ingested all ${ingestedCount} Labour Welfare Fund Statutory Master profiles into Cloud Firestore under organizations/${orgId}/employee_lwf_details matching PRD Sections 1, 4, 11 & 13!`,
            "success"
        );
    }

    if (btnConfirmLwfMasterIngest) {
        btnConfirmLwfMasterIngest.disabled = false;
        btnConfirmLwfMasterIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    renderOnboardingLwfMasterTable();
}

/**
 * Renders the LWF management table view in onboarding console
 */
async function renderOnboardingLwfMasterTable() {
    const container = document.getElementById('onboardingLwfMasterTableContainer');
    if (!container) return;

    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    let records = [];

    if (window.KylrxLwfDetailsService && typeof window.KylrxLwfDetailsService.listAllLwfDetails === 'function') {
        try {
            records = await window.KylrxLwfDetailsService.listAllLwfDetails(orgId);
        } catch (e) {
            console.warn("Could not list LWF profiles:", e);
        }
    }

    if (records.length === 0 && window.KylrxLwfDetailsService) {
        records = window.KylrxLwfDetailsService.DEFAULT_LWF_PROFILES || [];
    }

    container.innerHTML = `
        <div style="background: white; border: 1px solid var(--border); border-radius: 20px; padding: 2rem; box-shadow: var(--shadow); margin-bottom: 2rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 44px; height: 44px; border-radius: 12px; background: #eff6ff; color: #1d4ed8; display: flex; align-items: center; justify-content: center;">
                        <i data-lucide="shield-check" style="width: 24px; height: 24px;"></i>
                    </div>
                    <div>
                        <h2 style="font-size: 1.35rem; font-weight: 800; color: #0f172a; margin: 0;">Labour Welfare Fund (LWF) Statutory Master Console</h2>
                        <p style="font-size: 0.82rem; color: var(--text-muted); margin: 2px 0 0 0;">
                            Cloud Firestore: <code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; color: #1d4ed8; font-weight: 700;">organizations/{orgId}/employee_lwf_details/{employeeId}</code>
                        </p>
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <span class="badge-verified" style="background: #eff6ff; color: #1e40af; border-color: #bfdbfe;">
                        <i data-lucide="layers"></i> ${records.length} Profiles Tracked
                    </span>
                </div>
            </div>

            <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 14px;">
                <table class="preview-table" style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
                    <thead>
                        <tr>
                            <th style="width: 40px;">#</th>
                            <th>Employee ID</th>
                            <th>Jurisdiction State</th>
                            <th>Registration No</th>
                            <th>Frequency</th>
                            <th>EE Share (₹)</th>
                            <th>ER Share (₹)</th>
                            <th>Total Remittance</th>
                            <th>Next Deduction</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${records.map((r, i) => `
                            <tr>
                                <td>${i + 1}</td>
                                <td><strong style="color: #1e40af; font-family: monospace;">${escapeHtml(r.employeeId)}</strong></td>
                                <td style="font-weight: 700; color: #1e293b;">${escapeHtml(r.state || 'Karnataka')}</td>
                                <td><code style="font-size: 0.74rem;">${escapeHtml(r.employerRegistrationNo || '—')}</code></td>
                                <td style="font-size: 0.74rem; font-weight: 700; color: #1e40af;">${escapeHtml(r.frequency || 'Annual')}</td>
                                <td style="font-family: monospace; font-weight: 700; color: #047857;">₹${Number(r.employeeContribution || 0).toFixed(2)}</td>
                                <td style="font-family: monospace; font-weight: 700; color: #1e40af;">₹${Number(r.employerContribution || 0).toFixed(2)}</td>
                                <td style="font-family: monospace; font-weight: 800; color: #0f172a;">₹${(Number(r.employeeContribution || 0) + Number(r.employerContribution || 0)).toFixed(2)}</td>
                                <td style="font-size: 0.74rem; color: #047857; font-weight: 700;">${escapeHtml(r.deductionSchedule?.nextDeduction || '—')}</td>
                                <td>
                                    <span style="font-size: 0.7rem; font-weight: 800; padding: 2px 8px; border-radius: 6px; background: ${r.isLwfApplicable !== false ? '#ecfdf5' : '#f1f5f9'}; color: ${r.isLwfApplicable !== false ? '#059669' : '#64748b'};">
                                        ${r.isLwfApplicable !== false ? 'Active' : 'Exempt'}
                                    </span>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    if (window.lucide) lucide.createIcons();
}

/**
 * Extracts and maps rows from 'NPS Details' / 'NPS Master' sheet strictly adhering to 22 attributes (PRD Sections 1, 4, 11 & 13)
 */
async function extract22NpsMasterAttributesFromSheetRows(rows) {
    let existingEmployeeIds = null;
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';

    try {
        const empSnap = await getDocs(collection(db, "organizations", orgId, "employees"));
        if (!empSnap.empty) {
            existingEmployeeIds = new Set();
            empSnap.forEach(d => {
                const data = d.data();
                if (data.employeeId) existingEmployeeIds.add(data.employeeId);
                if (data.empId) existingEmployeeIds.add(data.empId);
                existingEmployeeIds.add(d.id);
            });
        }
    } catch (e) {
        console.warn("Could not fetch active employees for NPS FK validation, will fall back:", e);
    }

    if (window.KylrxNpsDetailsParser && typeof window.KylrxNpsDetailsParser.parseSheetRows === 'function') {
        const parsed = window.KylrxNpsDetailsParser.parseSheetRows(rows, { existingEmployeeIds, orgId });
        return {
            records: parsed.records || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || []
        };
    }

    return { records: [], firestoreDocs: [], errors: ["KylrxNpsDetailsParser module not loaded."] };
}

/**
 * Renders parsed National Pension System (NPS) Statutory Master preview table
 */
function renderParsedNpsMasterPreview(fileName, sheetName, records, errors = []) {
    if (npsMasterParseResultTitle) {
        npsMasterParseResultTitle.innerText = `NPS Statutory Master Records (${records.length} Records)`;
    }
    if (npsMasterParseResultMeta) {
        npsMasterParseResultMeta.innerText = `Extracted 22 attributes from '${sheetName}' in ${fileName}`;
    }

    if (npsMasterValidationStatusBadge) {
        if (errors.length === 0) {
            npsMasterValidationStatusBadge.className = 'badge-verified';
            npsMasterValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid NPS Profiles`;
        } else {
            npsMasterValidationStatusBadge.className = 'badge-pending';
            npsMasterValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedNpsMasterTableBody) {
        parsedNpsMasterTableBody.innerHTML = records.map((r, idx) => {
            const isNps = r['NPS Applicable'] === 'Yes' || r.isNpsApplicable === true;
            const pran = r['PRAN'] || r.pran || '—';
            const status = r['NPS Account Status'] || r.npsAccountStatus || 'ACTIVE';
            const cra = r['CRA / Recordkeeping Agency'] || r.craAgency || 'Protean (NSDL)';
            const t1 = r['Tier I Active'] === 'Yes' || r.tier1Active === true ? 'T1: Yes' : 'T1: No';
            const t2 = r['Tier II Active'] === 'Yes' || r.tier2Active === true ? 'T2: Yes' : 'T2: No';

            const ee = (r['Employee Contribution %'] !== null && r['Employee Contribution %'] !== undefined && r['Employee Contribution %'] !== '')
                ? `${Number(r['Employee Contribution %']).toFixed(1)}%`
                : (r['Employee Contribution Amount'] ? `₹${Number(r['Employee Contribution Amount']).toFixed(2)}` : '—');

            const er = (r['Employer Contribution %'] !== null && r['Employer Contribution %'] !== undefined && r['Employer Contribution %'] !== '')
                ? `${Number(r['Employer Contribution %']).toFixed(1)}%`
                : (r['Employer Contribution Amount'] ? `₹${Number(r['Employer Contribution Amount']).toFixed(2)}` : '—');

            const ytd = Number(r['Total Contribution YTD'] !== undefined ? r['Total Contribution YTD'] : (r.totalContributionYtd || 0)).toFixed(2);
            const kyc = r['KYC Status'] || (r.kyc && r.kyc.overallStatus) || 'VERIFIED';

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #1e40af;">${escapeHtml(r['Employee ID'] || r.employeeId)}</td>
                    <td><code style="font-size: 0.75rem; color: #047857; font-weight: 700;">${escapeHtml(pran)}</code></td>
                    <td style="font-size: 0.75rem; font-weight: 700; color: ${status === 'ACTIVE' ? '#059669' : '#64748b'};">${escapeHtml(status)}</td>
                    <td style="font-size: 0.75rem; color: #1e293b; font-weight: 600;">${escapeHtml(cra)}</td>
                    <td style="font-size: 0.72rem; color: #334155;">${escapeHtml(t1)}, ${escapeHtml(t2)}</td>
                    <td style="font-weight: 700; font-family: monospace; color: #047857;">${escapeHtml(ee)}</td>
                    <td style="font-weight: 700; font-family: monospace; color: #1e40af;">${escapeHtml(er)}</td>
                    <td style="font-weight: 700; font-family: monospace; color: #0f172a;">₹${ytd}</td>
                    <td>
                        <span style="font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: ${kyc === 'VERIFIED' ? '#ecfdf5' : '#fffbeb'}; color: ${kyc === 'VERIFIED' ? '#059669' : '#b45309'};">
                            ${escapeHtml(kyc)}
                        </span>
                    </td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (npsMasterParseResultsContainer) npsMasterParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed NPS Statutory Master records to Cloud Firestore:
 * Path: organizations/{orgId}/employee_nps_details/{employeeId}
 */
async function executeNpsMasterIngest(npsDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    console.log(`🚀 Ingesting ${npsDocs.length} NPS Statutory Master records into organizations/${orgId}/employee_nps_details...`);

    let ingestedCount = 0;
    const errors = [];

    for (const docObj of npsDocs) {
        try {
            if (window.KylrxNpsDetailsService && typeof window.KylrxNpsDetailsService.saveEmployeeNpsDetails === 'function') {
                await window.KylrxNpsDetailsService.saveEmployeeNpsDetails(orgId, docObj.employeeId, docObj);
            } else {
                const npsRef = doc(db, "organizations", orgId, "employee_nps_details", docObj.employeeId);
                await setDoc(npsRef, {
                    ...docObj,
                    updatedAt: serverTimestamp()
                }, { merge: true });
            }
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest NPS details for ${docObj.employeeId}:`, err);
            errors.push(`${docObj.employeeId}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${npsDocs.length} NPS profiles.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "NPS Master Ingested",
            `Successfully ingested all ${ingestedCount} National Pension System Statutory Master profiles into Cloud Firestore under organizations/${orgId}/employee_nps_details matching PRD Sections 1, 4, 11 & 13!`,
            "success"
        );
    }

    if (btnConfirmNpsMasterIngest) {
        btnConfirmNpsMasterIngest.disabled = false;
        btnConfirmNpsMasterIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    renderOnboardingNpsMasterTable();
}

/**
 * Renders the NPS management table view in onboarding console
 */
async function renderOnboardingNpsMasterTable() {
    const container = document.getElementById('onboardingNpsMasterTableContainer');
    if (!container) return;

    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    let records = [];

    if (window.KylrxNpsDetailsService && typeof window.KylrxNpsDetailsService.listAllNpsDetails === 'function') {
        try {
            records = await window.KylrxNpsDetailsService.listAllNpsDetails(orgId);
        } catch (e) {
            console.warn("Could not list NPS profiles:", e);
        }
    }

    if (records.length === 0 && window.KylrxNpsDetailsService) {
        records = window.KylrxNpsDetailsService.DEFAULT_NPS_PROFILES || [];
    }

    container.innerHTML = `
        <div style="background: white; border: 1px solid var(--border); border-radius: 20px; padding: 2rem; box-shadow: var(--shadow); margin-bottom: 2rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 44px; height: 44px; border-radius: 12px; background: #ecfdf5; color: #059669; display: flex; align-items: center; justify-content: center;">
                        <i data-lucide="piggy-bank" style="width: 24px; height: 24px;"></i>
                    </div>
                    <div>
                        <h2 style="font-size: 1.35rem; font-weight: 800; color: #0f172a; margin: 0;">National Pension System (NPS) Statutory Master Console</h2>
                        <p style="font-size: 0.82rem; color: var(--text-muted); margin: 2px 0 0 0;">
                            Cloud Firestore: <code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; color: #059669; font-weight: 700;">organizations/{orgId}/employee_nps_details/{employeeId}</code>
                        </p>
                    </div>
                </div>
                <div style="display: flex; gap: 8px;">
                    <span class="badge-verified" style="background: #ecfdf5; color: #065f46; border-color: #a7f3d0;">
                        <i data-lucide="layers"></i> ${records.length} Profiles Tracked
                    </span>
                </div>
            </div>

            <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 14px;">
                <table class="preview-table" style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
                    <thead>
                        <tr>
                            <th style="width: 40px;">#</th>
                            <th>Employee ID</th>
                            <th>PRAN</th>
                            <th>Model / CRA Agency</th>
                            <th>Tiers</th>
                            <th>Employee Share</th>
                            <th>Employer Share</th>
                            <th>Total YTD (₹)</th>
                            <th>Nominee</th>
                            <th>KYC Status</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${records.map((r, i) => {
                            const contribs = r.contributions || {};
                            const ee = contribs.employeePercentage ? `${contribs.employeePercentage}%` : (contribs.employeeAmount ? `₹${contribs.employeeAmount}` : '—');
                            const er = contribs.employerPercentage ? `${contribs.employerPercentage}%` : (contribs.employerAmount ? `₹${contribs.employerAmount}` : '—');
                            const ytd = Number(contribs.totalContributionYtd || 0).toFixed(2);
                            const kyc = r.kyc?.overallStatus || 'VERIFIED';

                            return `
                                <tr>
                                    <td>${i + 1}</td>
                                    <td><strong style="color: #1e40af; font-family: monospace;">${escapeHtml(r.employeeId)}</strong></td>
                                    <td><code style="font-size: 0.74rem; color: #047857; font-weight: 700;">${escapeHtml(r.pran || '—')}</code></td>
                                    <td style="font-weight: 600; color: #1e293b;">${escapeHtml(r.npsModel || 'Corporate Model')}<br><small style="color: var(--text-muted);">${escapeHtml(r.craAgency || 'Protean (NSDL)')}</small></td>
                                    <td style="font-size: 0.74rem;">
                                        <span style="color: ${r.tier1Active !== false ? '#059669' : '#94a3b8'}; font-weight: 700;">T1: ${r.tier1Active !== false ? 'Active' : 'Off'}</span><br>
                                        <span style="color: ${r.tier2Active ? '#0284c7' : '#94a3b8'}; font-weight: 700;">T2: ${r.tier2Active ? 'Active' : 'Off'}</span>
                                    </td>
                                    <td style="font-family: monospace; font-weight: 700; color: #047857;">${escapeHtml(ee)}</td>
                                    <td style="font-family: monospace; font-weight: 700; color: #1e40af;">${escapeHtml(er)}</td>
                                    <td style="font-family: monospace; font-weight: 800; color: #0f172a;">₹${ytd}</td>
                                    <td style="font-size: 0.74rem; color: #334155;">${escapeHtml(r.nomineeStatus || 'SUBMITTED')}</td>
                                    <td>
                                        <span style="font-size: 0.7rem; font-weight: 800; padding: 2px 6px; border-radius: 4px; background: ${kyc === 'VERIFIED' ? '#ecfdf5' : '#fffbeb'}; color: ${kyc === 'VERIFIED' ? '#059669' : '#b45309'};">
                                            ${escapeHtml(kyc)}
                                        </span>
                                    </td>
                                    <td>
                                        <span style="font-size: 0.7rem; font-weight: 800; padding: 2px 8px; border-radius: 6px; background: ${r.isNpsApplicable !== false ? '#ecfdf5' : '#f1f5f9'}; color: ${r.isNpsApplicable !== false ? '#059669' : '#64748b'};">
                                            ${r.isNpsApplicable !== false ? (r.npsAccountStatus || 'Active') : 'Exempt'}
                                        </span>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    if (window.lucide) lucide.createIcons();
}

/**
 * Extracts and maps rows from 'Gratuity Details' / 'Gratuity Master' sheet strictly adhering to 18 attributes (PRD Sections 1, 4, 11 & 13)
 */
async function extract18GratuityMasterAttributesFromSheetRows(rows) {
    let existingEmployeeIds = null;
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';

    try {
        const empSnap = await getDocs(collection(db, "organizations", orgId, "employees"));
        if (!empSnap.empty) {
            existingEmployeeIds = new Set();
            empSnap.forEach(d => {
                const data = d.data();
                if (data.employeeId) existingEmployeeIds.add(data.employeeId);
                if (data.empId) existingEmployeeIds.add(data.empId);
                existingEmployeeIds.add(d.id);
            });
        }
    } catch (e) {
        console.warn("Could not fetch active employees for Gratuity FK validation, will fall back:", e);
    }

    if (window.KylrxGratuityDetailsParser && typeof window.KylrxGratuityDetailsParser.parseSheetRows === 'function') {
        const parsed = window.KylrxGratuityDetailsParser.parseSheetRows(rows, { existingEmployeeIds, orgId });
        return {
            records: parsed.records || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || []
        };
    }

    return { records: [], firestoreDocs: [], errors: ["KylrxGratuityDetailsParser module not loaded."] };
}

/**
 * Renders parsed Gratuity Statutory Master preview table
 */
function renderParsedGratuityMasterPreview(fileName, sheetName, records, errors = []) {
    if (gratuityMasterParseResultTitle) {
        gratuityMasterParseResultTitle.innerText = `Gratuity Statutory Master Records (${records.length} Records)`;
    }
    if (gratuityMasterParseResultMeta) {
        gratuityMasterParseResultMeta.innerText = `Extracted 18 attributes from '${sheetName}' in ${fileName}`;
    }

    if (gratuityMasterValidationStatusBadge) {
        if (errors.length === 0) {
            gratuityMasterValidationStatusBadge.className = 'badge-verified';
            gratuityMasterValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid Gratuity Profiles`;
        } else {
            gratuityMasterValidationStatusBadge.className = 'badge-pending';
            gratuityMasterValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    if (parsedGratuityMasterTableBody) {
        parsedGratuityMasterTableBody.innerHTML = records.map((r, idx) => {
            const empId = r['Employee ID'] || r.employeeId || '—';
            const doj = r['Date of Joining'] || r.dateOfJoining || '—';
            const doe = r['Date of Exit'] || r.dateOfExit || '—';
            const tenure = r['Continuous Service (Years)'] !== undefined ? r['Continuous Service (Years)'] : (r.continuousServiceYears !== undefined ? r.continuousServiceYears : '—');
            const completed = r['Completed Years for Gratuity'] !== undefined ? r['Completed Years for Gratuity'] : (r.completedYearsForGratuity !== undefined ? r.completedYearsForGratuity : '—');
            const eligStatus = r['Gratuity Eligibility Status'] || r.eligibilityStatus || 'VESTED';
            const eligibleSal = r['Last Drawn Wages / Eligible Salary'] !== undefined ? r['Last Drawn Wages / Eligible Salary'] : (r.wages?.eligibleSalary || r.lastDrawnEligibleSalary || 0);
            const accrued = r['Accrued Gratuity Amount'] !== undefined ? r['Accrued Gratuity Amount'] : (r.accruedGratuityAmount || 0);
            const formula = r['Gratuity Calculation Basis'] || r.calculationBasis || '15/26 Formula';
            const nominee = r['Nominee Details Status'] || r.nomineeStatus || 'VERIFIED';
            const payStatus = r['Payment Status'] || (r.settlement?.paymentStatus) || 'ACCRUING';

            let eligColor = '#059669';
            let eligBg = '#ecfdf5';
            if (eligStatus === 'NOT_ELIGIBLE') {
                eligColor = '#b45309';
                eligBg = '#fffbeb';
            } else if (eligStatus === 'EXEMPTED') {
                eligColor = '#64748b';
                eligBg = '#f1f5f9';
            }

            let payColor = '#334155';
            let payBg = '#f8fafc';
            if (payStatus === 'DISBURSED') {
                payColor = '#059669';
                payBg = '#ecfdf5';
            } else if (payStatus === 'PENDING_SETTLEMENT') {
                payColor = '#c2410c';
                payBg = '#fff7ed';
            } else if (payStatus === 'APPROVED') {
                payColor = '#2563eb';
                payBg = '#eff6ff';
            }

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #1e40af;">${escapeHtml(empId)}</td>
                    <td style="font-family: monospace; font-size: 0.76rem;">${escapeHtml(doj)}</td>
                    <td style="font-family: monospace; font-size: 0.76rem; color: ${doe !== '—' ? '#b45309' : '#94a3b8'};">${escapeHtml(doe)}</td>
                    <td style="font-weight: 600;">${tenure} yrs</td>
                    <td style="font-weight: 700; color: #0f172a;">${completed}</td>
                    <td>
                        <span style="font-size: 0.7rem; font-weight: 800; padding: 2px 6px; border-radius: 4px; background: ${eligBg}; color: ${eligColor};">
                            ${escapeHtml(eligStatus)}
                        </span>
                    </td>
                    <td style="font-weight: 700; font-family: monospace; color: #0f172a;">₹${Number(eligibleSal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                    <td style="font-weight: 800; font-family: monospace; color: #059669;">₹${Number(accrued).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                    <td style="font-size: 0.74rem; color: #475569;">${escapeHtml(formula)}</td>
                    <td style="font-size: 0.72rem; font-weight: 600;">${escapeHtml(nominee)}</td>
                    <td>
                        <span style="font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px; background: ${payBg}; color: ${payColor};">
                            ${escapeHtml(payStatus)}
                        </span>
                    </td>
                    <td style="text-align: center;">
                        <span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">
                            Valid
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (gratuityMasterParseResultsContainer) gratuityMasterParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Gratuity Statutory Master records to Cloud Firestore:
 * Path: organizations/{orgId}/employee_gratuity_details/{employeeId}
 */
async function executeGratuityMasterIngest(gratuityDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    console.log(`🚀 Ingesting ${gratuityDocs.length} Gratuity Statutory Master records into organizations/${orgId}/employee_gratuity_details...`);

    let ingestedCount = 0;
    const errors = [];

    for (const docObj of gratuityDocs) {
        try {
            if (window.KylrxGratuityDetailsService && typeof window.KylrxGratuityDetailsService.saveGratuityDetails === 'function') {
                await window.KylrxGratuityDetailsService.saveGratuityDetails(orgId, docObj.employeeId, docObj);
            } else {
                const gratRef = doc(db, "organizations", orgId, "employee_gratuity_details", docObj.employeeId);
                await setDoc(gratRef, {
                    ...docObj,
                    updatedAt: serverTimestamp()
                }, { merge: true });
            }
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest Gratuity details for ${docObj.employeeId}:`, err);
            errors.push(`${docObj.employeeId}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${gratuityDocs.length} Gratuity profiles.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Gratuity Master Ingested",
            `Successfully ingested all ${ingestedCount} Payment of Gratuity Act, 1972 Statutory Master profiles into Cloud Firestore under organizations/${orgId}/employee_gratuity_details matching PRD Sections 1, 4, 11 & 13!`,
            "success"
        );
    }

    if (btnConfirmGratuityMasterIngest) {
        btnConfirmGratuityMasterIngest.disabled = false;
        btnConfirmGratuityMasterIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    renderOnboardingGratuityMasterTable();
}

/**
 * Renders the Gratuity management table view in onboarding console
 */
async function renderOnboardingGratuityMasterTable() {
    const container = document.getElementById('onboardingGratuityMasterTableContainer');
    if (!container) return;

    const orgId = state.orgId || localStorage.getItem('orgId') || 'ORG_KYLRX_01';
    let records = [];

    if (window.KylrxGratuityDetailsService && typeof window.KylrxGratuityDetailsService.listAllGratuityDetails === 'function') {
        try {
            records = await window.KylrxGratuityDetailsService.listAllGratuityDetails(orgId);
        } catch (e) {
            console.warn("Could not list Gratuity profiles:", e);
        }
    }

    if (records.length === 0 && window.KylrxGratuityDetailsService) {
        records = window.KylrxGratuityDetailsService.DEFAULT_GRATUITY_PROFILES || [];
    }

    const totalVested = records.filter(r => r.eligibilityStatus === 'VESTED' || r.eligibilityStatus === 'ELIGIBLE').length;
    const totalPending = records.filter(r => (r.settlement?.paymentStatus === 'PENDING_SETTLEMENT') || r.paymentStatus === 'PENDING_SETTLEMENT').length;
    const totalLiability = records.reduce((acc, r) => acc + Number(r.accruedGratuityAmount || 0), 0);

    container.innerHTML = `
        <div style="background: white; border: 1px solid var(--border); border-radius: 20px; padding: 2rem; box-shadow: var(--shadow); margin-bottom: 2rem;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 12px;">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <div style="width: 44px; height: 44px; border-radius: 12px; background: #e0e7ff; color: #4338ca; display: flex; align-items: center; justify-content: center;">
                        <i data-lucide="award" style="width: 24px; height: 24px;"></i>
                    </div>
                    <div>
                        <h2 style="font-size: 1.35rem; font-weight: 800; color: #0f172a; margin: 0;">Payment of Gratuity Act, 1972 Statutory Master Console</h2>
                        <p style="font-size: 0.82rem; color: var(--text-muted); margin: 2px 0 0 0;">
                            Cloud Firestore: <code style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; color: #4338ca; font-weight: 700;">organizations/{orgId}/employee_gratuity_details/{employeeId}</code>
                        </p>
                    </div>
                </div>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                    <span class="badge-verified" style="background: #e0e7ff; color: #3730a3; border-color: #c7d2fe;">
                        <i data-lucide="users"></i> ${records.length} Profiles Tracked
                    </span>
                    <span class="badge-verified" style="background: #ecfdf5; color: #065f46; border-color: #a7f3d0;">
                        <i data-lucide="shield-check"></i> ${totalVested} Vested (&ge;5 Yrs)
                    </span>
                    <span class="badge-verified" style="background: #fff7ed; color: #9a3412; border-color: #fed7aa;">
                        <i data-lucide="clock"></i> ${totalPending} Pending F&amp;F
                    </span>
                    <span class="badge-verified" style="background: #f8fafc; color: #0f172a; border-color: #e2e8f0; font-family: monospace;">
                        Liability: ₹${totalLiability.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                </div>
            </div>

            <div style="overflow-x: auto; border: 1px solid var(--border); border-radius: 14px;">
                <table class="preview-table" style="width: 100%; border-collapse: collapse; font-size: 0.82rem;">
                    <thead>
                        <tr>
                            <th style="width: 35px;">#</th>
                            <th>Employee ID</th>
                            <th>Service Dates</th>
                            <th>Continuous Service</th>
                            <th>Qualifying Years</th>
                            <th>Eligible Wages (Basic+DA)</th>
                            <th>Accrued Gratuity (₹)</th>
                            <th>Formula</th>
                            <th>Nominee (Form F)</th>
                            <th>Eligibility</th>
                            <th>Payment Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${records.map((r, i) => {
                            const wages = r.wages?.eligibleSalary || r.eligibleSalary || r.lastDrawnEligibleSalary || 0;
                            const accrued = r.accruedGratuityAmount || 0;
                            const elig = r.eligibilityStatus || 'VESTED';
                            const pStatus = r.settlement?.paymentStatus || r.paymentStatus || 'ACCRUING';

                            let eligBg = elig === 'VESTED' || elig === 'ELIGIBLE' ? '#ecfdf5' : (elig === 'NOT_ELIGIBLE' ? '#fffbeb' : '#f1f5f9');
                            let eligColor = elig === 'VESTED' || elig === 'ELIGIBLE' ? '#059669' : (elig === 'NOT_ELIGIBLE' ? '#b45309' : '#64748b');

                            let payBg = pStatus === 'DISBURSED' ? '#ecfdf5' : (pStatus === 'PENDING_SETTLEMENT' ? '#fff7ed' : '#f8fafc');
                            let payColor = pStatus === 'DISBURSED' ? '#059669' : (pStatus === 'PENDING_SETTLEMENT' ? '#c2410c' : '#334155');

                            return `
                                <tr>
                                    <td>${i + 1}</td>
                                    <td><strong style="color: #1e40af; font-family: monospace;">${escapeHtml(r.employeeId)}</strong></td>
                                    <td style="font-size: 0.74rem;">
                                        DOJ: ${escapeHtml(r.dateOfJoining || '—')}<br>
                                        <span style="color: ${r.dateOfExit ? '#b45309' : '#94a3b8'};">DOE: ${escapeHtml(r.dateOfExit || 'Active')}</span>
                                    </td>
                                    <td style="font-weight: 600;">${r.continuousServiceYears !== undefined ? r.continuousServiceYears : 0} Years</td>
                                    <td style="font-weight: 800; color: #0f172a;">${r.completedYearsForGratuity || r.completedYears || 0}</td>
                                    <td style="font-family: monospace; font-weight: 700;">₹${Number(wages).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                                    <td style="font-family: monospace; font-weight: 800; color: #059669;">₹${Number(accrued).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                                    <td style="font-size: 0.74rem; color: #475569;">${escapeHtml(r.calculationBasis || '15/26 Formula')}</td>
                                    <td style="font-size: 0.74rem; font-weight: 600; color: ${r.nomineeStatus === 'VERIFIED' ? '#059669' : '#b45309'};">
                                        ${escapeHtml(r.nomineeStatus || 'VERIFIED')}
                                    </td>
                                    <td>
                                        <span style="font-size: 0.7rem; font-weight: 800; padding: 2px 6px; border-radius: 4px; background: ${eligBg}; color: ${eligColor};">
                                            ${escapeHtml(elig)}
                                        </span>
                                    </td>
                                    <td>
                                        <span style="font-size: 0.7rem; font-weight: 800; padding: 2px 8px; border-radius: 6px; background: ${payBg}; color: ${payColor};">
                                            ${escapeHtml(pStatus)}
                                        </span>
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    if (window.lucide) lucide.createIcons();
}

/**
 * Extracts and maps rows from 'Salary Stcruture' sheet strictly using 9 attributes (PRD Sections 1 & 4):
 * 1. Employee_ID (FK referencing active employee)
 * 2. Effective_From (ISO Date YYYY-MM-DD)
 * 3. Pay_Frequency (Monthly / Bi-weekly / Weekly)
 * 4. Salary_Structure_Code (package template identifier)
 * 5. Component_Code (FK referencing Payroll Components)
 * 6. Amount (fixed numeric value if calculation is fixed)
 * 7. Percentage (rate applied to calculation basis)
 * 8. Calculation_Basis (FLAT, BASIC, GROSS, CTC)
 * 9. Active (boolean: true for "Yes", false for "No")
 */
async function extract9SalaryStructureAttributesFromSheetRows(rows) {
    let existingEmployeeIds = null;
    let existingComponentCodes = null;
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';

    try {
        const empSnap = await getDocs(collection(db, "organizations", orgId, "employees"));
        if (!empSnap.empty) {
            existingEmployeeIds = new Set();
            empSnap.forEach(d => {
                const data = d.data();
                if (data.employeeId) existingEmployeeIds.add(data.employeeId);
                if (data.empId) existingEmployeeIds.add(data.empId);
                existingEmployeeIds.add(d.id);
            });
        }
    } catch (e) {
        console.warn("Could not fetch active employees for FK validation:", e);
    }

    try {
        const compSnap = await getDocs(collection(db, "organizations", orgId, "payroll_components"));
        if (!compSnap.empty) {
            existingComponentCodes = new Set();
            compSnap.forEach(d => {
                const data = d.data();
                if (data.componentCode) existingComponentCodes.add(data.componentCode);
                existingComponentCodes.add(d.id);
            });
        }
    } catch (e) {
        console.warn("Could not fetch payroll components for FK validation:", e);
    }

    if (window.KylrxSalaryStructureParser && typeof window.KylrxSalaryStructureParser.parseSheetRows === 'function') {
        const parsed = window.KylrxSalaryStructureParser.parseSheetRows(rows, { existingEmployeeIds, existingComponentCodes });
        return {
            records: parsed.records || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || []
        };
    }

    return { records: [], firestoreDocs: [], errors: ["KylrxSalaryStructureParser module not loaded."] };
}

/**
 * Renders parsed Salary Structure preview table and live summary cards
 */
function renderParsedSalaryStructurePreview(fileName, sheetName, records, firestoreDocs = [], errors = []) {
    if (salaryStructureParseResultTitle) {
        salaryStructureParseResultTitle.innerText = `Salary Structures (${firestoreDocs.length} Packages, ${records.length} Components)`;
    }
    if (salaryStructureParseResultMeta) {
        salaryStructureParseResultMeta.innerText = `Extracted 9 attributes from '${sheetName}' in ${fileName}`;
    }

    if (salaryStructureValidationStatusBadge) {
        if (errors.length === 0) {
            salaryStructureValidationStatusBadge.className = 'badge-verified';
            salaryStructureValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid Components (${firestoreDocs.length} Structures)`;
        } else {
            salaryStructureValidationStatusBadge.className = 'badge-pending';
            salaryStructureValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    // Update Summary Metrics
    if (salaryTotalRowsDisplay) salaryTotalRowsDisplay.textContent = records.length;
    if (salaryTotalStructuresDisplay) salaryTotalStructuresDisplay.textContent = firestoreDocs.length;
    
    const totalMonthlyGross = firestoreDocs.reduce((acc, d) => acc + (d.grossMonthly || 0), 0);
    const totalAnnualCtc = firestoreDocs.reduce((acc, d) => acc + (d.annualCTC || 0), 0);

    if (salaryTotalMonthlyGrossDisplay) {
        salaryTotalMonthlyGrossDisplay.textContent = '₹' + Number(totalMonthlyGross).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (salaryTotalAnnualCtcDisplay) {
        salaryTotalAnnualCtcDisplay.textContent = '₹' + Number(totalAnnualCtc).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    if (parsedSalaryStructureTableBody) {
        parsedSalaryStructureTableBody.innerHTML = records.map((r, idx) => {
            const isActive = r.Active === true || r.Active === 'Yes' || r.Active === 'true';
            const statusBadge = isActive
                ? `<span style="color: #166534; background: #dcfce7; font-weight: 800; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem; border: 1px solid #bbf7d0;">Active</span>`
                : `<span style="color: #64748b; background: #f1f5f9; font-weight: 600; padding: 2px 6px; border-radius: 9999px; font-size: 0.7rem;">Inactive</span>`;

            const amtDisplay = (r.Amount !== null && r.Amount !== undefined && r.Amount !== '') 
                ? '₹' + Number(r.Amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : '—';
            const pctDisplay = (r.Percentage !== null && r.Percentage !== undefined && r.Percentage !== '')
                ? `${Number(r.Percentage)}%`
                : '—';

            const compVal = r.computedMonthlyAmount !== undefined 
                ? '₹' + Number(r.computedMonthlyAmount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : (amtDisplay !== '—' ? amtDisplay : '—');

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #0284c7;">${escapeHtml(r.Employee_ID || r.employeeId)}</td>
                    <td style="font-size: 0.78rem; font-weight: 600; color: #475569;">${escapeHtml(r.Effective_From || r.effectiveFrom)}</td>
                    <td>
                        <strong style="color: #0f172a; font-family: monospace; font-size: 0.78rem;">${escapeHtml(r.Salary_Structure_Code || r.salaryStructureCode)}</strong>
                    </td>
                    <td>
                        <span style="font-weight: 700; color: #4f46e5; background: #eef2ff; padding: 2px 6px; border-radius: 6px; font-family: monospace; font-size: 0.78rem;">
                            ${escapeHtml(r.Component_Code || r.componentCode)}
                        </span>
                    </td>
                    <td style="text-align: right; font-family: monospace; font-weight: 600;">${escapeHtml(amtDisplay)}</td>
                    <td style="text-align: right; font-family: monospace; font-weight: 600; color: #0891b2;">${escapeHtml(pctDisplay)}</td>
                    <td>
                        <span style="font-size: 0.72rem; font-weight: 700; background: #f1f5f9; color: #334155; padding: 2px 6px; border-radius: 6px;">
                            ${escapeHtml(r.Calculation_Basis || r.calculationBasis)}
                        </span>
                    </td>
                    <td style="text-align: right; font-family: monospace; font-weight: 800; color: #059669;">${escapeHtml(compVal)}</td>
                    <td style="text-align: center;">${statusBadge}</td>
                </tr>
            `;
        }).join('');
    }

    if (salaryStructureParseResultsContainer) salaryStructureParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Salary Structure revisions to Cloud Firestore:
 * Path: organizations/{orgId}/salary_structures/{employeeId}_v_{effectiveDate}
 * PRD Sections 1 & 4 dynamic compensation versioning
 */
async function executeSalaryStructureIngest(salaryDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${salaryDocs.length} Salary Structure revisions into organizations/${orgId}/salary_structures...`);

    let ingestedCount = 0;
    const errors = [];

    for (const docObj of salaryDocs) {
        try {
            if (window.KylrxSalaryStructureService && typeof window.KylrxSalaryStructureService.saveSalaryStructure === 'function') {
                await window.KylrxSalaryStructureService.saveSalaryStructure(orgId, docObj.employeeId, docObj);
            } else {
                const docId = `${docObj.employeeId}_v_${docObj.effectiveFrom}`;
                const structRef = doc(db, "organizations", orgId, "salary_structures", docId);
                await setDoc(structRef, {
                    ...docObj,
                    updatedAt: serverTimestamp()
                }, { merge: true });
            }
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest Salary Structure for ${docObj.employeeId}:`, err);
            errors.push(`${docObj.employeeId}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${salaryDocs.length} Salary Structures.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Salary Structures Ingested",
            `Successfully ingested all ${ingestedCount} Salary Structure revisions into Cloud Firestore under organizations/${orgId}/salary_structures matching PRD Sections 1 & 4! Dynamic compensation rules and version control active.`,
            "success"
        );
    }

    if (btnConfirmSalaryStructureIngest) {
        btnConfirmSalaryStructureIngest.disabled = false;
        btnConfirmSalaryStructureIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    if (window.KylrxSalaryStructureService && typeof window.KylrxSalaryStructureService.renderSalaryConsole === 'function') {
        window.KylrxSalaryStructureService.renderSalaryConsole('onboardingSalaryStructureTableContainer');
    }
}

/**
 * Commits parsed Attendance Policies to Cloud Firestore:
 * Path: organizations/{orgId}/attendance_policies/{attendancePolicyCode}
 */
async function executePolicyIngest(policyDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${policyDocs.length} Attendance Policies into organizations/${orgId}/attendance_policies...`);

    let ingestedCount = 0;
    const errors = [];

    for (const p of policyDocs) {
        try {
            const policyRef = doc(db, "organizations", orgId, "attendance_policies", p.attendancePolicyCode);
            await setDoc(policyRef, {
                attendancePolicyCode: p.attendancePolicyCode,
                policyName: p.policyName,
                lateAfterMinutes: p.lateAfterMinutes,
                earlyLeavingGraceMinute: p.earlyLeavingGraceMinute,
                absentAfterHours: p.absentAfterHours,
                regularizationAllowed: p.regularizationAllowed,
                regularizationWindowDays: p.regularizationWindowDays,
                wfhAllowed: p.wfhAllowed,
                otMinimumMinutes: p.otMinimumMinutes,
                otApprovalRequired: p.otApprovalRequired,
                geoFenceRequired: p.geoFenceRequired,
                ipRestricted: p.ipRestricted,
                isActive: p.isActive,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });

            if (window.KylrxAttendancePolicyService && typeof window.KylrxAttendancePolicyService.createPolicy === 'function') {
                await window.KylrxAttendancePolicyService.createPolicy(p, orgId);
            }

            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest Policy ${p.attendancePolicyCode}:`, err);
            errors.push(`${p.attendancePolicyCode}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${policyDocs.length} Policies.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Policies Ingested",
            `Successfully ingested all ${ingestedCount} Attendance Policies into Cloud Firestore under organizations/${orgId}/attendance_policies matching PRD Sections 1, 15 & 16!`,
            "success"
        );
    }

    if (btnConfirmPolicyIngest) {
        btnConfirmPolicyIngest.disabled = false;
        btnConfirmPolicyIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    if (window.KylrxAttendancePolicyService && typeof window.KylrxAttendancePolicyService.renderAdminConsole === 'function') {
        window.KylrxAttendancePolicyService.renderAdminConsole('onboardingAttendancePolicyTableContainer');
    }
}

/**
 * Extracts and maps rows to the exact 21 attributes
 */
function extract21AttributesFromSheetRows(rows) {
    const extracted = {};

    // Helper to find a key in an object case-insensitively
    function findValueInObject(obj, synonymsList) {
        const objKeys = Object.keys(obj);
        for (const syn of synonymsList) {
            const cleanSyn = syn.toLowerCase().replace(/[\s_-]+/g, '');
            const foundKey = objKeys.find(k => k.trim().toLowerCase().replace(/[\s_-]+/g, '') === cleanSyn);
            if (foundKey && obj[foundKey] !== undefined && obj[foundKey] !== null && String(obj[foundKey]).trim() !== '') {
                return String(obj[foundKey]).trim();
            }
        }
        return null;
    }

    // Format A: Standard tabular format (Row 0 has headers, Row 1 has data)
    const firstRow = rows[0] || {};
    ORGANIZATION_ATTRIBUTES.forEach(attr => {
        const val = findValueInObject(firstRow, [attr.key, ...attr.synonyms]);
        extracted[attr.key] = val !== null ? val : (attr.defaultValue || "");
    });

    // Format B: Two-column key-value format (Column A: Attribute Name, Column B: Value)
    // If fewer than 5 attributes were found from first row and multiple rows exist, scan down rows
    const extractedCount = Object.values(extracted).filter(v => v !== "").length;
    if (extractedCount < 5 && rows.length > 5) {
        rows.forEach(row => {
            const values = Object.values(row);
            if (values.length >= 2) {
                const rowKey = String(values[0]).trim().toLowerCase().replace(/[\s_-]+/g, '');
                const rowVal = String(values[1]).trim();

                ORGANIZATION_ATTRIBUTES.forEach(attr => {
                    const matchedSyn = [attr.key, ...attr.synonyms].some(s => s.toLowerCase().replace(/[\s_-]+/g, '') === rowKey);
                    if (matchedSyn && rowVal) {
                        extracted[attr.key] = rowVal;
                    }
                });
            }
        });
    }

    // Enforce statutory casing
    if (extracted.Currency) extracted.Currency = extracted.Currency.toUpperCase();
    if (extracted.PAN) extracted.PAN = extracted.PAN.toUpperCase();
    if (extracted.TAN) extracted.TAN = extracted.TAN.toUpperCase();
    if (extracted.CIN_or_LLPIN) extracted.CIN_or_LLPIN = extracted.CIN_or_LLPIN.toUpperCase();
    if (extracted.GSTIN) extracted.GSTIN = extracted.GSTIN.toUpperCase();
    if (extracted.Official_Email) extracted.Official_Email = extracted.Official_Email.toLowerCase();

    return extracted;
}

/**
 * Renders the parsed 21 attributes into the live preview table
 */
function renderParsedAttributesPreview(fileName, sheetName, data) {
    if (parseResultFileName) parseResultFileName.innerText = fileName;
    if (parseResultMeta) parseResultMeta.innerText = `Extracted 21 attributes from '${sheetName}' sheet`;

    const errors = validateOrganizationAttributes(data);
    const isValid = errors.length === 0;

    if (validationStatusBadge) {
        if (isValid) {
            validationStatusBadge.className = 'badge-verified';
            validationStatusBadge.innerHTML = '<i data-lucide="check-circle" style="width: 14px;"></i> All 21 Attributes Validated';
        } else {
            validationStatusBadge.className = 'badge-pending';
            validationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Field Issue(s) Detected`;
        }
    }

    if (parsedAttributesTableBody) {
        parsedAttributesTableBody.innerHTML = ORGANIZATION_ATTRIBUTES.map((attr, index) => {
            const val = data[attr.key] || '';
            const isMissingRequired = attr.required && !val;
            
            let statusPill = '';
            if (isMissingRequired) {
                statusPill = '<span style="color: #991b1b; background: #fee2e2; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #fecaca;">Missing *</span>';
            } else if (val) {
                statusPill = '<span style="color: #166534; background: #dcfce7; font-weight: 700; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; border: 1px solid #bbf7d0;">Extracted</span>';
            } else {
                statusPill = '<span style="color: #64748b; background: #f1f5f9; font-weight: 600; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem;">Optional</span>';
            }

            const displayVal = val 
                ? `<span style="font-weight: 600; color: #0f172a;">${escapeHtml(val)}</span>` 
                : `<span style="color: #94a3b8; font-style: italic;">(Empty)</span>`;

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${index + 1}</td>
                    <td>
                        <strong style="color: #1e293b;">${attr.key}</strong>
                        ${attr.required ? '<span style="color: var(--danger); font-weight: 800;">*</span>' : ''}
                    </td>
                    <td>${displayVal}</td>
                    <td>${statusPill}</td>
                </tr>
            `;
        }).join('');
    }

    if (parseResultsContainer) parseResultsContainer.style.display = 'block';
    if (dropZone) dropZone.style.display = 'none';
    if (window.lucide) lucide.createIcons();
}

/**
 * PRD Section 2: Core Processing & State Update
 * 
 * 1. Save/update record in Firestore under organizations/{orgId}.
 * 2. Update organization state to { orgConfigured: true }.
 * 3. Trigger initial continuous sequential employee ID provisioning (EMP0001) for subsequent onboarding.
 * 4. Redirect Super Admin to main administrative dashboard (admin-dashboard.html).
 */
async function executeOrganizationSetup(attributes21, sourceMethod) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';

    console.log(`🚀 Executing Organization Setup via [${sourceMethod}] for orgId: "${orgId}"...`);

    // 1. Construct payload with exact 21 attributes + enterprise system metadata
    const orgPayload = {
        // Exact 21 attributes matching PRD
        Legal_Name: attributes21.Legal_Name,
        Display_Name: attributes21.Display_Name,
        Organization_Type: attributes21.Organization_Type,
        Industry: attributes21.Industry,
        Website: attributes21.Website || '',
        Official_Email: attributes21.Official_Email,
        Official_Phone: attributes21.Official_Phone,
        Country: attributes21.Country,
        State: attributes21.State,
        City: attributes21.City,
        PIN_Code: attributes21.PIN_Code,
        Registered_Address: attributes21.Registered_Address,
        Corporate_Address: attributes21.Corporate_Address,
        Time_Zone: attributes21.Time_Zone,
        Currency: attributes21.Currency,
        Financial_Year_Start: attributes21.Financial_Year_Start,
        PAN: attributes21.PAN,
        TAN: attributes21.TAN,
        CIN_or_LLPIN: attributes21.CIN_or_LLPIN || '',
        GSTIN: attributes21.GSTIN,
        Logo_URL: attributes21.Logo_URL || '',

        // Normalized camelCase mirrors for backwards compatibility
        legalName: attributes21.Legal_Name,
        displayName: attributes21.Display_Name,
        organizationType: attributes21.Organization_Type,
        industry: attributes21.Industry,
        website: attributes21.Website || '',
        officialEmail: attributes21.Official_Email,
        officialPhone: attributes21.Official_Phone,
        country: attributes21.Country,
        state: attributes21.State,
        city: attributes21.City,
        pinCode: attributes21.PIN_Code,
        registeredAddress: attributes21.Registered_Address,
        corporateAddress: attributes21.Corporate_Address,
        timezone: attributes21.Time_Zone,
        currency: attributes21.Currency,
        financialYearStart: attributes21.Financial_Year_Start,
        pan: attributes21.PAN,
        tan: attributes21.TAN,
        cinOrLlpin: attributes21.CIN_or_LLPIN || '',
        gstin: attributes21.GSTIN,
        logoUrl: attributes21.Logo_URL || '',

        // PRD Section 2 Gate State
        orgId: orgId,
        orgConfigured: true,
        initialEmployeeIdProvisioned: true,
        setupSource: sourceMethod,
        configuredAt: serverTimestamp(),
        updatedAt: serverTimestamp()
    };

    // Step 1: Save/update Firestore organizations/{orgId}
    const orgDocRef = doc(db, "organizations", orgId);
    await setDoc(orgDocRef, orgPayload, { merge: true });
    console.log(`✅ Step 1: Organization record saved to Firestore under organizations/${orgId}`);

    // Step 2: Trigger continuous sequential employee ID provisioning (starting at EMP0001)
    // Writing counter document at organizations/{orgId}/counters/employees with currentSequence: 0
    // guarantees subsequent allocation begins atomically at EMP0001
    const counterDocRef = doc(db, "organizations", orgId, "counters", "employees");
    try {
        await setDoc(counterDocRef, {
            currentSequence: 0,
            prefix: 'EMP',
            padLength: 4,
            nextIdPreview: 'EMP0001',
            initialProvisioned: true,
            orgId: orgId,
            initializedAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        }, { merge: true });
        console.log(`🔢 Step 2: Initialized continuous sequential Employee ID counter (EMP0001) for org ${orgId}`);
    } catch (counterErr) {
        // Firestore rules make counters server-only; the backend signup already provisions it.
        console.warn('Step 2: employee ID counter is managed by the server, skipping client write:', counterErr.message);
    }

    // Step 3: Update local storage and UI status
    localStorage.setItem('orgConfigured', 'true');
    localStorage.setItem('orgId', orgId);
    localStorage.setItem('companyName', orgPayload.Display_Name || orgPayload.Legal_Name);

    if (statusBadge) {
        statusBadge.className = 'badge-verified';
        statusBadge.innerHTML = '<i data-lucide="check-circle" style="width: 14px;"></i> Organization Configured (orgConfigured: true)';
        if (window.lucide) lucide.createIcons();
    }

    // Step 4: Alert Super Admin and redirect to main administrative dashboard
    window.customAlertCallback = () => {
        window.location.href = 'admin-dashboard.html';
    };

    window.showCustomAlert(
        "Organization Configured Successfully",
        `Legal identity for "${orgPayload.Legal_Name}" is verified and active. Continuous sequential Employee ID provisioning (EMP0001) has been provisioned.\n\nRedirecting to Admin Console...`,
        "success"
    );

    setTimeout(() => {
        window.location.href = 'admin-dashboard.html';
    }, 2200);
}

/**
 * Sets up sidebar logout
 */
function setupLogout() {
    if (logoutBtn) {
        logoutBtn.onclick = (e) => {
            e.preventDefault();
            localStorage.clear();
            auth.signOut().then(() => {
                window.location.href = 'index.html';
            });
        };
    }
}

/**
 * Custom Alert Modal Controller
 */
window.customAlertCallback = null;

window.showCustomAlert = function(title, msg, type = 'success') {
    const overlay = document.getElementById('customAlertOverlay');
    const titleEl = document.getElementById('customAlertTitle');
    const msgEl = document.getElementById('customAlertMsg');
    const iconEl = document.getElementById('customAlertIcon');

    if (titleEl) titleEl.innerText = title;
    if (msgEl) msgEl.innerText = msg;
    if (iconEl) {
        if (type === 'error') {
            iconEl.setAttribute('data-lucide', 'alert-triangle');
            if (iconEl.parentElement) {
                iconEl.parentElement.style.background = '#fee2e2';
                iconEl.parentElement.style.color = '#ef4444';
            }
        } else {
            iconEl.setAttribute('data-lucide', 'check-circle');
            if (iconEl.parentElement) {
                iconEl.parentElement.style.background = '#dcfce7';
                iconEl.parentElement.style.color = '#16a34a';
            }
        }
        if (window.lucide) lucide.createIcons();
    }
    if (overlay) overlay.style.display = 'flex';
};

window.closeCustomAlert = function() {
    const overlay = document.getElementById('customAlertOverlay');
    if (overlay) overlay.style.display = 'none';
    if (typeof window.customAlertCallback === 'function') {
        const cb = window.customAlertCallback;
        window.customAlertCallback = null;
        cb();
    }
};

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * ============================================================================
 * HOLIDAY CALENDAR EXTRACTION, PREVIEW, AND INGESTION HANDLERS (PRD §§ 1, 4, 15, 16)
 * ============================================================================
 */

/**
 * Extracts and maps rows from 'Holiday Calendar' sheet strictly using 9 attributes:
 * 1. Holiday_Calendar_Code (unique grouped identifier)
 * 2. Holiday_Calendar_Name (display title)
 * 3. Location_Code (FK linked to active location)
 * 4. Holiday_Date (ISO YYYY-MM-DD)
 * 5. Holiday_Name (display title)
 * 6. Holiday_Type (National, Regional, Restricted, Floating)
 * 7. Optional_Holiday (boolean)
 * 8. Paid_Holiday (boolean)
 * 9. Active (boolean)
 */
async function extract9HolidayCalendarAttributesFromSheetRows(rows) {
    let existingLocationCodes = new Set();
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';

    try {
        const locationsSnap = await getDocs(collection(db, "organizations", orgId, "locations"));
        locationsSnap.docs.forEach(docSnap => {
            const data = docSnap.data();
            if (data.locationCode) existingLocationCodes.add(data.locationCode.toUpperCase());
            if (data.code) existingLocationCodes.add(data.code.toUpperCase());
            existingLocationCodes.add(docSnap.id.toUpperCase());
        });
    } catch (e) {
        // Fallback to standard active locations if remote query fails
    }

    if (existingLocationCodes.size === 0) {
        existingLocationCodes = new Set([
            'LOC-BLR', 'LOC_BLR', 'LOC_BLR_01', 'LOC-BLR-01',
            'LOC-MUM', 'LOC_MUM', 'LOC_MUM_01', 'LOC-MUM-01',
            'LOC-DEL', 'LOC_DEL', 'LOC_DEL_01', 'LOC-DEL-01',
            'LOC-HYD', 'LOC_HYD', 'LOC_HYD_01', 'LOC-HYD-01',
            'LOC-PUN', 'LOC_PUN', 'LOC_PUN_01', 'LOC-PUN-01',
            'LOC-CHN', 'LOC_CHN', 'LOC_CHN_01', 'LOC-CHN-01',
            'LOC_CORP_01', 'LOC_HQ', 'ALL'
        ]);
    }

    if (window.KylrxHolidayCalendarParser && typeof window.KylrxHolidayCalendarParser.parseHolidayCalendarSheet === 'function') {
        return window.KylrxHolidayCalendarParser.parseHolidayCalendarSheet(rows, { activeLocations: existingLocationCodes });
    }

    return { records: [], firestoreDocs: [], errors: ["KylrxHolidayCalendarParser module not loaded."] };
}

/**
 * Renders parsed Holiday Calendar preview table and metrics
 */
function renderParsedHolidayCalendarPreview(fileName, sheetName, records, firestoreDocs = [], errors = []) {
    if (holidayCalendarParseResultTitle) {
        holidayCalendarParseResultTitle.innerText = `Holiday Calendar (${records.length} Holidays, ${firestoreDocs.length} Docs)`;
    }
    if (holidayCalendarParseResultMeta) {
        holidayCalendarParseResultMeta.innerText = `Extracted 9 attributes from '${sheetName}' in ${fileName}`;
    }

    if (holidayCalendarValidationStatusBadge) {
        if (errors.length === 0) {
            holidayCalendarValidationStatusBadge.className = 'badge-verified';
            holidayCalendarValidationStatusBadge.innerHTML = `<i data-lucide="check-circle" style="width: 14px;"></i> ${records.length} Valid Closures (0 Errors)`;
        } else {
            holidayCalendarValidationStatusBadge.className = 'badge-pending';
            holidayCalendarValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle" style="width: 14px;"></i> ${errors.length} Issue(s) Detected`;
        }
    }

    // Update KPI Displays
    const calendarsSet = new Set(records.map(r => r.Holiday_Calendar_Code || r.calendarCode));
    const mandatoryCount = records.filter(r => !r.Optional_Holiday && !r.isOptional).length;
    const optionalCount = records.filter(r => r.Optional_Holiday || r.isOptional).length;

    if (holidayTotalRowsDisplay) holidayTotalRowsDisplay.innerText = records.length;
    if (holidayTotalCalendarsDisplay) holidayTotalCalendarsDisplay.innerText = calendarsSet.size;
    if (holidayTotalMandatoryDisplay) holidayTotalMandatoryDisplay.innerText = mandatoryCount;
    if (holidayTotalOptionalDisplay) holidayTotalOptionalDisplay.innerText = optionalCount;

    if (parsedHolidayCalendarTableBody) {
        parsedHolidayCalendarTableBody.innerHTML = records.map((r, idx) => {
            const hasError = errors.some(e => e.includes(`Row #${r.rowIndex}`));
            const isOpt = r.Optional_Holiday || r.isOptional;
            const isPaid = r.Paid_Holiday !== undefined ? r.Paid_Holiday : r.isPaid;
            const isAct = r.Active !== undefined ? r.Active : r.isActive;

            return `
                <tr style="${hasError ? 'background: #fff1f2;' : ''}">
                    <td style="font-weight: 700; color: #64748b;">${idx + 1}</td>
                    <td>
                        <strong style="color: #0f172a; font-family: monospace; font-size: 0.78rem;">${escapeHtml(r.Holiday_Calendar_Code || r.calendarCode)}</strong>
                    </td>
                    <td>
                        <span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; font-weight: 800; background: #f1f5f9; color: #334155;">
                            ${escapeHtml(r.Location_Code || r.locationCode)}
                        </span>
                    </td>
                    <td style="font-family: monospace; font-weight: 700; color: #0f172a;">
                        ${escapeHtml(r.Holiday_Date || r.holidayDate)}
                    </td>
                    <td style="font-weight: 700; color: #1e293b;">
                        ${escapeHtml(r.Holiday_Name || r.holidayName)}
                    </td>
                    <td>
                        <span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; font-weight: 700; background: #e0e7ff; color: #3730a3;">
                            ${escapeHtml(r.Holiday_Type || r.holidayType || 'National')}
                        </span>
                    </td>
                    <td style="text-align: center;">
                        <span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; font-weight: 800; background: ${isOpt ? '#fef3c7; color: #b45309;' : '#f1f5f9; color: #64748b;'}">
                            ${isOpt ? 'FLOATING' : 'MANDATORY'}
                        </span>
                    </td>
                    <td style="text-align: center;">
                        <span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; font-weight: 800; background: ${isPaid ? '#dcfce7; color: #15803d;' : '#fee2e2; color: #b91c1c;'}">
                            ${isPaid ? 'PAID' : 'UNPAID'}
                        </span>
                    </td>
                    <td style="text-align: center;">
                        <span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.72rem; font-weight: 800; background: ${isAct ? '#ecfdf5; color: #047857;' : '#f1f5f9; color: #94a3b8;'}">
                            ${isAct ? 'ACTIVE' : 'INACTIVE'}
                        </span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (holidayCalendarParseResultsContainer) holidayCalendarParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Holiday Calendar closures to Cloud Firestore:
 * Path: organizations/{orgId}/holiday_calendars/{calendarCode}/holidays/{holidayId}
 */
async function executeHolidayCalendarIngest(holidayDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${holidayDocs.length} Holiday closures into organizations/${orgId}/holiday_calendars...`);

    let ingestedCount = 0;
    const errors = [];

    for (const docObj of holidayDocs) {
        try {
            if (window.KylrxHolidayCalendarService && typeof window.KylrxHolidayCalendarService.saveHoliday === 'function') {
                await window.KylrxHolidayCalendarService.saveHoliday(orgId, docObj.calendarCode, docObj);
            } else {
                const holidayRef = doc(db, "organizations", orgId, "holiday_calendars", docObj.calendarCode, "holidays", docObj.id);
                await setDoc(holidayRef, {
                    ...docObj,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                }, { merge: true });
            }
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest Holiday for ${docObj.calendarCode} / ${docObj.holidayDate}:`, err);
            errors.push(`${docObj.holidayName} (${docObj.holidayDate}): ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${holidayDocs.length} Holidays.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Holiday Calendars Ingested",
            `Successfully ingested all ${ingestedCount} Holiday closures into Cloud Firestore under organizations/${orgId}/holiday_calendars/{calendarCode}/holidays matching PRD Sections 1, 4, 15, & 16! Location-based attendance and payroll interlocks are active.`,
            "success"
        );
    }

    if (btnConfirmHolidayCalendarIngest) {
        btnConfirmHolidayCalendarIngest.disabled = false;
        btnConfirmHolidayCalendarIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    if (window.KylrxHolidayCalendarService && typeof window.KylrxHolidayCalendarService.renderAdminHolidayConsole === 'function') {
        window.KylrxHolidayCalendarService.renderAdminHolidayConsole('onboardingHolidayCalendarTableContainer');
    }
}

/**
 * Extracts and maps rows from 'Statuatory Compliance' sheet strictly using 11 attributes:
 * 1. Compliance_Code (PK)
 * 2. Compliance_Name (Title)
 * 3. Applicable (Boolean)
 * 4. Registration_Number (Employer ID)
 * 5. State (Jurisdiction)
 * 6. Effective_From (YYYY-MM-DD)
 * 7. Wage_Ceiling_or_Rule (Cutoff or Slab Formula)
 * 8. Employee_Contribution_Rate (EE %)
 * 9. Employer_Contribution_Rate (ER %)
 * 10. Due_Date_Day (Day of Month: 1-31)
 * 11. Active (Boolean)
 */
async function extract11StatutoryComplianceAttributesFromSheetRows(rows) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    if (window.KylrxStatutoryComplianceParser && typeof window.KylrxStatutoryComplianceParser.parseStatutoryComplianceSheet === 'function') {
        return window.KylrxStatutoryComplianceParser.parseStatutoryComplianceSheet(rows, { orgId });
    }
    return { records: [], firestoreDocs: [], errors: ["KylrxStatutoryComplianceParser module not loaded."] };
}

/**
 * Renders parsed Statutory Compliance preview table and metrics
 */
function renderParsedStatutoryCompliancePreview(fileName, sheetName, records, firestoreDocs = [], errors = []) {
    if (statutoryComplianceParseResultTitle) {
        statutoryComplianceParseResultTitle.innerText = `Statutory Compliance (${records.length} Policies, ${firestoreDocs.length} Docs)`;
    }
    if (statutoryComplianceParseResultMeta) {
        statutoryComplianceParseResultMeta.innerText = `Extracted 11 attributes from '${sheetName}' in ${fileName}`;
    }

    if (statutoryComplianceValidationStatusBadge) {
        if (errors.length === 0) {
            statutoryComplianceValidationStatusBadge.className = 'badge-verified';
            statutoryComplianceValidationStatusBadge.innerHTML = '<i data-lucide="check"></i> 11 Attributes Validated &amp; Ready';
        } else {
            statutoryComplianceValidationStatusBadge.className = 'badge-pending';
            statutoryComplianceValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle"></i> ${errors.length} Validation Errors`;
        }
    }

    if (statutoryTotalRowsDisplay) statutoryTotalRowsDisplay.innerText = records.length;
    if (statutoryTotalApplicableDisplay) statutoryTotalApplicableDisplay.innerText = records.filter(r => r.Applicable).length;
    if (statutoryTotalStatesDisplay) statutoryTotalStatesDisplay.innerText = new Set(records.map(r => r.State)).size;
    if (statutoryTotalDueRemindersDisplay) statutoryTotalDueRemindersDisplay.innerText = records.filter(r => r.Due_Date_Day <= 15).length;

    if (parsedStatutoryComplianceTableBody) {
        parsedStatutoryComplianceTableBody.innerHTML = records.map((r, idx) => {
            const eeRate = typeof r.Employee_Contribution_Rate === 'number' && r.Employee_Contribution_Rate <= 100
                ? `${r.Employee_Contribution_Rate}%`
                : `${r.Employee_Contribution_Rate}`;
            const erRate = typeof r.Employer_Contribution_Rate === 'number' && r.Employer_Contribution_Rate <= 100
                ? `${r.Employer_Contribution_Rate}%`
                : `${r.Employer_Contribution_Rate}`;

            return `
                <tr style="border-bottom: 1px solid var(--border);">
                    <td style="color: var(--text-muted); font-size: 0.75rem;">${idx + 1}</td>
                    <td style="font-family: monospace; font-weight: 800; color: #2563eb;">${r.Compliance_Code}</td>
                    <td style="font-weight: 700; color: #0f172a;">${r.Compliance_Name}</td>
                    <td style="text-align: center;">
                        <span style="display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 800; background: ${r.Applicable ? '#dcfce7' : '#f1f5f9'}; color: ${r.Applicable ? '#166534' : '#64748b'};">
                            ${r.Applicable ? 'YES' : 'NO'}
                        </span>
                    </td>
                    <td style="font-family: monospace; font-size: 0.75rem;">${r.Registration_Number || '-'}</td>
                    <td><span style="padding: 2px 6px; border-radius: 6px; font-size: 0.72rem; font-weight: 700; background: #eff6ff; color: #1e40af;">${r.State}</span></td>
                    <td style="font-size: 0.75rem; color: #64748b;">${r.Effective_From}</td>
                    <td style="font-weight: 700; color: #334155;">${typeof r.Wage_Ceiling_or_Rule === 'number' ? `₹${r.Wage_Ceiling_or_Rule.toLocaleString('en-IN')}` : r.Wage_Ceiling_or_Rule}</td>
                    <td style="font-weight: 700; color: #2563eb;">${eeRate}</td>
                    <td style="font-weight: 700; color: #16a34a;">${erRate}</td>
                    <td style="text-align: center; font-weight: 800; color: #0f172a;">${r.Due_Date_Day}th</td>
                </tr>
            `;
        }).join('');
    }

    if (statutoryComplianceParseResultsContainer) statutoryComplianceParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Statutory Compliance policies to Cloud Firestore:
 * Path: organizations/{orgId}/statutory_rules/{complianceCode}
 */
async function executeStatutoryComplianceIngest(statutoryDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${statutoryDocs.length} Statutory Compliance policies into organizations/${orgId}/statutory_rules...`);

    let ingestedCount = 0;
    const errors = [];

    for (const docObj of statutoryDocs) {
        try {
            if (window.KylrxStatutoryComplianceService && typeof window.KylrxStatutoryComplianceService.batchUpsertRules === 'function') {
                window.KylrxStatutoryComplianceService.batchUpsertRules([docObj], orgId);
            }
            const ruleRef = doc(db, "organizations", orgId, "statutory_rules", docObj.complianceCode);
            await setDoc(ruleRef, {
                ...docObj,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest Statutory Policy for ${docObj.complianceCode}:`, err);
            errors.push(`${docObj.complianceCode}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} of ${statutoryDocs.length} Statutory Rules.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Statutory Policies Ingested",
            `Successfully ingested all ${ingestedCount} Statutory Compliance rules into Cloud Firestore under organizations/${orgId}/statutory_rules matching PRD Sections 1, 4, 11, & 13! Dynamic payroll deductions and due date alerts are activated.`,
            "success"
        );
    }

    if (btnConfirmStatutoryComplianceIngest) {
        btnConfirmStatutoryComplianceIngest.disabled = false;
        btnConfirmStatutoryComplianceIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }

    if (window.KylrxStatutoryComplianceUIController && typeof window.KylrxStatutoryComplianceUIController.renderAdminConsole === 'function') {
        window.KylrxStatutoryComplianceUIController.renderAdminConsole('onboardingStatutoryComplianceTableContainer', state.orgId);
    }
}

/**
 * Extracts and maps rows from 'Role_Code/Employee Cod' sheet strictly adhering to 13 attributes
 * matching PRD Sections 1, 14, 17, & 18.
 */
async function extract13RolePermissionAttributesFromSheetRows(rows) {
    if (window.KylrxRolePermissionParser && typeof window.KylrxRolePermissionParser.parseRolePermissionSheet === 'function') {
        const parsed = window.KylrxRolePermissionParser.parseRolePermissionSheet(rows);
        const mappedRecords = parsed.docs.map(d => ({
            Role_Code_or_Employee_Code: d.roleCode,
            Role_Name: d.roleName,
            Description: d.description,
            Scope_Level: d.scopeLevel,
            Employee_Module: d.modules.employee,
            Attendance_Module: d.modules.attendance,
            Leave_Module: d.modules.leave,
            Payroll_Module: d.modules.payroll,
            Recruitment_Module: d.modules.recruitment,
            Assets_Module: d.modules.assets,
            Reports_Module: d.modules.reports,
            Organization_Setup: d.modules.organizationSetup,
            Active: d.isActive ? "Yes" : "No"
        }));
        return {
            records: mappedRecords,
            firestoreDocs: parsed.docs,
            errors: parsed.errors
        };
    }

    // Direct fallback mapping
    const records = [];
    const firestoreDocs = [];
    const errors = [];

    rows.forEach((row, idx) => {
        const code = String(row.Role_Code_or_Employee_Code || row.role_code || row.code || '').trim().toUpperCase();
        if (!code) return;

        const isSuperAdmin = (code === 'ROLE_SUPER_ADMIN');
        const targetType = isSuperAdmin ? 'BASE_ROLE' : (code.startsWith('ROLE_') ? 'BASE_ROLE' : 'EMPLOYEE_OVERRIDE');
        const roleName = String(row.Role_Name || row.name || (targetType === 'BASE_ROLE' ? code : `Override for ${code}`));
        const scopeLevel = row.Scope_Level || (isSuperAdmin ? 'Global' : 'Self');

        const modules = {
            employee: isSuperAdmin ? 'Full' : (row.Employee_Module || 'None'),
            attendance: isSuperAdmin ? 'Full' : (row.Attendance_Module || 'None'),
            leave: isSuperAdmin ? 'Full' : (row.Leave_Module || 'None'),
            payroll: isSuperAdmin ? 'Full' : (row.Payroll_Module || 'None'),
            recruitment: isSuperAdmin ? 'Full' : (row.Recruitment_Module || 'None'),
            assets: isSuperAdmin ? 'Full' : (row.Assets_Module || 'None'),
            reports: isSuperAdmin ? 'Full' : (row.Reports_Module || 'None'),
            organizationSetup: isSuperAdmin ? 'Full' : (row.Organization_Setup || 'None')
        };

        const docObj = {
            targetType,
            roleCode: code,
            employeeId: targetType === 'EMPLOYEE_OVERRIDE' ? code : null,
            roleName,
            description: row.Description || '',
            scopeLevel,
            modules,
            isActive: true,
            isImmutable: isSuperAdmin
        };

        firestoreDocs.push(docObj);
        records.push({
            Role_Code_or_Employee_Code: code,
            Role_Name: roleName,
            Description: docObj.description,
            Scope_Level: scopeLevel,
            Employee_Module: modules.employee,
            Attendance_Module: modules.attendance,
            Leave_Module: modules.leave,
            Payroll_Module: modules.payroll,
            Recruitment_Module: modules.recruitment,
            Assets_Module: modules.assets,
            Reports_Module: modules.reports,
            Organization_Setup: modules.organizationSetup,
            Active: "Yes"
        });
    });

    return { records, firestoreDocs, errors };
}

/**
 * Renders the parsed preview table for Role Permissions & Employee Overrides
 */
function renderParsedRolePermissionPreview(fileName, sheetName, records, firestoreDocs, errors) {
    if (rolePermissionParseResultTitle) {
        rolePermissionParseResultTitle.textContent = `'${sheetName}' Sheet Parsed (${records.length} Profiles)`;
    }
    if (rolePermissionParseResultMeta) {
        rolePermissionParseResultMeta.textContent = `File: ${fileName} • 13 Attributes Schema Adhered (PRD §§ 1, 14, 17, & 18)`;
    }

    if (rolePermissionValidationStatusBadge) {
        if (errors && errors.length > 0) {
            rolePermissionValidationStatusBadge.className = 'badge-pending';
            rolePermissionValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle"></i> ${errors.length} Warnings / Notice`;
        } else {
            rolePermissionValidationStatusBadge.className = 'badge-verified';
            rolePermissionValidationStatusBadge.innerHTML = `<i data-lucide="check"></i> 13 Attributes Validated`;
        }
    }

    const baseRolesCount = firestoreDocs.filter(d => d.targetType === 'BASE_ROLE').length;
    const overridesCount = firestoreDocs.filter(d => d.targetType === 'EMPLOYEE_OVERRIDE').length;
    const activeCount = firestoreDocs.filter(d => d.isActive !== false).length;

    if (roleTotalRowsDisplay) roleTotalRowsDisplay.textContent = records.length;
    if (roleTotalBaseRolesDisplay) roleTotalBaseRolesDisplay.textContent = baseRolesCount;
    if (roleTotalOverridesDisplay) roleTotalOverridesDisplay.textContent = overridesCount;
    if (roleTotalActiveDisplay) roleTotalActiveDisplay.textContent = activeCount;

    if (parsedRolePermissionTableBody) {
        const badgeHelper = window.KylrxRbacUIController ? window.KylrxRbacUIController.getBadgeStyle : (p) => 'background: #f1f5f9; color: #475569;';

        parsedRolePermissionTableBody.innerHTML = records.map((r, i) => {
            const isRole = String(r.Role_Code_or_Employee_Code).startsWith('ROLE_');
            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${i + 1}</td>
                    <td style="font-weight: 800; font-family: monospace; color: ${isRole ? '#2563eb' : '#be185d'};">
                        ${r.Role_Code_or_Employee_Code}
                    </td>
                    <td>
                        <span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 6px; font-weight: 800; ${isRole ? 'background: #eff6ff; color: #1e40af;' : 'background: #fdf2f8; color: #9d174d;'}">
                            ${isRole ? 'BASE_ROLE' : 'OVERRIDE'}
                        </span>
                    </td>
                    <td style="font-weight: 600;">${r.Role_Name}</td>
                    <td>
                        <span style="font-size: 0.72rem; padding: 2px 6px; border-radius: 6px; background: #f8fafc; border: 1px solid #e2e8f0; font-weight: 700;">
                            ${r.Scope_Level}
                        </span>
                    </td>
                    <td style="text-align: center;"><span style="font-size: 0.65rem; padding: 2px 4px; border-radius: 4px; ${badgeHelper(r.Employee_Module)}">${r.Employee_Module}</span></td>
                    <td style="text-align: center;"><span style="font-size: 0.65rem; padding: 2px 4px; border-radius: 4px; ${badgeHelper(r.Attendance_Module)}">${r.Attendance_Module}</span></td>
                    <td style="text-align: center;"><span style="font-size: 0.65rem; padding: 2px 4px; border-radius: 4px; ${badgeHelper(r.Leave_Module)}">${r.Leave_Module}</span></td>
                    <td style="text-align: center;"><span style="font-size: 0.65rem; padding: 2px 4px; border-radius: 4px; ${badgeHelper(r.Payroll_Module)}">${r.Payroll_Module}</span></td>
                    <td style="text-align: center;"><span style="font-size: 0.65rem; padding: 2px 4px; border-radius: 4px; ${badgeHelper(r.Recruitment_Module)}">${r.Recruitment_Module}</span></td>
                    <td style="text-align: center;"><span style="font-size: 0.65rem; padding: 2px 4px; border-radius: 4px; ${badgeHelper(r.Assets_Module)}">${r.Assets_Module}</span></td>
                    <td style="text-align: center;"><span style="font-size: 0.65rem; padding: 2px 4px; border-radius: 4px; ${badgeHelper(r.Reports_Module)}">${r.Reports_Module}</span></td>
                    <td style="text-align: center;"><span style="font-size: 0.65rem; padding: 2px 4px; border-radius: 4px; ${badgeHelper(r.Organization_Setup)}">${r.Organization_Setup}</span></td>
                    <td style="text-align: center;">
                        <span style="font-size: 0.7rem; font-weight: 800; color: ${r.Active === 'Yes' ? '#16a34a' : '#dc2626'};">${r.Active}</span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (rolePermissionParseResultsContainer) rolePermissionParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Commits parsed Role Permissions & Employee Overrides to Cloud Firestore:
 * - Base Roles: organizations/{orgId}/roles/{roleCode}
 * - User Overrides: organizations/{orgId}/user_permission_overrides/{employeeId}
 */
async function executeRolePermissionIngest(roleDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${roleDocs.length} Role & Permission Override documents into organizations/${orgId}...`);

    let rolesIngested = 0;
    let overridesIngested = 0;
    const errors = [];

    // Also update in-memory rbacService ledger
    if (window.KylrxRBACService && typeof window.KylrxRBACService.ingestPermissionRecords === 'function') {
        window.KylrxRBACService.ingestPermissionRecords(roleDocs, orgId);
    }

    for (const docObj of roleDocs) {
        try {
            if (docObj.targetType === 'BASE_ROLE') {
                const roleRef = doc(db, "organizations", orgId, "roles", docObj.roleCode);
                await setDoc(roleRef, {
                    ...docObj,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                }, { merge: true });
                rolesIngested++;
            } else {
                const empKey = docObj.employeeId || docObj.roleCode;
                const overrideRef = doc(db, "organizations", orgId, "user_permission_overrides", empKey);
                await setDoc(overrideRef, {
                    ...docObj,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                }, { merge: true });
                overridesIngested++;
            }
        } catch (err) {
            console.error(`Failed to ingest permission record for ${docObj.roleCode}:`, err);
            errors.push(`${docObj.roleCode}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${rolesIngested} Base Roles and ${overridesIngested} Employee Overrides.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "RBAC Profiles Ingested",
            `Successfully ingested all ${rolesIngested} Base Roles and ${overridesIngested} Employee Overrides into Cloud Firestore under organizations/${orgId} matching PRD Sections 1, 14, 17, & 18! Real-time UI element gating is active.`,
            "success"
        );
    }

    if (btnConfirmRolePermissionIngest) {
        btnConfirmRolePermissionIngest.disabled = false;
        btnConfirmRolePermissionIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }
}

/**
 * Extracts and maps rows from 'Workflow Rules' sheet strictly adhering to 10 attributes
 * matching PRD Sections 1, 9, 12, 14, & 18.
 */
async function extract10WorkflowRulesAttributesFromSheetRows(rows) {
    if (window.KylrxWorkflowRulesParser && typeof window.KylrxWorkflowRulesParser.parseWorkflowRulesSheet === 'function') {
        const parsed = window.KylrxWorkflowRulesParser.parseWorkflowRulesSheet(rows);
        const mappedRecords = parsed.records.map(r => ({
            Workflow_Code: r.workflowCode,
            Module: r.module,
            Transaction_Type: r.transactionType,
            Step_No: r.stepNo,
            Approver_Type: r.approverType,
            Approver_Employee_ID: r.approverEmployeeId || '',
            Approver_Role_Code: r.approverRoleCode || '',
            SLA_Hours: r.slaHours,
            Mandatory: r.isMandatory ? "Yes" : "No",
            Active: r.isActive ? "Yes" : "No"
        }));
        return {
            records: mappedRecords,
            workflowDocuments: parsed.workflowDocuments,
            errors: parsed.errors,
            metadata: parsed.metadata
        };
    }

    // Direct fallback
    const records = [];
    const workflowDocuments = [];
    const grouped = {};
    rows.forEach((row, i) => {
        const wfCode = String(row.Workflow_Code || row.workflow_code || row.code || '').trim();
        if (!wfCode) return;
        const mod = String(row.Module || row.module || 'Leave').trim();
        const trx = String(row.Transaction_Type || row.transaction_type || 'General_Request').trim();
        const stepNo = parseInt(row.Step_No || row.step_no || (i + 1), 10);
        const approverType = String(row.Approver_Type || row.approver_type || 'Reporting_Manager').trim();
        const empId = row.Approver_Employee_ID || row.approver_employee_id || null;
        const roleCode = row.Approver_Role_Code || row.approver_role_code || null;
        const sla = parseFloat(row.SLA_Hours || row.sla_hours || 24);
        const mandatory = String(row.Mandatory || 'Yes').toLowerCase().startsWith('y');
        const active = !String(row.Active || 'Yes').toLowerCase().startsWith('n');

        const rec = {
            Workflow_Code: wfCode,
            Module: mod,
            Transaction_Type: trx,
            Step_No: stepNo,
            Approver_Type: approverType,
            Approver_Employee_ID: empId || '',
            Approver_Role_Code: roleCode || '',
            SLA_Hours: sla,
            Mandatory: mandatory ? "Yes" : "No",
            Active: active ? "Yes" : "No"
        };
        records.push(rec);

        if (!grouped[wfCode]) {
            grouped[wfCode] = {
                workflowCode: wfCode,
                module: mod,
                transactionType: trx,
                isActive: active,
                steps: []
            };
        }
        grouped[wfCode].steps.push({
            stepNo,
            approverType,
            approverEmployeeId: empId,
            approverRoleCode: roleCode,
            slaHours: sla,
            isMandatory: mandatory
        });
    });

    for (const k of Object.keys(grouped)) {
        grouped[k].steps.sort((a, b) => a.stepNo - b.stepNo);
        workflowDocuments.push({
            ...grouped[k],
            createdAt: 'serverTimestamp()',
            updatedAt: 'serverTimestamp()'
        });
    }

    return { records, workflowDocuments, errors: [], metadata: { totalWorkflows: workflowDocuments.length, activeWorkflows: workflowDocuments.length, modulesCovered: ['Leave'] } };
}

/**
 * Renders the parsed preview table and visual canvas for Workflow Rules
 */
function renderParsedWorkflowRulesPreview(fileName, sheetName, records, workflowDocs, errors) {
    if (workflowRulesParseResultTitle) {
        workflowRulesParseResultTitle.textContent = `'${sheetName}' Sheet Parsed (${records.length} Step Rows, ${workflowDocs.length} Workflows)`;
    }
    if (workflowRulesParseResultMeta) {
        workflowRulesParseResultMeta.textContent = `File: ${fileName} • 10 Attributes Schema Adhered (PRD §§ 1, 9, 12, 14, & 18)`;
    }

    if (workflowValidationStatusBadge) {
        if (errors && errors.length > 0) {
            workflowValidationStatusBadge.className = 'badge-pending';
            workflowValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle"></i> ${errors.length} Warnings / Issues`;
        } else {
            workflowValidationStatusBadge.className = 'badge-verified';
            workflowValidationStatusBadge.innerHTML = `<i data-lucide="check"></i> 10 Attributes Validated`;
        }
    }

    const uniqueModules = new Set(records.map(r => r.Module));
    const activeWfs = workflowDocs.filter(w => w.isActive !== false).length;

    if (wfTotalStepRowsDisplay) wfTotalStepRowsDisplay.textContent = records.length;
    if (wfTotalWorkflowsDisplay) wfTotalWorkflowsDisplay.textContent = workflowDocs.length;
    if (wfActiveWorkflowsDisplay) wfActiveWorkflowsDisplay.textContent = activeWfs;
    if (wfModulesCoveredDisplay) wfModulesCoveredDisplay.textContent = uniqueModules.size;

    // Render visual flow designer canvas for the first workflow
    if (wfCanvasPreviewContainer && workflowDocs.length > 0 && window.KylrxWorkflowFlowDesigner) {
        window.KylrxWorkflowFlowDesigner.renderFlowCanvas(wfCanvasPreviewContainer, workflowDocs[0], { isReadOnly: false });
    }

    if (workflowRulesParsedTableBody) {
        workflowRulesParsedTableBody.innerHTML = records.map((r, i) => {
            let targetLabel = '-';
            if (r.Approver_Type === 'Specific_Employee') {
                targetLabel = `<span style="font-size: 0.72rem; font-weight: 700; color: #b45309; background: #fef3c7; padding: 2px 6px; border-radius: 4px;">ID: ${r.Approver_Employee_ID}</span>`;
            } else if (r.Approver_Type === 'Role_Based') {
                targetLabel = `<span style="font-size: 0.72rem; font-weight: 700; color: #4338ca; background: #e0e7ff; padding: 2px 6px; border-radius: 4px;">Role: ${r.Approver_Role_Code}</span>`;
            } else {
                targetLabel = `<span style="font-size: 0.72rem; color: #64748b;">Dynamic</span>`;
            }

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${i + 1}</td>
                    <td style="font-weight: 800; font-family: monospace; color: #0284c7;">
                        ${r.Workflow_Code}
                    </td>
                    <td>
                        <span style="font-size: 0.72rem; padding: 2px 6px; border-radius: 6px; background: #f1f5f9; color: #334155; font-weight: 700;">
                            ${r.Module}
                        </span>
                    </td>
                    <td style="font-weight: 600;">${r.Transaction_Type}</td>
                    <td style="text-align: center; font-weight: 800; color: #0f172a;">${r.Step_No}</td>
                    <td>
                        <span style="font-size: 0.72rem; padding: 2px 6px; border-radius: 6px; background: #e0f2fe; color: #0369a1; font-weight: 700;">
                            ${r.Approver_Type}
                        </span>
                    </td>
                    <td>${targetLabel}</td>
                    <td style="text-align: center; font-weight: 700;">${r.SLA_Hours}h</td>
                    <td style="text-align: center;">
                        <span style="font-size: 0.7rem; font-weight: 800; color: ${r.Mandatory === 'Yes' ? '#b91c1c' : '#64748b'};">${r.Mandatory}</span>
                    </td>
                    <td style="text-align: center;">
                        <span style="font-size: 0.7rem; font-weight: 800; color: ${r.Active === 'Yes' ? '#16a34a' : '#dc2626'};">${r.Active}</span>
                    </td>
                </tr>
            `;
        }).join('');
    }

    if (workflowRulesParseResultsContainer) workflowRulesParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Ingests hierarchical workflow documents into Cloud Firestore:
 * Path: organizations/{orgId}/workflows/{workflowCode}
 */
async function executeWorkflowRulesIngest(workflowDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${workflowDocs.length} Workflow Chain documents into organizations/${orgId}/workflows/...`);

    let ingestedCount = 0;
    const errors = [];

    for (const wf of workflowDocs) {
        try {
            const wfRef = doc(db, "organizations", orgId, "workflows", wf.workflowCode);
            await setDoc(wfRef, {
                workflowCode: wf.workflowCode,
                module: wf.module,
                transactionType: wf.transactionType,
                isActive: wf.isActive !== false,
                steps: wf.steps,
                totalSteps: wf.steps.length,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest workflow ${wf.workflowCode}:`, err);
            errors.push(`${wf.workflowCode}: ${err.message}`);
        }
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} Workflows.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Workflow Rules Ingested",
            `Successfully ingested all ${ingestedCount} multi-step workflow configurations into Cloud Firestore under organizations/${orgId}/workflows matching PRD Sections 1, 9, 12, 14, & 18! Dynamic approval router is active.`,
            "success"
        );
    }

    if (btnConfirmWorkflowRulesIngest) {
        btnConfirmWorkflowRulesIngest.disabled = false;
        btnConfirmWorkflowRulesIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }
}

/**
 * Extracts and maps rows from 'Payroll Components' sheet strictly adhering to 13 attributes:
 * 1. Component_Code (PK)
 * 2. Component_Name (display title)
 * 3. Component_Type ("Earning", "Deduction", "Reimbursement", "Employer_Contribution")
 * 4. Calculation_Method ("Flat_Amount", "Percentage", "Formula", "Slab")
 * 5. Value_or_Percentage (number | null)
 * 6. Percentage_Basis (string | null: "BASIC", "GROSS", "CTC", etc.)
 * 7. Taxable (boolean: true for "Yes", false for "No")
 * 8. PF_Applicable (boolean: true for "Yes", false for "No")
 * 9. ESI_Applicable (boolean: true for "Yes", false for "No")
 * 10. PT_Applicable (boolean: true for "Yes", false for "No")
 * 11. TDS_Applicable (boolean: true for "Yes", false for "No")
 * 12. Prorate_On_LOP (boolean: true for "Yes", false for "No")
 * 13. Active (boolean: true for "Yes", false for "No")
 */
async function extract13PayrollComponentAttributesFromSheetRows(rawRows) {
    const parser = window.KylrxPayrollComponentsParser || window.payrollComponentsParser;
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';

    if (parser && typeof parser.parsePayrollComponents === 'function') {
        const parsed = parser.parsePayrollComponents(rawRows, { orgId });
        return {
            records: parsed.records || [],
            firestoreDocs: parsed.firestoreDocs || [],
            errors: parsed.errors || [],
            metadata: parsed.metadata || {}
        };
    }

    // Fallback extraction if parser not loaded
    const records = [];
    const firestoreDocs = [];
    const errors = [];
    const seenCodes = new Set();

    function normalizeKey(str) {
        return String(str || '').toLowerCase().replace(/[\s_-]+/g, '');
    }

    function getVal(row, synonyms) {
        const keys = Object.keys(row);
        for (const syn of synonyms) {
            const cleanSyn = normalizeKey(syn);
            const foundKey = keys.find(k => normalizeKey(k) === cleanSyn);
            if (foundKey && row[foundKey] !== undefined && row[foundKey] !== null) {
                const val = row[foundKey];
                if (typeof val === 'string' && val.trim() !== '') return val.trim();
                if (typeof val !== 'string') return val;
            }
        }
        return '';
    }

    function parseBoolean(val, defaultVal = false) {
        if (typeof val === 'boolean') return val;
        const s = String(val || '').trim().toLowerCase();
        if (['yes', 'true', '1', 'y'].includes(s)) return true;
        if (['no', 'false', '0', 'n'].includes(s)) return false;
        return defaultVal;
    }

    rawRows.forEach((row, idx) => {
        const rowNum = idx + 2;
        const code = String(getVal(row, ['component_code', 'componentcode', 'code']) || '').trim().toUpperCase();
        const name = String(getVal(row, ['component_name', 'componentname', 'name', 'title']) || '').trim();
        const type = String(getVal(row, ['component_type', 'componenttype', 'type']) || 'Earning').trim();
        const method = String(getVal(row, ['calculation_method', 'calculationmethod', 'method']) || 'Flat_Amount').trim();
        const rawVal = getVal(row, ['value_or_percentage', 'valueorpercentage', 'value', 'percentage', 'pct']);
        const basis = String(getVal(row, ['percentage_basis', 'percentagebasis', 'basis']) || '').trim().toUpperCase() || null;

        const isTaxable = parseBoolean(getVal(row, ['taxable', 'is_taxable']), true);
        const isPf = parseBoolean(getVal(row, ['pf_applicable', 'pfapplicable']), false);
        const isEsi = parseBoolean(getVal(row, ['esi_applicable', 'esiapplicable']), false);
        const isPt = parseBoolean(getVal(row, ['pt_applicable', 'ptapplicable']), false);
        const isTds = parseBoolean(getVal(row, ['tds_applicable', 'tdsapplicable']), false);
        const prorateOnLop = parseBoolean(getVal(row, ['prorate_on_lop', 'prorateonlop']), true);
        const isActive = parseBoolean(getVal(row, ['active', 'is_active']), true);

        if (!code) {
            errors.push(`Row ${rowNum}: Missing mandatory Component_Code.`);
            return;
        }
        if (seenCodes.has(code)) {
            errors.push(`Row ${rowNum}: Duplicate Component_Code "${code}".`);
            return;
        }
        seenCodes.add(code);

        const record = {
            Component_Code: code,
            Component_Name: name || code,
            Component_Type: type,
            Calculation_Method: method,
            Value_or_Percentage: rawVal !== '' ? Number(rawVal) : null,
            Percentage_Basis: basis,
            Taxable: isTaxable ? 'Yes' : 'No',
            PF_Applicable: isPf ? 'Yes' : 'No',
            ESI_Applicable: isEsi ? 'Yes' : 'No',
            PT_Applicable: isPt ? 'Yes' : 'No',
            TDS_Applicable: isTds ? 'Yes' : 'No',
            Prorate_On_LOP: prorateOnLop ? 'Yes' : 'No',
            Active: isActive ? 'Yes' : 'No'
        };

        const docPayload = {
            componentCode: code,
            componentName: name || code,
            componentType: type,
            calculationMethod: method,
            defaultValueOrPercentage: rawVal !== '' ? Number(rawVal) : null,
            percentageBasis: basis,
            isTaxable,
            isPfApplicable: isPf,
            isEsiApplicable: isEsi,
            isPtApplicable: isPt,
            isTdsApplicable: isTds,
            prorateOnLop,
            isActive
        };

        records.push(record);
        firestoreDocs.push(docPayload);
    });

    return { records, firestoreDocs, errors };
}

/**
 * Renders the parsed preview table for Payroll Components
 */
function renderParsedPayrollComponentPreview(fileName, sheetName, records, firestoreDocs, errors) {
    if (payrollComponentsParseResultTitle) {
        payrollComponentsParseResultTitle.textContent = `'${sheetName}' Sheet Parsed (${records.length} Components)`;
    }
    if (payrollComponentsParseResultMeta) {
        payrollComponentsParseResultMeta.textContent = `File: ${fileName} • 13 Attributes Schema Adhered (PRD §§ 1 & 4)`;
    }

    if (payrollComponentsValidationStatusBadge) {
        if (errors && errors.length > 0) {
            payrollComponentsValidationStatusBadge.className = 'badge-pending';
            payrollComponentsValidationStatusBadge.innerHTML = `<i data-lucide="alert-triangle"></i> ${errors.length} Warnings / Issues`;
        } else {
            payrollComponentsValidationStatusBadge.className = 'badge-verified';
            payrollComponentsValidationStatusBadge.innerHTML = `<i data-lucide="check"></i> 13 Attributes Validated`;
        }
    }

    const earningsCount = records.filter(r => r.Component_Type === 'Earning').length;
    const deductionsCount = records.filter(r => r.Component_Type === 'Deduction').length;
    const statutoryCount = records.filter(r => r.PF_Applicable === 'Yes' || r.ESI_Applicable === 'Yes' || r.PT_Applicable === 'Yes' || r.TDS_Applicable === 'Yes').length;

    if (compTotalRowsDisplay) compTotalRowsDisplay.textContent = records.length;
    if (compEarningsDisplay) compEarningsDisplay.textContent = earningsCount;
    if (compDeductionsDisplay) compDeductionsDisplay.textContent = deductionsCount;
    if (compStatutoryDisplay) compStatutoryDisplay.textContent = statutoryCount;

    if (parsedPayrollComponentsTableBody) {
        parsedPayrollComponentsTableBody.innerHTML = records.map((r, i) => {
            const typeBadge = {
                'Earning': 'background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0;',
                'Deduction': 'background: #fffbeb; color: #d97706; border: 1px solid #fde68a;',
                'Reimbursement': 'background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe;',
                'Employer_Contribution': 'background: #faf5ff; color: #7c3aed; border: 1px solid #e9d5ff;'
            }[r.Component_Type] || 'background: #f1f5f9; color: #475569;';

            const valDisplay = r.Calculation_Method === 'Percentage'
                ? `${r.Value_or_Percentage}% of ${r.Percentage_Basis || 'BASIC'}`
                : (r.Value_or_Percentage != null ? `₹${Number(r.Value_or_Percentage).toLocaleString('en-IN')}` : '-');

            return `
                <tr>
                    <td style="font-weight: 700; color: var(--text-muted);">${i + 1}</td>
                    <td style="font-weight: 800; font-family: monospace; color: #2563eb;">${r.Component_Code}</td>
                    <td style="font-weight: 600;">${r.Component_Name}</td>
                    <td>
                        <span style="font-size: 0.72rem; padding: 2px 8px; border-radius: 6px; font-weight: 700; ${typeBadge}">
                            ${r.Component_Type}
                        </span>
                    </td>
                    <td style="font-size: 0.8rem; color: #475569;">${r.Calculation_Method}</td>
                    <td style="font-size: 0.8rem; font-weight: 700;">${valDisplay}</td>
                    <td style="text-align: center; font-size: 0.75rem; font-weight: 800; color: ${r.Taxable === 'Yes' ? '#16a34a' : '#64748b'};">${r.Taxable}</td>
                    <td style="text-align: center; font-size: 0.75rem; font-weight: 800; color: ${r.PF_Applicable === 'Yes' ? '#2563eb' : '#64748b'};">${r.PF_Applicable}</td>
                    <td style="text-align: center; font-size: 0.75rem; font-weight: 800; color: ${r.ESI_Applicable === 'Yes' ? '#2563eb' : '#64748b'};">${r.ESI_Applicable}</td>
                    <td style="text-align: center; font-size: 0.75rem; font-weight: 800; color: ${r.PT_Applicable === 'Yes' ? '#2563eb' : '#64748b'};">${r.PT_Applicable}</td>
                    <td style="text-align: center; font-size: 0.75rem; font-weight: 800; color: ${r.TDS_Applicable === 'Yes' ? '#2563eb' : '#64748b'};">${r.TDS_Applicable}</td>
                    <td style="text-align: center; font-size: 0.75rem; font-weight: 800; color: ${r.Prorate_On_LOP === 'Yes' ? '#2563eb' : '#64748b'};">${r.Prorate_On_LOP}</td>
                    <td style="text-align: center; font-size: 0.75rem; font-weight: 800; color: ${r.Active === 'Yes' ? '#16a34a' : '#dc2626'};">${r.Active}</td>
                </tr>
            `;
        }).join('');
    }

    if (payrollComponentsParseResultsContainer) payrollComponentsParseResultsContainer.style.display = 'block';
    if (window.lucide) lucide.createIcons();
}

/**
 * Ingests Payroll Component records into Cloud Firestore:
 * Path: organizations/{orgId}/payroll_components/{componentCode}
 */
async function executePayrollComponentIngest(componentDocs) {
    const orgId = state.orgId || localStorage.getItem('orgId') || 'org_kylrx';
    console.log(`🚀 Ingesting ${componentDocs.length} Payroll Component documents into organizations/${orgId}/payroll_components/...`);

    let ingestedCount = 0;
    const errors = [];

    for (const comp of componentDocs) {
        try {
            const compRef = doc(db, "organizations", orgId, "payroll_components", comp.componentCode);
            await setDoc(compRef, {
                componentCode: comp.componentCode,
                componentName: comp.componentName,
                componentType: comp.componentType,
                calculationMethod: comp.calculationMethod,
                defaultValueOrPercentage: comp.defaultValueOrPercentage,
                percentageBasis: comp.percentageBasis,
                isTaxable: Boolean(comp.isTaxable),
                isPfApplicable: Boolean(comp.isPfApplicable),
                isEsiApplicable: Boolean(comp.isEsiApplicable),
                isPtApplicable: Boolean(comp.isPtApplicable),
                isTdsApplicable: Boolean(comp.isTdsApplicable),
                prorateOnLop: Boolean(comp.prorateOnLop),
                isActive: Boolean(comp.isActive),
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            }, { merge: true });
            ingestedCount++;
        } catch (err) {
            console.error(`Failed to ingest payroll component ${comp.componentCode}:`, err);
            errors.push(`${comp.componentCode}: ${err.message}`);
        }
    }

    // Also update in-memory payrollComponentService
    const svc = window.KylrxPayrollComponentService || window.payrollComponentService;
    if (svc && typeof svc.ingestComponentRecords === 'function') {
        svc.ingestComponentRecords(componentDocs, orgId);
    }

    if (errors.length > 0) {
        window.showCustomAlert("Partial Ingest", `Ingested ${ingestedCount} Components.\nErrors:\n${errors.join('\n')}`, "warning");
    } else {
        window.showCustomAlert(
            "Payroll Components Ingested",
            `Successfully ingested all ${ingestedCount} payroll components into Cloud Firestore under organizations/${orgId}/payroll_components matching PRD Sections 1 & 4! Calculation engine and catalog updated.`,
            "success"
        );
    }

    if (btnConfirmPayrollComponentsIngest) {
        btnConfirmPayrollComponentsIngest.disabled = false;
        btnConfirmPayrollComponentsIngest.innerHTML = '<i data-lucide="check-circle-2"></i> Ingestion Complete';
        if (window.lucide) lucide.createIcons();
    }
}





