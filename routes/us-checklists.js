const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { requireUsOrg, findEmployee, audit, PEOPLE_COLLECTIONS } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const timeRules = require('../services/time-rules');
const rules = require('../services/checklist-rules');
const store = require('../services/us-checklist-service');
const { parseIsoDate } = require('../services/us-forms');

router.use(verifyToken);

const norm = (r) => String(r || '').toLowerCase().replace(/[\s_-]+/g, '');
const isStaff = (user) => ADMIN_HR_ROLES.some((r) => norm(r) === norm(user.role));
const isSelf = (user, emp) => [emp.id, emp.data.uid, emp.data.userId].filter(Boolean).includes(user.id);
const orgOptions = (org) => ({ skipFederalHolidays: Boolean(org.usProfile && org.usProfile.i9SkipFederalHolidays) });
const startDateOf = (emp) => {
    const d = String((emp.data.usProfile && emp.data.usProfile.startDate) || emp.data.joiningDate || '').slice(0, 10);
    return parseIsoDate(d) ? d : null;
};

/** Checklists for one person with live state; creates the onboarding list for a recent hire if missing */
async function checklistsFor(req, emp) {
    const info = await orgInfo(req.orgId);
    const today = timeRules.localDate(new Date().toISOString(), info.tz);
    let lists = await store.listForUser(req.orgId, emp.id);
    if (!lists.some((c) => c.kind === 'onboarding') && !/terminated/i.test(String(emp.data.status || ''))) {
        const start = startDateOf(emp);
        const sixtyDaysAgo = new Date(new Date(`${today}T00:00:00Z`).getTime() - 60 * 86400000).toISOString().slice(0, 10);
        if (start && start >= sixtyDaysAgo) {
            lists = [...lists, await store.createChecklist(req.orgId, emp, 'onboarding', start, orgOptions(req.org))];
        }
    }
    const facts = store.factsFor(emp.data);
    return lists.map((c) => ({ id: c.id, kind: c.kind, anchorDate: c.anchorDate, ...rules.evaluate(c.tasks, facts, today) }));
}

/** One person's lists. Employees see their own; staff see anyone's. */
router.get('/checklists/person/:userId', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.userId);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    if (!isStaff(req.user) && !isSelf(req.user, emp)) return res.status(403).json({ success: false, error: 'Not allowed' });
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, name: emp.data.name || null, lists: await checklistsFor(req, emp) });
});

router.get('/checklists/mine', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.user.id);
    if (!emp) return res.json({ success: true, lists: [] });
    const lists = (await checklistsFor(req, emp)).map((l) => ({ ...l, tasks: l.tasks.filter((t) => t.assignee === 'employee') }));
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, lists });
});

/** Tick or un-tick a task */
router.put('/checklists/person/:userId/:listId/tasks/:taskId', requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.userId);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const ref = rawCollection('checklists').doc(req.params.listId);
    const snap = await ref.get();
    if (!store.exists(snap) || snap.data().orgId !== req.orgId || snap.data().userId !== emp.id) return res.status(404).json({ success: false, error: 'Checklist not found' });
    const list = snap.data();
    const task = list.tasks.find((t) => t.id === req.params.taskId);
    if (!task) return res.status(404).json({ success: false, error: 'Task not found' });
    if (!rules.canComplete(task, req.user.role, isSelf(req.user, emp))) return res.status(403).json({ success: false, error: 'This task is not yours to tick' });
    const status = String((req.body && req.body.status) || '');
    if (!['done', 'open', 'skipped'].includes(status)) return res.status(400).json({ success: false, error: 'status must be done, open or skipped' });
    if (status === 'skipped' && task.required && !isStaff(req.user)) return res.status(403).json({ success: false, error: 'Only HR can skip a required task' });
    task.status = status; task.note = req.body.note ? String(req.body.note).slice(0, 300) : task.note;
    task.doneAt = status === 'done' ? new Date().toISOString() : null; task.doneBy = status === 'done' ? req.user.id : null;
    await ref.update({ tasks: list.tasks });
    audit(req.orgId, req, 'checklist_task_updated', emp.id, { list: list.kind, task: task.id, status });
    res.json({ success: true });
});

/** HR adds a custom task to one person's list */
router.post('/checklists/person/:userId/:listId/tasks', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const emp = await findEmployee(req.orgId, req.params.userId);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found' });
    const ref = rawCollection('checklists').doc(req.params.listId);
    const snap = await ref.get();
    if (!store.exists(snap) || snap.data().orgId !== req.orgId || snap.data().userId !== emp.id) return res.status(404).json({ success: false, error: 'Checklist not found' });
    const info = await orgInfo(req.orgId);
    const { errors, value } = rules.validateCustomTask(req.body, timeRules.localDate(new Date().toISOString(), info.tz));
    if (errors.length) return res.status(400).json({ success: false, errors });
    await ref.update({ tasks: [...snap.data().tasks, value] });
    audit(req.orgId, req, 'checklist_task_added', emp.id, { title: value.title });
    res.status(201).json({ success: true, task: value });
});

/** HR to-do list across everyone: open tasks, overdue first */
router.get('/checklists/overview', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const today = timeRules.localDate(new Date().toISOString(), info.tz);
    const [lists, snaps] = await Promise.all([
        rawCollection('checklists').where('orgId', '==', req.orgId).get(),
        Promise.all(PEOPLE_COLLECTIONS.map((n) => db.collection(n).get()))
    ]);
    const people = new Map(snaps.flatMap((s) => s.docs).filter((d) => d.data().orgId === req.orgId).map((d) => [d.id, d.data()]));
    const assignee = req.query.assignee && rules.ASSIGNEES.includes(req.query.assignee) ? req.query.assignee : null;
    const rows = [];
    for (const doc of lists.docs) {
        const c = doc.data();
        if (c.cancelled || !people.has(c.userId)) continue;
        const ev = rules.evaluate(c.tasks, store.factsFor(people.get(c.userId)), today);
        ev.tasks.filter((t) => !t.done && !t.skipped && (!assignee || t.assignee === assignee)).forEach((t) => rows.push({
            listId: doc.id, userId: c.userId, employeeId: c.employeeId, name: c.name, kind: c.kind, taskId: t.id, title: t.title,
            assignee: t.assignee, dueDate: t.dueDate, overdue: t.overdue, dueSoon: t.dueSoon, required: t.required, help: t.help
        }));
    }
    rows.sort((a, b) => (b.overdue - a.overdue) || a.dueDate.localeCompare(b.dueDate));
    res.json({ success: true, today, counts: { open: rows.length, overdue: rows.filter((r) => r.overdue).length }, data: rows.slice(0, 500) });
});

module.exports = router;
