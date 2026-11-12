const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, findEmployee, audit, exists } = require('./us-hr').helpers;
const { orgInfo, punchesSince } = require('./time').helpers;
const { requirePermission, requireAnyPermission, can, canManage } = require('../services/permissions');
const teamScope = require('../services/team-scope');
const timeRules = require('../services/time-rules');
const S = require('../services/schedule-rules');

router.use(verifyToken);
const SCHED = requireAnyPermission('time.approve', 'time.approve_team');
const B = '/schedule';
const nowIso = () => new Date().toISOString();
const isMonday = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) && S.weekStartOf(d) === d;
const col = (n) => rawCollection(n);
const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
const mineOrg = (orgId) => (r) => r.orgId === orgId;

async function settingsOf(orgId) {
    const s = await col('schedule_settings').doc(orgId).get();
    return { ...S.DEFAULT_SETTINGS, ...(exists(s) ? s.data() : {}) };
}
async function getDoc(name, orgId, id) {
    const s = await col(name).doc(String(id)).get();
    return exists(s) && s.data().orgId === orgId ? { id: s.id, ref: s.ref, ...s.data() } : null;
}
const person = async (orgId, id) => { const d = await getDoc('users', orgId, id); return d; };
const mayManage = (req, p) => Boolean(p) && canManage(req.user, p, 'time');

async function notify(orgId, userId, type, title, message, extra = {}) {
    if (!userId) return;
    await col('schedule_notices').add({ orgId, userId, type, title, message, read: false, createdAt: nowIso(), ...extra }).catch(() => {});
}

async function shiftsOfUser(orgId, userId) {
    return rows(await col('schedule_shifts').where('userId', '==', userId).get()).filter(mineOrg(orgId) && ((s) => s.orgId === orgId && s.status !== 'cancelled'));
}

/** Conflict list for a candidate shift (needs userId). Hard ones have severity 'block'. */
async function checkShift(orgId, shift, settings, tz) {
    const [others, leaves, av] = await Promise.all([
        shiftsOfUser(orgId, shift.userId),
        col('leave_requests').where('userId', '==', shift.userId).get().then((s) => rows(s).filter((l) => l.orgId === orgId)),
        col('schedule_availability').doc(`${orgId}_${shift.userId}`).get()
    ]);
    return S.conflictsFor({ shift, others, leaves, settings, avail: exists(av) ? av.data() : null, tz });
}

const stateOfPerson = async (orgId, p) => {
    const pr = (p && p.usProfile) || {};
    if (pr.workState) return pr.workState;
    const lid = pr.locationId || (p && p.locationId);
    if (lid) { const l = await getDoc('locations', orgId, lid); if (l) return l.state || null; }
    return null;
};

/** For a change to a PUBLISHED shift: premium-pay flag per the predictive rules table */
async function premiumFor(orgId, shift, change) {
    const rules = rows(await col('predictive_schedule_rules').where('orgId', '==', orgId).get());
    if (!rules.length) return null;
    const p = shift.userId ? await person(orgId, shift.userId) : null;
    return S.premiumOwed({ shift, change, nowIso: nowIso(), rules, state: await stateOfPerson(orgId, p) });
}

/* ------------------------------ settings ------------------------------ */

router.get(`${B}/settings`, SCHED, requireUsOrg, async (req, res) => res.json({ success: true, settings: await settingsOf(req.orgId) }));
router.put(`${B}/settings`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    const { errors, value } = S.validateSettings(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    await col('schedule_settings').doc(req.orgId).set({ ...value, orgId: req.orgId, updatedAt: nowIso(), updatedBy: req.user.id });
    audit(req.orgId, req, 'schedule_settings_saved', req.orgId);
    res.json({ success: true, settings: value });
});

/* ------------------------------ templates ------------------------------ */

