/**
 * Company equipment given to people (US).
 *
 * Who may add items, hand them out, take them back and change their state: HR and the owner (people.write).
 * Who may see every item: HR, the owner and read-only roles holding people.read.
 * A manager sees only the items that are with their own direct reports (read only).
 * Everyone sees the items that are with them, can confirm they have each one, and can report a problem.
 * The person holding an item never sees its cost, the internal notes or who had it before.
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, findEmployee, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { can, canonicalRole } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const A = require('../services/asset-rules');
const peopleStore = require('../services/people-data-store');

router.use(verifyToken);

const nowIso = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const today = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const col = () => rawCollection('assets');
const mayManage = (req) => can(req.user, 'people.write');
const maySeeAll = (req) => can(req.user, 'people.write') || can(req.user, 'people.read');
const isManager = (req) => canonicalRole(req.user.role) === 'manager';
const me = (req) => String(req.user.id || req.user.uid);
const who = (req) => req.user.name || req.user.email || 'someone';
const personName = (emp) => emp.data.name || [emp.data.usProfile && emp.data.usProfile.legalFirstName, emp.data.usProfile && emp.data.usProfile.legalLastName].filter(Boolean).join(' ') || emp.data.email || emp.id;

const pub = (a, t, { history = false } = {}) => ({ id: a.id, name: a.name, category: a.category, tag: a.tag || '', serial: a.serial || '', condition: a.condition || null, purchaseDate: a.purchaseDate || null, cost: a.cost ?? null, notes: a.notes || '',
    status: a.status, assignedTo: a.assignedTo || null, assignedToName: a.assignedToName || null, assignedAt: a.assignedAt || null, dueBack: a.dueBack || null, overdue: A.isOverdue(a, t), acknowledgedAt: a.acknowledgedAt || null,
    problem: a.problem || null, createdAt: a.createdAt, ...(history ? { history: a.history || [] } : {}) });

async function allAssets(orgId) {
    const snap = await col().where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function owned(req, res) {
    const snap = await col().doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { fail(res, 404, 'Item not found'); return null; }
    return { ref: snap.ref, id: snap.id, data: snap.data(), updateTime: snap.updateTime };
}
/** Write only if nobody changed the item since it was read (two people handing out the same laptop) */
async function guardedUpdate(res, a, patch) {
    try { await a.ref.update(patch, a.updateTime ? { lastUpdateTime: a.updateTime } : undefined); return true; } catch (err) {
        if (err && (err.code === 9 || /precondition/i.test(String(err.message)))) { fail(res, 409, 'Someone else just changed this item. Reload and try again.'); return false; }
        throw err;
    }
}
async function tagTaken(orgId, tag, exceptId) {
    if (!tag) return false;
    const snap = await col().where('tag', '==', tag).get();
    return snap.docs.some((d) => d.data().orgId === orgId && d.id !== exceptId);
}

router.get('/assets/options', requireUsOrg, async (req, res) => {
    const out = { success: true, note: A.NOTE, categories: A.CATEGORIES, statuses: A.STATUSES, conditions: A.CONDITIONS, canManage: mayManage(req), canSeeAll: maySeeAll(req), isManager: isManager(req) };
    if (mayManage(req)) out.people = (await peopleStore.loadPeople(req.orgId)).map((p) => ({ id: p.id, name: p.name, employeeId: p.employeeId, jobTitle: p.jobTitle })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json(out);
});

/* --------------------------------- my own items --------------------------------- */

router.get('/assets/mine', requireUsOrg, async (req, res) => {
    const t = await today(req.orgId);
    const snap = await col().where('assignedTo', '==', me(req)).get();
    const data = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => a.orgId === req.orgId && a.status === 'assigned').map((a) => A.holderView(a, t)).sort((x, y) => String(x.name).localeCompare(String(y.name)));
    res.json({ success: true, today: t, toConfirm: data.filter((a) => !a.acknowledgedAt).length, data });
});

