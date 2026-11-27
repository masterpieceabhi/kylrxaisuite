const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Customisable Template Engine (Kylrx Enterprise Suite)
 * 
 * Requirement 1.2 Customisable Templates:
 * Each applicable module should provide a suitable template structure.
 * This gives users a consistent starting point while allowing permitted changes.
 * - Choose: Users can choose an existing template from their module.
 * - Create: Authorised users can create new templates.
 * - Edit: Users can edit permitted fields and instructions.
 * - Preview: A preview appears before saving.
 * - Draft / Publish: Templates can be saved as drafts or published.
 * - Permissions: Administrators can manage template permissions.
 * 
 * Requirement 1.3 Module-level templates:
 * - Each module should have a template relevant to its purpose.
 * - A shared template may be provided by an administrator.
 * - Managers may create personal copies where permissions allow.
 * - Template status & Expected behaviour:
 *     Draft: Editable; not available for general use.
 *     Published: Available to permitted users.
 *     Archived: Retained for history; unavailable for new use.
 * - Template changes should be versioned. Existing records should not change unexpectedly when a template is updated.
 */

class CustomTemplateEngine {
    // One engine per company (see forOrg): each company's templates, copies and versions are its own
    constructor(orgId = null) {
        this.orgId = orgId || null;
        this.templates = new Map();
        this.initializeStandardModuleTemplates();
    }

    /** This company's engine (created on first use) */
    forOrg(orgId) {
        if (!orgId) throw new Error('A company is required for custom templates.');
        if (!orgEngines.has(orgId)) orgEngines.set(orgId, new CustomTemplateEngine(orgId));
        return orgEngines.get(orgId);
    }

    generateId() {
        return `TPL-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    }

    generatePersonalId() {
        return `TPL-PERS-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    }

    computeHash(data) {
        return crypto.createHash('sha256').update(JSON.stringify(data || {})).digest('hex');
    }

