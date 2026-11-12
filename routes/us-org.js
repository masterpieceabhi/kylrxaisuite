const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { requireUsOrg, findEmployee, audit } = require('./us-hr').helpers;
const { requirePermission, requireAnyPermission, can } = require('../services/permissions');
const O = require('../services/org-rules');
const P = require('../services/pay-schedule-rules');
const H = require('../services/holiday-rules');
const store = require('../services/people-data-store');
const holidays = require('../services/company-holidays');
const { federalHolidays } = require('../services/us-forms');


const now = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });

/** Fields of a person doc safe to show on the org screens (no pay, no IDs) */
const pub = (p) => ({ id: p.id, employeeId: p.employeeId, name: p.name, email: p.email, jobTitle: p.jobTitle, managerId: p.managerId, departmentId: p.departmentId, workLocationId: p.workLocationId, payScheduleId: p.payScheduleId, status: p.status });

async function setProfile(emp, patch, req) {
    await emp.ref.set({ usProfile: { ...patch, updatedAt: now(), updatedBy: req.user.id || null } }, { merge: true });
}

// ---------------------------------------------------------------- locations
router.get('/locations', requireUsOrg, async (req, res) => {
    const rows = await store.listByOrg('locations', req.orgId);
    const includeInactive = req.query.all === 'true' && can(req.user, 'org.settings');
    res.json({ success: true, data: rows.filter((l) => includeInactive || l.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name))) });
});

async function clearOtherHeadquarters(orgId, keepId) {
    const rows = await store.listByOrg('locations', orgId);
    await Promise.all(rows.filter((l) => l.isHeadquarters && l.id !== keepId).map((l) => rawCollection('locations').doc(l.id).set({ isHeadquarters: false }, { merge: true })));
}

router.post('/locations', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const { errors, value } = O.validateLocation(req.body);
    if (errors.length) return invalid(res, errors);
    const existing = await store.listByOrg('locations', req.orgId);
    if (existing.some((l) => l.active !== false && String(l.name).toLowerCase() === value.name.toLowerCase())) return fail(res, 409, 'A location with this name already exists');
    const doc = { ...value, orgId: req.orgId, isHeadquarters: value.isHeadquarters || existing.length === 0, createdAt: now(), createdBy: req.user.id || null };
    const ref = await rawCollection('locations').add(doc);
    if (doc.isHeadquarters) await clearOtherHeadquarters(req.orgId, ref.id);
    audit(req.orgId, req, 'org_location_created', ref.id, { name: value.name });
    res.status(201).json({ success: true, location: { id: ref.id, ...doc } });
});

router.put('/locations/:id', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('locations', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Location not found');
    const { errors, value } = O.validateLocation({ ...cur, ...req.body });
    if (errors.length) return invalid(res, errors);
    if (cur.isHeadquarters && !value.isHeadquarters) return fail(res, 409, 'Choose another location as headquarters instead of removing this one');
    await cur.ref.set({ ...value, updatedAt: now(), updatedBy: req.user.id || null }, { merge: true });
    if (value.isHeadquarters) await clearOtherHeadquarters(req.orgId, cur.id);
    audit(req.orgId, req, 'org_location_updated', cur.id, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, location: { id: cur.id, orgId: req.orgId, ...value } });
});

router.delete('/locations/:id', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('locations', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Location not found');
    if (cur.isHeadquarters) return fail(res, 409, 'The headquarters location cannot be removed');
    const people = await store.loadPeople(req.orgId);
    if (people.some((p) => p.workLocationId === cur.id)) return fail(res, 409, 'People are still assigned to this location. Move them first.');
    await cur.ref.set({ active: false, updatedAt: now() }, { merge: true });
    audit(req.orgId, req, 'org_location_deactivated', cur.id, {});
    res.json({ success: true });
});

// -------------------------------------------------------------- departments
router.get('/departments', requireUsOrg, async (req, res) => {
    const [rows, people] = await Promise.all([store.listByOrg('departments', req.orgId), store.loadPeople(req.orgId)]);
    const count = {};
    people.forEach((p) => { if (p.departmentId) count[p.departmentId] = (count[p.departmentId] || 0) + 1; });
    res.json({ success: true, data: rows.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((d) => ({ ...d, headCount: count[d.id] || 0 })) });
});

