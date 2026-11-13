/**
 * Notice texts: storage for the rules in notice-template-rules.js.
 *   notice_templates   doc `${orgId}::${key}`          the company's own copy of a starter, or its own template
 *   notice_templates   doc `${orgId}::-defaults`       the company's standard fill-ins (who to contact, plan name)
 *   notice_attachments doc `${orgId}::${postingKey}`   which template is attached to a tracked workplace notice
 * Every document has orgId and every read checks it.
 */
const { rawCollection } = require('../config/firebase');
const R = require('./notice-template-rules');
const posters = require('./postings-rules');

const exists = (snap) => (typeof snap.exists === 'function' ? snap.exists() : snap.exists);
const nowIso = () => new Date().toISOString();
// "::" cannot appear in a template key or a notice key, so two companies can never land on the same document id
const tplRef = (orgId, key) => rawCollection('notice_templates').doc(`${orgId}::${key}`);
const defaultsRef = (orgId) => rawCollection('notice_templates').doc(`${orgId}::-defaults`);
const attRef = (orgId, postingKey) => rawCollection('notice_attachments').doc(`${orgId}::${postingKey}`);

const isPostingKey = (key) => posters.FEDERAL.some((f) => f.key === key) || /^state_[A-Z]{2}$/.test(String(key));

async function stored(orgId, key) {
    if (!R.validKey(key)) return null;
    const s = await tplRef(orgId, key).get();
    return exists(s) && s.data().orgId === orgId && s.data().kind !== 'defaults' ? s.data() : null;
}

async function getDefaults(orgId) {
    const s = await defaultsRef(orgId).get();
    const d = exists(s) && s.data().orgId === orgId ? s.data().values || {} : {};
    return Object.fromEntries(R.DEFAULT_KEYS.map((k) => [k, d[k] || '']));
}

async function saveDefaults(orgId, input, actor) {
    const { errors, value } = R.validateDefaults(input);
    if (errors.length) return { errors };
    const values = { ...(await getDefaults(orgId)), ...value };
    await defaultsRef(orgId).set({ orgId, kind: 'defaults', values, updatedAt: nowIso(), updatedBy: actor || null });
    return { defaults: values };
}

async function attachments(orgId) {
    const snap = await rawCollection('notice_attachments').where('orgId', '==', orgId).get();
    return Object.fromEntries(snap.docs.map((d) => [d.data().postingKey, { templateKey: d.data().templateKey, attachedAt: d.data().attachedAt }]));
}

/** The whole library for a company: its own templates plus the starters it has not touched */
async function list(orgId) {
    const [snap, att, defaults] = await Promise.all([rawCollection('notice_templates').where('orgId', '==', orgId).get(), attachments(orgId), getDefaults(orgId)]);
    const mine = new Map(snap.docs.map((d) => d.data()).filter((d) => d.kind !== 'defaults' && d.key).map((d) => [d.key, d]));
    const usedBy = (key) => Object.entries(att).filter(([, a]) => a.templateKey === key).map(([postingKey]) => postingKey).sort();
    const rows = [
        ...R.STARTERS.map((s) => R.summary(R.effective(s.key, mine.get(s.key)), usedBy(s.key))),
        ...[...mine.values()].filter((d) => !R.STARTER_KEYS.includes(d.key)).sort((a, b) => a.title.localeCompare(b.title)).map((d) => R.summary(R.effective(d.key, d), usedBy(d.key)))
    ];
    return { data: rows, attachments: att, defaults };
}

/** One template with its text and version list. null when the key is unknown for this company. */
async function get(orgId, key) {
    const t = R.effective(key, await stored(orgId, key));
    if (!t) return null;
    const s = R.starter(key);
    return {
        ...R.summary(t), body: t.body, changeNote: t.changeNote || null,
        versions: [...(t.history || []).map((h) => ({ version: h.version, title: h.title, savedAt: h.savedAt, changeNote: h.changeNote || null, reviewed: Boolean(h.reviewed) })), ...(t.version > 0 ? [{ version: t.version, title: t.title, savedAt: t.updatedAt, changeNote: t.changeNote || null, reviewed: !t.draft, current: true }] : [])].reverse(),
        starterText: s && t.version > 0 ? { title: s.title, body: s.body } : null
    };
}

