/**
 * Company equipment given to people, for US companies (pure, no I/O).
 *
 * An item is available, with a person, out for repair, lost, or retired.
 * Every hand-over and return is kept in the item's history, so the company can show who had what and when.
 * Nothing here charges anyone for an item: whether a cost may be taken from pay depends on state law.
 */
const { parseIsoDate } = require('./us-forms');

const CATEGORIES = ['Laptop or computer', 'Phone', 'Tablet', 'Keys', 'Badge or access card', 'Uniform', 'Tools', 'Vehicle', 'Company card', 'Other'];
const STATUSES = ['available', 'assigned', 'repair', 'lost', 'retired'];
const CONDITIONS = ['new', 'good', 'fair', 'damaged'];
const NOTE = 'Do not take the cost of lost, damaged or unreturned equipment out of a paycheck without written permission and a check of your state rules. Many states limit or forbid it. Confirm with a US employment advisor.';
const HISTORY_MAX = 200;

const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const block = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[<>]/g, '').replace(/\r\n/g, '\n').trim().slice(0, max);

/** A new item, or a change to its details (partial: only the fields that were sent) */
function validateAsset(input, { partial = false } = {}) {
    const errors = []; const b = input || {}; const value = {};
    if (!partial || b.name !== undefined) { const n = clean(b.name, 120); if (n.length < 2) errors.push('Say what the item is (at least 2 characters)'); else value.name = n; }
    if (!partial || b.category !== undefined) { if (!CATEGORIES.includes(b.category)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}`); else value.category = b.category; }
    if (b.tag !== undefined) value.tag = clean(b.tag, 40);
    if (b.serial !== undefined) value.serial = clean(b.serial, 60);
    if (b.condition !== undefined && b.condition !== '' && b.condition !== null) { if (!CONDITIONS.includes(b.condition)) errors.push(`condition must be one of: ${CONDITIONS.join(', ')}`); else value.condition = b.condition; }
    if (b.purchaseDate !== undefined) { if (b.purchaseDate === '' || b.purchaseDate === null) value.purchaseDate = null; else if (!parseIsoDate(b.purchaseDate)) errors.push('purchaseDate must be a real date (YYYY-MM-DD)'); else value.purchaseDate = String(b.purchaseDate); }
    if (b.cost !== undefined) {
        if (b.cost === '' || b.cost === null) value.cost = null;
        else { const c = Number(b.cost); if (!Number.isFinite(c) || c < 0 || c > 1000000) errors.push('cost must be a dollar amount from 0 to 1,000,000'); else value.cost = Math.round(c * 100) / 100; }
    }
    if (b.notes !== undefined) value.notes = block(b.notes, 1000);
    if (partial && !errors.length && !Object.keys(value).length) errors.push('Nothing to change');
    return { errors, value: errors.length ? null : value };
}

/** Details of a hand-over: who gets it, an optional date it is due back, its condition and a note */
function validateAssignment(input, todayIso) {
    const errors = []; const b = input || {}; const value = {};
    const userId = clean(b.userId, 80);
    if (!userId) errors.push('Choose who gets the item'); else value.userId = userId;
    if (b.dueBack === undefined || b.dueBack === '' || b.dueBack === null) value.dueBack = null;
    else if (!parseIsoDate(b.dueBack)) errors.push('dueBack must be a real date (YYYY-MM-DD)');
    else if (todayIso && b.dueBack < todayIso) errors.push('The date it is due back cannot be in the past');
    else value.dueBack = String(b.dueBack);
    if (b.condition !== undefined && b.condition !== '' && b.condition !== null) { if (!CONDITIONS.includes(b.condition)) errors.push(`condition must be one of: ${CONDITIONS.join(', ')}`); else value.condition = b.condition; }
    value.note = clean(b.note, 300);
    return { errors, value: errors.length ? null : value };
}

/** May this be done to the item now? Returns null when allowed, or the reason it is not. */
function changeError(asset, action) {
    const s = asset.status;
    if (action === 'assign') return s === 'available' ? null : s === 'assigned' ? 'This item is already with someone. Take it back first.' : `This item is marked ${s}. Make it available first.`;
    if (action === 'return') return s === 'assigned' ? null : 'This item is not with anyone';
    if (action === 'repair') return s === 'available' ? null : s === 'assigned' ? 'Take the item back before sending it for repair' : `This item is already marked ${s}`;
    if (action === 'lost') return s === 'available' || s === 'assigned' || s === 'repair' ? null : `This item is already marked ${s}`;
    if (action === 'retired') return s === 'assigned' ? 'Take the item back before retiring it' : s === 'retired' ? 'This item is already retired' : null;
    if (action === 'available') return s === 'repair' || s === 'lost' || s === 'retired' ? null : s === 'assigned' ? 'Use "take back" for an item that is with someone' : 'This item is already available';
    if (action === 'delete') return (asset.history || []).some((h) => h.type === 'assigned') ? 'An item that was ever given to someone cannot be deleted, so its history is kept. Retire it instead.' : null;
    if (action === 'acknowledge') return s !== 'assigned' ? 'This item is not with you' : asset.acknowledgedAt ? 'You already confirmed this item' : null;
    if (action === 'problem') return s === 'assigned' ? null : 'This item is not with you';
    return `Unknown action: ${action}`;
}

/** A history line. at: ISO time. Extra fields are kept only when given. */
function historyEntry(type, { at, by, userId, name, note, condition } = {}) {
    const e = { type, at };
    if (by) e.by = by; if (userId) e.userId = userId; if (name) e.name = name; if (note) e.note = note; if (condition) e.condition = condition;
    return e;
}
const addHistory = (asset, entry) => [...(asset.history || []), entry].slice(-HISTORY_MAX);

/** Is an item past the date it was due back? */
const isOverdue = (asset, todayIso) => asset.status === 'assigned' && Boolean(asset.dueBack) && asset.dueBack < todayIso;

/** Counts for the top of the page */
function summary(assets, todayIso) {
    const by = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    for (const a of assets) if (by[a.status] !== undefined) by[a.status] += 1;
    const out = assets.filter((a) => a.status === 'assigned');
    return { total: assets.length, ...by, overdue: out.filter((a) => isOverdue(a, todayIso)).length, notConfirmed: out.filter((a) => !a.acknowledgedAt).length,
        problems: out.filter((a) => a.problem).length, valueWithPeople: Math.round(out.reduce((s, a) => s + (Number(a.cost) || 0), 0) * 100) / 100 };
}

/**
 * Items still with people who no longer work here. people: [{ id, name, active }].
 * An item whose holder is not in the list at all is included too (the person record is gone).
 */
function unreturned(assets, people) {
    const byId = new Map(people.map((p) => [p.id, p]));
    return assets.filter((a) => a.status === 'assigned').filter((a) => { const p = byId.get(a.assignedTo); return !p || !p.active; })
        .map((a) => ({ id: a.id, name: a.name, tag: a.tag || '', category: a.category, cost: a.cost ?? null, assignedTo: a.assignedTo, assignedToName: a.assignedToName || (byId.get(a.assignedTo) || {}).name || null, assignedAt: a.assignedAt || null }));
}

/** What the person holding an item sees: no cost, no internal notes, no history of other people */
function holderView(asset, todayIso) {
    return { id: asset.id, name: asset.name, category: asset.category, tag: asset.tag || '', serial: asset.serial || '', assignedAt: asset.assignedAt || null, dueBack: asset.dueBack || null, overdue: isOverdue(asset, todayIso),
        acknowledgedAt: asset.acknowledgedAt || null, problem: asset.problem ? { at: asset.problem.at, text: asset.problem.text } : null };
}

module.exports = { CATEGORIES, STATUSES, CONDITIONS, NOTE, HISTORY_MAX, validateAsset, validateAssignment, changeError, historyEntry, addHistory, isOverdue, summary, unreturned, holderView, clean, block };
