const express = require('express');
const router = express.Router();
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { requireUsOrg, audit } = require('./us-hr').helpers;
const svc = require('../services/us-people-service');

const MAX_BULK_ROWS = 500;

router.use(verifyToken);

/** Spreadsheet column names (snake_case) -> the nested shape the validators use */
function fromRow(row) {
    const g = (k) => (row[k] === undefined || row[k] === null ? '' : String(row[k]).trim());
    const input = {
        firstName: g('first_name'), lastName: g('last_name'), email: g('email'), phone: g('phone'),
        role: g('role') || 'employee', startDate: g('start_date'), jobTitle: g('job_title'), department: g('department')
    };
    const hasProfile = ['work_state', 'classification', 'pay_type', 'pay_rate', 'date_of_birth', 'ssn'].some((k) => g(k));
    if (hasProfile) {
        input.profile = {
            dateOfBirth: g('date_of_birth'),
            homeAddress: { line1: g('address_line1'), city: g('city'), state: g('state'), zip: g('zip') },
            workState: g('work_state'), classification: g('classification'), flsaStatus: g('flsa_status') || undefined,
            employmentType: g('employment_type') || 'full_time', payType: g('pay_type'), payFrequency: g('pay_frequency') || 'biweekly',
            payRate: g('pay_rate'), taxpayerId: g('ssn') || undefined, taxpayerIdType: g('id_type') || 'SSN'
        };
    }
    return input;
}

/** Add one employee. The temporary password is returned once and never stored in readable form. */
router.post('/employees', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const validated = svc.validatePerson(req.body);
    if (validated.errors.length) return res.status(400).json({ success: false, errors: validated.errors });
    if (await svc.emailTaken(validated.value.email)) {
        return res.status(409).json({ success: false, error: 'That email already has an account' });
    }
    const [employeeId] = await svc.allocateEmployeeIds(req.orgId, 1);
    const created = await svc.createPerson(req.orgId, validated, employeeId, req.user.id);
    audit(req.orgId, req, 'us_employee_created', created.uid, { employeeId, role: created.role });
    res.status(201).json({ success: true, employee: created });
});

/**
 * Add many employees from a file (the page parses the .csv/.xlsx and sends rows).
 * dryRun=true checks every row and creates nothing.
 */
router.post('/employees/bulk', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
    const dryRun = Boolean(req.body && req.body.dryRun);
    if (!rows || rows.length === 0) return res.status(400).json({ success: false, error: 'rows is required' });
    if (rows.length > MAX_BULK_ROWS) return res.status(400).json({ success: false, error: `At most ${MAX_BULK_ROWS} rows per upload` });

    const results = [];
    const seen = new Set();
    const valid = [];
    for (let i = 0; i < rows.length; i++) {
        const rowNumber = i + 2; // spreadsheet row (row 1 is the header)
        const validated = svc.validatePerson(fromRow(rows[i]));
        const email = validated.value.email;
        if (email && seen.has(email)) validated.errors.push('email appears more than once in this file');
        if (email) seen.add(email);
        if (validated.errors.length === 0 && await svc.emailTaken(email)) validated.errors.push('that email already has an account');
        if (validated.errors.length) results.push({ row: rowNumber, email, status: 'error', errors: validated.errors });
        else { valid.push({ rowNumber, validated }); results.push({ row: rowNumber, email, status: dryRun ? 'ok' : 'pending' }); }
    }

    if (!dryRun && valid.length) {
        const ids = await svc.allocateEmployeeIds(req.orgId, valid.length);
        for (let i = 0; i < valid.length; i++) {
            const { rowNumber, validated } = valid[i];
            const slot = results.find((r) => r.row === rowNumber);
            try {
                const created = await svc.createPerson(req.orgId, validated, ids[i], req.user.id);
                Object.assign(slot, { status: 'created', employeeId: created.employeeId, name: created.name, temporaryPassword: created.temporaryPassword });
            } catch (error) {
                Object.assign(slot, { status: 'error', errors: [`could not create: ${error.message}`] });
            }
        }
        audit(req.orgId, req, 'us_employees_bulk_created', req.orgId, { created: results.filter((r) => r.status === 'created').length, rows: rows.length });
    }

    res.set('Cache-Control', 'no-store');
    res.json({
        success: true, dryRun,
        summary: {
            rows: rows.length,
            ok: results.filter((r) => r.status === 'ok' || r.status === 'created').length,
            errors: results.filter((r) => r.status === 'error').length
        },
        results
    });
});

module.exports = router;
