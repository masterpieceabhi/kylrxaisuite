/**
 * HR report calculations for US companies. Pure functions over plain data, no I/O.
 *
 * Cost figures are ESTIMATES of wages only (no payroll taxes, benefits or bonuses): hourly staff are
 * costed from approved hours, salaried exempt staff from their annual salary. A "salary" pay rate is
 * taken to be annual pay. Overtime and double-time multipliers are parameters (defaults 1.5 and 2).
 */
const { parseIsoDate, isoDate, reverificationDate, retainUntil, onboardingStatus } = require('./us-forms');

const VOLUNTARY = ['resignation', 'retirement'];
const INVOLUNTARY = ['layoff', 'termination_for_cause'];
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

function addDays(iso, n) { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); }
function daysBetween(a, b) { return Math.round((parseIsoDate(b) - parseIsoDate(a)) / 86400000); }
function monthEnd(iso) { const d = parseIsoDate(iso); return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); }

/** A flat, safe view of one person record: employment periods (a rehire has more than one) and key facts */
function normalizePerson(id, d) {
    const p = d.usProfile || {};
    const start = String(p.startDate || d.joiningDate || '').slice(0, 10);
    const periods = [];
    for (const h of d.employmentHistory || []) {
        if (parseIsoDate(String(h.startDate || '').slice(0, 10))) periods.push({ start: String(h.startDate).slice(0, 10), end: h.endDate || null, type: h.type || null });
    }
    if (parseIsoDate(start)) {
        const t = p.termination || null;
        periods.push({ start, end: t && t.lastDay ? t.lastDay : null, type: t ? t.type : null, rehireEligible: t ? t.rehireEligible : undefined });
    }
    return {
        id, employeeId: d.employeeId || null, name: d.name || null, department: d.departmentName || d.department || 'Unassigned',
        jobTitle: d.jobTitle || null, status: d.status || 'Active', startDate: parseIsoDate(start) ? start : null, periods,
        classification: p.classification || null, employmentType: p.employmentType || null, workState: p.workState || null,
        flsaStatus: p.flsaStatus || null, payType: p.payType || null, payRate: Number(p.payRate) || null,
        hasTaxpayerId: Boolean(p.taxpayerIdLast4), usForms: d.usForms || {}, termination: p.termination || null
    };
}

const isActiveOn = (person, date) => person.periods.some((p) => p.start <= date && (!p.end || p.end >= date));

function headcountAt(people, date) {
    return people.filter((p) => isActiveOn(p, date)).length;
}

function tenureBucket(startIso, asOf) {
    const days = daysBetween(startIso, asOf);
    if (days < 90) return 'Under 90 days';
    if (days < 365) return '90 days to 1 year';
    if (days < 365 * 3) return '1 to 3 years';
    if (days < 365 * 5) return '3 to 5 years';
    return '5 years or more';
}

const TENURE_ORDER = ['Under 90 days', '90 days to 1 year', '1 to 3 years', '3 to 5 years', '5 years or more'];