async function mineOnly(req, res, action) {
    const a = await owned(req, res); if (!a) return null;
    if (a.data.assignedTo !== me(req) || a.data.status !== 'assigned') { fail(res, 404, 'Item not found'); return null; }
    const blocked = A.changeError(a.data, action);
    if (blocked) { fail(res, 409, blocked); return null; }
    return a;
}
router.post('/assets/:id/acknowledge', requireUsOrg, async (req, res) => {
    const a = await mineOnly(req, res, 'acknowledge'); if (!a) return;
    const at = nowIso();
    const patch = { acknowledgedAt: at, history: A.addHistory(a.data, A.historyEntry('confirmed', { at, userId: me(req), name: a.data.assignedToName, by: who(req) })) };
    if (!(await guardedUpdate(res, a, patch))) return;
    audit(req.orgId, req, 'asset_confirmed', a.id, {});
    res.json({ success: true, item: A.holderView({ id: a.id, ...a.data, ...patch }, await today(req.orgId)) });
});
router.post('/assets/:id/problem', requireUsOrg, async (req, res) => {
    const a = await mineOnly(req, res, 'problem'); if (!a) return;
    const text = A.block(req.body && req.body.text, 500);
    if (text.length < 5) return invalid(res, ['Say what is wrong (at least 5 characters)']);
    const at = nowIso();
    const patch = { problem: { at, text, by: me(req) }, history: A.addHistory(a.data, A.historyEntry('problem', { at, userId: me(req), name: a.data.assignedToName, by: who(req), note: text.slice(0, 300) })) };
    if (!(await guardedUpdate(res, a, patch))) return;
    audit(req.orgId, req, 'asset_problem_reported', a.id, {});
    res.json({ success: true, item: A.holderView({ id: a.id, ...a.data, ...patch }, await today(req.orgId)) });
});

/* ------------------------------ the company's items ------------------------------ */

router.get('/assets', requireUsOrg, async (req, res) => {
    if (!maySeeAll(req) && !isManager(req)) return fail(res, 403, 'You do not have permission to do this');
    const t = await today(req.orgId);
    const [assets, people] = await Promise.all([allAssets(req.orgId), peopleStore.loadPeople(req.orgId, { includeInactive: true })]);
    if (!maySeeAll(req)) {
        // a manager: only what their own direct reports hold, without cost or internal notes
        const team = new Set(people.filter((p) => p.managerId === me(req)).map((p) => p.id));
        const data = assets.filter((a) => a.status === 'assigned' && team.has(a.assignedTo)).map((a) => ({ ...A.holderView(a, t), assignedTo: a.assignedTo, assignedToName: a.assignedToName || null }));
        return res.json({ success: true, today: t, scope: 'team', count: data.length, data });
    }
    // look each holder up directly: an owner or admin without an employee number is not in the people list, but still works here
    const holderIds = [...new Set(assets.filter((a) => a.status === 'assigned' && a.assignedTo).map((a) => a.assignedTo))];
    const holders = (await Promise.all(holderIds.map((id) => findEmployee(req.orgId, id)))).filter(Boolean).map((emp) => ({ id: emp.id, name: personName(emp), active: peopleStore.isActivePerson(emp.data) }));
    const left = A.unreturned(assets, holders);
    const data = assets.map((a) => pub(a, t)).sort((x, y) => String(x.name).localeCompare(String(y.name)) || String(x.tag).localeCompare(String(y.tag)));
    res.json({ success: true, today: t, scope: 'all', canManage: mayManage(req), summary: A.summary(assets, t), unreturned: left, count: data.length, data });
});

router.get('/assets/:id', requireUsOrg, async (req, res) => {
    if (!maySeeAll(req)) return fail(res, 403, 'You do not have permission to do this');
    const a = await owned(req, res); if (!a) return;
    audit(req.orgId, req, 'asset_history_viewed', a.id, {});
    res.json({ success: true, item: pub({ id: a.id, ...a.data }, await today(req.orgId), { history: true }) });
});

router.post('/assets', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const { errors, value } = A.validateAsset(req.body);
    if (errors.length) return invalid(res, errors);
    if (await tagTaken(req.orgId, value.tag, null)) return fail(res, 409, `Another item already has the tag ${value.tag}`);
    const at = nowIso();
    const doc = { orgId: req.orgId, tag: '', serial: '', condition: null, purchaseDate: null, cost: null, notes: '', ...value, status: 'available', assignedTo: null, assignedToName: null, assignedAt: null, dueBack: null, acknowledgedAt: null, problem: null,
        history: [A.historyEntry('created', { at, by: who(req) })], createdAt: at, createdBy: me(req) };
    const ref = await col().add(doc);
    audit(req.orgId, req, 'asset_created', ref.id, { category: value.category });
    res.status(201).json({ success: true, item: pub({ id: ref.id, ...doc }, await today(req.orgId)) });
});

