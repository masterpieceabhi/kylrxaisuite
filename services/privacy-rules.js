/**
 * Privacy request rules (pure, no I/O): CCPA/CPRA-style requests from employees.
 * Deadlines, retention periods and wording are DATA a company can edit (settings), not hard-coded law.
 * Confirm every number with a US privacy/employment advisor before relying on it.
 */
const { parseIsoDate, isoDate } = require('./us-forms');

const DAY = 86400000;

const REQUEST_TYPES = {
    access: { en: 'Know / get a copy of my data', es: 'Saber / recibir una copia de mis datos' },
    delete: { en: 'Delete my data', es: 'Eliminar mis datos' },
    correct: { en: 'Correct my data', es: 'Corregir mis datos' },
    limit_sensitive: { en: 'Limit use of my sensitive information', es: 'Limitar el uso de mi información sensible' },
    opt_out: { en: 'Opt out of sale or sharing', es: 'Optar por no vender ni compartir mis datos' }
};

const STATUSES = ['received', 'in_progress', 'completed', 'denied', 'cancelled'];
const OPEN = ['received', 'in_progress'];

const DEFAULT_SETTINGS = {
    responseDays: 45,          // days to respond from receipt
    extensionDays: 45,         // one extension, with notice and a reason
    maxExtensions: 1,
    acknowledgeBusinessDays: 10,
    dueSoonDays: 7,            // "due soon" warning window
    exportLinkHours: 72,       // how long an access export link works
    exportMaxDownloads: 5
};

/**
 * Default retention table. years counts from `anchor`:
 *   termination: last day of employment (while still employed the records are kept)
 *   record: the record's own date
 *   i9: the LATER of hire + i9HireYears and termination + i9TermYears
 * These are suggestions drawn from common federal recordkeeping rules; the company edits them.
 */
const DEFAULT_RETENTION = [
    { key: 'profile_optional', label: 'Optional profile details (phone, personal email, emergency contacts, preferred name)', years: 0, anchor: 'none', basis: 'No legal retention need' },
    { key: 'consents', label: 'Consents and notices you acknowledged', years: 0, anchor: 'none', basis: 'No legal retention need' },
    { key: 'punch_photos', label: 'Clock-in photos', years: 0, anchor: 'none', basis: 'No legal retention need' },
    { key: 'eeo_selfid', label: 'EEO self-identification answers', years: 1, anchor: 'termination', basis: 'EEO recordkeeping (confirm the period)' },
    { key: 'time_punches', label: 'Time punches and timesheets', years: 3, anchor: 'record', basis: 'Wage and hour (FLSA) recordkeeping' },
    { key: 'leave_requests', label: 'Leave requests and balances', years: 3, anchor: 'record', basis: 'Leave recordkeeping (FMLA and state sick leave rules)' },
    { key: 'payroll_forms', label: 'Pay, W-4 and direct deposit records', years: 4, anchor: 'termination', basis: 'Payroll and employment tax records' },
    { key: 'i9', label: 'Form I-9', years: 1, i9HireYears: 3, anchor: 'i9', basis: 'I-9 rule: later of 3 years after hire or 1 year after employment ends' },
    { key: 'osha_incidents', label: 'Workplace injury and illness records', years: 5, anchor: 'record', basis: 'OSHA recordkeeping' },
    { key: 'vault_documents', label: 'Documents in the vault', years: null, anchor: 'document', basis: "Each document's own retention date and any legal hold" },
    { key: 'audit_logs', label: 'Security and audit log entries about you', years: 7, anchor: 'record', basis: 'Security and accountability record (no personal content beyond what happened)' },
    { key: 'privacy_requests', label: 'Records of privacy requests', years: 2, anchor: 'record', basis: 'Privacy law requires keeping request records (about 24 months)' },
    { key: 'account', label: 'Core identity record (name, employee ID, account)', years: 0, anchor: 'follows_others', basis: 'Kept while any category above is retained' }
];

const posInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function validateSettings(input) {
    const errors = [];
    const b = input || {};
    const out = { ...DEFAULT_SETTINGS };
    for (const [k, lo, hi] of [['responseDays', 1, 120], ['extensionDays', 0, 90], ['maxExtensions', 0, 3], ['acknowledgeBusinessDays', 0, 30], ['dueSoonDays', 1, 30], ['exportLinkHours', 1, 720], ['exportMaxDownloads', 1, 50]]) {
        if (b[k] === undefined) continue;
        const v = Number(b[k]);
        if (!posInt(v, lo, hi)) errors.push(`${k} must be a whole number from ${lo} to ${hi}`); else out[k] = v;
    }
    let retention = DEFAULT_RETENTION;
    if (b.retention !== undefined) {
        if (!Array.isArray(b.retention)) errors.push('retention must be a list');
        else {
            retention = DEFAULT_RETENTION.map((d) => {
                const o = b.retention.find((r) => r && r.key === d.key);
                if (!o) return d;
                const y = o.years === null ? null : Number(o.years);
                if (d.years !== null && !posInt(y, 0, 50)) { errors.push(`retention ${d.key}: years must be a whole number from 0 to 50`); return d; }
                const next = { ...d, years: d.years === null ? null : y, basis: String(o.basis || d.basis).slice(0, 200) };
                if (d.key === 'i9' && o.i9HireYears !== undefined) { if (!posInt(Number(o.i9HireYears), 0, 20)) errors.push('retention i9: i9HireYears must be 0 to 20'); else next.i9HireYears = Number(o.i9HireYears); }
                return next;
            });
        }
    }
    return { errors, value: errors.length ? null : { ...out, retention } };
}

const addDaysIso = (iso, n) => new Date(Date.parse(iso) + n * DAY).toISOString();

/** dueAt = receipt + responseDays; after an extension, + extensionDays more */
function deadlines(receivedAtIso, settings = DEFAULT_SETTINGS, extensionsUsed = 0) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const base = addDaysIso(receivedAtIso, s.responseDays);
    const extended = extensionsUsed > 0 ? addDaysIso(base, s.extensionDays * extensionsUsed) : base;
    return { dueAt: extended, originalDueAt: base, acknowledgeBy: businessDaysAfter(receivedAtIso.slice(0, 10), s.acknowledgeBusinessDays) };
}

function businessDaysAfter(isoDay, n) {
    let d = parseIsoDate(isoDay); let left = n;
    while (left > 0) { d = new Date(d.getTime() + DAY); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left -= 1; }
    return isoDate(d);
}

/** SLA state for a request: closed | overdue | due_soon | on_track, with days left (negative when late) */
function slaStatus(req, nowIso, settings = DEFAULT_SETTINGS) {
    if (!OPEN.includes(req.status)) return { state: 'closed', daysLeft: null };
    const s = { ...DEFAULT_SETTINGS, ...settings };
    const daysLeft = Math.ceil((Date.parse(req.dueAt) - Date.parse(nowIso)) / DAY);
    if (daysLeft < 0) return { state: 'overdue', daysLeft };
    return { state: daysLeft <= s.dueSoonDays ? 'due_soon' : 'on_track', daysLeft };
}

function validateNewRequest(body, { onBehalf = false } = {}) {
    const errors = []; const b = body || {};
    if (!REQUEST_TYPES[b.type]) errors.push(`type must be one of: ${Object.keys(REQUEST_TYPES).join(', ')}`);
    const details = String(b.details || '').trim();
    if (details.length > 2000) errors.push('details must be 2000 characters or fewer');
    if (b.type === 'correct' && details.length < 5) errors.push('Say what is wrong and what it should be (details)');
    if (onBehalf) {
        if (!b.onBehalfOf) errors.push('onBehalfOf (the employee) is required');
        const v = b.verification || {};
        if (!['in_person', 'verified_call', 'employee_logged_in', 'documents_checked'].includes(v.method)) errors.push('verification.method must be in_person, verified_call, employee_logged_in or documents_checked');
        if (String(v.note || '').trim().length < 5) errors.push('verification.note must say how the identity was checked');
        if (b.receivedAt && !/^\d{4}-\d{2}-\d{2}/.test(String(b.receivedAt))) errors.push('receivedAt must be a date (YYYY-MM-DD)');
    }
    return { errors, value: errors.length ? null : { type: b.type, details } };
}

