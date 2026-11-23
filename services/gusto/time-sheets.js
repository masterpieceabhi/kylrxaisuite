/**
 * Hours to a customer's own Gusto account (Gusto "App Integration", GUSTO_INTEGRATION=app).
 *
 * Two jobs:
 *   1. Matching: tie each person here to the employee who already exists in the customer's Gusto account, and
 *      remember that employee's id and job id. Nothing is created in Gusto.
 *   2. Time sheets: send each APPROVED day of work as one Gusto time sheet, with the hours already split into
 *      regular, overtime and double overtime, exactly as they were approved here.
 *
 * Gusto calculates pay and moves the money. In Gusto the owner then uses "Sync hours to payroll"; sending a time
 * sheet does not by itself put hours on a payroll.
 *
 * Read from Gusto's App Integrations pages on 2026-11-16 (Syncing Time Tracking Data, Syncing Employees, and the
 * time sheet and employee references):
 *   POST   /v1/companies/{company_uuid}/time_tracking/time_sheets     create (201)
 *   GET    /v1/time_tracking/time_sheets/{uuid}                       read one
 *   PUT    /v1/time_tracking/time_sheets/{uuid}                       update, send the current `version`
 *   DELETE /v1/time_tracking/time_sheets/{uuid}?version=...           remove (204)
 *   body: entity_uuid, entity_type "Employee", job_uuid, time_zone, shift_started_at, shift_ended_at (UTC),
 *         entries[{ hours_worked, pay_classification: "Regular" | "Overtime" | "Double overtime" }], metadata
 *   - "time tracking data must be submitted by shift", never added up per pay period; hours must be classified
 *   - a time sheet has synced_to_payroll_at; once a pay period is paid, a change needs an off-cycle payroll in Gusto
 *   - employees: match on at least two of email, date of birth, full name; let the user confirm; keep the uuid
 *   - the job id comes embedded with the employee (there is no separate "jobs for an employee" endpoint)
 * NOT confirmed there, so decided here and to be checked against the demo environment:
 *   - one time sheet per person per local day (first clock-in to last clock-out, unpaid breaks left out of the
 *     hours); Gusto's pages do not say how to represent breaks or whether shifts may overlap
 *   - whether Gusto rejects a change to a time sheet that is already on a payroll; we refuse first, to be safe
 *   - the scopes Gusto will assign (time_sheet:write, time_sheet:read, employees:read are the ones these calls need)
 */
const crypto = require('crypto');
const { GustoError } = require('./client');
const sync = require('./sync');
const rules = require('./rules');

const RECORDS = 'timeSheets';
const nowIso = () => new Date().toISOString();
const lc = (s) => String(s || '').trim().toLowerCase();
const round3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const fail = (status, code, message) => new GustoError(message, { status, code });
const cid = (ctx) => { if (!ctx.conn || !ctx.conn.companyUuid || ctx.conn.status !== 'connected') throw fail(409, 'not_connected', 'This company is not connected to Gusto'); return ctx.conn.companyUuid; };
const needApp = (ctx) => { if (ctx.opts.integration !== 'app') throw fail(409, 'not_app_integration', 'Sending time sheets is for a customer\'s own Gusto account. This server is set up for Gusto Embedded Payroll.'); };
const fullName = (e) => [e.first_name, e.last_name].filter(Boolean).join(' ');
const isW2 = (p) => p.classification === 'W2' || !p.classification;
const primaryJob = (e) => { const jobs = Array.isArray(e.jobs) ? e.jobs : []; return jobs.find((j) => j.primary) || jobs[0] || null; };

/** How Gusto pays someone, from their primary job's current pay: { unit: 'Hour' | 'Year' | ..., flsa } or null. */
function gustoPay(e) {
    const j = e ? primaryJob(e) : null;
    const comps = j && Array.isArray(j.compensations) ? j.compensations : [];
    const c = comps.find((x) => x && x.uuid && x.uuid === j.current_compensation_uuid) || comps[comps.length - 1];
    return c && c.payment_unit ? { unit: String(c.payment_unit), flsa: String(c.flsa_status || '') } : null;
}
/**
 * A warning when the two systems disagree on how someone is paid. Gusto does not put the hours of a salaried person
 * who gets no overtime on a payroll (found on the demo on 2026-11-22), so an hourly person here matched to such a
 * person there would quietly not be paid for their hours.
 */
