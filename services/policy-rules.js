/**
 * Company policy library with versions, for US companies (pure, no I/O).
 *
 * HR writes a policy as a draft and publishes it. Each publish makes a new numbered version and keeps the old ones.
 * A policy can ask people to acknowledge it. A new version asks everyone again, unless it is published as a
 * small fix, in which case earlier acknowledgements still count.
 * The system supplies no policy text and makes no claim that a policy is lawful.
 */
const { parseIsoDate } = require('./us-forms');

const CATEGORIES = ['Code of conduct', 'Attendance and time off', 'Pay and timekeeping', 'Safety', 'Anti-harassment and equal opportunity', 'Technology and data', 'Benefits', 'Other'];
const STATUSES = ['draft', 'published', 'archived'];
const BODY_MIN = 20;
const BODY_MAX = 20000;
const VERSIONS_MAX = 100;
const NOTE = 'These are your company\'s own policies; this system does not supply policy text. Have an employment attorney review your handbook, because state and city rules differ. An acknowledgement shows that a person received and read a policy. It does not make a policy lawful, and it is not agreement to a contract.';

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);

/** The draft of a policy (partial: only the fields that were sent) */
function validatePolicy(input, { partial = false } = {}) {
    const errors = []; const b = input || {}; const value = {};
    if (!partial || b.title !== undefined) { const t = clean(b.title, 150); if (t.length < 3) errors.push('Give the policy a title (at least 3 characters)'); else value.title = t; }
    if (!partial || b.category !== undefined) { if (!CATEGORIES.includes(b.category)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}`); else value.category = b.category; }
    if (!partial || b.body !== undefined) {
        const raw = String(b.body === undefined || b.body === null ? '' : b.body);
        if (raw.length > BODY_MAX) errors.push(`The policy text is too long (${raw.length} characters; the most is ${BODY_MAX}). Split it into two policies.`);
        else { const body = block(raw, BODY_MAX); if (body.length < BODY_MIN) errors.push(`Write the policy text (at least ${BODY_MIN} characters)`); else value.body = body; }
    }
    if (b.effectiveDate !== undefined) { if (b.effectiveDate === '' || b.effectiveDate === null) value.effectiveDate = null; else if (!parseIsoDate(b.effectiveDate)) errors.push('effectiveDate must be a real date (YYYY-MM-DD)'); else value.effectiveDate = String(b.effectiveDate); }
    if (b.requireAck !== undefined) value.requireAck = Boolean(b.requireAck);
    if (b.changeNote !== undefined) value.changeNote = clean(b.changeNote, 300);
    if (partial && !errors.length && !Object.keys(value).length) errors.push('Nothing to change');
    return { errors, value: errors.length ? null : value };
}

/** The version people see now, or null if the policy was never published */
const currentVersion = (policy) => ((policy.versions || []).length ? policy.versions[policy.versions.length - 1] : null);

/** Does the draft differ from what is published? */
function hasUnpublishedChanges(policy) {
    const cur = currentVersion(policy); const d = policy.draft || {};
    if (!cur) return true;
    return (d.title || '') !== (cur.title || '') || (d.category || '') !== (cur.category || '') || (d.body || '') !== (cur.body || '') || (d.effectiveDate || null) !== (cur.effectiveDate || null) || Boolean(d.requireAck) !== Boolean(cur.requireAck);
}

/** May this be done now? Returns null when allowed, or the reason it is not. */
function changeError(policy, action, { minor = false } = {}) {
    const cur = currentVersion(policy);
    if (action === 'edit') return policy.status === 'archived' ? 'Bring this policy back before changing it' : null;
    if (action === 'publish') {
        if (policy.status === 'archived') return 'Bring this policy back before publishing it';
        if (!policy.draft || String(policy.draft.body || '').length < BODY_MIN) return `Write the policy text first (at least ${BODY_MIN} characters)`;
        if (cur && !hasUnpublishedChanges(policy)) return 'Nothing has changed since the last published version';
        if (minor && !cur) return 'The first version cannot be a small fix';
        if (minor && !cur.requireAck && policy.draft.requireAck) return 'This version starts asking people to acknowledge, so it cannot be a small fix';
        return null;
    }
    if (action === 'archive') return policy.status === 'published' ? null : policy.status === 'archived' ? 'This policy is already archived' : 'A draft that was never published can be deleted instead';
    if (action === 'restore') return policy.status === 'archived' ? null : 'Only an archived policy can be brought back';
    if (action === 'delete') return cur ? 'A policy that was published cannot be deleted, so its versions and acknowledgements are kept. Archive it instead.' : null;
    if (action === 'acknowledge') return policy.status !== 'published' || !cur ? 'This policy is not published' : cur.requireAck ? null : 'This policy does not ask for an acknowledgement';
    return `Unknown action: ${action}`;
}

/**
 * The next version made from the draft. minor: a small fix, so acknowledgements of the version before still count.
 * ackFrom is the oldest version whose acknowledgement still counts for this one.
 */
function nextVersion(policy, { at, by, minor = false } = {}) {
    const cur = currentVersion(policy); const d = policy.draft;
    const version = (cur ? cur.version : 0) + 1;
    return { version, title: d.title, category: d.category, body: d.body, effectiveDate: d.effectiveDate || null, requireAck: Boolean(d.requireAck), changeNote: d.changeNote || '', minor: Boolean(minor && cur),
        ackFrom: minor && cur ? cur.ackFrom || cur.version : version, publishedAt: at, publishedByName: by || null };
}
const addVersion = (policy, v) => [...(policy.versions || []), v].slice(-VERSIONS_MAX);

/** Has this person acknowledged the current version (or an earlier one that still counts)? ackedVersions: numbers */
function ackState(policy, ackedVersions) {
    const cur = currentVersion(policy);
    if (!cur || policy.status !== 'published' || !cur.requireAck) return { needed: false, done: false, version: null };
    const from = cur.ackFrom || cur.version;
    const counted = (ackedVersions || []).filter((v) => v >= from && v <= cur.version);
    return { needed: counted.length === 0, done: counted.length > 0, version: counted.length ? Math.max(...counted) : null };
}

/** Who has and has not acknowledged. people: [{ id, name, employeeId }], acks: [{ userId, version, at }] */
function ackReport(policy, people, acks) {
    const cur = currentVersion(policy);
    if (!cur || !cur.requireAck) return { asked: false, total: people.length, done: 0, waiting: 0, rows: [] };
    const from = cur.ackFrom || cur.version;
    const best = new Map();
    for (const a of acks) { if (a.version < from || a.version > cur.version) continue; const have = best.get(a.userId); if (!have || a.version > have.version) best.set(a.userId, a); }
    const rows = people.map((p) => { const a = best.get(p.id); return { userId: p.id, name: p.name, employeeId: p.employeeId || null, done: Boolean(a), version: a ? a.version : null, at: a ? a.at : null }; })
        .sort((x, y) => Number(x.done) - Number(y.done) || String(x.name).localeCompare(String(y.name)));
    const done = rows.filter((r) => r.done).length;
    return { asked: true, total: rows.length, done, waiting: rows.length - done, rows };
}

/** What an employee reads: the published version only, never the draft */
function employeeView(policy, { withBody = true } = {}) {
    const cur = currentVersion(policy);
    if (!cur || policy.status !== 'published') return null;
    return { id: policy.id, title: cur.title, category: cur.category, version: cur.version, effectiveDate: cur.effectiveDate || null, publishedAt: cur.publishedAt, requireAck: cur.requireAck, changeNote: cur.version > 1 ? cur.changeNote || '' : '', ...(withBody ? { body: cur.body } : {}) };
}

module.exports = { CATEGORIES, STATUSES, BODY_MIN, BODY_MAX, VERSIONS_MAX, NOTE, validatePolicy, currentVersion, hasUnpublishedChanges, changeError, nextVersion, addVersion, ackState, ackReport, employeeView, clean, block };
