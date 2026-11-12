const express = require('express');
const router = express.Router();
const { db, rawCollection } = require('../config/firebase');
const { verifyToken, authorize, ADMIN_HR_ROLES } = require('../middleware/authMiddleware');
const { requireUsOrg, PEOPLE_COLLECTIONS } = require('./us-hr').helpers;
const { orgInfo } = require('./time').helpers;
const { balanceFor, loadPolicies, hireDateOf } = require('./us-leave').helpers;
const timeRules = require('../services/time-rules');
const leaveRules = require('../services/leave-rules');
const R = require('../services/us-reports');
const { parseIsoDate, isoDate } = require('../services/us-forms');

const MAX_PEOPLE_FOR_LEAVE = 300;

router.use(verifyToken);
router.use('/reports', require('../services/permissions').requirePermission('reports.view'), requireUsOrg);

const addDays = (iso, n) => { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); };
const validDate = (v) => (parseIsoDate(v) ? v : null);

/** Everyone with an employee ID in this company, as report-ready records */
async function loadPeople(orgId) {
    const snaps = await Promise.all(PEOPLE_COLLECTIONS.map((n) => db.collection(n).get()));
    const docs = snaps.flatMap((s) => s.docs).filter((d) => d.data().orgId === orgId && d.data().employeeId);
    return { docs, people: docs.map((d) => R.normalizePerson(d.id, d.data())) };
}

async function context(req) {
    const info = await orgInfo(req.orgId);
    return { info, today: timeRules.localDate(new Date().toISOString(), info.tz) };
}

function sendCsv(res, name, columns, rows) {
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}.csv"`);
    res.send(R.toCsv(columns, rows));
}

/* Headline numbers for the top of the reports page */
router.get('/reports/summary', async (req, res) => {
    const { today } = await context(req);
    const { people } = await loadPeople(req.orgId);
    const hc = R.headcountReport(people, today, 6);
    const t = R.turnoverReport(people, addDays(today, -89), today);
    const comp = R.complianceReport(people, today);
    const weeksSnap = await rawCollection('timesheet_weeks').where('orgId', '==', req.orgId).get();
    const weeks = weeksSnap.docs.map((d) => d.data());
    res.json({
        success: true, asOf: today,
        headcount: hc.total, trend: hc.trend, hiresLast6Months: hc.hiresInPeriod,
        turnover90d: { separations: t.separations, annualizedPercent: t.annualizedPercent },
        peopleWithPaperworkIssues: comp.peopleWithIssues,
        hoursWaitingForApproval: weeks.filter((w) => w.status === 'submitted').length
    });
});

