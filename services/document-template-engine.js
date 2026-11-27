const crypto = require('crypto');
const logger = require('../utils/logger');
const automationEngine = require('./automation-engine');

/**
 * Enterprise Document & Template Engine (Kylrx Enterprise Suite)
 * 
 * Centralizes document generation across the entire automation platform.
 * Full Automation delegates to this engine rather than embedding document logic.
 * 
 * 10 Standard Document Templates:
 * 1. Offer Letter
 * 2. Appointment Letter
 * 3. Promotion Letter
 * 4. Increment Letter
 * 5. Transfer Letter
 * 6. Payslip
 * 7. F&F Statement (Full & Final Settlement)
 * 8. Relieving Letter
 * 9. Experience Letter
 * 10. Termination Letter
 * 
 * Core Features:
 * - Version Control (e.g. v1.0.0, v1.1.0, v2.0.0 with author, change notes, draft/approved)
 * - Effective Dates (effectiveFrom, effectiveTo; selects current approved version)
 * - Approval Lifecycle (draft -> pending_approval -> approved; only approved can generate)
 * - Employee-Field Mapping ({{employee.name}}, {{compensation.ctc}}, fallback defaults)
 * - Permitted Modules Gating (No / limited actions, Yes, permitted modules)
 * - Stage 8 Audit Logging via AutomationEngine
 */

class DocumentTemplateEngine {
    // One engine per company (see forOrg): each company's template versions and generated documents are its own
    constructor(orgId = null) {
        this.orgId = orgId || null;
        this.templates = new Map();
        this.generatedDocuments = new Map();
        this.initializeStandardTemplates();
    }

    /** This company's engine (created on first use) */
    forOrg(orgId) {
        if (!orgId) throw new Error('A company is required for document templates.');
        if (!orgEngines.has(orgId)) orgEngines.set(orgId, new DocumentTemplateEngine(orgId));
        return orgEngines.get(orgId);
    }

    /**
     * Compute SHA-256 integrity hash
     */
    computeHash(content) {
        return crypto.createHash('sha256').update(content || '').digest('hex');
    }

