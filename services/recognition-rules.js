/**
 * Announcements and recognition ("thanks") for US companies (pure, no I/O).
 *
 * Announcements: HR writes one as a draft, publishes it to everyone, one location or one department, and
 * archives it later. An announcement may be pinned to the top and may stop showing after an end date.
 * Each person who opens one leaves a single read marker, so HR can see how many people have read it.
 *
 * Thanks: any employee may thank a coworker in the same company, choosing one of the company's values.
 * A person cannot thank themselves, and may send only so many a day (the company sets the number).
 * HR may hide a thanks that is not appropriate; it is kept and marked hidden, never removed.
 */
const { parseIsoDate } = require('./us-forms');

const STATUSES = ['draft', 'published', 'archived'];
const AUDIENCES = ['everyone', 'location', 'department'];
const TITLE_MAX = 150;
const BODY_MAX = 5000;
const MESSAGE_MIN = 3;
const MESSAGE_MAX = 500;
const VALUES_MAX = 12;
const LIMIT_MAX = 50;
const DEFAULT_SETTINGS = {
    dailyLimit: 5,
    values: [
        { id: 'teamwork', name: 'Teamwork' },
        { id: 'customer_care', name: 'Customer care' },
        { id: 'going_the_extra_mile', name: 'Going the extra mile' },
        { id: 'safety', name: 'Safety' },
        { id: 'great_idea', name: 'Great idea' }
    ]
};

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);

/* ------------------------------------ settings ------------------------------------ */

/** The company's settings with the defaults filled in */
function settingsOf(stored) {
    const s = stored || {};
    const values = Array.isArray(s.values) && s.values.length ? s.values.map((v) => ({ id: String(v.id), name: String(v.name) })) : DEFAULT_SETTINGS.values.map((v) => ({ ...v }));
    const n = Number(s.dailyLimit);
    return { dailyLimit: Number.isInteger(n) && n >= 1 && n <= LIMIT_MAX ? n : DEFAULT_SETTINGS.dailyLimit, values };
}

/** What HR may change: the list of values (names) and the number of thanks a person may send in a day */
function validateSettings(input) {
    const errors = []; const b = input || {}; const value = {};
    if (b.dailyLimit !== undefined) {
        const n = Number(b.dailyLimit);
        if (!Number.isInteger(n) || n < 1 || n > LIMIT_MAX) errors.push(`The daily limit must be a whole number from 1 to ${LIMIT_MAX}`); else value.dailyLimit = n;
    }
    if (b.values !== undefined) {
        if (!Array.isArray(b.values) || !b.values.length) errors.push('Keep at least one value');
        else if (b.values.length > VALUES_MAX) errors.push(`Keep the list to ${VALUES_MAX} values or fewer`);
        else {
            const seen = new Set(); const list = [];
            b.values.forEach((raw, i) => {
                const name = clean(raw && typeof raw === 'object' ? raw.name : raw, 40);
                if (name.length < 2) { errors.push(`Value ${i + 1}: give it a name (at least 2 characters)`); return; }
                // a value keeps its id when it is renamed, so earlier thanks still count under it
                const given = raw && typeof raw === 'object' && raw.id ? slug(raw.id) : '';
                const id = given || slug(name);
                if (!id) { errors.push(`Value ${i + 1}: use letters or numbers in the name`); return; }
                if (seen.has(id) || list.some((v) => v.name.toLowerCase() === name.toLowerCase())) { errors.push(`Value ${i + 1}: "${name}" is on the list twice`); return; }
                seen.add(id); list.push({ id, name });
            });
            if (!errors.length) value.values = list;
        }
    }
    if (!errors.length && !Object.keys(value).length) errors.push('Nothing to change');
    return { errors, value: errors.length ? null : value };
}

/* ---------------------------------- announcements ---------------------------------- */

