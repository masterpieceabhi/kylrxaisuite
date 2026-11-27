/**
 * Email notices: short emails that tell a person something is waiting for them, with a link into the app.
 * (The in-app list of notices is services/notices.js; this file only sends email.)
 *
 *   timesheet.submitted            -> the people who may approve that person's hours
 *   timesheet.approved / rejected  -> the person
 *   leave.requested                -> the people who may decide that person's time off
 *   leave.approved / denied        -> the person
 *   announcement.published         -> everyone active in the company
 *   policy.published               -> everyone active in the company
 *   survey.opened                  -> everyone active in the company
 *   review.shared                  -> the person
 *   review_cycle.opened            -> the people in the round
 *   asset.assigned                 -> the person who now has the item
 *
 * Signing links are sent by signingEmail() + sendNow() from the e-sign route (a link is a secret, never an event).
 * Reminders (open checklist tasks, unread policies, unsigned documents) are services/email-reminders.js, once a day.
 *
 * They hang off services/events.js: whatever raises one of those events also sends the email, so no route needs to
 * know about email. An email never holds pay, tax or personal details, only a name, a date and a link.
 *
 * Off when: no email is set up (SMTP_USER and SMTP_PASS, or RESEND_API_KEY), NOTICES_EMAIL=off, or the company has
 * noticesEmail: false. Sending never affects the action that raised the event, and a failure is only logged.
 */