router.get(`${B}/templates`, SCHED, requireUsOrg, async (req, res) => {
    res.json({ success: true, data: rows(await col('shift_templates').where('orgId', '==', req.orgId).get()).filter((t) => t.active !== false) });
});
router.post(`${B}/templates`, SCHED, requireUsOrg, async (req, res) => {
    const { errors, value } = S.validateTemplate(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ref = await col('shift_templates').add({ ...value, orgId: req.orgId, active: true, createdAt: nowIso(), createdBy: req.user.id });
    res.status(201).json({ success: true, template: { id: ref.id, ...value } });
});
router.put(`${B}/templates/:id`, SCHED, requireUsOrg, async (req, res) => {
    const t = await getDoc('shift_templates', req.orgId, req.params.id);
    if (!t) return res.status(404).json({ success: false, error: 'Template not found' });
    const { errors, value } = S.validateTemplate({ ...t, ...req.body });
    if (errors.length) return res.status(400).json({ success: false, errors });
    await t.ref.update({ ...value, updatedAt: nowIso() });
    res.json({ success: true, template: { id: t.id, ...value } });
});
router.delete(`${B}/templates/:id`, SCHED, requireUsOrg, async (req, res) => {
    const t = await getDoc('shift_templates', req.orgId, req.params.id);
    if (!t) return res.status(404).json({ success: false, error: 'Template not found' });
    await t.ref.update({ active: false });
    res.json({ success: true });
});

/* ------------------------------ shifts ------------------------------ */

async function buildShift(req, body, tz, base = {}) {
    let b = { ...base, ...body };
    if (body.templateId) {
        const t = await getDoc('shift_templates', req.orgId, body.templateId);
        if (!t) return { error: 'Template not found', code: 404 };
        b = { startTime: t.startTime, endTime: t.endTime, breakMinutes: t.breakMinutes, role: t.role, locationId: t.locationId, departmentId: t.departmentId, ...b };
    }
    const { errors, value } = S.validateShiftInput(b, tz);
    if (errors.length) return { errors, code: 400 };
    const shift = {
        ...value, orgId: req.orgId, userId: b.userId || null, locationId: b.locationId || null, departmentId: b.departmentId || null, role: b.role ? String(b.role).slice(0, 60) : null,
        jobId: b.jobId || null, templateId: b.templateId || null, notes: b.notes ? String(b.notes).slice(0, 300) : null, weekStart: S.weekStartOf(value.date)
    };
    if (shift.jobId && !(await getDoc('jobs', req.orgId, shift.jobId))) return { errors: ['Job not found'], code: 400 };
    if (shift.userId) {
        const p = await person(req.orgId, shift.userId);
        if (!p) return { error: 'Person not found', code: 404 };
        if (!mayManage(req, p)) return { error: 'You can only schedule your own team', code: 403 };
    }
    return { shift };
}

const blocked = (c) => c.filter((x) => x.severity === 'block');

router.post(`${B}/shifts`, SCHED, requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const built = await buildShift(req, req.body || {}, info.tz);
    if (built.code) return res.status(built.code).json(built.errors ? { success: false, errors: built.errors } : { success: false, error: built.error });
    const shift = { ...built.shift, status: 'draft', createdAt: nowIso(), createdBy: req.user.id };
    let conflicts = [];
    if (shift.userId) {
        conflicts = await checkShift(req.orgId, shift, await settingsOf(req.orgId), info.tz);
        if (blocked(conflicts).length) return res.status(409).json({ success: false, error: blocked(conflicts)[0].message, conflicts });
    }
    // Adding a shift to a week that is already published is a schedule change
    const sib = rows(await col('schedule_shifts').where('orgId', '==', req.orgId).get()).find((s) => s.weekStart === shift.weekStart && s.status === 'published' && (s.locationId || null) === shift.locationId && (s.departmentId || null) === shift.departmentId);
    if (sib) { shift.status = 'published'; shift.publishedAt = nowIso(); const pr = await premiumFor(req.orgId, shift, 'added'); if (pr) shift.premiumOwed = [pr]; }
    const ref = await col('schedule_shifts').add(shift);
    if (shift.status === 'published') await notify(req.orgId, shift.userId, 'shift_added', 'New shift', `You were added to a shift on ${shift.date} ${shift.startTime}-${shift.endTime}.`, { shiftId: ref.id });
    audit(req.orgId, req, 'shift_created', ref.id, { userId: shift.userId, date: shift.date });
    res.status(201).json({ success: true, shift: { id: ref.id, ...shift }, warnings: conflicts });
});

router.post(`${B}/shifts/bulk`, SCHED, requireUsOrg, async (req, res) => {
    const b = req.body || {};
    const userIds = Array.isArray(b.userIds) ? b.userIds.slice(0, 100) : [];
    const dates = Array.isArray(b.dates) ? b.dates.slice(0, 31) : [];
    if (!dates.length) return res.status(400).json({ success: false, error: 'dates is required' });
    const info = await orgInfo(req.orgId); const settings = await settingsOf(req.orgId);
    const targets = userIds.length ? userIds : [null];
    const results = [];
    for (const uid of targets) for (const date of dates) {
        const built = await buildShift(req, { ...b, userId: uid, date }, info.tz);
        if (built.code) { results.push({ userId: uid, date, created: false, error: built.error || built.errors.join('; ') }); continue; }
        const shift = { ...built.shift, status: 'draft', createdAt: nowIso(), createdBy: req.user.id };
        const conflicts = shift.userId ? await checkShift(req.orgId, shift, settings, info.tz) : [];
        if (blocked(conflicts).length) { results.push({ userId: uid, date, created: false, error: blocked(conflicts)[0].message, conflicts }); continue; }
        const ref = await col('schedule_shifts').add(shift);
        results.push({ userId: uid, date, created: true, id: ref.id, warnings: conflicts });
    }
    audit(req.orgId, req, 'shifts_bulk_created', null, { created: results.filter((r) => r.created).length });
    res.status(201).json({ success: true, created: results.filter((r) => r.created).length, skipped: results.filter((r) => !r.created).length, results });
});

router.put(`${B}/shifts/:id`, SCHED, requireUsOrg, async (req, res) => {
    const cur = await getDoc('schedule_shifts', req.orgId, req.params.id);
    if (!cur || cur.status === 'cancelled') return res.status(404).json({ success: false, error: 'Shift not found' });
    if (cur.userId && !mayManage(req, await person(req.orgId, cur.userId))) return res.status(403).json({ success: false, error: 'Not allowed' });
    const info = await orgInfo(req.orgId);
    const built = await buildShift(req, req.body || {}, info.tz, cur);
    if (built.code) return res.status(built.code).json(built.errors ? { success: false, errors: built.errors } : { success: false, error: built.error });
    const next = { ...cur, ...built.shift, id: cur.id };
    let conflicts = [];
    if (next.userId) {
        conflicts = await checkShift(req.orgId, next, await settingsOf(req.orgId), info.tz);
        if (blocked(conflicts).length) return res.status(409).json({ success: false, error: blocked(conflicts)[0].message, conflicts });
    }
    const patch = { ...built.shift, updatedAt: nowIso(), updatedBy: req.user.id };
    const timeChanged = cur.startAt !== next.startAt || cur.endAt !== next.endAt || cur.userId !== next.userId;
    if (cur.status === 'published' && timeChanged) {
        const pr = await premiumFor(req.orgId, cur, cur.userId !== next.userId ? 'reassigned' : 'time_changed');
        patch.changes = [...(cur.changes || []), { at: nowIso(), by: req.user.id, from: { date: cur.date, startTime: cur.startTime, endTime: cur.endTime, userId: cur.userId || null } }];
        if (pr) patch.premiumOwed = [...(cur.premiumOwed || []), pr];
        await notify(req.orgId, next.userId, 'shift_changed', 'Shift changed', `Your shift on ${next.date} is now ${next.startTime}-${next.endTime}.`, { shiftId: cur.id });
        if (cur.userId && cur.userId !== next.userId) await notify(req.orgId, cur.userId, 'shift_removed', 'Shift removed', `Your shift on ${cur.date} ${cur.startTime}-${cur.endTime} was reassigned.`, { shiftId: cur.id });
    }
    await cur.ref.update(patch);
    audit(req.orgId, req, 'shift_updated', cur.id, { published: cur.status === 'published', premium: Boolean(patch.premiumOwed) });
    res.json({ success: true, shift: { ...cur, ...patch, ref: undefined }, warnings: conflicts, premiumOwed: patch.premiumOwed || cur.premiumOwed || [] });
});