function payMismatch(person, e) {
    const g = gustoPay(e); const ours = String((person && person.payType) || '').toLowerCase();
    if (!g || !ours) return null;
    const salariedNoOvertime = g.unit !== 'Hour' && !/nonexempt/i.test(g.flsa);
    if (ours === 'hourly' && salariedNoOvertime) return 'Paid by the hour here, but salaried without overtime in Gusto: Gusto will not put this person\'s hours on a payroll. Change the pay type in one of them.';
    if (ours === 'hourly' && g.unit !== 'Hour') return 'Paid by the hour here, but salaried in Gusto. Check the pay type in both.';
    if ((ours === 'salary' || ours === 'salaried') && g.unit === 'Hour') return 'Salaried here, but paid by the hour in Gusto. Check the pay type in both.';
    return null;
}

/* ------------------------------- matching people ------------------------------- */

/** Which of Gusto's three matching facts agree for this person and this Gusto employee */
function criteria(person, emp) {
    const by = [];
    const emails = [emp.email, emp.work_email].map(lc).filter(Boolean);
    if (person.email && emails.includes(lc(person.email))) by.push('email');
    if (person.dob && emp.date_of_birth && String(person.dob).slice(0, 10) === String(emp.date_of_birth).slice(0, 10)) by.push('date of birth');
    if (person.first && person.last && lc(person.first) === lc(emp.first_name) && lc(person.last) === lc(emp.last_name)) by.push('name');
    return by;
}

async function gustoEmployees(ctx) {
    const all = await ctx.client.paginate(`/v1/companies/${cid(ctx)}/employees`);
    return all.filter((e) => e && e.uuid);
}

/**
 * Everyone here next to who they are in Gusto.
 *   matched    already confirmed
 *   suggested  exactly one Gusto employee agrees on two or more facts, and nobody else claims them: ready to confirm
 *   unmatched  the owner has to pick, or the person is not in Gusto yet
 */
async function getMatches(ctx) {
    needApp(ctx);
    const [employees, peopleAll, links] = await Promise.all([gustoEmployees(ctx), sync.loadPeople(ctx), ctx.store.listLinks(ctx.orgId, 'employee')]);
    const people = peopleAll.filter((p) => p.active !== false && isW2(p));
    const byUuid = new Map(employees.map((e) => [e.uuid, e]));
    const linkOf = new Map(links.filter((l) => l.gustoUuid).map((l) => [l.ourId, l]));
    const taken = new Set([...linkOf.values()].map((l) => l.gustoUuid));
    const free = employees.filter((e) => !taken.has(e.uuid) && !e.terminated);

    // strong candidates (two or more facts) for each unmatched person
    const strong = new Map();
    for (const p of people) {
        if (linkOf.has(p.id)) continue;
        strong.set(p.id, free.map((e) => ({ e, by: criteria(p, e) })).filter((x) => x.by.length >= 2));
    }
    const claims = new Map(); // gusto uuid -> how many people it is the single strong candidate for
    for (const list of strong.values()) if (list.length === 1) claims.set(list[0].e.uuid, (claims.get(list[0].e.uuid) || 0) + 1);

    const rows = people.map((p) => {
        const link = linkOf.get(p.id);
        if (link) {
            const e = byUuid.get(link.gustoUuid);
            return {
                userId: p.id, name: p.name, state: e ? 'matched' : 'missing_in_gusto', gustoUuid: link.gustoUuid, gustoName: e ? fullName(e) : (link.gusto && link.gusto.name) || null,
                matchedBy: link.matchedBy || [], hasJob: Boolean(link.jobUuid), leftGusto: Boolean(e && e.terminated), payWarning: e ? payMismatch(p, e) : null,
                note: !e ? 'This person is no longer in the Gusto account. Remove the match and choose again.' : !link.jobUuid ? 'Gusto shows no job for this person, so hours cannot be sent yet.' : payMismatch(p, e)
            };
        }
        const list = strong.get(p.id) || [];
        const single = list.length === 1 && claims.get(list[0].e.uuid) === 1 ? list[0] : null;
        const possible = free.map((e) => ({ e, by: criteria(p, e) })).filter((x) => x.by.length >= 1).sort((a, b) => b.by.length - a.by.length).slice(0, 5);
        return {
            userId: p.id, name: p.name, state: single ? 'suggested' : 'unmatched',
            gustoUuid: single ? single.e.uuid : null, gustoName: single ? fullName(single.e) : null, matchedBy: single ? single.by : [],
            candidates: possible.map((x) => ({ gustoUuid: x.e.uuid, name: fullName(x.e), agreesOn: x.by, payWarning: payMismatch(p, x.e) })), payWarning: single ? payMismatch(p, single.e) : null,
            note: single ? payMismatch(p, single.e) : list.length > 1 ? 'More than one person in Gusto looks the same. Choose the right one.' : possible.length ? 'Only one fact agrees. Check and choose.' : 'Nobody in Gusto looks like this person. Add them in Gusto first.'
        };
    });
    const used = new Set(rows.map((r) => r.gustoUuid).filter(Boolean));
    return {
        rows,
        unmatchedInGusto: free.filter((e) => !used.has(e.uuid)).map((e) => ({ gustoUuid: e.uuid, name: fullName(e) })),
        totals: { people: rows.length, matched: rows.filter((r) => r.state === 'matched').length, suggested: rows.filter((r) => r.state === 'suggested').length, unmatched: rows.filter((r) => r.state === 'unmatched' || r.state === 'missing_in_gusto').length, inGusto: employees.length }
    };
}