    /**
     * Pre-seed the 10 Standard Enterprise Templates with approved V1 versions
     */
    initializeStandardTemplates() {
        const standardDefinitions = [
            // 1. Offer Letter
            {
                key: 'offer_letter',
                name: 'Offer Letter',
                description: 'Formal employment offer extended to prospective candidates outlining compensation and terms.',
                category: 'Onboarding',
                permittedModules: ['onboarding', 'hr_admin'],
                fieldMappings: [
                    { token: '{{candidate.name}}', label: 'Candidate Full Name', required: true, sample: 'Rahul Deshmukh' },
                    { token: '{{candidate.email}}', label: 'Candidate Email', required: true, sample: 'rahul.deshmukh@example.com' },
                    { token: '{{job.title}}', label: 'Offered Designation', required: true, sample: 'Senior Full Stack Engineer' },
                    { token: '{{job.department}}', label: 'Department', required: true, sample: 'Engineering' },
                    { token: '{{job.location}}', label: 'Work Location', required: true, sample: 'Bengaluru, India' },
                    { token: '{{compensation.annualCtc}}', label: 'Annual CTC (INR)', required: true, sample: '₹ 28,50,000' },
                    { token: '{{offer.joiningDate}}', label: 'Expected Joining Date', required: true, sample: '2026-10-15' },
                    { token: '{{offer.validUntil}}', label: 'Offer Validity Date', required: true, sample: '2026-09-30' },
                    { token: '{{company.name}}', label: 'Company Legal Entity', required: true, sample: 'Kylrx Technologies Private Limited' },
                    { token: '{{signatory.name}}', label: 'Authorized Signatory', required: true, sample: 'Swati Khandelwal, VP of HR' }
                ],
                initialBody: `
<div class="doc-container">
    <div class="doc-header">
        <h2>{{company.name}}</h2>
        <p>Private & Confidential Employment Offer</p>
    </div>
    <div class="doc-body">
        <p>Date: {{date.today}}</p>
        <p>Dear <strong>{{candidate.name}}</strong>,</p>
        <p>We are delighted to extend an offer of employment for the position of <strong>{{job.title}}</strong> in our <strong>{{job.department}}</strong> team at {{job.location}}.</p>
        <p>Your Total Annual Cost to Company (CTC) will be <strong>{{compensation.annualCtc}}</strong> per annum. Your anticipated commencement of service is <strong>{{offer.joiningDate}}</strong>.</p>
        <p>This offer is valid until <strong>{{offer.validUntil}}</strong>. Please sign and return the duplicate copy as an acknowledgment of your acceptance.</p>
        <div class="doc-signatures">
            <div><p>Sincerely,</p><p><strong>{{signatory.name}}</strong><br>{{company.name}}</p></div>
            <div><p>Accepted By:</p><p><strong>{{candidate.name}}</strong><br>Date: _____________</p></div>
        </div>
    </div>
</div>`
            },

            // 2. Appointment Letter
            {
                key: 'appointment_letter',
                name: 'Appointment Letter',
                description: 'Legally binding appointment contract issued upon Day 1 joining confirmation.',
                category: 'Onboarding',
                permittedModules: ['onboarding', 'hr_admin'],
                fieldMappings: [
                    { token: '{{employee.code}}', label: 'Employee ID', required: true, sample: 'EMP-1048' },
                    { token: '{{employee.name}}', label: 'Employee Name', required: true, sample: 'Rahul Deshmukh' },
                    { token: '{{employee.designation}}', label: 'Designation', required: true, sample: 'Senior Full Stack Engineer' },
                    { token: '{{employee.joiningDate}}', label: 'Effective Joining Date', required: true, sample: '2026-10-15' },
                    { token: '{{probation.periodMonths}}', label: 'Probation Duration', required: true, sample: '6 Months' },
                    { token: '{{company.name}}', label: 'Company Legal Entity', required: true, sample: 'Kylrx Technologies Private Limited' }
                ],
                initialBody: `
<div class="doc-container">
    <div class="doc-header"><h2>{{company.name}}</h2><p>Official Letter of Appointment</p></div>
    <div class="doc-body">
        <p>Employee Code: <strong>{{employee.code}}</strong></p>
        <p>Dear <strong>{{employee.name}}</strong>,</p>
        <p>With reference to your acceptance of our offer, we are pleased to appoint you as <strong>{{employee.designation}}</strong> effective from <strong>{{employee.joiningDate}}</strong>.</p>
        <p>You will be on probation for a period of <strong>{{probation.periodMonths}}</strong> from your date of joining. You will be governed by the standard company employment policies.</p>
    </div>
</div>`
            },

            // 3. Promotion Letter
            {
                key: 'promotion_letter',
                name: 'Promotion Letter',
                description: 'Official corporate recognition of grade elevation, title advancement, and revised role responsibilities.',
                category: 'PMS',
                permittedModules: ['workforce_lifecycle', 'pms', 'hr_admin'],
                fieldMappings: [
                    { token: '{{employee.code}}', label: 'Employee ID', required: true, sample: 'EMP-742' },
                    { token: '{{employee.name}}', label: 'Employee Name', required: true, sample: 'Kavita Joshi' },
                    { token: '{{promotion.previousTitle}}', label: 'Previous Role', required: true, sample: 'Lead Frontend Developer' },
                    { token: '{{promotion.newTitle}}', label: 'Promoted Role', required: true, sample: 'Staff Cloud Architect' },
                    { token: '{{promotion.newBand}}', label: 'New Grade / Band', required: true, sample: 'L6 - Principal Staff' },
                    { token: '{{promotion.effectiveDate}}', label: 'Effective Date', required: true, sample: '2026-10-01' },
                    { token: '{{company.name}}', label: 'Company Legal Entity', required: true, sample: 'Kylrx Technologies Private Limited' }
                ],
                initialBody: `
<div class="doc-container">
    <div class="doc-header"><h2>{{company.name}}</h2><p>Career Milestone: Promotion Recognition</p></div>
    <div class="doc-body">
        <p>Dear <strong>{{employee.name}}</strong> ({{employee.code}}),</p>
        <p>In recognition of your exceptional performance and leadership impact, the Executive Committee is pleased to promote you from <strong>{{promotion.previousTitle}}</strong> to <strong>{{promotion.newTitle}}</strong> (Grade: <strong>{{promotion.newBand}}</strong>).</p>
        <p>This promotion becomes effective from <strong>{{promotion.effectiveDate}}</strong>. Congratulations on this well-deserved achievement!</p>
    </div>
</div>`
            },

            // 4. Increment Letter
            {
                key: 'increment_letter',
                name: 'Increment Letter',
                description: 'Annual or cycle-based compensation revision, increment percentage, and updated salary breakdown.',
                category: 'PMS',
                permittedModules: ['workforce_lifecycle', 'pms', 'payroll', 'hr_admin'],
                fieldMappings: [
                    { token: '{{employee.code}}', label: 'Employee ID', required: true, sample: 'EMP-742' },
                    { token: '{{employee.name}}', label: 'Employee Name', required: true, sample: 'Kavita Joshi' },
                    { token: '{{compensation.previousCtc}}', label: 'Previous CTC', required: true, sample: '₹ 22,00,000' },
                    { token: '{{compensation.revisedCtc}}', label: 'Revised CTC', required: true, sample: '₹ 26,40,000' },
                    { token: '{{compensation.incrementPct}}', label: 'Increment Percentage', required: true, sample: '20.0%' },
                    { token: '{{compensation.effectiveDate}}', label: 'Effective Date', required: true, sample: '2026-10-01' },
                    { token: '{{company.name}}', label: 'Company Legal Entity', required: true, sample: 'Kylrx Technologies Private Limited' }
                ],
                initialBody: `
<div class="doc-container">
    <div class="doc-header"><h2>{{company.name}}</h2><p>Annual Compensation Revision</p></div>
    <div class="doc-body">
        <p>Dear <strong>{{employee.name}}</strong> ({{employee.code}}),</p>
        <p>Following your recent performance appraisal review, your annual compensation has been revised by <strong>{{compensation.incrementPct}}</strong>.</p>
        <p>Previous Annual CTC: <strong>{{compensation.previousCtc}}</strong><br>
        Revised Annual CTC: <strong>{{compensation.revisedCtc}}</strong><br>
        Effective Date: <strong>{{compensation.effectiveDate}}</strong></p>
    </div>
</div>`
            },

            // 5. Transfer Letter
            {
                key: 'transfer_letter',
                name: 'Transfer Letter',
                description: 'Formal confirmation of inter-departmental, business unit, or geographic location transfer.',
                category: 'Workforce',
                permittedModules: ['workforce_lifecycle', 'hr_admin'],
                fieldMappings: [
                    { token: '{{employee.code}}', label: 'Employee ID', required: true, sample: 'EMP-309' },
                    { token: '{{employee.name}}', label: 'Employee Name', required: true, sample: 'Amit Saxena' },
                    { token: '{{transfer.fromLocation}}', label: 'Current Location', required: true, sample: 'Mumbai Center' },
                    { token: '{{transfer.toLocation}}', label: 'Target Location', required: true, sample: 'Bengaluru Campus' },
                    { token: '{{transfer.newDepartment}}', label: 'New Department', required: true, sample: 'Enterprise Cloud' },
                    { token: '{{transfer.effectiveDate}}', label: 'Reporting Date', required: true, sample: '2026-11-01' },
                    { token: '{{company.name}}', label: 'Company Legal Entity', required: true, sample: 'Kylrx Technologies Private Limited' }
                ],
                initialBody: `
<div class="doc-container">
    <div class="doc-header"><h2>{{company.name}}</h2><p>Inter-Office Transfer Order</p></div>
    <div class="doc-body">
        <p>Dear <strong>{{employee.name}}</strong> ({{employee.code}}),</p>
        <p>In line with organizational requirements, you are transferred from <strong>{{transfer.fromLocation}}</strong> to <strong>{{transfer.toLocation}}</strong> in the <strong>{{transfer.newDepartment}}</strong> unit.</p>
        <p>You are requested to report at the new location on <strong>{{transfer.effectiveDate}}</strong>. Relocation assistance will be provided as per company policy.</p>
    </div>
</div>`
            },

            // 6. Payslip
            {
                key: 'payslip',
                name: 'Monthly Payslip',
                description: 'Itemized statement of monthly earnings, allowances, statutory deductions (PF, ESIC, PT, TDS), and net payout.',
                category: 'Payroll',
                permittedModules: ['payroll', 'hr_admin'],
                fieldMappings: [
                    { token: '{{employee.code}}', label: 'Employee ID', required: true, sample: 'EMP-882' },
                    { token: '{{employee.name}}', label: 'Employee Name', required: true, sample: 'Priya Sharma' },
                    { token: '{{payroll.monthYear}}', label: 'Payroll Month', required: true, sample: 'September 2026' },
                    { token: '{{payroll.paidDays}}', label: 'Payable Days', required: true, sample: '30' },
                    { token: '{{earnings.basic}}', label: 'Basic Salary', required: true, sample: '₹ 85,000' },
                    { token: '{{earnings.hra}}', label: 'HRA', required: true, sample: '₹ 42,500' },
                    { token: '{{earnings.specialAllowance}}', label: 'Special Allowance', required: true, sample: '₹ 38,000' },
                    { token: '{{earnings.gross}}', label: 'Gross Earnings', required: true, sample: '₹ 1,65,500' },
                    { token: '{{deductions.pf}}', label: 'Provident Fund (EPF)', required: true, sample: '₹ 1,800' },
                    { token: '{{deductions.tax}}', label: 'TDS / Income Tax', required: true, sample: '₹ 22,400' },
                    { token: '{{deductions.total}}', label: 'Total Deductions', required: true, sample: '₹ 24,200' },
                    { token: '{{payroll.netSalary}}', label: 'Net Take-Home Pay', required: true, sample: '₹ 1,41,300' },
                    { token: '{{company.name}}', label: 'Company Legal Entity', required: true, sample: 'Kylrx Technologies Private Limited' }
                ],
                initialBody: `
<div class="doc-container">
    <div class="doc-header"><h2>{{company.name}}</h2><p>Salary Payslip for {{payroll.monthYear}}</p></div>
    <div class="doc-body">
        <p>Employee: <strong>{{employee.name}}</strong> | ID: <strong>{{employee.code}}</strong> | Paid Days: {{payroll.paidDays}}</p>
        <table style="width:100%; border-collapse: collapse; margin-top: 12px;">
            <tr><th style="text-align:left;">Earnings</th><th style="text-align:right;">Amount</th><th style="text-align:left;">Deductions</th><th style="text-align:right;">Amount</th></tr>
            <tr><td>Basic</td><td style="text-align:right;">{{earnings.basic}}</td><td>Provident Fund (EPF)</td><td style="text-align:right;">{{deductions.pf}}</td></tr>
            <tr><td>HRA</td><td style="text-align:right;">{{earnings.hra}}</td><td>Income Tax (TDS)</td><td style="text-align:right;">{{deductions.tax}}</td></tr>
            <tr><td>Special Allowance</td><td style="text-align:right;">{{earnings.specialAllowance}}</td><td>Other Deductions</td><td style="text-align:right;">₹ 0</td></tr>
            <tr style="font-weight:bold;"><td>Gross Earnings</td><td style="text-align:right;">{{earnings.gross}}</td><td>Total Deductions</td><td style="text-align:right;">{{deductions.total}}</td></tr>
        </table>
        <h3 style="margin-top:16px; color:#4f46e5;">Net Disbursed Amount: {{payroll.netSalary}}</h3>
    </div>
</div>`
            },

            // 7. F&F Statement (Full & Final)
            {
                key: 'fnf_statement',
                name: 'Full & Final (F&F) Statement',
                description: 'Comprehensive financial settlement statement detailing final salary, leave encashment, gratuity, and recoveries.',
                category: 'Exit',
                permittedModules: ['exit', 'exit_offboarding', 'payroll', 'hr_admin'],
                fieldMappings: [
                    { token: '{{employee.code}}', label: 'Employee ID', required: true, sample: 'EMP-042' },
                    { token: '{{employee.name}}', label: 'Employee Name', required: true, sample: 'Alex Mercer' },
                    { token: '{{exit.lastWorkingDay}}', label: 'Last Working Day', required: true, sample: '2026-09-30' },
                    { token: '{{fnf.unpaidSalary}}', label: 'Unpaid Salary', required: true, sample: '₹ 45,000' },
                    { token: '{{fnf.leaveEncashment}}', label: 'Leave Encashment', required: true, sample: '₹ 32,500' },
                    { token: '{{fnf.gratuity}}', label: 'Gratuity Settlement', required: true, sample: '₹ 65,000' },
                    { token: '{{fnf.recoveries}}', label: 'Asset / Notice Deductions', required: true, sample: '₹ 0' },
                    { token: '{{fnf.netSettlement}}', label: 'Net Payable Settlement', required: true, sample: '₹ 1,42,500' },
                    { token: '{{company.name}}', label: 'Company Legal Entity', required: true, sample: 'Kylrx Technologies Private Limited' }
                ],
                initialBody: `
<div class="doc-container">
    <div class="doc-header"><h2>{{company.name}}</h2><p>Full & Final Settlement Voucher (F&F)</p></div>
    <div class="doc-body">
        <p>Employee: <strong>{{employee.name}}</strong> ({{employee.code}}) | LWD: <strong>{{exit.lastWorkingDay}}</strong></p>
        <p>Pending Days Salary: {{fnf.unpaidSalary}}<br>
        Leave Encashment Payout: {{fnf.leaveEncashment}}<br>
        Statutory Gratuity: {{fnf.gratuity}}<br>
        Less: Recoveries / Deductions: {{fnf.recoveries}}</p>
        <h3>Net Final Disbursement: {{fnf.netSettlement}}</h3>
        <p style="font-size:0.8rem; color:#64748b;">All departmental clearances (IT, Admin, Finance, Library) verified.</p>
    </div>
</div>`
            },

            // 8. Relieving Letter
            {
                key: 'relieving_letter',
                name: 'Relieving Letter',
                description: 'Formal corporate release certifying clearance of all duties, handover of assets, and relief from service.',
                category: 'Exit',
                permittedModules: ['exit', 'exit_offboarding', 'hr_admin'],
                fieldMappings: [
                    { token: '{{employee.code}}', label: 'Employee ID', required: true, sample: 'EMP-042' },
                    { token: '{{employee.name}}', label: 'Employee Name', required: true, sample: 'Alex Mercer' },
                    { token: '{{employee.designation}}', label: 'Designation at Exit', required: true, sample: 'Lead Software Architect' },
                    { token: '{{exit.resignationDate}}', label: 'Resignation Date', required: true, sample: '2026-08-01' },
                    { token: '{{exit.relievingDate}}', label: 'Relieving Date', required: true, sample: '2026-09-30' },
                    { token: '{{company.name}}', label: 'Company Legal Entity', required: true, sample: 'Kylrx Technologies Private Limited' },
                    { token: '{{signatory.name}}', label: 'HR Signatory', required: true, sample: 'Swati Khandelwal, VP of HR' }
                ],
                initialBody: `
<div class="doc-container">
    <div class="doc-header"><h2>{{company.name}}</h2><p>Official Relieving Letter</p></div>
    <div class="doc-body">
        <p>Date: {{date.today}}</p>
        <p>To Whom It May Concern,</p>
        <p>This is to certify that <strong>{{employee.name}}</strong> (Employee ID: <strong>{{employee.code}}</strong>) was employed with <strong>{{company.name}}</strong> as <strong>{{employee.designation}}</strong>.</p>
        <p>Pursuant to their resignation submitted on {{exit.resignationDate}}, they are hereby relieved from all duties and employment responsibilities effective the close of business on <strong>{{exit.relievingDate}}</strong>.</p>
        <p>All company assets and departmental clearances have been duly completed and verified.</p>
        <p>We wish {{employee.name}} every success in their future professional endeavors.</p>
        <div style="margin-top:30px;"><p>For {{company.name}},</p><p><strong>{{signatory.name}}</strong></p></div>
    </div>
</div>`
            },

            // 9. Experience Letter
            {
                key: 'experience_letter',
                name: 'Experience Letter',
                description: 'Certificate of tenure, roles held, character, and professional service with the organization.',
                category: 'Exit',
                permittedModules: ['exit', 'exit_offboarding', 'hr_admin'],
                fieldMappings: [
                    { token: '{{employee.code}}', label: 'Employee ID', required: true, sample: 'EMP-042' },
                    { token: '{{employee.name}}', label: 'Employee Name', required: true, sample: 'Alex Mercer' },
                    { token: '{{employee.designation}}', label: 'Designation', required: true, sample: 'Lead Software Architect' },
                    { token: '{{employee.joiningDate}}', label: 'Joining Date', required: true, sample: '2023-04-10' },
                    { token: '{{exit.relievingDate}}', label: 'Relieving Date', required: true, sample: '2026-09-30' },
                    { token: '{{company.name}}', label: 'Company Legal Entity', required: true, sample: 'Kylrx Technologies Private Limited' },
                    { token: '{{signatory.name}}', label: 'Authorized Signatory', required: true, sample: 'Swati Khandelwal, VP of HR' }
                ],
                initialBody: `
<div class="doc-container">
    <div class="doc-header"><h2>{{company.name}}</h2><p>Certificate of Professional Experience</p></div>
    <div class="doc-body">
        <p>Date: {{date.today}}</p>
        <p>To Whom It May Concern,</p>
        <p>This is to certify that <strong>{{employee.name}}</strong> was engaged as a full-time employee with <strong>{{company.name}}</strong> from <strong>{{employee.joiningDate}}</strong> to <strong>{{exit.relievingDate}}</strong>.</p>
        <p>During their tenure, they held the position of <strong>{{employee.designation}}</strong>. Their conduct and dedication were found to be commendable throughout their service.</p>
        <div style="margin-top:30px;"><p>Authorized Signatory,</p><p><strong>{{signatory.name}}</strong><br>{{company.name}}</p></div>
    </div>
</div>`
            },

            // 10. Termination Letter
            {
                key: 'termination_letter',
                name: 'Termination Letter',
                description: 'Formal notification of contract severance pursuant to misconduct, performance deficit, or corporate restructuring.',
                category: 'Exit',
                permittedModules: ['exit', 'exit_offboarding', 'hr_admin'],
                fieldMappings: [
                    { token: '{{employee.code}}', label: 'Employee ID', required: true, sample: 'EMP-991' },
                    { token: '{{employee.name}}', label: 'Employee Name', required: true, sample: 'Vikram Batra' },
                    { token: '{{termination.reason}}', label: 'Termination Grounds', required: true, sample: 'Continued non-compliance with Code of Conduct policy' },
                    { token: '{{termination.effectiveDate}}', label: 'Effective Severance Date', required: true, sample: '2026-09-15' },
                    { token: '{{termination.severanceTerms}}', label: 'Severance Pay Terms', required: true, sample: '30 days salary in lieu of notice period' },
                    { token: '{{company.name}}', label: 'Company Legal Entity', required: true, sample: 'Kylrx Technologies Private Limited' },
                    { token: '{{signatory.name}}', label: 'Authorized Signatory', required: true, sample: 'Director of Human Capital' }
                ],
                initialBody: `
<div class="doc-container">
    <div class="doc-header"><h2>{{company.name}}</h2><p>Notice of Employment Termination</p></div>
    <div class="doc-body">
        <p>Date: {{date.today}}</p>
        <p>Dear <strong>{{employee.name}}</strong> ({{employee.code}}),</p>
        <p>This communication serves as formal notice that your employment with <strong>{{company.name}}</strong> is terminated effective <strong>{{termination.effectiveDate}}</strong>.</p>
        <p>Grounds: {{termination.reason}}</p>
        <p>Terms of Severance: {{termination.severanceTerms}}. You are instructed to surrender all company assets to IT clearance today.</p>
        <div style="margin-top:30px;"><p>For {{company.name}},</p><p><strong>{{signatory.name}}</strong></p></div>
    </div>
</div>`
            }
        ];

        // Seed each template with V1.0.0 Approved version
        standardDefinitions.forEach(def => {
            const v1 = {
                versionId: `${def.key}_v1.0.0`,
                versionNumber: '1.0.0',
                status: 'approved', // Pre-approved initial enterprise standard
                isActive: true,
                effectiveFrom: '2026-01-01T00:00:00.000Z',
                effectiveTo: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                createdBy: 'System Super Admin',
                approvedBy: 'Compliance Board',
                approvedAt: '2026-01-01T00:00:00.000Z',
                approvalRemarks: 'Standard corporate baseline approved.',
                changeNotes: 'Initial production baseline template.',
                templateBody: def.initialBody.trim(),
                fieldMappings: def.fieldMappings,
                sha256: this.computeHash(def.initialBody.trim())
            };

            this.templates.set(def.key, {
                key: def.key,
                name: def.name,
                description: def.description,
                category: def.category,
                permittedModules: def.permittedModules,
                versions: [v1],
                activeVersion: v1.versionNumber
            });
        });

        logger.info(`[DocumentTemplateEngine] Initialized with ${this.templates.size} standard document templates.`);
    }

