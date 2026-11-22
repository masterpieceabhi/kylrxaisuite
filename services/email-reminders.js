/**
 * Once-a-day reminder emails, run by services/daily-jobs.js after the housekeeping:
 *
 *   Checklist tasks  open required onboarding/offboarding tasks: the day before they are due, on the day, then every 3 days
 *                    while overdue (for up to 30 days). One email per person listing all their open tasks:
 *                    employee tasks to the person, HR tasks to HR and the owner, manager tasks to the person's manager.
 *   Policies         a published policy the person is asked to confirm and has not: 3, 7 and 14 days after it was published.
 *   Signing          an open signing request, when services/esign-rules.js remindersDue() says so (3 days since the last
 *                    contact, or 3 days before it runs out), at most 3 automatic reminders. The email carries a fresh link
 *                    (only a hash of a link is stored, so the old one cannot be sent again; it stops working).
 *
 * The same off switches as every email notice: no email set up, NOTICES_EMAIL=off, or the company has noticesEmail: false.
 * Also REMINDERS_EMAIL=off for these alone. Only US companies. An email never holds pay, tax or personal details.
 */
const N = require('./email-notices');

const MAX_LINES = 15;
const POLICY_DAYS = [3, 7, 14];
const AUTO_SIGN_REMINDERS = 3;

const daysBetween = (fromIso, toIso) => Math.round((Date.parse(`${String(toIso).slice(0, 10)}T12:00:00Z`) - Date.parse(`${String(fromIso).slice(0, 10)}T12:00:00Z`)) / 86400000);

/** Is today a reminder day for a task due on dueDate? */
function remindDay(dueDate, today) {
    if (!dueDate) return false;
    const late = daysBetween(dueDate, today);
    return late === -1 || late === 0 || (late > 0 && late <= 30 && late % 3 === 0);
}

/**
 * Pure. Returns the emails for one company.
 *   tasks:    [{ userId, name, assignee: employee|hr|manager, title, dueDate }]  (open tasks only)
 *   policies: [{ id, title, publishedAt, needs: Set(userId) }]                  (who still has to confirm)
 *   can(user, perm), canManage(user, target, scope): the permission rules
 */
function plan({ today, people, tasks = [], policies = [], appUrl, company, can, canManage }) {
    const link = (page) => `${appUrl}/${page}`;
    const sign = `${company ? `${company} on ` : ''}Onn HR`;
    const live = people.filter(N.active);
    const byId = new Map(live.map((p) => [p.id, p]));
    const hr = live.filter((u) => can({ id: u.id, role: u.role }, 'people.write'));
    const out = [];

    // checklist tasks, grouped by who has to act
    const inbox = new Map(); // recipient id -> [task]
    const add = (p, t) => { if (!p) return; if (!inbox.has(p.id)) inbox.set(p.id, []); inbox.get(p.id).push(t); };
    for (const t of tasks) {
        if (!t.dueDate || daysBetween(t.dueDate, today) < -1) continue; // not near yet
        const person = byId.get(t.userId);
        if (t.assignee === 'employee') add(person, t);
        else if (t.assignee === 'manager') {
            const target = people.find((p) => p.id === t.userId);
            // the person's own manager(s): people who manage them without being HR (HR may manage everyone)
            const mgrs = target ? live.filter((u) => u.id !== t.userId && !can({ id: u.id, role: u.role }, 'people.write') && canManage({ id: u.id, role: u.role }, target, 'time')) : [];
            (mgrs.length ? mgrs : hr).forEach((u) => add(u, t));
        } else hr.filter((u) => u.id !== t.userId).forEach((u) => add(u, t));
    }
    for (const [id, list] of inbox) {
        if (!list.some((t) => remindDay(t.dueDate, today))) continue;
        const p = byId.get(id);
        const own = list.every((t) => t.userId === id);
        const late = list.filter((t) => daysBetween(t.dueDate, today) > 0).length;
        list.sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
        const lines = list.slice(0, MAX_LINES).map((t) => `- ${t.title}${own ? '' : ` (${t.name || 'a team member'})`}: ${daysBetween(t.dueDate, today) > 0 ? `was due ${N.DAY(t.dueDate)}` : `due ${N.DAY(t.dueDate)}`}`);
        if (list.length > MAX_LINES) lines.push(`- and ${list.length - MAX_LINES} more`);
        out.push({
            to: p.email,
            subject: late ? `${late} ${late === 1 ? 'task is' : 'tasks are'} overdue` : `${list.length === 1 ? 'A task is' : `${list.length} tasks are`} due soon`,
            text: `Hi ${N.firstName(p)},\n\n${own ? 'These steps are waiting for you:' : 'These onboarding and offboarding steps are waiting:'}\n\n${lines.join('\n')}\n\nOpen them here: ${link(own ? 'us-onboarding.html' : 'admin-us-checklists.html')}\n\n${sign}\nYou get this email because you use Onn HR at work.`
        });
    }

    // policies still to confirm, one email per person
    const unread = new Map();
    for (const pol of policies) {
        if (!pol.publishedAt || !POLICY_DAYS.includes(daysBetween(pol.publishedAt, today))) continue;
        for (const uid of pol.needs || []) { if (byId.has(uid)) { if (!unread.has(uid)) unread.set(uid, []); unread.get(uid).push(pol.title || 'A company policy'); } }
    }
    for (const [uid, titles] of unread) {
        const p = byId.get(uid);
        out.push({
            to: p.email,
            subject: titles.length === 1 ? `Reminder: please read ${String(titles[0]).slice(0, 120)}` : `Reminder: ${titles.length} company policies to read`,
            text: `Hi ${N.firstName(p)},\n\nYou are asked to read and confirm:\n\n${titles.slice(0, MAX_LINES).map((x) => `- ${String(x).slice(0, 200)}`).join('\n')}\n\nRead them here: ${link('my-policies.html')}\n\n${sign}\nYou get this email because you use Onn HR at work.`
        });
    }
    return out;
}

