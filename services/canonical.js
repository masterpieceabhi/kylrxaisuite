/**
 * Canonical HR model, version v1 (pure, no I/O).
 *
 * Everything that leaves the product through the public API, webhooks, SCIM or a connector is
 * shaped here. Mappers WHITELIST fields (they never spread a stored document), so new stored
 * fields cannot leak by accident. Never exposed, at any scope: SSN/ITIN, bank details, medical
 * or leave reasons, EEO/demographic data, date of birth, home address, password material.
 * Pay fields appear only when the caller holds the `pay:read` scope.
 */

const SCHEMA_VERSION = 'v1';

/** Key fragments that must never appear in an outgoing object (defense in depth) */
const FORBIDDEN_KEY = /(ssn|taxpayer|itin|password|passwd|secret|bank|routing|account_?number|iban|medical|disab|ethnic|race|veteran|eeo|gender|date_?of_?birth|dob|home_?address|keyhash|credential)/i;

const iso = (v) => {
    if (!v) return null;
    if (typeof v === 'string') { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
    if (typeof v.toDate === 'function') return v.toDate().toISOString();
    if (v instanceof Date) return v.toISOString();
    if (typeof v._seconds === 'number') return new Date(v._seconds * 1000).toISOString();
    return null;
};
const dateOnly = (v) => { const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
const realDate = (v) => { const d = dateOnly(v); if (!d) return null; const t = new Date(`${d}T00:00:00Z`); return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null; };
const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const STATUS = { active: 'active', terminated: 'terminated', inactive: 'inactive', suspended: 'inactive', onboarding: 'pending', pending: 'pending', invited: 'pending' };
const personStatus = (s) => STATUS[String(s || 'active').toLowerCase()] || 'active';

const orgUnitId = (name) => (name ? `ou_${slug(name)}` : null);
const locationIdFor = (user) => {
    const p = (user && user.usProfile) || {};
    if (user.locationId) return String(user.locationId);
    return p.workState ? `loc_${String(p.workState).toLowerCase()}` : null;
};

/** Timestamp that drives `updated_since` and ETags */
function updatedAtOf(doc) {
    const p = (doc && doc.usProfile) || {};
    return iso(doc.updatedAt) || iso(p.updatedAt) || iso(doc.createdAt) || iso(doc.uploadedAt) || null;
}

function stripForbidden(value) {
    if (Array.isArray(value)) return value.map(stripForbidden);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (FORBIDDEN_KEY.test(k)) continue;
            out[k] = stripForbidden(v);
        }
        return out;
    }
    return value;
}

/** Throws if a forbidden key is present anywhere (used by tests) */
function findForbiddenKeys(value, path = '') {
    const hits = [];
    if (Array.isArray(value)) value.forEach((v, i) => hits.push(...findForbiddenKeys(v, `${path}[${i}]`)));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (FORBIDDEN_KEY.test(k)) hits.push(`${path}.${k}`);
            hits.push(...findForbiddenKeys(v, `${path}.${k}`));
        }
    }
    return hits;
}

/* --------------------------------- Person --------------------------------- */

function splitName(full) {
    const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { first: null, last: null };
    if (parts.length === 1) return { first: parts[0], last: null };
    return { first: parts[0], last: parts.slice(1).join(' ') };
}

function toCompensation(user) {
    const p = user.usProfile || {};
    if (p.payRate === undefined && !p.payType) return null;
    return { pay_type: str(p.payType), pay_rate: num(p.payRate), pay_frequency: str(p.payFrequency), currency: 'USD' };
}

function toPerson(user, { includePay = false } = {}) {
    const p = user.usProfile || {};
    const nm = splitName(user.name);
    const first = str(p.legalFirstName) || nm.first;
    const last = str(p.legalLastName) || nm.last;
    const dept = str(user.departmentName || user.department_name || (user.department !== 'General Operations' ? user.department : null));
    const out = {
        object: 'person',
        schema_version: SCHEMA_VERSION,
        id: user.id || user.uid,
        employee_number: str(user.employeeId),
        status: personStatus(user.status),
        first_name: first,
        last_name: last,
        preferred_name: str(p.preferredName),
        display_name: str(user.name) || [first, last].filter(Boolean).join(' ') || null,
        work_email: str(user.email),
        phone: str(user.phone),
        hire_date: dateOnly(p.startDate || user.joiningDate),
        termination_date: dateOnly(user.terminationDate || (user.terminatedAt)),
        job: {
            title: str(user.jobTitle),
            org_unit_id: orgUnitId(dept),
            org_unit_name: dept,
            location_id: locationIdFor(user),
            manager_id: str(p.managerId || user.managerId),
            employment_type: str(p.employmentType),
            classification: str(p.classification),
            flsa_status: str(p.flsaStatus)
        },
        work_state: str(p.workState),
        created_at: iso(user.createdAt),
        updated_at: updatedAtOf(user)
    };
    if (includePay) out.compensation = toCompensation(user);
    return out;
}