function countBy(items, keyFn) {
    const m = new Map();
    for (const it of items) { const k = keyFn(it) || 'Not set'; m.set(k, (m.get(k) || 0) + 1); }
    return [...m.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}

/** Headcount today, breakdowns, tenure and a month-end trend for the last `months` months */
function headcountReport(people, asOf, months = 12) {
    const active = people.filter((p) => isActiveOn(p, asOf));
    const trend = [];
    let cursor = asOf;
    for (let i = 0; i < months; i++) {
        const end = monthEnd(cursor) > asOf ? asOf : monthEnd(cursor);
        trend.unshift({ month: end.slice(0, 7), date: end, headcount: headcountAt(people, end) });
        cursor = addDays(`${end.slice(0, 7)}-01`, -1);
    }
    const tenure = countBy(active.filter((p) => p.startDate), (p) => tenureBucket(p.startDate, asOf)).sort((a, b) => TENURE_ORDER.indexOf(a.key) - TENURE_ORDER.indexOf(b.key));
    const from = trend[0] ? `${trend[0].month}-01` : asOf;
    const hires = people.flatMap((p) => p.periods).filter((per) => per.start >= from && per.start <= asOf).length;
    return {
        asOf, total: active.length,
        byDepartment: countBy(active, (p) => p.department), byWorkerType: countBy(active, (p) => p.classification),
        byEmploymentType: countBy(active, (p) => p.employmentType), byState: countBy(active, (p) => p.workState),
        tenure, trend, hiresInPeriod: hires
    };
}

function separationCategory(type) {
    if (VOLUNTARY.includes(type)) return 'Voluntary';
    if (INVOLUNTARY.includes(type)) return 'Involuntary';
    return 'Other';
}

/** People who left between `from` and `to`, the rate, and how it splits */
function turnoverReport(people, from, to) {
    const separations = [];
    for (const p of people) {
        for (const per of p.periods) {
            if (per.end && per.end >= from && per.end <= to) {
                separations.push({ id: p.id, employeeId: p.employeeId, name: p.name, department: p.department, lastDay: per.end, type: per.type || 'other',
                    category: separationCategory(per.type), tenureDays: daysBetween(per.start, per.end), rehireEligible: per.rehireEligible });
            }
        }
    }
    const startHc = headcountAt(people, from); const endHc = headcountAt(people, to);
    const avg = (startHc + endHc) / 2;
    const days = Math.max(1, daysBetween(from, to) + 1);
    const rate = avg > 0 ? (separations.length / avg) * 100 : 0;
    return {
        from, to, separations: separations.length, startHeadcount: startHc, endHeadcount: endHc, averageHeadcount: round1(avg),
        ratePercent: round1(rate), annualizedPercent: round1(rate * (365 / days)),
        byCategory: countBy(separations, (s) => s.category), byType: countBy(separations, (s) => s.type), byDepartment: countBy(separations, (s) => s.department),
        averageTenureDays: separations.length ? Math.round(separations.reduce((s, x) => s + x.tenureDays, 0) / separations.length) : 0,
        under90Days: separations.filter((s) => s.tenureDays < 90).length,
        list: separations.sort((a, b) => b.lastDay.localeCompare(a.lastDay))
    };
}

/** Hourly cost of one hour for a person, or null when no pay rate is on file */
function hourlyRate(person) {
    if (!person.payRate) return null;
    return person.payType === 'salary' ? person.payRate / 2080 : person.payRate;
}

/**
 * Estimated wages and overtime from approved weeks.
 *   weeks: [{ userId, weekStart, totals:{ regularHours, overtimeHours, doubleTimeHours, workedHours }, exempt }]
 */
function laborReport(weeks, peopleById, opts = {}) {
    const otMult = opts.overtimeMultiplier || 1.5;
    const dtMult = opts.doubleTimeMultiplier || 2;
    const byPerson = new Map();
    const byWeek = new Map();
    let missingRate = 0;
    for (const w of weeks) {
        const person = peopleById.get(w.userId);
        const t = w.totals;
        const rate = person ? hourlyRate(person) : null;
        let cost = null; let otCost = 0;
        if (person && person.payType === 'salary' && w.exempt && person.payRate) cost = person.payRate / 52;
        else if (rate !== null) {
            cost = t.regularHours * rate + t.overtimeHours * rate * otMult + t.doubleTimeHours * rate * dtMult;
            otCost = t.overtimeHours * rate * otMult + t.doubleTimeHours * rate * dtMult;
        }
        const key = w.userId;
        const row = byPerson.get(key) || { userId: key, employeeId: person && person.employeeId, name: person && person.name, department: person ? person.department : 'Unassigned',
            weeks: 0, workedHours: 0, regularHours: 0, overtimeHours: 0, doubleTimeHours: 0, estimatedCost: 0, hasRate: rate !== null || cost !== null };
        row.weeks += 1; row.workedHours += t.workedHours; row.regularHours += t.regularHours; row.overtimeHours += t.overtimeHours; row.doubleTimeHours += t.doubleTimeHours;
        if (cost !== null) row.estimatedCost += cost;
        byPerson.set(key, row);
        const wk = byWeek.get(w.weekStart) || { weekStart: w.weekStart, workedHours: 0, overtimeHours: 0, estimatedCost: 0 };
        wk.workedHours += t.workedHours; wk.overtimeHours += t.overtimeHours + t.doubleTimeHours; wk.estimatedCost += cost || 0;
        byWeek.set(w.weekStart, wk);
        if (cost === null) missingRate += 1;
        row.overtimeCost = (row.overtimeCost || 0) + otCost;
    }
    const people = [...byPerson.values()].map((r) => ({ ...r, workedHours: round2(r.workedHours), regularHours: round2(r.regularHours), overtimeHours: round2(r.overtimeHours),
        doubleTimeHours: round2(r.doubleTimeHours), estimatedCost: round2(r.estimatedCost), overtimeCost: round2(r.overtimeCost || 0),
        overtimeShare: r.workedHours ? round1(((r.overtimeHours + r.doubleTimeHours) / r.workedHours) * 100) : 0 }))
        .sort((a, b) => b.overtimeHours + b.doubleTimeHours - (a.overtimeHours + a.doubleTimeHours) || b.estimatedCost - a.estimatedCost);
    const deptMap = new Map();
    for (const r of people) {
        const d = deptMap.get(r.department) || { department: r.department, people: 0, workedHours: 0, overtimeHours: 0, estimatedCost: 0 };
        d.people += 1; d.workedHours += r.workedHours; d.overtimeHours += r.overtimeHours + r.doubleTimeHours; d.estimatedCost += r.estimatedCost; deptMap.set(r.department, d);
    }
    const sum = (k) => people.reduce((s, r) => s + r[k], 0);
    const worked = sum('workedHours'); const ot = sum('overtimeHours') + sum('doubleTimeHours');
    return {
        weeksCounted: weeks.length, peopleCounted: people.length, rowsWithoutRate: missingRate,
        totals: { workedHours: round2(worked), regularHours: round2(sum('regularHours')), overtimeHours: round2(ot), estimatedCost: round2(sum('estimatedCost')), overtimeCost: round2(sum('overtimeCost')), overtimeSharePercent: worked ? round1((ot / worked) * 100) : 0 },
        byDepartment: [...deptMap.values()].map((d) => ({ ...d, workedHours: round2(d.workedHours), overtimeHours: round2(d.overtimeHours), estimatedCost: round2(d.estimatedCost) })).sort((a, b) => b.estimatedCost - a.estimatedCost),
        byWeek: [...byWeek.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart)).map((w) => ({ ...w, workedHours: round2(w.workedHours), overtimeHours: round2(w.overtimeHours), estimatedCost: round2(w.estimatedCost) })),
        byPerson: people
    };
}