    /**
     * Pre-seed standard shared templates across all core enterprise modules
     * PRD 1.3: "Each module should have a template relevant to its purpose. A shared template may be provided by an administrator."
     */
    initializeStandardModuleTemplates() {
        const seedTemplates = [
            // ==========================================
            // MODULE: GOALS (Manager & Team Goals)
            // ==========================================
            {
                id: 'TPL-GOAL-001',
                key: 'tpl_goal_zerotrust',
                name: 'Zero-Trust Infrastructure & Endpoint Hardening',
                module: 'goals',
                category: 'Cybersecurity & Compliance',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Pre-configured goal template for managers implementing enterprise zero-trust identity, mTLS, and automated endpoint telemetry.',
                instructions: 'Adjust the target compliance percentage, select target completion date, and customize department-specific milestone acceptance criteria.',
                permittedFields: [
                    { fieldKey: 'title', label: 'Goal Title', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Zero-Trust Architecture & Threat Hardening', instructions: 'Customize the goal title if needed for your unit.' },
                    { fieldKey: 'outcome', label: 'Desired Outcome Statement', type: 'textarea', isPermittedToEdit: true, isRequired: true, defaultValue: 'Achieve zero security breaches and reach 99.99% compliant network infrastructure across all enterprise endpoints.', instructions: 'Describe the high-impact strategic result.' },
                    { fieldKey: 'target', label: 'Target Compliance Metric', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 99.9, instructions: 'Specify the target numerical value (e.g. 99.9).' },
                    { fieldKey: 'unit', label: 'Measurement Unit', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: '% Compliance', instructions: 'Unit of measurement (e.g., %, Milestones, Hours).' },
                    { fieldKey: 'completionCriteria', label: 'Completion Criteria', type: 'textarea', isPermittedToEdit: true, isRequired: true, defaultValue: 'All regional nodes pass automated vulnerability scanners and have mTLS authentication active.', instructions: 'Explicit definition of done for this goal.' },
                    { fieldKey: 'targetCompletionDate', label: 'Target Completion Date', type: 'date', isPermittedToEdit: true, isRequired: true, defaultValue: '2026-12-15', instructions: 'Expected deadline for 100% completion.' },
                    { fieldKey: 'departmentCode', label: 'Department Unit Code', type: 'text', isPermittedToEdit: false, isRequired: true, defaultValue: 'UNIT-CYB-802', instructions: 'Locked to active department unit code.' }
                ],
                lockedFields: ['departmentCode', 'module'],
                structure: {
                    defaultTitle: 'Zero-Trust Architecture & Threat Hardening',
                    defaultOutcome: 'Achieve zero security breaches and reach 99.99% compliant network infrastructure across all enterprise endpoints.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 99.9,
                    defaultUnit: '% Compliance',
                    defaultMilestones: [
                        { id: 'm1', title: 'Complete IAM zero-trust policy matrix', targetOffsetDays: 14, completed: false },
                        { id: 'm2', title: 'Deploy mTLS certificate rotations to microservices', targetOffsetDays: 30, completed: false },
                        { id: 'm3', title: 'Enforce MFA on internal admin jump hosts', targetOffsetDays: 45, completed: false },
                        { id: 'm4', title: 'Conduct external penetration audit and remediation', targetOffsetDays: 60, completed: false }
                    ]
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['goals', 'pms', 'hr_admin'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin', 'manager'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'Super Admin',
                createdAt: '2026-01-10T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-01-15T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_goal_001',
                        status: 'published',
                        effectiveFrom: '2026-01-15',
                        structure: {
                            defaultTitle: 'Zero-Trust Architecture & Threat Hardening',
                            defaultOutcome: 'Achieve zero security breaches and reach 99.99% compliant network infrastructure across all enterprise endpoints.',
                            defaultTarget: 99.9,
                            defaultUnit: '% Compliance'
                        },
                        instructions: 'Adjust the target compliance percentage, select target completion date, and customize department-specific milestone acceptance criteria.',
                        changeNotes: 'Initial standard shared template approved and published by Super Admin.',
                        createdBy: 'Super Admin',
                        createdAt: '2026-01-15T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-01-10T00:00:00.000Z', actor: 'Super Admin', action: 'created', notes: 'Initial shared system template created.' },
                    { timestamp: '2026-01-15T00:00:00.000Z', actor: 'Super Admin', action: 'published', notes: 'Published for all department managers.' }
                ]
            },
            {
                id: 'TPL-GOAL-002',
                key: 'tpl_goal_okr_delivery',
                name: 'Quarterly Sprint & Milestone Delivery OKR',
                module: 'goals',
                category: 'Operational Excellence',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Milestone-based operational goal template for tracking quarterly deliverables, code releases, or project phases.',
                instructions: 'Define the target milestone deliverables, set the milestone completion dates, and establish binary acceptance criteria.',
                permittedFields: [
                    { fieldKey: 'title', label: 'Goal Title', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Quarterly Sprint Deliverables Execution', instructions: 'Title of the quarterly initiative.' },
                    { fieldKey: 'outcome', label: 'Outcome Statement', type: 'textarea', isPermittedToEdit: true, isRequired: true, defaultValue: 'Deliver 100% of committed Q4 architecture releases on schedule with zero critical blocker regressions.', instructions: 'Clear outcome statement.' },
                    { fieldKey: 'target', label: 'Total Milestones Target', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 4, instructions: 'Count of critical delivery milestones.' },
                    { fieldKey: 'unit', label: 'Unit', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Milestones', instructions: 'Measurement unit.' },
                    { fieldKey: 'targetCompletionDate', label: 'Quarterly End Date', type: 'date', isPermittedToEdit: true, isRequired: true, defaultValue: '2026-12-31', instructions: 'Final delivery cutoff date.' }
                ],
                lockedFields: ['module'],
                structure: {
                    defaultTitle: 'Quarterly Sprint Deliverables Execution',
                    defaultOutcome: 'Deliver 100% of committed Q4 architecture releases on schedule with zero critical blocker regressions.',
                    measurementMethod: 'milestone',
                    defaultTarget: 4,
                    defaultUnit: 'Milestones',
                    defaultMilestones: [
                        { id: 'm1', title: 'Sprint Backlog Grooming & Resource Allocation', targetOffsetDays: 7, completed: false },
                        { id: 'm2', title: 'Alpha Release & Integration Sandbox Testing', targetOffsetDays: 30, completed: false },
                        { id: 'm3', title: 'Beta Staging Deployment & UAT Sign-off', targetOffsetDays: 60, completed: false },
                        { id: 'm4', title: 'Production Go-Live and Telemetry Verification', targetOffsetDays: 90, completed: false }
                    ]
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['goals', 'pms'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin', 'manager'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'Super Admin',
                createdAt: '2026-01-10T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-01-15T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_goal_002',
                        status: 'published',
                        effectiveFrom: '2026-01-15',
                        changeNotes: 'Initial standard shared OKR template provided by administrator.',
                        createdBy: 'Super Admin',
                        createdAt: '2026-01-15T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-01-10T00:00:00.000Z', actor: 'Super Admin', action: 'created', notes: 'Standard OKR delivery template seeded.' }
                ]
            },
            {
                id: 'TPL-GOAL-003',
                key: 'tpl_goal_incident_sla',
                name: 'Incident Response MTTR Reduction (SLA)',
                module: 'goals',
                category: 'Operational Excellence',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Operational goal for reducing mean time to resolve (MTTR) system alerts, bug tickets, or customer escalations.',
                instructions: 'Set the target minutes, define the escalation playbook, and record review intervals.',
                permittedFields: [
                    { fieldKey: 'title', label: 'Goal Title', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Incident Response MTTR Reduction Under 15 Minutes', instructions: 'Goal Title' },
                    { fieldKey: 'outcome', label: 'Outcome Statement', type: 'textarea', isPermittedToEdit: true, isRequired: true, defaultValue: 'Average MTTR dropped to less than 15 minutes for critical P1/P2 operational anomalies.', instructions: 'Outcome' },
                    { fieldKey: 'target', label: 'Target MTTR (Minutes)', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 15, instructions: 'Target minutes' },
                    { fieldKey: 'unit', label: 'Unit', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Minutes MTTR', instructions: 'Unit' }
                ],
                lockedFields: ['module'],
                structure: {
                    defaultTitle: 'Incident Response MTTR Reduction Under 15 Minutes',
                    defaultOutcome: 'Average MTTR dropped to less than 15 minutes for critical P1/P2 operational anomalies.',
                    measurementMethod: 'unit',
                    defaultTarget: 15,
                    defaultUnit: 'Minutes MTTR',
                    defaultMilestones: [
                        { id: 'm1', title: 'Audit historical incident triage bottlenecks', targetOffsetDays: 10, completed: false },
                        { id: 'm2', title: 'Implement automated on-call paging webhooks', targetOffsetDays: 25, completed: false },
                        { id: 'm3', title: 'Complete 3 simulated incident response dry runs', targetOffsetDays: 45, completed: false }
                    ]
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['goals', 'pms'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin', 'manager'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'Super Admin',
                createdAt: '2026-02-01T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-02-05T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_goal_003',
                        status: 'published',
                        effectiveFrom: '2026-02-05',
                        changeNotes: 'MTTR shared template approved by administrator.',
                        createdBy: 'Super Admin',
                        createdAt: '2026-02-05T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-02-01T00:00:00.000Z', actor: 'Super Admin', action: 'created', notes: 'MTTR template created.' }
                ]
            },
            {
                id: 'TPL-GOAL-004',
                key: 'tpl_goal_team_upskill',
                name: 'Team Capability & Technical Certification Plan',
                module: 'goals',
                category: 'Team Development',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Capability development template enabling managers to sponsor and track professional certifications across team members.',
                instructions: 'Enter total targeted credentials, assign mentors, and schedule milestone examinations.',
                permittedFields: [
                    { fieldKey: 'title', label: 'Goal Title', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Team Technical Capability & Certification Sponsorship', instructions: 'Goal Title' },
                    { fieldKey: 'target', label: 'Target Certifications Count', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 5, instructions: 'Target Count' },
                    { fieldKey: 'unit', label: 'Unit', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Certifications', instructions: 'Unit' }
                ],
                lockedFields: ['module'],
                structure: {
                    defaultTitle: 'Team Technical Capability & Certification Sponsorship',
                    defaultOutcome: 'Enhance departmental capabilities by graduating team leads with industry certifications.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 5,
                    defaultUnit: 'Certifications',
                    defaultMilestones: [
                        { id: 'm1', title: 'Procure certification vouchers & learning tracks', targetOffsetDays: 14, completed: false },
                        { id: 'm2', title: 'Complete peer-led preparation bootcamps', targetOffsetDays: 45, completed: false },
                        { id: 'm3', title: 'Achieve passing score transcripts', targetOffsetDays: 90, completed: false }
                    ]
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['goals', 'pms'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin', 'manager'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'HR Director',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-03-05T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_goal_004',
                        status: 'published',
                        effectiveFrom: '2026-03-05',
                        changeNotes: 'Team certification plan shared template.',
                        createdBy: 'HR Director',
                        createdAt: '2026-03-05T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-03-01T00:00:00.000Z', actor: 'HR Director', action: 'created', notes: 'Team upskill template.' }
                ]
            },

            // ==========================================
            // MODULE: ONBOARDING
            // ==========================================
            {
                id: 'TPL-ONB-001',
                key: 'tpl_onboard_executive',
                name: 'Executive & Senior Lead Onboarding Roadmap',
                module: 'onboarding',
                category: 'Onboarding',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Structured onboarding milestone template for incoming department managers and senior engineers.',
                instructions: 'Permitted fields include mentor assignment, start date, and 30-60-90 day KPI checkpoints. Company policy clauses remain locked.',
                permittedFields: [
                    { fieldKey: 'candidateName', label: 'Candidate Full Name', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'New Hire', instructions: 'Candidate name' },
                    { fieldKey: 'mentorName', label: 'Assigned Executive Mentor', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'John Doe', instructions: 'Assigned Mentor' },
                    { fieldKey: 'joiningDate', label: 'First Day of Employment', type: 'date', isPermittedToEdit: true, isRequired: true, defaultValue: '2026-11-01', instructions: 'Start date' },
                    { fieldKey: 'probationPeriodMonths', label: 'Probation Duration (Months)', type: 'number', isPermittedToEdit: false, isRequired: true, defaultValue: 3, instructions: 'Locked by enterprise HR policy.' }
                ],
                lockedFields: ['probationPeriodMonths', 'module'],
                structure: {
                    defaultTitle: 'Executive Induction Protocol',
                    bodyTemplate: `
<div class="onboard-doc">
    <h3>Executive Induction Protocol — {{candidateName}}</h3>
    <p>Mentor Assigned: <strong>{{mentorName}}</strong> | Effective Start Date: <strong>{{joiningDate}}</strong></p>
    <ul>
        <li>Day 1: Security credential issuance & zero-trust key provisioning</li>
        <li>Day 14: Department architecture briefing & roadmap alignment</li>
        <li>Day 30: Initial milestone review with Manager</li>
        <li>Day 90: Formal probationary confirmation assessment</li>
    </ul>
</div>`
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['onboarding', 'hr_admin'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'HR Operations',
                createdAt: '2026-02-10T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-02-12T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_onb_001',
                        status: 'published',
                        effectiveFrom: '2026-02-12',
                        changeNotes: 'Initial onboarding roadmap template published by admin.',
                        createdBy: 'HR Operations',
                        createdAt: '2026-02-12T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-02-10T00:00:00.000Z', actor: 'HR Operations', action: 'created', notes: 'Created onboarding roadmap template.' }
                ]
            },

            // ==========================================
            // MODULE: LIFECYCLE (Promotions, Transfers)
            // ==========================================
            {
                id: 'TPL-LIF-001',
                key: 'tpl_lifecycle_promotion',
                name: 'Merit Promotion & Band Advancement Template',
                module: 'lifecycle',
                category: 'Employee Lifecycle',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Formal career progression and designation promotion recommendation template.',
                instructions: 'Managers can edit new job title, justification summary, and target effective date. Band salary scales remain locked by compensation rules.',
                permittedFields: [
                    { fieldKey: 'employeeName', label: 'Employee Name', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Jane Smith', instructions: 'Employee Name' },
                    { fieldKey: 'newDesignation', label: 'Promoted Designation', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Lead Security Engineer', instructions: 'New title' },
                    { fieldKey: 'effectiveDate', label: 'Promotion Effective Date', type: 'date', isPermittedToEdit: true, isRequired: true, defaultValue: '2026-11-01', instructions: 'Effective date' },
                    { fieldKey: 'justification', label: 'Performance Justification', type: 'textarea', isPermittedToEdit: true, isRequired: true, defaultValue: 'Consistently exceeded sprint metrics and led SOC2 readiness initiative.', instructions: 'Rationale' },
                    { fieldKey: 'corporateEntity', label: 'Legal Employer Entity', type: 'text', isPermittedToEdit: false, isRequired: true, defaultValue: 'Kylrx Technologies Private Limited', instructions: 'Locked corporate entity.' }
                ],
                lockedFields: ['corporateEntity', 'module'],
                structure: {
                    defaultTitle: 'Notice of Merit Promotion',
                    bodyTemplate: `
<div class="lifecycle-doc">
    <h3>Notice of Merit Promotion</h3>
    <p>We are thrilled to announce the promotion of <strong>{{employeeName}}</strong> to <strong>{{newDesignation}}</strong> effective <strong>{{effectiveDate}}</strong>.</p>
    <p><strong>Manager Justification:</strong> {{justification}}</p>
    <p>Issued by {{corporateEntity}}.</p>
</div>`
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['lifecycle', 'hr_admin', 'pms'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'HR Admin',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-03-05T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_lif_001',
                        status: 'published',
                        effectiveFrom: '2026-03-05',
                        changeNotes: 'Shared merit promotion template initialized by administrator.',
                        createdBy: 'HR Admin',
                        createdAt: '2026-03-05T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-03-01T00:00:00.000Z', actor: 'HR Admin', action: 'created', notes: 'Seeded promotion template.' }
                ]
            },

            // ==========================================
            // MODULE: EXIT / OFFBOARDING
            // ==========================================
            {
                id: 'TPL-EXT-001',
                key: 'tpl_exit_handover',
                name: 'Departmental Knowledge Handover & Asset Return',
                module: 'exit',
                category: 'Exit Operations',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Manager clearance checklist for departing personnel verifying repository access revocation and hardware return.',
                instructions: 'Managers customize the designated successor and project handover dates. Statutory clearance checkboxes remain immutable.',
                permittedFields: [
                    { fieldKey: 'employeeName', label: 'Departing Employee', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Alex Vance', instructions: 'Departing employee' },
                    { fieldKey: 'successorName', label: 'Knowledge Transfer Successor', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'John Doe', instructions: 'Assigned successor' },
                    { fieldKey: 'lastWorkingDay', label: 'Last Working Day', type: 'date', isPermittedToEdit: true, isRequired: true, defaultValue: '2026-11-15', instructions: 'Final date' },
                    { fieldKey: 'statutoryNoticePeriod', label: 'Statutory Notice Requirement', type: 'text', isPermittedToEdit: false, isRequired: true, defaultValue: '60 Calendar Days', instructions: 'Locked by legal compliance.' }
                ],
                lockedFields: ['statutoryNoticePeriod', 'module'],
                structure: {
                    defaultTitle: 'Department Handover Sign-off',
                    bodyTemplate: `
<div class="exit-doc">
    <h3>Department Handover Sign-off — {{employeeName}}</h3>
    <p>Successor: <strong>{{successorName}}</strong> | Last Working Day: <strong>{{lastWorkingDay}}</strong></p>
    <p>Mandatory Notice: {{statutoryNoticePeriod}} (Verified).</p>
</div>`
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['exit', 'hr_admin'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'Exit Ops',
                createdAt: '2026-04-01T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-04-05T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_ext_001',
                        status: 'published',
                        effectiveFrom: '2026-04-05',
                        changeNotes: 'Shared exit handover template provided by administrator.',
                        createdBy: 'Exit Ops',
                        createdAt: '2026-04-05T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-04-01T00:00:00.000Z', actor: 'Exit Ops', action: 'created', notes: 'Created exit handover template.' }
                ]
            },

            // ==========================================
            // MODULE: ATTENDANCE
            // ==========================================
            {
                id: 'TPL-ATT-001',
                key: 'tpl_att_roster_regularization',
                name: 'Shift Roster Scheduling & Regularization Policy Template',
                module: 'attendance',
                category: 'Attendance Operations',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Departmental template for managing shifts, grace periods, biometric regularizations, and on-duty approvals.',
                instructions: 'Managers customize shift grace minutes and maximum regularization allowances per month.',
                permittedFields: [
                    { fieldKey: 'shiftName', label: 'Shift Name', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'General Morning Shift (SH_GEN_01)', instructions: 'Target shift name' },
                    { fieldKey: 'gracePeriodMinutes', label: 'Grace Period (Minutes)', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 15, instructions: 'Allowed late punch grace period' },
                    { fieldKey: 'maxMonthlyRegularizations', label: 'Max Regularizations / Month', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 3, instructions: 'Allowed manual regularizations' },
                    { fieldKey: 'statutoryMaxDailyHours', label: 'Statutory Max Daily Work Hours', type: 'number', isPermittedToEdit: false, isRequired: true, defaultValue: 9, instructions: 'Locked by Factories Act and Shops & Establishment laws.' }
                ],
                lockedFields: ['statutoryMaxDailyHours', 'module'],
                structure: {
                    defaultTitle: 'Department Attendance & Shift Policy',
                    defaultOutcome: 'Maintain 98% on-time attendance and prompt regularization resolution within 48 hours.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 98,
                    defaultUnit: '% On-time',
                    defaultMilestones: [
                        { id: 'm1', title: 'Publish shift roster for following calendar month', targetOffsetDays: 25, completed: false },
                        { id: 'm2', title: 'Review and approve pending regularizations before pay-period lock', targetOffsetDays: 30, completed: false }
                    ]
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['attendance', 'hr_admin'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'HR Operations Admin',
                createdAt: '2026-04-10T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-04-12T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_att_001',
                        status: 'published',
                        effectiveFrom: '2026-04-12',
                        changeNotes: 'Shared attendance template provided by administrator.',
                        createdBy: 'HR Operations Admin',
                        createdAt: '2026-04-12T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-04-10T00:00:00.000Z', actor: 'HR Operations Admin', action: 'created', notes: 'Created attendance roster template.' }
                ]
            },

            // ==========================================
            // MODULE: LEAVE & TIME OFF
            // ==========================================
            {
                id: 'TPL-LEV-001',
                key: 'tpl_leave_allocation_compoff',
                name: 'Annual Leave Quota & Compensatory Off Allocation Template',
                module: 'leave',
                category: 'Leave & Time Off',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Standard template for annual earned leave allocations, sick leave accruals, and compensatory off approval workflows.',
                instructions: 'Adjust team leave overlap thresholds and compensatory off validity periods.',
                permittedFields: [
                    { fieldKey: 'leavePolicyName', label: 'Policy Title', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Standard Tech Engineering Leave Quota', instructions: 'Policy Name' },
                    { fieldKey: 'maxConcurrentTeamLeavePercent', label: 'Max Concurrent Out-of-Office %', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 25, instructions: 'Maximum % of team on leave simultaneously' },
                    { fieldKey: 'compOffExpiryDays', label: 'Comp-Off Expiry Duration (Days)', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 60, instructions: 'Days to utilize earned comp-off' },
                    { fieldKey: 'maternityLeaveStatutoryWeeks', label: 'Statutory Maternity Leave Duration (Weeks)', type: 'number', isPermittedToEdit: false, isRequired: true, defaultValue: 26, instructions: 'Locked by Maternity Benefit Act.' }
                ],
                lockedFields: ['maternityLeaveStatutoryWeeks', 'module'],
                structure: {
                    defaultTitle: 'Leave Quota and Approval Governance',
                    defaultOutcome: 'Zero staffing coverage gaps during peak sprint releases.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 100,
                    defaultUnit: '% Coverage'
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['leave', 'hr_admin'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'Super Admin',
                createdAt: '2026-05-01T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-05-05T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_lev_001',
                        status: 'published',
                        effectiveFrom: '2026-05-05',
                        changeNotes: 'Shared leave template provided by administrator.',
                        createdBy: 'Super Admin',
                        createdAt: '2026-05-05T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-05-01T00:00:00.000Z', actor: 'Super Admin', action: 'created', notes: 'Created leave governance template.' }
                ]
            },

            // ==========================================
            // MODULE: PAYROLL
            // ==========================================
            {
                id: 'TPL-PAY-001',
                key: 'tpl_payroll_disbursement_audit',
                name: 'Monthly Payroll Processing & Statutory Deductions Audit',
                module: 'payroll',
                category: 'Payroll & Finance',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Pre-disbursement audit checklist verifying gross wage calculations, PF, ESIC, PT deductions, and bank payouts.',
                instructions: 'Finance managers customize disbursement target dates and audit reconciliation sign-offs.',
                permittedFields: [
                    { fieldKey: 'payrollCycleMonth', label: 'Payroll Cycle Month/Year', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'October 2026', instructions: 'Target payroll cycle' },
                    { fieldKey: 'disbursementTargetDate', label: 'Disbursement Target Date', type: 'date', isPermittedToEdit: true, isRequired: true, defaultValue: '2026-10-31', instructions: 'Salary credit target date' },
                    { fieldKey: 'pfStatutoryRatePercent', label: 'Employee PF Statutory Rate', type: 'number', isPermittedToEdit: false, isRequired: true, defaultValue: 12, instructions: 'Locked by EPFO regulations.' }
                ],
                lockedFields: ['pfStatutoryRatePercent', 'module'],
                structure: {
                    defaultTitle: 'Monthly Payroll Processing & Statutory Deductions Audit',
                    defaultOutcome: '100% on-time salary credit with zero statutory calculation variance.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 100,
                    defaultUnit: '% Accuracy'
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['payroll', 'hr_admin'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'Finance Director',
                createdAt: '2026-05-10T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-05-15T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_pay_001',
                        status: 'published',
                        effectiveFrom: '2026-05-15',
                        changeNotes: 'Shared payroll audit template approved by administrator.',
                        createdBy: 'Finance Director',
                        createdAt: '2026-05-15T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-05-10T00:00:00.000Z', actor: 'Finance Director', action: 'created', notes: 'Created payroll audit template.' }
                ]
            },

            // ==========================================
            // MODULE: PMS (Performance Management System)
            // ==========================================
            {
                id: 'TPL-PMS-001',
                key: 'tpl_pms_quarterly_review',
                name: 'Quarterly Performance Appraisal & 360 Review Template',
                module: 'pms',
                category: 'Performance Management',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Manager appraisal scorecard covering deliverables, competencies, self-assessment, and L1/L2 calibration sign-offs.',
                instructions: 'Managers customize the weighting between OKR deliverables and behavioral core values.',
                permittedFields: [
                    { fieldKey: 'cycleName', label: 'Evaluation Period', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'FY26-Q3 Performance Review', instructions: 'Cycle identifier' },
                    { fieldKey: 'deliverableWeightPercent', label: 'OKR / Deliverables Weight %', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 70, instructions: 'Deliverables percentage' },
                    { fieldKey: 'competencyWeightPercent', label: 'Values & Competencies Weight %', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 30, instructions: 'Competencies percentage' },
                    { fieldKey: 'ratingScale', label: 'Rating Scale Standard', type: 'text', isPermittedToEdit: false, isRequired: true, defaultValue: '1-to-5 Calibrated Bell Curve', instructions: 'Locked by enterprise talent policy.' }
                ],
                lockedFields: ['ratingScale', 'module'],
                structure: {
                    defaultTitle: 'Quarterly Performance Appraisal & 360 Review',
                    defaultOutcome: '100% completed manager reviews and developmental feedback delivered before cycle close.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 100,
                    defaultUnit: '% Appraisals Completed'
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['pms', 'goals', 'hr_admin'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'Talent Management Admin',
                createdAt: '2026-06-01T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-06-05T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_pms_001',
                        status: 'published',
                        effectiveFrom: '2026-06-05',
                        changeNotes: 'Shared PMS appraisal scorecard approved by administrator.',
                        createdBy: 'Talent Management Admin',
                        createdAt: '2026-06-05T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-06-01T00:00:00.000Z', actor: 'Talent Management Admin', action: 'created', notes: 'Created PMS review template.' }
                ]
            },

            // ==========================================
            // MODULE: RECRUITMENT
            // ==========================================
            {
                id: 'TPL-REC-001',
                key: 'tpl_recruitment_rubric',
                name: 'Candidate Technical Assessment & Scoring Rubric Template',
                module: 'recruitment',
                category: 'Recruitment & Talent',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Structured interview assessment scorecard with standardized criteria for engineering coding, architecture, and behavioral rounds.',
                instructions: 'Hiring managers customize technical topics, question sets, and minimum passing threshold.',
                permittedFields: [
                    { fieldKey: 'jobRole', label: 'Target Job Position', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Senior Distributed Systems Engineer', instructions: 'Job title' },
                    { fieldKey: 'minimumPassingScore', label: 'Minimum Passing Threshold (%)', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 80, instructions: 'Passing score percentage' },
                    { fieldKey: 'eeoComplianceGuarantee', label: 'EEO / Anti-Bias Compliance Clause', type: 'text', isPermittedToEdit: false, isRequired: true, defaultValue: 'Strict adherence to Equal Employment Opportunity and non-discriminatory hiring guidelines.', instructions: 'Locked by legal compliance.' }
                ],
                lockedFields: ['eeoComplianceGuarantee', 'module'],
                structure: {
                    defaultTitle: 'Candidate Technical Assessment & Interview Rubric',
                    defaultOutcome: 'Consistent, objective hiring decisions with zero interview bias.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 80,
                    defaultUnit: 'Score %'
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['recruitment', 'hr_admin'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'Talent Acquisition Lead',
                createdAt: '2026-06-15T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-06-20T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_rec_001',
                        status: 'published',
                        effectiveFrom: '2026-06-20',
                        changeNotes: 'Shared recruitment rubric template provided by administrator.',
                        createdBy: 'Talent Acquisition Lead',
                        createdAt: '2026-06-20T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-06-15T00:00:00.000Z', actor: 'Talent Acquisition Lead', action: 'created', notes: 'Created recruitment rubric template.' }
                ]
            },

            // ==========================================
            // MODULE: COMPLIANCE (Demonstrates allowPersonalCopies: false)
            // ==========================================
            {
                id: 'TPL-CMP-001',
                key: 'tpl_compliance_statutory_audit',
                name: 'Statutory Master Filing & Compliance Audit Checklist Template',
                module: 'compliance',
                category: 'Statutory Compliance',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Strict legal master checklist for monthly EPFO ECR, ESIC challan, PT return, and LWF reconciliation filings.',
                instructions: 'Statutory filing checklist governed directly by legal and chief compliance officer. Modifications prohibited.',
                permittedFields: [
                    { fieldKey: 'filingMonth', label: 'Filing Period', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'October 2026', instructions: 'Statutory month' },
                    { fieldKey: 'complianceOfficerSignoff', label: 'Compliance Officer Full Name', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Nandan Rao', instructions: 'Signing officer' },
                    { fieldKey: 'statutoryDueDateEPFO', label: 'EPFO Filing Due Date', type: 'text', isPermittedToEdit: false, isRequired: true, defaultValue: '15th of Subsequent Month', instructions: 'Strict statutory legal requirement.' }
                ],
                lockedFields: ['statutoryDueDateEPFO', 'module'],
                structure: {
                    defaultTitle: 'Statutory Master Filing & Compliance Audit Checklist',
                    defaultOutcome: 'Zero late filing penalties and 100% certified statutory challan reconciliation.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 100,
                    defaultUnit: '% Reconciled'
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: false, // Strict compliance: personal copies are explicitly disallowed!
                    canCreatePersonalCopies: [],
                    permittedRoles: ['super_admin', 'hr_admin'],
                    permittedModules: ['compliance', 'hr_admin'],
                    canEditPermittedFields: ['super_admin', 'hr_admin'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'Chief Compliance Officer',
                createdAt: '2026-07-01T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-07-05T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_cmp_001',
                        status: 'published',
                        effectiveFrom: '2026-07-05',
                        changeNotes: 'Official statutory compliance audit master template.',
                        createdBy: 'Chief Compliance Officer',
                        createdAt: '2026-07-05T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-07-01T00:00:00.000Z', actor: 'Chief Compliance Officer', action: 'created', notes: 'Created statutory compliance template.' }
                ]
            },

            // ==========================================
            // MODULE: POLICY
            // ==========================================
            {
                id: 'TPL-POL-001',
                key: 'tpl_policy_security_sop',
                name: 'Corporate Information Security & Acceptable Use Policy Template',
                module: 'policy',
                category: 'Corporate Governance',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Enterprise standard for acceptable device use, clean desk protocols, VPN connection standards, and cryptographic key custody.',
                instructions: 'Managers customize team-specific data retention exceptions while master enterprise security clauses remain locked.',
                permittedFields: [
                    { fieldKey: 'policyTitle', label: 'Policy Title', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'Department Information Security & Cyber Hygiene SOP', instructions: 'Policy title' },
                    { fieldKey: 'logRetentionDays', label: 'Local Telemetry Retention (Days)', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 365, instructions: 'Retention period' },
                    { fieldKey: 'enterpriseMasterEntity', label: 'Governing Entity', type: 'text', isPermittedToEdit: false, isRequired: true, defaultValue: 'Kylrx Technologies Group', instructions: 'Locked corporate entity.' }
                ],
                lockedFields: ['enterpriseMasterEntity', 'module'],
                structure: {
                    defaultTitle: 'Information Security & Cyber Hygiene SOP',
                    defaultOutcome: '100% employee policy acknowledgement and zero policy violations.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 100,
                    defaultUnit: '% Acknowledged'
                },
                status: 'published',
                version: 'v1.0',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['policy', 'hr_admin'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'CISO Office',
                createdAt: '2026-07-10T00:00:00.000Z',
                updatedAt: '2026-10-18T00:00:00.000Z',
                publishedAt: '2026-07-15T00:00:00.000Z',
                versions: [
                    {
                        versionNumber: 'v1.0',
                        versionId: 'ver_init_pol_001',
                        status: 'published',
                        effectiveFrom: '2026-07-15',
                        changeNotes: 'Shared corporate security policy template provided by administrator.',
                        createdBy: 'CISO Office',
                        createdAt: '2026-07-15T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-07-10T00:00:00.000Z', actor: 'CISO Office', action: 'created', notes: 'Created security policy template.' }
                ]
            },

            // ==========================================
            // DRAFT TEMPLATE EXAMPLE (Demonstrates Draft state)
            // PRD 1.3: "Draft: Editable; not available for general use."
            // ==========================================
            {
                id: 'TPL-GOAL-DRAFT-001',
                key: 'tpl_goal_ai_automation',
                name: 'AI Agent Deployment & Process Automation Draft',
                module: 'goals',
                category: 'Innovation',
                scope: 'shared',
                isShared: true,
                providedByAdmin: false,
                description: 'Emerging template for rolling out autonomous agentic triage workflows across regional desks.',
                instructions: 'Draft template currently under review by enterprise architecture council.',
                permittedFields: [
                    { fieldKey: 'title', label: 'Goal Title', type: 'text', isPermittedToEdit: true, isRequired: true, defaultValue: 'AI Agent Deployment in Core Triage', instructions: 'Draft title' },
                    { fieldKey: 'target', label: 'Target Automated Workflows', type: 'number', isPermittedToEdit: true, isRequired: true, defaultValue: 10, instructions: 'Workflow count' }
                ],
                lockedFields: ['module'],
                structure: {
                    defaultTitle: 'AI Agent Deployment in Core Triage',
                    defaultOutcome: 'Automate 10 manual HR and security tickets via verified agentic workflows.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 10,
                    defaultUnit: 'Workflows',
                    defaultMilestones: [
                        { id: 'm1', title: 'Security sandbox compliance certification', targetOffsetDays: 14, completed: false }
                    ]
                },
                status: 'draft',
                version: 'v0.9-draft',
                permissions: {
                    allowPersonalCopies: true,
                    canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                    permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                    permittedModules: ['goals', 'pms'],
                    canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                    canCreateNewTemplate: ['super_admin', 'hr_admin', 'manager'],
                    canPublish: ['super_admin', 'hr_admin'],
                    canManagePermissions: ['super_admin', 'hr_admin']
                },
                createdBy: 'John Doe (Manager)',
                ownerId: 'MGR-JOHN-DOE',
                createdAt: '2026-10-17T12:00:00.000Z',
                updatedAt: '2026-10-17T12:00:00.000Z',
                publishedAt: null,
                versions: [
                    {
                        versionNumber: 'v0.9-draft',
                        versionId: 'ver_init_draft_001',
                        status: 'draft',
                        effectiveFrom: null,
                        changeNotes: 'Initial working draft.',
                        createdBy: 'John Doe (Manager)',
                        createdAt: '2026-10-17T12:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2026-10-17T12:00:00.000Z', actor: 'John Doe (Manager)', action: 'saved_as_draft', notes: 'Initial draft saved for review.' }
                ]
            },

            // ==========================================
            // ARCHIVED TEMPLATE EXAMPLE (Demonstrates Archived state)
            // PRD 1.3: "Archived: Retained for history; unavailable for new use."
            // ==========================================
            {
                id: 'TPL-LEGACY-001',
                key: 'tpl_legacy_manual_attendance',
                name: 'Legacy Manual Attendance Register Protocol (Superseded)',
                module: 'attendance',
                category: 'Legacy Governance',
                scope: 'shared',
                isShared: true,
                providedByAdmin: true,
                description: 'Physical paper-based attendance muster roll verification protocol used prior to biometric/GPS system rollout.',
                instructions: 'ARCHIVED SYSTEM TEMPLATE: Retained strictly for historical audit compliance. Not available for new shifts.',
                permittedFields: [
                    { fieldKey: 'registerBookNumber', label: 'Register Book #', type: 'text', isPermittedToEdit: false, isRequired: true, defaultValue: 'MUSTER-2024-BOOK-3', instructions: 'Physical register book number' }
                ],
                lockedFields: ['registerBookNumber', 'module'],
                structure: {
                    defaultTitle: 'Manual Muster Roll Protocol',
                    defaultOutcome: 'Historical muster register verification.',
                    measurementMethod: 'quantitative',
                    defaultTarget: 100,
                    defaultUnit: '% Logged'
                },
                status: 'archived',
                version: 'v1.0-legacy',
                permissions: {
                    allowPersonalCopies: false,
                    canCreatePersonalCopies: [],
                    permittedRoles: ['super_admin', 'hr_admin'],
                    permittedModules: ['attendance', 'hr_admin']
                },
                createdBy: 'System Migration Admin',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2025-12-31T23:59:59.000Z',
                publishedAt: '2024-01-05T00:00:00.000Z',
                archivedAt: '2025-12-31T23:59:59.000Z',
                archivedBy: 'System Migration Admin',
                versions: [
                    {
                        versionNumber: 'v1.0-legacy',
                        versionId: 'ver_legacy_001',
                        status: 'archived',
                        effectiveFrom: '2024-01-05',
                        changeNotes: 'Archived after modern biometric sync upgrade.',
                        createdBy: 'System Migration Admin',
                        createdAt: '2024-01-05T00:00:00.000Z'
                    }
                ],
                history: [
                    { timestamp: '2024-01-01T00:00:00.000Z', actor: 'System Migration Admin', action: 'created', notes: 'Initial legacy template.' },
                    { timestamp: '2025-12-31T23:59:59.000Z', actor: 'System Migration Admin', action: 'archived', notes: 'Archived. Replaced by biometric shift engine.' }
                ]
            }
        ];

        for (const tpl of seedTemplates) {
            this.templates.set(tpl.id, tpl);
            if (tpl.key) {
                this.templates.set(tpl.key, tpl);
            }
        }
    }

    /**
     * List all templates with optional module, status, scope, role, and general-use filtering
     */
    listTemplates({ module, status, role, search, scope, ownerId, forGeneralUse, includeArchived } = {}) {
        // Collect unique by id
        const mapById = new Map();
        for (const tpl of this.templates.values()) {
            mapById.set(tpl.id, tpl);
        }
        let results = Array.from(mapById.values());

        // Filter by module
        if (module && module !== 'all') {
            results = results.filter(t => t.module.toLowerCase() === module.toLowerCase());
        }

        // Filter by status (draft | published | archived)
        if (status && status !== 'all') {
            results = results.filter(t => t.status.toLowerCase() === status.toLowerCase());
        } else if (!includeArchived) {
            // By default, exclude archived templates from general active listings (PRD 1.3: unavailable for new use)
            results = results.filter(t => t.status !== 'archived');
        }

        // Filter by scope (shared | personal)
        if (scope && scope !== 'all') {
            results = results.filter(t => (t.scope || 'shared').toLowerCase() === scope.toLowerCase());
        }

        // Filter by owner
        if (ownerId) {
            results = results.filter(t => t.ownerId === ownerId || t.scope === 'shared');
        }

        // General-use filtering:
        // PRD 1.3: Draft: "not available for general use"
        // PRD 1.3: Archived: "unavailable for new use"
        if (forGeneralUse) {
            results = results.filter(t => {
                if (t.status === 'archived') return false;
                if (t.status === 'draft') {
                    // Only creator or admin can view their own drafts
                    if (role === 'super_admin' || role === 'hr_admin') return true;
                    if (ownerId && t.ownerId === ownerId) return true;
                    return false;
                }
                return true;
            });
        }

        // Role-based visibility
        if (role) {
            results = results.filter(t => {
                if (role === 'super_admin' || role === 'hr_admin') return true;
                if (t.ownerId && ownerId && t.ownerId === ownerId) return true;
                if (!t.permissions?.permittedRoles) return true;
                return t.permissions.permittedRoles.includes(role);
            });
        }

        // Search query
        if (search) {
            const q = search.toLowerCase();
            results = results.filter(t => 
                t.name.toLowerCase().includes(q) || 
                (t.description && t.description.toLowerCase().includes(q)) || 
                (t.category && t.category.toLowerCase().includes(q))
            );
        }

        return results.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
    }

    /**
     * Get single template by ID or Key
     */
    getTemplate(idOrKey) {
        const tpl = this.templates.get(idOrKey);
        if (!tpl) {
            throw new Error(`Template "${idOrKey}" not found.`);
        }
        return tpl;
    }

    /**
     * PRD 1.3: "A shared template may be provided by an administrator."
     * Administrators create shared templates accessible across permitted users and modules.
     */
    provideSharedTemplate(templateData, adminActor = { name: 'Super Admin', role: 'super_admin' }) {
        const adminRoles = ['super_admin', 'hr_admin', 'admin'];
        const actorRole = adminActor.role || 'user';
        if (!adminRoles.includes(actorRole)) {
            throw new Error(`Permission Denied: Only administrators can provide shared templates. Current role: "${actorRole}". Authorized roles: ${adminRoles.join(', ')}.`);
        }

        return this.createTemplate({
            ...templateData,
            scope: 'shared',
            isShared: true,
            providedByAdmin: true,
            status: templateData.status || 'published'
        }, adminActor);
    }

    /**
     * Create a new custom template
     */
    createTemplate(templateData, actor = { name: 'Admin', role: 'hr_admin' }) {
        if (!templateData.name || !templateData.name.trim()) {
            throw new Error('Template name is required.');
        }
        if (!templateData.module) {
            throw new Error('Module (e.g., goals, onboarding, lifecycle, payroll, exit, policy, attendance, leave, pms, recruitment, compliance) is required.');
        }

        // Verify user authorization to create template
        const allowedRoles = ['super_admin', 'hr_admin', 'manager'];
        const actorRole = actor.role || 'manager';
        if (!allowedRoles.includes(actorRole)) {
            throw new Error(`Role "${actorRole}" is not authorized to create templates. Authorized roles: ${allowedRoles.join(', ')}.`);
        }

        const id = templateData.id || this.generateId();
        const key = templateData.key || `tpl_${templateData.module.toLowerCase()}_${Date.now()}`;
        const now = new Date().toISOString();
        const initialStatus = templateData.status === 'published' ? 'published' : (templateData.status === 'archived' ? 'archived' : 'draft');
        const initialVersion = templateData.version || (initialStatus === 'published' ? 'v1.0' : 'v0.1-draft');

        // Determine scope: shared vs personal
        const isShared = templateData.scope === 'shared' || (templateData.isShared === true) || (actorRole === 'super_admin' || actorRole === 'hr_admin' && templateData.isPersonal !== true);
        const scope = isShared ? 'shared' : 'personal';

        // Prepare permitted fields
        const permittedFields = Array.isArray(templateData.permittedFields) ? templateData.permittedFields.map(f => ({
            fieldKey: f.fieldKey || f.key || 'custom_field',
            label: f.label || f.fieldKey,
            type: f.type || 'text',
            isPermittedToEdit: f.isPermittedToEdit !== false,
            isRequired: !!f.isRequired,
            defaultValue: f.defaultValue !== undefined ? f.defaultValue : '',
            instructions: f.instructions || 'Edit this permitted field.',
            options: f.options || null
        })) : [];

        const lockedFields = Array.isArray(templateData.lockedFields) 
            ? templateData.lockedFields 
            : permittedFields.filter(f => !f.isPermittedToEdit).map(f => f.fieldKey);

        const structure = templateData.structure || {
            defaultTitle: templateData.name.trim(),
            bodyTemplate: templateData.bodyTemplate || ''
        };

        const initialVersionObj = {
            versionNumber: initialVersion,
            versionId: `ver_${Date.now()}`,
            status: initialStatus,
            effectiveFrom: initialStatus === 'published' ? now.split('T')[0] : null,
            structure: JSON.parse(JSON.stringify(structure)),
            permittedFields: JSON.parse(JSON.stringify(permittedFields)),
            lockedFields: [...lockedFields],
            instructions: (templateData.instructions || '').trim(),
            changeNotes: 'Initial template creation.',
            createdBy: `${actor.name} (${actor.role})`,
            createdAt: now,
            sha256: this.computeHash(structure)
        };

        const newTemplate = {
            id,
            key,
            name: templateData.name.trim(),
            module: templateData.module.toLowerCase(),
            category: templateData.category || 'General',
            scope,
            isShared,
            isPersonal: !isShared,
            providedByAdmin: !!templateData.providedByAdmin || (actorRole === 'super_admin' || actorRole === 'hr_admin'),
            ownerId: actor.id || actor.name,
            ownerName: actor.name,
            ownerRole: actorRole,
            description: (templateData.description || '').trim(),
            instructions: (templateData.instructions || 'Users can edit permitted fields before saving.').trim(),
            permittedFields,
            lockedFields,
            structure,
            status: initialStatus,
            version: initialVersion,
            versions: Array.isArray(templateData.versions) && templateData.versions.length > 0
                ? templateData.versions 
                : [initialVersionObj],
            permissions: {
                allowPersonalCopies: templateData.permissions?.allowPersonalCopies !== false,
                canCreatePersonalCopies: templateData.permissions?.canCreatePersonalCopies || ['manager', 'hr_admin', 'super_admin'],
                permittedRoles: templateData.permissions?.permittedRoles || ['super_admin', 'hr_admin', 'manager'],
                permittedModules: templateData.permissions?.permittedModules || [templateData.module.toLowerCase(), 'hr_admin'],
                canEditPermittedFields: templateData.permissions?.canEditPermittedFields || ['super_admin', 'hr_admin', 'manager'],
                canCreateNewTemplate: templateData.permissions?.canCreateNewTemplate || ['super_admin', 'hr_admin', 'manager'],
                canPublish: templateData.permissions?.canPublish || ['super_admin', 'hr_admin'],
                canManagePermissions: templateData.permissions?.canManagePermissions || ['super_admin', 'hr_admin']
            },
            createdBy: `${actor.name} (${actor.role})`,
            createdAt: now,
            updatedAt: now,
            publishedAt: initialStatus === 'published' ? now : null,
            archivedAt: initialStatus === 'archived' ? now : null,
            archivedBy: initialStatus === 'archived' ? `${actor.name} (${actor.role})` : null,
            history: [
                {
                    timestamp: now,
                    actor: `${actor.name} (${actor.role})`,
                    action: initialStatus === 'published' ? 'created_and_published' : (initialStatus === 'archived' ? 'created_as_archived' : 'created_as_draft'),
                    notes: `Template "${templateData.name}" created with status: ${initialStatus} (scope: ${scope}).`
                }
            ]
        };

        this.templates.set(id, newTemplate);
        this.templates.set(key, newTemplate);
        logger.info(`[CustomTemplateEngine] Created template ${id} (${key}) in status ${initialStatus} [${scope}] by ${actor.name}`);
        return newTemplate;
    }

    /**
     * PRD 1.3: "Managers may create personal copies where permissions allow."
     * Creates a personal copy of a template for a manager when permissions permit.
     */
    createPersonalCopy(templateIdOrKey, actor = { name: 'Manager', role: 'manager' }, overrides = {}) {
        const tpl = this.getTemplate(templateIdOrKey);

        // PRD 1.3: Archived templates are unavailable for new use
        if (tpl.status === 'archived') {
            throw new Error(`Cannot create personal copies of an Archived template. Template "${tpl.name}" is retained for history only.`);
        }

        // Permission Check 1: Does the template allow personal copying?
        if (tpl.permissions?.allowPersonalCopies === false) {
            throw new Error(`Permission Denied: Template "${tpl.name}" does not allow personal copies.`);
        }

        // Permission Check 2: Does the actor have permission to copy?
        const allowedRoles = tpl.permissions?.canCreatePersonalCopies || ['manager', 'hr_admin', 'super_admin'];
        const actorRole = actor.role || 'manager';
        if (!allowedRoles.includes(actorRole) && actorRole !== 'super_admin' && actorRole !== 'hr_admin') {
            throw new Error(`Permission Denied: Role "${actorRole}" is not permitted to create personal copies. Authorized roles: ${allowedRoles.join(', ')}.`);
        }

        const id = this.generatePersonalId();
        const key = `tpl_pers_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
        const now = new Date().toISOString();
        const copyName = overrides.name || `[Personal Copy] ${tpl.name}`;
        const copyStatus = overrides.status || 'draft'; // Managers create in draft for personal editing
        const copyVersion = 'v1.0-personal';

        const structure = overrides.structure 
            ? JSON.parse(JSON.stringify(overrides.structure)) 
            : JSON.parse(JSON.stringify(tpl.structure || {}));

        const permittedFields = overrides.permittedFields 
            ? JSON.parse(JSON.stringify(overrides.permittedFields)) 
            : JSON.parse(JSON.stringify(tpl.permittedFields || []));

        const lockedFields = overrides.lockedFields 
            ? [...overrides.lockedFields] 
            : [...(tpl.lockedFields || [])];

        const instructions = (overrides.instructions !== undefined ? overrides.instructions : tpl.instructions || '').trim();

        const initialVersionObj = {
            versionNumber: copyVersion,
            versionId: `ver_${Date.now()}`,
            status: copyStatus,
            effectiveFrom: copyStatus === 'published' ? now.split('T')[0] : null,
            structure: JSON.parse(JSON.stringify(structure)),
            permittedFields: JSON.parse(JSON.stringify(permittedFields)),
            lockedFields: [...lockedFields],
            instructions,
            changeNotes: `Personal copy instantiated from parent template "${tpl.name}" (${tpl.version}).`,
            createdBy: `${actor.name} (${actor.role})`,
            createdAt: now,
            sha256: this.computeHash(structure)
        };

        const personalTemplate = {
            id,
            key,
            name: copyName,
            module: tpl.module,
            category: overrides.category || tpl.category,
            scope: 'personal',
            isShared: false,
            isPersonal: true,
            providedByAdmin: false,
            parentTemplateId: tpl.id,
            parentTemplateKey: tpl.key,
            parentTemplateVersion: tpl.version,
            ownerId: actor.id || actor.name,
            ownerName: actor.name,
            ownerRole: actorRole,
            description: overrides.description || `Manager personal copy of ${tpl.name}`,
            instructions,
            permittedFields,
            lockedFields,
            structure,
            status: copyStatus,
            version: copyVersion,
            versions: [initialVersionObj],
            permissions: {
                allowPersonalCopies: true,
                canCreatePersonalCopies: ['manager', 'hr_admin', 'super_admin'],
                permittedRoles: ['super_admin', 'hr_admin', 'manager'],
                permittedModules: [tpl.module, 'hr_admin'],
                canEditPermittedFields: ['super_admin', 'hr_admin', 'manager'],
                canCreateNewTemplate: ['super_admin', 'hr_admin', 'manager'],
                canPublish: ['manager', 'super_admin', 'hr_admin'],
                canManagePermissions: ['super_admin', 'hr_admin']
            },
            createdBy: `${actor.name} (${actor.role})`,
            createdAt: now,
            updatedAt: now,
            publishedAt: copyStatus === 'published' ? now : null,
            history: [
                {
                    timestamp: now,
                    actor: `${actor.name} (${actor.role})`,
                    action: 'personal_copy_created',
                    notes: `Personal copy created from "${tpl.name}" (${tpl.version}) by manager ${actor.name}.`
                }
            ]
        };

        this.templates.set(id, personalTemplate);
        this.templates.set(key, personalTemplate);
        logger.info(`[CustomTemplateEngine] Manager ${actor.name} created personal template ${id} from parent ${tpl.id}`);
        return personalTemplate;
    }

    /**
     * PRD 1.3: "Archived: Retained for history; unavailable for new use."
     * Archives a template so it is preserved for audit history but blocked from new instantiation.
     */
    archiveTemplate(idOrKey, actor = { name: 'Admin', role: 'hr_admin' }, reason = '') {
        const tpl = this.getTemplate(idOrKey);

        const actorRole = actor.role || 'user';
        const isOwner = tpl.ownerId === actor.id || tpl.ownerName === actor.name || tpl.createdBy.includes(actor.name);
        const isAdmin = actorRole === 'super_admin' || actorRole === 'hr_admin';

        if (!isAdmin && !isOwner) {
            throw new Error(`Permission Denied: Only administrators or the template creator can archive template "${tpl.name}".`);
        }

        const now = new Date().toISOString();
        tpl.status = 'archived';
        tpl.archivedAt = now;
        tpl.archivedBy = `${actor.name} (${actorRole})`;
        tpl.updatedAt = now;

        tpl.history.push({
            timestamp: now,
            actor: `${actor.name} (${actorRole})`,
            action: 'archived',
            notes: reason || 'Template archived and retained for historical audit only. Unavailable for new use.'
        });

        this.templates.set(tpl.id, tpl);
        if (tpl.key) this.templates.set(tpl.key, tpl);
        logger.info(`[CustomTemplateEngine] Template ${tpl.id} transitioned to ARCHIVED status by ${actor.name}`);
        return tpl;
    }

    /**
     * PRD 1.3: "Template changes should be versioned. Existing records should not change unexpectedly when a template is updated."
     * Creates and records an explicit new version snapshot for a template.
     */
    createTemplateVersion(idOrKey, newVersionData, actor = { name: 'Admin', role: 'hr_admin' }) {
        const tpl = this.getTemplate(idOrKey);

        if (tpl.status === 'archived') {
            throw new Error(`Cannot create a new version of an Archived template. Template "${tpl.name}" is retained for history only.`);
        }

        const actorRole = actor.role || 'user';
        const isOwner = tpl.ownerId === actor.id || tpl.ownerName === actor.name || tpl.createdBy.includes(actor.name);
        const isAdmin = actorRole === 'super_admin' || actorRole === 'hr_admin';
        if (!isAdmin && !isOwner) {
            throw new Error(`Permission Denied: Only administrators or the template creator can version template "${tpl.name}".`);
        }

        const now = new Date().toISOString();

        // Compute next version string if not provided (e.g. v1.0 -> v1.1 or v2.0)
        let nextVersion = newVersionData.versionNumber;
        if (!nextVersion) {
            const currentParts = tpl.version.replace('v', '').split('.');
            const major = parseInt(currentParts[0], 10) || 1;
            const minor = parseInt(currentParts[1], 10) || 0;
            nextVersion = newVersionData.isMajor ? `v${major + 1}.0` : `v${major}.${minor + 1}`;
        }

        // Merge structure updates
        const updatedStructure = newVersionData.structure 
            ? { ...tpl.structure, ...newVersionData.structure }
            : JSON.parse(JSON.stringify(tpl.structure || {}));

        // Merge permitted fields
        let updatedPermittedFields = tpl.permittedFields;
        if (Array.isArray(newVersionData.permittedFields)) {
            updatedPermittedFields = newVersionData.permittedFields.map(f => ({
                fieldKey: f.fieldKey,
                label: f.label || f.fieldKey,
                type: f.type || 'text',
                isPermittedToEdit: f.isPermittedToEdit !== false,
                isRequired: !!f.isRequired,
                defaultValue: f.defaultValue,
                instructions: f.instructions || '',
                options: f.options || null
            }));
        }

        const updatedLockedFields = Array.isArray(newVersionData.lockedFields) 
            ? newVersionData.lockedFields 
            : [...(tpl.lockedFields || [])];

        const updatedInstructions = newVersionData.instructions !== undefined 
            ? newVersionData.instructions.trim() 
            : tpl.instructions;

        const newVersionSnapshot = {
            versionNumber: nextVersion,
            versionId: `ver_${Date.now()}`,
            status: tpl.status,
            effectiveFrom: newVersionData.effectiveFrom || now.split('T')[0],
            structure: JSON.parse(JSON.stringify(updatedStructure)),
            permittedFields: JSON.parse(JSON.stringify(updatedPermittedFields)),
            lockedFields: [...updatedLockedFields],
            instructions: updatedInstructions,
            changeNotes: newVersionData.changeNotes || `Published new version ${nextVersion}.`,
            createdBy: `${actor.name} (${actor.role})`,
            createdAt: now,
            sha256: this.computeHash(updatedStructure)
        };

        if (!Array.isArray(tpl.versions)) {
            tpl.versions = [];
        }
        tpl.versions.push(newVersionSnapshot);

        // Update active working copy
        tpl.version = nextVersion;
        tpl.structure = updatedStructure;
        tpl.permittedFields = updatedPermittedFields;
        tpl.lockedFields = updatedLockedFields;
        tpl.instructions = updatedInstructions;
        tpl.updatedAt = now;

        tpl.history.push({
            timestamp: now,
            actor: `${actor.name} (${actor.role})`,
            action: 'version_published',
            notes: `Template version updated to ${nextVersion}: ${newVersionData.changeNotes || 'New version published.'}`
        });

        this.templates.set(tpl.id, tpl);
        if (tpl.key) this.templates.set(tpl.key, tpl);
        logger.info(`[CustomTemplateEngine] Template ${tpl.id} updated to version ${nextVersion} by ${actor.name}`);
        return tpl;
    }

    /**
     * Get version history for a template
     */
    getTemplateVersions(idOrKey) {
        const tpl = this.getTemplate(idOrKey);
        return tpl.versions || [];
    }

    /**
     * Edit permitted fields and instructions
     * Automatically snapshots version changes to guarantee immutability of existing records
     */
    updateTemplate(idOrKey, updates, actor = { name: 'User', role: 'manager' }) {
        const tpl = this.getTemplate(idOrKey);

        if (tpl.status === 'archived') {
            throw new Error(`Cannot update an Archived template. Template "${tpl.name}" is retained for history only.`);
        }

        const now = new Date().toISOString();

        if (updates.name) tpl.name = updates.name.trim();
        if (updates.description !== undefined) tpl.description = updates.description.trim();
        if (updates.instructions !== undefined) tpl.instructions = updates.instructions.trim();
        if (updates.category) tpl.category = updates.category;

        // Update permitted fields
        if (Array.isArray(updates.permittedFields)) {
            tpl.permittedFields = updates.permittedFields.map(f => ({
                fieldKey: f.fieldKey,
                label: f.label || f.fieldKey,
                type: f.type || 'text',
                isPermittedToEdit: f.isPermittedToEdit !== false,
                isRequired: !!f.isRequired,
                defaultValue: f.defaultValue,
                instructions: f.instructions || '',
                options: f.options || null
            }));
        }

        if (Array.isArray(updates.lockedFields)) {
            tpl.lockedFields = updates.lockedFields;
        }

        if (updates.structure) {
            tpl.structure = {
                ...tpl.structure,
                ...updates.structure
            };
        }

        if (updates.status) {
            tpl.status = updates.status;
        }

        tpl.updatedAt = now;

        // If template is published, record version snapshot for traceability
        if (tpl.status === 'published' && Array.isArray(tpl.versions)) {
            tpl.versions.push({
                versionNumber: tpl.version,
                versionId: `ver_${Date.now()}`,
                status: tpl.status,
                effectiveFrom: now.split('T')[0],
                structure: JSON.parse(JSON.stringify(tpl.structure || {})),
                permittedFields: JSON.parse(JSON.stringify(tpl.permittedFields || [])),
                lockedFields: [...(tpl.lockedFields || [])],
                instructions: tpl.instructions,
                changeNotes: updates.changeNotes || 'Template modified and re-saved.',
                createdBy: `${actor.name} (${actor.role})`,
                createdAt: now,
                sha256: this.computeHash(tpl.structure)
            });
        }

        tpl.history.push({
            timestamp: now,
            actor: `${actor.name} (${actor.role})`,
            action: 'edited',
            notes: updates.changeNotes || 'Template fields and instructions updated.'
        });

        this.templates.set(tpl.id, tpl);
        if (tpl.key) this.templates.set(tpl.key, tpl);
        logger.info(`[CustomTemplateEngine] Updated template ${tpl.id} by ${actor.name}`);
        return tpl;
    }

    /**
     * Preview template before saving
     */
    previewTemplate(idOrKey, customFieldValues = {}) {
        const tpl = this.getTemplate(idOrKey);
        
        // Merge custom values with defaults
        const mergedFields = {};
        for (const pf of (tpl.permittedFields || [])) {
            if (customFieldValues[pf.fieldKey] !== undefined) {
                mergedFields[pf.fieldKey] = customFieldValues[pf.fieldKey];
            } else {
                mergedFields[pf.fieldKey] = pf.defaultValue;
            }
        }

        let previewHtml = '';
        if (tpl.module === 'goals') {
            const title = mergedFields.title || tpl.structure.defaultTitle || tpl.name;
            const outcome = mergedFields.outcome || tpl.structure.defaultOutcome || tpl.description;
            const target = mergedFields.target !== undefined ? mergedFields.target : (tpl.structure.defaultTarget || 100);
            const unit = mergedFields.unit || tpl.structure.defaultUnit || '%';
            const criteria = mergedFields.completionCriteria || 'Complete all deliverables on schedule.';
            const targetDate = mergedFields.targetCompletionDate || 'Not specified';
            const milestones = tpl.structure.defaultMilestones || [];

            previewHtml = `
<div style="background: white; border: 1.5px solid #e2e8f0; border-radius: 16px; padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); font-family: inherit;">
    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; border-bottom: 1px solid #f1f5f9; padding-bottom: 12px;">
        <div>
            <span style="font-size: 11px; font-weight: 800; background: #eff6ff; color: #2563eb; padding: 3px 10px; border-radius: 12px; text-transform: uppercase;">${tpl.category}</span>
            <h3 style="font-size: 1.25rem; font-weight: 800; color: #0f172a; margin: 8px 0 4px;">${title}</h3>
            <p style="font-size: 0.85rem; color: #64748b; margin: 0;"><strong>Target Outcome:</strong> ${outcome}</p>
        </div>
        <div style="text-align: right;">
            <div style="font-size: 1.5rem; font-weight: 800; color: #2563eb;">${target} <span style="font-size: 0.85rem; color: #64748b;">${unit}</span></div>
            <div style="font-size: 0.75rem; color: #94a3b8; font-weight: 600;">Target Deadline: ${targetDate}</div>
        </div>
    </div>
    <div style="margin-bottom: 16px;">
        <h4 style="font-size: 0.75rem; font-weight: 800; color: #64748b; text-transform: uppercase; margin-bottom: 8px;">Completion Criteria</h4>
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; font-size: 0.85rem; color: #334155;">
            ${criteria}
        </div>
    </div>
    ${milestones.length > 0 ? `
    <div>
        <h4 style="font-size: 0.75rem; font-weight: 800; color: #64748b; text-transform: uppercase; margin-bottom: 8px;">Template Milestones (${milestones.length})</h4>
        <div style="display: flex; flex-direction: column; gap: 6px;">
            ${milestones.map((m, i) => `
                <div style="display: flex; align-items: center; gap: 10px; background: #ffffff; border: 1px solid #e2e8f0; padding: 8px 12px; border-radius: 8px; font-size: 0.82rem;">
                    <span style="width: 18px; height: 18px; border-radius: 50%; background: #eff6ff; color: #2563eb; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 800;">${i+1}</span>
                    <span style="flex: 1; font-weight: 600; color: #1e293b;">${m.title}</span>
                    <span style="font-size: 11px; color: #94a3b8;">+${m.targetOffsetDays || 14} days</span>
                </div>
            `).join('')}
        </div>
    </div>` : ''}
</div>`;
        } else {
            let body = tpl.structure.bodyTemplate || tpl.description || '';
            for (const [k, v] of Object.entries(mergedFields)) {
                body = body.split(`{{${k}}}`).join(v);
            }
            previewHtml = `
<div style="background: white; border: 1.5px solid #e2e8f0; border-radius: 16px; padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); font-family: inherit;">
    <div style="margin-bottom: 12px; font-size: 12px; font-weight: 700; color: #2563eb; text-transform: uppercase;">[${tpl.module.toUpperCase()}] ${tpl.name} (Preview)</div>
    <div style="font-size: 0.9rem; line-height: 1.6; color: #1e293b;">${body}</div>
</div>`;
        }

        return {
            templateId: tpl.id,
            templateName: tpl.name,
            module: tpl.module,
            status: tpl.status,
            version: tpl.version,
            scope: tpl.scope,
            mergedFields,
            instructions: tpl.instructions,
            previewHtml
        };
    }

    /**
     * Save template as draft
     * PRD 1.3: "Draft: Editable; not available for general use."
     */
    saveAsDraft(idOrKey, updates = {}, actor = { name: 'User', role: 'manager' }) {
        const tpl = this.getTemplate(idOrKey);
        if (updates && Object.keys(updates).length > 0) {
            this.updateTemplate(idOrKey, updates, actor);
        }
        tpl.status = 'draft';
        const now = new Date().toISOString();
        tpl.updatedAt = now;
        tpl.history.push({
            timestamp: now,
            actor: `${actor.name} (${actor.role})`,
            action: 'saved_as_draft',
            notes: 'Template saved in draft state (Editable; not available for general use).'
        });
        logger.info(`[CustomTemplateEngine] Template ${tpl.id} saved as draft by ${actor.name}`);
        return tpl;
    }

    /**
     * Publish template
     * PRD 1.3: "Published: Available to permitted users."
     */
    publishTemplate(idOrKey, actor = { name: 'Admin', role: 'hr_admin' }) {
        const tpl = this.getTemplate(idOrKey);

        if (tpl.status === 'archived') {
            throw new Error(`Cannot publish an Archived template. Template "${tpl.name}" is retained for history only.`);
        }

        const actorRole = actor.role || 'manager';
        const canPublishRoles = tpl.permissions?.canPublish || ['super_admin', 'hr_admin'];
        const isOwnerManager = tpl.isPersonal && (tpl.ownerId === actor.id || tpl.ownerName === actor.name);

        if (!canPublishRoles.includes(actorRole) && actorRole !== 'super_admin' && actorRole !== 'hr_admin' && !isOwnerManager) {
            throw new Error(`Role "${actorRole}" does not have publish permission for this template. Authorized roles: ${canPublishRoles.join(', ')}.`);
        }

        tpl.status = 'published';
        const now = new Date().toISOString();
        tpl.updatedAt = now;
        tpl.publishedAt = now;
        
        // Bump version if it was draft
        if (tpl.version.includes('draft')) {
            tpl.version = tpl.isPersonal ? 'v1.0-personal' : 'v1.0';
        }

        if (Array.isArray(tpl.versions)) {
            tpl.versions.push({
                versionNumber: tpl.version,
                versionId: `ver_${Date.now()}`,
                status: 'published',
                effectiveFrom: now.split('T')[0],
                structure: JSON.parse(JSON.stringify(tpl.structure || {})),
                permittedFields: JSON.parse(JSON.stringify(tpl.permittedFields || [])),
                lockedFields: [...(tpl.lockedFields || [])],
                instructions: tpl.instructions,
                changeNotes: 'Template published and made available to permitted users.',
                createdBy: `${actor.name} (${actor.role})`,
                createdAt: now,
                sha256: this.computeHash(tpl.structure)
            });
        }

        tpl.history.push({
            timestamp: now,
            actor: `${actor.name} (${actor.role})`,
            action: 'published',
            notes: 'Template published and made available to permitted users.'
        });

        logger.info(`[CustomTemplateEngine] Template ${tpl.id} published by ${actor.name}`);
        return tpl;
    }

    /**
     * Administrator manages template permissions
     */
    updateTemplatePermissions(idOrKey, newPermissions, actor = { name: 'Super Admin', role: 'super_admin' }) {
        const actorRole = actor.role || 'user';
        if (actorRole !== 'super_admin' && actorRole !== 'hr_admin' && actorRole !== 'admin') {
            throw new Error(`Access Denied: Only Administrators can manage template permissions. Current role: "${actorRole}".`);
        }

        const tpl = this.getTemplate(idOrKey);
        const previousPermissions = { ...tpl.permissions };

        tpl.permissions = {
            ...tpl.permissions,
            ...newPermissions
        };

        if (Array.isArray(newPermissions.lockedFields)) {
            tpl.lockedFields = newPermissions.lockedFields;
            tpl.permittedFields.forEach(pf => {
                if (newPermissions.lockedFields.includes(pf.fieldKey)) {
                    pf.isPermittedToEdit = false;
                } else if (newPermissions.unlockedFields?.includes(pf.fieldKey)) {
                    pf.isPermittedToEdit = true;
                }
            });
        }

        const now = new Date().toISOString();
        tpl.updatedAt = now;
        tpl.history.push({
            timestamp: now,
            actor: `${actor.name} (${actor.role})`,
            action: 'permissions_updated',
            notes: `Permissions updated by administrator: permitted roles [${(tpl.permissions.permittedRoles || []).join(', ')}], allowPersonalCopies: ${tpl.permissions.allowPersonalCopies}.`,
            previousPermissions,
            newPermissions: tpl.permissions
        });

        this.templates.set(tpl.id, tpl);
        if (tpl.key) this.templates.set(tpl.key, tpl);
        logger.info(`[CustomTemplateEngine] Administrator ${actor.name} updated permissions on template ${tpl.id}`);
        return tpl;
    }

    /**
     * Instantiate goal or record from template with user permitted values
     * PRD 1.3:
     * - Draft: Editable; not available for general use.
     * - Published: Available to permitted users.
     * - Archived: Retained for history; unavailable for new use.
     * - Versioned & Immutable: Existing records do not change unexpectedly when a template is updated.
     */
    instantiateTemplate(idOrKey, userInputs = {}, actor = { name: 'Manager', role: 'manager' }) {
        const tpl = this.getTemplate(idOrKey);

        // 1. ARCHIVED CHECK:
        // PRD 1.3: "Archived: Retained for history; unavailable for new use."
        if (tpl.status === 'archived') {
            throw new Error(`Template "${tpl.name}" is Archived and unavailable for new use. It is retained for history only.`);
        }

        // 2. DRAFT CHECK:
        // PRD 1.3: "Draft: Editable; not available for general use."
        if (tpl.status === 'draft') {
            const isCreatorOrAdmin = actor.role === 'super_admin' || 
                                     actor.role === 'hr_admin' || 
                                     tpl.ownerId === actor.id || 
                                     tpl.ownerName === actor.name || 
                                     tpl.createdBy?.includes(actor.name);
            if (!isCreatorOrAdmin) {
                throw new Error(`Template "${tpl.name}" is in Draft status and is not available for general use. It must be Published first.`);
            }
        }

        // 3. PERMISSIONS CHECK:
        if (actor.role !== 'super_admin' && actor.role !== 'hr_admin') {
            if (tpl.permissions?.permittedRoles && !tpl.permissions.permittedRoles.includes(actor.role)) {
                throw new Error(`Role "${actor.role}" is not permitted to instantiate template "${tpl.name}". Permitted roles: ${tpl.permissions.permittedRoles.join(', ')}.`);
            }
        }

        // 4. LOCKED FIELDS PROTECTION:
        const modifiedLocked = (tpl.lockedFields || []).filter(lk => 
            userInputs[lk] !== undefined && 
            userInputs[lk] !== tpl.permittedFields.find(f => f.fieldKey === lk)?.defaultValue
        );

        if (modifiedLocked.length > 0 && actor.role !== 'super_admin') {
            throw new Error(`Permission Denied: Fields [${modifiedLocked.join(', ')}] are locked by administrator policy and cannot be altered.`);
        }

        // 5. IMMUTABLE VERSION SNAPSHOT:
        // PRD 1.3: "Template changes should be versioned. Existing records should not change unexpectedly when a template is updated"
        const templateVersionSnapshot = {
            templateId: tpl.id,
            templateKey: tpl.key,
            templateName: tpl.name,
            templateVersion: tpl.version,
            scope: tpl.scope || 'shared',
            module: tpl.module,
            category: tpl.category,
            structure: JSON.parse(JSON.stringify(tpl.structure || {})),
            permittedFields: JSON.parse(JSON.stringify(tpl.permittedFields || [])),
            lockedFields: [...(tpl.lockedFields || [])],
            instructions: tpl.instructions,
            sha256: this.computeHash(tpl.structure)
        };

        const recordId = `REC-${Date.now()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

        const instantiated = {
            recordId,
            templateId: tpl.id,
            templateKey: tpl.key,
            templateName: tpl.name,
            templateVersion: tpl.version,
            templateVersionSnapshot,
            module: tpl.module,
            category: tpl.category,
            scope: tpl.scope || 'shared',
            title: userInputs.title || tpl.structure.defaultTitle || tpl.name,
            outcome: userInputs.outcome || tpl.structure.defaultOutcome || tpl.description,
            measurement: {
                method: tpl.structure.measurementMethod || 'quantitative',
                target: userInputs.target !== undefined ? userInputs.target : (tpl.structure.defaultTarget || 100),
                unit: userInputs.unit || tpl.structure.defaultUnit || '%',
                completionCriteria: userInputs.completionCriteria || 'Standard template acceptance criteria.',
                milestones: (tpl.structure.defaultMilestones || []).map((m, idx) => ({
                    id: `m_${idx + 1}`,
                    title: m.title,
                    targetDate: userInputs.targetCompletionDate || null,
                    completed: false
                }))
            },
            schedule: {
                startDate: new Date().toISOString().split('T')[0],
                targetCompletionDate: userInputs.targetCompletionDate || ''
            },
            instructions: tpl.instructions,
            customizedFields: userInputs,
            instantiatedBy: `${actor.name} (${actor.role})`,
            instantiatedAt: new Date().toISOString()
        };

        return instantiated;
    }
}

const orgEngines = new Map();

// Default instance (no company) for existing callers and tests; routes use customTemplateEngine.forOrg(orgId)
const customTemplateEngine = new CustomTemplateEngine();
module.exports = customTemplateEngine;
