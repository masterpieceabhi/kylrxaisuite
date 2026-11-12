/**
 * Document templates and electronic signature rules (pure, no I/O except crypto randomness).
 * Merge-field rendering with HTML escaping, single-use signing tokens (only a hash is stored),
 * signing validation, request states, reminders and the completion certificate.
 * E-signature law (ESIGN/UETA) and document wording should be confirmed with counsel.
 */
const crypto = require('crypto');

const TEMPLATE_TYPES = [
    { key: 'offer_letter', label: 'Offer letter', vaultCategory: 'offer_letter' },
    { key: 'handbook_ack', label: 'Handbook acknowledgement', vaultCategory: 'signed_policy' },
    { key: 'nda', label: 'Non-disclosure agreement', vaultCategory: 'signed_policy' },
    { key: 'policy_ack', label: 'Policy acknowledgement', vaultCategory: 'signed_policy' },
    { key: 'direct_deposit', label: 'Direct-deposit authorization', vaultCategory: 'signed_policy' },
    { key: 'custom', label: 'Custom document', vaultCategory: 'signed_policy' }
];
const typeOf = (k) => TEMPLATE_TYPES.find((t) => t.key === k) || null;

const MERGE_FIELDS = [
    'first_name', 'last_name', 'full_name', 'email', 'job_title', 'department', 'start_date', 'pay_rate', 'pay_unit', 'work_state',
    'company_name', 'manager_name', 'today', 'policy_name', 'custom_1', 'custom_2'
];

const STATUSES = ['pending', 'viewed', 'signed', 'declined', 'voided', 'expired', 'locked'];
const OPEN_STATUSES = ['pending', 'viewed'];
const DEFAULT_EXPIRY_DAYS = 14;
const DEFAULT_MAX_ATTEMPTS = 5;
const MAX_SIGNATURE_BYTES = 300 * 1024;

const CONSENT_TEXT = {
    en: 'I agree to use electronic records and signatures. I understand that my typed name and drawn signature below are legally binding in the same way as a handwritten signature, that I can ask for a paper copy, and that I can withdraw this consent before signing by closing this page. I have the ability to view this document on my device.',
    es: 'Acepto usar registros y firmas electronicos. Entiendo que mi nombre escrito y mi firma dibujada abajo tienen la misma validez legal que una firma manuscrita, que puedo pedir una copia en papel y que puedo retirar este consentimiento antes de firmar cerrando esta pagina. Puedo ver este documento en mi dispositivo.'
};

const escapeHtml = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const FIELD_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function extractFields(body) {
    const out = new Set();
    String(body || '').replace(FIELD_RE, (_, f) => { out.add(f); return ''; });
    return [...out];
}

/**
 * Renders a template body. values: { field: string }. Everything is escaped; line breaks become <br>.
 * Returns { html, text, unknown (not a known merge field), missing (known but no value) }.
 */
function renderTemplate(body, values) {
    const vals = values || {};
    const unknown = []; const missing = [];
    const fill = (src, esc) => String(src || '').replace(FIELD_RE, (_, f) => {
        if (!MERGE_FIELDS.includes(f)) { if (!unknown.includes(f)) unknown.push(f); return esc ? `<mark>{{${escapeHtml(f)}}}</mark>` : `{{${f}}}`; }
        const v = vals[f];
        if (v === undefined || v === null || String(v).trim() === '') { if (!missing.includes(f)) missing.push(f); return esc ? `<mark>[${escapeHtml(f)}]</mark>` : `[${f}]`; }
        return esc ? escapeHtml(v) : String(v);
    });
    // escape literal text first (so template authors cannot inject HTML), then fill the fields
    const escapedSource = String(body || '').split(FIELD_RE).map((part, i) => (i % 2 === 0 ? escapeHtml(part) : `{{${part}}}`)).join('');
    const html = fill(escapedSource, true).replace(/\r?\n/g, '<br>\n');
    const text = fill(body, false);
    return { html, text, unknown, missing };
}

function validateTemplate(input) {
    const errors = [];
    const b = input || {};
    const name = String(b.name || '').replace(/[<>]/g, '').trim().slice(0, 100);
    if (!name) errors.push('name is required');
    if (!typeOf(b.type)) errors.push(`type must be one of: ${TEMPLATE_TYPES.map((t) => t.key).join(', ')}`);
    const body = String(b.body || '').replace(/\u0000/g, '').slice(0, 30000);
    if (body.trim().length < 20) errors.push('body must have at least 20 characters');
    if (errors.length) return { errors, value: null, warnings: [] };
    const unknown = extractFields(body).filter((f) => !MERGE_FIELDS.includes(f));
    return { errors, value: { name, type: b.type, body, language: b.language === 'es' ? 'es' : 'en' }, warnings: unknown.map((f) => `Unknown merge field {{${f}}} will be flagged and block sending`) };
}

