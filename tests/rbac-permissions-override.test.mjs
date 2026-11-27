/**
 * ============================================================================
 * KYLRX.AI ENTERPRISE HRMS - HYBRID RBAC & PERMISSION OVERRIDE TEST SUITE
 * ============================================================================
 * 
 * Validates PRD Sections 1, 14, 17, & 18:
 * 1. Exact Schema & Dual-Target Entity Resolution (All 13 Attributes)
 * 2. Cascading Authorization Resolution Pipeline & Super Admin Lock
 * 3. Setup & Ingestion Support (SheetJS, Deduplication, & Enum Sanitization)
 * 4. Real-Time UI Element Guarding (data-permission & data-min-level)
 * 5. Data Scope & Boundary Checks (Global, Business_Unit, Department, Location, Self)
 * 6. Cloud Firestore Data Architecture & Ledger Persistence
 * 7. HTML & DOM Wiring Verification
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Import parsers & services
const roleParser = (await import('../services/role-permission-parser.js')).default;
const rbacService = (await import('../services/rbac-service.js')).default;
const rbacUIController = (await import('../services/rbac-ui-controller.js')).default;

test('PRD Sections 1, 14, 17, & 18: Hybrid RBAC & Permission Overrides Suite', async (t) => {

    await t.test('1. Exact Schema & Dual-Target Entity Resolution (All 13 Attributes)', async () => {
        // Verify 13 attributes definition
        assert.equal(roleParser.ROLE_PERMISSION_ATTRIBUTES.length, 13, "Must define exactly 13 canonical attributes");
        
        const expectedKeys = [
            "Role_Code_or_Employee_Code",
            "Role_Name",
            "Description",
            "Scope_Level",
            "Employee_Module",
            "Attendance_Module",
            "Leave_Module",
            "Payroll_Module",
            "Recruitment_Module",
            "Assets_Module",
            "Reports_Module",
            "Organization_Setup",
            "Active"
        ];
        roleParser.ROLE_PERMISSION_ATTRIBUTES.forEach((attr, idx) => {
            assert.equal(attr.key, expectedKeys[idx], `Attribute ${idx + 1} must match '${expectedKeys[idx]}'`);
        });

        // Test Target Entity Resolution:
        // ROLE_ prefix -> BASE_ROLE
        assert.equal(roleParser.resolveTargetEntityType('ROLE_SUPER_ADMIN'), 'BASE_ROLE');
        assert.equal(roleParser.resolveTargetEntityType('ROLE_ADMIN'), 'BASE_ROLE');
        assert.equal(roleParser.resolveTargetEntityType('ROLE_HRMS'), 'BASE_ROLE');
        assert.equal(roleParser.resolveTargetEntityType('ROLE_DEPT_MGR'), 'BASE_ROLE');

        // EMP prefix or Employee ID -> EMPLOYEE_OVERRIDE
        assert.equal(roleParser.resolveTargetEntityType('EMP0001'), 'EMPLOYEE_OVERRIDE');
        assert.equal(roleParser.resolveTargetEntityType('EMP0012'), 'EMPLOYEE_OVERRIDE');
        assert.equal(roleParser.resolveTargetEntityType('E-1029'), 'EMPLOYEE_OVERRIDE');
        assert.equal(roleParser.resolveTargetEntityType('9082'), 'EMPLOYEE_OVERRIDE');

        // Scope Level Enums
        const validScopes = ['Global', 'Business_Unit', 'Department', 'Location', 'Self'];
        validScopes.forEach(scope => {
            assert.equal(roleParser.sanitizeScopeLevel(scope), scope);
        });
        assert.equal(roleParser.sanitizeScopeLevel('invalid_scope'), 'Self', "Invalid scope should fallback safely");

        // Module Permission Enums
        const validPerms = ["Full", "View", "Edit", "Approve", "Disburse_Only", "Allocate", "Export", "Self", "None"];
        validPerms.forEach(perm => {
            assert.equal(roleParser.sanitizeModulePermission(perm), perm);
        });
        assert.equal(roleParser.sanitizeModulePermission('read'), 'View');
        assert.equal(roleParser.sanitizeModulePermission('write'), 'Edit');
        assert.equal(roleParser.sanitizeModulePermission('unknown_perm'), 'None');
    });

    await t.test('2. Cascading Authorization Resolution Pipeline & Super Admin Lock', async () => {
        rbacService.clearAll();

        // 1. Base Role: Standard Employee
        const empContext = {
            uid: 'usr_emp12',
            employeeId: 'EMP0012',
            baseRole: 'ROLE_EMPLOYEE'
        };
        const baseEmpPerms = rbacService.resolveUserPermissions(empContext);
        assert.equal(baseEmpPerms.baseRole, 'ROLE_EMPLOYEE');
        assert.equal(baseEmpPerms.scopeLevel, 'Self');
        assert.equal(baseEmpPerms.modules.employee, 'Self');
        assert.equal(baseEmpPerms.modules.assets, 'Self');
        assert.equal(baseEmpPerms.modules.reports, 'None');
        assert.equal(baseEmpPerms.modules.payroll, 'Self');
        assert.equal(baseEmpPerms.hasActiveOverride, false);

        // 2. Individual Override: Grant EMP0012 elevated Asset Full and Report Export with Global Scope
        rbacService.saveOverride({
            targetType: 'EMPLOYEE_OVERRIDE',
            employeeId: 'EMP0012',
            roleName: 'Special Asset Auditor Override',
            description: 'Temporary elevated access to audit company assets and export reports',
            scopeLevel: 'Global',
            modules: {
                assets: 'Full',
                reports: 'Export'
            },
            isActive: true
        });

        const overriddenPerms = rbacService.resolveUserPermissions(empContext);
        assert.equal(overriddenPerms.hasActiveOverride, true);
        assert.equal(overriddenPerms.overrideTitle, 'Special Asset Auditor Override');
        assert.equal(overriddenPerms.scopeLevel, 'Global', "Scope must elevate to override scope");
        assert.equal(overriddenPerms.modules.assets, 'Full', "Assets module must elevate to Full");
        assert.equal(overriddenPerms.modules.reports, 'Export', "Reports module must elevate to Export");
        assert.equal(overriddenPerms.modules.employee, 'Self', "Non-overridden modules retain base role permissions");
        assert.equal(overriddenPerms.modules.payroll, 'Self');

        // Capability checks
        assert.equal(rbacService.hasPermission(overriddenPerms, 'assets', 'Full'), true);
        assert.equal(rbacService.hasPermission(overriddenPerms, 'assets', 'View'), true);
        assert.equal(rbacService.hasPermission(overriddenPerms, 'reports', 'Export'), true);
        assert.equal(rbacService.hasPermission(overriddenPerms, 'reports', 'View'), true);
        assert.equal(rbacService.hasPermission(overriddenPerms, 'payroll', 'Full'), false);

        // 3. Super Admin Lock: Immutable Full access
        const superAdminContext = {
            uid: 'usr_super',
            employeeId: 'EMP0012', // Even if an override exists for this employeeId!
            baseRole: 'ROLE_SUPER_ADMIN'
        };
        const saPerms = rbacService.resolveUserPermissions(superAdminContext);
        assert.equal(saPerms.isSuperAdmin, true);
        assert.equal(saPerms.scopeLevel, 'Global');
        assert.equal(Object.values(saPerms.modules).every(v => v === 'Full'), true, "All 8 modules must be strictly 'Full'");
        assert.equal(saPerms.hasActiveOverride, false, "Super Admin cannot be modified by user override");

        // Attempting to downgrade Super Admin via saveRole must be blocked / sanitized
        rbacService.saveRole({
            roleCode: 'ROLE_SUPER_ADMIN',
            roleName: 'Attacker Downgrade',
            scopeLevel: 'Self',
            modules: { employee: 'None', payroll: 'None' },
            isActive: false
        });
        const saProtected = rbacService.getRole('ROLE_SUPER_ADMIN');
        assert.equal(saProtected.isImmutable, true);
        assert.equal(saProtected.isActive, true);
        assert.equal(saProtected.modules.employee, 'Full');
    });

    await t.test('3. Setup & Ingestion Support (SheetJS, Deduplication, & Enum Sanitization)', async () => {
        const rawSheetData = [
            {
                "Role_Code_or_Employee_Code": "ROLE_OPERATIONS",
                "Role_Name": "Operations Specialist",
                "Description": "Warehouse and logistics tracking",
                "Scope_Level": "Business_Unit",
                "Employee_Module": "View",
                "Attendance_Module": "Approve",
                "Leave_Module": "Approve",
                "Payroll_Module": "None",
                "Recruitment_Module": "None",
                "Assets_Module": "Allocate",
                "Reports_Module": "Export",
                "Organization_Setup": "None",
                "Active": "Yes"
            },
            {
                "Role_Code_or_Employee_Code": "EMP0005",
                "Role_Name": "Regional Logistics Lead Override",
                "Description": "Oversees physical hardware allocation",
                "Scope_Level": "Location",
                "Employee_Module": "View",
                "Attendance_Module": "View",
                "Leave_Module": "View",
                "Payroll_Module": "None",
                "Recruitment_Module": "None",
                "Assets_Module": "Full",
                "Reports_Module": "Export",
                "Organization_Setup": "None",
                "Active": "Yes"
            },
            // Duplicate code to test deduplication
            {
                "Role_Code_or_Employee_Code": "ROLE_OPERATIONS",
                "Role_Name": "Operations Specialist (Updated)",
                "Description": "Warehouse, logistics, and vendor tracking",
                "Scope_Level": "Business_Unit",
                "Employee_Module": "View",
                "Attendance_Module": "Approve",
                "Leave_Module": "Approve",
                "Payroll_Module": "None",
                "Recruitment_Module": "None",
                "Assets_Module": "Full", // Elevated
                "Reports_Module": "Export",
                "Organization_Setup": "None",
                "Active": "Yes"
            }
        ];

        const parseResult = roleParser.parseRolePermissionSheet(rawSheetData);
        assert.equal(parseResult.success, true);
        assert.equal(parseResult.totalRows, 3);
        // Because of deduplication, 2 distinct items (1 base role, 1 override) + 1 auto-seeded super admin = 3
        const opsRole = parseResult.docs.find(d => d.roleCode === 'ROLE_OPERATIONS');
        assert.ok(opsRole, "ROLE_OPERATIONS must be parsed");
        assert.equal(opsRole.roleName, "Operations Specialist (Updated)", "Deduplication must keep latest row");
        assert.equal(opsRole.modules.assets, "Full");

        const emp5Override = parseResult.docs.find(d => d.employeeId === 'EMP0005');
        assert.ok(emp5Override, "EMP0005 override must be parsed");
        assert.equal(emp5Override.targetType, 'EMPLOYEE_OVERRIDE');
        assert.equal(emp5Override.scopeLevel, 'Location');
    });

    await t.test('4. Real-Time UI Element Guarding (data-permission & data-min-level)', async () => {
        // Mock DOM element and container
        class MockElement {
            constructor(tagName, attrs = {}) {
                this.tagName = tagName;
                this.attributes = attrs;
                this.style = { display: '' };
                this.dataset = {};
                this.disabled = false;
                this.readOnly = false;
                this.classList = {
                    _classes: new Set(),
                    add(c) { this._classes.add(c); },
                    remove(c) { this._classes.delete(c); },
                    contains(c) { return this._classes.has(c); }
                };
                this.title = '';
            }
            getAttribute(k) { return this.attributes[k]; }
            setAttribute(k, v) { this.attributes[k] = v; }
            removeAttribute(k) { delete this.attributes[k]; }
        }

        const runPayrollBtn = new MockElement('BUTTON', {
            'data-permission': 'Payroll_Module',
            'data-min-level': 'Full',
            'data-guard-mode': 'disable'
        });

        const viewReportsDiv = new MockElement('DIV', {
            'data-permission': 'Reports_Module',
            'data-min-level': 'Export',
            'data-guard-mode': 'hide'
        });

        const orgSetupLink = new MockElement('A', {
            'data-permission': 'Organization_Setup',
            'data-min-level': 'View',
            'data-guard-mode': 'hide'
        });

        const mockContainer = {
            querySelectorAll: (sel) => {
                if (sel === '[data-permission]') {
                    return [runPayrollBtn, viewReportsDiv, orgSetupLink];
                }
                return [];
            }
        };

        // User 1: Standard Employee with no payroll Full, no reports Export, no Org Setup
        const user1Perms = {
            isSuperAdmin: false,
            modules: {
                payroll: 'Self',
                reports: 'None',
                organizationSetup: 'None'
            }
        };

        rbacService.guardDOM(mockContainer, user1Perms);
        assert.equal(runPayrollBtn.disabled, true, "Payroll button must be disabled for employee");
        assert.equal(viewReportsDiv.style.display, 'none', "Reports div must be hidden for employee");
        assert.equal(orgSetupLink.style.display, 'none', "Org setup must be hidden for employee");

        // User 2: Finance Manager with payroll Full and reports Export
        const financePerms = {
            isSuperAdmin: false,
            modules: {
                payroll: 'Full',
                reports: 'Export',
                organizationSetup: 'None'
            }
        };

        rbacService.guardDOM(mockContainer, financePerms);
        assert.equal(runPayrollBtn.disabled, false, "Payroll button must be enabled for finance manager");
        assert.notEqual(viewReportsDiv.style.display, 'none', "Reports div must be visible for finance manager");
        assert.equal(orgSetupLink.style.display, 'none', "Org setup still hidden for finance manager");

        // User 3: Super Admin with Full on everything
        const superPerms = {
            isSuperAdmin: true,
            modules: {
                payroll: 'Full',
                reports: 'Full',
                organizationSetup: 'Full'
            }
        };
        rbacService.guardDOM(mockContainer, superPerms);
        assert.equal(runPayrollBtn.disabled, false);
        assert.notEqual(viewReportsDiv.style.display, 'none');
        assert.notEqual(orgSetupLink.style.display, 'none', "Org setup visible for Super Admin");
    });

    await t.test('5. Data Scope & Boundary Checks (Global, Business_Unit, Department, Location, Self)', async () => {
        // Global Scope User
        const globalUser = { uid: 'u_admin', scopeLevel: 'Global', isSuperAdmin: false };
        assert.equal(rbacService.checkDataScope(globalUser, { businessUnitId: 'BU-TECH' }), true);
        assert.equal(rbacService.checkDataScope(globalUser, { departmentId: 'DEPT-ENG' }), true);

        // Business Unit Scoped User
        const buUser = { uid: 'u_bu', scopeLevel: 'Business_Unit', businessUnitId: 'BU-TECH' };
        assert.equal(rbacService.checkDataScope(buUser, { businessUnitId: 'BU-TECH' }), true);
        assert.equal(rbacService.checkDataScope(buUser, { businessUnitId: 'BU-OPS' }), false);

        // Department Scoped User
        const deptUser = { uid: 'u_dept', scopeLevel: 'Department', departmentId: 'DEPT-ENG' };
        assert.equal(rbacService.checkDataScope(deptUser, { departmentId: 'DEPT-ENG' }), true);
        assert.equal(rbacService.checkDataScope(deptUser, { departmentId: 'DEPT-FIN' }), false);

        // Location Scoped User
        const locUser = { uid: 'u_loc', scopeLevel: 'Location', locationId: 'LOC-BNG' };
        assert.equal(rbacService.checkDataScope(locUser, { locationId: 'LOC-BNG' }), true);
        assert.equal(rbacService.checkDataScope(locUser, { locationId: 'LOC-MUM' }), false);

        // Self Scoped User
        const selfUser = { uid: 'u_self', employeeId: 'EMP0012', scopeLevel: 'Self' };
        assert.equal(rbacService.checkDataScope(selfUser, { employeeId: 'EMP0012' }), true);
        assert.equal(rbacService.checkDataScope(selfUser, { employeeId: 'EMP0001' }), false);
    });

    await t.test('6. Cloud Firestore Data Architecture & Ledger Persistence', async () => {
        const mockFirestoreStore = new Map();
        const mockDb = {
            doc: (dbInst, path, id) => `${path}/${id}`,
            setDoc: async (docRef, data, opts) => {
                mockFirestoreStore.set(docRef, { ...data });
            }
        };

        const records = [
            {
                targetType: 'BASE_ROLE',
                roleCode: 'ROLE_DEPT_MGR',
                roleName: 'Department Manager',
                scopeLevel: 'Department',
                modules: { employee: 'View', attendance: 'Approve' },
                isActive: true
            },
            {
                targetType: 'EMPLOYEE_OVERRIDE',
                employeeId: 'EMP0012',
                roleCode: 'EMP0012',
                roleName: 'Special Asset Auditor Override',
                scopeLevel: 'Global',
                modules: { assets: 'Full', reports: 'Export' },
                isActive: true
            }
        ];

        const ingestResult = await rbacService.ingestPermissionRecords(records, 'org_kylrx', mockDb);
        assert.equal(ingestResult.success, true);
        assert.equal(ingestResult.rolesIngested, 1);
        assert.equal(ingestResult.overridesIngested, 1);

        // Check Firestore document paths
        const rolePath = 'organizations/org_kylrx/roles/ROLE_DEPT_MGR';
        const overridePath = 'organizations/org_kylrx/user_permission_overrides/EMP0012';
        assert.ok(mockFirestoreStore.has(rolePath), `Must store base role at ${rolePath}`);
        assert.ok(mockFirestoreStore.has(overridePath), `Must store override at ${overridePath}`);

        // Sync user cache
        await rbacService.syncUserClaimsAndCache('org_kylrx', 'u12', 'EMP0012', {
            baseRole: 'ROLE_EMPLOYEE',
            resolvedRoleTitle: 'Standard Employee',
            scopeLevel: 'Global',
            isSuperAdmin: false,
            hasActiveOverride: true,
            modules: { assets: 'Full' }
        }, mockDb);

        const cachePath = 'organizations/org_kylrx/user_permissions/u12';
        assert.ok(mockFirestoreStore.has(cachePath), `Must store user permissions cache at ${cachePath}`);
    });

    await t.test('7. HTML & DOM Wiring Verification', async () => {
        // Verify Templates.xlsx contains the sheet
        const xlsxPath = path.join(rootDir, 'Templates.xlsx');
        assert.ok(fs.existsSync(xlsxPath), "Templates.xlsx must exist");

        const XLSX = (await import('xlsx')).default;
        XLSX.set_fs(fs); // the ES-module build of SheetJS 0.20 reads files only when handed fs
        const wb = XLSX.readFile(xlsxPath);
        const hasRoleSheet = wb.SheetNames.some(sn => 
            sn.includes('Role_Code') || sn.includes('Roles_Permissions') || sn.includes('Role_Permissions')
        );
        assert.ok(hasRoleSheet, "Templates.xlsx must contain Role Permissions sheet");

        // Verify admin-onboarding-upload.html contains container and buttons
        const uploadHtml = fs.readFileSync(path.join(rootDir, 'admin-onboarding-upload.html'), 'utf8');
        assert.ok(uploadHtml.includes('id="rolePermissionParseResultsContainer"'), "Must contain rolePermissionParseResultsContainer");
        assert.ok(uploadHtml.includes('id="btnConfirmRolePermissionIngest"'), "Must contain btnConfirmRolePermissionIngest");
        assert.ok(uploadHtml.includes('id="btnCancelRolePermissionIngest"'), "Must contain btnCancelRolePermissionIngest");
        assert.ok(uploadHtml.includes('rolePermissionParser.js'), "Must load rolePermissionParser.js");
        assert.ok(uploadHtml.includes('rbacService.js'), "Must load rbacService.js");

        // Verify admin-settings.html contains rbac tab and container
        const settingsHtml = fs.readFileSync(path.join(rootDir, 'admin-settings.html'), 'utf8');
        assert.ok(settingsHtml.includes('data-tab="rbac_permissions"'), "Must contain rbac_permissions tab button");
        assert.ok(settingsHtml.includes('id="settingsRbacContainer"'), "Must contain settingsRbacContainer");
        assert.ok(settingsHtml.includes('rolePermissionParser.js'), "Must load rolePermissionParser.js in settings");
        assert.ok(settingsHtml.includes('rbacService.js'), "Must load rbacService.js in settings");
        assert.ok(settingsHtml.includes('services/rbac-ui-controller.js'), "Must load rbac-ui-controller in settings");

        // Verify firestore.rules
        const firestoreRules = fs.readFileSync(path.join(rootDir, 'firestore.rules'), 'utf8');
        assert.ok(firestoreRules.includes('match /roles/{roleCode}'), "firestore.rules must secure /roles/{roleCode}");
        assert.ok(firestoreRules.includes('match /user_permission_overrides/{employeeId}'), "firestore.rules must secure /user_permission_overrides/{employeeId}");
        assert.ok(firestoreRules.includes('match /user_permissions/{userId}'), "firestore.rules must secure /user_permissions/{userId}");
    });
});