router.put('/assets/:id', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const a = await owned(req, res); if (!a) return;
    const { errors, value } = A.validateAsset(req.body, { partial: true });
    if (errors.length) return invalid(res, errors);
    if (value.tag && value.tag !== a.data.tag && await tagTaken(req.orgId, value.tag, a.id)) return fail(res, 409, `Another item already has the tag ${value.tag}`);
    const patch = { ...value, updatedAt: nowIso(), updatedBy: me(req) };
    if (!(await guardedUpdate(res, a, patch))) return;
    audit(req.orgId, req, 'asset_updated', a.id, { fields: Object.keys(value) });
    res.json({ success: true, item: pub({ id: a.id, ...a.data, ...patch }, await today(req.orgId)) });
});

router.delete('/assets/:id', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const a = await owned(req, res); if (!a) return;
    const blocked = A.changeError(a.data, 'delete');
    if (blocked) return fail(res, 409, blocked);
    await a.ref.delete();
    audit(req.orgId, req, 'asset_deleted', a.id, { name: a.data.name, tag: a.data.tag || null });
    res.json({ success: true });
});

/** Give the item to a person */
router.post('/assets/:id/assign', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const a = await owned(req, res); if (!a) return;
    const blocked = A.changeError(a.data, 'assign');
    if (blocked) return fail(res, 409, blocked);
    const t = await today(req.orgId);
    const { errors, value } = A.validateAssignment(req.body, t);
    if (errors.length) return invalid(res, errors);
    const emp = await findEmployee(req.orgId, value.userId);
    if (!emp) return fail(res, 404, 'Person not found');
    if (!peopleStore.isActivePerson(emp.data)) return fail(res, 409, 'This person no longer works here');
    const at = nowIso(); const name = personName(emp);
    const patch = { status: 'assigned', assignedTo: emp.id, assignedToName: name, assignedAt: at, dueBack: value.dueBack, acknowledgedAt: null, problem: null, ...(value.condition ? { condition: value.condition } : {}),
        history: A.addHistory(a.data, A.historyEntry('assigned', { at, by: who(req), userId: emp.id, name, note: value.note, condition: value.condition })) };
    if (!(await guardedUpdate(res, a, patch))) return;
    audit(req.orgId, req, 'asset_assigned', a.id, { to: emp.id });
    res.json({ success: true, item: pub({ id: a.id, ...a.data, ...patch }, t) });
});

/** Take the item back */
router.post('/assets/:id/return', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const a = await owned(req, res); if (!a) return;
    const blocked = A.changeError(a.data, 'return');
    if (blocked) return fail(res, 409, blocked);
    const condition = req.body && req.body.condition;
    if (condition && !A.CONDITIONS.includes(condition)) return invalid(res, [`condition must be one of: ${A.CONDITIONS.join(', ')}`]);
    const at = nowIso();
    const patch = { status: 'available', assignedTo: null, assignedToName: null, assignedAt: null, dueBack: null, acknowledgedAt: null, problem: null, ...(condition ? { condition } : {}),
        history: A.addHistory(a.data, A.historyEntry('returned', { at, by: who(req), userId: a.data.assignedTo, name: a.data.assignedToName, note: A.clean(req.body && req.body.note, 300), condition })) };
    if (!(await guardedUpdate(res, a, patch))) return;
    audit(req.orgId, req, 'asset_returned', a.id, { from: a.data.assignedTo });
    res.json({ success: true, item: pub({ id: a.id, ...a.data, ...patch }, await today(req.orgId)) });
});

/** Mark as out for repair, lost or retired, or make it available again */
router.post('/assets/:id/status', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return fail(res, 403, 'You do not have permission to do this');
    const a = await owned(req, res); if (!a) return;
    const to = req.body && req.body.status;
    if (!['repair', 'lost', 'retired', 'available'].includes(to)) return invalid(res, ['status must be one of: repair, lost, retired, available']);
    const blocked = A.changeError(a.data, to);
    if (blocked) return fail(res, 409, blocked);
    const at = nowIso();
    // an item lost while with someone keeps that person's name in its history, then is no longer with them
    const patch = { status: to, assignedTo: null, assignedToName: null, assignedAt: null, dueBack: null, acknowledgedAt: null, problem: null,
        history: A.addHistory(a.data, A.historyEntry(to === 'available' ? 'restored' : to, { at, by: who(req), userId: a.data.assignedTo, name: a.data.assignedToName, note: A.clean(req.body && req.body.note, 300) })) };
    if (!(await guardedUpdate(res, a, patch))) return;
    audit(req.orgId, req, `asset_marked_${to}`, a.id, { from: a.data.status, holder: a.data.assignedTo || null });
    res.json({ success: true, item: pub({ id: a.id, ...a.data, ...patch }, await today(req.orgId)) });
});

module.exports = router;