/** An announcement (partial: only the fields that were sent). today: the company's date, to refuse an end date in the past */
function validateAnnouncement(input, { partial = false, today = null } = {}) {
    const errors = []; const b = input || {}; const value = {};
    if (!partial || b.title !== undefined) { const t = clean(b.title, TITLE_MAX); if (t.length < 3) errors.push('Give the announcement a title (at least 3 characters)'); else value.title = t; }
    if (!partial || b.body !== undefined) {
        const raw = String(b.body === undefined || b.body === null ? '' : b.body);
        if (raw.length > BODY_MAX) errors.push(`The text is too long (${raw.length} characters; the most is ${BODY_MAX})`);
        else { const body = block(raw, BODY_MAX); if (body.length < 1) errors.push('Write the announcement text'); else value.body = body; }
    }
    if (!partial || b.audience !== undefined) {
        const a = b.audience && typeof b.audience === 'object' ? b.audience : { type: b.audience === undefined ? 'everyone' : b.audience };
        if (!AUDIENCES.includes(a.type)) errors.push(`audience must be one of: ${AUDIENCES.join(', ')}`);
        else if (a.type === 'everyone') value.audience = { type: 'everyone', id: null };
        else if (!a.id || typeof a.id !== 'string' || a.id.length > 200) errors.push(a.type === 'location' ? 'Choose the location' : 'Choose the department');
        else value.audience = { type: a.type, id: a.id };
    }
    if (b.pinned !== undefined) value.pinned = Boolean(b.pinned);
    if (b.endDate !== undefined) {
        if (b.endDate === '' || b.endDate === null) value.endDate = null;
        else if (!parseIsoDate(b.endDate)) errors.push('The end date must be a real date (YYYY-MM-DD)');
        else if (today && String(b.endDate) < today) errors.push('The end date has already passed');
        else value.endDate = String(b.endDate);
    }
    if (partial && !errors.length && !Object.keys(value).length) errors.push('Nothing to change');
    return { errors, value: errors.length ? null : value };
}

/** May this be done now? Returns null when allowed, or the reason it is not. */
function announcementChangeError(a, action) {
    if (action === 'edit') return a.status === 'archived' ? 'An archived announcement cannot be changed' : null;
    if (action === 'publish') return a.status === 'draft' ? null : a.status === 'published' ? 'This announcement is already published' : 'An archived announcement cannot be published again. Write a new one.';
    if (action === 'archive') return a.status === 'published' ? null : a.status === 'archived' ? 'This announcement is already archived' : 'A draft that was never published can be deleted instead';
    if (action === 'delete') return a.status === 'draft' ? null : 'An announcement that was published cannot be deleted, so its read records are kept. Archive it instead.';
    return `Unknown action: ${action}`;
}

/** Is this announcement meant for this person? person: { departmentId, workLocationId } (either may be missing) */
function isForPerson(a, person) {
    const aud = a.audience || { type: 'everyone' }; const p = person || {};
    if (aud.type === 'everyone') return true;
    if (aud.type === 'location') return Boolean(p.workLocationId) && p.workLocationId === aud.id;
    if (aud.type === 'department') return Boolean(p.departmentId) && p.departmentId === aud.id;
    return false;
}
const hasEnded = (a, today) => Boolean(a.endDate && today && a.endDate < today);
/** Does this person see it today? Only published ones, for them, up to and including the end date */
const isVisibleTo = (a, person, today) => a.status === 'published' && !hasEnded(a, today) && isForPerson(a, person);
/** Pinned on top, then newest first */
const sortForReading = (list) => [...list].sort((x, y) => Number(Boolean(y.pinned)) - Number(Boolean(x.pinned)) || String(y.publishedAt || y.createdAt || '').localeCompare(String(x.publishedAt || x.createdAt || '')));
/** How many of these people the announcement is meant for */
const audienceCount = (a, people) => (people || []).filter((p) => isForPerson(a, p)).length;
/** One read marker per person per announcement */
const readId = (announcementId, userId) => `${announcementId}_${userId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 300);

/* ------------------------------------- thanks ------------------------------------- */

/**
 * A thanks from one person to another.
 *   fromId:    the sender
 *   peopleIds: ids of the people in the same company who may be thanked
 *   values:    the company's values [{ id, name }]
 */
function validateThanks(input, { fromId, peopleIds, values } = {}) {
    const errors = []; const b = input || {}; const value = {};
    const to = typeof b.toUserId === 'string' ? b.toUserId.trim() : '';
    const known = peopleIds instanceof Set ? peopleIds : new Set(peopleIds || []);
    if (!to) errors.push('Choose the person you want to thank');
    else if (to === String(fromId)) errors.push('You cannot thank yourself');
    else if (!known.has(to)) errors.push('That person is not in your company');
    else value.toUserId = to;
    const v = (values || []).find((x) => x.id === b.valueId);
    if (!v) errors.push('Choose what the thanks is for'); else { value.valueId = v.id; value.valueName = v.name; }
    const raw = String(b.message === undefined || b.message === null ? '' : b.message);
    if (raw.length > MESSAGE_MAX) errors.push(`The message is too long (${raw.length} characters; the most is ${MESSAGE_MAX})`);
    else { const m = block(raw, MESSAGE_MAX); if (m.length < MESSAGE_MIN) errors.push('Write a short message'); else value.message = m; }
    return { errors, value: errors.length ? null : value };
}

/** How many thanks this person sent on this day (hidden ones count too, so hiding does not hand back a turn) */
const sentOn = (thanks, userId, day) => (thanks || []).filter((t) => t.fromId === userId && t.day === day).length;
/** Null when the person may send another one today, or the reason they may not */
function limitError(sentToday, settings) {
    const limit = settingsOf(settings).dailyLimit;
    return sentToday >= limit ? `You have sent ${limit} thanks today, which is the most allowed in one day. You can send more tomorrow.` : null;
}
/** The stored id of a person's nth thanks of a day: a fixed set of ids per day is what enforces the limit */
const slotId = (orgId, userId, day, n) => `${orgId}_${userId}_${day}_${n}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 300);

