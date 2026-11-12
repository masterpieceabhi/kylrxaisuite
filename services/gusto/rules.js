/**
 * Gusto integration: pure rules (no I/O). Everything here is unit tested in tests/gusto-rules.test.mjs.
 * Things we are not certain about in Gusto's API are NOT here; they live in mapping.js adapters
 * and are listed in docs/GUSTO.md under "verify against sandbox".
 */
const crypto = require('crypto');

/* ------------------------------ signatures (webhooks) ------------------------------ */

/** HMAC-SHA256 hex of the raw request body with the subscription's verification token */
function signPayload(rawBody, verificationToken) {
    return crypto.createHmac('sha256', String(verificationToken)).update(rawBody).digest('hex');
}

/**
 * Timing-safe check of the X-Gusto-Signature header. `rawBody` must be the exact bytes received
 * (Buffer or string). Returns false (never throws) for anything malformed.
 */
function verifySignature(rawBody, verificationToken, headerValue) {
    if (!verificationToken || !headerValue || rawBody === undefined || rawBody === null) return false;
    const given = String(headerValue).trim().replace(/^sha256=/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(given)) return false;
    const expected = signPayload(rawBody, verificationToken);
    return crypto.timingSafeEqual(Buffer.from(given, 'hex'), Buffer.from(expected, 'hex'));
}

/* ------------------------------ retry, backoff, rate limits ------------------------------ */

/** Exponential backoff with jitter: attempt 1 -> ~base, 2 -> ~2*base ... capped */
function backoffMs(attempt, baseMs = 500, capMs = 30000, random = Math.random) {
    const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
    return Math.round(exp / 2 + random() * (exp / 2));
}

/** Milliseconds to wait from a 429/503 response's headers (Retry-After seconds or HTTP date, else X-RateLimit-Reset) */
function retryAfterMs(headers, nowMs = Date.now(), fallbackMs = 1000) {
    const h = (name) => {
        if (!headers) return undefined;
        if (typeof headers.get === 'function') return headers.get(name) || undefined;
        const k = Object.keys(headers).find((x) => x.toLowerCase() === name.toLowerCase());
        return k ? headers[k] : undefined;
    };
    const ra = h('retry-after');
    if (ra !== undefined && ra !== null && ra !== '') {
        const secs = Number(ra);
        if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
        const when = Date.parse(ra);
        if (Number.isFinite(when)) return Math.max(0, when - nowMs);
    }
    const reset = h('x-ratelimit-reset');
    if (reset !== undefined && reset !== '') {
        const n = Number(reset);
        if (Number.isFinite(n)) return Math.max(0, n > 1e9 ? (n * 1000 - nowMs) : n * 1000); // epoch seconds or seconds-from-now
    }
    return fallbackMs;
}

/** Sliding-window limiter state: how long must the next request wait? (pure; the client owns the timers) */
/**
 * A request holds a slot from the moment it is sent (begin) and its slot is timed from the moment the answer
 * comes back (end). The server counts a request when it arrives, which is somewhere between those two, so timing
 * from the answer can never free a slot before the server's own window has let go of it. Timing from the send
 * can: a slow first burst followed by a fast second one lands inside one server window.
 */
function createRateWindow({ max = 180, windowMs = 60000 } = {}) {
    const stamps = [];
    let inFlight = 0;
    let pausedUntil = 0;
    return {
        /** ms to wait before a request may start (0 = now) */
        waitMs(nowMs) {
            while (stamps.length && stamps[0] <= nowMs - windowMs) stamps.shift();
            let wait = Math.max(0, pausedUntil - nowMs);
            // every slot taken: wait for the oldest answered one to age out, or briefly for one in flight to answer
            if (stamps.length + inFlight >= max) wait = Math.max(wait, stamps.length ? stamps[0] + windowMs - nowMs : 25);
            return wait;
        },
        begin() { inFlight += 1; },
        end(nowMs) { inFlight = Math.max(0, inFlight - 1); stamps.push(nowMs); },
        record(nowMs) { stamps.push(nowMs); },
        pauseUntil(ms) { pausedUntil = Math.max(pausedUntil, ms); },
        get size() { return stamps.length + inFlight; }
    };
}

/* ------------------------------ payroll cutoff ------------------------------ */

const PAYROLL_TZ = 'America/Los_Angeles';
const DEADLINE_HOUR_PT = '16:00';

