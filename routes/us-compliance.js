const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { requireUsOrg, audit, exists, PEOPLE_COLLECTIONS } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const timeRules = require('../services/time-rules');
const posters = require('../services/postings-rules');
const eeo = require('../services/eeo-rules');
const osha = require('../services/osha-rules');
const reports = require('../services/us-reports');

const SENSITIVE_ROLES = ['Super Admin', 'super_admin', 'hr_admin'];

router.use(verifyToken);

const todayFor = async (orgId) => timeRules.localDate(new Date().toISOString(), (await orgInfo(orgId)).tz);
const isActivePerson = (d) => !/^(terminated)$/i.test(String(d.status || '')) && d.employeeId;

async function loadActivePeople(orgId) {
    const snaps = await Promise.all(PEOPLE_COLLECTIONS.map((n) => db.collection(n).get()));
    return snaps.flatMap((s) => s.docs).filter((d) => d.data().orgId === orgId && isActivePerson(d.data()));
}

const csv = (res, name, columns, rows) => {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(reports.toCsv(columns.map(([key, label]) => ({ key, label })), rows));
};

/* ---------------------------------- workplace notices ---------------------------------- */

router.get('/postings', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const [t, people, snap] = await Promise.all([todayFor(req.orgId), loadActivePeople(req.orgId), rawCollection('posting_records').where('orgId', '==', req.orgId).get()]);
    const entries = Object.fromEntries(snap.docs.map((d) => [d.data().key, d.data().entry]));
    const states = [...(req.org.usProfile && req.org.usProfile.workStates || []), ...people.map((d) => d.data().usProfile && d.data().usProfile.workState).filter(Boolean)];
    const tracker = posters.buildTracker(entries, people.length, states, t);
    res.json({ success: true, today: t, headcount: people.length, note: 'A tracker, not legal advice. Check the current list of required notices with the U.S. Department of Labor and your state labor department.', ...tracker });
});

router.put('/postings/:key', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const key = String(req.params.key);
    if (!posters.FEDERAL.some((f) => f.key === key) && !/^state_[A-Z]{2}$/.test(key)) return res.status(404).json({ success: false, error: 'Unknown notice' });
    const { errors, value } = posters.validateEntry(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    await rawCollection('posting_records').doc(`${req.orgId}_${key}`).set({ orgId: req.orgId, key, entry: { ...value, recordedBy: req.user.id, recordedAt: new Date().toISOString() } });
    audit(req.orgId, req, 'posting_recorded', key, { postedOn: value.postedOn });
    res.json({ success: true });
});

/* ---------------------------------- EEO self-identification ---------------------------------- */

router.get('/eeo/options', requireUsOrg, (req, res) => {
    res.json({ success: true, sex: eeo.SEX, races: eeo.RACES, hispanic: eeo.HISPANIC, veteran: eeo.VETERAN, disability: eeo.DISABILITY, jobCategories: eeo.JOB_CATEGORIES });
});

/** Whether the signed-in person has answered. Never returns the answers themselves. */
router.get('/eeo/me', requireUsOrg, async (req, res) => {
    const snap = await rawCollection('eeo_selfid').doc(`${req.orgId}_${req.user.id}`).get();
    res.json({ success: true, answered: exists(snap), answeredAt: exists(snap) ? snap.data().updatedAt : null });
});

router.put('/eeo/me', requireUsOrg, async (req, res) => {
    const { errors, value } = eeo.validateSelfId(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    await rawCollection('eeo_selfid').doc(`${req.orgId}_${req.user.id}`).set({ orgId: req.orgId, userId: req.user.id, record: value, updatedAt: new Date().toISOString() });
    audit(req.orgId, req, 'eeo_selfid_submitted', req.user.id); // records that it was submitted, never the answers
    res.json({ success: true });
});

router.put('/eeo/job-category/:userId', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const key = String((req.body && req.body.jobCategory) || '');
    if (!eeo.JOB_CATEGORIES.some((c) => c.key === key)) return res.status(400).json({ success: false, error: 'jobCategory is not valid' });
    const ref = rawCollection('users').doc(req.params.userId);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Employee not found' });
    await ref.set({ usProfile: { eeoJobCategory: key } }, { merge: true });
    audit(req.orgId, req, 'eeo_job_category_set', req.params.userId, { jobCategory: key });
    res.json({ success: true });
});

/** EEO-1 style totals. Totals only: no one's individual answers are ever shown. */
router.get('/eeo/report', authorize(SENSITIVE_ROLES), requireUsOrg, async (req, res) => {
    const [docs, selfSnap] = await Promise.all([loadActivePeople(req.orgId), rawCollection('eeo_selfid').where('orgId', '==', req.orgId).get()]);
    const self = new Map(selfSnap.docs.map((d) => [d.data().userId, d.data().record]));
    const people = docs.map((d) => ({ jobCategory: d.data().usProfile && d.data().usProfile.eeoJobCategory, selfId: self.get(d.id) || null }));
    const report = eeo.eeoReport(people);
    const missingCategory = docs.filter((d) => !(d.data().usProfile && d.data().usProfile.eeoJobCategory)).map((d) => ({ userId: d.id, employeeId: d.data().employeeId, name: d.data().name, jobTitle: d.data().jobTitle || null }));
    const unanswered = docs.filter((d) => !self.has(d.id)).length;
    if (req.query.format === 'csv') {
        const cols = [['category', 'Job category'], ...eeo.RACE_COLUMNS.flatMap((c) => [[`${c.key}_male`, `${c.label} - male`], [`${c.key}_female`, `${c.label} - female`]]), ['total', 'Total']];
        return csv(res, 'eeo1-counts', cols, [...report.rows.map((r) => ({ category: r.label, ...r.cells, total: r.total })), { category: 'All categories', ...report.totals, total: report.grandTotal }]);
    }
    audit(req.orgId, req, 'eeo_report_viewed', req.orgId);
    res.json({ success: true, note: 'Who must file an EEO-1 report, and when, is set by the EEOC. Confirm on eeoc.gov. Self-identification is voluntary and these are totals only.', unanswered, missingCategory, ...report });
});