/** Only one extension, only while open and not yet late, with a reason */
function canExtend(req, nowIso, settings = DEFAULT_SETTINGS) {
    const s = { ...DEFAULT_SETTINGS, ...settings };
    if (!OPEN.includes(req.status)) return { ok: false, reason: 'This request is already closed' };
    if ((req.extensionsUsed || 0) >= s.maxExtensions || s.extensionDays <= 0) return { ok: false, reason: 'The extension for this request has already been used' };
    if (Date.parse(nowIso) > Date.parse(req.dueAt)) return { ok: false, reason: 'The deadline has passed; an extension must be given before it' };
    return { ok: true };
}

/* ------------------------------- retention / deletion plan ------------------------------- */

const yearsAfter = (iso, y) => { const d = parseIsoDate(String(iso).slice(0, 10)); return isoDate(new Date(Date.UTC(d.getUTCFullYear() + y, d.getUTCMonth(), d.getUTCDate()))); };
const maxIso = (list) => list.filter(Boolean).sort().slice(-1)[0] || null;

/**
 * Decides, per category, what a deletion request may remove today.
 * facts: { terminationDate|null, hireDate|null, legalHoldUser, counts: {...}, punches: [{date}], leave: [{date}], osha: [{date}], vault: [{id,retainUntil,legalHold,deletedAlready}], audit: [{date}], privacyRequests: [{date}] }
 * Returns { employmentActive, legalHold, rows[] } where each row has action: delete | retain | partial
 * with deleteCount, retainCount, retainUntil, reason, and executable ids for per-record categories.
 */