router.get('/reports/headcount', async (req, res) => {
    const { today } = await context(req);
    const asOf = validDate(req.query.asOf) || today;
    const { people } = await loadPeople(req.orgId);
    const report = R.headcountReport(people, asOf, Math.min(24, Math.max(1, Number(req.query.months) || 12)));
    const list = people.filter((p) => R.isActiveOn(p, asOf)).map((p) => ({
        employeeId: p.employeeId, name: p.name, department: p.department, jobTitle: p.jobTitle, workerType: p.classification, employmentType: p.employmentType,
        workState: p.workState, startDate: p.startDate, tenure: p.startDate ? R.tenureBucket(p.startDate, asOf) : ''
    })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (req.query.format === 'csv') {
        return sendCsv(res, 'headcount', [['employeeId', 'Employee ID'], ['name', 'Name'], ['department', 'Department'], ['jobTitle', 'Job title'], ['workerType', 'Worker type'], ['employmentType', 'Employment type'], ['workState', 'Work state'], ['startDate', 'Start date'], ['tenure', 'Tenure']].map(([key, label]) => ({ key, label })), list);
    }
    res.json({ success: true, ...report, list });
});

router.get('/reports/turnover', async (req, res) => {
    const { today } = await context(req);
    const to = validDate(req.query.to) || today;
    const from = validDate(req.query.from) || addDays(to, -364);
    if (from > to) return res.status(400).json({ success: false, error: 'from must be before to' });
    const { people } = await loadPeople(req.orgId);
    const report = R.turnoverReport(people, from, to);
    if (req.query.format === 'csv') {
        return sendCsv(res, 'turnover', [['employeeId', 'Employee ID'], ['name', 'Name'], ['department', 'Department'], ['lastDay', 'Last day'], ['type', 'Type'], ['category', 'Category'], ['tenureDays', 'Days employed']].map(([key, label]) => ({ key, label })), report.list);
    }
    res.json({ success: true, ...report });
});

router.get('/reports/labor', async (req, res) => {
    const { today } = await context(req);
    const to = validDate(req.query.to) || today;
    const from = validDate(req.query.from) || addDays(to, -83);
    const statuses = req.query.includeSubmitted === 'true' ? ['approved', 'submitted'] : ['approved'];
    const [{ people }, snap] = await Promise.all([loadPeople(req.orgId), rawCollection('timesheet_weeks').where('orgId', '==', req.orgId).get()]);
    const weeks = snap.docs.map((d) => d.data()).filter((w) => statuses.includes(w.status) && w.weekStart >= from && w.weekStart <= to && w.totals);
    const report = R.laborReport(weeks, new Map(people.map((p) => [p.id, p])), {
        overtimeMultiplier: Number(req.query.otMultiplier) || 1.5, doubleTimeMultiplier: Number(req.query.dtMultiplier) || 2
    });
    if (req.query.format === 'csv') {
        return sendCsv(res, 'labor-and-overtime', [['employeeId', 'Employee ID'], ['name', 'Name'], ['department', 'Department'], ['weeks', 'Weeks'], ['workedHours', 'Total hours'], ['regularHours', 'Regular hours'], ['overtimeHours', 'Overtime hours'], ['doubleTimeHours', 'Double time hours'], ['overtimeShare', 'Overtime %'], ['estimatedCost', 'Estimated wages (USD)']].map(([key, label]) => ({ key, label })), report.byPerson);
    }
    res.json({ success: true, from, to, includes: statuses, note: 'Estimated wages only: no payroll taxes, benefits or bonuses. A salary pay rate is read as annual pay.', ...report });
});

router.get('/reports/leave', async (req, res) => {
    const info = (await context(req)).info;
    const [{ docs, people }, policies] = await Promise.all([loadPeople(req.orgId), loadPolicies(req.orgId)]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const rows = [];
    let skipped = 0;
    for (const d of docs.slice(0, MAX_PEOPLE_FOR_LEAVE)) {
        const person = byId.get(d.id);
        const data = d.data();
        if (/^terminated$/i.test(String(data.status || '')) || !hireDateOf({ data })) { skipped += 1; continue; }
        for (const p of policies.filter((x) => leaveRules.appliesTo(x, data.usProfile))) {
            const r = await balanceFor(req.orgId, { id: d.id, data }, p, info);
            if (!r.error) rows.push({ userId: d.id, policy: p.name, type: p.type, balanceHours: r.balance.balance, payoutRequired: Boolean(p.payoutAtTermination) });
        }
    }
    const report = R.leaveLiabilityReport(rows, byId);
    if (req.query.format === 'csv') {
        return sendCsv(res, 'leave-balances', [['employeeId', 'Employee ID'], ['name', 'Name'], ['department', 'Department'], ['policy', 'Policy'], ['type', 'Type'], ['balanceHours', 'Balance (hours)'], ['estimatedValue', 'Estimated value (USD)']].map(([key, label]) => ({ key, label })), report.detail);
    }
    res.json({ success: true, skippedPeople: skipped, note: 'Value is an estimate: hours times each person\'s hourly rate. It is not an accounting figure.', ...report });
});

router.get('/reports/compliance', async (req, res) => {
    const { today } = await context(req);
    const { people } = await loadPeople(req.orgId);
    const report = R.complianceReport(people, today);
    if (req.query.format === 'csv') {
        return sendCsv(res, 'paperwork-and-data-issues', [['employeeId', 'Employee ID'], ['name', 'Name'], ['department', 'Department'], ['problems', 'Problems'], ['reverifyOn', 'I-9 expiry']].map(([key, label]) => ({ key, label })),
            report.list.map((r) => ({ ...r, problems: r.issueText.join('; ') })));
    }
    res.json({ success: true, ...report });
});

/** Form I-9 audit list for everyone, current and former */
router.get('/reports/i9-audit', async (req, res) => {
    const { today } = await context(req);
    const { people } = await loadPeople(req.orgId);
    const report = R.i9AuditReport(people, today);
    if (req.query.format === 'csv') {
        return sendCsv(res, 'i9-audit', [['employeeId', 'Employee ID'], ['name', 'Name'], ['department', 'Department'], ['status', 'Status'], ['hireDate', 'First day'], ['section1On', 'Section 1 signed'], ['section1Due', 'Section 1 due'], ['section2On', 'Section 2 examined'], ['section2Due', 'Section 2 due'], ['reverifyOn', 'Reverify by'], ['lastDay', 'Last day'], ['keepUntil', 'Keep until'], ['findings', 'Findings']].map(([key, label]) => ({ key, label })),
            report.list.map((r) => ({ ...r, findings: r.findings.join('; ') })));
    }
    res.json({ success: true, note: 'A worklist, not a legal opinion. Confirm findings with a US immigration or employment advisor before an audit.', ...report });
});

router.get('/reports/time', async (req, res) => {
    const { today } = await context(req);
    const since = addDays(today, -7 * Math.min(26, Math.max(1, Number(req.query.weeks) || 8)));
    const [wsnap, csnap] = await Promise.all([
        rawCollection('timesheet_weeks').where('orgId', '==', req.orgId).get(),
        rawCollection('punch_corrections').where('orgId', '==', req.orgId).get()
    ]);
    const weeks = wsnap.docs.map((d) => d.data()).filter((w) => w.weekStart >= timeRules.weekStart(since));
    const corrections = csnap.docs.map((d) => d.data()).filter((c) => String(c.createdAt).slice(0, 10) >= since);
    const report = R.timeReport(weeks, corrections, today);
    if (req.query.format === 'csv') {
        return sendCsv(res, 'timesheets-waiting', [['employeeId', 'Employee ID'], ['name', 'Name'], ['weekStart', 'Week of'], ['waitingDays', 'Days waiting']].map(([key, label]) => ({ key, label })), report.waitingMoreThan3Days);
    }
    res.json({ success: true, since, ...report });
});

module.exports = router;
