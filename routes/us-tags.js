/**
 * Tags on people: a company tag list (HR edits it), tags on a person, and the people list filtered by tag.
 * Mounted inside routes/us-people-data.js, which checks the sign-in. Collection: people_tags (every doc has orgId).
 * A person's tags are tag ids in `tags` on their record.
 */
const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const { requireUsOrg, findEmployee, audit } = require('./us-hr').helpers;
const { requirePermission, can, canonicalRole } = require('../services/permissions');
const T = require('../services/tag-rules');
const store = require('../services/people-data-store');

const now = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const pubTag = (t) => ({ id: t.id, name: t.name, color: t.color || 'grey', updatedAt: t.updatedAt || t.createdAt || null });

/** People of the company with their raw tag ids (users first, roster rows only when no user has the same employee ID) */
async function peopleWithTags(orgId) {
    const [users, roster] = await Promise.all([store.listByOrg('users', orgId), store.listByOrg('employees', orgId)]);
    const seen = new Set(users.map((u) => u.employeeId).filter(Boolean));
    return [...users, ...roster.filter((r) => !r.employeeId || !seen.has(r.employeeId))].filter((p) => p.employeeId || p.usProfile);
}

// ------------------------------------------------------------ company tag list
router.get('/tags', requirePermission('people.read'), requireUsOrg, async (req, res) => {
    const [tags, people] = await Promise.all([store.listByOrg('people_tags', req.orgId), peopleWithTags(req.orgId)]);
    const counts = T.countByTag(people.filter(store.isActivePerson), tags);
    res.json({ success: true, max: T.MAX_TAGS, maxNameLength: T.MAX_NAME_LENGTH, colors: T.COLORS, canEdit: can(req.user, 'people.write'), data: T.sortTags(tags).map((t) => ({ ...pubTag(t), people: counts[t.id] || 0 })) });
});

router.post('/tags', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const { errors, value } = T.validateTag(req.body);
    if (errors.length) return invalid(res, errors);
    const ref = rawCollection('people_tags').doc();
    const id = ref.id;
    const doc = { orgId: req.orgId, name: value.name, color: value.color, createdAt: now(), createdBy: req.user.id || null };
    // In a transaction: two people adding the same name at the same moment cannot both succeed, and the limit of 50 holds
    const problem = await db.runTransaction(async (tx) => {
        const existing = (await tx.get(rawCollection('people_tags').where('orgId', '==', req.orgId))).docs.map((d) => ({ id: d.id, ...d.data() }));
        const conflict = T.listConflict(existing, value);
        if (conflict) return conflict;
        tx.set(ref, doc);
        return null;
    });
    if (problem) return fail(res, 409, problem);
    audit(req.orgId, req, 'people_tag_created', id, { name: value.name });
    res.status(201).json({ success: true, tag: pubTag({ id, ...doc }) });
});

/** Rename or recolour. Send expectedUpdatedAt (from the list) so a second editor does not silently overwrite the first. */
router.put('/tags/:id', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('people_tags', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Tag not found');
    const b = req.body || {};
    const { errors, value } = T.validateTag({ name: b.name === undefined ? cur.name : b.name, color: b.color === undefined ? cur.color : b.color });
    if (errors.length) return invalid(res, errors);
    const stamp = cur.updatedAt || cur.createdAt || null;
    if (b.expectedUpdatedAt && stamp && b.expectedUpdatedAt !== stamp) return fail(res, 409, 'Someone else changed this tag. Reload and try again.');
    const conflict = T.listConflict(await store.listByOrg('people_tags', req.orgId), value, cur.id);
    if (conflict) return fail(res, 409, conflict);
    const updatedAt = now();
    await cur.ref.set({ name: value.name, color: value.color, updatedAt, updatedBy: req.user.id || null }, { merge: true });
    audit(req.orgId, req, 'people_tag_updated', cur.id, { from: cur.name, to: value.name, color: value.color });
    res.json({ success: true, tag: pubTag({ id: cur.id, name: value.name, color: value.color, updatedAt }) });
});

