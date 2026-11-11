/**
 * Document vault rules (pure). Categories, upload checks, who may see a document and when one
 * may be deleted. Retention years are SUGGESTIONS: confirm them for your state with an advisor.
 */
const { parseIsoDate, isoDate } = require('./us-forms');

const MAX_BYTES = 10 * 1024 * 1024;

const CATEGORIES = [
    { key: 'offer_letter', label: 'Offer letter', scope: 'employee', retentionYears: 4 },
    { key: 'signed_policy', label: 'Signed policy or acknowledgement', scope: 'employee', retentionYears: 4 },
    { key: 'certification', label: 'Certification or license', scope: 'employee', retentionYears: null, tracksExpiry: true },
    { key: 'performance', label: 'Performance review', scope: 'employee', retentionYears: 4 },
    { key: 'disciplinary', label: 'Disciplinary record', scope: 'employee', retentionYears: 4 },
    { key: 'leave_paperwork', label: 'Leave paperwork', scope: 'employee', retentionYears: 4 },
    { key: 'payroll_record', label: 'Payroll record', scope: 'employee', retentionYears: 4 },
    { key: 'medical_confidential', label: 'Medical or confidential', scope: 'employee', retentionYears: 4, confidential: true },
    { key: 'employee_other', label: 'Other (employee)', scope: 'employee', retentionYears: 4 },
    { key: 'handbook', label: 'Employee handbook', scope: 'company', retentionYears: null },
    { key: 'insurance', label: 'Insurance certificate', scope: 'company', retentionYears: null, tracksExpiry: true },
    { key: 'business_license', label: 'Business license or permit', scope: 'company', retentionYears: null, tracksExpiry: true },
    { key: 'poster_proof', label: 'Poster or notice record', scope: 'company', retentionYears: 3 },
    { key: 'osha_filing', label: 'OSHA filing (300, 300A, 301)', scope: 'company', retentionYears: 5 },
    { key: 'eeo_filing', label: 'EEO-1 filing', scope: 'company', retentionYears: 5 },
    { key: 'contract', label: 'Contract or agreement', scope: 'company', retentionYears: 7 },
    { key: 'company_other', label: 'Other (company)', scope: 'company', retentionYears: 4 }
];

const categoryOf = (key) => CATEGORIES.find((c) => c.key === key) || null;

const ALLOWED_TYPES = {
    'application/pdf': ['pdf'], 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'], 'text/plain': ['txt']
};

/** What the first bytes say the file really is (never trust the name or the browser's type) */
function sniffType(buf) {
    if (!buf || buf.length < 4) return null;
    if (buf.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
    if ((buf[0] === 0x4d && buf[1] === 0x5a) || buf.slice(0, 4).toString('latin1') === '\x7fELF' || buf.slice(0, 2).toString('latin1') === '#!') return 'executable';
    const head = buf.slice(0, 512);
    if (!head.includes(0) && /^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(head.toString('utf8'))) return 'text/plain';
    return null;
}

const safeFileName = (name) => String(name || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'file';

function validateUpload(meta, file) {
    const errors = [];
    const m = meta || {};
    const cat = categoryOf(m.category);
    if (!cat) errors.push('category is not valid');
    if (!['company', 'employee'].includes(m.scope)) errors.push('scope must be company or employee');
    else if (cat && cat.scope !== m.scope) errors.push(`${cat.label} belongs to ${cat.scope} documents`);
    if (m.scope === 'employee' && !m.userId) errors.push('Choose the employee this document is for');
    const title = String(m.title || '').trim();
    if (!title) errors.push('title is required');
    if (m.expiresOn && !parseIsoDate(m.expiresOn)) errors.push('expiresOn must be YYYY-MM-DD');

    if (!file || !file.buffer || file.buffer.length === 0) errors.push('A file is required');
    else {
        if (file.buffer.length > MAX_BYTES) errors.push('The file is larger than 10 MB');
        const real = sniffType(file.buffer);
        const ext = String(file.originalname || '').split('.').pop().toLowerCase();
        if (real === 'executable' || real === null) errors.push('That file type is not allowed (PDF, image, Word, Excel or text only)');
        else {
            const allowedExt = real === 'zip' ? ['docx', 'xlsx'] : (ALLOWED_TYPES[real] || []);
            if (!allowedExt.includes(ext)) errors.push(`The file name ends in .${ext} but the content looks like ${real === 'zip' ? 'an Office file' : real}`);
        }
    }
    return {
        errors,
        value: errors.length ? null : {
            scope: m.scope, category: m.category, title: title.slice(0, 120), userId: m.userId || null, expiresOn: m.expiresOn || null,
            shared: m.shared === true && !(cat && cat.confidential), confidential: Boolean(cat && cat.confidential),
            mime: sniffType(file.buffer) === 'zip' ? (String(file.originalname).toLowerCase().endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') : sniffType(file.buffer),
            fileName: safeFileName(file.originalname)
        }
    };
}

function addYears(iso, n) {
    const d = parseIsoDate(iso);
    return isoDate(new Date(Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate())));
}

/** Keep-until date from the category's suggested retention */
function retainUntil(category, uploadedIso) {
    const c = categoryOf(category);
    return c && c.retentionYears ? addYears(uploadedIso.slice(0, 10), c.retentionYears) : null;
}

const normRole = (r) => String(r || '').toLowerCase().replace(/[\s_-]+/g, '');
const HR = ['superadmin', 'admin', 'hradmin', 'hrms', 'hrpayroll'];
const CONFIDENTIAL_VIEWERS = ['superadmin', 'hradmin'];

/** May this user see (and download) this document? */
function canView(doc, user) {
    if (doc.deleted) return false;
    const role = normRole(user.role);
    if (doc.confidential) return CONFIDENTIAL_VIEWERS.includes(role);
    if (HR.includes(role)) return true;
    if (!doc.shared) return false;
    return doc.scope === 'company' || doc.userId === user.id;
}

/** A document may be deleted when its retention has passed and no legal hold is on it */
function deletionCheck(doc, todayIso) {
    if (doc.legalHold) return { ok: false, reason: 'This document is under a legal hold' };
    if (doc.retainUntil && doc.retainUntil > todayIso) return { ok: false, reason: `Keep this document until ${doc.retainUntil}` };
    return { ok: true };
}

function daysUntil(iso, todayIso) {
    return Math.round((parseIsoDate(iso) - parseIsoDate(todayIso)) / 86400000);
}

module.exports = { MAX_BYTES, CATEGORIES, categoryOf, ALLOWED_TYPES, sniffType, safeFileName, validateUpload, retainUntil, canView, deletionCheck, daysUntil };