/** What unused paid time off is worth at each person's hourly rate (an estimate, not an accounting figure) */
function leaveLiabilityReport(rows, peopleById) {
    const byPolicy = new Map();
    const detail = rows.map((r) => {
        const person = peopleById.get(r.userId);
        const rate = person ? hourlyRate(person) : null;
        const value = rate === null ? null : round2(r.balanceHours * rate);
        const pol = byPolicy.get(r.policy) || { policy: r.policy, type: r.type, people: 0, hours: 0, estimatedValue: 0, withoutRate: 0 };
        pol.people += 1; pol.hours += r.balanceHours; if (value === null) pol.withoutRate += 1; else pol.estimatedValue += value;
        byPolicy.set(r.policy, pol);
        return { userId: r.userId, employeeId: person && person.employeeId, name: person && person.name, department: person ? person.department : 'Unassigned', policy: r.policy, type: r.type, balanceHours: r.balanceHours, payoutRequired: Boolean(r.payoutRequired), estimatedValue: value };
    });
    const policies = [...byPolicy.values()].map((p) => ({ ...p, hours: round2(p.hours), estimatedValue: round2(p.estimatedValue) }));
    return {
        totals: { hours: round2(policies.reduce((s, p) => s + p.hours, 0)), estimatedValue: round2(policies.reduce((s, p) => s + p.estimatedValue, 0)),
            payoutRequiredValue: round2(detail.filter((d) => d.payoutRequired && d.estimatedValue).reduce((s, d) => s + d.estimatedValue, 0)) },
        byPolicy: policies, detail: detail.sort((a, b) => (b.estimatedValue || 0) - (a.estimatedValue || 0))
    };
}

const ISSUE_TEXT = {
    no_start_date: 'No start date', no_taxpayer_id: 'No SSN or ITIN on file', no_work_state: 'No work state', no_pay_rate: 'No pay rate', no_classification: 'No worker type',
    no_direct_deposit: 'No direct deposit', w4_missing: 'W-4 missing', i9_section1_missing: 'I-9 Section 1 missing', i9_section2_missing: 'I-9 Section 2 missing',
    i9_reverification_due: 'I-9 expires within 90 days', i9_reverification_overdue: 'I-9 expired', i9_purge_ok: 'I-9 can be disposed of (retention period passed)'
};