/** What people see of a thanks. Hidden ones are left out unless forHr is set. */
function thanksView(t, { forHr = false } = {}) {
    if (t.hidden && !forHr) return null;
    return { id: t.id, fromId: t.fromId, fromName: t.fromName || null, toId: t.toId, toName: t.toName || null, valueId: t.valueId, valueName: t.valueName || t.valueId, message: t.message, at: t.at, day: t.day,
        ...(forHr ? { hidden: Boolean(t.hidden), hiddenReason: t.hiddenReason || null, hiddenByName: t.hiddenByName || null, hiddenAt: t.hiddenAt || null } : {}) };
}
const newestFirst = (list) => [...list].sort((a, b) => String(b.at).localeCompare(String(a.at)));

/** from and to as dates, both needed, from not after to */
function validateRange(from, to) {
    if (!parseIsoDate(from) || !parseIsoDate(to)) return 'from and to are needed as dates (YYYY-MM-DD)';
    if (from > to) return 'The first date must not be after the last date';
    return null;
}

/** Counts by person and by value for the days from..to. Hidden thanks are not counted, only totalled. */
function summarize(thanks, { from, to, values } = {}) {
    const inRange = (thanks || []).filter((t) => (!from || t.day >= from) && (!to || t.day <= to));
    const shown = inRange.filter((t) => !t.hidden);
    const people = new Map();
    const person = (id, name) => { if (!people.has(id)) people.set(id, { userId: id, name: name || id, received: 0, given: 0 }); const p = people.get(id); if (name && p.name === id) p.name = name; return p; };
    const byVal = new Map((values || []).map((v) => [v.id, { valueId: v.id, name: v.name, count: 0 }]));
    for (const t of shown) {
        person(t.toId, t.toName).received += 1; person(t.fromId, t.fromName).given += 1;
        if (!byVal.has(t.valueId)) byVal.set(t.valueId, { valueId: t.valueId, name: t.valueName || t.valueId, count: 0 });
        byVal.get(t.valueId).count += 1;
    }
    return { from: from || null, to: to || null, total: shown.length, hidden: inRange.length - shown.length,
        byPerson: [...people.values()].sort((a, b) => b.received - a.received || b.given - a.given || String(a.name).localeCompare(String(b.name))),
        byValue: [...byVal.values()].sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name))) };
}

/** CSV cell: quoted, and text that a spreadsheet would run as a formula is made plain text */
function csvCell(v) {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** The report as one CSV: a block of counts by person, then a block of counts by value */
function reportCsv(summary) {
    const lines = [['Thanks from', summary.from || '', 'to', summary.to || ''], [], ['Person', 'Thanks received', 'Thanks given']];
    summary.byPerson.forEach((p) => lines.push([p.name, p.received, p.given]));
    lines.push([], ['Value', 'Times chosen']);
    summary.byValue.forEach((v) => lines.push([v.name, v.count]));
    return `${lines.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

module.exports = { STATUSES, AUDIENCES, TITLE_MAX, BODY_MAX, MESSAGE_MIN, MESSAGE_MAX, VALUES_MAX, LIMIT_MAX, DEFAULT_SETTINGS, settingsOf, validateSettings, validateAnnouncement, announcementChangeError,
    isForPerson, hasEnded, isVisibleTo, sortForReading, audienceCount, readId, validateThanks, sentOn, limitError, slotId, thanksView, newestFirst, validateRange, summarize, csvCell, reportCsv, clean, block };