router.delete(`${B}/shifts/:id`, SCHED, requireUsOrg, async (req, res) => {
    const cur = await getDoc('schedule_shifts', req.orgId, req.params.id);
    if (!cur || cur.status === 'cancelled') return res.status(404).json({ success: false, error: 'Shift not found' });
    if (cur.userId && !mayManage(req, await person(req.orgId, cur.userId))) return res.status(403).json({ success: false, error: 'Not allowed' });
    if (cur.status !== 'published') { await cur.ref.delete(); return res.json({ success: true, deleted: true }); }
    const pr = await premiumFor(req.orgId, cur, 'cancelled');
    await cur.ref.update({ status: 'cancelled', cancelledAt: nowIso(), cancelledBy: req.user.id, ...(pr ? { premiumOwed: [...(cur.premiumOwed || []), pr] } : {}) });
    await notify(req.orgId, cur.userId, 'shift_cancelled', 'Shift cancelled', `Your shift on ${cur.date} ${cur.startTime}-${cur.endTime} was cancelled.`, { shiftId: cur.id });
    audit(req.orgId, req, 'shift_cancelled', cur.id, { premium: Boolean(pr) });
    res.json({ success: true, cancelled: true, premiumOwed: pr ? [pr] : [] });
});

/* ------------------------------ week view, copy, publish ------------------------------ */

async function scopedShifts(req, weekStart, q = {}) {
    let list = rows(await col('schedule_shifts').where('orgId', '==', req.orgId).get()).filter((s) => s.weekStart === weekStart && s.status !== 'cancelled');
    if (q.locationId) list = list.filter((s) => s.locationId === q.locationId);
    if (q.departmentId) list = list.filter((s) => s.departmentId === q.departmentId);
    const people = await teamScope.loadOrgPeople(req.orgId);
    return { list: list.filter((s) => !s.userId || canManage(req.user, people.get(s.userId), 'time')), people };
}

router.get(`${B}/week`, SCHED, requireUsOrg, async (req, res) => {
    const weekStart = String(req.query.weekStart || '');
    if (!isMonday(weekStart)) return res.status(400).json({ success: false, error: 'weekStart must be a Monday (YYYY-MM-DD)' });
    const info = await orgInfo(req.orgId); const settings = await settingsOf(req.orgId);
    const { list, people } = await scopedShifts(req, weekStart, req.query);
    const today = timeRules.localDate(nowIso(), info.tz);
    const staff = [];
    for (const p of people.values()) {
        if (!['active', 'terminating'].includes(String(p.status || 'active').toLowerCase())) continue;
        if (!canManage(req.user, p, 'time')) continue;
        const mine = list.filter((s) => s.userId === p.id);
        let worked = {};
        if (weekStart < today) {
            const sheet = timeRules.timesheet(await punchesSince(req.orgId, p.id, new Date(new Date(`${weekStart}T00:00:00Z`).getTime() - 86400000).toISOString()), info.tz, nowIso(), null);
            sheet.days.forEach((d) => { worked[d.date] = d.workedMinutes / 60; });
        }
        const scheduled = S.weeklyHours(weekStart, mine);
        const projected = S.projectedWeekHours(weekStart, mine, worked, today);
        const warn = [];
        if (projected > settings.maxWeeklyHours) warn.push('over_weekly_hours'); else if (projected > settings.overtimeWeeklyHours) warn.push('overtime_risk');
        staff.push({ userId: p.id, name: p.name || null, jobTitle: p.jobTitle || null, scheduledHours: scheduled, projectedHours: projected, warnings: warn });
    }
    staff.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({ success: true, weekStart, today, settings, staff, shifts: list.map((s) => ({ ...s, ref: undefined })), published: list.length > 0 && list.every((s) => s.status === 'published') });
});

router.post(`${B}/copy`, SCHED, requireUsOrg, async (req, res) => {
    const { fromWeek, toWeek } = req.body || {};
    if (!isMonday(fromWeek) || !isMonday(toWeek) || fromWeek === toWeek) return res.status(400).json({ success: false, error: 'fromWeek and toWeek must be different Mondays' });
    const info = await orgInfo(req.orgId); const settings = await settingsOf(req.orgId);
    const { list } = await scopedShifts(req, fromWeek, req.body);
    const copies = S.copyWeek(list, fromWeek, toWeek, info.tz);
    let created = 0; const skipped = [];
    for (const c of copies) {
        const shift = { ...c, orgId: req.orgId, status: 'draft', weekStart: toWeek, createdAt: nowIso(), createdBy: req.user.id, copiedFrom: fromWeek };
        if (shift.userId) {
            const cf = await checkShift(req.orgId, shift, settings, info.tz);
            if (blocked(cf).length) { skipped.push({ userId: shift.userId, date: shift.date, reason: blocked(cf)[0].message }); continue; }
        }
        await col('schedule_shifts').add(shift); created += 1;
    }
    audit(req.orgId, req, 'schedule_week_copied', null, { fromWeek, toWeek, created });
    res.status(201).json({ success: true, created, skipped });
});