const DAY = (iso) => {
    const d = new Date(`${String(iso || '').slice(0, 10)}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const MAX_EVERYONE = 500;
const firstName = (p) => String((p && p.name) || '').trim().split(/\s+/)[0] || 'there';
const active = (p) => Boolean(p && p.email) && !/^(terminated|inactive|offboarded|suspended|ended)$/i.test(String(p.status || 'active'));
const span = (d) => `${DAY(d.start_date)}${d.end_date && d.end_date !== d.start_date ? ` to ${DAY(d.end_date)}` : ''}`;

/**
 * Who gets what, as a list of { to, subject, text }. Pure: `people` is the company's people
 * ({ id, name, email, role, status, usProfile, managerId }), `canManage(user, target, scope)` the permission rule.
 */
function build(type, data, people, { canManage, appUrl, company }) {
    const d = data || {};
    const person = people.find((p) => p.id === d.person_id);
    const link = (page) => `${appUrl}/${page}`;
    const sign = `${company ? `${company} on ` : ''}Onn HR`;
    const mail = (p, subject, lines) => ({ to: p.email, subject, text: `Hi ${firstName(p)},\n\n${lines.join('\n\n')}\n\n${sign}\nYou get this email because you use Onn HR at work.` });
    const deciders = (scope) => people.filter((u) => active(u) && person && u.id !== person.id && canManage({ id: u.id, role: u.role }, person, scope));
    const who = (person && person.name) || 'A team member';

    switch (type) {
        case 'timesheet.submitted':
            if (!person) return [];
            return deciders('time').map((u) => mail(u, `Hours to approve: ${who}, week of ${DAY(d.week_start)}`,
                [`${who} sent their hours for the week of ${DAY(d.week_start)} for approval.`, `Review them here: ${link('admin-us-time.html')}`]));
        case 'timesheet.approved':
        case 'timesheet.rejected': {
            if (!active(person)) return [];
            const ok = type === 'timesheet.approved';
            return [mail(person, `Your hours for the week of ${DAY(d.week_start)} were ${ok ? 'approved' : 'sent back'}`,
                [ok ? `Your hours for the week of ${DAY(d.week_start)} were approved.` : `Your hours for the week of ${DAY(d.week_start)} were sent back to you. Check them, fix anything that is wrong, and send them again.`,
                    `See your hours: ${link('timesheet.html')}`])];
        }
        case 'leave.requested':
            if (!person) return [];
            return deciders('leave').map((u) => mail(u, `Time off to decide: ${who}, ${span(d)}`,
                [`${who} asked for time off: ${span(d)}.`, `Decide here: ${link('admin-us-leave.html')}`]));
        case 'leave.approved':
        case 'leave.denied': {
            if (!active(person)) return [];
            const ok = type === 'leave.approved';
            return [mail(person, ok ? `Your time off (${span(d)}) was approved` : 'Your time-off request was not approved',
                [ok ? `Your time off (${span(d)}) was approved.` : 'Your time-off request was not approved. Talk to your manager if you have questions.',
                    `See your time off: ${link('leave.html')}`])];
        }
        case 'announcement.published':
            return people.filter(active).filter((p) => p.id !== d.published_by).slice(0, MAX_EVERYONE).map((p) => mail(p, `News at work: ${String(d.title || 'a new announcement').slice(0, 120)}`,
                [`There is a new announcement: "${String(d.title || '').slice(0, 200)}".`, `Read it here: ${link('us-home.html')}`]));
        case 'policy.published':
            return people.filter(active).filter((p) => p.id !== d.published_by).slice(0, MAX_EVERYONE).map((p) => mail(p, `${d.require_ack ? 'Please read: ' : 'Updated: '}${String(d.title || 'a company policy').slice(0, 120)}`,
                [`${d.require_ack ? 'A company policy was published that you are asked to read and confirm' : 'A company policy was updated'}: "${String(d.title || '').slice(0, 200)}".`, `Read it here: ${link('my-policies.html')}`]));
        case 'survey.opened':
            return people.filter(active).filter((p) => p.id !== d.opened_by).slice(0, MAX_EVERYONE).map((p) => mail(p, `A short survey: ${String(d.title || 'your opinion').slice(0, 120)}`,
                [`Your company opened a survey: "${String(d.title || '').slice(0, 200)}". Your answers are not stored with your name.`, `Answer it here: ${link('my-surveys.html')}`]));
        case 'review.shared':
            if (!active(person)) return [];
            return [mail(person, 'Your review was shared with you', ['Your manager shared a written review with you. Read it and mark that you have seen it.', `Read it here: ${link('my-goals.html')}`])];
        case 'review_cycle.opened': {
            const ids = new Set(Array.isArray(d.person_ids) ? d.person_ids : []);
            return people.filter(active).filter((p) => ids.has(p.id)).slice(0, MAX_EVERYONE).map((p) => mail(p, `Review round started: ${String(d.name || 'reviews').slice(0, 120)}`,
                [`A review round started: "${String(d.name || '').slice(0, 200)}". You may be asked for a self review and for feedback on coworkers.`, `See what is asked of you: ${link('my-reviews.html')}`]));
        }
        case 'asset.assigned':
            if (!active(person)) return [];
            return [mail(person, `Company equipment given to you: ${String(d.asset_name || 'an item').slice(0, 120)}`,
                [`HR recorded that you now have: ${String(d.asset_name || 'a company item').slice(0, 200)}${d.due_back ? `, to give back by ${DAY(d.due_back)}` : ''}.`, `Please confirm you have it, or report a problem: ${link('my-assets.html')}`])];
        default:
            return [];
    }
}

const TYPES = new Set(['timesheet.submitted', 'timesheet.approved', 'timesheet.rejected', 'leave.requested', 'leave.approved', 'leave.denied', 'announcement.published', 'policy.published',
    'survey.opened', 'review.shared', 'review_cycle.opened', 'asset.assigned']);

/**
 * The email with a signing link. The link is a secret (whoever has it can sign), so it never goes through events or
 * webhooks: the e-sign route sends this one straight away, to the signer's own address only.
 */
function signingEmail({ name, email, docName, url, expiresAt, company, reminder = false }) {
    if (!email || !url) return null;
    const sign = `${company ? `${company} on ` : ''}Onn HR`;
    const doc = String(docName || 'A document').slice(0, 150);
    const until = expiresAt ? ` The link works until ${DAY(expiresAt)}.` : '';
    return {
        to: email,
        subject: `${reminder ? 'Reminder: ' : ''}Please sign: ${doc}`.slice(0, 180),
        text: `Hi ${firstName({ name })},\n\n${company || 'Your company'} sent you a document to read and sign: ${doc}.\n\nOpen it here: ${url}\n\nThe link is only for you: please do not forward it. Opening it does not sign anything.${until}\n\n${sign}\nIf you did not expect this, you can ignore this email.`
    };
}

/** Sends ready-made messages for one company, with the same off switches as the event emails. Never throws. */
async function sendNow(orgId, messages, { env = process.env, send, org } = {}) {
    const list = (messages || []).filter(Boolean);
    if (!list.length || !emailReady(env)) return 0;
    const logger = require('../utils/logger');
    try {
        let o = org;
        if (!o) { const snap = await require('../config/firebase').rawCollection('organizations').doc(orgId).get(); o = (typeof snap.exists === 'function' ? snap.exists() : snap.exists) ? snap.data() : {}; }
        if (o.noticesEmail === false) return 0;
        const sendEmail = send || require('../utils/email').sendEmail;
        let sent = 0;
        for (const m of list) { try { await sendEmail(m); sent += 1; } catch (e) { logger.warn(`[EmailNotices] could not send "${String(m.subject).slice(0, 60)}": ${String(e.message).slice(0, 160)}`); } }
        return sent;
    } catch (e) { logger.warn(`[EmailNotices] send failed: ${String(e && e.message).slice(0, 160)}`); return 0; }
}
const companyName = (org) => String((org && (org.Display_Name || org.displayName || org.name || org.Legal_Name)) || '').trim();
const emailReady = (env = process.env) => Boolean((env.SMTP_USER && env.SMTP_PASS) || env.RESEND_API_KEY) && env.NOTICES_EMAIL !== 'off';

/** Called by services/events.js for every event. Never throws; resolves to how many emails went out. */
async function fromEvent(orgId, type, data, { env = process.env, load, send } = {}) {
    if (!TYPES.has(type) || !orgId || !emailReady(env)) return 0;
    const logger = require('../utils/logger');
    try {
        const { org, people } = load ? await load(orgId) : await loadCompany(orgId);
        if (org.noticesEmail === false) return 0;
        const out = build(type, data, people, {
            canManage: require('./permissions').canManage,
            appUrl: String(env.APP_URL || 'https://app.onnhr.com').replace(/\/+$/, ''),
            company: String(org.Display_Name || org.displayName || org.name || org.Legal_Name || '').trim()
        });
        const sendEmail = send || require('../utils/email').sendEmail;
        let sent = 0;
        for (const m of out) {
            try { await sendEmail(m); sent += 1; } catch (e) { logger.warn(`[EmailNotices] ${type} could not be emailed: ${String(e.message).slice(0, 160)}`); }
        }
        return sent;
    } catch (e) { logger.warn(`[EmailNotices] ${type} failed: ${String(e && e.message).slice(0, 160)}`); return 0; }
}

async function loadCompany(orgId) {
    const { rawCollection } = require('../config/firebase');
    const o = await rawCollection('organizations').doc(orgId).get();
    const snap = await rawCollection('users').where('orgId', '==', orgId).get();
    return { org: (typeof o.exists === 'function' ? o.exists() : o.exists) ? o.data() : {}, people: snap.docs.map((x) => ({ id: x.id, ...x.data() })) };
}

module.exports = { build, fromEvent, emailReady, signingEmail, sendNow, companyName, loadCompany, TYPES, DAY, firstName, active };
