/**
 * ============================================================================
 * KYLRX.AI ENTERPRISE HRMS - PAYROLL COMPONENTS & CALCULATION ENGINE TEST SUITE
 * ============================================================================
 * 
 * Comprehensive automated test suite validating:
 * 1. Exact 13 Attributes Schema & Field Mapping (PRD Sections 1 & 4)
 * 2. SheetJS Ingestion & Boolean Normalization from Templates.xlsx
 * 3. Primary Key Uniqueness & Percentage_Basis Validation Rules
 * 4. Component Catalog CRUD Operations & In-Memory / Firestore Sync
 * 5. Loss of Pay (LOP) Proration Engine (`Prorate_On_LOP` true vs false)
 * 6. Statutory Wage Base Aggregation (PF, ESI, PT, Taxable Gross)
 * 7. Decoupled integration with payrollDocumentService & payrollDisbursementService
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
XLSX.set_fs(fs); // the ES-module build of SheetJS 0.20 reads files only when handed fs

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Import services and modules under test
const parserPath = path.resolve(rootDir, 'payrollComponentsParser.js');
const servicePath = path.resolve(rootDir, 'payrollComponentService.js');
const enginePath = path.resolve(rootDir, 'services/payroll/payrollCalculationEngine.js');
const docServicePath = path.resolve(rootDir, 'services/payroll/payrollDocumentService.js');
const disbServicePath = path.resolve(rootDir, 'services/payroll/payrollDisbursementService.js');

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const payrollComponentsParser = require(parserPath);
const payrollComponentService = require(servicePath);
const payrollCalculationEngine = require(enginePath);
const { PayrollDocumentService } = require(docServicePath);
const { PayrollDisbursementService } = require(disbServicePath);

test('1. Exact Schema & 13 Attributes Validation from Templates.xlsx', async (t) => {
    const templatePath = path.resolve(rootDir, 'assets/Templates.xlsx');
    assert.ok(fs.existsSync(templatePath), 'Templates.xlsx must exist in assets/ directory');

    const workbook = XLSX.readFile(templatePath);
    const sheetName = workbook.SheetNames.find(s => s.trim().toLowerCase() === 'payroll components' || s.trim().toLowerCase() === 'payroll_components');
    assert.ok(sheetName, "Workbook must contain 'Payroll Components' or 'Payroll_Components' sheet");

    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    assert.ok(rawRows.length > 0, "'Payroll Components' sheet must contain data rows");

    // Ingest and validate using payrollComponentsParser
    const result = payrollComponentsParser.parsePayrollComponents(rawRows, { orgId: 'org_test_101' });

    assert.equal(result.errors.length, 0, `Parser encountered unexpected validation errors: ${JSON.stringify(result.errors)}`);
    assert.ok(result.records.length >= 10, 'Expected at least 10 canonical payroll components in Templates.xlsx');
    assert.equal(result.records.length, result.firestoreDocs.length, 'Records count must match Firestore documents count');

    // Verify all 13 attributes on each parsed document
    const expectedAttributes = [
        'componentCode',
        'componentName',
        'componentType',
        'calculationMethod',
        'defaultValueOrPercentage',
        'percentageBasis',
        'isTaxable',
        'isPfApplicable',
        'isEsiApplicable',
        'isPtApplicable',
        'isTdsApplicable',
        'prorateOnLop',
        'isActive'
    ];

    for (const doc of result.firestoreDocs) {
        for (const attr of expectedAttributes) {
            assert.ok(attr in doc, `Attribute '${attr}' is missing on component ${doc.componentCode}`);
        }
        // Verify boolean normalization
        assert.equal(typeof doc.isTaxable, 'boolean', 'isTaxable must be boolean');
        assert.equal(typeof doc.isPfApplicable, 'boolean', 'isPfApplicable must be boolean');
        assert.equal(typeof doc.isEsiApplicable, 'boolean', 'isEsiApplicable must be boolean');
        assert.equal(typeof doc.isPtApplicable, 'boolean', 'isPtApplicable must be boolean');
        assert.equal(typeof doc.isTdsApplicable, 'boolean', 'isTdsApplicable must be boolean');
        assert.equal(typeof doc.prorateOnLop, 'boolean', 'prorateOnLop must be boolean');
        assert.equal(typeof doc.isActive, 'boolean', 'isActive must be boolean');
    }

    // Verify canonical components exist: BASIC, HRA, SPECIAL_ALLOW, PF_EE, ESI_EE, PT, TDS
    const codeMap = new Map(result.firestoreDocs.map(c => [c.componentCode, c]));
    assert.ok(codeMap.has('BASIC'), 'BASIC component must exist');
    assert.ok(codeMap.has('HRA'), 'HRA component must exist');
    assert.ok(codeMap.has('SPECIAL_ALLOW'), 'SPECIAL_ALLOW component must exist');
    assert.ok(codeMap.has('PF_EE'), 'PF_EE deduction component must exist');
    assert.ok(codeMap.has('ESI_EE'), 'ESI_EE deduction component must exist');
    assert.ok(codeMap.has('PT'), 'PT deduction component must exist');
    assert.ok(codeMap.has('TDS'), 'TDS deduction component must exist');

    // Verify Percentage basis rule on HRA
    const hra = codeMap.get('HRA');
    assert.equal(hra.calculationMethod, 'Percentage');
    assert.equal(hra.percentageBasis, 'BASIC');
    assert.equal(hra.defaultValueOrPercentage, 50);
});

test('2. Parser Validation Rules & Enforcement of Constraints', async (t) => {
    // A. Duplicate Component_Code enforcement
    const dupRows = [
        { Component_Code: 'BONUS', Component_Name: 'Bonus 1', Component_Type: 'Earning', Calculation_Method: 'Flat_Amount', Active: 'Yes' },
        { Component_Code: 'BONUS', Component_Name: 'Bonus 2', Component_Type: 'Earning', Calculation_Method: 'Flat_Amount', Active: 'Yes' }
    ];
    const dupResult = payrollComponentsParser.parsePayrollComponents(dupRows);
    assert.ok(dupResult.errors.some(e => e.includes('Duplicate Component_Code')), 'Should detect duplicate Component_Code');

    // B. Missing Percentage_Basis when Calculation_Method is Percentage
    const invalidPctRows = [
        { Component_Code: 'CUSTOM_PCT', Component_Name: 'Custom Pct', Component_Type: 'Earning', Calculation_Method: 'Percentage', Value_or_Percentage: 10, Percentage_Basis: '' }
    ];
    const pctResult = payrollComponentsParser.parsePayrollComponents(invalidPctRows);
    assert.ok(pctResult.errors.some(e => e.includes('Percentage_Basis is mandatory')), 'Should require Percentage_Basis for Percentage method');

    // C. Invalid Component_Type enum validation
    const invalidTypeRows = [
        { Component_Code: 'INVALID_TYPE', Component_Name: 'Bad Type', Component_Type: 'Perk_Benefit', Calculation_Method: 'Flat_Amount' }
    ];
    const typeResult = payrollComponentsParser.parsePayrollComponents(invalidTypeRows);
    assert.ok(typeResult.errors.some(e => e.includes('Invalid Component_Type')), 'Should reject unapproved component types');
});

test('3. Component Catalog CRUD Operations & In-Memory / Firestore Store', async (t) => {
    const orgId = 'org_test_suite_500';

    // Create custom component
    const newComp = {
        componentCode: 'TEST_PERK',
        componentName: 'Test Wellness Perk',
        componentType: 'Earning',
        calculationMethod: 'Flat_Amount',
        defaultValueOrPercentage: 5000,
        percentageBasis: null,
        isTaxable: true,
        isPfApplicable: false,
        isEsiApplicable: true,
        isPtApplicable: true,
        isTdsApplicable: true,
        prorateOnLop: true,
        isActive: true
    };

    const saved = await payrollComponentService.savePayrollComponent(newComp, orgId);
    assert.equal(saved.componentCode, 'TEST_PERK');

    // Read back
    const retrieved = payrollComponentService.getPayrollComponent('TEST_PERK', orgId);
    assert.ok(retrieved, 'Should retrieve saved component');
    assert.equal(retrieved.componentName, 'Test Wellness Perk');
    assert.equal(retrieved.defaultValueOrPercentage, 5000);

    // Update
    retrieved.defaultValueOrPercentage = 6500;
    await payrollComponentService.savePayrollComponent(retrieved, orgId);
    const updated = payrollComponentService.getPayrollComponent('TEST_PERK', orgId);
    assert.equal(updated.defaultValueOrPercentage, 6500);

    // List
    const all = payrollComponentService.listPayrollComponents(orgId);
    assert.ok(all.some(c => c.componentCode === 'TEST_PERK'));

    // Delete
    const deleted = await payrollComponentService.deletePayrollComponent('TEST_PERK', orgId);
    assert.equal(deleted, true);
    assert.equal(payrollComponentService.getPayrollComponent('TEST_PERK', orgId), null);
});

test('4. Loss of Pay (LOP) Proration Engine Precision (Prorate_On_LOP true vs false)', async (t) => {
    // Calendar: 30 days, LOP: 3 days => 27 paid days => factor = 27 / 30 = 0.9000
    const factor = payrollComponentService.calculateLopProrationFactor(30, 3);
    assert.equal(factor, 0.9);

    // Full 30 days worked => factor = 1.0
    const fullFactor = payrollComponentService.calculateLopProrationFactor(30, 0);
    assert.equal(fullFactor, 1.0);

    // Component with Prorate_On_LOP: true
    // Scheduled: 50,000 => Earned: 50,000 * 0.9 = 45,000
    const proratedComp = {
        componentCode: 'BASIC',
        prorateOnLop: true,
        defaultValueOrPercentage: 50000
    };
    const earnedProrated = payrollComponentService.calculateComponentProration(proratedComp, 50000, 30, 3);
    assert.equal(earnedProrated.earnedAmount, 45000);
    assert.equal(earnedProrated.prorated, true);

    // Component with Prorate_On_LOP: false
    // Scheduled: 25,000 (e.g. Variable Pay or Fixed PT) => Retains 25,000 regardless of LOP days
    const fixedComp = {
        componentCode: 'VARIABLE_PAY',
        prorateOnLop: false,
        defaultValueOrPercentage: 25000
    };
    const earnedFixed = payrollComponentService.calculateComponentProration(fixedComp, 25000, 30, 3);
    assert.equal(earnedFixed.earnedAmount, 25000);
    assert.equal(earnedFixed.prorated, false);
});

test('5. Dynamic Statutory Wage Base Resolution & Net Pay Calculation', async (t) => {
    const employee = {
        employeeId: 'EMP0010',
        employeeName: 'Aarav Sharma',
        pan: 'ABCDE1234F',
        bankName: 'HDFC Bank',
        accountNumber: '50100012345678',
        ifsc: 'HDFC0000123'
    };

    // Salary Structure components
    const salaryStructure = {
        components: [
            { componentCode: 'BASIC', calculationBasis: 'FLAT', amount: 50000 },
            { componentCode: 'HRA', calculationBasis: 'Percentage', percentage: 50 }, // 50% of BASIC = 25,000
            { componentCode: 'SPECIAL_ALLOW', calculationBasis: 'FLAT', amount: 20000 },
            { componentCode: 'CONVEYANCE', calculationBasis: 'FLAT', amount: 1600 },
            { componentCode: 'VARIABLE_PAY', calculationBasis: 'FLAT', amount: 10000 },
            { componentCode: 'PF_EE', calculationBasis: 'Percentage', percentage: 12 }, // 12% of BASIC
            { componentCode: 'PT', calculationBasis: 'FLAT', amount: 200 }
        ]
    };

    // Catalog definition matching PRD Section 1 & 4
    const catalog = [
        { componentCode: 'BASIC', componentType: 'Earning', prorateOnLop: true, isTaxable: true, isPfApplicable: true, isEsiApplicable: true, isPtApplicable: true, isTdsApplicable: true },
        { componentCode: 'HRA', componentType: 'Earning', prorateOnLop: true, isTaxable: true, isPfApplicable: false, isEsiApplicable: true, isPtApplicable: true, isTdsApplicable: true },
        { componentCode: 'SPECIAL_ALLOW', componentType: 'Earning', prorateOnLop: true, isTaxable: true, isPfApplicable: false, isEsiApplicable: true, isPtApplicable: true, isTdsApplicable: true },
        { componentCode: 'CONVEYANCE', componentType: 'Earning', prorateOnLop: true, isTaxable: false, isPfApplicable: false, isEsiApplicable: false, isPtApplicable: false, isTdsApplicable: false },
        { componentCode: 'VARIABLE_PAY', componentType: 'Earning', prorateOnLop: false, isTaxable: true, isPfApplicable: false, isEsiApplicable: true, isPtApplicable: true, isTdsApplicable: true },
        { componentCode: 'PF_EE', componentType: 'Deduction', prorateOnLop: true, isTaxable: false, isPfApplicable: false, isEsiApplicable: false, isPtApplicable: false, isTdsApplicable: false },
        { componentCode: 'PT', componentType: 'Deduction', prorateOnLop: false, isTaxable: false, isPfApplicable: false, isEsiApplicable: false, isPtApplicable: false, isTdsApplicable: false }
    ];

    // Attendance: 30 days calendar, 3 days LOP => proration factor = 0.9
    const attendance = {
        calendarDaysInMonth: 30,
        lopDays: 3,
        month: '2026-09'
    };

    const result = payrollCalculationEngine.calculateEmployeePayroll(employee, salaryStructure, attendance, catalog);

    // Verify LOP Proration on individual components
    // BASIC: scheduled 50,000 * 0.9 = 45,000
    const basicComp = result.components.find(c => c.componentCode === 'BASIC');
    assert.equal(basicComp.earnedAmount, 45000);

    // HRA: scheduled 25,000 * 0.9 = 22,500
    const hraComp = result.components.find(c => c.componentCode === 'HRA');
    assert.equal(hraComp.earnedAmount, 22500);

    // SPECIAL_ALLOW: scheduled 20,000 * 0.9 = 18,000
    const specialComp = result.components.find(c => c.componentCode === 'SPECIAL_ALLOW');
    assert.equal(specialComp.earnedAmount, 18000);

    // CONVEYANCE: scheduled 1,600 * 0.9 = 1,440
    const convComp = result.components.find(c => c.componentCode === 'CONVEYANCE');
    assert.equal(convComp.earnedAmount, 1440);

    // VARIABLE_PAY: scheduled 10,000, prorateOnLop = false => 10,000
    const varComp = result.components.find(c => c.componentCode === 'VARIABLE_PAY');
    assert.equal(varComp.earnedAmount, 10000);

    // Gross Earnings: 45000 + 22500 + 18000 + 1440 + 10000 = 96,940
    assert.equal(result.grossEarnings, 96940);

    // PF_EE: scheduled (12% of 50000 = 6000) * 0.9 = 5400
    const pfComp = result.components.find(c => c.componentCode === 'PF_EE');
    assert.equal(pfComp.earnedAmount, 5400);

    // PT: 200 (prorateOnLop is false)
    const ptComp = result.components.find(c => c.componentCode === 'PT');
    assert.equal(ptComp.earnedAmount, 200);

    // Total Deductions: 5400 + 200 = 5600
    assert.equal(result.totalDeductions, 5600);

    // Net Pay: 96940 - 5600 = 91,340
    assert.equal(result.netPay, 91340);
    assert.equal(result.netPayable, 91340);

    // Verify Statutory Wage Bases
    // PF Gross: only BASIC has isPfApplicable == true => 45,000
    assert.equal(result.statutoryWageBases.pfGross, 45000);

    // ESI Gross: BASIC (45000) + HRA (22500) + SPECIAL_ALLOW (18000) + VARIABLE_PAY (10000) = 95,500
    assert.equal(result.statutoryWageBases.esiGross, 95500);

    // PT Gross: BASIC (45000) + HRA (22500) + SPECIAL_ALLOW (18000) + VARIABLE_PAY (10000) = 95,500
    assert.equal(result.statutoryWageBases.ptGross, 95500);

    // Taxable Gross: All earnings except CONVEYANCE = 96940 - 1440 = 95,500
    assert.equal(result.statutoryWageBases.taxableGross, 95500);
});

test('6. Decoupled Pipeline Integration with payrollDocumentService & payrollDisbursementService', async (t) => {
    const employee = {
        employeeId: 'EMP0099',
        employeeName: 'Pooja Iyer',
        pan: 'ABCDE9999Z',
        bankName: 'ICICI Bank',
        accountNumber: '000105001234',
        ifsc: 'ICIC0000001'
    };

    const salaryStructure = {
        components: [
            { componentCode: 'BASIC', calculationBasis: 'FLAT', amount: 60000 },
            { componentCode: 'HRA', calculationBasis: 'Percentage', percentage: 50 },
            { componentCode: 'PF_EE', calculationBasis: 'FLAT', amount: 7200 }
        ]
    };

    const attendance = { calendarDaysInMonth: 30, lopDays: 0, month: 'September 2026' };
    const catalog = [
        { componentCode: 'BASIC', componentType: 'Earning', prorateOnLop: true, isTaxable: true, isPfApplicable: true },
        { componentCode: 'HRA', componentType: 'Earning', prorateOnLop: true, isTaxable: true, isPfApplicable: false },
        { componentCode: 'PF_EE', componentType: 'Deduction', prorateOnLop: true, isTaxable: false }
    ];

    const computedPayroll = payrollCalculationEngine.calculateEmployeePayroll(employee, salaryStructure, attendance, catalog);

    // A. Feed into payrollDocumentService.js
    const docService = new PayrollDocumentService({ db: null });
    const generatedDoc = await payrollCalculationEngine.feedIntoDocumentService(computedPayroll, docService, {
        period: 'September 2026',
        adminId: 'ADMIN_TEST'
    });

    assert.ok(generatedDoc.success, 'Document generation should report success');
    assert.ok(generatedDoc.docId.startsWith('PAY-EMP0099-'), 'Generated payslip docId should encode employee ID');
    assert.equal(generatedDoc.documentRecord.docType, 'Payslip');
    assert.equal(generatedDoc.documentRecord.employeeName, 'Pooja Iyer');
    assert.equal(generatedDoc.documentRecord.security.watermark, 'Kylrx AI Enterprise Confidential');
    assert.ok(generatedDoc.documentRecord.security.sha256Fingerprint, 'Payslip must contain SHA-256 fingerprint');

    // B. Feed into payrollDisbursementService.js (Decentro Fabric payout batch)
    const disbService = new PayrollDisbursementService({ db: null });
    const batch = await payrollCalculationEngine.feedIntoDisbursementService(computedPayroll, disbService, {
        makerId: 'MAKER_ADMIN_77',
        payoutChannel: 'IMPS',
        period: 'September 2026'
    });

    assert.ok(batch.batchId.startsWith('DISB-'), 'Batch ID should be generated');
    assert.equal(batch.status, 'PENDING_APPROVAL', 'Initial batch status must be PENDING_APPROVAL under 4-Eyes governance');
    assert.equal(batch.maker.makerId, 'MAKER_ADMIN_77', 'Batch maker should record initiator ID');
    assert.equal(batch.summary.totalRecords, 1);
    assert.equal(batch.records[0].amount, computedPayroll.netPay);
    assert.equal(batch.records[0].beneficiary.accountNumber, '000105001234');
    assert.equal(batch.records[0].beneficiary.ifsc, 'ICIC0000001');

    // Verify 4-Eyes Maker-Checker authorization gate
    // 1. Same maker cannot approve (should throw MakerCheckerViolationError)
    await assert.rejects(
        async () => {
            await disbService.approveDisbursementBatch(batch.batchId, 'MAKER_ADMIN_77');
        },
        /4-Eyes Violation/
    );

    // 2. Distinct checker can approve
    const approved = await disbService.approveDisbursementBatch(batch.batchId, 'CHECKER_VP_FINANCE');
    assert.equal(approved.batch.status, 'APPROVED');
    assert.equal(approved.batch.checker.checkerId, 'CHECKER_VP_FINANCE');
});