router.post(`${B}/publish`, SCHED, requireUsOrg, async (req, res) => {
    const weekStart = String((req.body && req.body.weekStart) || '');
    if (!isMonday(weekStart)) return res.status(400).json({ success: false, error: 'weekStart must be a Monday (YYYY-MM-DD)' });
    const { list } = await scopedShifts(req, weekStart, req.body);
    const drafts = list.filter((s) => s.status === 'draft');
    const at = nowIso(); const byUser = new Map();
    for (const s of drafts) {
        await col('schedule_shifts').doc(s.id).update({ status: 'published', publishedAt: at, publishedBy: req.user.id });
        if (s.userId) byUser.set(s.userId, (byUser.get(s.userId) || 0) + 1);
    }
    for (const [uid, n] of byUser) await notify(req.orgId, uid, 'schedule_published', 'Your schedule is published', `${n} shift${n === 1 ? '' : 's'} for the week of ${weekStart}.`, { weekStart });
    audit(req.orgId, req, 'schedule_published', weekStart, { shifts: drafts.length });
    res.json({ success: true, published: drafts.length, notified: byUser.size, publishedAt: at });
});

/* ------------------------------ employee: my schedule, open shifts ------------------------------ */

router.get(`${B}/mine`, requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId);
    const today = timeRules.localDate(nowIso(), info.tz);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : today;
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : S.addDays(today, 28);
    const mine = (await shiftsOfUser(req.orgId, req.user.id)).filter((s) => s.status === 'published' && s.date >= from && s.date <= to).sort((a, b) => a.startAt.localeCompare(b.startAt));
    res.json({ success: true, from, to, today, data: mine.map((s) => ({ ...s, ref: undefined, premiumOwed: undefined, changes: undefined })) });
});

router.get(`${B}/open`, requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId); const today = timeRules.localDate(nowIso(), info.tz);
    const me = await person(req.orgId, req.user.id);
    const list = rows(await col('schedule_shifts').where('orgId', '==', req.orgId).get())
        .filter((s) => !s.userId && s.status === 'published' && s.date >= today && S.isQualified(s, me)).sort((a, b) => a.startAt.localeCompare(b.startAt));
    res.json({ success: true, data: list.map((s) => ({ id: s.id, date: s.date, startTime: s.startTime, endTime: s.endTime, hours: s.hours, role: s.role, locationId: s.locationId, claimPending: Boolean(s.claim && s.claim.status === 'pending'), mineClaim: Boolean(s.claim && s.claim.userId === req.user.id && s.claim.status === 'pending') })) });
});

router.post(`${B}/shifts/:id/claim`, requireUsOrg, async (req, res) => {
    const s = await getDoc('schedule_shifts', req.orgId, req.params.id);
    if (!s || s.status !== 'published' || s.userId) return res.status(404).json({ success: false, error: 'This open shift is not available' });
    if (s.claim && s.claim.status === 'pending') return res.status(409).json({ success: false, error: 'Someone has already claimed this shift. Waiting for approval.' });
    const me = await person(req.orgId, req.user.id);
    if (!me || !S.isQualified(s, me)) return res.status(403).json({ success: false, error: 'You are not qualified for this shift' });
    const info = await orgInfo(req.orgId); const settings = await settingsOf(req.orgId);
    const conflicts = await checkShift(req.orgId, { ...s, userId: req.user.id }, settings, info.tz);
    if (blocked(conflicts).length) return res.status(409).json({ success: false, error: blocked(conflicts)[0].message, conflicts });
    if (settings.claimNeedsApproval) {
        await s.ref.update({ claim: { userId: req.user.id, name: me.name || null, at: nowIso(), status: 'pending' } });
        audit(req.orgId, req, 'open_shift_claimed', s.id, {});
        return res.json({ success: true, status: 'pending_approval', warnings: conflicts });
    }
    await s.ref.update({ userId: req.user.id, claim: null, assignedVia: 'claim' });
    audit(req.orgId, req, 'open_shift_taken', s.id, {});
    res.json({ success: true, status: 'assigned', warnings: conflicts });
});

router.post(`${B}/shifts/:id/claim/decision`, SCHED, requireUsOrg, async (req, res) => {
    const s = await getDoc('schedule_shifts', req.orgId, req.params.id);
    if (!s || !s.claim || s.claim.status !== 'pending') return res.status(404).json({ success: false, error: 'No pending claim' });
    const claimer = await person(req.orgId, s.claim.userId);
    if (!mayManage(req, claimer)) return res.status(403).json({ success: false, error: 'Not allowed' });
    const decision = String((req.body && req.body.decision) || '');
    if (!['approve', 'deny'].includes(decision)) return res.status(400).json({ success: false, error: 'decision must be approve or deny' });
    if (decision === 'approve') {
        const info = await orgInfo(req.orgId);
        const cf = await checkShift(req.orgId, { ...s, userId: s.claim.userId }, await settingsOf(req.orgId), info.tz);
        if (blocked(cf).length) return res.status(409).json({ success: false, error: blocked(cf)[0].message, conflicts: cf });
        await s.ref.update({ userId: s.claim.userId, claim: null, assignedVia: 'claim' });
        await notify(req.orgId, s.claim.userId, 'claim_approved', 'Shift approved', `You got the shift on ${s.date} ${s.startTime}-${s.endTime}.`, { shiftId: s.id });
    } else {
        await s.ref.update({ claim: null });
        await notify(req.orgId, s.claim.userId, 'claim_denied', 'Shift not approved', `Your request for the shift on ${s.date} was not approved.`, { shiftId: s.id });
    }
    audit(req.orgId, req, `open_shift_claim_${decision}`, s.id, { userId: s.claim.userId });
    res.json({ success: true });
});

