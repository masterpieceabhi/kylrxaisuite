/**
 * Single sign-on settings (pure validation + a small lookup). Sign-in itself runs through Firebase
 * Authentication / Identity Platform OIDC or SAML providers that the owner configures in the
 * Firebase console; this module stores which provider a company uses, which email domains belong to
 * it, and whether password sign-in is switched off for everyone except break-glass accounts.
 */
const { rawCollection } = require('../config/firebase');

const PROVIDER_ID = /^(oidc|saml)\.[a-z0-9][a-z0-9-]{0,39}$/;
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateSettings(input) {
    const errors = [];
    const b = input || {};
    const value = { enabled: b.enabled === true, enforce: b.enforce === true };
    const pid = String(b.providerId || '').trim().toLowerCase();
    if (value.enabled) {
        if (!PROVIDER_ID.test(pid)) errors.push('providerId must look like oidc.entra or saml.okta (the provider id from Firebase Authentication)');
        else value.providerId = pid;
    } else if (PROVIDER_ID.test(pid)) value.providerId = pid;
    const domains = Array.isArray(b.allowedDomains) ? [...new Set(b.allowedDomains.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))] : [];
    if (domains.some((d) => !DOMAIN.test(d))) errors.push('allowedDomains has a value that is not a domain, for example "example.com"');
    else value.allowedDomains = domains;
    if (value.enabled && domains.length === 0) errors.push('Add at least one email domain that uses single sign-on');
    const breakGlass = Array.isArray(b.breakGlassEmails) ? [...new Set(b.breakGlassEmails.map((e) => String(e).trim().toLowerCase()).filter(Boolean))] : [];
    if (breakGlass.some((e) => !EMAIL.test(e))) errors.push('breakGlassEmails has an invalid email');
    else value.breakGlassEmails = breakGlass;
    if (value.enforce && !value.enabled) errors.push('Turn single sign-on on before requiring it');
    if (value.enforce && breakGlass.length === 0) errors.push('Keep at least one break-glass email that can still use a password, so an outage at the identity provider cannot lock everyone out');
    return { errors, value };
}

function domainOf(email) {
    const m = /@([^@\s]+)$/.exec(String(email || '').trim().toLowerCase());
    return m ? m[1] : null;
}

/** Which company and provider an email belongs to, or null (never returns company ids to the caller) */
async function discover(email) {
    const domain = domainOf(email);
    if (!domain) return null;
    const snap = await rawCollection('organizations').where('ssoSettings.allowedDomains', 'array-contains', domain).limit(3).get();
    const doc = snap.docs.find((d) => d.data().ssoSettings && d.data().ssoSettings.enabled);
    if (!doc) return null;
    const s = doc.data().ssoSettings;
    return { providerId: s.providerId, enforce: Boolean(s.enforce), orgId: doc.id };
}

/** True when this person may no longer sign in with a password */
async function passwordLoginBlocked(user) {
    if (!user || !user.orgId) return false;
    const snap = await rawCollection('organizations').doc(user.orgId).get();
    const exists = typeof snap.exists === 'function' ? snap.exists() : snap.exists;
    if (!exists) return false;
    const s = snap.data().ssoSettings;
    if (!s || !s.enabled || !s.enforce) return false;
    const email = String(user.email || '').toLowerCase();
    if ((s.breakGlassEmails || []).includes(email)) return false;
    return true;
}

module.exports = { PROVIDER_ID, validateSettings, domainOf, discover, passwordLoginBlocked };
