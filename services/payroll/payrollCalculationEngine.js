/**
 * ============================================================================
 * KYLRX.AI ENTERPRISE HRMS - PAYROLL CALCULATION ENGINE
 * ============================================================================
 * 
 * Centralized dynamic payroll computation pipeline matching PRD Section 4:
 * 1. Loss of Pay (LOP) Proration across scheduled components
 * 2. Statutory Wage Base Aggregation (PF, ESI, PT, TDS)
 * 3. Decoupled integration with:
 *    - payrollDocumentService.js (payslip PDF & Excel generation)
 *    - payrollDisbursementService.js (Decentro Fabric banking batch payouts)
 * 
 * @version 1.0.0
 * @author Principal Fintech & Payroll Systems Architect
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.KylrxPayrollCalculationEngine = factory();
        root.payrollCalculationEngine = root.KylrxPayrollCalculationEngine;
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * Compute full monthly payroll for an employee
     * 
     * @param {Object} employee - Employee master/finance object
     * @param {Object} salaryStructure - Salary structure { components: [...] }
     * @param {Object} attendanceData - { calendarDaysInMonth, lopDays, payableDays }
     * @param {Array|Map} componentCatalog - Active Payroll Components catalog
     * @param {Object} options - Additional calculation options
     * @returns {Object} Complete payroll computation record
     */
    function calculateEmployeePayroll(employee, salaryStructure, attendanceData = {}, componentCatalog = null, options = {}) {
        if (!employee) throw new Error('Missing employee data for payroll calculation.');
        if (!salaryStructure || !Array.isArray(salaryStructure.components)) {
            throw new Error('Missing or invalid salary structure components.');
        }

        const calendarDays = Number(attendanceData.calendarDaysInMonth) || 30;
        const lopDays = Number(attendanceData.lopDays) || 0;
        const paidDays = Math.max(0, calendarDays - lopDays);
        const prorationFactor = Math.round((paidDays / calendarDays) * 10000) / 10000;

        const resolvedComponents = [];
        let grossEarnings = 0;
        let totalDeductions = 0;
        let totalReimbursements = 0;
        let totalEmployerContributions = 0;

        let pfGrossWages = 0;
        let esiGrossWages = 0;
        let ptGrossWages = 0;
        let totalTaxableIncome = 0;

        // Build lookup catalog map
        const catalogMap = new Map();
        if (componentCatalog && Array.isArray(componentCatalog)) {
            componentCatalog.forEach(c => catalogMap.set(String(c.componentCode || c.code || c.Component_Code).toUpperCase(), c));
        }

        // Pass 1: Resolve Scheduled Amounts from Salary Structure
        // Handle FLAT amounts first
        const componentValues = new Map();
        const pendingPercentage = [];

        for (const comp of salaryStructure.components) {
            const code = String(comp.componentCode || comp.Component_Code || comp.code || '').trim().toUpperCase();
            const basis = String(comp.calculationBasis || comp.Calculation_Basis || 'FLAT').trim().toUpperCase();
            const rawAmt = Number(comp.amount !== undefined ? comp.amount : comp.evaluatedAmount);
            const rawPct = Number(comp.percentage);

            if (basis === 'FLAT' && !isNaN(rawAmt)) {
                componentValues.set(code, rawAmt);
            } else if (!isNaN(rawPct)) {
                pendingPercentage.push({ code, basis, pct: rawPct, fallbackAmt: rawAmt });
            } else if (!isNaN(rawAmt)) {
                componentValues.set(code, rawAmt);
            }
        }

        // Default definition for a component that is not in the catalog
        function defaultDefinition(code, comp) {
            const isDeduct = code.includes('DEDUCT') || code.startsWith('PF_') || code.startsWith('ESIC_') || code === 'PT' || code === 'TDS';
            return {
                componentCode: code,
                componentName: comp.componentName || code,
                componentType: isDeduct ? 'Deduction' : 'Earning',
                prorateOnLop: !isDeduct,
                isTaxable: !isDeduct,
                isPfApplicable: code === 'BASIC',
                isEsiApplicable: !isDeduct,
                isPtApplicable: !isDeduct,
                isTdsApplicable: !isDeduct
            };
        }
        function isProrated(def) {
            return (def.prorateOnLop !== false && def.Prorate_On_LOP !== 'No');
        }
        const pendingCodes = new Set(pendingPercentage.map(p => p.code));
        const componentCode = (comp) => String(comp.componentCode || comp.Component_Code || comp.code || '').trim().toUpperCase();

        // Earned (LOP-prorated) amount of every component that is not a percentage of another one.
        // Percentage components (PF 12% of BASIC, HRA 40% of BASIC, ...) are taken from these EARNED
        // amounts, so a month with unpaid leave does not charge PF on the full scheduled basic.
        const earnedBase = new Map();
        for (const comp of salaryStructure.components) {
            const code = componentCode(comp);
            if (pendingCodes.has(code) || !componentValues.has(code)) continue;
            const def = catalogMap.get(code) || defaultDefinition(code, comp);
            const scheduled = componentValues.get(code);
            earnedBase.set(code, isProrated(def) ? Math.round(scheduled * prorationFactor * 100) / 100 : scheduled);
        }
        // Optional PF wage ceiling (for example 15,000): a catalog setting on the PF component
        // (pfWageCeiling / PF_Wage_Ceiling) or options.pfWageCeiling for the whole run. 0/blank = no ceiling.
        function pfCeilingFor(code, def) {
            const isPfContribution = /^PF[_-]/.test(code) || def.isPfContribution === true;
            if (!isPfContribution) return 0;
            const own = Number(def.pfWageCeiling !== undefined ? def.pfWageCeiling : def.PF_Wage_Ceiling);
            if (own > 0) return own;
            const global = Number(options && options.pfWageCeiling);
            return global > 0 ? global : 0;
        }
        const percentageEarned = new Map();

        // Handle Percentage amounts
        for (const item of pendingPercentage) {
            let baseCode = item.basis;
            if (!componentValues.has(baseCode) || baseCode === 'PERCENTAGE' || baseCode === 'PCT') {
                const def = catalogMap.get(item.code);
                if (def && (def.percentageBasis || def.Percentage_Basis)) {
                    baseCode = String(def.percentageBasis || def.Percentage_Basis).trim().toUpperCase();
                } else {
                    baseCode = 'BASIC';
                }
            }
            const baseAmt = componentValues.get(baseCode) || 0;
            const computedAmt = Math.round(((item.pct / 100) * baseAmt) * 100) / 100;
            componentValues.set(item.code, computedAmt || item.fallbackAmt || 0);

            if (earnedBase.has(baseCode) && baseAmt) {
                const pctDef = catalogMap.get(item.code) || defaultDefinition(item.code, { componentName: item.code });
                let earnedBasis = earnedBase.get(baseCode);
                const ceiling = pfCeilingFor(item.code, pctDef);
                if (ceiling > 0) earnedBasis = Math.min(earnedBasis, ceiling);
                percentageEarned.set(item.code, Math.round(((item.pct / 100) * earnedBasis) * 100) / 100);
            }
        }

        // Pass 2: Apply LOP Proration & Classify Statutory Wage Bases
        for (const comp of salaryStructure.components) {
            const code = String(comp.componentCode || comp.Component_Code || comp.code || '').trim().toUpperCase();
            let def = catalogMap.get(code);

            if (!def) def = defaultDefinition(code, comp);

            const scheduledAmount = componentValues.get(code) !== undefined ? componentValues.get(code) : Number(comp.amount || 0);
            
            // Check proration flag
            const shouldProrate = isProrated(def);
            // A percentage-of-component amount already follows the earned basis (never prorated twice)
            const fromEarnedBasis = percentageEarned.has(code);
            const earnedAmount = fromEarnedBasis
                ? percentageEarned.get(code)
                : (shouldProrate
                    ? Math.round(scheduledAmount * prorationFactor * 100) / 100
                    : scheduledAmount);

            const compType = def.componentType || (def.type === 'DEDUCTION' ? 'Deduction' : 'Earning');

            if (compType === 'Earning') {
                grossEarnings += earnedAmount;
                if (def.isPfApplicable || def.PF_Applicable === 'Yes') pfGrossWages += earnedAmtOr(earnedAmount);
                if (def.isEsiApplicable || def.ESI_Applicable === 'Yes') esiGrossWages += earnedAmtOr(earnedAmount);
                if (def.isPtApplicable || def.PT_Applicable === 'Yes') ptGrossWages += earnedAmtOr(earnedAmount);
                if (def.isTaxable !== false && def.Taxable !== 'No') totalTaxableIncome += earnedAmtOr(earnedAmount);
            } else if (compType === 'Deduction') {
                totalDeductions += earnedAmount;
            } else if (compType === 'Reimbursement') {
                totalReimbursements += earnedAmount;
            } else if (compType === 'Employer_Contribution') {
                totalEmployerContributions += earnedAmount;
            }

            resolvedComponents.push({
                componentCode: code,
                componentName: def.componentName || comp.componentName || code,
                componentType: compType,
                calculationMethod: def.calculationMethod || comp.calculationBasis || 'Flat_Amount',
                scheduledAmount,
                earnedAmount,
                prorated: ((shouldProrate || fromEarnedBasis) && prorationFactor < 1.0),
                isTaxable: Boolean(def.isTaxable),
                isPfApplicable: Boolean(def.isPfApplicable),
                isEsiApplicable: Boolean(def.isEsiApplicable),
                isPtApplicable: Boolean(def.isPtApplicable),
                isTdsApplicable: Boolean(def.isTdsApplicable)
            });
        }

        function earnedAmtOr(amt) {
            return isNaN(amt) ? 0 : amt;
        }

        const netPay = Math.round((grossEarnings - totalDeductions + totalReimbursements) * 100) / 100;

        // Output format compatible with payrollDocumentService & payrollDisbursementService
        return {
            employeeId: employee.employeeId || employee.id || employee.Employee_ID,
            employeeName: employee.employeeName || employee.name || `${employee.firstName || ''} ${employee.lastName || ''}`.trim() || 'Employee',
            pan: employee.pan || employee.panNumber || '',
            bankName: employee.bankName || employee.Bank_Name || 'Standard Bank',
            accountNumber: employee.accountNumber || employee.Account_Number || '',
            ifsc: employee.ifsc || employee.IFSC || '',
            month: attendanceData.month || new Date().toISOString().substring(0, 7),
            calendarDays,
            lopDays,
            paidDays,
            prorationFactor,
            grossEarnings: Math.round(grossEarnings * 100) / 100,
            totalDeductions: Math.round(totalDeductions * 100) / 100,
            totalReimbursements: Math.round(totalReimbursements * 100) / 100,
            totalEmployerContributions: Math.round(totalEmployerContributions * 100) / 100,
            netPay: Math.max(0, netPay),
            netPayable: Math.max(0, netPay), // Alias for service compatibility
            statutoryWageBases: {
                pfGross: Math.round(pfGrossWages * 100) / 100,
                esiGross: Math.round(esiGrossWages * 100) / 100,
                ptGross: Math.round(ptGrossWages * 100) / 100,
                taxableGross: Math.round(totalTaxableIncome * 100) / 100
            },
            components: resolvedComponents,
            // Pre-structured payout payload for Decentro Fabric
            disbursementPayload: {
                beneficiaryId: employee.employeeId || employee.id,
                beneficiaryName: employee.employeeName || employee.name,
                accountNumber: employee.accountNumber || employee.Account_Number,
                ifsc: employee.ifsc || employee.IFSC,
                amount: Math.max(0, netPay),
                paymentReference: `PAY_${employee.employeeId || employee.id}_${Date.now()}`
            }
        };
    }

    /**
     * Compute monthly payroll for a batch of employees
     */
    function calculateBatchPayroll(employees = [], salaryStructureMap = new Map(), attendanceMap = new Map(), componentCatalog = null, options = {}) {
        const results = [];
        for (const emp of employees) {
            const empId = emp.employeeId || emp.id || emp.Employee_ID;
            let structure = null;
            if (salaryStructureMap instanceof Map) {
                structure = salaryStructureMap.get(empId) || salaryStructureMap.get('DEFAULT');
            } else if (typeof salaryStructureMap === 'object' && salaryStructureMap !== null) {
                structure = salaryStructureMap[empId] || salaryStructureMap.default || salaryStructureMap;
            }
            if (!structure && emp.salaryStructure) {
                structure = emp.salaryStructure;
            }

            let attendance = {};
            if (attendanceMap instanceof Map) {
                attendance = attendanceMap.get(empId) || {};
            } else if (typeof attendanceMap === 'object' && attendanceMap !== null) {
                attendance = attendanceMap[empId] || {};
            }

            if (structure) {
                const comp = calculateEmployeePayroll(emp, structure, attendance, componentCatalog, options);
                results.push(comp);
            }
        }
        return results;
    }

    /**
     * Feed computed payroll breakdowns into payrollDocumentService.js
     * 
     * @param {Object|Array} computedPayroll - Single or batch calculation output
     * @param {Object} documentService - Instance of PayrollDocumentService
     * @param {Object} options - Options including period, adminId, etc.
     * @returns {Promise<Object|Array>} Generated payslip document records
     */
    async function feedIntoDocumentService(computedPayroll, documentService, options = {}) {
        if (!documentService || typeof documentService.generatePayslipDocument !== 'function') {
            throw new Error('Invalid PayrollDocumentService instance provided.');
        }

        const items = Array.isArray(computedPayroll) ? computedPayroll : [computedPayroll];
        const results = [];

        for (const item of items) {
            const empAdapt = {
                id: item.employeeId,
                employeeId: item.employeeId,
                name: item.employeeName,
                employeeName: item.employeeName,
                grossSalary: item.grossEarnings,
                salary: item.grossEarnings,
                netPayable: item.netPay,
                salaryStructure: {
                    components: item.components
                }
            };
            const period = options.period || item.month || 'September 2026';
            const metadata = {
                periodDays: item.calendarDays,
                lopDays: item.lopDays,
                adminId: options.adminId || 'PAYROLL_ADMIN',
                ...options
            };
            const doc = await documentService.generatePayslipDocument(empAdapt, period, metadata);
            results.push(doc);
        }

        return Array.isArray(computedPayroll) ? results : results[0];
    }

    /**
     * Feed computed payroll breakdowns into payrollDisbursementService.js
     * 
     * @param {Array|Object} computedPayroll - Single or batch calculation output
     * @param {Object} disbursementService - Instance of PayrollDisbursementService
     * @param {Object} options - Options including makerId, period, batchId, payoutChannel
     * @returns {Promise<Object>} Created disbursement batch record
     */
    async function feedIntoDisbursementService(computedPayroll, disbursementService, options = {}) {
        if (!disbursementService || typeof disbursementService.createDisbursementBatch !== 'function') {
            throw new Error('Invalid PayrollDisbursementService instance provided.');
        }

        const items = Array.isArray(computedPayroll) ? computedPayroll : [computedPayroll];
        const disbursementEmployees = items.map(item => ({
            id: item.employeeId,
            employeeId: item.employeeId,
            name: item.employeeName,
            employeeName: item.employeeName,
            netPayable: item.netPay,
            financeDetails: {
                Account_Holder_Name: item.employeeName,
                Bank_Name: item.bankName,
                Account_Number: item.accountNumber,
                IFSC: item.ifsc,
                Account_Type: 'Savings',
                Is_Primary: true
            }
        }));

        const batch = await disbursementService.createDisbursementBatch({
            batchId: options.batchId || `DISB-ENG-${Date.now()}`,
            period: options.period || (items[0] && items[0].month) || 'September 2026',
            makerId: options.makerId || 'MAKER_ADMIN_01',
            payoutChannel: options.payoutChannel || 'IMPS',
            employees: disbursementEmployees
        });

        return batch;
    }

    return {
        calculateEmployeePayroll,
        calculateBatchPayroll,
        feedIntoDocumentService,
        feedIntoDisbursementService
    };
}));
