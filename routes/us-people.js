const express = require('express');
const router = express.Router();
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, findEmployee, audit } = require('./us-hr').helpers;
const { requirePermission } = require('../services/permissions');
const svc = require('../services/us-people-service');
const R = require('../services/team-import-rules');
const L = require('../services/access-link-rules');
const { validateTaxpayerId } = require('../services/us-validation');
const Mail = require('../services/team-invite-emails');
const { emailReady } = require('../services/email-notices');

const MAX_BULK_ROWS = 500;

// Who may use these routes (services/permissions.js decides which roles hold the permission):
//   add people (one, from a file, from a pasted sheet), make and stop links, approve join requests,
//   give a person a new temporary password or set-up link                                   people.write
const PEOPLE_WRITE = requirePermission('people.write');

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
router.post('/employees', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const validated = svc.validatePerson(req.body);
    if (validated.errors.length) return res.status(400).json({ success: false, errors: validated.errors });
    if (await svc.emailTaken(validated.value.email)) {
        return res.status(409).json({ success: false, error: 'That email already has an account' });
    }
    const [employeeId] = await svc.allocateEmployeeIds(req.orgId, 1);
    const created = await svc.createPerson(req.orgId, validated, employeeId, req.user.id);
    audit(req.orgId, req, 'us_employee_created', created.uid, { employeeId, role: created.role });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, employee: created });
});

/**
 * Add many employees from a file (the page parses the .csv/.xlsx and sends rows).
 * dryRun=true checks every row and creates nothing.
 */
router.post('/employees/bulk', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
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

// =====================================================================================================================
// Team import: paste a sheet or pick a file, check the guessed columns, fix rows on screen, create the good ones.
// The reading and guessing is in services/team-import-rules.js; creation is the same code as the routes above.
// =====================================================================================================================

/** The fields a column can be matched to, and the limits (for the page) */
router.get('/team-import/fields', PEOPLE_WRITE, requireUsOrg, (req, res) => {
    res.json({ success: true, fields: R.FIELDS, maxRows: R.MAX_ROWS, passwordRules: L.PASSWORD_RULES_TEXT, setupLinkDays: L.SETUP_LINK_DAYS, joinLinkMaxDays: L.JOIN_LINK_MAX_DAYS, openLinkMaxHours: L.OPEN_LINK_MAX_HOURS, openLinkMaxPeople: L.OPEN_LINK_MAX_PEOPLE, maxApproveAtOnce: L.MAX_APPROVE_AT_ONCE, emailReady: emailReady() });
});

/** Reads the sheet (rows of cells from a file, or pasted text) and guesses what each column is. Stores nothing. */
router.post('/team-import/analyze', PEOPLE_WRITE, requireUsOrg, (req, res) => {
    const b = req.body || {};
    // Pasted or uploaded text (CSV, tab-separated, or a phone contacts .vcf), contacts picked on the phone, or file rows
    const text = typeof b.text === 'string' ? b.text.slice(0, 5000000) : null;
    const table = text !== null ? (R.isVcf(text) ? R.parseVcf(text) : R.parsePasted(text)) : (Array.isArray(b.contacts) ? R.contactsToTable(b.contacts) : b.rows);
    const { errors, rows } = R.cleanTable(table);
    if (!errors.length && rows.length === 0) errors.push('There is nothing to read. Paste the rows you copied, or choose a file.');
    if (errors.length) return res.status(400).json({ success: false, errors });
    const guess = R.guessMapping(rows, { headerRow: typeof b.headerRow === 'boolean' ? b.headerRow : undefined });
    if (guess.rowCount === 0) return res.status(400).json({ success: false, errors: ['Only a header row was found. Copy the rows with the people too.'] });
    if (guess.rowCount > R.MAX_ROWS) return res.status(400).json({ success: false, errors: [`At most ${R.MAX_ROWS} people at a time. Split the sheet and add the rest in a second round.`] });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, ...guess, rows });
});

