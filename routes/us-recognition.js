/**
 * Announcements and recognition ("thanks") for US companies.
 *
 * Announcements: HR and the owner (people.write) write, publish, archive and delete them. Read-only roles holding
 * people.read may see the HR list and the read counts. Everyone signed in to the company reads the published ones
 * meant for them; opening one leaves a single read marker per person, which is never changed or removed.
 *
 * Thanks: everyone signed in to the company may thank a coworker, read the company feed and see their own.
 * HR may hide one (it is kept and marked hidden), change the list of values and the daily limit, and read the report.
 */
const express = require('express');
const router = express.Router();
const { rawCollection } = require('../config/firebase');
const { verifyToken } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { can } = require('../services/permissions');
const timeRules = require('../services/time-rules');
const R = require('../services/recognition-rules');
const peopleStore = require('../services/people-data-store');

router.use(verifyToken);

const FEED_MAX = 60;
const nowIso = () => new Date().toISOString();
const fail = (res, code, error) => res.status(code).json({ success: false, error });
const invalid = (res, errors) => res.status(400).json({ success: false, errors });
const today = async (orgId) => timeRules.localDate(nowIso(), (await orgInfo(orgId)).tz);
const col = (n) => rawCollection(n);
const mayManage = (req) => can(req.user, 'people.write');
const maySeeAll = (req) => can(req.user, 'people.write') || can(req.user, 'people.read');
const me = (req) => String(req.user.id || req.user.uid);
const who = (req) => req.user.name || req.user.email || 'someone';
const taken = (err) => Boolean(err && (err.code === 6 || /already exists/i.test(String(err.message))));
const forbidden = (res) => fail(res, 403, 'You do not have permission to do this');

const listOrg = (name, orgId) => peopleStore.listByOrg(name, orgId);
const loadSettings = async (orgId) => { const snap = await col('recognition_settings').doc(orgId).get(); return R.settingsOf(exists(snap) && snap.data().orgId === orgId ? snap.data() : null); };
/** The caller as a person of the company (location and department), or an empty person when they have no profile */
const personOf = (people, id) => people.find((p) => p.id === id) || {};