async function departmentChecks(req, value, selfId) {
    const errors = [];
    const rows = await store.listByOrg('departments', req.orgId);
    if (rows.some((d) => d.id !== selfId && String(d.name).toLowerCase() === value.name.toLowerCase())) errors.push('A department with this name already exists');
    if (value.code && rows.some((d) => d.id !== selfId && d.code === value.code)) errors.push('A department with this code already exists');
    if (value.parentId) {
        if (!rows.some((d) => d.id === value.parentId)) errors.push('parentId is not a department of this company');
        else if (selfId && O.wouldCreateCycle(Object.fromEntries(rows.map((d) => [d.id, d.parentId || null])), selfId, value.parentId)) errors.push('That parent would put the department inside itself');
    }
    if (value.headId) {
        const head = await findEmployee(req.orgId, value.headId);
        if (!head) errors.push('headId is not a person in this company'); else value.headId = head.id;
    }
    return errors;
}

router.post('/departments', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const { errors, value } = O.validateDepartment(req.body);
    errors.push(...(errors.length ? [] : await departmentChecks(req, value, null)));
    if (errors.length) return invalid(res, errors);
    const doc = { ...value, orgId: req.orgId, createdAt: now(), createdBy: req.user.id || null };
    const ref = await rawCollection('departments').add(doc);
    audit(req.orgId, req, 'org_department_created', ref.id, { name: value.name });
    res.status(201).json({ success: true, department: { id: ref.id, ...doc } });
});

router.put('/departments/:id', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('departments', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Department not found');
    const { errors, value } = O.validateDepartment({ ...cur, ...req.body });
    errors.push(...(errors.length ? [] : await departmentChecks(req, value, cur.id)));
    if (errors.length) return invalid(res, errors);
    await cur.ref.set({ ...value, updatedAt: now() }, { merge: true });
    audit(req.orgId, req, 'org_department_updated', cur.id, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, department: { id: cur.id, orgId: req.orgId, ...value } });
});

router.delete('/departments/:id', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('departments', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Department not found');
    const [rows, people] = await Promise.all([store.listByOrg('departments', req.orgId), store.loadPeople(req.orgId, { includeInactive: true })]);
    if (rows.some((d) => d.parentId === cur.id)) return fail(res, 409, 'This department has sub-departments. Move or delete them first.');
    if (people.some((p) => p.departmentId === cur.id)) return fail(res, 409, 'People are still assigned to this department. Move them first.');
    await cur.ref.delete();
    audit(req.orgId, req, 'org_department_deleted', cur.id, { name: cur.name });
    res.json({ success: true });
});

// ----------------------------------------------------------------- managers
router.put('/people/:id/manager', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    const wanted = req.body && req.body.managerId;
    const before = (emp.data.usProfile && emp.data.usProfile.managerId) || null;
    if (wanted === undefined) return invalid(res, ['managerId is required (use null to remove the manager)']);
    let managerId = null;
    if (wanted) {
        const mgr = await findEmployee(req.orgId, String(wanted));
        if (!mgr) return fail(res, 404, 'Manager not found in this company');
        if (mgr.id === emp.id) return fail(res, 409, 'A person cannot manage themselves');
        if (!store.isActivePerson(mgr.data)) return fail(res, 409, 'That manager is no longer active');
        const people = await store.loadPeople(req.orgId, { includeInactive: true });
        if (O.wouldCreateCycle(O.managerMap(people), emp.id, mgr.id)) return fail(res, 409, 'That would create a reporting loop: the chosen manager already reports to this person');
        managerId = mgr.id;
    }
    await setProfile(emp, { managerId }, req);
    audit(req.orgId, req, managerId ? 'org_manager_set' : 'org_manager_removed', emp.id, { from: before, to: managerId });
    res.json({ success: true, personId: emp.id, managerId });
});

/** A person's L1 manager and the chain above them */
router.get('/people/:id/managers', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    const isSelf = emp.id === req.user.id;
    if (!isSelf && !can(req.user, 'people.read')) return fail(res, 403, 'You do not have permission to do this');
    const chain = O.managerChain(await store.loadPeople(req.orgId), emp.id);
    res.json({ success: true, l1: chain[0] ? pub(chain[0]) : null, chain: chain.map(pub) });
});

/** Team lookup: ?scope=direct|subtree. A manager sees their own team; people.read sees anyone's. */
router.get('/people/:id/team', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    const own = emp.id === req.user.id;
    if (!can(req.user, 'people.read') && !(own && can(req.user, 'people.read_team'))) return fail(res, 403, 'You do not have permission to do this');
    const people = await store.loadPeople(req.orgId);
    const subtree = req.query.scope === 'subtree';
    const team = subtree ? O.subtree(people, emp.id) : O.directReports(people, emp.id).map((p) => ({ ...p, level: 1 }));
    res.json({ success: true, managerId: emp.id, scope: subtree ? 'subtree' : 'direct', count: team.length, data: team.map((p) => ({ ...pub(p), level: p.level })) });
});