/** Runs fn over items, a few at a time */
async function eachLimited(items, limit, fn) {
    let next = 0;
    const worker = async () => { while (next < items.length) { const i = next; next += 1; await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** The people a check or create request is about: either already matched ({ field: text }) or a sheet plus its column choices */
function peopleFrom(body) {
    const b = body || {};
    if (Array.isArray(b.people)) {
        if (b.people.length === 0) return { errors: ['There are no rows to check'] };
        if (b.people.length > R.MAX_ROWS) return { errors: [`At most ${R.MAX_ROWS} people at a time`] };
        return { errors: [], people: b.people.map((p) => (p && typeof p === 'object' ? p : {})) };
    }
    const { errors, rows } = R.cleanTable(b.rows);
    if (errors.length) return { errors };
    const body2 = b.hasHeader === false ? rows : rows.slice(1);
    if (!body2.length) return { errors: ['There are no rows to check'] };
    if (body2.length > R.MAX_ROWS) return { errors: [`At most ${R.MAX_ROWS} people at a time`] };
    const mapping = R.validateMapping(b.mapping, rows[0].length);
    if (mapping.errors.length) return { errors: mapping.errors };
    return { errors: [], people: R.applyMapping(body2, mapping.value) };
}

/**
 * Checks every person with the same validation the "add one employee" form uses and says what is wrong, cell by cell.
 * SSNs are only kept when options.ssn === 'import'; they are never sent back in full.
 */
async function checkPeople(people, options) {
    const ssn = options && options.ssn === 'import' ? 'import' : 'leave';
    const opts = { ssn, defaultStartDate: options && options.defaultStartDate ? String(options.defaultStartDate) : '' };
    const rows = people.map((raw, i) => {
        const n = R.normalizePerson(raw, opts);
        const conv = R.toPersonInput(n);
        let validated = null; let problems = n.problems;
        if (!problems.length) {
            validated = svc.validatePerson(conv.input);
            problems = R.mergeProblems(problems, validated.errors);
            if (conv.taxpayerId) {
                const t = validateTaxpayerId(conv.taxpayerId.value, conv.taxpayerId.type);
                if (t.valid) validated.taxpayerId = t; else problems = R.mergeProblems(problems, [{ field: 'ssn', message: 'This is not a valid Social Security number or ITIN' }]);
            }
            validated.partialProfile = conv.partialProfile;
            validated.employeeNumber = conv.employeeNumber;
        }
        return { index: i, n, validated, problems };
    });
    const dup = R.duplicateEmails(rows.map((r) => ({ email: r.n.values.email })));
    rows.forEach((r) => { if (dup.has(r.index)) r.problems = R.mergeProblems(r.problems.filter((p) => p.field !== 'email'), [{ field: 'email', message: 'This email is used higher up in the list. Each person needs their own email.' }]); });
    await eachLimited(rows.filter((r) => !r.problems.length), 8, async (r) => {
        if (await svc.emailTaken(r.validated.value.email)) r.problems = [{ field: 'email', message: 'This email already has an account' }];
    });
    return rows.map((r) => {
        const values = { ...r.n.values };
        if (values.ssn) values.ssn = R.maskSsn(values.ssn);
        return { row: r.index + 1, ok: r.problems.length === 0, values, problems: r.problems, notes: r.n.notes, ssnLeftOut: r.n.ssnDropped, profile: r.n.profile, validated: r.validated };
    });
}

const publicRow = ({ validated, ...rest }) => rest;

router.post('/team-import/check', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const from = peopleFrom(req.body);
    if (from.errors.length) return res.status(400).json({ success: false, errors: from.errors });
    const options = (req.body && req.body.options) || {};
    const keepSsn = options.ssn === 'import';
    const people = from.people.map((p) => { const out = {}; R.FIELD_KEYS.forEach((k) => { if (p[k] !== undefined && p[k] !== null && String(p[k]).trim() !== '' && (k !== 'ssn' || keepSsn)) out[k] = String(p[k]).slice(0, 300); }); return out; });
    const rows = await checkPeople(people, options);
    res.set('Cache-Control', 'no-store');
    res.json({
        success: true, ssn: keepSsn ? 'import' : 'leave',
        summary: { rows: rows.length, ok: rows.filter((r) => r.ok).length, problems: rows.filter((r) => !r.ok).length, ssnLeftOut: keepSsn ? 0 : from.people.filter((p) => p.ssn && String(p.ssn).trim()).length },
        people, results: rows.map(publicRow)
    });
});

/**
 * Creates the rows that pass the check; rows with problems are reported and skipped.
 *   options.access 'link' (default): nobody sees a password; each person gets a personal set-up link, returned once
 *   options.access 'password': a temporary password per person, returned once; they must change it at first sign-in
 *   options.email (default true): with email set up, each set-up link is also emailed to that person (emailed: true).
 *   A temporary password is never emailed.
 */
router.post('/team-import/create', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const from = peopleFrom(req.body);
    if (from.errors.length) return res.status(400).json({ success: false, errors: from.errors });
    const options = (req.body && req.body.options) || {};
    const access = options.access === 'password' ? 'password' : 'link';
    const keepSsn = options.ssn === 'import';
    const people = from.people.map((p) => { const out = { ...p }; if (!keepSsn) delete out.ssn; return out; });
    const rows = await checkPeople(people, options);
    const good = rows.filter((r) => r.ok);
    const results = rows.map((r) => ({ row: r.row, email: r.values.email || '', name: [r.values.first_name, r.values.last_name].filter(Boolean).join(' '), status: r.ok ? 'pending' : 'skipped', problems: r.problems }));
    let ssnStored = 0;
    if (good.length) {
        const ids = await svc.allocateEmployeeIds(req.orgId, good.length);
        for (let i = 0; i < good.length; i++) {
            const slot = results[good[i].row - 1];
            try {
                const created = await svc.createPerson(req.orgId, good[i].validated, ids[i], req.user.id, { access });
                Object.assign(slot, { status: 'created', uid: created.uid, employeeId: created.employeeId, name: created.name });
                if (good[i].validated.taxpayerId) ssnStored += 1;
                if (access === 'password') slot.temporaryPassword = created.temporaryPassword;
                else { const link = await svc.createSetupLink(req.orgId, created.uid, req.user.id); slot.setupToken = link.token; slot.linkExpiresAt = link.expiresAt; }
            } catch (error) {
                Object.assign(slot, { status: 'error', problems: [{ field: null, message: `Could not add this person: ${error.message}` }] });
            }
        }
    }
    const created = results.filter((r) => r.status === 'created').length;
    let emailed = 0;
    if (created && access === 'link' && options.email !== false) {
        const sent = await Mail.sendSetupLinks(req.orgId, results.filter((r) => r.status === 'created').map((r) => ({ name: r.name, email: r.email, token: r.setupToken, expiresAt: r.linkExpiresAt })));
        results.forEach((r) => { if (r.status === 'created' && sent.has(r.email)) { r.emailed = true; emailed += 1; } });
    }
    if (created) audit(req.orgId, req, 'us_team_import_created', req.orgId, { created, rows: rows.length, access, ssnStored, emailed });
    res.set('Cache-Control', 'no-store');
    res.status(created ? 201 : 200).json({ success: true, access, summary: { rows: rows.length, created, skipped: results.filter((r) => r.status !== 'created').length, ssnStored, emailed }, results });
});

// ------------------------------------------------------------------------------------- sign-in help for HR

/** Everyone in the company with where they are with signing in (waiting for set-up, temporary password, active) */
router.get('/team-import/access', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const data = await svc.listAccess(req.orgId);
    res.json({ success: true, count: data.length, data: data.slice(0, 1000) });
});