async function ownedDoc(req, res, name, label) {
    const snap = await col(name).doc(String(req.params.id)).get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) { fail(res, 404, `${label} not found`); return null; }
    return { ref: snap.ref, id: snap.id, data: { id: snap.id, ...snap.data() }, updateTime: snap.updateTime };
}
/** Write only if nobody changed the record since it was read */
async function guardedUpdate(res, d, patch) {
    try { await d.ref.update(patch, d.updateTime ? { lastUpdateTime: d.updateTime } : undefined); return true; } catch (err) {
        if (err && (err.code === 9 || /precondition/i.test(String(err.message)))) { fail(res, 409, 'Someone else just changed this. Reload and try again.'); return false; }
        throw err;
    }
}
/** Names of the company's locations and departments, to show who an announcement is for */
async function places(orgId) {
    const [locations, departments] = await Promise.all([listOrg('locations', orgId), listOrg('departments', orgId)]);
    const pick = (rows) => rows.map((r) => ({ id: r.id, name: r.name || r.code || r.id })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { locations: pick(locations), departments: pick(departments) };
}
function audienceLabel(a, pl) {
    const aud = a.audience || { type: 'everyone' };
    if (aud.type === 'everyone') return 'Everyone';
    const hit = (aud.type === 'location' ? pl.locations : pl.departments).find((x) => x.id === aud.id);
    return `${aud.type === 'location' ? 'Location' : 'Department'}: ${hit ? hit.name : 'no longer exists'}`;
}
/** The audience must be a location or department of this company */
async function audienceError(orgId, audience) {
    if (!audience || audience.type === 'everyone') return null;
    const found = await peopleStore.getOwned(audience.type === 'location' ? 'locations' : 'departments', orgId, audience.id);
    return found ? null : audience.type === 'location' ? 'That location is not in your company' : 'That department is not in your company';
}
const annView = (a, pl, extra = {}) => ({ id: a.id, title: a.title, body: a.body, audience: a.audience || { type: 'everyone', id: null }, audienceLabel: audienceLabel(a, pl), pinned: Boolean(a.pinned), endDate: a.endDate || null, publishedAt: a.publishedAt || null, publishedByName: a.publishedByName || null, ...extra });

router.get('/recognition/options', requireUsOrg, async (req, res) => {
    const [settings, people, t, pl] = await Promise.all([loadSettings(req.orgId), peopleStore.loadPeople(req.orgId), today(req.orgId), maySeeAll(req) ? places(req.orgId) : null]);
    const mine = (await listOrg('recognition_thanks', req.orgId)).filter((x) => x.fromId === me(req));
    const sentToday = R.sentOn(mine, me(req), t);
    res.json({ success: true, today: t, values: settings.values, dailyLimit: settings.dailyLimit, sentToday, leftToday: Math.max(0, settings.dailyLimit - sentToday), messageMax: R.MESSAGE_MAX, bodyMax: R.BODY_MAX,
        // names only: enough to choose who to thank
        people: people.filter((p) => p.id !== me(req)).map((p) => ({ id: p.id, name: p.name, jobTitle: p.jobTitle || null })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
        canManage: mayManage(req), canSeeAll: maySeeAll(req), ...(pl || {}) });
});

/* ------------------------------ announcements: reading (everyone) ------------------------------ */

router.get('/announcements/mine', requireUsOrg, async (req, res) => {
    const [all, reads, people, t, pl] = await Promise.all([listOrg('announcements', req.orgId), listOrg('announcement_reads', req.orgId), peopleStore.loadPeople(req.orgId, { includeInactive: true }), today(req.orgId), places(req.orgId)]);
    const person = personOf(people, me(req));
    const readAt = new Map(reads.filter((r) => r.userId === me(req)).map((r) => [r.announcementId, r.at]));
    const data = R.sortForReading(all.filter((a) => R.isVisibleTo(a, person, t))).map((a) => annView(a, pl, { read: readAt.has(a.id), readAt: readAt.get(a.id) || null }));
    res.json({ success: true, today: t, unread: data.filter((a) => !a.read).length, data });
});

router.post('/announcements/:id/read', requireUsOrg, async (req, res) => {
    const a = await ownedDoc(req, res, 'announcements', 'Announcement'); if (!a) return;
    const [people, t] = await Promise.all([peopleStore.loadPeople(req.orgId, { includeInactive: true }), today(req.orgId)]);
    // a draft, an archived one, or one for another location is the same as one that does not exist
    if (!R.isVisibleTo(a.data, personOf(people, me(req)), t)) return fail(res, 404, 'Announcement not found');
    const at = nowIso();
    try {
        await col('announcement_reads').doc(R.readId(a.id, me(req))).create({ orgId: req.orgId, announcementId: a.id, userId: me(req), name: who(req), at });
    } catch (err) {
        if (taken(err)) return res.json({ success: true, already: true });
        throw err;
    }
    audit(req.orgId, req, 'announcement_read', a.id, {});
    res.status(201).json({ success: true, readAt: at });
});

/* ------------------------------ announcements: managing (HR, owner) ------------------------------ */

router.get('/announcements', requireUsOrg, async (req, res) => {
    if (!maySeeAll(req)) return forbidden(res);
    const [all, reads, people, t, pl] = await Promise.all([listOrg('announcements', req.orgId), listOrg('announcement_reads', req.orgId), peopleStore.loadPeople(req.orgId), today(req.orgId), places(req.orgId)]);
    const counts = new Map(); reads.forEach((r) => counts.set(r.announcementId, (counts.get(r.announcementId) || 0) + 1));
    const order = { published: 0, draft: 1, archived: 2 };
    const data = all.map((a) => annView(a, pl, { status: a.status, ended: a.status === 'published' && R.hasEnded(a, t), readCount: counts.get(a.id) || 0, audienceCount: R.audienceCount(a, people), createdAt: a.createdAt, createdByName: a.createdByName || null, updatedAt: a.updatedAt || null }))
        .sort((x, y) => order[x.status] - order[y.status] || Number(y.pinned) - Number(x.pinned) || String(y.publishedAt || y.createdAt).localeCompare(String(x.publishedAt || x.createdAt)));
    res.json({ success: true, today: t, canManage: mayManage(req), data });
});

router.get('/announcements/:id/reads', requireUsOrg, async (req, res) => {
    if (!maySeeAll(req)) return forbidden(res);
    const a = await ownedDoc(req, res, 'announcements', 'Announcement'); if (!a) return;
    const [reads, people] = await Promise.all([col('announcement_reads').where('announcementId', '==', a.id).get(), peopleStore.loadPeople(req.orgId)]);
    const rows = reads.docs.map((d) => d.data()).filter((r) => r.orgId === req.orgId).map((r) => ({ userId: r.userId, name: r.name || null, at: r.at })).sort((x, y) => String(y.at).localeCompare(String(x.at)));
    audit(req.orgId, req, 'announcement_reads_viewed', a.id, {});
    res.json({ success: true, announcement: { id: a.id, title: a.data.title, status: a.data.status }, readCount: rows.length, audienceCount: R.audienceCount(a.data, people), data: rows });
});

router.post('/announcements', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return forbidden(res);
    const { errors, value } = R.validateAnnouncement(req.body, { today: await today(req.orgId) });
    if (errors.length) return invalid(res, errors);
    const bad = await audienceError(req.orgId, value.audience);
    if (bad) return invalid(res, [bad]);
    const at = nowIso();
    const doc = { orgId: req.orgId, status: 'draft', pinned: false, endDate: null, ...value, publishedAt: null, createdAt: at, createdBy: me(req), createdByName: who(req) };
    const ref = await col('announcements').add(doc);
    audit(req.orgId, req, 'announcement_created', ref.id, { title: value.title, audience: value.audience.type });
    res.status(201).json({ success: true, announcement: annView({ id: ref.id, ...doc }, await places(req.orgId), { status: 'draft', readCount: 0 }) });
});

router.put('/announcements/:id', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return forbidden(res);
    const a = await ownedDoc(req, res, 'announcements', 'Announcement'); if (!a) return;
    const blocked = R.announcementChangeError(a.data, 'edit');
    if (blocked) return fail(res, 409, blocked);
    const { errors, value } = R.validateAnnouncement(req.body, { partial: true, today: await today(req.orgId) });
    if (errors.length) return invalid(res, errors);
    const bad = await audienceError(req.orgId, value.audience);
    if (bad) return invalid(res, [bad]);
    const patch = { ...value, updatedAt: nowIso(), updatedBy: me(req) };
    if (!(await guardedUpdate(res, a, patch))) return;
    audit(req.orgId, req, 'announcement_changed', a.id, { fields: Object.keys(value), status: a.data.status });
    res.json({ success: true, announcement: annView({ ...a.data, ...patch }, await places(req.orgId), { status: a.data.status }) });
});