/** Save the matches a person confirmed. Each pair is checked again against Gusto's own list. */
async function confirmMatches(ctx, pairs, actor) {
    needApp(ctx);
    if (!Array.isArray(pairs) || !pairs.length) throw fail(400, 'validation', 'Choose at least one person to match');
    if (pairs.length > 500) throw fail(400, 'validation', 'Too many matches in one go');
    const [employees, peopleAll, links] = await Promise.all([gustoEmployees(ctx), sync.loadPeople(ctx), ctx.store.listLinks(ctx.orgId, 'employee')]);
    const people = new Map(peopleAll.map((p) => [p.id, p]));
    const byUuid = new Map(employees.map((e) => [e.uuid, e]));
    const owner = new Map(links.filter((l) => l.gustoUuid).map((l) => [l.gustoUuid, l.ourId]));
    const out = { saved: 0, refused: [], warnings: [] };
    const seen = new Set();
    for (const pair of pairs) {
        const userId = String((pair && pair.userId) || ''); const gustoUuid = String((pair && pair.gustoUuid) || '');
        const p = people.get(userId); const e = byUuid.get(gustoUuid);
        const why = !p ? 'That person is not in this company.' : !e ? 'That employee is not in the connected Gusto account.' : e.terminated ? 'That employee has left the company in Gusto.'
            : (owner.has(gustoUuid) && owner.get(gustoUuid) !== userId) || seen.has(gustoUuid) ? 'That Gusto employee is already matched to someone else.' : null;
        if (why) { out.refused.push({ userId, gustoUuid, reason: why }); continue; }
        seen.add(gustoUuid);
        const job = primaryJob(e);
        await ctx.store.saveLink(ctx.orgId, 'employee', userId, {
            gustoUuid, jobUuid: job ? job.uuid : null, version: e.version || null, syncState: 'matched', matchedBy: criteria(p, e), matchedAt: nowIso(), matchedByUser: actor || null,
            gusto: { name: fullName(e), onboarded: Boolean(e.onboarded) }
        });
        out.saved += 1;
        const warn = payMismatch(p, e);
        if (warn) out.warnings.push({ userId, name: p.name || null, gustoName: fullName(e), warning: warn });
    }
    return out;
}

async function removeMatch(ctx, userId) {
    needApp(ctx);
    const link = await ctx.store.getLink(ctx.orgId, 'employee', String(userId));
    if (!link) throw fail(404, 'not_found', 'This person is not matched');
    await ctx.store.deleteLink(ctx.orgId, 'employee', String(userId));
    return { removed: true };
}

/**
 * Bring every saved match up to date with the customer's Gusto account. Nothing is changed in Gusto.
 *   - the primary job can change there (a new job, a transfer): the job id sent with hours is replaced
 *   - a person can be dismissed there: remembered as `left`; hours for their last days are still sent, with a warning
 *   - a person can be gone from the list altogether: remembered as `missing`; nothing is sent until they are matched again
 * Called before hours are sent and from the page. Gusto's employee reference (read 2026-11-17) gives `terminated`
 * and `jobs[]` with `primary` on each employee of GET /v1/companies/{id}/employees.
 */