/* ---------------------------------- OSHA injury and illness log ---------------------------------- */

const yearOf = (v, fallback) => (/^\d{4}$/.test(String(v)) ? Number(v) : fallback);

/** Any worker can report an injury. HR then decides whether it is recordable. */
router.post('/osha/report', requireUsOrg, async (req, res) => {
    const t = await todayFor(req.orgId);
    const { errors, value } = osha.validateReport(req.body, t);
    if (errors.length) return res.status(400).json({ success: false, errors });
    const ref = await rawCollection('osha_incidents').add({
        orgId: req.orgId, ...value, userId: req.user.id, employeeName: req.user.name || null, jobTitle: req.user.jobTitle || null, status: 'reported',
        classification: null, reportedAt: new Date().toISOString(), reportedBy: req.user.id
    });
    audit(req.orgId, req, 'osha_incident_reported', ref.id, { date: value.dateOfIncident });
    res.status(201).json({ success: true, id: ref.id, message: 'Thank you. HR has been notified. You will not be treated differently for reporting this.' });
});

router.get('/osha/incidents', requireUsOrg, async (req, res) => {
    const snap = await rawCollection('osha_incidents').where('orgId', '==', req.orgId).get();
    const staff = ADMIN_HR_ROLES.some((r) => String(r).toLowerCase().replace(/[\s_-]+/g, '') === String(req.user.role).toLowerCase().replace(/[\s_-]+/g, ''));
    let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!staff) rows = rows.filter((r) => r.userId === req.user.id).map((r) => ({ id: r.id, dateOfIncident: r.dateOfIncident, description: r.description, location: r.location, status: r.status, reportedAt: r.reportedAt }));
    rows.sort((a, b) => String(b.reportedAt).localeCompare(String(a.reportedAt)));
    res.json({ success: true, count: rows.length, data: rows.slice(0, 300) });
});

router.put('/osha/incidents/:id/classify', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const ref = rawCollection('osha_incidents').doc(req.params.id);
    const snap = await ref.get();
    if (!exists(snap) || snap.data().orgId !== req.orgId) return res.status(404).json({ success: false, error: 'Incident not found' });
    const { errors, value } = osha.validateClassification(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });
    await ref.update({ ...value, status: 'classified', classifiedBy: req.user.id, classifiedAt: new Date().toISOString() });
    audit(req.orgId, req, 'osha_incident_classified', req.params.id, { classification: value.classification });
    res.json({ success: true });
});

async function incidentsForYear(orgId, year) {
    const snap = await rawCollection('osha_incidents').where('orgId', '==', orgId).get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => i.status === 'classified' && String(i.dateOfIncident).startsWith(String(year)));
}

router.get('/osha/log', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const year = yearOf(req.query.year, Number((await todayFor(req.orgId)).slice(0, 4)));
    const rows = osha.logRows(await incidentsForYear(req.orgId, year), year);
    if (req.query.format === 'csv') {
        return csv(res, `osha-300-log-${year}`, [['caseNumber', 'Case no.'], ['employeeName', 'Employee'], ['jobTitle', 'Job title'], ['dateOfIncident', 'Date of injury'], ['location', 'Where it happened'], ['description', 'Description'], ['classification', 'Classification'], ['daysAway', 'Days away'], ['daysRestricted', 'Days restricted'], ['injuryTypeLabel', 'Type']], rows);
    }
    res.json({ success: true, year, note: 'Whether a case is recordable, and who must keep or electronically submit these forms, depends on OSHA rules for your industry and size. Confirm on osha.gov.', count: rows.length, data: rows });
});

router.get('/osha/summary', authorize(ADMIN_HR_ROLES), requireUsOrg, async (req, res) => {
    const year = yearOf(req.query.year, Number((await todayFor(req.orgId)).slice(0, 4)));
    const [incidents, weeks, people] = await Promise.all([
        incidentsForYear(req.orgId, year), rawCollection('timesheet_weeks').where('orgId', '==', req.orgId).get(), loadActivePeople(req.orgId)
    ]);
    const fromTime = weeks.docs.map((d) => d.data()).filter((w) => w.status === 'approved' && String(w.weekStart).startsWith(String(year)) && w.totals).reduce((s, w) => s + w.totals.workedHours, 0);
    const override = Number(req.query.hoursWorked);
    const hours = override > 0 ? override : fromTime;
    res.json({ success: true, hoursSource: override > 0 ? 'entered by you' : 'approved timesheets', ...osha.summary(incidents, year, hours, people.length) });
});

module.exports = router;