async function move(req, res, action, status, name) {
    if (!mayManage(req)) return forbidden(res);
    const a = await ownedDoc(req, res, 'announcements', 'Announcement'); if (!a) return;
    const blocked = R.announcementChangeError(a.data, action);
    if (blocked) return fail(res, 409, blocked);
    const at = nowIso();
    if (action === 'publish' && R.hasEnded(a.data, await today(req.orgId))) return fail(res, 409, 'The end date has already passed. Change or clear it, then publish.');
    const patch = { status, updatedAt: at, updatedBy: me(req), ...(action === 'publish' ? { publishedAt: at, publishedBy: me(req), publishedByName: who(req) } : { archivedAt: at }) };
    if (!(await guardedUpdate(res, a, patch))) return;
    audit(req.orgId, req, name, a.id, { title: a.data.title });
    res.json({ success: true, announcement: annView({ ...a.data, ...patch }, await places(req.orgId), { status }) });
}
router.post('/announcements/:id/publish', requireUsOrg, (req, res) => move(req, res, 'publish', 'published', 'announcement_published'));
router.post('/announcements/:id/archive', requireUsOrg, (req, res) => move(req, res, 'archive', 'archived', 'announcement_archived'));

router.delete('/announcements/:id', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return forbidden(res);
    const a = await ownedDoc(req, res, 'announcements', 'Announcement'); if (!a) return;
    const blocked = R.announcementChangeError(a.data, 'delete');
    if (blocked) return fail(res, 409, blocked);
    await a.ref.delete();
    audit(req.orgId, req, 'announcement_deleted', a.id, { title: a.data.title });
    res.json({ success: true });
});

/* ------------------------------------ thanks (everyone) ------------------------------------ */

router.get('/recognition/feed', requireUsOrg, async (req, res) => {
    const hr = maySeeAll(req) && req.query.all === '1';
    const rows = R.newestFirst(await listOrg('recognition_thanks', req.orgId)).map((x) => R.thanksView(x, { forHr: hr })).filter(Boolean).slice(0, hr ? 500 : FEED_MAX);
    res.json({ success: true, data: rows });
});

router.get('/recognition/mine', requireUsOrg, async (req, res) => {
    const rows = R.newestFirst(await listOrg('recognition_thanks', req.orgId));
    const view = (list) => list.map((x) => R.thanksView(x)).filter(Boolean);
    res.json({ success: true, received: view(rows.filter((x) => x.toId === me(req))), given: view(rows.filter((x) => x.fromId === me(req))) });
});