async function refreshMatches(ctx) {
    needApp(ctx);
    const [employees, links] = await Promise.all([gustoEmployees(ctx), ctx.store.listLinks(ctx.orgId, 'employee')]);
    const byUuid = new Map(employees.map((e) => [e.uuid, e]));
    const out = { checked: 0, changed: 0, jobChanged: [], left: [], missing: [], back: [] };
    for (const l of links.filter((x) => x.gustoUuid)) {
        out.checked += 1;
        const e = byUuid.get(l.gustoUuid);
        const was = l.gustoState || 'active';
        const state = !e ? 'missing' : e.terminated ? 'left' : 'active';
        const job = e ? primaryJob(e) : null;
        const jobUuid = e ? (job ? job.uuid : null) : l.jobUuid || null; // a person who is missing keeps the last job we saw
        const name = e ? fullName(e) : (l.gusto && l.gusto.name) || null;
        const row = { userId: l.ourId, gustoUuid: l.gustoUuid, name };
        const jobMoved = (l.jobUuid || null) !== jobUuid;
        if (jobMoved) out.jobChanged.push(row);
        if (state !== was) { if (state === 'left') out.left.push(row); else if (state === 'missing') out.missing.push(row); else out.back.push(row); }
        if (!jobMoved && state === was && ((l.gusto && l.gusto.name) || null) === name) continue;
        await ctx.store.saveLink(ctx.orgId, 'employee', l.ourId, { jobUuid, gustoState: state, version: e ? e.version || null : l.version || null, gusto: { name, onboarded: e ? Boolean(e.onboarded) : Boolean(l.gusto && l.gusto.onboarded) }, checkedAt: nowIso() });
        out.changed += 1;
    }
    await ctx.store.saveConnection(ctx.orgId, { lastMatchRefresh: { at: nowIso(), checked: out.checked, changed: out.changed, jobChanged: out.jobChanged.length, left: out.left.length, missing: out.missing.length } });
    return out;
}

/* ------------------------------- approved days -> shifts ------------------------------- */

async function loadWeeks(ctx, start, end) {
    if (ctx.loadWeeks) return ctx.loadWeeks(ctx.orgId, start, end);
    const { rawCollection } = require('../../config/firebase');
    const snap = await rawCollection('timesheet_weeks').where('orgId', '==', ctx.orgId).get();
    const from = rules.addDays(start, -6);
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((w) => w.weekStart >= from && w.weekStart <= end);
}

function checkPeriod(start, end) {
    if (!rules.parseIso(start) || !rules.parseIso(end)) throw fail(400, 'validation', 'start and end must be dates (YYYY-MM-DD)');
    if (end < start) throw fail(400, 'validation', 'The end date is before the start date');
    if (Date.parse(end) - Date.parse(start) > 62 * 86400000) throw fail(400, 'validation', 'Choose a period of two months or less');
}

const CLASSES = [['regularHours', 'Regular'], ['overtimeHours', 'Overtime'], ['doubleTimeHours', 'Double overtime']];

/** What Gusto receives for one shift. Kept in one place so the same content always gives the same fingerprint. */
function payloadOf(shift) {
    return {
        entity_uuid: shift.entityUuid, entity_type: 'Employee', job_uuid: shift.jobUuid, time_zone: shift.timeZone,
        shift_started_at: shift.startAt, shift_ended_at: shift.endAt,
        entries: shift.entries.map((x) => ({ hours_worked: x.hours, pay_classification: x.classification })),
        metadata: { source: 'onn_hr', ref: shift.key }
    };
}
/**
 * The entries for a change to a time sheet Gusto already holds: each one carries the id of the entry of the same kind
 * it replaces. Returns null when Gusto holds a kind of pay that is no longer wanted, which a change cannot take away.
 */
function entriesForUpdate(current, wanted) {
    const held = new Map(((current && current.entries) || []).map((x) => [x.pay_classification, x.uuid || null]));
    const kinds = new Set(wanted.map((x) => x.pay_classification));
    for (const kind of held.keys()) if (!kinds.has(kind)) return null;
    return wanted.map((x) => (held.get(x.pay_classification) ? { uuid: held.get(x.pay_classification), ...x } : x));
}
const fingerprint = (shift) => crypto.createHash('sha256').update(JSON.stringify(payloadOf(shift))).digest('hex');

/**
 * The shifts that would be sent for a period, and everything that stands in the way. Reads our data only.
 * A shift is one person's approved work on one local day.
 */