function pad(n) { return String(n).padStart(2, '0'); }
function isoOf(d) { return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function parseIso(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
    if (!m) return null;
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? d : null;
}
function addDays(iso, n) { const d = parseIso(iso); d.setUTCDate(d.getUTCDate() + n); return isoOf(d); }
function subBusinessDays(iso, n) {
    const d = parseIso(iso);
    let left = n;
    while (left > 0) {
        d.setUTCDate(d.getUTCDate() - 1);
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) left -= 1;
    }
    return isoOf(d);
}
function pacificOffsetMinutes(utcMs) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: PAYROLL_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utcMs));
    const g = (t) => Number(parts.find((p) => p.type === t).value);
    return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - utcMs) / 60000;
}
/** 4:00 PM Pacific on a calendar date, as a UTC ISO string */
function pacificDeadlineIso(dateIso) {
    const d = parseIso(dateIso);
    if (!d) return null;
    const guess = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 16, 0);
    let utc = guess - pacificOffsetMinutes(guess) * 60000;
    utc = guess - pacificOffsetMinutes(utc) * 60000;
    return new Date(utc).toISOString();
}

/**
 * When must a payroll be submitted to reach employees on `checkDate`?
 * Gusto's own `payroll_deadline` (when present) wins; otherwise we estimate: 4 PM Pacific,
 * `achBusinessDays` business days before the check date (default 4). This is a warning aid only.
 */
function cutoffInfo({ nowIso, checkDate, gustoDeadlineIso = null, achBusinessDays = 4 }) {
    const now = Date.parse(nowIso);
    let deadlineIso = gustoDeadlineIso && Number.isFinite(Date.parse(gustoDeadlineIso)) ? new Date(gustoDeadlineIso).toISOString() : null;
    let source = deadlineIso ? 'gusto' : null;
    if (!deadlineIso) {
        if (!parseIso(checkDate)) return { deadlineIso: null, status: 'unknown', message: 'The check date is not known yet, so the deadline cannot be shown.', source: null };
        deadlineIso = pacificDeadlineIso(subBusinessDays(checkDate, achBusinessDays));
        source = 'estimate';
    }
    const ms = Date.parse(deadlineIso) - now;
    const minutesLeft = Math.floor(ms / 60000);
    let status = 'ok';
    let message;
    if (ms < 0) { status = 'passed'; message = 'The deadline for this check date has passed. Employees will probably be paid later than the check date. Gusto shows the earliest new date.'; }
    else if (ms < 3 * 3600000) { status = 'urgent'; message = `Less than ${Math.max(1, Math.ceil(ms / 3600000))} hour(s) left before the 4:00 PM Pacific deadline. Submit now to keep the check date.`; }
    else if (ms < 24 * 3600000) { status = 'soon'; message = 'The deadline is within a day (4:00 PM Pacific). Submit today to keep the check date.'; }
    else message = `Submit before 4:00 PM Pacific on ${new Date(Date.parse(deadlineIso) - pacificOffsetMinutes(Date.parse(deadlineIso)) * -60000).toISOString().slice(0, 10)}. Standard direct deposit takes about ${achBusinessDays} business days.`;
    return { deadlineIso, minutesLeft, status, message, source };
}

/* ------------------------------ hours feed ------------------------------ */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const hoursStr = (n) => (Math.round((Number(n) || 0) * 1000) / 1000).toFixed(3);

/** Does the Monday-start week lie entirely inside [start, end]? Is it partly inside? */
function weekPlacement(weekStart, start, end) {
    const weekEnd = addDays(weekStart, 6);
    if (weekStart >= start && weekEnd <= end) return 'inside';
    if (weekEnd < start || weekStart > end) return 'outside';
    return 'partial';
}

/**
 * Builds the hours to send to Gusto for one pay period.
 *  weeks:  timesheet_weeks docs { userId, weekStart, status, totals{regularHours,overtimeHours,doubleTimeHours}, name? }
 *  people: [{ id, name, payType:'hourly'|'salary', flsa, active }]   (our people)
 *  links:  Map or object: userId -> { gustoUuid, meta:{ jobUuid } }
 *  leave:  approved leave requests [{ userId, type, dates:[iso], hoursPerDay }]
 * Output: rows (one per linked hourly person), issues [{severity:'blocker'|'warning', code, userId?, message}], totals.
 */
