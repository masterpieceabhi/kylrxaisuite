/**
 * ============================================================================
 * KYLRX.AI ENTERPRISE HRMS - UNIFIED JOB & ROSTER UPDATES PARSER
 * ============================================================================
 * 
 * Unified Template 1 Parser matching PRD Sections 1, 3, 4, 11, & 13:
 * Ingests, validates, deduplicates, and normalizes Employee Job & Roster records
 * from Excel (.xlsx/.xls) or CSV files.
 * 
 * Exact 11 Header Fields:
 * 1.  Employee_ID (string, foreign key)
 * 2.  Organization_ID (string, tenant key)
 * 3.  Effective_Date (ISO Date: YYYY-MM-DD)
 * 4.  Department_Code (string)
 * 5.  Designation_Title (string)
 * 6.  Annual_CTC (number, updated annual cost to company)
 * 7.  Shift_Roster_Code (string, e.g., "SHIFT_GEN_9_6", "SHIFT_ROT_NIGHT")
 * 8.  Week_Off_Pattern (string enum: "SAT_SUN_FIXED", "ROTATIONAL_5_DAY", "SUN_ONLY", "CUSTOM_WEEK_OFF")
 * 9.  Custom_Week_Off_Days (comma-separated string, e.g., "Saturday,Sunday" or "Sunday")
 * 10. Reason_For_Update (string, e.g., "Annual Increment", "Promotion", "Shift Rotation")
 * 11. Active (boolean)
 * 
 * @version 2.0.0
 * @author Principal Full-Stack & Enterprise Systems Architect
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define(['xlsx'], factory);
    } else if (typeof module === 'object' && module.exports) {
        let xlsxModule;
        try {
            xlsxModule = require('xlsx');
        } catch (e) {
            xlsxModule = null;
        }
        module.exports = factory(xlsxModule);
    } else {
        root.KylrxJobRosterParser = factory(root.XLSX);
        root.jobRosterParser = root.KylrxJobRosterParser;
    }
}(typeof self !== 'undefined' ? self : this, function (XLSX) {
    'use strict';

    // Canonical Header Synonyms for resilient CSV / Excel column mapping
    const HEADER_SYNONYMS = {
        employeeId: [
            'employee_id', 'employeeid', 'emp_id', 'empid', 'emp id', 'employee no', 'staff_id', 'id'
        ],
        organizationId: [
            'organization_id', 'organizationid', 'org_id', 'orgid', 'tenant_id', 'tenantid', 'company_id', 'org'
        ],
        effectiveDate: [
            'effective_date', 'effectivedate', 'effective_from', 'effectivefrom', 'start_date', 'date', 'valid_from'
        ],
        departmentCode: [
            'department_code', 'departmentcode', 'dept_code', 'deptcode', 'department', 'dept', 'dept_id'
        ],
        designationTitle: [
            'designation_title', 'designationtitle', 'designation', 'job_title', 'jobtitle', 'title', 'position', 'role'
        ],
        employeeName: ['employee_name', 'employeename', 'full_name', 'fullname', 'name'],
        officialEmail: ['official_email', 'officialemail', 'work_email', 'workemail', 'email', 'email_address'],
        annualCtc: [
            'annual_ctc', 'annualctc', 'ctc', 'total_ctc', 'cost_to_company', 'annual_salary', 'package', 'gross_ctc'
        ],
        shiftRosterCode: [
            'shift_roster_code', 'shiftrostercode', 'shift_code', 'shiftcode', 'roster_code', 'rostercode', 'shift', 'roster'
        ],
        weekOffPattern: [
            'week_off_pattern', 'weekoffpattern', 'week_off', 'weekoff', 'off_days_pattern', 'weekly_off', 'week_off_type'
        ],
        customWeekOffDays: [
            'custom_week_off_days', 'customweekoffdays', 'custom_week_off', 'custom_off_days', 'custom_days', 'off_days', 'custom_weekoffs'
        ],
        reasonForUpdate: [
            'reason_for_update', 'reasonforupdate', 'reason', 'update_reason', 'change_reason', 'remarks', 'event_type'
        ],
        active: [
            'active', 'is_active', 'isactive', 'status', 'enabled', 'is_enabled'
        ]
    };

    /**
     * Allowed Week Off Pattern Enums
     */
    const VALID_WEEK_OFF_PATTERNS = [
        'SAT_SUN_FIXED',
        'ROTATIONAL_5_DAY',
        'SUN_ONLY',
        'CUSTOM_WEEK_OFF'
    ];

    /**
     * Standard Day Names
     */
    const VALID_DAY_NAMES = [
        'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'
    ];

    /**
     * Canonical 11 Attributes Schema Definition
     */
    const JOB_ROSTER_ATTRIBUTES = [
        { key: "Employee_ID", label: "1. Employee ID", required: true, synonyms: HEADER_SYNONYMS.employeeId },
        { key: "Organization_ID", label: "2. Organization ID", required: false, defaultValue: "ORG_KYLRX_CORP", synonyms: HEADER_SYNONYMS.organizationId },
        { key: "Effective_Date", label: "3. Effective Date (YYYY-MM-DD)", required: true, defaultValue: "2026-01-01", synonyms: HEADER_SYNONYMS.effectiveDate },
        { key: "Department_Code", label: "4. Department Code", required: true, synonyms: HEADER_SYNONYMS.departmentCode },
        { key: "Designation_Title", label: "5. Designation Title", required: true, synonyms: HEADER_SYNONYMS.designationTitle },
        { key: "Annual_CTC", label: "6. Annual CTC (INR)", required: true, synonyms: HEADER_SYNONYMS.annualCtc },
        { key: "Shift_Roster_Code", label: "7. Shift Roster Code", required: true, defaultValue: "SHIFT_GEN_9_6", synonyms: HEADER_SYNONYMS.shiftRosterCode },
        { key: "Week_Off_Pattern", label: "8. Week Off Pattern", required: true, defaultValue: "SAT_SUN_FIXED", synonyms: HEADER_SYNONYMS.weekOffPattern },
        { key: "Custom_Week_Off_Days", label: "9. Custom Week Off Days", required: false, synonyms: HEADER_SYNONYMS.customWeekOffDays },
        { key: "Reason_For_Update", label: "10. Reason For Update", required: false, defaultValue: "Annual Increment", synonyms: HEADER_SYNONYMS.reasonForUpdate },
        { key: "Active", label: "11. Active (Yes/No)", required: false, defaultValue: true, synonyms: HEADER_SYNONYMS.active }
    ];

    /**
     * Sanitizes boolean string / numeric representations into boolean
     */
    function sanitizeBoolean(val, defaultVal = true) {
        if (val === undefined || val === null || val === '') return defaultVal;
        if (typeof val === 'boolean') return val;
        if (typeof val === 'number') return val === 1;
        const s = String(val).trim().toLowerCase();
        if (['yes', 'y', 'true', 't', '1', 'active', 'applicable', 'enabled'].includes(s)) return true;
        if (['no', 'n', 'false', 'f', '0', 'inactive', 'not applicable', 'disabled'].includes(s)) return false;
        return defaultVal;
    }

    /**
     * Formats date string to YYYY-MM-DD
     */
    function formatDate(val) {
        if (!val) return new Date().toISOString().split('T')[0];
        if (val instanceof Date && !isNaN(val.getTime())) {
            const y = val.getFullYear();
            const m = String(val.getMonth() + 1).padStart(2, '0');
            const d = String(val.getDate()).padStart(2, '0');
            return `${y}-${m}-${d}`;
        }
        const s = String(val).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(s)) {
            const parts = s.split(/[-/]/);
            return `${parts[2]}-${parts[1].padStart(2, '0')}-${parts[0].padStart(2, '0')}`;
        }
        // Excel serial date number
        if (!isNaN(Number(s)) && Number(s) > 20000 && Number(s) < 80000) {
            const date = new Date((Number(s) - (25567 + 2)) * 86400 * 1000);
            return date.toISOString().split('T')[0];
        }
        return s;
    }

    /**
     * Normalizes Week Off Pattern
     */
    function normalizeWeekOffPattern(val) {
        if (!val) return 'SAT_SUN_FIXED';
        const clean = String(val).trim().toUpperCase().replace(/[\s-]+/g, '_');
        if (clean.includes('SAT') && clean.includes('SUN')) return 'SAT_SUN_FIXED';
        if (clean.includes('ROTAT') || clean.includes('5_DAY') || clean.includes('5DAY')) return 'ROTATIONAL_5_DAY';
        if (clean.includes('SUN') && !clean.includes('SAT')) return 'SUN_ONLY';
        if (clean.includes('CUSTOM')) return 'CUSTOM_WEEK_OFF';
        if (VALID_WEEK_OFF_PATTERNS.includes(clean)) return clean;
        return 'SAT_SUN_FIXED';
    }

    /**
     * Sanitizes and validates custom week off days
     */
    function sanitizeCustomWeekOffDays(val, pattern) {
        if (!val) {
            if (pattern === 'SAT_SUN_FIXED') return 'Saturday,Sunday';
            if (pattern === 'SUN_ONLY') return 'Sunday';
            if (pattern === 'ROTATIONAL_5_DAY') return 'Rotational (2 Days)';
            return '';
        }
        const parts = String(val).split(/[,|;/]+/).map(p => p.trim()).filter(Boolean);
        const capitalized = parts.map(p => {
            const lower = p.toLowerCase();
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        });
        return capitalized.join(',');
    }

    /**
     * Finds normalized field value from row using synonyms
     */
    function findField(row, fieldKey) {
        if (!row || typeof row !== 'object') return undefined;
        const synonyms = HEADER_SYNONYMS[fieldKey] || [];
        
        // Exact property match
        if (row[fieldKey] !== undefined && row[fieldKey] !== '') return row[fieldKey];

        const rowKeys = Object.keys(row);

        // Pass 1: Case-insensitive match on fieldKey
        for (const key of rowKeys) {
            if (key.trim().toLowerCase() === fieldKey.toLowerCase()) {
                if (row[key] !== undefined && row[key] !== '') return row[key];
            }
        }

        // Pass 2: Canonical synonym match
        for (const syn of synonyms) {
            const normSyn = syn.toLowerCase().replace(/[\s\-_()]+/g, '_');
            for (const key of rowKeys) {
                const normalizedKey = key.trim().toLowerCase().replace(/[\s\-_()]+/g, '_');
                if (normalizedKey === normSyn) {
                    if (row[key] !== undefined && row[key] !== '') return row[key];
                }
            }
        }

        // Pass 3: Fuzzy boundary match
        for (const syn of synonyms) {
            if (syn.length < 4) continue;
            const normSyn = syn.toLowerCase().replace(/[\s\-_()]+/g, '_');
            for (const key of rowKeys) {
                const normalizedKey = key.trim().toLowerCase().replace(/[\s\-_()]+/g, '_');
                if (normalizedKey.startsWith(normSyn + '_') || normalizedKey.endsWith('_' + normSyn)) {
                    if (row[key] !== undefined && row[key] !== '') return row[key];
                }
            }
        }

        return undefined;
    }

    /**
     * Validates and normalizes a single raw row object
     */
    function validateRow(rawRow, index = 0, defaultOrgId = 'ORG_KYLRX_CORP') {
        const errors = [];
        const warnings = [];

        // 1. Employee_ID
        let employeeId = findField(rawRow, 'employeeId');
        if (employeeId === undefined || employeeId === null || String(employeeId).trim() === '') {
            errors.push('Employee_ID is required.');
            employeeId = '';
        } else {
            employeeId = String(employeeId).trim().toUpperCase();
        }

        // 2. Organization_ID
        let orgId = findField(rawRow, 'organizationId');
        if (!orgId || String(orgId).trim() === '') {
            orgId = defaultOrgId;
        } else {
            orgId = String(orgId).trim();
        }

        // 3. Effective_Date
        let effectiveDateRaw = findField(rawRow, 'effectiveDate');
        let effectiveDate = formatDate(effectiveDateRaw);
        if (!effectiveDateRaw || !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
            warnings.push('Effective_Date was invalid or missing; defaulted to current date.');
            effectiveDate = new Date().toISOString().split('T')[0];
        }

        // 4. Department_Code
        let departmentCode = findField(rawRow, 'departmentCode');
        if (departmentCode === undefined || departmentCode === null || String(departmentCode).trim() === '') {
            errors.push('Department_Code is required.');
            departmentCode = '';
        } else {
            departmentCode = String(departmentCode).trim().toUpperCase();
        }

        // 5. Designation_Title
        let designationTitle = findField(rawRow, 'designationTitle');
        if (designationTitle === undefined || designationTitle === null || String(designationTitle).trim() === '') {
            errors.push('Designation_Title is required.');
            designationTitle = '';
        } else {
            designationTitle = String(designationTitle).trim();
        }

        // 6. Annual_CTC
        let annualCtcRaw = findField(rawRow, 'annualCtc');
        let annualCtc = 0;
        if (annualCtcRaw === undefined || annualCtcRaw === null || String(annualCtcRaw).trim() === '') {
            errors.push('Annual_CTC is required.');
        } else {
            const cleanNum = String(annualCtcRaw).replace(/[₹,\s]/g, '');
            annualCtc = Number(cleanNum);
            if (isNaN(annualCtc) || annualCtc < 0) {
                errors.push(`Annual_CTC must be a valid positive number, received: "${annualCtcRaw}".`);
                annualCtc = 0;
            }
        }

        // 7. Shift_Roster_Code
        let shiftRosterCode = findField(rawRow, 'shiftRosterCode');
        if (!shiftRosterCode || String(shiftRosterCode).trim() === '') {
            shiftRosterCode = 'SHIFT_GEN_9_6';
        } else {
            shiftRosterCode = String(shiftRosterCode).trim().toUpperCase();
        }

        // 8. Week_Off_Pattern
        let weekOffPatternRaw = findField(rawRow, 'weekOffPattern');
        let weekOffPattern = normalizeWeekOffPattern(weekOffPatternRaw);

        // 9. Custom_Week_Off_Days
        let customWeekOffDaysRaw = findField(rawRow, 'customWeekOffDays');
        let customWeekOffDays = sanitizeCustomWeekOffDays(customWeekOffDaysRaw, weekOffPattern);
        if (weekOffPattern === 'CUSTOM_WEEK_OFF' && !customWeekOffDays) {
            errors.push('Custom_Week_Off_Days is required when Week_Off_Pattern is CUSTOM_WEEK_OFF.');
        }

        // 10. Reason_For_Update
        let reasonForUpdate = findField(rawRow, 'reasonForUpdate');
        if (!reasonForUpdate || String(reasonForUpdate).trim() === '') {
            reasonForUpdate = 'Annual Increment / Routine Roster Realignment';
        } else {
            reasonForUpdate = String(reasonForUpdate).trim();
        }

        // 11. Active
        let activeRaw = findField(rawRow, 'active');
        let active = sanitizeBoolean(activeRaw, true);

        // Optional extras (not part of the 11 core attributes): used to create a profile for a new person
        const employeeNameRaw = findField(rawRow, 'employeeName');
        const officialEmailRaw = findField(rawRow, 'officialEmail');
        const optionalPeople = {};
        if (employeeNameRaw && String(employeeNameRaw).trim()) optionalPeople.Employee_Name = String(employeeNameRaw).trim();
        if (officialEmailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(officialEmailRaw).trim())) optionalPeople.Official_Email = String(officialEmailRaw).trim().toLowerCase();

        const normalizedRecord = {
            rowIndex: index + 1,
            Employee_ID: employeeId,
            Organization_ID: orgId,
            ...optionalPeople,
            Effective_Date: effectiveDate,
            Department_Code: departmentCode,
            Designation_Title: designationTitle,
            Annual_CTC: annualCtc,
            Shift_Roster_Code: shiftRosterCode,
            Week_Off_Pattern: weekOffPattern,
            Custom_Week_Off_Days: customWeekOffDays,
            Reason_For_Update: reasonForUpdate,
            Active: active,
            isValid: errors.length === 0,
            errors,
            warnings
        };

        return normalizedRecord;
    }

    /**
     * Parses array of raw row objects
     */
    function parseArray(rawRows, options = {}) {
        const defaultOrgId = options.defaultOrgId || options.orgId || 'ORG_KYLRX_CORP';
        if (!Array.isArray(rawRows)) {
            return {
                success: false,
                count: 0,
                validRows: [],
                invalidRows: [],
                data: [],
                errors: ['Input data is not a valid array of row records.'],
                warnings: []
            };
        }

        const validRows = [];
        const invalidRows = [];
        const allRecords = [];
        const seenEmployeeIds = new Set();
        const globalWarnings = [];

        rawRows.forEach((raw, idx) => {
            // Skip empty rows
            const values = Object.values(raw).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
            if (values.length === 0) return;

            const record = validateRow(raw, idx, defaultOrgId);

            // Deduplication warning
            if (record.Employee_ID) {
                if (seenEmployeeIds.has(record.Employee_ID)) {
                    record.warnings.push(`Duplicate Employee_ID "${record.Employee_ID}" in current batch; will overwrite previous row in batch.`);
                }
                seenEmployeeIds.add(record.Employee_ID);
            }

            allRecords.push(record);
            if (record.isValid) {
                validRows.push(record);
            } else {
                invalidRows.push(record);
            }
        });

        return {
            success: invalidRows.length === 0 && validRows.length > 0,
            count: allRecords.length,
            validCount: validRows.length,
            invalidCount: invalidRows.length,
            validRows,
            invalidRows,
            data: allRecords,
            errors: invalidRows.flatMap(r => r.errors.map(err => `Row ${r.rowIndex} (${r.Employee_ID || 'No ID'}): ${err}`)),
            warnings: globalWarnings.concat(allRecords.flatMap(r => r.warnings.map(w => `Row ${r.rowIndex} (${r.Employee_ID || 'No ID'}): ${w}`)))
        };
    }

    /**
     * Parses workbook / binary / text file data
     */
    function parse(fileData, options = {}) {
        let sheetJs = options.xlsx || XLSX;
        if (!sheetJs && typeof window !== 'undefined' && window.XLSX) {
            sheetJs = window.XLSX;
        }

        if (!sheetJs) {
            throw new Error("SheetJS (XLSX) library is required to parse spreadsheet files.");
        }

        let workbook;
        try {
            if (typeof fileData === 'string') {
                workbook = sheetJs.read(fileData, { type: 'string', cellDates: true });
            } else if (fileData instanceof ArrayBuffer || ArrayBuffer.isView(fileData)) {
                workbook = sheetJs.read(fileData, { type: 'array', cellDates: true });
            } else {
                workbook = sheetJs.read(fileData, { type: 'binary', cellDates: true });
            }
        } catch (err) {
            return {
                success: false,
                count: 0,
                validRows: [],
                invalidRows: [],
                data: [],
                errors: [`Failed to parse spreadsheet file: ${err.message}`],
                warnings: []
            };
        }

        // Sheet selection: priority to 'Job & Roster' / 'Job Details' / 'Roster' / first sheet
        let targetSheetName = workbook.SheetNames[0];
        const preferredSheets = ['Job & Roster', 'Job and Roster', 'Job_Roster', 'Employee Job', 'Job Details', 'Roster Updates', 'Roster'];
        for (const name of preferredSheets) {
            const match = workbook.SheetNames.find(s => s.trim().toLowerCase() === name.toLowerCase());
            if (match) {
                targetSheetName = match;
                break;
            }
        }

        const sheet = workbook.Sheets[targetSheetName];
        if (!sheet) {
            return {
                success: false,
                count: 0,
                validRows: [],
                invalidRows: [],
                data: [],
                errors: [`Sheet "${targetSheetName}" not found in workbook.`],
                warnings: []
            };
        }

        const rawRows = sheetJs.utils.sheet_to_json(sheet, { defval: '', raw: false });
        const result = parseArray(rawRows, options);
        result.sheetName = targetSheetName;
        result.sheetNames = workbook.SheetNames;
        return result;
    }

    /**
     * Generates a sample CSV template for Job & Roster Updates
     */
    function generateTemplateCSV() {
        const headers = JOB_ROSTER_ATTRIBUTES.map(a => a.key).join(',');
        const sampleRows = [
            'EMP0001,ORG_KYLRX_CORP,2026-04-01,DEP_ENG,Principal Engineer,2400000,SHIFT_GEN_9_6,SAT_SUN_FIXED,"Saturday,Sunday",Annual Increment,Yes',
            'EMP0002,ORG_KYLRX_CORP,2026-04-01,DEP_HR,Senior HR Operations Lead,1200000,SHIFT_GEN_9_6,SAT_SUN_FIXED,"Saturday,Sunday",Promotion,Yes',
            'EMP0003,ORG_KYLRX_CORP,2026-04-01,DEP_OPS,Operations Specialist,720000,SHIFT_ROT_NIGHT,ROTATIONAL_5_DAY,"Tuesday,Wednesday",Shift Rotation,Yes'
        ];
        return [headers, ...sampleRows].join('\n');
    }

    /**
     * Generates downloadable Excel Template using SheetJS
     */
    function generateTemplateWorkbook(options = {}) {
        let sheetJs = options.xlsx || XLSX;
        if (!sheetJs && typeof window !== 'undefined' && window.XLSX) {
            sheetJs = window.XLSX;
        }
        if (!sheetJs) throw new Error("SheetJS is required to generate Excel workbook.");

        const headers = JOB_ROSTER_ATTRIBUTES.map(a => a.key);
        const data = [
            headers,
            ['EMP0001', 'ORG_KYLRX_CORP', '2026-04-01', 'DEP_ENG', 'Principal Engineer', 2400000, 'SHIFT_GEN_9_6', 'SAT_SUN_FIXED', 'Saturday,Sunday', 'Annual Increment', 'Yes'],
            ['EMP0002', 'ORG_KYLRX_CORP', '2026-04-01', 'DEP_HR', 'Senior HR Operations Lead', 1200000, 'SHIFT_GEN_9_6', 'SAT_SUN_FIXED', 'Saturday,Sunday', 'Promotion', 'Yes'],
            ['EMP0003', 'ORG_KYLRX_CORP', '2026-04-01', 'DEP_OPS', 'Operations Specialist', 720000, 'SHIFT_ROT_NIGHT', 'ROTATIONAL_5_DAY', 'Tuesday,Wednesday', 'Shift Rotation', 'Yes']
        ];

        const ws = sheetJs.utils.aoa_to_sheet(data);
        const wb = sheetJs.utils.book_new();
        sheetJs.utils.book_append_sheet(wb, ws, "Job & Roster");
        return wb;
    }

    return {
        JOB_ROSTER_ATTRIBUTES,
        HEADER_SYNONYMS,
        VALID_WEEK_OFF_PATTERNS,
        parse,
        parseArray,
        validateRow,
        formatDate,
        normalizeWeekOffPattern,
        sanitizeBoolean,
        generateTemplateCSV,
        generateTemplateWorkbook
    };
}));