router.get(`${B}/claims`, SCHED, requireUsOrg, async (req, res) => {
    const people = await teamScope.loadOrgPeople(req.orgId);
    const list = rows(await col('schedule_shifts').where('orgId', '==', req.orgId).get()).filter((s) => s.claim && s.claim.status === 'pending' && canManage(req.user, people.get(s.claim.userId), 'time'));
    res.json({ success: true, data: list.map((s) => ({ shiftId: s.id, date: s.date, startTime: s.startTime, endTime: s.endTime, claimedBy: s.claim.userId, name: s.claim.name, at: s.claim.at })) });
});

/* ------------------------------ swaps and drops ------------------------------ */

router.post(`${B}/swaps`, requireUsOrg, async (req, res) => {
    const b = req.body || {};
    const type = b.type === 'drop' ? 'drop' : 'swap';
    const shift = await getDoc('schedule_shifts', req.orgId, b.shiftId);
    if (!shift || shift.userId !== req.user.id || shift.status !== 'published') return res.status(404).json({ success: false, error: 'Shift not found' });
    const info = await orgInfo(req.orgId);
    if (shift.startAt <= nowIso()) return res.status(409).json({ success: false, error: 'That shift has already started' });
    const existing = rows(await col('shift_swaps').where('shiftId', '==', shift.id).get()).find((x) => x.orgId === req.orgId && ['pending_peer', 'pending_manager'].includes(x.status));
    if (existing) return res.status(409).json({ success: false, error: 'There is already a pending request for this shift' });
    const doc = { orgId: req.orgId, type, shiftId: shift.id, requesterId: req.user.id, requesterName: req.user.name || null, note: String(b.note || '').slice(0, 300), createdAt: nowIso(), shiftDate: shift.date, shiftTime: `${shift.startTime}-${shift.endTime}` };
    if (type === 'swap') {
        if (!b.targetUserId || b.targetUserId === req.user.id) return res.status(400).json({ success: false, error: 'Choose a coworker to swap with' });
        const peer = await person(req.orgId, b.targetUserId);
        if (!peer) return res.status(404).json({ success: false, error: 'Coworker not found' });
        if (!S.isQualified(shift, peer)) return res.status(403).json({ success: false, error: 'That coworker is not qualified for this shift' });
        const cf = await checkShift(req.orgId, { ...shift, userId: peer.id }, await settingsOf(req.orgId), info.tz);
        if (blocked(cf).length) return res.status(409).json({ success: false, error: `Your coworker cannot take it: ${blocked(cf)[0].message}`, conflicts: cf });
        doc.targetUserId = peer.id; doc.targetName = peer.name || null;
        if (b.targetShiftId) {
            const ts = await getDoc('schedule_shifts', req.orgId, b.targetShiftId);
            if (!ts || ts.userId !== peer.id || ts.status !== 'published') return res.status(404).json({ success: false, error: 'Their shift was not found' });
            doc.targetShiftId = ts.id;
        }
        doc.status = 'pending_peer';
    } else doc.status = 'pending_manager';
    const ref = await col('shift_swaps').add(doc);
    if (doc.targetUserId) await notify(req.orgId, doc.targetUserId, 'swap_request', 'Shift swap request', `${doc.requesterName || 'A coworker'} asks you to take the shift on ${shift.date} ${shift.startTime}-${shift.endTime}.`, { swapId: ref.id });
    audit(req.orgId, req, 'shift_swap_requested', ref.id, { type });
    res.status(201).json({ success: true, swap: { id: ref.id, ...doc } });
});

router.post(`${B}/swaps/:id/respond`, requireUsOrg, async (req, res) => {
    const sw = await getDoc('shift_swaps', req.orgId, req.params.id);
    if (!sw || sw.targetUserId !== req.user.id || sw.status !== 'pending_peer') return res.status(404).json({ success: false, error: 'Request not found' });
    const accept = Boolean(req.body && req.body.accept);
    const settings = await settingsOf(req.orgId);
    const status = !accept ? 'declined' : 'pending_manager';
    await sw.ref.update({ status, peerRespondedAt: nowIso() });
    await notify(req.orgId, sw.requesterId, accept ? 'swap_peer_accepted' : 'swap_peer_declined', accept ? 'Coworker accepted' : 'Coworker declined', accept ? 'Waiting for your manager.' : 'Your swap request was declined.', { swapId: sw.id });
    audit(req.orgId, req, accept ? 'shift_swap_peer_accepted' : 'shift_swap_peer_declined', sw.id, {});
    res.json({ success: true, status, managerApprovalNeeded: settings.swapNeedsManager });
});

async function applySwap(req, sw) {
    const info = await orgInfo(req.orgId); const settings = await settingsOf(req.orgId);
    const shift = await getDoc('schedule_shifts', req.orgId, sw.shiftId);
    if (!shift || shift.userId !== sw.requesterId || shift.status !== 'published') return { error: 'The shift has changed since the request' };
    const swapShift = sw.targetShiftId ? await getDoc('schedule_shifts', req.orgId, sw.targetShiftId) : null;
    if (sw.type === 'swap') {
        const others = (await shiftsOfUser(req.orgId, sw.targetUserId)).filter((o) => !swapShift || o.id !== swapShift.id);
        const cf1 = S.conflictsFor({ shift: { ...shift, userId: sw.targetUserId }, others, leaves: rows(await col('leave_requests').where('userId', '==', sw.targetUserId).get()).filter((l) => l.orgId === req.orgId), settings, avail: null, tz: info.tz });
        if (blocked(cf1).length) return { error: blocked(cf1)[0].message, conflicts: cf1 };
        if (swapShift) {
            const mineOthers = (await shiftsOfUser(req.orgId, sw.requesterId)).filter((o) => o.id !== shift.id);
            const cf2 = S.conflictsFor({ shift: { ...swapShift, userId: sw.requesterId }, others: mineOthers, leaves: rows(await col('leave_requests').where('userId', '==', sw.requesterId).get()).filter((l) => l.orgId === req.orgId), settings, avail: null, tz: info.tz });
            if (blocked(cf2).length) return { error: blocked(cf2)[0].message, conflicts: cf2 };
            await swapShift.ref.update({ userId: sw.requesterId, assignedVia: 'swap' });
        }
        await shift.ref.update({ userId: sw.targetUserId, assignedVia: 'swap' });
    } else {
        await shift.ref.update({ userId: null, claim: null, assignedVia: 'drop', droppedBy: sw.requesterId });
    }
    return { ok: true };
}