async function buildShifts(ctx, start, end) {
    needApp(ctx);
    checkPeriod(start, end);
    const [peopleAll, weeksAll, links] = await Promise.all([sync.loadPeople(ctx), loadWeeks(ctx, start, end), ctx.store.listLinks(ctx.orgId, 'employee')]);
    const people = new Map(peopleAll.map((p) => [p.id, p]));
    const linkOf = new Map(links.filter((l) => l.gustoUuid).map((l) => [l.ourId, l]));
    const issues = []; const shifts = [];
    const once = new Set();
    const issue = (key, row) => { if (once.has(key)) return; once.add(key); issues.push(row); };
    const inPeriod = (d) => d >= start && d <= end;
    let holidayHours = 0; let premiumHours = 0;

    for (const w of weeksAll.filter((x) => x.orgId === ctx.orgId).sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart)))) {
        const p = people.get(w.userId);
        const who = (p && p.name) || w.name || w.userId;
        const weekEnd = w.weekEnd || rules.addDays(w.weekStart, 6);
        if (weekEnd < start || w.weekStart > end) continue;
        if (!p || !isW2(p)) continue; // contractors are not paid by time sheet
        if (w.status !== 'approved') {
            if (w.status === 'submitted' || w.status === 'open' || w.status === 'rejected') issue(`wait:${w.userId}:${w.weekStart}`, { severity: 'warning', code: 'timesheet_not_approved', userId: w.userId, message: `${who}: the week of ${w.weekStart} is not approved yet, so its hours are not sent.` });
            continue;
        }
        if (p.payType === 'salary' || p.flsa === 'exempt' || w.exempt) { issue(`sal:${w.userId}`, { severity: 'info', code: 'salaried_not_sent', userId: w.userId, message: `${who} is paid a salary, so no hours are sent.` }); continue; }
        if (!Array.isArray(w.days)) { issue(`old:${w.userId}:${w.weekStart}`, { severity: 'blocker', code: 'no_day_detail', userId: w.userId, message: `${who}: the week of ${w.weekStart} was approved before each day's hours were kept. Reopen it and approve it again.` }); continue; }
        const link = linkOf.get(w.userId);
        if (!link) { issue(`match:${w.userId}`, { severity: 'blocker', code: 'not_matched', userId: w.userId, message: `${who} is not matched to an employee in Gusto yet.` }); continue; }
        if (link.gustoState === 'missing') { issue(`gone:${w.userId}`, { severity: 'blocker', code: 'gone_from_gusto', userId: w.userId, message: `${who} is no longer in the Gusto account. Remove the match and choose again.` }); continue; }
        if (link.gustoState === 'left') issue(`left:${w.userId}`, { severity: 'warning', code: 'left_gusto', userId: w.userId, message: `${who} has been dismissed in Gusto. Their hours are still sent; check their final pay in Gusto.` });
        if (!link.jobUuid) { issue(`job:${w.userId}`, { severity: 'blocker', code: 'no_job', userId: w.userId, message: `${who}: Gusto shows no job for this person. Add a job in Gusto, then match again.` }); continue; }

        for (const h of w.holidayPay || []) if (inPeriod(h.date)) holidayHours += Number(h.hours) || 0;
        for (const d of w.days) {
            if (!d || !inPeriod(d.date)) continue;
            premiumHours += Number(d.premiumHours) || 0;
            const entries = CLASSES.map(([k, classification]) => ({ classification, hours: round3(d[k]) })).filter((x) => x.hours > 0);
            if (!entries.length) continue;
            if (!d.startAt || !d.endAt || !(Date.parse(d.endAt) > Date.parse(d.startAt))) { issue(`time:${w.userId}:${d.date}`, { severity: 'blocker', code: 'no_shift_times', userId: w.userId, message: `${who}: the start and end of work on ${d.date} are not known. Reopen the week and approve it again.` }); continue; }
            const shift = {
                key: `${w.userId}_${d.date}`, userId: w.userId, name: who, date: d.date, weekStart: w.weekStart, entityUuid: link.gustoUuid, jobUuid: link.jobUuid,
                timeZone: w.timeZone || 'UTC', startAt: new Date(d.startAt).toISOString(), endAt: new Date(d.endAt).toISOString(), entries,
                hours: round3(entries.reduce((s, x) => s + x.hours, 0))
            };
            shift.hash = fingerprint(shift);
            shifts.push(shift);
        }
    }
    if (holidayHours > 0) issues.push({ severity: 'info', code: 'holiday_pay_not_sent', message: `${round3(holidayHours)} hours of holiday pay are not sent, because a time sheet describes hours worked. Add holiday pay in Gusto.` });
    if (premiumHours > 0) issues.push({ severity: 'info', code: 'premium_not_sent', message: `${round3(premiumHours)} extra paid hours for missed breaks are not sent, because a time sheet describes hours worked. Add them in Gusto.` });

    const sum = (k) => round3(shifts.reduce((s, x) => s + ((x.entries.find((e) => e.classification === k) || {}).hours || 0), 0));
    return {
        periodStart: start, periodEnd: end, shifts, issues,
        totals: { shifts: shifts.length, people: new Set(shifts.map((s) => s.userId)).size, regularHours: sum('Regular'), overtimeHours: sum('Overtime'), doubleTimeHours: sum('Double overtime') },
        blocked: issues.some((i) => i.severity === 'blocker')
    };
}