/** Create or update. Returns { template, changed } | { errors } | { notFound } */
async function save(orgId, key, input, actor) {
    if (!R.validKey(key)) return { errors: ['the template key is not valid'] };
    const current = await stored(orgId, key);
    if (!current && !R.starter(key) && !String(key).startsWith('custom_')) return { notFound: true };
    const { errors, value } = R.validateTemplate(input);
    if (errors.length) return { errors };
    const next = R.nextVersion(current, value, { key, orgId, actor, now: nowIso() });
    if (next.changed) await tplRef(orgId, key).set(next.doc);
    return { template: await get(orgId, key), changed: next.changed };
}

/** A company's own new template. Returns { template, key } | { errors } */
async function create(orgId, input, actor) {
    const { errors, value } = R.validateTemplate(input);
    if (errors.length) return { errors };
    const snap = await rawCollection('notice_templates').where('orgId', '==', orgId).get();
    const key = R.keyFromTitle(value.title, snap.docs.map((d) => d.data().key).filter(Boolean));
    await tplRef(orgId, key).set(R.nextVersion(null, value, { key, orgId, actor, now: nowIso() }).doc);
    return { key, template: await get(orgId, key) };
}

/** Records that an advisor reviewed the current version. Returns { template } | { errors } | { notFound } | { conflict } */
async function markReviewed(orgId, key, input, actor, todayIso) {
    const current = await stored(orgId, key);
    if (!current) return R.starter(key) ? { conflict: 'Save your own copy of this starting draft first. Then record the review of that copy.' } : { notFound: true };
    const { errors, value } = R.validateReview(input, todayIso);
    if (errors.length) return { errors };
    await tplRef(orgId, key).update({ reviewed: { version: current.version, ...value, recordedBy: actor || null, recordedAt: nowIso() } });
    return { template: await get(orgId, key) };
}

/** Brings an older version back as a new version (never reviewed). Returns { template } | { notFound } | { errors } */
async function restoreVersion(orgId, key, version, actor) {
    const current = await stored(orgId, key);
    if (!current) return { notFound: true };
    const old = (current.history || []).find((h) => h.version === Number(version));
    if (!old) return { errors: [`version ${version} is not in the history of this template`] };
    const next = R.nextVersion(current, { title: old.title, body: old.body, changeNote: `Back to version ${old.version}` }, { key, orgId, actor, now: nowIso() });
    if (next.changed) await tplRef(orgId, key).set(next.doc);
    return { template: await get(orgId, key) };
}

/** Removes the company's copy: a starter goes back to its starting draft, a company template is gone. { ok } | { notFound } | { conflict } */
async function remove(orgId, key) {
    const current = await stored(orgId, key);
    if (!current) return { notFound: true };
    const att = await attachments(orgId);
    if (!R.starter(key) && Object.values(att).some((a) => a.templateKey === key)) return { conflict: 'This text is attached to a workplace notice. Detach it first.' };
    await tplRef(orgId, key).delete();
    return { ok: true, revertedToStarter: Boolean(R.starter(key)) };
}

/** The notice with the fill-ins filled. person: { name } or null. Returns { title, text, missing, draft, version } | { notFound } */
async function renderFor(orgId, key, { companyName, person, today, extra } = {}) {
    const t = R.effective(key, await stored(orgId, key));
    if (!t) return { notFound: true };
    const values = R.mergeValues({ companyName, personName: person && person.name, today, defaults: await getDefaults(orgId), extra });
    return { ...R.render(t, values), version: t.version, key };
}

/** Attach a template to a tracked workplace notice, or detach with templateKey null. { ok } | { notFound: 'posting'|'template' } */
async function attach(orgId, postingKey, templateKey, actor) {
    if (!isPostingKey(postingKey)) return { notFound: 'posting' };
    if (templateKey === null || templateKey === undefined || templateKey === '') { await attRef(orgId, postingKey).delete(); return { ok: true, attached: null }; }
    if (!R.effective(templateKey, await stored(orgId, templateKey))) return { notFound: 'template' };
    await attRef(orgId, postingKey).set({ orgId, postingKey, templateKey, attachedAt: nowIso(), attachedBy: actor || null });
    return { ok: true, attached: templateKey };
}

module.exports = { isPostingKey, stored, getDefaults, saveDefaults, attachments, list, get, save, create, markReviewed, restoreVersion, remove, renderFor, attach };