router.post(`${B}/swaps/:id/decision`, SCHED, requireUsOrg, async (req, res) => {
    const sw = await getDoc('shift_swaps', req.orgId, req.params.id);
    if (!sw || sw.status !== 'pending_manager') return res.status(404).json({ success: false, error: 'No request waiting for a decision' });
    const reqPerson = await person(req.orgId, sw.requesterId);
    if (!mayManage(req, reqPerson)) return res.status(403).json({ success: false, error: 'Not allowed' });
    if (sw.targetUserId && !mayManage(req, await person(req.orgId, sw.targetUserId))) return res.status(403).json({ success: false, error: 'Not allowed: the coworker is not on your team' });
    const decision = String((req.body && req.body.decision) || '');
    if (!['approve', 'deny'].includes(decision)) return res.status(400).json({ success: false, error: 'decision must be approve or deny' });
    if (decision === 'approve') {
        const r = await applySwap(req, sw);
        if (r.error) return res.status(409).json({ success: false, error: r.error, conflicts: r.conflicts });
    }
    const status = decision === 'approve' ? 'approved' : 'denied';
    await sw.ref.update({ status, decidedBy: req.user.id, decidedAt: nowIso(), decisionNote: String((req.body && req.body.note) || '').slice(0, 300) });
    for (const uid of [sw.requesterId, sw.targetUserId]) await notify(req.orgId, uid, `swap_${status}`, `Shift ${sw.type} ${status}`, `The ${sw.type} for ${sw.shiftDate} ${sw.shiftTime} was ${status}.`, { swapId: sw.id });
    audit(req.orgId, req, `shift_swap_${status}`, sw.id, { type: sw.type });
    res.json({ success: true, status });
});

router.post(`${B}/swaps/:id/cancel`, requireUsOrg, async (req, res) => {
    const sw = await getDoc('shift_swaps', req.orgId, req.params.id);
    if (!sw || sw.requesterId !== req.user.id || !['pending_peer', 'pending_manager'].includes(sw.status)) return res.status(404).json({ success: false, error: 'Request not found' });
    await sw.ref.update({ status: 'cancelled', cancelledAt: nowIso() });
    res.json({ success: true });
});

router.get(`${B}/swaps`, requireUsOrg, async (req, res) => {
    const all = rows(await col('shift_swaps').where('orgId', '==', req.orgId).get());
    let list;
    if (req.query.scope === 'manage') {
        if (!can(req.user, 'time.approve') && !can(req.user, 'time.approve_team')) return res.status(403).json({ success: false, error: 'Not allowed' });
        const people = await teamScope.loadOrgPeople(req.orgId);
        list = all.filter((x) => canManage(req.user, people.get(x.requesterId), 'time'));
        if (req.query.status) list = list.filter((x) => x.status === req.query.status);
    } else list = all.filter((x) => x.requesterId === req.user.id || x.targetUserId === req.user.id);
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, data: list.slice(0, 200).map((x) => ({ ...x, ref: undefined })) });
});

/** Coworkers a person could swap with (names only, same company) */
router.get(`${B}/coworkers`, requireUsOrg, async (req, res) => {
    const people = await teamScope.loadOrgPeople(req.orgId);
    res.json({ success: true, data: Array.from(people.values()).filter((p) => p.id !== req.user.id && ['active'].includes(String(p.status || 'active').toLowerCase())).map((p) => ({ userId: p.id, name: p.name || null })).sort((a, b) => String(a.name).localeCompare(String(b.name))) });
});

/* ------------------------------ availability ------------------------------ */

function cleanAvailability(body) {
    const errors = [];
    const weekly = (Array.isArray(body.weekly) ? body.weekly : []).map((w) => {
        const d = Number(w.dow);
        if (!(d >= 0 && d <= 6)) { errors.push('dow must be 0 (Sunday) to 6'); return null; }
        const out = { dow: d, available: w.available !== false };
        if (w.start || w.end) { if (!/^\d{2}:\d{2}$/.test(w.start || '') || !/^\d{2}:\d{2}$/.test(w.end || '')) { errors.push('start and end must be HH:MM'); return null; } out.start = w.start; out.end = w.end; }
        return out;
    }).filter(Boolean);
    const exceptions = (Array.isArray(body.exceptions) ? body.exceptions : []).map((x) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(x.date || '')) { errors.push('exception date must be YYYY-MM-DD'); return null; }
        const out = { date: x.date, available: x.available !== false, note: x.note ? String(x.note).slice(0, 100) : null };
        if (x.start && x.end) { out.start = x.start; out.end = x.end; }
        return out;
    }).filter(Boolean);
    return { errors, value: { weekly: weekly.slice(0, 40), exceptions: exceptions.slice(0, 120) } };
}

