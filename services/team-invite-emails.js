/**
 * Emails for adding people (routes/us-people.js team import, routes/team-access-public.js join link):
 *
 *   setupLinkEmail     a new person's personal set-up link, to that person's own address only
 *   joinRequestNotice  "someone asked to join": to the owner and HR (people.write), with a link to the waiting list
 *   joinApprovedEmail  "you are in": to the approved person, with how to sign in
 *
 * A set-up link is a secret (whoever has it gets into that account), so like a signing link it is sent straight away by
 * the route and never goes through events or webhooks. The notice to HR holds the person's name only, no email or phone.
 * The same off switches as every email notice (services/email-notices.js sendNow): no email set up, NOTICES_EMAIL=off,
 * or the company has noticesEmail: false. Sending never stops the action that asked for it, and a failure is only logged.
 */
const N = require('./email-notices');

const appUrl = (env = process.env) => String(env.APP_URL || 'https://app.onnhr.com').replace(/\/+$/, '');
const sign = (company) => `${company ? `${company} on ` : ''}Onn HR`;
const clip = (s, n) => String(s || '').replace(/[\r\n]+/g, ' ').trim().slice(0, n);

async function loadOrg(orgId) {
    const snap = await require('../config/firebase').rawCollection('organizations').doc(orgId).get();
    return (typeof snap.exists === 'function' ? snap.exists() : snap.exists) ? snap.data() : {};
}

const setupUrl = (token, env) => `${appUrl(env)}/join.html#s=${token}`;

function setupLinkEmail({ name, email, url, expiresAt, company }) {
    if (!email || !url) return null;
    const who = clip(company, 120) || 'Your employer';
    const until = expiresAt ? ` It works once, until ${N.DAY(expiresAt)}.` : ' It works once.';
    return {
        to: email,
        subject: `${who} added you to Onn HR: set up your sign-in`.slice(0, 180),
        text: `Hi ${N.firstName({ name })},\n\n${who} uses Onn HR for hours, time off, pay papers and documents, and added you to it.\n\nSet up your sign-in here (you choose a PIN, it takes a minute):\n${url}\n\nThe link is only for you: please do not forward it.${until} If it runs out, ask ${company ? clip(company, 120) : 'your employer'} for a new one.\n\n${sign(clip(company, 120))}\nIf you do not work there, you can ignore this email.`
    };
}

function joinRequestNotice({ to, requesterName, company, env }) {
    if (!to || !to.length) return null;
    const who = clip(requesterName, 120) || 'Someone';
    return {
        to,
        subject: `${who} asked to join ${clip(company, 100) || 'your company'} on Onn HR`.slice(0, 180),
        text: `${who} used your company join link and is waiting for your approval.\n\nThey cannot sign in or see anything until you approve them. Approve only people you know work for you:\n${appUrl(env)}/admin-us-team-import.html#waitCard\n\n${sign(clip(company, 120))}`
    };
}

function joinApprovedEmail({ name, email, company, env }) {
    if (!email) return null;
    const who = clip(company, 120) || 'Your employer';
    return {
        to: email,
        subject: `You're in: ${who} approved you on Onn HR`.slice(0, 180),
        text: `Hi ${N.firstName({ name })},\n\n${who} approved your request to join. You can sign in now:\n${appUrl(env)}/login.html\n\nType your email, press "No PIN, or forgot it?", enter the code we send you, and choose a PIN.\n\n${sign(clip(company, 120))}`
    };
}

/** The owner and HR administrators of a company (people.write), active and with an email. `people` as N.loadCompany gives. */
function reviewers(people) {
    const { can } = require('./permissions');
    return [...new Set((people || []).filter((p) => N.active(p) && can(p, 'people.write')).map((p) => String(p.email).toLowerCase()))].slice(0, 20);
}

/** Emails each new person their set-up link. items: [{ name, email, token, expiresAt }]. Resolves to the emails sent to. */
async function sendSetupLinks(orgId, items, { env = process.env, send, org } = {}) {
    if (!N.emailReady(env) || !items || !items.length) return new Set();
    const o = org || (await loadOrg(orgId).catch(() => ({})));
    if (o.noticesEmail === false) return new Set();
    const company = N.companyName(o);
    const done = new Set();
    for (const it of items) {
        const m = setupLinkEmail({ name: it.name, email: it.email, url: setupUrl(it.token, env), expiresAt: it.expiresAt, company });
        if (m && (await N.sendNow(orgId, [m], { env, send, org: o })) > 0) done.add(it.email);
    }
    return done;
}

async function notifyJoinRequest(orgId, requesterName, { env = process.env, send, load } = {}) {
    if (!N.emailReady(env)) return 0;
    try {
        const { org, people } = load ? await load(orgId) : await N.loadCompany(orgId);
        return await N.sendNow(orgId, [joinRequestNotice({ to: reviewers(people), requesterName, company: N.companyName(org), env })], { env, send, org });
    } catch (_) { return 0; }
}

async function sendApproved(orgId, person, { env = process.env, send, org } = {}) {
    if (!N.emailReady(env)) return 0;
    try {
        const o = org || (await loadOrg(orgId));
        return await N.sendNow(orgId, [joinApprovedEmail({ name: person.name, email: person.email, company: N.companyName(o), env })], { env, send, org: o });
    } catch (_) { return 0; }
}

module.exports = { setupLinkEmail, joinRequestNotice, joinApprovedEmail, reviewers, setupUrl, sendSetupLinks, notifyJoinRequest, sendApproved };