function toJob(user, { includePay = false } = {}) {
    const person = toPerson(user, { includePay });
    const out = {
        object: 'job', schema_version: SCHEMA_VERSION,
        id: `${person.id}_primary`, person_id: person.id, is_primary: true,
        title: person.job.title, org_unit_id: person.job.org_unit_id, location_id: person.job.location_id,
        manager_id: person.job.manager_id, employment_type: person.job.employment_type,
        classification: person.job.classification, flsa_status: person.job.flsa_status,
        start_date: person.hire_date, end_date: person.termination_date, status: person.status, updated_at: person.updated_at
    };
    if (includePay) out.compensation = person.compensation;
    return out;
}

/* ----------------------------- Org unit / Location ----------------------------- */

/** Departments come from the `departments` collection and from the people's department names */
function buildOrgUnits(departmentDocs, users) {
    const map = new Map();
    for (const d of departmentDocs || []) {
        const name = str(d.departmentName || d.name);
        if (!name) continue;
        map.set(slug(name), {
            object: 'org_unit', schema_version: SCHEMA_VERSION, id: orgUnitId(name), name, code: str(d.departmentCode || d.code),
            type: 'department', parent_id: null, head_person_id: str(d.departmentHead || d.headId), headcount: 0,
            created_at: iso(d.createdAt), updated_at: updatedAtOf(d)
        });
    }
    for (const u of users || []) {
        if (personStatus(u.status) === 'terminated') continue;
        const name = str(u.departmentName || u.department_name);
        if (!name) continue;
        const key = slug(name);
        if (!map.has(key)) {
            map.set(key, { object: 'org_unit', schema_version: SCHEMA_VERSION, id: orgUnitId(name), name, code: null, type: 'department', parent_id: null, head_person_id: null, headcount: 0, created_at: null, updated_at: null });
        }
        const unit = map.get(key);
        unit.headcount += 1;
        const ts = updatedAtOf(u);
        if (ts && (!unit.updated_at || ts > unit.updated_at)) unit.updated_at = ts;
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildLocations(locationDocs, users, org) {
    const out = new Map();
    const biz = (org && org.usProfile && org.usProfile.businessAddress) || null;
    const tz = (org && org.usProfile && org.usProfile.timezone) || null;
    if (biz) {
        out.set('loc_hq', {
            object: 'location', schema_version: SCHEMA_VERSION, id: 'loc_hq', name: 'Headquarters', type: 'headquarters',
            address: { line1: str(biz.line1 || biz.street), line2: str(biz.line2), city: str(biz.city), state: str(biz.state), postal_code: str(biz.zip || biz.postalCode), country: 'US' },
            time_zone: tz, headcount: 0, updated_at: iso(org.updatedAt) || null
        });
    }
    for (const l of locationDocs || []) {
        const id = String(l.locationId || l.id || '');
        if (!id) continue;
        out.set(id, {
            object: 'location', schema_version: SCHEMA_VERSION, id, name: str(l.locationName || l.name) || id, type: str(l.type) || 'office',
            address: { line1: str(l.address1 || l.line1), line2: str(l.address2 || l.line2), city: str(l.city), state: str(l.state), postal_code: str(l.zip || l.postalCode), country: str(l.country) || 'US' },
            time_zone: str(l.timeZone || l.timezone) || tz, headcount: 0, updated_at: updatedAtOf(l)
        });
    }
    for (const u of users || []) {
        if (personStatus(u.status) === 'terminated') continue;
        const id = locationIdFor(u);
        if (!id) continue;
        if (!out.has(id)) {
            const st = ((u.usProfile || {}).workState || '').toUpperCase();
            out.set(id, { object: 'location', schema_version: SCHEMA_VERSION, id, name: `${st} work location`, type: 'work_state', address: { line1: null, line2: null, city: null, state: st || null, postal_code: null, country: 'US' }, time_zone: tz, headcount: 0, updated_at: null });
        }
        out.get(id).headcount += 1;
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------------------------- Time ---------------------------------- */

const round2 = (n) => Math.round(n * 100) / 100;

function toWeeklyTimeEntry(week, person) {
    const t = week.totals || {};
    const [uid] = String(week.id || '').split('_');
    const weekStart = week.weekStart || String(week.id || '').split('_')[1];
    const end = new Date(`${weekStart}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
    return {
        object: 'time_entry', schema_version: SCHEMA_VERSION, id: week.id, period: 'week',
        person_id: week.userId || uid, employee_number: str((person && person.employeeId) || week.employeeId),
        date: weekStart, end_date: end.toISOString().slice(0, 10), status: week.status,
        hours: { worked: num(t.workedHours), regular: num(t.regularHours), overtime: num(t.overtimeHours), double_time: num(t.doubleTimeHours) },
        approved_at: iso(week.decidedAt), updated_at: iso(week.decidedAt) || iso(week.submittedAt)
    };
}

/**
 * Daily worked hours from punches (types: in, out, break_start, break_end), grouped by local date.
 * An open shift (no out yet) is ignored.
 */
function dailyFromPunches(punches) {
    const sorted = [...punches].filter((p) => !p.voided).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const days = new Map();
    const day = (d) => { if (!days.has(d)) days.set(d, { workedMs: 0, breakMs: 0, firstIn: null, lastOut: null }); return days.get(d); };
    let workStart = null; let breakStart = null; let startDate = null;
    for (const p of sorted) {
        const at = new Date(p.at).getTime();
        if (p.type === 'in') { workStart = at; startDate = p.localDate; if (!day(startDate).firstIn) day(startDate).firstIn = p.at; }
        else if (p.type === 'break_start' && workStart !== null) { day(startDate).workedMs += at - workStart; workStart = null; breakStart = at; }
        else if (p.type === 'break_end' && breakStart !== null) { day(startDate).breakMs += at - breakStart; breakStart = null; workStart = at; }
        else if (p.type === 'out' && workStart !== null) { const d = day(startDate); d.workedMs += at - workStart; d.lastOut = p.at; workStart = null; }
        else if (p.type === 'out' && breakStart !== null) { day(startDate).breakMs += at - breakStart; day(startDate).lastOut = p.at; breakStart = null; }
    }
    return [...days.entries()].map(([date, d]) => ({ date, workedHours: round2(d.workedMs / 3600000), breakMinutes: Math.round(d.breakMs / 60000), firstIn: d.firstIn, lastOut: d.lastOut }))
        .filter((d) => d.lastOut).sort((a, b) => a.date.localeCompare(b.date));
}

function toDailyTimeEntry(personId, employeeNumber, d) {
    return {
        object: 'time_entry', schema_version: SCHEMA_VERSION, id: `${personId}_${d.date}`, period: 'day',
        person_id: personId, employee_number: str(employeeNumber), date: d.date, end_date: d.date, status: 'approved',
        hours: { worked: d.workedHours, regular: null, overtime: null, double_time: null },
        break_minutes: d.breakMinutes, first_in: d.firstIn, last_out: d.lastOut, updated_at: d.lastOut
    };
}

/* ---------------------------------- Leave ---------------------------------- */

/** The free-text reason is never exposed: it can describe medical conditions */
function toLeaveRequest(r) {
    return {
        object: 'leave_request', schema_version: SCHEMA_VERSION, id: r.id, person_id: r.userId, employee_number: str(r.employeeId),
        policy_id: str(r.policyId), policy_name: str(r.policyName), leave_type: str(r.type),
        start_date: dateOnly(r.startDate), end_date: dateOnly(r.endDate), dates: Array.isArray(r.dates) ? r.dates : [],
        hours: num(r.hours), hours_per_day: num(r.hoursPerDay), status: str(r.status),
        decided_at: iso(r.decidedAt), decided_by: str(r.decidedBy),
        created_at: iso(r.createdAt), updated_at: iso(r.decidedAt) || iso(r.cancelledAt) || iso(r.createdAt)
    };
}

function toLeaveBalance(person, policy, bal, asOf) {
    const b = bal || {};
    return {
        object: 'leave_balance', schema_version: SCHEMA_VERSION, id: `${person.id}_${policy.id}`, person_id: person.id, employee_number: str(person.employeeId),
        policy_id: policy.id, policy_name: str(policy.name), leave_type: str(policy.type), as_of: asOf || null,
        available_hours: num(b.availableBalance), balance_hours: num(b.balance), accrued_this_year_hours: num(b.accruedThisYear), pending_hours: num(b.pendingHours),
        updated_at: null
    };
}

/* ---------------------------------- Pay ---------------------------------- */

/** Placeholder: the payroll provider module (Gusto) will write documents into `pay_results` */
function toPayResult(r) {
    const n = (v) => (v === undefined || v === null ? null : Number(v));
    return {
        object: 'pay_result', schema_version: SCHEMA_VERSION, id: r.id, person_id: str(r.userId || r.personId), employee_number: str(r.employeeId),
        pay_period: { start: dateOnly(r.periodStart), end: dateOnly(r.periodEnd) }, pay_date: dateOnly(r.payDate), status: str(r.status),
        currency: str(r.currency) || 'USD', gross: n(r.gross), net: n(r.net), employee_taxes: n(r.employeeTaxes), employer_taxes: n(r.employerTaxes),
        deductions: n(r.deductions), hours: n(r.hours), department: str(r.department), updated_at: iso(r.updatedAt) || iso(r.createdAt)
    };
}

/* -------------------------------- Documents -------------------------------- */

/** Documents that are never listed, even as metadata */
const HIDDEN_DOC_CATEGORIES = new Set(['medical_confidential', 'disciplinary', 'eeo_filing']);
const isDocumentVisible = (d) => !d.deleted && !d.confidential && !HIDDEN_DOC_CATEGORIES.has(d.category);

/** Metadata only; the file bytes (and download links) are never part of the API */
function toDocumentMeta(d) {
    return {
        object: 'document', schema_version: SCHEMA_VERSION, id: d.id, scope: str(d.scope), category: str(d.category), title: str(d.title),
        person_id: str(d.userId), file_name: str(d.fileName), mime_type: str(d.mime), size_bytes: num(d.size), checksum_sha256: str(d.sha256),
        expires_on: dateOnly(d.expiresOn), retain_until: dateOnly(d.retainUntil), uploaded_at: iso(d.uploadedAt), updated_at: iso(d.uploadedAt)
    };
}

/* --------------------------- Inbound (write) mapping --------------------------- */

/** Accepts the canonical person shape from API/SCIM writers and returns the stored-field patch */
function personPatchFromCanonical(input) {
    const b = input || {};
    const patch = {}; const errors = [];
    const set = (key, v) => { if (v !== undefined) patch[key] = v; };
    const text = (field, max = 120) => {
        if (b[field] === undefined) return undefined;
        const v = b[field] === null ? '' : String(b[field]).trim();
        if (v.length > max) { errors.push(`${field} is too long`); return undefined; }
        return v;
    };
    const first = text('first_name'); const last = text('last_name');
    if (first !== undefined) { if (!first) errors.push('first_name cannot be empty'); else set('firstName', first); }
    if (last !== undefined) { if (!last) errors.push('last_name cannot be empty'); else set('lastName', last); }
    set('preferredName', text('preferred_name'));
    set('phone', text('phone', 40));
    const email = text('work_email');
    if (email !== undefined) { if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.push('work_email is not valid'); else set('email', email.toLowerCase()); }
    const job = b.job && typeof b.job === 'object' ? b.job : {};
    if (b.job_title !== undefined) job.title = b.job_title;
    if (job.title !== undefined) set('jobTitle', String(job.title || '').trim().slice(0, 120));
    if (job.org_unit_name !== undefined) set('departmentName', String(job.org_unit_name || '').trim().slice(0, 120));
    if (job.manager_id !== undefined) set('managerId', job.manager_id === null ? null : String(job.manager_id));
    if (b.hire_date !== undefined) {
        const d = realDate(b.hire_date);
        if (!d) errors.push('hire_date must be YYYY-MM-DD'); else set('startDate', d);
    }
    if (b.termination_date !== undefined) {
        const d = b.termination_date === null ? null : realDate(b.termination_date);
        if (b.termination_date !== null && !d) errors.push('termination_date must be YYYY-MM-DD'); else set('terminationDate', d);
    }
    if (b.status !== undefined) {
        if (!['active', 'inactive', 'terminated'].includes(b.status)) errors.push('status must be active, inactive or terminated'); else set('status', b.status);
    }
    return { errors, patch };
}

module.exports = {
    SCHEMA_VERSION, FORBIDDEN_KEY, slug, iso, dateOnly, orgUnitId, locationIdFor, updatedAtOf, personStatus,
    stripForbidden, findForbiddenKeys, splitName, realDate,
    toPerson, toJob, toCompensation, buildOrgUnits, buildLocations,
    toWeeklyTimeEntry, dailyFromPunches, toDailyTimeEntry, toLeaveRequest, toLeaveBalance, toPayResult,
    isDocumentVisible, toDocumentMeta, HIDDEN_DOC_CATEGORIES, personPatchFromCanonical
};