router.get(`${B}/availability`, requireUsOrg, async (req, res) => {
    const s = await col('schedule_availability').doc(`${req.orgId}_${req.user.id}`).get();
    res.json({ success: true, availability: exists(s) ? { weekly: s.data().weekly || [], exceptions: s.data().exceptions || [] } : { weekly: [], exceptions: [] } });
});
router.put(`${B}/availability`, requireUsOrg, async (req, res) => {
    const { errors, value } = cleanAvailability(req.body || {});
    if (errors.length) return res.status(400).json({ success: false, errors });
    await col('schedule_availability').doc(`${req.orgId}_${req.user.id}`).set({ ...value, orgId: req.orgId, userId: req.user.id, updatedAt: nowIso() });
    res.json({ success: true, availability: value });
});
router.get(`${B}/availability/:userId`, SCHED, requireUsOrg, async (req, res) => {
    if (!mayManage(req, await person(req.orgId, req.params.userId))) return res.status(403).json({ success: false, error: 'Not allowed' });
    const s = await col('schedule_availability').doc(`${req.orgId}_${req.params.userId}`).get();
    res.json({ success: true, availability: exists(s) ? { weekly: s.data().weekly || [], exceptions: s.data().exceptions || [] } : { weekly: [], exceptions: [] } });
});

/* ------------------------------ predictive scheduling rules ------------------------------ */

router.get(`${B}/predictive-rules`, SCHED, requireUsOrg, async (req, res) => {
    res.json({ success: true, note: S.PREDICTIVE_NOTE, data: rows(await col('predictive_schedule_rules').where('orgId', '==', req.orgId).get()) });
});
router.post(`${B}/predictive-rules`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    const { errors, value } = S.validatePredictiveRule(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ref = await col('predictive_schedule_rules').add({ ...value, orgId: req.orgId, createdAt: nowIso(), createdBy: req.user.id });
    audit(req.orgId, req, 'predictive_rule_created', ref.id, { noticeDays: value.noticeDays });
    res.status(201).json({ success: true, rule: { id: ref.id, ...value } });
});
router.put(`${B}/predictive-rules/:id`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    const r = await getDoc('predictive_schedule_rules', req.orgId, req.params.id);
    if (!r) return res.status(404).json({ success: false, error: 'Rule not found' });
    const { errors, value } = S.validatePredictiveRule({ ...r, ...req.body });
    if (errors.length) return res.status(400).json({ success: false, errors });
    await r.ref.update({ ...value, updatedAt: nowIso() });
    audit(req.orgId, req, 'predictive_rule_updated', r.id, {});
    res.json({ success: true, rule: { id: r.id, ...value } });
});
router.delete(`${B}/predictive-rules/:id`, requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    const r = await getDoc('predictive_schedule_rules', req.orgId, req.params.id);
    if (!r) return res.status(404).json({ success: false, error: 'Rule not found' });
    await r.ref.delete();
    audit(req.orgId, req, 'predictive_rule_deleted', r.id, {});
    res.json({ success: true });
});

/* ------------------------------ reports ------------------------------ */

router.get(`${B}/reports/vs-actual`, SCHED, requireUsOrg, async (req, res) => {
    const info = await orgInfo(req.orgId); const today = timeRules.localDate(nowIso(), info.tz);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : today;
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : S.addDays(to, -6);
    const people = await teamScope.loadOrgPeople(req.orgId);
    const shifts = rows(await col('schedule_shifts').where('orgId', '==', req.orgId).get()).filter((s) => s.status === 'published' && s.userId && s.date >= from && s.date <= to && canManage(req.user, people.get(s.userId), 'time'));
    const byUser = {};
    const since = new Date(new Date(`${from}T00:00:00Z`).getTime() - 2 * 86400000).toISOString();
    for (const uid of new Set(shifts.map((s) => s.userId))) byUser[uid] = await punchesSince(req.orgId, uid, since);
    const r = S.compareScheduleToActual(shifts, byUser, info.tz, nowIso());
    res.json({ success: true, from, to, summary: r.summary, data: r.rows.map((x) => ({ ...x, name: (people.get(x.userId) || {}).name || null })) });
});

router.get(`${B}/reports/premium`, SCHED, requireUsOrg, async (req, res) => {
    const people = await teamScope.loadOrgPeople(req.orgId);
    const list = rows(await col('schedule_shifts').where('orgId', '==', req.orgId).get()).filter((s) => (s.premiumOwed || []).length && (!s.userId || canManage(req.user, people.get(s.userId), 'time')));
    res.json({ success: true, data: list.map((s) => ({ shiftId: s.id, userId: s.userId || null, name: (people.get(s.userId) || {}).name || null, date: s.date, startTime: s.startTime, status: s.status, premiumOwed: s.premiumOwed })) });
});

/* ------------------------------ in-app notices ------------------------------ */

router.get(`${B}/notices`, requireUsOrg, async (req, res) => {
    const list = rows(await col('schedule_notices').where('userId', '==', req.user.id).get()).filter(mineOrg(req.orgId)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ success: true, unread: list.filter((n) => !n.read).length, data: list.slice(0, 50) });
});
router.post(`${B}/notices/:id/read`, requireUsOrg, async (req, res) => {
    const n = await getDoc('schedule_notices', req.orgId, req.params.id);
    if (!n || n.userId !== req.user.id) return res.status(404).json({ success: false, error: 'Notice not found' });
    await n.ref.update({ read: true });
    res.json({ success: true });
});

/* ------------------------------ jobs and time allocation ------------------------------ */

router.get('/jobs', requireUsOrg, async (req, res) => {
    res.json({ success: true, data: rows(await col('jobs').where('orgId', '==', req.orgId).get()).filter((j) => j.active !== false || req.query.all === '1').sort((a, b) => String(a.code).localeCompare(String(b.code))) });
});
router.post('/jobs', requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    const { errors, value } = S.validateJob(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const dup = rows(await col('jobs').where('orgId', '==', req.orgId).get()).find((j) => j.code === value.code);
    if (dup) return res.status(409).json({ success: false, error: 'A job with that code already exists' });
    const ref = await col('jobs').add({ ...value, orgId: req.orgId, createdAt: nowIso(), createdBy: req.user.id });
    audit(req.orgId, req, 'job_created', ref.id, { code: value.code });
    res.status(201).json({ success: true, job: { id: ref.id, ...value } });
});
router.put('/jobs/:id', requirePermission('time.manage_rules'), requireUsOrg, async (req, res) => {
    const j = await getDoc('jobs', req.orgId, req.params.id);
    if (!j) return res.status(404).json({ success: false, error: 'Job not found' });
    const { errors, value } = S.validateJob({ ...j, ...req.body, code: j.code });
    if (errors.length) return res.status(400).json({ success: false, errors });
    await j.ref.update({ ...value, updatedAt: nowIso() });
    res.json({ success: true, job: { id: j.id, ...value } });
});