router.get('/org/chart', requireUsOrg, async (req, res) => {
    let rootId = null;
    if (req.query.root === 'me') rootId = req.user.id;
    else if (req.query.root) rootId = String(req.query.root);
    const seesAll = can(req.user, 'people.read');
    if (!seesAll && !(can(req.user, 'people.read_team') && rootId === req.user.id)) return fail(res, 403, 'You do not have permission to do this');
    const [people, deps, locs] = await Promise.all([store.loadPeople(req.orgId), store.listByOrg('departments', req.orgId), store.listByOrg('locations', req.orgId)]);
    const dName = Object.fromEntries(deps.map((d) => [d.id, d.name])); const lName = Object.fromEntries(locs.map((l) => [l.id, l.name]));
    let nodes = people;
    if (rootId) {
        if (!people.some((p) => p.id === rootId)) return res.json({ success: true, count: 0, tree: [] }); // e.g. a manager with no team yet
        const ids = new Set([rootId, ...O.subtree(people, rootId).map((p) => p.id)]);
        nodes = people.filter((p) => ids.has(p.id)).map((p) => (p.id === rootId ? { ...p, managerId: null } : p));
    }
    const slim = nodes.map((p) => ({ id: p.id, employeeId: p.employeeId, name: p.name, jobTitle: p.jobTitle, managerId: p.managerId, department: dName[p.departmentId] || null, location: lName[p.workLocationId] || null }));
    res.json({ success: true, count: slim.length, tree: O.buildTree(slim) });
});

// -------------------------------------------------- location/department assignment
async function resolveAssignment(orgId, body, cache) {
    const errors = []; const patch = {};
    if (body.workLocationId !== undefined) {
        if (body.workLocationId === null || body.workLocationId === '') patch.workLocationId = null;
        else {
            const l = (cache.locations || []).find((x) => x.id === body.workLocationId);
            if (!l) errors.push('workLocationId is not a location of this company'); else if (l.active === false) errors.push('That location is inactive'); else patch.workLocationId = l.id;
        }
    }
    if (body.departmentId !== undefined) {
        if (body.departmentId === null || body.departmentId === '') patch.departmentId = null;
        else {
            const d = (cache.departments || []).find((x) => x.id === body.departmentId);
            if (!d) errors.push('departmentId is not a department of this company'); else patch.departmentId = d.id;
        }
    }
    if (!errors.length && !Object.keys(patch).length) errors.push('send workLocationId and/or departmentId');
    return { errors, patch };
}

router.put('/people/:id/assignment', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    const cache = { locations: await store.listByOrg('locations', req.orgId), departments: await store.listByOrg('departments', req.orgId) };
    const { errors, patch } = await resolveAssignment(req.orgId, req.body || {}, cache);
    if (errors.length) return invalid(res, errors);
    await setProfile(emp, patch, req);
    audit(req.orgId, req, 'org_assignment_updated', emp.id, patch);
    res.json({ success: true, personId: emp.id, ...patch });
});