/**
 * A new temporary password or a new set-up link for a person. Whatever they had before stops working.
 * Never for someone with a higher role than the requester, and never for yourself.
 */
router.post('/team-import/people/:id/reissue', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const method = req.body && req.body.method;
    if (method !== 'link' && method !== 'password') return res.status(400).json({ success: false, error: 'method must be "link" or "password"' });
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (emp.ref.parent.id !== 'users' || !emp.data.email) return res.status(409).json({ success: false, error: 'This person has no sign-in yet. Add them with their email first.' });
    const may = L.mayResetAccess(req.user, { ...emp.data, id: emp.id });
    if (!may.ok) return res.status(may.status).json({ success: false, error: may.error });
    const out = await svc.reissueAccess(req.orgId, emp.id, method, req.user.id);
    if (method === 'link' && req.body.email !== false) out.emailed = (await Mail.sendSetupLinks(req.orgId, [{ name: emp.data.name, email: emp.data.email, token: out.token, expiresAt: out.expiresAt }])).size > 0;
    audit(req.orgId, req, 'us_access_reissued', emp.id, { method, targetRole: emp.data.role || null, emailed: Boolean(out.emailed) });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, person: { id: emp.id, employeeId: emp.data.employeeId || null, name: emp.data.name || null, email: emp.data.email }, ...out });
});