async function workedMinutesOn(orgId, userId, date, info) {
    const since = new Date(new Date(`${date}T00:00:00Z`).getTime() - 86400000).toISOString();
    const sheet = timeRules.timesheet(await punchesSince(orgId, userId, since), info.tz, nowIso(), null);
    const d = sheet.days.find((x) => x.date === date);
    return d ? d.workedMinutes : 0;
}

router.post('/allocations', requireUsOrg, async (req, res) => {
    const b = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
    const userId = b.userId && b.userId !== req.user.id ? String(b.userId) : req.user.id;
    if (userId !== req.user.id && !mayManage(req, await person(req.orgId, userId))) return res.status(403).json({ success: false, error: 'Not allowed' });
    const info = await orgInfo(req.orgId);
    const worked = await workedMinutesOn(req.orgId, userId, b.date, info);
    const existing = rows(await col('time_allocations').where('userId', '==', userId).get()).filter((a) => a.orgId === req.orgId && a.date === b.date);
    const keep = existing.filter((a) => a.source !== 'split');
    const { errors, value } = S.validateAllocations(b.allocations, worked, keep.reduce((s, a) => s + a.minutes, 0));
    if (errors.length) return res.status(400).json({ success: false, errors });
    for (const j of new Set(value.map((v) => v.jobId))) if (!(await getDoc('jobs', req.orgId, j))) return res.status(400).json({ success: false, errors: ['Job not found'] });
    for (const a of existing.filter((x) => x.source === 'split')) await col('time_allocations').doc(a.id).delete();
    for (const v of value) await col('time_allocations').add({ orgId: req.orgId, userId, date: b.date, jobId: v.jobId, minutes: v.minutes, note: v.note, source: 'split', createdAt: nowIso(), createdBy: req.user.id });
    audit(req.orgId, req, 'time_allocated', userId, { date: b.date, jobs: value.length });
    res.status(201).json({ success: true, workedMinutes: worked, allocatedMinutes: value.reduce((s, x) => s + x.minutes, 0) + keep.reduce((s, a) => s + a.minutes, 0) });
});

/** Per-punch allocation: the time from this punch to the next punch goes to a job */
router.post('/allocations/from-punch', requireUsOrg, async (req, res) => {
    const b = req.body || {};
    const p = await getDoc('time_punches', req.orgId, b.punchId);
    if (!p || p.userId !== req.user.id || !['in', 'break_end'].includes(p.type)) return res.status(404).json({ success: false, error: 'Punch not found' });
    if (!(await getDoc('jobs', req.orgId, b.jobId))) return res.status(400).json({ success: false, error: 'Job not found' });
    const after = (await punchesSince(req.orgId, req.user.id, p.at)).filter((x) => x.at > p.at);
    const next = after[0];
    if (!next) return res.status(409).json({ success: false, error: 'This work period is still open' });
    const minutes = Math.max(1, Math.round((new Date(next.at) - new Date(p.at)) / 60000));
    const dup = rows(await col('time_allocations').where('userId', '==', req.user.id).get()).find((a) => a.orgId === req.orgId && a.punchId === p.id);
    if (dup) return res.status(409).json({ success: false, error: 'This period is already allocated' });
    const ref = await col('time_allocations').add({ orgId: req.orgId, userId: req.user.id, date: p.localDate, jobId: b.jobId, minutes, punchId: p.id, source: 'punch', note: b.note ? String(b.note).slice(0, 200) : null, createdAt: nowIso(), createdBy: req.user.id });
    res.status(201).json({ success: true, id: ref.id, minutes });
});

router.get('/allocations', requireUsOrg, async (req, res) => {
    const userId = req.query.userId && req.query.userId !== req.user.id ? String(req.query.userId) : req.user.id;
    if (userId !== req.user.id && !mayManage(req, await person(req.orgId, userId)) && !can(req.user, 'time.view_all')) return res.status(403).json({ success: false, error: 'Not allowed' });
    let list = rows(await col('time_allocations').where('userId', '==', userId).get()).filter(mineOrg(req.orgId));
    if (req.query.from) list = list.filter((a) => a.date >= req.query.from);
    if (req.query.to) list = list.filter((a) => a.date <= req.query.to);
    res.json({ success: true, data: list.sort((a, b) => a.date.localeCompare(b.date)) });
});

router.get('/jobs/report', requireAnyPermission('time.approve', 'time.approve_team', 'time.view_all', 'reports.view'), requireUsOrg, async (req, res) => {
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '0000-00-00';
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '9999-12-31';
    let list = rows(await col('time_allocations').where('orgId', '==', req.orgId).get()).filter((a) => a.date >= from && a.date <= to);
    const wide = can(req.user, 'time.approve') || can(req.user, 'time.view_all') || can(req.user, 'reports.view');
    if (!wide) list = await teamScope.filterRows(req.user, req.orgId, list, 'time');
    const jobs = rows(await col('jobs').where('orgId', '==', req.orgId).get());
    const data = S.jobReport(list, jobs);
    res.json({ success: true, from, to, totalHours: Math.round(data.reduce((s, r) => s + r.minutes, 0) / 6) / 10, data });
});

module.exports = router;
