/**
 * Company data download and account closure: the pure parts (no database, no files, no email).
 *   - zip(entries)              a ZIP file (deflate) from [{ name, data }]; Node's zlib only, no library
 *   - cleanRecord(value)        a stored record made safe to hand out: sign-in secrets removed, encrypted values
 *                               (SSNs, bank and document numbers) replaced by a note, Firestore types made plain JSON
 *   - exportPlan / deletePlan   which collections go into the download, and which are deleted when a company closes
 *   - closure rules             the 30-day wait, who may undo it, when the reminder goes
 * The promise these keep is in docs/policies/DATA_PROCESSING_AGREEMENT_DRAFT.md section 9: the customer can download its
 * data for 30 days after the end, then it is deleted and the deletion is confirmed in writing.
 */
const zlib = require('zlib');

const WAIT_DAYS = 30;
const REMIND_DAYS_BEFORE = 3;

/* ------------------------------------------------------------------ what goes where */

// Platform-wide or our own business records: never in a company download, never deleted with a company.
const PLATFORM = new Set(['organizations', 'system_config', 'system_configs', 'system_counters', 'platform_jobs', 'company_closures',
    'billing_accounts', 'billing_events', 'enterprise_metrics']);
// Sign-in and access secrets: deleted with the company, but never handed out.
const SECRET = new Set(['otp_verifications', 'oauth_codes', 'oauth_tokens', 'scim_tokens', 'signin_qr_links', 'api_idempotency', 'api_keys']);
// Our invoices to the customer: in the download (they are the customer's invoices too), kept by us for tax records.
const KEEP_BUT_EXPORT = new Set(['billing_invoices']);

/** Every collection the app writes company data to (the database's own list is added to this at run time). */
const KNOWN = ['activities', 'alert_breaches', 'alert_rules', 'alerts', 'api_access_log', 'api_idempotency', 'api_keys', 'approval_resolutions',
    'asset_audit_logs', 'asset_declarations', 'asset_issue_reports', 'assets', 'assignment_rules', 'assistant_threads', 'assistant_usage', 'attendance',
    'attendance_regularizations', 'audit_chain', 'audit_logs', 'automation_audit_logs', 'automation_runs', 'automations', 'background_checks',
    'bank_reconciliations', 'benefit_settings', 'billing_invoices', 'bulk_ai_configurations', 'bulk_trigger_audit_logs', 'bulk_trigger_jobs', 'candidate_eeo',
    'candidate_events', 'candidates', 'checklist_templates', 'checklists', 'clock_consents', 'clock_devices', 'clock_exceptions', 'clock_jurisdiction_rules',
    'clock_notices', 'clock_policies', 'cobra_records', 'comp_history', 'company_holidays', 'compliance_plans', 'connector_connections',
    'connector_dead_letters', 'connector_logs', 'connector_runs', 'connector_sync_state', 'contractor_payments', 'contractor_w9', 'contractors',
    'conversion_audit', 'counters', 'custom_field_defs', 'departments', 'disbursement_batches', 'doc_templates', 'document_audit_logs', 'eeo_selfid',
    'employee_assignments', 'employee_exits', 'employee_finance', 'employee_types', 'employees', 'event_outbox', 'everify_cases',
    'exit_interview_settings', 'exit_interviews', 'gusto_connections', 'gusto_links', 'hiring_settings', 'history', 'informational_notices',
    'integration_alerts', 'job_requisitions', 'kiosks', 'leave_adjustments', 'leave_case_settings', 'leave_cases', 'leave_payout_locks',
    'leave_payout_settings', 'leave_payouts', 'leave_policies', 'leave_requests', 'locations', 'new_hire_agencies', 'new_hire_submissions',
    'notice_attachments', 'notice_templates', 'notifications', 'oauth_apps', 'oauth_codes', 'oauth_grants', 'oauth_tokens', 'onboarding_reminders_audit',
    'osha_incidents', 'otp_audit_logs', 'otp_verifications', 'pay_results', 'pay_schedules', 'payment_batches', 'payroll', 'payroll_documents',
    'payroll_exception_alerts', 'payroll_reprocessing_queue', 'payroll_runs', 'pending_approvals', 'people_data_settings', 'people_tags', 'policies',
    'policy_acks', 'policy_audit', 'policy_settings', 'policy_versions', 'posting_records', 'privacy_requests', 'privacy_settings',
    'profile_change_requests', 'punch_corrections', 'punch_photos', 'salary_structures', 'schedule_shifts', 'scim_tokens', 'shifts', 'sign_requests',
    'signin_qr_links', 'support_grants', 'tasks', 'time_punches', 'timesheet_weeks', 'tip_distributions', 'tip_pools', 'tip_records', 'tip_settings',
    'users', 'validation_issues', 'vault_documents', 'wage_rules', 'webhook_audit_logs', 'webhook_deliveries', 'webhook_endpoints'];