function planDeletion(facts, retention = DEFAULT_RETENTION, todayIso) {
    const rule = (k) => retention.find((r) => r.key === k) || DEFAULT_RETENTION.find((r) => r.key === k);
    const employmentActive = !facts.terminationDate;
    const hold = Boolean(facts.legalHoldUser) || (facts.vault || []).some((v) => v.legalHold && !v.deletedAlready);
    const rows = [];
    const retained = (key, label, count, until, reason) => rows.push({ key, label, action: 'retain', count, deleteCount: 0, retainCount: count, retainUntil: until, reason });
    const deleted = (key, label, count) => rows.push({ key, label, action: count ? 'delete' : 'none', count, deleteCount: count, retainCount: 0, retainUntil: null, reason: count ? 'No legal reason to keep it' : 'Nothing on file' });

    // Whole-category records that are kept while employed and for N years after employment ends
    const afterEmployment = (key, count, extra) => {
        const r = rule(key);
        if (!count) return rows.push({ key, label: r.label, action: 'none', count: 0, deleteCount: 0, retainCount: 0, retainUntil: null, reason: 'Nothing on file' });
        if (employmentActive) return retained(key, r.label, count, null, `Employment is ongoing; kept while employed and ${r.years} year(s) after (${r.basis})`);
        let until = yearsAfter(facts.terminationDate, r.years);
        if (key === 'i9' && facts.hireDate) until = maxIso([until, yearsAfter(facts.hireDate, r.i9HireYears || 3)]);
        if (until > todayIso || hold) return retained(key, r.label, count, until, `${r.basis}${hold ? '; a legal hold is active' : ''}`);
        rows.push({ key, label: r.label, action: 'delete', count, deleteCount: count, retainCount: 0, retainUntil: null, reason: `Retention period ended ${until}` });
    };

    // Per-record categories (each record carries its own date)
    const perRecord = (key, list) => {
        const r = rule(key); list = list || [];
        if (!list.length) return rows.push({ key, label: r.label, action: 'none', count: 0, deleteCount: 0, retainCount: 0, retainUntil: null, reason: 'Nothing on file' });
        const keep = []; const del = [];
        for (const rec of list) { const until = yearsAfter(rec.date, r.years); (until > todayIso || hold ? keep : del).push({ ...rec, until }); }
        const lastUntil = maxIso(keep.map((k) => k.until));
        rows.push({ key, label: r.label, action: keep.length === 0 ? 'delete' : (del.length === 0 ? 'retain' : 'partial'), count: list.length, deleteCount: del.length, retainCount: keep.length, retainUntil: lastUntil, deleteIds: del.map((d) => d.id).filter(Boolean), reason: keep.length ? `${r.basis}${hold ? '; a legal hold is active' : ''}` : `All records are past their ${r.years}-year retention` });
    };

    deleted('profile_optional', rule('profile_optional').label, facts.counts.optionalProfileFields || 0);
    deleted('consents', rule('consents').label, facts.counts.consents || 0);
    deleted('punch_photos', rule('punch_photos').label, facts.counts.punchPhotos || 0);
    afterEmployment('eeo_selfid', facts.counts.eeo || 0);
    perRecord('time_punches', facts.punches);
    perRecord('leave_requests', facts.leave);
    afterEmployment('payroll_forms', facts.counts.payrollForms || 0);
    afterEmployment('i9', facts.counts.i9 || 0);
    perRecord('osha_incidents', facts.osha);

    // Vault documents follow their own retention date and legal hold (same rule as vault-rules.deletionCheck)
    const vd = (facts.vault || []).filter((v) => !v.deletedAlready);
    if (!vd.length) rows.push({ key: 'vault_documents', label: rule('vault_documents').label, action: 'none', count: 0, deleteCount: 0, retainCount: 0, retainUntil: null, reason: 'Nothing on file' });
    else {
        const del = []; const keep = [];
        for (const v of vd) (v.legalHold ? keep : (v.retainUntil && v.retainUntil > todayIso ? keep : del)).push(v);
        rows.push({
            key: 'vault_documents', label: rule('vault_documents').label, action: keep.length === 0 ? 'delete' : (del.length === 0 ? 'retain' : 'partial'), count: vd.length, deleteCount: del.length, retainCount: keep.length,
            retainUntil: maxIso(keep.map((k) => (k.legalHold ? '9999-12-31' : k.retainUntil))), deleteIds: del.map((d) => d.id),
            reason: keep.some((k) => k.legalHold) ? 'Under a legal hold (kept until the hold is lifted)' : (keep.length ? "Kept until each document's retention date" : 'Retention periods have ended')
        });
    }

    perRecord('audit_logs', facts.audit);
    // The audit trail and request records are never deleted by a request: they prove what we did
    for (const k of ['audit_logs', 'privacy_requests']) { const row = rows.find((r) => r.key === k); if (row) { row.action = row.count ? 'retain' : 'none'; row.retainCount = row.count; row.deleteCount = 0; delete row.deleteIds; row.retainUntil = row.count ? 'ongoing' : null; row.reason = row.count ? rule(k).basis : 'Nothing on file'; } }
    const pr = rows.find((r) => r.key === 'privacy_requests');
    if (!pr) rows.push({ key: 'privacy_requests', label: rule('privacy_requests').label, action: (facts.privacyRequests || []).length ? 'retain' : 'none', count: (facts.privacyRequests || []).length, deleteCount: 0, retainCount: (facts.privacyRequests || []).length, retainUntil: (facts.privacyRequests || []).length ? 'ongoing' : null, reason: rule('privacy_requests').basis });

    // The account itself: removed (anonymized) only when nothing else has to be kept
    const keepers = rows.filter((r) => r.retainCount > 0 && r.key !== 'audit_logs' && r.key !== 'privacy_requests');
    const anyKeeper = keepers.length > 0 || employmentActive || hold;
    const acctUntil = maxIso(keepers.map((k) => (k.retainUntil === 'ongoing' ? null : k.retainUntil)));
    rows.push({
        key: 'account', label: rule('account').label, action: anyKeeper ? 'retain' : 'anonymize', count: 1, deleteCount: anyKeeper ? 0 : 1, retainCount: anyKeeper ? 1 : 0,
        retainUntil: anyKeeper ? (employmentActive ? null : acctUntil) : null,
        reason: employmentActive ? 'Employment is ongoing; the identity record is needed for payroll and legal compliance' : (hold ? 'A legal hold is active' : (anyKeeper ? 'Kept while other records above must be kept' : 'Nothing else needs it: the person will be anonymized and the login removed'))
    });
    return { employmentActive, legalHold: hold, anythingToDelete: rows.some((r) => r.deleteCount > 0), rows };
}