/** The preview for the page: each shift with what would happen to it (new, changed, already sent) */
async function preview(ctx, start, end) {
    const built = await buildShifts(ctx, start, end);
    const sent = new Map((await ctx.store.listRecords(RECORDS, ctx.orgId)).filter((r) => r.status === 'sent').map((r) => [r.id, r]));
    const keys = new Set(built.shifts.map((s) => s.key));
    const rows = built.shifts.map((s) => {
        const r = sent.get(s.key);
        return { key: s.key, userId: s.userId, name: s.name, date: s.date, startAt: s.startAt, endAt: s.endAt, timeZone: s.timeZone, entries: s.entries, hours: s.hours, action: !r ? 'send' : r.hash === s.hash ? 'none' : 'update' };
    });
    const toRemove = [...sent.values()].filter((r) => r.date >= start && r.date <= end && !keys.has(r.id)).map((r) => ({ key: r.id, userId: r.userId, name: r.name || r.userId, date: r.date, action: 'remove' }));
    return { ...built, shifts: undefined, rows, toRemove, counts: { send: rows.filter((r) => r.action === 'send').length, update: rows.filter((r) => r.action === 'update').length, none: rows.filter((r) => r.action === 'none').length, remove: toRemove.length } };
}

/* ------------------------------- sending ------------------------------- */

const PATH = (uuid) => `/v1/time_tracking/time_sheets/${uuid}`;

/**
 * Send the approved shifts of a period: new ones are created, changed ones updated, and ones that are no longer
 * approved here are removed. A time sheet that Gusto has already put on a payroll is never touched.
 * Each shift stands alone: one failing does not stop the others, and running this again is safe.
 */
async function send(ctx, start, end, o = {}) {
    needApp(ctx);
    checkPeriod(start, end);
    return oneAtATime(ctx.orgId, () => sendNow(ctx, start, end, o));
}

// Two sends for one company at the same moment (two approvals a second apart) could each create the same day's
// time sheet. They run one after the other instead. This holds inside one server process, which is all that runs
// today (docs/DEPLOY.md); the idempotency key on each create is the second guard.
const queues = new Map();
function oneAtATime(orgId, fn) {
    const next = (queues.get(orgId) || Promise.resolve()).then(fn, fn);
    const settled = next.then(() => {}, () => {});
    queues.set(orgId, settled);
    settled.then(() => { if (queues.get(orgId) === settled) queues.delete(orgId); });
    return next;
}