const NAME = /^[A-Za-z0-9_-]{1,100}$/;
const allNames = (fromDb = []) => [...new Set([...KNOWN, ...fromDb])].filter((n) => NAME.test(n)).sort();

/** Collections in a company's download. */
function exportPlan(fromDb = []) { return allNames(fromDb).filter((n) => !PLATFORM.has(n) && !SECRET.has(n)); }

/** Collections whose records for the company are deleted when it closes (the company's organizations record goes too). */
function deletePlan(fromDb = []) { return allNames(fromDb).filter((n) => !PLATFORM.has(n) && !KEEP_BUT_EXPORT.has(n)); }

/* ------------------------------------------------------------------ cleaning a record */

// Field names that hold sign-in secrets (PIN and password hashes, authenticator secrets, tokens, codes).
const SECRET_FIELD = /(hash|secret|salt|token|password|privatekey|apikey|webhookkey|signingkey|refreshtoken)|^(pin|pincode|totp|otp|otpcode)$|^(totp|otp)[A-Z_]/i;
// The app's encrypted values: "v1:<iv>:<tag>:<data>" (services/pii-crypto.js)
const ENCRYPTED = /^v1:[A-Za-z0-9+/=]{8,}:[A-Za-z0-9+/=]{8,}:[A-Za-z0-9+/=]+$/;
const ENCRYPTED_NOTE = '[encrypted, not included]';

function cleanRecord(v, depth = 0) {
    if (depth > 30) return null;
    if (v === null || v === undefined) return v === undefined ? undefined : null;
    if (typeof v === 'string') return ENCRYPTED.test(v) ? ENCRYPTED_NOTE : v;
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map((x) => { const c = cleanRecord(x, depth + 1); return c === undefined ? null : c; });
    if (v instanceof Date) return v.toISOString();
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) return '[binary, not included]';
    if (typeof v === 'object') {
        if (typeof v.toDate === 'function' && typeof v.seconds === 'number') return v.toDate().toISOString();
        if (typeof v.latitude === 'number' && typeof v.longitude === 'number') return { latitude: v.latitude, longitude: v.longitude };
        if (typeof v.path === 'string' && typeof v.id === 'string' && (v.firestore !== undefined || typeof v.collection === 'function')) return v.path;
        const out = {};
        for (const [k, x] of Object.entries(v)) {
            if (SECRET_FIELD.test(k)) continue;
            const c = cleanRecord(x, depth + 1);
            if (c !== undefined) out[k] = c;
        }
        return out;
    }
    return null;
}

/* ------------------------------------------------------------------ zip */

const DOS_EPOCH = Date.UTC(1980, 0, 1);
function dosTime(d) {
    const t = new Date(Math.max(d.getTime(), DOS_EPOCH));
    return {
        time: (t.getUTCHours() << 11) | (t.getUTCMinutes() << 5) | Math.floor(t.getUTCSeconds() / 2),
        date: ((t.getUTCFullYear() - 1980) << 9) | ((t.getUTCMonth() + 1) << 5) | t.getUTCDate()
    };
}