/** Bulk assign from CSV text or rows: person, manager, location, department. ?dryRun=true only checks. */
router.post('/org/assignments/bulk', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const body = req.body || {};
    const rows = (Array.isArray(body.rows) ? body.rows : O.parseCsv(body.csv)).map(O.normalizeAssignRow);
    if (!rows.length) return invalid(res, ['send rows or csv with at least one row']);
    if (rows.length > 500) return invalid(res, ['at most 500 rows per upload']);
    const dryRun = req.query.dryRun === 'true' || body.dryRun === true;
    const [people, locations, departments] = await Promise.all([store.loadPeople(req.orgId, { includeInactive: true }), store.listByOrg('locations', req.orgId), store.listByOrg('departments', req.orgId)]);
    const lower = (v) => String(v || '').toLowerCase();
    const findPerson = (key) => people.find((p) => p.id === key || lower(p.employeeId) === lower(key) || lower(p.email) === lower(key));
    const map = O.managerMap(people);
    const results = [];
    for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i]; const line = i + 2;
        const errs = []; const patch = {};
        const person = r.person ? findPerson(r.person) : null;
        if (!person) { results.push({ line, person: r.person || null, ok: false, errors: ['person not found'] }); continue; }
        if (r.manager !== undefined) {
            if (r.manager === null) patch.managerId = null;
            else {
                const m = findPerson(r.manager);
                if (!m) errs.push('manager not found');
                else if (m.id === person.id) errs.push('a person cannot manage themselves');
                else if (!store.isActivePerson(m)) errs.push('manager is not active');
                else if (O.wouldCreateCycle(map, person.id, m.id)) errs.push('would create a reporting loop');
                else patch.managerId = m.id;
            }
        }
        if (r.location !== undefined) {
            if (r.location === null) patch.workLocationId = null;
            else { const l = locations.find((x) => x.active !== false && (x.id === r.location || lower(x.name) === lower(r.location))); if (!l) errs.push('location not found'); else patch.workLocationId = l.id; }
        }
        if (r.department !== undefined) {
            if (r.department === null) patch.departmentId = null;
            else { const d = departments.find((x) => x.id === r.department || lower(x.code) === lower(r.department) || lower(x.name) === lower(r.department)); if (!d) errs.push('department not found'); else patch.departmentId = d.id; }
        }
        if (!errs.length && !Object.keys(patch).length) errs.push('nothing to change in this row');
        if (errs.length) { results.push({ line, person: r.person, ok: false, errors: errs }); continue; }
        if ('managerId' in patch) map[person.id] = patch.managerId; // later rows see this change
        if (!dryRun) {
            const emp = await findEmployee(req.orgId, person.id);
            if (!emp) { results.push({ line, person: r.person, ok: false, errors: ['person not found'] }); continue; }
            await setProfile(emp, patch, req);
        }
        results.push({ line, person: r.person, ok: true, changes: patch });
    }
    const applied = results.filter((x) => x.ok).length;
    if (!dryRun) audit(req.orgId, req, 'org_bulk_assignment', null, { rows: rows.length, applied });
    res.json({ success: true, dryRun, total: rows.length, applied, failed: rows.length - applied, results });
});

// ------------------------------------------------------------- pay schedules
const SCHEDULE_VIEW = requireAnyPermission('payroll.view', 'org.settings');
const SCHEDULE_EDIT = requireAnyPermission('org.settings', 'payroll.run');

async function holidaysAround(orgId, fromIso, days) {
    const to = P.addDays(fromIso, days);
    const set = await holidays.holidaySetForRange(orgId, fromIso, to);
    for (let y = Number(fromIso.slice(0, 4)); y <= Number(to.slice(0, 4)); y += 1) federalHolidays(y).forEach((d) => set.add(d)); // banks close on federal holidays
    return set;
}

router.get('/pay-schedules', SCHEDULE_VIEW, requireUsOrg, async (req, res) => {
    const [rows, people] = await Promise.all([store.listByOrg('pay_schedules', req.orgId), store.loadPeople(req.orgId)]);
    const count = {};
    people.forEach((p) => { if (p.payScheduleId) count[p.payScheduleId] = (count[p.payScheduleId] || 0) + 1; });
    res.json({ success: true, data: rows.map((s) => ({ ...s, members: count[s.id] || 0 })), unassigned: people.filter((p) => !p.payScheduleId).length });
});

router.post('/pay-schedules', SCHEDULE_EDIT, requireUsOrg, async (req, res) => {
    const { errors, value } = P.validateSchedule(req.body);
    if (errors.length) return invalid(res, errors);
    const rows = await store.listByOrg('pay_schedules', req.orgId);
    if (rows.some((s) => String(s.name).toLowerCase() === value.name.toLowerCase())) return fail(res, 409, 'A pay schedule with this name already exists');
    const doc = { ...value, orgId: req.orgId, createdAt: now(), createdBy: req.user.id || null };
    const ref = await rawCollection('pay_schedules').add(doc);
    audit(req.orgId, req, 'pay_schedule_created', ref.id, { name: value.name, frequency: value.frequency });
    res.status(201).json({ success: true, schedule: { id: ref.id, ...doc } });
});

router.put('/pay-schedules/:id', SCHEDULE_EDIT, requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('pay_schedules', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Pay schedule not found');
    const { errors, value } = P.validateSchedule({ ...cur, ...req.body });
    if (errors.length) return invalid(res, errors);
    const people = await store.loadPeople(req.orgId);
    if (value.frequency !== cur.frequency && people.some((p) => p.payScheduleId === cur.id)) return fail(res, 409, 'People are on this schedule. Create a new schedule instead of changing its frequency.');
    await cur.ref.set({ ...value, updatedAt: now() }, { merge: true });
    audit(req.orgId, req, 'pay_schedule_updated', cur.id, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, schedule: { id: cur.id, orgId: req.orgId, ...value } });
});