async function sendNow(ctx, start, end, { actor = null, auto = false } = {}) {
    const company = cid(ctx);
    const { store, orgId, client } = ctx;
    // A job id or a person can have changed in Gusto since the match was confirmed. If Gusto cannot be asked right
    // now, the matches stay as they were and each day is still tried.
    let matchCheck = null;
    try { matchCheck = await refreshMatches(ctx); } catch (e) {
        if (!e || e.name !== 'GustoError') throw e;
        if (e.code === 'reauth_required' || e.code === 'not_connected') throw e;
    }
    const built = await buildShifts(ctx, start, end);
    const records = new Map((await store.listRecords(RECORDS, orgId)).map((r) => [r.id, r]));
    const out = { periodStart: start, periodEnd: end, created: 0, updated: 0, unchanged: 0, removed: 0, failed: 0, locked: 0, issues: built.issues, totals: built.totals, problems: [] };
    const problem = async (key, name, date, e, lockedMsg) => {
        if (lockedMsg) { out.locked += 1; out.problems.push({ key, name, date, code: 'already_on_payroll', message: lockedMsg }); return; }
        out.failed += 1;
        const message = e && e.message ? e.message : 'The time sheet could not be sent';
        out.problems.push({ key, name, date, code: (e && e.code) || 'gusto_error', message });
        await store.logError(orgId, { scope: 'time_sheet', ref: key, message: `${name}, ${date}: ${message}`, code: (e && e.code) || null });
    };
    const LOCKED = 'Gusto has already put these hours on a payroll. A change now needs an off-cycle payroll in Gusto.';

    for (const s of built.shifts) {
        const rec = records.get(s.key);
        try {
            if (!rec || rec.status !== 'sent' || !rec.gustoUuid) {
                const made = await client.post(`/v1/companies/${company}/time_tracking/time_sheets`, payloadOf(s), { idempotencyKey: `onnhr:${orgId}:${s.key}:${s.hash.slice(0, 24)}` });
                if (!made || !made.uuid) throw fail(502, 'bad_response', 'Gusto did not return the time sheet');
                await store.saveRecord(RECORDS, orgId, s.key, { userId: s.userId, name: s.name, date: s.date, gustoUuid: made.uuid, version: made.version || null, hash: s.hash, hours: s.hours, status: 'sent', gustoStatus: made.status || null, sentAt: nowIso(), sentBy: actor });
                out.created += 1;
            } else if (rec.hash === s.hash) {
                out.unchanged += 1;
                continue;
            } else {
                const current = await client.get(PATH(rec.gustoUuid));
                if (current.synced_to_payroll_at) { await problem(s.key, s.name, s.date, null, LOCKED); continue; }
                // Found against Gusto's demo on 2026-11-17: an entry sent without its id is ADDED to the time sheet, not
                // swapped in (the change was refused with "Entries do not fit in the time you entered"). So each entry
                // carries the id of the one it replaces. Gusto documents no way to drop an entry, so when a kind of pay
                // disappears (overtime that is no longer there) the time sheet is removed and made again.
                const entries = entriesForUpdate(current, payloadOf(s).entries);
                if (entries) {
                    const saved = await client.put(PATH(rec.gustoUuid), { ...payloadOf(s), entries, version: current.version });
                    await store.saveRecord(RECORDS, orgId, s.key, { name: s.name, version: (saved && saved.version) || null, hash: s.hash, hours: s.hours, gustoStatus: (saved && saved.status) || null, sentAt: nowIso(), sentBy: actor });
                } else {
                    await client.del(PATH(rec.gustoUuid), { query: { version: current.version } });
                    await store.saveRecord(RECORDS, orgId, s.key, { status: 'removed', removedAt: nowIso(), removedBy: actor });
                    const made = await client.post(`/v1/companies/${company}/time_tracking/time_sheets`, payloadOf(s), { idempotencyKey: `onnhr:${orgId}:${s.key}:${s.hash.slice(0, 24)}` });
                    if (!made || !made.uuid) throw fail(502, 'bad_response', 'Gusto did not return the time sheet');
                    await store.saveRecord(RECORDS, orgId, s.key, { userId: s.userId, name: s.name, date: s.date, gustoUuid: made.uuid, version: made.version || null, hash: s.hash, hours: s.hours, status: 'sent', gustoStatus: made.status || null, sentAt: nowIso(), sentBy: actor, removedAt: null });
                }
                out.updated += 1;
            }
            await store.resolveErrors(orgId, 'time_sheet', s.key);
        } catch (e) {
            if (!e || e.name !== 'GustoError') throw e;
            if (e.code === 'reauth_required' || e.code === 'not_connected') throw e; // nothing else will work either
            await problem(s.key, s.name, s.date, e);
        }
    }

    // sent before, in this period, and no longer among the approved shifts (the week was reopened or a punch removed)
    const keep = new Set(built.shifts.map((s) => s.key));
    for (const rec of records.values()) {
        if (rec.status !== 'sent' || !rec.gustoUuid || rec.date < start || rec.date > end || keep.has(rec.id)) continue;
        const name = rec.name || rec.userId;
        try {
            let current = null;
            try { current = await client.get(PATH(rec.gustoUuid)); } catch (e) { if (e.code !== 'not_found') throw e; }
            if (current && current.synced_to_payroll_at) { await problem(rec.id, name, rec.date, null, LOCKED); continue; }
            if (current) await client.del(PATH(rec.gustoUuid), { query: { version: current.version } });
            await store.saveRecord(RECORDS, orgId, rec.id, { status: 'removed', removedAt: nowIso(), removedBy: actor });
            await store.resolveErrors(orgId, 'time_sheet', rec.id);
            out.removed += 1;
        } catch (e) {
            if (!e || e.name !== 'GustoError') throw e;
            if (e.code === 'reauth_required' || e.code === 'not_connected') throw e;
            await problem(rec.id, name, rec.date, e);
        }
    }
    out.matchCheck = matchCheck ? { checked: matchCheck.checked, jobChanged: matchCheck.jobChanged.length, left: matchCheck.left.length, missing: matchCheck.missing.length } : null;
    await store.saveConnection(orgId, { lastHoursSend: { at: nowIso(), by: actor, auto: Boolean(auto), periodStart: start, periodEnd: end, created: out.created, updated: out.updated, unchanged: out.unchanged, removed: out.removed, failed: out.failed, locked: out.locked } });
    return out;
}