/** [{ name, data: Buffer|string }] -> one ZIP Buffer. Names are cleaned to safe relative paths. */
function zip(entries, now = new Date()) {
    const { time, date } = dosTime(now);
    const locals = []; const centrals = []; let offset = 0; const seen = new Set();
    for (const e of entries) {
        let name = String(e.name || 'file').replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..').map((p) => p.replace(/[^\w.\- ]+/g, '_').slice(0, 120)).join('/') || 'file';
        while (seen.has(name)) name = name.replace(/(\.[^./]+)?$/, (m) => `_1${m}`);
        seen.add(name);
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data == null ? '' : e.data), 'utf8');
        const crc = zlib.crc32(raw) >>> 0;
        const packed = zlib.deflateRawSync(raw);
        const useDeflate = packed.length < raw.length;
        const body = useDeflate ? packed : raw;
        const nameBuf = Buffer.from(name, 'utf8');
        const head = Buffer.alloc(30);
        head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(useDeflate ? 8 : 0, 8);
        head.writeUInt16LE(time, 10); head.writeUInt16LE(date, 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18);
        head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26); head.writeUInt16LE(0, 28);
        locals.push(head, nameBuf, body);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
        cen.writeUInt16LE(time, 12); cen.writeUInt16LE(date, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(raw.length, 24);
        cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
        centrals.push(cen, nameBuf);
        offset += head.length + nameBuf.length + body.length;
        if (offset > 0xFFFFFFFF) throw new Error('The download is too large for one ZIP file');
    }
    const cenBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(seen.size, 8); end.writeUInt16LE(seen.size, 10);
    end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cenBuf, end]);
}

/** Reads a ZIP made by zip() (for tests and checks): [{ name, data }]. */
function unzip(buf) {
    const out = [];
    let p = 0;
    while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) {
        const method = buf.readUInt16LE(p + 8); const size = buf.readUInt32LE(p + 18); const nameLen = buf.readUInt16LE(p + 26); const extra = buf.readUInt16LE(p + 28);
        const name = buf.slice(p + 30, p + 30 + nameLen).toString('utf8');
        const body = buf.slice(p + 30 + nameLen + extra, p + 30 + nameLen + extra + size);
        out.push({ name, data: method === 8 ? zlib.inflateRawSync(body) : body, crc: buf.readUInt32LE(p + 14) });
        p += 30 + nameLen + extra + size;
    }
    return out;
}

/* ------------------------------------------------------------------ closure */

const dayOf = (d) => new Date(d).toISOString().slice(0, 10);
function addDays(day, n) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return dayOf(d); }

/** The typed name must match the company's name (spaces and letter case do not matter). */
function nameMatches(typed, org) {
    const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
    const t = norm(typed);
    if (!t) return false;
    return [org.legalName, org.Legal_Name, org.name, org.companyName, org.Display_Name].filter(Boolean).some((n) => norm(n) === t);
}

/** A new closure request: deletion on the morning after WAIT_DAYS full days. */
function newClosure({ now = new Date(), by, byEmail, companyName }) {
    const today = dayOf(now);
    return { state: 'scheduled', requestedAt: new Date(now).toISOString(), requestedBy: by || null, contactEmail: byEmail || null, companyName: companyName || null,
        deleteOn: addDays(today, WAIT_DAYS), remindOn: addDays(today, WAIT_DAYS - REMIND_DAYS_BEFORE), reminded: false };
}

const isScheduled = (c) => Boolean(c && c.state === 'scheduled');
const dueForDeletion = (c, today) => isScheduled(c) && String(c.deleteOn || '9999') <= today;
const dueForReminder = (c, today) => isScheduled(c) && !c.reminded && String(c.remindOn || '9999') <= today && String(c.deleteOn) > today;
const canWithdraw = (c, today) => isScheduled(c) && String(c.deleteOn) > today;

module.exports = { WAIT_DAYS, REMIND_DAYS_BEFORE, PLATFORM, SECRET, KEEP_BUT_EXPORT, KNOWN, ENCRYPTED_NOTE, exportPlan, deletePlan, cleanRecord, zip, unzip,
    nameMatches, newClosure, isScheduled, dueForDeletion, dueForReminder, canWithdraw, addDays, dayOf };