/** Pure. Which open signing requests get an automatic reminder today. */
function signingDue(requests, nowIso) {
    const E = require('./esign-rules');
    const due = new Set(E.remindersDue(requests, nowIso).map((r) => r.id));
    return requests.filter((r) => due.has(r.id) && r.signerEmail && (r.reminders || []).filter((x) => x.by === 'daily-job').length < AUTO_SIGN_REMINDERS);
}

/* --------------------------------- the real thing --------------------------------- */

const isUs = (o) => require('../country-config').resolveCountryCode(o.country || o.Country) === 'US';

async function runOrg(orgId, org, { env = process.env, send } = {}) {
    const { rawCollection } = require('../config/firebase');
    const timeRules = require('./time-rules');
    const { orgInfo } = require('../routes/time').helpers;
    const rules = require('./checklist-rules');
    const store = require('./us-checklist-service');
    const P = require('./policy-rules');
    const E = require('./esign-rules');
    const S = require('./esign-service');
    const perms = require('./permissions');
    const appUrl = String(env.APP_URL || 'https://app.onnhr.com').replace(/\/+$/, '');
    const company = N.companyName(org);
    const today = timeRules.localDate(new Date().toISOString(), (await orgInfo(orgId)).tz);
    const docs = async (name) => (await rawCollection(name).where('orgId', '==', orgId).get()).docs.map((d) => ({ id: d.id, ref: d.ref, ...d.data() }));

    const people = (await docs('users')).map(({ ref, ...p }) => p);
    const [lists, policies, acks, signs] = await Promise.all([docs('checklists'), docs('policies'), docs('policy_acks'), docs('sign_requests')]);

    const read = await store.handbookFacts(orgId).catch(() => () => false);
    const byId = new Map(people.map((p) => [p.id, p]));
    const tasks = [];
    for (const c of lists) {
        if (c.cancelled || !byId.has(c.userId)) continue;
        const ev = rules.evaluate(c.tasks, store.factsFor(byId.get(c.userId), { handbook: read(c.userId) }), today, c.userId);
        // required tasks only: optional ones ("if they use the shared tablet") would only be noise in an inbox
        ev.tasks.filter((t) => !t.done && !t.skipped && t.required).forEach((t) => tasks.push({ userId: c.userId, name: c.name || byId.get(c.userId).name, assignee: t.assignee, title: t.title, dueDate: t.dueDate }));
    }
    const acked = new Map();
    for (const a of acks) { const k = `${a.policyId}|${a.userId}`; if (!acked.has(k)) acked.set(k, []); acked.get(k).push(a.version); }
    const pols = policies.filter((p) => P.ackState(p, []).needed).map((p) => {
        const cur = P.currentVersion(p) || {};
        return { id: p.id, title: cur.title || p.title, publishedAt: cur.publishedAt, needs: new Set(people.filter(N.active).filter((u) => P.ackState(p, acked.get(`${p.id}|${u.id}`) || []).needed).map((u) => u.id)) };
    });

    const messages = plan({ today, people, tasks, policies: pols, appUrl, company, can: perms.can, canManage: perms.canManage });
    let sent = await N.sendNow(orgId, messages, { env, send, org });

    // signing reminders: a fresh link each time
    const now = new Date().toISOString();
    for (const r of signingDue(signs, now)) {
        const { token, hash } = E.generateToken();
        await r.ref.update({ tokenHash: hash, reminders: [...(r.reminders || []), { at: now, by: 'daily-job' }], history: [...(r.history || []), S.histEntry('reminder_emailed', null, { by: 'daily-job' })] });
        const msg = N.signingEmail({ name: r.signerName, email: r.signerEmail, docName: r.templateName, url: `${appUrl}${S.signUrl(null, token)}`, expiresAt: r.expiresAt, company, reminder: true });
        sent += await N.sendNow(orgId, [msg], { env, send, org });
    }
    return { orgId, emails: sent };
}

/** Every US company. Never throws; returns a short summary for the daily run. */
async function runAll({ env = process.env, send } = {}) {
    if (!N.emailReady(env) || env.REMINDERS_EMAIL === 'off') return { skipped: 'email is not set up or reminders are off', emails: 0, companies: 0 };
    const { rawCollection } = require('../config/firebase');
    const orgs = await rawCollection('organizations').get();
    let emails = 0; let companies = 0; const errors = [];
    for (const o of orgs.docs) {
        const org = o.data() || {};
        if (!isUs(org) || org.noticesEmail === false) continue;
        try { const r = await runOrg(o.id, org, { env, send }); emails += r.emails; companies += 1; } catch (e) { errors.push(`${o.id}: ${String(e.message).slice(0, 120)}`); }
    }
    return { emails, companies, errors };
}

module.exports = { plan, signingDue, remindDay, runAll, runOrg, POLICY_DAYS, AUTO_SIGN_REMINDERS };