/** Removing a tag from the company list also takes it off every person who had it */
router.delete('/tags/:id', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const cur = await store.getOwned('people_tags', req.orgId, req.params.id);
    if (!cur) return fail(res, 404, 'Tag not found');
    const people = (await peopleWithTags(req.orgId)).filter((p) => Array.isArray(p.tags) && p.tags.includes(cur.id));
    await cur.ref.delete();
    let cleared = 0;
    for (const p of people) {
        const emp = await findEmployee(req.orgId, p.id);
        if (!emp) continue;
        await emp.ref.set({ tags: (emp.data.tags || []).filter((id) => id !== cur.id) }, { merge: true });
        cleared += 1;
    }
    audit(req.orgId, req, 'people_tag_deleted', cur.id, { name: cur.name, removedFromPeople: cleared });
    res.json({ success: true, removedFromPeople: cleared });
});

// ------------------------------------------------------------- tags on a person
/** HR and read-only roles see anyone's tags; a manager sees their direct reports'. Employees do not see tags (they are HR labels). */
function maySeeTags(req, emp) {
    if (can(req.user, 'people.read')) return true;
    const mgr = emp.data.usProfile && emp.data.usProfile.managerId;
    return canonicalRole(req.user.role) === 'manager' && Boolean(mgr) && mgr === req.user.id;
}

router.get('/employees/:id/tags', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    if (!maySeeTags(req, emp)) return fail(res, 403, 'You do not have permission to do this');
    const tags = await store.listByOrg('people_tags', req.orgId);
    const ids = T.cleanTagIds(emp.data.tags, tags);
    res.json({ success: true, personId: emp.id, data: T.sortTags(tags.filter((t) => ids.includes(t.id))).map(pubTag) });
});

/** Body: { add: [tagId], remove: [tagId] } (either or both). Done in a transaction so two HR people tagging at once both land. */
router.put('/employees/:id/tags', requirePermission('people.write'), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.id);
    if (!emp) return fail(res, 404, 'Employee not found');
    const tags = await store.listByOrg('people_tags', req.orgId);
    const b = req.body || {};
    const result = await db.runTransaction(async (tx) => {
        const snap = await tx.get(emp.ref);
        const data = snap.data() || {};
        if (data.orgId !== req.orgId) return { errors: ['Employee not found'] };
        const r = T.applyChange(data.tags, tags, { add: b.add, remove: b.remove });
        if (!r.errors.length) tx.set(emp.ref, { tags: r.value }, { merge: true });
        return r;
    });
    if (result.errors.length) return invalid(res, result.errors);
    if (result.added.length || result.removed.length) audit(req.orgId, req, 'people_tags_changed', emp.id, { added: result.added, removed: result.removed });
    res.json({ success: true, personId: emp.id, added: result.added, removed: result.removed, data: T.sortTags(tags.filter((t) => result.value.includes(t.id))).map(pubTag) });
});

// ------------------------------------------------------ people list by tag
/** ?tag=<id or name>[,<id or name>] &match=any|all &all=true (include people who left). No tag = everyone, with their tags. */
router.get('/people/tagged', requirePermission('people.read'), requireUsOrg, async (req, res) => {
    const [tags, people] = await Promise.all([store.listByOrg('people_tags', req.orgId), peopleWithTags(req.orgId)]);
    const { ids, unknown } = T.resolveFilter(req.query.tag, tags);
    if (unknown.length) return invalid(res, [`not a tag of this company: ${unknown.join(', ')}`]);
    const mode = req.query.match === 'all' ? 'all' : 'any';
    const byId = Object.fromEntries(tags.map((t) => [t.id, t]));
    const rows = people.filter((p) => req.query.all === 'true' || store.isActivePerson(p)).map((p) => ({ ...p, tags: T.cleanTagIds(p.tags, tags) }));
    const data = T.filterByTags(rows, ids, mode).map((p) => {
        const up = p.usProfile || {};
        return {
            id: p.id, employeeId: p.employeeId || null, name: p.name || [up.legalFirstName, up.legalLastName].filter(Boolean).join(' ') || p.email || p.id,
            email: p.email || null, jobTitle: up.jobTitle || p.jobTitle || null, status: p.status || 'active',
            tags: T.sortTags(p.tags.map((id) => byId[id])).map((t) => ({ id: t.id, name: t.name, color: t.color || 'grey' }))
        };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ success: true, filter: { tags: ids, match: mode }, count: data.length, data });
});

module.exports = router;