function buildHoursFeed({ weeks = [], people = [], links = {}, leave = [], periodStart, periodEnd, includePto = true }) {
    const issues = [];
    if (!parseIso(periodStart) || !parseIso(periodEnd) || periodEnd < periodStart) {
        return { rows: [], issues: [{ severity: 'blocker', code: 'bad_period', message: 'The pay period dates are not valid.' }], totals: { regularHours: 0, overtimeHours: 0, doubleTimeHours: 0, ptoHours: 0, people: 0 }, ready: false };
    }
    const linkOf = (id) => (links instanceof Map ? links.get(id) : links[id]);
    // every Monday whose week overlaps the period
    const mondays = [];
    let cursor = periodStart;
    while (cursor <= periodEnd) {
        const dow = parseIso(cursor).getUTCDay();
        if (dow === 1 || cursor === periodStart) {
            const ws = dow === 1 ? cursor : addDays(cursor, -((dow + 6) % 7));
            if (!mondays.includes(ws)) mondays.push(ws);
        }
        cursor = addDays(cursor, 1);
    }
    const byUser = new Map();
    for (const w of weeks) {
        if (!byUser.has(w.userId)) byUser.set(w.userId, []);
        byUser.get(w.userId).push(w);
    }
    const partial = mondays.filter((m) => weekPlacement(m, periodStart, periodEnd) === 'partial');
    if (partial.length) {
        issues.push({ severity: 'warning', code: 'partial_week', message: `The week starting ${partial.join(', ')} is only partly inside this pay period. Weekly time totals cannot be split by day, so that week is not included. Align the pay period to Monday to Sunday weeks, or add those hours by hand in Gusto.` });
    }
    const full = mondays.filter((m) => weekPlacement(m, periodStart, periodEnd) === 'inside');

    const rows = [];
    const totals = { regularHours: 0, overtimeHours: 0, doubleTimeHours: 0, ptoHours: 0, people: 0 };
    for (const p of people) {
        if (p.active === false) continue;
        const link = linkOf(p.id);
        const salaried = p.payType === 'salary' || p.flsa === 'exempt';
        if (!link || !link.gustoUuid) {
            issues.push({ severity: 'blocker', code: 'not_linked', userId: p.id, message: `${p.name || p.id} is not in Gusto yet. Sync people first.` });
            continue;
        }
        const mine = byUser.get(p.id) || [];
        const approved = new Map(mine.filter((w) => w.status === 'approved').map((w) => [w.weekStart, w]));
        let regular = 0; let overtime = 0; let doubleTime = 0;
        const missing = [];
        const pending = [];
        for (const m of full) {
            const wk = approved.get(m);
            if (wk) {
                const t = wk.totals || {};
                regular += Number(t.regularHours) || 0; overtime += Number(t.overtimeHours) || 0; doubleTime += Number(t.doubleTimeHours) || 0;
            } else {
                const other = mine.find((w) => w.weekStart === m);
                if (other && other.status === 'submitted') pending.push(m); else if (!salaried) missing.push(m);
            }
        }
        if (pending.length) issues.push({ severity: 'warning', code: 'timesheet_not_approved', userId: p.id, message: `${p.name || p.id}: hours for the week of ${pending.join(', ')} are waiting for approval and are not included.` });
        if (!salaried && missing.length === full.length && full.length > 0 && !pending.length) {
            issues.push({ severity: 'warning', code: 'no_hours', userId: p.id, message: `${p.name || p.id} has no approved hours in this pay period. They will be paid for 0 hours unless that is fixed.` });
        } else if (!salaried && missing.length && !pending.length) {
            issues.push({ severity: 'warning', code: 'missing_weeks', userId: p.id, message: `${p.name || p.id}: no approved hours for the week of ${missing.join(', ')}.` });
        }
        const pto = {};
        if (includePto) {
            for (const r of leave) {
                if (r.userId !== p.id) continue;
                const days = (r.dates || []).filter((d) => d >= periodStart && d <= periodEnd);
                if (!days.length) continue;
                const name = String(r.type || '').toLowerCase().includes('sick') ? 'Sick Hours' : 'Vacation Hours';
                pto[name] = round2((pto[name] || 0) + days.length * (Number(r.hoursPerDay) || 0));
            }
        }
        const ptoHours = round2(Object.values(pto).reduce((a, b) => a + b, 0));
        if (salaried && !ptoHours) continue; // salaried people are paid their salary; no hours to send
        const row = {
            userId: p.id, name: p.name || null, employeeUuid: link.gustoUuid, jobUuid: (link.meta && link.meta.jobUuid) || null,
            payType: salaried ? 'salary' : 'hourly',
            regularHours: salaried ? 0 : round2(regular), overtimeHours: salaried ? 0 : round2(overtime), doubleTimeHours: salaried ? 0 : round2(doubleTime),
            pto: Object.entries(pto).map(([name, hours]) => ({ name, hours })), ptoHours
        };
        if (!salaried && !row.jobUuid) issues.push({ severity: 'blocker', code: 'no_job', userId: p.id, message: `${p.name || p.id} has no job/pay rate in Gusto yet. Sync this person again.` });
        rows.push(row);
        totals.regularHours += row.regularHours; totals.overtimeHours += row.overtimeHours; totals.doubleTimeHours += row.doubleTimeHours; totals.ptoHours += ptoHours;
    }
    totals.people = rows.length;
    for (const k of ['regularHours', 'overtimeHours', 'doubleTimeHours', 'ptoHours']) totals[k] = round2(totals[k]);
    return { rows, issues, totals, weeksIncluded: full, ready: !issues.some((i) => i.severity === 'blocker') };
}