/* ------------------------------- access export ------------------------------- */

const SECRET_KEY = /encrypted|password|hash|secret|token|salt|mfa|keyhash/i;
const NUMBER_KEY = /^(number|documentNumber|accountNumber|routingNumber|ssn|taxpayerId|authorizationNumber|itin)$/i;
const maskLast4 = (v) => { const s = String(v == null ? '' : v).replace(/\s+/g, ''); return s.length > 4 ? `${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-4)}` : '****'; };

/** Removes secrets and masks account/ID numbers anywhere in a structure. Full SSN/bank numbers can never leave. */
function redact(v, depth = 0) {
    if (v === null || v === undefined || depth > 8) return v;
    if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
    if (typeof v !== 'object') return v;
    if (typeof v.toDate === 'function') return v.toDate().toISOString();
    const out = {};
    for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEY.test(k)) continue;
        if (NUMBER_KEY.test(k) && (typeof val === 'string' || typeof val === 'number')) { out[k] = maskLast4(val); continue; }
        out[k] = redact(val, depth + 1);
    }
    return out;
}

function eeoAnswered(rec) {
    if (!rec) return { submitted: false };
    const out = { submitted: true };
    for (const [k, v] of Object.entries(rec)) out[k] = Array.isArray(v) ? v.length > 0 : (v !== null && v !== '' && v !== undefined);
    return { ...out, note: 'Only whether each question was answered is shown, not the answers themselves.' };
}

/**
 * The access bundle. facts: { user, org, punches, leave, documents, consents, eeo, audit, requests, now, requestId }
 * Never includes: full taxpayer ID, full bank account/routing numbers, encrypted values, password data, EEO answers.
 */
function buildAccessBundle(facts) {
    const u = facts.user || {};
    const { usProfile = {}, usForms = {}, password, passwordHash, mfaSecret, ...rest } = u;
    const { taxpayerIdEncrypted, taxpayerIdLast4, ...profile } = usProfile;
    const forms = redact(usForms);
    return {
        generatedAt: facts.now, requestId: facts.requestId || null, format: 'kylrx-access-export-v1',
        subject: { id: u.id || null, employeeId: u.employeeId || null, name: u.name || null, email: u.email || null },
        profile: {
            account: redact({ role: rest.role, status: rest.status, department: rest.department, jobTitle: rest.jobTitle, phone: rest.phone, personalEmail: rest.personalEmail, startDate: rest.startDate || rest.joiningDate }),
            usProfile: redact(profile),
            taxpayerId: taxpayerIdLast4 ? { onFile: true, masked: `***-**-${taxpayerIdLast4}` } : { onFile: Boolean(taxpayerIdEncrypted) }
        },
        forms: { ...forms, note: 'Taxpayer ID, bank account and document numbers are masked to the last 4 digits.' },
        timePunches: (facts.punches || []).map((p) => redact({ at: p.at, type: p.type, source: p.source, note: p.note, location: p.location })),
        leave: (facts.leave || []).map((l) => redact({ type: l.type, from: l.from || l.startDate, to: l.to || l.endDate, hours: l.hours, status: l.status, requestedAt: l.createdAt || l.requestedAt })),
        documents: (facts.documents || []).map((d) => ({ title: d.confidential ? '(confidential document)' : d.title, category: d.category, uploadedAt: d.uploadedAt, retainUntil: d.retainUntil || null, expiresOn: d.expiresOn || null })),
        consents: (facts.consents || []).map((c) => redact(c)),
        eeo: eeoAnswered(facts.eeo),
        auditEntriesAboutYou: (facts.audit || []).map((a) => ({ at: a.at, action: a.action, byRole: a.actorRole || null })),
        privacyRequests: (facts.requests || []).map((r) => ({ id: r.id, type: r.type, status: r.status, receivedAt: r.receivedAt })),
        notIncluded: ['Full taxpayer ID and bank numbers (masked on purpose)', 'Passwords and security secrets', 'The actual EEO answers', 'File contents (the list of documents is included; ask HR for copies)', 'Information about other people']
    };
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kv = (o) => `<table>${Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `<tr><th>${esc(k)}</th><td>${typeof v === 'object' ? `<code>${esc(JSON.stringify(v))}</code>` : esc(v)}</td></tr>`).join('')}</table>`;
const list = (rows, cols) => rows.length ? `<table><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(typeof r[c] === 'object' ? JSON.stringify(r[c]) : r[c])}</td>`).join('')}</tr>`).join('')}</table>` : '<p class="m">None on file.</p>';