// --------------------------------------------------------------------------------------- company join link

router.get('/team-import/join-links', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    res.json({ success: true, data: await svc.listJoinLinks(req.orgId), maxDays: L.JOIN_LINK_MAX_DAYS });
});

/** A new join link. The link itself is in this answer only: the server keeps a hash and cannot show it again. */
router.post('/team-import/join-links', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const b = req.body || {};
    // open: true makes an open link (for a team meeting): the first maxPeople people are let in at once, for a few hours
    const open = b.open === true ? { hours: b.hours, maxPeople: b.maxPeople } : null;
    const r = await svc.createJoinLink(req.orgId, req.user.id, b.days, b.label, open);
    if (!r.ok) return res.status(r.status).json({ success: false, error: r.error });
    audit(req.orgId, req, 'us_join_link_created', r.link.id.slice(0, 12), { expiresAt: r.link.expiresAt, open: r.link.open, maxPeople: r.link.maxPeople || null });
    res.set('Cache-Control', 'no-store');
    res.status(201).json({ success: true, token: r.token, link: r.link });
});

router.delete('/team-import/join-links/:id', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const r = await svc.revokeJoinLink(req.orgId, req.params.id, req.user.id);
    if (!r.ok) return res.status(r.status).json({ success: false, error: r.error });
    audit(req.orgId, req, 'us_join_link_revoked', String(req.params.id).slice(0, 12));
    res.json({ success: true });
});

router.get('/team-import/join-requests', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const data = await svc.listJoinRequests(req.orgId);
    res.json({ success: true, waiting: data.filter((r) => r.status === 'waiting').length, data });
});

/** Approve several waiting people at once (at most 50). Each is approved on its own; the answer says which did not work. */
router.post('/team-import/join-requests/approve-many', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const b = req.body || {};
    const picked = L.approveIds(b.ids);
    if (picked.error) return res.status(400).json({ success: false, error: picked.error });
    const r = await svc.approveJoinRequests(req.orgId, picked.ids, req.user.id, { startDate: b.startDate });
    let emailed = 0;
    for (const a of r.approved) {
        const sent = (await Mail.sendApproved(req.orgId, { name: `${a.request.data.firstName} ${a.request.data.lastName}`, email: a.request.data.email })) > 0;
        if (sent) emailed += 1;
        audit(req.orgId, req, 'us_join_request_approved', a.person.uid, { requestId: a.id, employeeId: a.person.employeeId, emailed: sent, together: true });
    }
    res.status(r.approved.length ? 201 : 409).json({ success: r.approved.length > 0, approved: r.approved.length, emailed, failed: r.failed,
        ...(r.approved.length ? {} : { error: (r.failed[0] && r.failed[0].error) || 'Nobody was approved' }) });
});

/** Approve: the person becomes an employee (never a higher role) and can sign in with the password they chose */
router.post('/team-import/join-requests/:id/approve', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const request = await svc.getJoinRequest(req.orgId, req.params.id);
    if (!request) return res.status(404).json({ success: false, error: 'Request not found' });
    const b = req.body || {};
    const r = await svc.approveJoinRequest(req.orgId, request, req.user.id, { startDate: b.startDate, jobTitle: b.jobTitle, department: b.department });
    if (!r.ok) return res.status(r.status).json(r.errors ? { success: false, errors: r.errors } : { success: false, error: r.error });
    const emailed = (await Mail.sendApproved(req.orgId, { name: `${request.data.firstName} ${request.data.lastName}`, email: request.data.email })) > 0;
    audit(req.orgId, req, 'us_join_request_approved', r.person.uid, { requestId: request.id, employeeId: r.person.employeeId, emailed });
    res.status(201).json({ success: true, employee: r.person, emailed });
});

router.post('/team-import/join-requests/:id/reject', PEOPLE_WRITE, requireUsOrg, async (req, res) => {
    const request = await svc.getJoinRequest(req.orgId, req.params.id);
    if (!request) return res.status(404).json({ success: false, error: 'Request not found' });
    const r = await svc.rejectJoinRequest(req.orgId, request, req.user.id);
    if (!r.ok) return res.status(r.status).json({ success: false, error: r.error });
    audit(req.orgId, req, 'us_join_request_rejected', request.id);
    res.json({ success: true });
});

module.exports = router;