/* ------------------------------- sending by itself ------------------------------- */

/** The company's choice: send hours to Gusto as soon as a week is approved, rejected or reopened. Off unless switched on. */
async function setAutoSend(ctx, on, actor) {
    needApp(ctx);
    if (typeof on !== 'boolean') throw fail(400, 'validation', 'autoSend must be true or false');
    await ctx.store.saveConnection(ctx.orgId, { autoSendHours: on, autoSendSetAt: nowIso(), autoSendSetBy: actor || null });
    ctx.conn = await ctx.store.getConnection(ctx.orgId);
    return { autoSend: on };
}

/**
 * Called after a week's hours are approved, rejected or reopened. Does nothing unless this server connects to
 * customers' own Gusto accounts, the company is connected and has switched automatic sending on.
 * It never throws: the decision on the week has already been saved, and a failure here is written to the Gusto
 * error list (and cleared the next time that week goes through).
 * An approved week sends its days; a week that is no longer approved has its days removed from Gusto, unless
 * Gusto has already put them on a payroll.
 */
async function afterWeekChange(orgId, weekStart, { actor = null, deps = null } = {}) {
    let ctx = null;
    try {
        if (!deps && require('./config').integration() !== 'app') return { skipped: 'not_app_integration' };
        ctx = await require('./index').makeContext(orgId, deps || {});
        if (ctx.opts.integration !== 'app') return { skipped: 'not_app_integration' };
        if (!ctx.conn || ctx.conn.status !== 'connected' || !ctx.conn.companyUuid) return { skipped: 'not_connected' };
        if (ctx.conn.autoSendHours !== true) return { skipped: 'switched_off' };
        if (!rules.parseIso(weekStart)) return { skipped: 'bad_week' };
        const out = await send(ctx, weekStart, rules.addDays(weekStart, 6), { actor, auto: true });
        await ctx.store.resolveErrors(orgId, 'auto_send', weekStart);
        return out;
    } catch (e) {
        const message = e && e.message ? String(e.message).slice(0, 300) : 'Unknown error';
        try { if (ctx) await ctx.store.logError(orgId, { scope: 'auto_send', ref: weekStart, message: `The hours for the week of ${weekStart} were not sent to Gusto by themselves: ${message}. Send them from the Hours to Gusto tab.`, code: (e && e.code) || null }); } catch (_) { /* nothing more can be done here */ }
        try { ((ctx && ctx.log) || require('./index').defaultLog).warn('gusto auto send failed', { orgId, weekStart, code: (e && e.code) || null }); } catch (_) { /* logging must not throw */ }
        return { failed: true, code: (e && e.code) || 'error', message };
    }
}

/** What has been sent for a period, from our own records (no call to Gusto) */
async function listSent(ctx, start, end) {
    needApp(ctx);
    checkPeriod(start, end);
    return (await ctx.store.listRecords(RECORDS, ctx.orgId)).filter((r) => r.date >= start && r.date <= end)
        .map((r) => ({ key: r.id, userId: r.userId, name: r.name || null, date: r.date, hours: r.hours || null, status: r.status, gustoStatus: r.gustoStatus || null, sentAt: r.sentAt || null, removedAt: r.removedAt || null }))
        .sort((a, b) => `${a.date}${a.name}`.localeCompare(`${b.date}${b.name}`));
}

module.exports = { payMismatch, getMatches, confirmMatches, removeMatch, refreshMatches, setAutoSend, afterWeekChange, buildShifts, preview, send, listSent, criteria, payloadOf, _internal: { fingerprint, primaryJob } };