const sha256 = (s) => crypto.createHash('sha256').update(typeof s === 'string' ? s : Buffer.from(s)).digest('hex');

/** One-time token: 256 random bits. Only the hash is ever stored. */
function generateToken() {
    const token = 'sg_' + crypto.randomBytes(32).toString('base64url');
    return { token, hash: sha256(token) };
}
const TOKEN_SHAPE = /^sg_[A-Za-z0-9_-]{43}$/;
const isTokenShape = (t) => TOKEN_SHAPE.test(String(t || ''));

function clampExpiryDays(d) {
    const n = Number(d);
    if (!Number.isFinite(n)) return DEFAULT_EXPIRY_DAYS;
    return Math.min(90, Math.max(1, Math.round(n)));
}
const clampAttempts = (a) => { const n = Number(a); return Number.isFinite(n) ? Math.min(10, Math.max(1, Math.round(n))) : DEFAULT_MAX_ATTEMPTS; };
const expiresAtFor = (nowIso, days) => new Date(Date.parse(nowIso) + clampExpiryDays(days) * 86400000).toISOString();

/** The state a request is really in right now (an open request past its expiry is expired) */
function effectiveStatus(req, nowIso) {
    if (OPEN_STATUSES.includes(req.status) && req.expiresAt && Date.parse(req.expiresAt) <= Date.parse(nowIso)) return 'expired';
    return req.status;
}

function canSign(req, nowIso) {
    const st = effectiveStatus(req, nowIso);
    if (st === 'signed') return { ok: false, code: 'signed', reason: 'This document has already been signed' };
    if (st === 'declined') return { ok: false, code: 'declined', reason: 'This document was declined' };
    if (st === 'voided') return { ok: false, code: 'voided', reason: 'This request was cancelled' };
    if (st === 'expired') return { ok: false, code: 'expired', reason: 'This link has expired. Ask the sender for a new one' };
    if (st === 'locked' || (req.attempts || 0) >= (req.maxAttempts || DEFAULT_MAX_ATTEMPTS)) return { ok: false, code: 'locked', reason: 'Too many attempts. Ask the sender for a new link' };
    return { ok: true };
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-zÀ-ɏ ]/g, '').replace(/\s+/g, ' ').trim();