router.post('/recognition/thanks', requireUsOrg, async (req, res) => {
    const [settings, people, t] = await Promise.all([loadSettings(req.orgId), peopleStore.loadPeople(req.orgId), today(req.orgId)]);
    const { errors, value } = R.validateThanks(req.body, { fromId: me(req), peopleIds: people.map((p) => p.id), values: settings.values });
    if (errors.length) return invalid(res, errors);
    const to = people.find((p) => p.id === value.toUserId);
    const at = nowIso();
    const doc = { orgId: req.orgId, fromId: me(req), fromName: who(req), toId: to.id, toName: to.name, valueId: value.valueId, valueName: value.valueName, message: value.message, at, day: t, hidden: false };
    // A person has a fixed set of record ids for each day (one per allowed thanks), so two sent at the same moment cannot both take the last one
    let id = null;
    for (let n = 1; n <= settings.dailyLimit && !id; n += 1) {
        const slot = R.slotId(req.orgId, me(req), t, n);
        try { await col('recognition_thanks').doc(slot).create(doc); id = slot; } catch (err) { if (!taken(err)) throw err; }
    }
    if (!id) return fail(res, 409, R.limitError(settings.dailyLimit, settings));
    audit(req.orgId, req, 'thanks_sent', id, { toId: to.id, valueId: value.valueId });
    const sent = R.sentOn((await listOrg('recognition_thanks', req.orgId)), me(req), t);
    res.status(201).json({ success: true, thanks: R.thanksView({ id, ...doc }), leftToday: Math.max(0, settings.dailyLimit - sent) });
});

/* ------------------------------------ thanks (HR, owner) ------------------------------------ */

async function setHidden(req, res, hidden) {
    if (!mayManage(req)) return forbidden(res);
    const x = await ownedDoc(req, res, 'recognition_thanks', 'Thanks'); if (!x) return;
    if (Boolean(x.data.hidden) === hidden) return fail(res, 409, hidden ? 'This thanks is already hidden' : 'This thanks is not hidden');
    const reason = R.clean(req.body && req.body.reason, 200);
    if (hidden && reason.length < 3) return invalid(res, ['Say why this is being hidden (a few words)']);
    const patch = hidden ? { hidden: true, hiddenReason: reason, hiddenBy: me(req), hiddenByName: who(req), hiddenAt: nowIso() } : { hidden: false, shownAgainBy: me(req), shownAgainAt: nowIso() };
    if (!(await guardedUpdate(res, x, patch))) return;
    audit(req.orgId, req, hidden ? 'thanks_hidden' : 'thanks_shown_again', x.id, hidden ? { reason, fromId: x.data.fromId, toId: x.data.toId } : { fromId: x.data.fromId, toId: x.data.toId });
    res.json({ success: true, thanks: R.thanksView({ ...x.data, ...patch }, { forHr: true }) });
}
router.post('/recognition/thanks/:id/hide', requireUsOrg, (req, res) => setHidden(req, res, true));
router.post('/recognition/thanks/:id/show', requireUsOrg, (req, res) => setHidden(req, res, false));

router.get('/recognition/report', requireUsOrg, async (req, res) => {
    if (!maySeeAll(req)) return forbidden(res);
    const from = String(req.query.from || ''); const to = String(req.query.to || '');
    const bad = R.validateRange(from, to);
    if (bad) return fail(res, 400, bad);
    const [rows, settings] = await Promise.all([listOrg('recognition_thanks', req.orgId), loadSettings(req.orgId)]);
    const summary = R.summarize(rows, { from, to, values: settings.values });
    audit(req.orgId, req, 'recognition_report_viewed', null, { from, to });
    res.json({ success: true, ...summary, csv: R.reportCsv(summary) });
});

router.put('/recognition/settings', requireUsOrg, async (req, res) => {
    if (!mayManage(req)) return forbidden(res);
    const { errors, value } = R.validateSettings(req.body);
    if (errors.length) return invalid(res, errors);
    await col('recognition_settings').doc(req.orgId).set({ orgId: req.orgId, ...value, updatedAt: nowIso(), updatedBy: me(req) }, { merge: true });
    audit(req.orgId, req, 'recognition_settings_changed', req.orgId, { fields: Object.keys(value), dailyLimit: value.dailyLimit, values: value.values ? value.values.length : undefined });
    const settings = await loadSettings(req.orgId);
    res.json({ success: true, values: settings.values, dailyLimit: settings.dailyLimit });
});

module.exports = router;