router.delete('/pay-schedules/:id', SCHEDULE_EDIT, requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('pay_schedules', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Pay schedule not found');
    const people = await store.loadPeople(req.orgId, { includeInactive: true });
    if (people.some((p) => p.payScheduleId === cur.id)) return fail(res, 409, 'People are on this schedule. Move them first.');
    await cur.ref.delete();
    audit(req.orgId, req, 'pay_schedule_deleted', cur.id, { name: cur.name });
    res.json({ success: true });
});

/** Upcoming pay dates (?from=YYYY-MM-DD&n=6) and the period containing ?date= */
router.get('/pay-schedules/:id/preview', SCHEDULE_VIEW, requireUsOrg, async (req, res) => {
    const s = await store.getOwned('pay_schedules', req.orgId, req.params.id);
    if (!s) return fail(res, 404, 'Pay schedule not found');
    const from = req.query.from ? String(req.query.from) : await store.todayFor(req.orgId);
    const date = req.query.date ? String(req.query.date) : from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || P.addDays === null) return invalid(res, ['from and date must be YYYY-MM-DD']);
    let n = Number(req.query.n || 6); if (!Number.isInteger(n) || n < 1 || n > 60) n = 6;
    try {
        const hs = await holidaysAround(req.orgId, P.addDays(from, -60), 800 + n * 35);
        res.json({ success: true, schedule: { id: s.id, name: s.name, frequency: s.frequency }, containing: P.periodContaining(s, date, hs), next: P.nextPayDates(s, from, n, hs) });
    } catch (e) { return invalid(res, ['dates are not valid']); }
});

/** Put people on a schedule. Their pay frequency must match unless syncFrequency is true. */
router.post('/pay-schedules/:id/assign', SCHEDULE_EDIT, requireUsOrg, async (req, res) => {
    const s = await store.getOwned('pay_schedules', req.orgId, req.params.id);
    if (!s) return fail(res, 404, 'Pay schedule not found');
    if (s.active === false) return fail(res, 409, 'This pay schedule is not active');
    const ids = Array.isArray(req.body && req.body.userIds) ? req.body.userIds.map(String) : [];
    if (!ids.length || ids.length > 500) return invalid(res, ['userIds must list 1 to 500 people']);
    const sync = Boolean(req.body.syncFrequency);
    const results = [];
    for (const id of ids) {
        const emp = await findEmployee(req.orgId, id);
        if (!emp) { results.push({ id, ok: false, error: 'not found' }); continue; }
        const freq = emp.data.usProfile && emp.data.usProfile.payFrequency;
        if (freq && freq !== s.frequency && !sync) { results.push({ id: emp.id, ok: false, error: `pay frequency is ${freq}, this schedule is ${s.frequency}` }); continue; }
        await setProfile(emp, { payScheduleId: s.id, ...(sync ? { payFrequency: s.frequency } : {}) }, req);
        results.push({ id: emp.id, ok: true });
    }
    audit(req.orgId, req, 'pay_schedule_assigned', s.id, { count: results.filter((r) => r.ok).length });
    res.json({ success: true, results, assigned: results.filter((r) => r.ok).length });
});

router.post('/pay-schedules/unassign', SCHEDULE_EDIT, requireUsOrg, async (req, res) => {
    const ids = Array.isArray(req.body && req.body.userIds) ? req.body.userIds.map(String) : [];
    if (!ids.length || ids.length > 500) return invalid(res, ['userIds must list 1 to 500 people']);
    let n = 0;
    for (const id of ids) { const emp = await findEmployee(req.orgId, id); if (emp) { await setProfile(emp, { payScheduleId: null }, req); n += 1; } }
    audit(req.orgId, req, 'pay_schedule_unassigned', null, { count: n });
    res.json({ success: true, unassigned: n });
});

async function scheduleMembers(orgId) {
    const [schedules, people] = await Promise.all([store.listByOrg('pay_schedules', orgId), store.loadPeople(orgId)]);
    const byId = Object.fromEntries(schedules.map((s) => [s.id, s]));
    return people.map((p) => ({ id: p.id, employeeId: p.employeeId, name: p.name, payFrequency: p.payFrequency, scheduleId: p.payScheduleId && byId[p.payScheduleId] ? p.payScheduleId : null, scheduleName: p.payScheduleId && byId[p.payScheduleId] ? byId[p.payScheduleId].name : null }));
}