/** Checks typed name, drawn signature (PNG data URL) and consent. */
function validateSignature(input, signerName) {
    const errors = [];
    const b = input || {};
    if (b.consent !== true) errors.push('You must agree to use electronic records and signatures');
    const typed = String(b.typedName || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (typed.length < 2) errors.push('Type your full name');
    else if (signerName && normName(typed) !== normName(signerName)) errors.push('The typed name must match the name this document was sent to');
    let png = null;
    const data = String(b.signatureData || '');
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(data);
    if (!m) errors.push('Draw your signature');
    else {
        const buf = Buffer.from(m[1], 'base64');
        if (buf.length > MAX_SIGNATURE_BYTES) errors.push('The signature image is too large');
        else if (buf.length < 100 || buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') errors.push('The signature image is not valid');
        else png = data;
    }
    return { errors, value: errors.length ? null : { typedName: typed, signatureData: png } };
}

/** Reminder worklist: open requests not reminded in `everyDays`, and requests expiring within `soonDays` */
function remindersDue(requests, nowIso, { everyDays = 3, soonDays = 3 } = {}) {
    const now = Date.parse(nowIso);
    return requests.filter((r) => OPEN_STATUSES.includes(effectiveStatus(r, nowIso))).map((r) => {
        const last = (r.reminders || []).length ? Date.parse(r.reminders[r.reminders.length - 1].at) : Date.parse(r.sentAt || r.createdAt);
        const daysSince = Math.floor((now - last) / 86400000);
        const daysLeft = Math.ceil((Date.parse(r.expiresAt) - now) / 86400000);
        return { id: r.id, signerName: r.signerName, templateName: r.templateName, signerType: r.signerType, daysSinceContact: daysSince, daysLeft, expiringSoon: daysLeft <= soonDays, due: daysSince >= everyDays || daysLeft <= soonDays };
    }).filter((r) => r.due).sort((a, b) => a.daysLeft - b.daysLeft);
}

/** Completion certificate (a self-contained, printable HTML page) */
function buildCertificate(info) {
    const rows = [
        ['Document', info.templateName], ['Signer', info.signerName], ['Signer email', info.signerEmail || 'not recorded'], ['Signed at (UTC)', info.signedAt],
        ['IP address', info.ip || 'unknown'], ['Device (user agent)', info.userAgent || 'unknown'], ['Document SHA-256', info.documentHash],
        ['Request reference', info.requestId], ['Company', info.companyName || '']
    ];
    const audit = (info.history || []).map((h) => `<tr><td>${escapeHtml(h.at)}</td><td>${escapeHtml(h.event)}</td><td>${escapeHtml(h.ip || '')}</td></tr>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Certificate of completion</title>
<style>body{font:14px/1.5 Georgia,serif;max-width:780px;margin:24px auto;padding:0 16px;color:#111}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin:10px 0}td,th{border:1px solid #bbb;padding:6px 8px;text-align:left;vertical-align:top;word-break:break-all}.doc{border:1px solid #bbb;padding:14px;margin:14px 0}.sig{max-height:110px;border-bottom:1px solid #111}</style></head><body>
<h1>Certificate of completion</h1><p>This certificate records the electronic signature of the document below.</p>
<table>${rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</table>
<p><b>Consent:</b> ${escapeHtml(info.consentText)}</p>
<p><b>Typed name:</b> ${escapeHtml(info.typedName)}</p><p><img class="sig" alt="Drawn signature" src="${escapeHtml(info.signatureData)}"></p>
<h2>Document as signed</h2><div class="doc">${info.renderedHtml}</div>
<h2>Audit trail</h2><table><tr><th>When (UTC)</th><th>Event</th><th>IP</th></tr>${audit}</table>
<p style="font-size:12px;color:#555">The SHA-256 above is the hash of the exact document text shown to the signer. Any change to the document changes the hash.</p></body></html>`;
}

/** Starter library. These are generic drafts: have counsel review them before use. */
const DEFAULT_TEMPLATES = [
    { name: 'Offer letter', type: 'offer_letter', body: 'Dear {{first_name}},\n\n{{company_name}} is pleased to offer you the position of {{job_title}}, starting on {{start_date}}. Your pay will be {{pay_rate}} per {{pay_unit}}, paid according to our regular payroll schedule and subject to required withholdings.\n\nYour employment is at will, which means that either you or the company may end it at any time, with or without cause or notice. This offer depends on completing the required employment eligibility verification and any background check you have authorized.\n\nPlease sign below to accept.\n\nSincerely,\n{{company_name}}' },
    { name: 'Handbook acknowledgement', type: 'handbook_ack', body: 'I, {{full_name}}, confirm that I received the {{company_name}} employee handbook on {{today}}, that I have had the chance to read it and ask questions, and that I understand I am responsible for following its policies. I understand the handbook is not a contract of employment and that the company may update it.' },
    { name: 'Non-disclosure agreement', type: 'nda', body: 'This agreement is between {{company_name}} and {{full_name}}.\n\n1. Confidential information means non-public business, customer, financial and technical information that I learn through my work.\n2. I will use it only to do my job and will not share it with anyone outside the company without written permission.\n3. These duties continue after my work ends. They do not stop me from reporting unlawful conduct to a government agency or from discussing my own pay and working conditions where the law protects that.\n\nSigned on {{today}}.' },
    { name: 'Policy acknowledgement', type: 'policy_ack', body: 'I, {{full_name}}, confirm that I received and read the policy named "{{policy_name}}" on {{today}} and that I understand it. I will ask my manager or HR if I have questions.' },
    { name: 'Direct-deposit authorization', type: 'direct_deposit', body: 'I, {{full_name}}, authorize {{company_name}} to deposit my pay by direct deposit into the account I have provided through the secure employee portal. I can change or cancel this authorization at any time by telling HR. Bank details are NOT written on this page; they stay in the secure portal.' }
];

module.exports = {
    TEMPLATE_TYPES, typeOf, MERGE_FIELDS, STATUSES, OPEN_STATUSES, DEFAULT_EXPIRY_DAYS, DEFAULT_MAX_ATTEMPTS, CONSENT_TEXT, DEFAULT_TEMPLATES,
    escapeHtml, extractFields, renderTemplate, validateTemplate, sha256, generateToken, isTokenShape, clampExpiryDays, clampAttempts, expiresAtFor,
    effectiveStatus, canSign, validateSignature, remindersDue, buildCertificate
};