function renderBundleHtml(b, lang = 'en') {
    const es = lang === 'es';
    const T = es ? { h: 'Sus datos personales', gen: 'Generado', prof: 'Perfil', forms: 'Formularios', punches: 'Registros de tiempo', leave: 'Tiempo libre', docs: 'Documentos (lista)', cons: 'Consentimientos', eeo: 'Autoidentificación EEO', aud: 'Registros de auditoría sobre usted', req: 'Solicitudes de privacidad', not: 'No incluido' }
        : { h: 'Your personal data', gen: 'Generated', prof: 'Profile', forms: 'Forms', punches: 'Time punches', leave: 'Leave', docs: 'Documents (list only)', cons: 'Consents', eeo: 'EEO self-identification', aud: 'Audit entries about you', req: 'Privacy requests', not: 'Not included' };
    return `<!doctype html><html lang="${es ? 'es' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(T.h)}</title><style>
body{font:14px/1.5 system-ui,Segoe UI,sans-serif;color:#0f172a;max-width:860px;margin:24px auto;padding:0 16px}h1{margin:0}h2{margin:28px 0 8px;font-size:16px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}
table{border-collapse:collapse;width:100%;margin:6px 0}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top;font-size:13px}th{color:#64748b;font-weight:600;width:28%}.m{color:#64748b}code{font-size:12px;word-break:break-all}
</style></head><body><h1>${esc(T.h)}</h1><div class="m">${esc(b.subject.name || '')} &middot; ${esc(T.gen)} ${esc(b.generatedAt)}</div>
<h2>${esc(T.prof)}</h2>${kv({ ...b.profile.account, ...b.profile.usProfile, taxpayerId: b.profile.taxpayerId.masked || (b.profile.taxpayerId.onFile ? 'on file' : '') })}
<h2>${esc(T.forms)}</h2>${kv(Object.fromEntries(Object.entries(b.forms).map(([k, v]) => [k, v])))}
<h2>${esc(T.punches)}</h2>${list(b.timePunches, ['at', 'type', 'source', 'note'])}
<h2>${esc(T.leave)}</h2>${list(b.leave, ['type', 'from', 'to', 'hours', 'status'])}
<h2>${esc(T.docs)}</h2>${list(b.documents, ['title', 'category', 'uploadedAt', 'retainUntil'])}
<h2>${esc(T.cons)}</h2>${list(b.consents, Object.keys(b.consents[0] || { consent: 1 }))}
<h2>${esc(T.eeo)}</h2>${kv(b.eeo)}
<h2>${esc(T.aud)}</h2>${list(b.auditEntriesAboutYou, ['at', 'action', 'byRole'])}
<h2>${esc(T.req)}</h2>${list(b.privacyRequests, ['id', 'type', 'status', 'receivedAt'])}
<h2>${esc(T.not)}</h2><ul>${b.notIncluded.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></body></html>`;
}

module.exports = { REQUEST_TYPES, STATUSES, OPEN, DEFAULT_SETTINGS, DEFAULT_RETENTION, validateSettings, deadlines, businessDaysAfter, slaStatus, validateNewRequest, canExtend, planDeletion, redact, maskLast4, buildAccessBundle, renderBundleHtml, yearsAfter };