router.get('/pay-schedules/members', SCHEDULE_VIEW, requireUsOrg, async (req, res) => {
    const data = await scheduleMembers(req.orgId);
    res.json({ success: true, count: data.length, data: req.query.scheduleId ? data.filter((m) => m.scheduleId === req.query.scheduleId) : data });
});

router.get('/pay-schedules/export', SCHEDULE_VIEW, requireUsOrg, async (req, res) => {
    const data = await scheduleMembers(req.orgId);
    const esc = (v) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [['Employee ID', 'Name', 'Pay frequency', 'Pay schedule'].map(esc).join(','), ...data.map((m) => [m.employeeId, m.name, m.payFrequency, m.scheduleName || '(none)'].map(esc).join(','))];
    audit(req.orgId, req, 'pay_schedule_export', null, { rows: data.length });
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="pay-schedules.csv"').send(`${lines.join('\r\n')}\r\n`);
});

// ----------------------------------------------------------------- holidays
router.get('/holidays', requireUsOrg, async (req, res) => {
    const year = Number(req.query.year || (await store.todayFor(req.orgId)).slice(0, 4));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return invalid(res, ['year must be between 2000 and 2100']);
    res.json({ success: true, year, data: await holidays.calendarFor(req.orgId, year) });
});

router.get('/holidays/check', requireUsOrg, async (req, res) => {
    const date = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return invalid(res, ['date must be YYYY-MM-DD']);
    const info = await holidays.companyHolidayInfo(req.orgId, date, { locationId: req.query.locationId });
    res.json({ success: true, date, holiday: Boolean(info), info });
});

async function locationIdsOk(orgId, ids) {
    if (!ids || !ids.length) return true;
    const locs = await store.listByOrg('locations', orgId);
    return ids.every((id) => locs.some((l) => l.id === id));
}

router.post('/holidays', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const { errors, value } = H.validateHoliday(req.body);
    if (!errors.length && !(await locationIdsOk(req.orgId, value.locationIds))) errors.push('locationIds must be locations of this company');
    if (errors.length) return invalid(res, errors);
    const docs = await store.listByOrg('company_holidays', req.orgId);
    if (value.kind === 'federal' && docs.some((d) => d.kind === 'federal' && d.federalKey === value.federalKey && d.year === value.year)) return fail(res, 409, 'This federal holiday already has a company setting. Edit it instead.');
    if (value.kind === 'custom' && docs.some((d) => d.kind === 'custom' && d.date === value.date && String(d.name).toLowerCase() === value.name.toLowerCase())) return fail(res, 409, 'This holiday is already on the calendar');
    const doc = { ...value, orgId: req.orgId, createdAt: now(), createdBy: req.user.id || null };
    const ref = await rawCollection('company_holidays').add(doc);
    holidays.invalidate(req.orgId);
    audit(req.orgId, req, 'holiday_created', ref.id, { kind: value.kind, date: value.date || null, federalKey: value.federalKey || null });
    res.status(201).json({ success: true, holiday: { id: ref.id, ...doc } });
});

router.put('/holidays/:id', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('company_holidays', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Holiday not found');
    const { errors, value } = H.validateHoliday({ ...cur, ...req.body, kind: cur.kind, federalKey: cur.federalKey, year: cur.year });
    if (!errors.length && !(await locationIdsOk(req.orgId, value.locationIds))) errors.push('locationIds must be locations of this company');
    if (errors.length) return invalid(res, errors);
    await cur.ref.set({ ...value, updatedAt: now() }, { merge: true });
    holidays.invalidate(req.orgId);
    audit(req.orgId, req, 'holiday_updated', cur.id, { fields: Object.keys(req.body || {}) });
    res.json({ success: true, holiday: { id: cur.id, orgId: req.orgId, ...value } });
});

/** Removing a custom day deletes it; removing a federal setting puts the federal default back */
router.delete('/holidays/:id', requirePermission('org.settings'), requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('company_holidays', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Holiday not found');
    await cur.ref.delete();
    holidays.invalidate(req.orgId);
    audit(req.orgId, req, 'holiday_deleted', cur.id, { kind: cur.kind });
    res.json({ success: true });
});

router.helpers = { loadPeople: store.loadPeople };
module.exports = router;