    /**
     * Retrieve all template headers with current active version info
     */
    listTemplates() {
        const list = [];
        for (const [key, tpl] of this.templates.entries()) {
            const activeVer = tpl.versions.find(v => v.isActive && v.status === 'approved') || tpl.versions[0];
            list.push({
                key: tpl.key,
                name: tpl.name,
                description: tpl.description,
                category: tpl.category,
                permittedModules: tpl.permittedModules,
                activeVersion: activeVer ? activeVer.versionNumber : null,
                effectiveFrom: activeVer ? activeVer.effectiveFrom : null,
                totalVersions: tpl.versions.length,
                status: activeVer ? activeVer.status : 'draft',
                fieldMappings: activeVer ? activeVer.fieldMappings : [],
                versions: tpl.versions
            });
        }
        return list;
    }

    /**
     * Get single template with full version history and field mappings
     */
    getTemplate(key) {
        const tpl = this.templates.get(key);
        if (!tpl) {
            throw new Error(`Document template '${key}' not found.`);
        }
        return tpl;
    }

    /**
     * Resolve active, approved template version effective as of a given timestamp
     */
    resolveActiveTemplate(key, asOfDate = new Date().toISOString()) {
        const tpl = this.getTemplate(key);
        const asOf = new Date(asOfDate).getTime();

        // Filter approved versions whose effectiveFrom <= asOfDate and (effectiveTo is null or >= asOfDate)
        const eligible = tpl.versions.filter(v => {
            if (v.status !== 'approved') return false;
            const from = new Date(v.effectiveFrom).getTime();
            const to = v.effectiveTo ? new Date(v.effectiveTo).getTime() : Infinity;
            return from <= asOf && asOf <= to;
        });

        if (eligible.length === 0) {
            throw new Error(`No approved and effective template version found for '${key}' as of ${asOfDate}.`);
        }

        // Return most recent version
        eligible.sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime());
        return eligible[0];
    }

    /**
     * Create a new version of an existing template (Defaults to 'draft')
     */
    createTemplateVersion(key, { versionNumber, templateBody, effectiveFrom, changeNotes, createdBy = 'HR Admin', fieldMappings }) {
        const tpl = this.getTemplate(key);

        // Check if versionNumber already exists
        if (tpl.versions.some(v => v.versionNumber === versionNumber)) {
            throw new Error(`Version '${versionNumber}' already exists for template '${key}'.`);
        }

        const newVersion = {
            versionId: `${key}_v${versionNumber}`,
            versionNumber,
            status: 'draft',
            isActive: false,
            effectiveFrom: effectiveFrom || new Date().toISOString(),
            effectiveTo: null,
            createdAt: new Date().toISOString(),
            createdBy,
            approvedBy: null,
            approvedAt: null,
            approvalRemarks: '',
            changeNotes: changeNotes || 'Draft updates',
            templateBody: templateBody.trim(),
            fieldMappings: fieldMappings || tpl.versions[0]?.fieldMappings || [],
            sha256: this.computeHash(templateBody.trim())
        };

        tpl.versions.push(newVersion);
        this.templates.set(key, tpl);

        logger.info(`[DocumentTemplateEngine] New version ${versionNumber} created for template '${key}' (Status: draft).`);
        return newVersion;
    }

    /**
     * Approve a template version (State: approved, makes it active)
     */
    approveTemplateVersion(key, versionNumber, { approvedBy = 'HR Director', approvalRemarks = 'Approved' } = {}) {
        const tpl = this.getTemplate(key);
        const version = tpl.versions.find(v => v.versionNumber === versionNumber);

        if (!version) {
            throw new Error(`Version '${versionNumber}' not found for template '${key}'.`);
        }

        // Mark previously active versions inactive if effective dates overlap
        tpl.versions.forEach(v => {
            if (v.versionNumber !== versionNumber && v.isActive) {
                v.isActive = false;
            }
        });

        version.status = 'approved';
        version.isActive = true;
        version.approvedBy = approvedBy;
        version.approvedAt = new Date().toISOString();
        version.approvalRemarks = approvalRemarks;
        tpl.activeVersion = version.versionNumber;

        this.templates.set(key, tpl);
        logger.info(`[DocumentTemplateEngine] Version ${versionNumber} for template '${key}' approved by ${approvedBy}.`);
        return version;
    }

    /**
     * Check if a caller module is permitted to generate a given template
     * Prompt constraint: "No / limited actions, Yes, permitted modules"
     */
    isModulePermitted(templateKey, callerModule) {
        if (!callerModule) return false;
        if (callerModule === 'super_admin' || callerModule === 'hr_admin') return true;

        const tpl = this.templates.get(templateKey);
        if (!tpl) return false;

        return tpl.permittedModules.includes(callerModule);
    }

    /**
     * Interpolate employee tokens with payload values
     */
    interpolateTokens(templateHtml, dataContext = {}) {
        if (!templateHtml) return '';

        // Add standard system tokens
        const mergedContext = {
            date: {
                today: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
                isoToday: new Date().toISOString().split('T')[0]
            },
            company: {
                name: 'Kylrx Technologies Private Limited',
                taxId: 'CIN: U72200KA2024PTC189201'
            },
            ...dataContext
        };

        // Standardize common token aliases across domains
        if (mergedContext.payroll) {
            mergedContext.payroll.netSalary = mergedContext.payroll.netSalary || mergedContext.payroll.netPay;
            mergedContext.payroll.netPay = mergedContext.payroll.netPay || mergedContext.payroll.netSalary;
            mergedContext.payroll.monthYear = mergedContext.payroll.monthYear || `${mergedContext.payroll.month || ''} ${mergedContext.payroll.year || ''}`.trim();
        }
        if (mergedContext.payroll && !mergedContext.earnings) {
            mergedContext.earnings = {
                basic: mergedContext.payroll.basicSalary,
                hra: mergedContext.payroll.hra,
                specialAllowance: mergedContext.payroll.specialAllowance,
                gross: mergedContext.payroll.grossPay
            };
        }
        if (mergedContext.payroll && !mergedContext.deductions) {
            mergedContext.deductions = {
                pf: mergedContext.payroll.pfEmployee,
                tax: mergedContext.payroll.tds,
                total: mergedContext.payroll.totalDeductions
            };
        }
        if (mergedContext.fnf) {
            mergedContext.fnf.unpaidSalary = mergedContext.fnf.unpaidSalary || mergedContext.fnf.basicForFnf;
            mergedContext.fnf.leaveEncashment = mergedContext.fnf.leaveEncashment || mergedContext.fnf.earnedLeaveEncashment;
            mergedContext.fnf.recoveries = mergedContext.fnf.recoveries || mergedContext.fnf.loanDeductions;
        }

        return templateHtml.replace(/\{\{([^}]+)\}\}/g, (match, tokenPath) => {
            const path = tokenPath.trim();
            const parts = path.split('.');
            let current = mergedContext;

            for (const part of parts) {
                if (current && typeof current === 'object' && part in current) {
                    current = current[part];
                } else {
                    current = undefined;
                    break;
                }
            }

            if (current !== undefined && current !== null) {
                return String(current);
            }

            // Return original token or blank fallback
            return `[${path}]`;
        });
    }

    /**
     * Generate Document from Approved Template
     * Full Automation calls this method!
     */
    async generateDocument(templateKey, dataContext = {}, { callerModule = 'hr_admin', actor = 'Automation Pipeline', asOfDate = new Date().toISOString() } = {}) {
        // 1. Permission Gating
        if (!this.isModulePermitted(templateKey, callerModule)) {
            const errMsg = `Access Denied: Module '${callerModule}' is not permitted to generate template '${templateKey}'. Permitted: [${this.templates.get(templateKey)?.permittedModules.join(', ')}]`;
            logger.warn(`[DocumentTemplateEngine] 🚫 ${errMsg}`);
            throw new Error(errMsg);
        }

        // 2. Resolve Active Approved Version
        const activeVersion = this.resolveActiveTemplate(templateKey, asOfDate);
        if (activeVersion.status !== 'approved') {
            throw new Error(`Template '${templateKey}' version ${activeVersion.versionNumber} is '${activeVersion.status}' and cannot be used for generation.`);
        }

        // 3. Interpolate Tokens
        const renderedHtml = this.interpolateTokens(activeVersion.templateBody, dataContext);
        const docSha256 = this.computeHash(renderedHtml);

        // 4. Archive Generated Document Record
        const docId = `DOC_${templateKey.toUpperCase()}_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const recipientName = dataContext.employee?.name || dataContext.candidate?.name || 'Authorized Recipient';
        const recipientId = dataContext.employee?.code || dataContext.candidate?.id || 'N/A';

        const docRecord = {
            docId,
            templateKey,
            templateName: this.templates.get(templateKey)?.name,
            versionNumber: activeVersion.versionNumber,
            versionSha256: activeVersion.sha256,
            callerModule,
            generatedBy: actor,
            generatedAt: new Date().toISOString(),
            recipientName,
            recipientId,
            sha256: docSha256,
            renderedHtml,
            status: 'generated'
        };

        this.generatedDocuments.set(docId, docRecord);

        // 5. Record Immutable Stage 8 Audit Log in Automation Engine
        try {
            await automationEngine.recordAuditLog({
                runId: `doc-gen-${docId}`,
                ...(this.orgId ? { orgId: this.orgId } : {}),
                automationId: `document-template-engine`,
                stage: 'Document Generation',
                status: 'success',
                details: {
                    docId,
                    templateKey,
                    versionNumber: activeVersion.versionNumber,
                    callerModule,
                    recipientName,
                    recipientId,
                    sha256: docSha256
                }
            });
        } catch (e) {
            logger.warn(`[DocumentTemplateEngine] Audit log warning: ${e.message}`);
        }

        logger.info(`[DocumentTemplateEngine] ✅ Document '${docId}' generated via template '${templateKey}' (${activeVersion.versionNumber}) for ${recipientName}.`);
        return docRecord;
    }

    /**
     * Preview template with sample or custom context (Does not archive)
     */
    previewTemplate(templateKey, { versionNumber, dataContext = {} } = {}) {
        const tpl = this.getTemplate(templateKey);
        let version;
        if (versionNumber) {
            version = tpl.versions.find(v => v.versionNumber === versionNumber);
            if (!version) throw new Error(`Version '${versionNumber}' not found for template '${templateKey}'.`);
        } else {
            version = this.resolveActiveTemplate(templateKey);
        }

        // Build sample payload from fieldMappings if not provided
        const samplePayload = {};
        version.fieldMappings.forEach(m => {
            const parts = m.token.replace(/[{}]/g, '').trim().split('.');
            let curr = samplePayload;
            for (let i = 0; i < parts.length - 1; i++) {
                curr[parts[i]] = curr[parts[i]] || {};
                curr = curr[parts[i]];
            }
            curr[parts[parts.length - 1]] = m.sample;
        });

        const mergedPayload = { ...samplePayload, ...dataContext };
        const renderedHtml = this.interpolateTokens(version.templateBody, mergedPayload);

        return {
            templateKey,
            versionNumber: version.versionNumber,
            status: version.status,
            effectiveFrom: version.effectiveFrom,
            renderedHtml,
            samplePayload: mergedPayload
        };
    }

    /**
     * List generated documents
     */
    listGeneratedDocuments({ limit = 50, templateKey, recipientId } = {}) {
        let docs = Array.from(this.generatedDocuments.values());
        if (templateKey) {
            docs = docs.filter(d => d.templateKey === templateKey);
        }
        if (recipientId) {
            docs = docs.filter(d => d.recipientId === recipientId);
        }
        docs.sort((a, b) => new Date(b.generatedAt) - new Date(a.generatedAt));
        return docs.slice(0, limit);
    }

    /**
     * Get single generated document
     */
    getGeneratedDocument(docId) {
        const doc = this.generatedDocuments.get(docId);
        if (!doc) {
            throw new Error(`Generated document '${docId}' not found.`);
        }
        return doc;
    }
}

const orgEngines = new Map();

// Default instance (no company) for existing callers and tests; routes use documentTemplateEngine.forOrg(orgId)
const documentTemplateEngine = new DocumentTemplateEngine();
module.exports = documentTemplateEngine;