/** Paperwork and data problems per person, for compliance and data-quality review */
function complianceReport(people, asOf) {
    const rows = [];
    for (const p of people) {
        const left = p.periods.length > 0 && !isActiveOn(p, asOf) && p.periods.every((per) => per.end && per.end < asOf);
        const issues = [];
        const f = p.usForms || {};
        if (left) {
            const hire = p.periods[0].start; const last = p.periods[p.periods.length - 1].end;
            const until = retainUntil(hire, last);
            if (until && until < asOf && (f.i9 && (f.i9.section1 || f.i9.section2))) issues.push('i9_purge_ok');
        } else {
            if (!p.startDate) issues.push('no_start_date');
            if (!p.hasTaxpayerId) issues.push('no_taxpayer_id');
            if (!p.workState) issues.push('no_work_state');
            if (!p.classification) issues.push('no_classification');
            if (!p.payRate) issues.push('no_pay_rate');
            if (!f.directDeposit) issues.push('no_direct_deposit');
            if (p.startDate) {
                const st = onboardingStatus({ firstDay: p.startDate, w4: f.w4, i9: f.i9, todayIso: asOf });
                if (!(f.w4 && f.w4.current)) issues.push('w4_missing');
                if (!(f.i9 && f.i9.section1)) issues.push('i9_section1_missing');
                if (!(f.i9 && f.i9.section2)) issues.push('i9_section2_missing');
                if (st.flags.includes('i9_reverification_soon')) issues.push('i9_reverification_due');
                if (st.flags.includes('i9_reverification_overdue')) issues.push('i9_reverification_overdue');
            }
        }
        if (issues.length) rows.push({ id: p.id, employeeId: p.employeeId, name: p.name, department: p.department, issues, issueText: issues.map((i) => ISSUE_TEXT[i]), reverifyOn: reverificationDate(f.i9 && f.i9.section1, f.i9 && f.i9.section2) });
    }
    const counts = {};
    rows.forEach((r) => r.issues.forEach((i) => { counts[i] = (counts[i] || 0) + 1; }));
    const peopleChecked = people.filter((p) => isActiveOn(p, asOf)).length;
    return { asOf, peopleChecked, peopleWithIssues: rows.length, counts: Object.entries(counts).map(([key, count]) => ({ key, label: ISSUE_TEXT[key], count })).sort((a, b) => b.count - a.count), list: rows };
}

/** Where timesheets stand: approvals backlog, flags and fixes */
function timeReport(weeks, corrections, today) {
    const byStatus = countBy(weeks, (w) => w.status).map((s) => ({ key: s.key, count: s.count }));
    const stale = weeks.filter((w) => w.status === 'submitted' && w.submittedAt && daysBetween(String(w.submittedAt).slice(0, 10), today) >= 3)
        .map((w) => ({ userId: w.userId, employeeId: w.employeeId, name: w.name, weekStart: w.weekStart, waitingDays: daysBetween(String(w.submittedAt).slice(0, 10), today) }));
    const decided = weeks.filter((w) => w.decidedAt && w.submittedAt);
    const avgHours = decided.length ? round1(decided.reduce((s, w) => s + (new Date(w.decidedAt) - new Date(w.submittedAt)) / 3600000, 0) / decided.length) : 0;
    const flagCounts = {};
    weeks.forEach((w) => (w.flags || []).forEach((f) => { flagCounts[f] = (flagCounts[f] || 0) + 1; }));
    return {
        weeks: weeks.length, byStatus, waitingMoreThan3Days: stale, averageHoursToApprove: avgHours,
        flags: Object.entries(flagCounts).map(([key, count]) => ({ key, count })),
        corrections: countBy(corrections, (c) => c.status), correctionsByKind: countBy(corrections, (c) => c.kind)
    };
}

function toCsv(columns, rows) {
    const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    return [columns.map((c) => c.label).join(','), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(','))].join('\n') + '\n';
}

module.exports = {
    normalizePerson, isActiveOn, headcountAt, tenureBucket, headcountReport, turnoverReport, separationCategory, hourlyRate,
    laborReport, leaveLiabilityReport, complianceReport, timeReport, toCsv, ISSUE_TEXT
};
