/**
 * Required workplace notices ("posters"): a tracker, not legal advice. The federal list is a
 * starting point and the state requirements are recorded by the company, because they differ by
 * state and change. Confirm applicability with the U.S. Department of Labor and your state agency.
 */
const { parseIsoDate, isoDate } = require('./us-forms');

const FEDERAL = [
    { key: 'flsa', title: 'Employee Rights Under the Fair Labor Standards Act', appliesWhen: 'Employers covered by the FLSA (most employers)' },
    { key: 'eeo', title: 'Know Your Rights: Workplace Discrimination is Illegal (EEO)', appliesWhen: 'Employers with 15 or more employees, and federal contractors', minEmployees: 15 },
    { key: 'fmla', title: 'Employee Rights and Responsibilities Under the Family and Medical Leave Act', appliesWhen: 'Employers with 50 or more employees', minEmployees: 50 },
    { key: 'osha', title: 'Job Safety and Health: It\'s the Law', appliesWhen: 'Most private employers' },
    { key: 'userra', title: 'Your Rights Under USERRA', appliesWhen: 'All employers' },
    { key: 'eppa', title: 'Employee Polygraph Protection Act', appliesWhen: 'Most private employers' }
];

const REVIEW_WINDOW_DAYS = 30;
const DEFAULT_REVIEW_DAYS = 365;

function addDays(iso, n) { const d = parseIsoDate(iso); d.setUTCDate(d.getUTCDate() + n); return isoDate(d); }

function validateEntry(input) {
    const errors = [];
    const b = input || {};
    const value = {};
    if (!parseIsoDate(b.postedOn)) errors.push('postedOn must be a real date (YYYY-MM-DD)'); else value.postedOn = b.postedOn;
    const loc = String(b.location || '').trim();
    if (!loc) errors.push('location is required (for example: break room board, or intranet page)'); else value.location = loc.slice(0, 120);
    if (b.nextReviewOn) { if (!parseIsoDate(b.nextReviewOn)) errors.push('nextReviewOn must be YYYY-MM-DD'); else value.nextReviewOn = b.nextReviewOn; }
    value.electronic = b.electronic === true;
    if (b.notes) value.notes = String(b.notes).slice(0, 300);
    return { errors, value };
}

/** not_posted, posted, review_due, or not_applicable for one notice */
function statusOf(item, entry, headcount, today) {
    if (item.minEmployees && headcount < item.minEmployees) return 'not_applicable';
    if (!entry) return 'not_posted';
    const due = entry.nextReviewOn || addDays(entry.postedOn, DEFAULT_REVIEW_DAYS);
    return due <= addDays(today, REVIEW_WINDOW_DAYS) ? 'review_due' : 'posted';
}

/** The full tracker: federal notices plus one line for each state where people work */
function buildTracker(entriesByKey, headcount, workStates, today) {
    const items = FEDERAL.map((f) => ({ key: f.key, scope: 'federal', title: f.title, appliesWhen: f.appliesWhen, entry: entriesByKey[f.key] || null, status: statusOf(f, entriesByKey[f.key], headcount, today) }));
    for (const st of [...new Set(workStates)].sort()) {
        const key = `state_${st}`;
        items.push({ key, scope: st, title: `${st} state and local labor law notices`, appliesWhen: 'Your state labor department lists the notices every employer must post, plus any city or county notices', entry: entriesByKey[key] || null, status: statusOf({ key }, entriesByKey[key], headcount, today) });
    }
    return {
        items,
        counts: {
            total: items.filter((i) => i.status !== 'not_applicable').length,
            posted: items.filter((i) => i.status === 'posted').length,
            reviewDue: items.filter((i) => i.status === 'review_due').length,
            notPosted: items.filter((i) => i.status === 'not_posted').length
        }
    };
}

module.exports = { FEDERAL, validateEntry, statusOf, buildTracker };