/** Stable fingerprint of a feed: if it changes after prepare, the preview is stale and must be redone */
function feedHash(rows) {
    const canon = rows.map((r) => [r.userId, r.regularHours, r.overtimeHours, r.doubleTimeHours, JSON.stringify(r.pto)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return crypto.createHash('sha256').update(JSON.stringify(canon)).digest('hex').slice(0, 24);
}

/** Gusto `employee_compensations` update body from feed rows. Names/multipliers are adapter-level (see mapping notes). */
function toGustoCompensations(rows, existing = []) {
    const byEmp = new Map(rows.map((r) => [r.employeeUuid, r]));
    const out = [];
    for (const ec of existing) {
        const row = byEmp.get(ec.employee_uuid);
        if (!row) continue;
        const jobUuid = row.jobUuid || ((ec.hourly_compensations || [])[0] || {}).job_uuid || null;
        const hourly = [];
        if (row.payType === 'hourly') {
            hourly.push({ name: 'Regular Hours', job_uuid: jobUuid, hours: hoursStr(row.regularHours), compensation_multiplier: 1 });
            hourly.push({ name: 'Overtime', job_uuid: jobUuid, hours: hoursStr(row.overtimeHours), compensation_multiplier: 1.5 });
            hourly.push({ name: 'Double overtime', job_uuid: jobUuid, hours: hoursStr(row.doubleTimeHours), compensation_multiplier: 2 });
        }
        out.push({
            employee_uuid: ec.employee_uuid, excluded: false,
            hourly_compensations: hourly,
            paid_time_off: row.pto.map((p) => ({ name: p.name, hours: hoursStr(p.hours) }))
        });
    }
    return out;
}

/* ------------------------------ reconciliation ------------------------------ */

/**
 * Compare our hours feed with what Gusto holds on the payroll.
 * gustoEmployees: payroll.employee_compensations[]  (hourly_compensations with name/hours)
 */
function reconcile({ feedRows = [], gustoCompensations = [], people = [], links = {} }) {
    const linkOf = (id) => (links instanceof Map ? links.get(id) : links[id]);
    const gById = new Map(gustoCompensations.map((c) => [c.employee_uuid, c]));
    const diffs = [];
    const sumOf = (c, pred) => (c ? (c.hourly_compensations || []).filter(pred).reduce((a, h) => a + Number(h.hours || 0), 0) : 0);
    for (const row of feedRows) {
        const c = gById.get(row.employeeUuid);
        const g = {
            regular: round2(sumOf(c, (h) => Number(h.compensation_multiplier) === 1)),
            overtime: round2(sumOf(c, (h) => Number(h.compensation_multiplier) === 1.5)),
            doubleTime: round2(sumOf(c, (h) => Number(h.compensation_multiplier) === 2))
        };
        const ours = { regular: row.regularHours, overtime: row.overtimeHours, doubleTime: row.doubleTimeHours };
        const mismatch = row.payType === 'hourly' && (!c || ['regular', 'overtime', 'doubleTime'].some((k) => Math.abs(g[k] - ours[k]) > 0.005));
        diffs.push({ userId: row.userId, name: row.name, ours, gusto: g, inGusto: Boolean(c), match: !mismatch });
    }
    const feedIds = new Set(feedRows.map((r) => r.userId));
    const missingLinks = people.filter((p) => p.active !== false && !(linkOf(p.id) && linkOf(p.id).gustoUuid)).map((p) => ({ userId: p.id, name: p.name || null }));
    const linkedNotInFeed = people.filter((p) => p.active !== false && linkOf(p.id) && p.payType === 'hourly' && !feedIds.has(p.id)).map((p) => ({ userId: p.id, name: p.name || null }));
    const knownUuids = new Set(people.map((p) => (linkOf(p.id) || {}).gustoUuid).filter(Boolean));
    const onlyInGusto = gustoCompensations.filter((c) => !knownUuids.has(c.employee_uuid)).map((c) => ({ employeeUuid: c.employee_uuid }));
    return { diffs, mismatches: diffs.filter((d) => !d.match).length, missingLinks, linkedNotInFeed, onlyInGusto, clean: diffs.every((d) => d.match) && !missingLinks.length && !onlyInGusto.length };
}

/* ------------------------------ onboarding state machine ------------------------------ */

const STEP_DEFS = [
    { key: 'company', label: 'Create the company in Gusto', needs: [], help: 'Creates your payroll account at Gusto. Needs the company name, EIN and the admin contact.' },
    { key: 'terms', label: 'Accept the Gusto terms of service', needs: ['company'], help: 'A company admin must accept Gusto\'s terms. Their name, email and IP address are sent to Gusto.' },
    { key: 'locations', label: 'Add the company address (work location)', needs: ['terms'], help: 'Where people work. Used for state and local taxes.' },
    { key: 'federal_tax', label: 'Federal tax details', needs: ['terms'], help: 'Legal name, EIN, tax payer type and filing form.' },
    { key: 'industry', label: 'Choose the industry', needs: ['terms'], help: 'The NAICS code that describes the business.' },
    { key: 'bank', label: 'Add the company bank account', needs: ['terms'], help: 'The account Gusto debits for payroll.' },
    { key: 'bank_verify', label: 'Verify the bank account (two small deposits)', needs: ['bank'], help: 'Gusto sends two small deposits in 1 to 2 business days. Enter the two amounts.' },
    { key: 'pay_schedule', label: 'Set the pay schedule', needs: ['terms'], help: 'How often people are paid and the first pay date.' },
    { key: 'employees', label: 'Add the people to Gusto', needs: ['locations', 'pay_schedule'], help: 'Sync your people. Each one needs name, email, date of birth and a pay rate.' },
    { key: 'employee_onboarded', label: 'Finish at least one employee', needs: ['employees'], help: 'Gusto needs at least one fully onboarded employee before approval.' },
    { key: 'state_taxes', label: 'State tax setup', needs: ['employees'], help: 'State account numbers and rates for each state where people work.' },
    { key: 'signatory', label: 'Name the company signatory', needs: ['terms'], help: 'The person authorised to sign tax forms for the company.' },
    { key: 'forms', label: 'Sign the required forms', needs: ['signatory', 'federal_tax'], help: 'For example the e-file and e-pay authorisation (Form 8655).' },
    { key: 'finish', label: 'Submit for Gusto approval', needs: ['locations', 'federal_tax', 'industry', 'bank_verify', 'pay_schedule', 'employee_onboarded', 'state_taxes', 'signatory', 'forms'], help: 'Tells Gusto you are done. Gusto reviews the company, usually within 2 business days.' },
    { key: 'approval', label: 'Wait for Gusto approval', needs: ['finish'], help: 'Gusto reviews the company. When approved you can run payroll.' }
];
const STEP_KEYS = STEP_DEFS.map((s) => s.key);

/**
 * facts: { company, terms, locations, federalTax, industry, bank, bankVerified, bankVerifyPending, paySchedule,
 *          employees, employeeOnboarded, stateTaxes:{required,done}, signatory, forms:{total,signed}, finished, approved, errors:{step:msg} }
 * Returns [{ key, label, help, status: done|ready|blocked|waiting|error, blockedBy:[labels], note }]
 */
function computeOnboardingSteps(f = {}) {
    const st = f.stateTaxes || { required: 0, done: 0 };
    const fm = f.forms || { total: 0, signed: 0 };
    const done = {
        company: !!f.company, terms: !!f.terms, locations: (f.locations || 0) > 0, federal_tax: !!f.federalTax, industry: !!f.industry,
        bank: !!f.bank, bank_verify: !!f.bankVerified, pay_schedule: (f.paySchedule || 0) > 0, employees: (f.employees || 0) > 0,
        employee_onboarded: (f.employeeOnboarded || 0) > 0, state_taxes: st.required > 0 ? st.done >= st.required : !!f.stateTaxesChecked,
        signatory: !!f.signatory, forms: fm.total > 0 ? fm.signed >= fm.total : !!f.signatory && !!f.formsChecked,
        finish: !!f.finished || !!f.approved, approval: !!f.approved
    };
    const label = Object.fromEntries(STEP_DEFS.map((s) => [s.key, s.label]));
    return STEP_DEFS.map((s) => {
        const blockedBy = s.needs.filter((k) => !done[k]).map((k) => label[k]);
        let status;
        let note = null;
        if (done[s.key]) status = 'done';
        else if (f.errors && f.errors[s.key]) { status = 'error'; note = f.errors[s.key]; }
        else if (blockedBy.length) status = 'blocked';
        else status = 'ready';
        if (s.key === 'bank_verify' && !done.bank_verify && f.bankVerifyPending && !blockedBy.length) { status = 'waiting'; note = 'Waiting for the two small deposits to arrive (1 to 2 business days).'; }
        if (s.key === 'approval' && !done.approval && done.finish) { status = 'waiting'; note = 'Gusto is reviewing the company (usually within 2 business days).'; }
        if (s.key === 'state_taxes' && !done.state_taxes && st.required) note = `${st.done} of ${st.required} states done`;
        if (s.key === 'forms' && !done.forms && fm.total) note = `${fm.signed} of ${fm.total} forms signed`;
        return { key: s.key, label: s.label, help: s.help, status, blockedBy: status === 'blocked' ? blockedBy : [], note };
    });
}
function nextOnboardingStep(steps) {
    return steps.find((s) => s.status === 'ready' || s.status === 'error') || steps.find((s) => s.status === 'waiting') || null;
}

/* ------------------------------ webhook event routing ------------------------------ */

/** Which part of the system an event concerns (so the processor knows what to refresh) */
function classifyEvent(evt) {
    const type = String((evt && (evt.event_type || evt.type)) || '').toLowerCase();
    const entity = String((evt && (evt.entity_type || evt.resource_type)) || '').toLowerCase();
    if (type.startsWith('company.') || entity === 'company') return 'company';
    if (type.startsWith('payroll.') || entity === 'payroll') return 'payroll';
    if (type.startsWith('employee.') || entity === 'employee') return 'employee';
    if (type.startsWith('time_off') || entity === 'timeoffrequest') return 'time_off';
    if (type.startsWith('form.') || entity === 'form') return 'form';
    if (type.startsWith('document.') || entity === 'document') return 'document';
    if (type.startsWith('notification') || entity === 'notification') return 'notification';
    return 'other';
}

/** Stable dedupe key for an event (Gusto sends a uuid per event) */
function eventKey(evt) {
    if (evt && evt.uuid) return String(evt.uuid);
    return crypto.createHash('sha256').update(JSON.stringify(evt || {})).digest('hex').slice(0, 32);
}

/** Retry schedule for processing our own queue: 1m, 5m, 30m, 2h, 6h ... gives up after `max` attempts */
function processRetryDelayMs(attempt, max = 8) {
    if (attempt >= max) return null;
    return [60e3, 300e3, 1800e3, 7200e3, 21600e3, 43200e3, 86400e3, 86400e3][Math.min(attempt, 7)];
}

const GUSTO_FREQUENCY = { weekly: 'Every week', biweekly: 'Every other week', semimonthly: 'Twice per month', monthly: 'Monthly' };
const OUR_FREQUENCY = Object.fromEntries(Object.entries(GUSTO_FREQUENCY).map(([k, v]) => [v, k]));

module.exports = {
    signPayload, verifySignature, backoffMs, retryAfterMs, createRateWindow,
    pacificDeadlineIso, cutoffInfo, subBusinessDays, addDays, weekPlacement, buildHoursFeed, feedHash, toGustoCompensations, reconcile,
    STEP_DEFS, STEP_KEYS, computeOnboardingSteps, nextOnboardingStep, classifyEvent, eventKey, processRetryDelayMs,
    GUSTO_FREQUENCY, OUR_FREQUENCY, hoursStr, round2, parseIso
};
