/**
 * A person sets up an authenticator app for their own sign-in (the codes themselves are in services/totp.js).
 *
 *   1. begin(person)            a new secret, kept as "pending" on the person's record; the answer carries it once,
 *                               as text and as the otpauth:// link an app scans as a QR
 *   2. confirm(person, code)    the person types the code their app now shows; only then is the app switched on.
 *                               This proves the secret really reached an app before it can lock anyone out.
 *   3. remove(person, code)     switched off again, with a current code from the app
 *
 * On the person's record (users/{uid}.totp):
 *   { pendingEnc, pendingAt }                              set-up started, not confirmed
 *   { secretEnc, enabledAt, lastCounter, attempts, lockedUntil, lastUsedAt }   in use
 * The secret is encrypted with the same key that protects SSNs (services/pii-crypto.js) and is never sent anywhere
 * after the one answer of begin(). A browser cannot read or write these fields (firestore.rules).
 *
 * Signing in with it is the "app" choice of the PIN sign-in (services/pin-signin.js): the app code takes the place
 * of the emailed or texted code, so it works on a server with no mail and no text messages.
 */
const totp = require('./totp');

const PENDING_MINUTES = 15;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;
function fail(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const ctx = (uid) => `${uid}:totp`;

/**
 * deps: { encrypt(plain, context), decrypt(payload, context), save(uid, patch), now() }
 * person: { uid, email, totp } where totp is the stored object (or undefined)
 */
function create(deps) {
    const now = deps.now || (() => new Date());

    function statusOf(person) {
        const t = (person && person.totp) || {};
        return { enabled: Boolean(t.secretEnc && t.enabledAt), since: t.enabledAt || null, lastUsedAt: t.lastUsedAt || null };
    }

    async function begin(person) {
        if (!person || !person.uid) throw fail(404, 'not_found', 'Person not found');
        if (statusOf(person).enabled) throw fail(409, 'already_on', 'An authenticator app is already set up. Remove it first to set up another.');
        const secret = totp.newSecret();
        await deps.save(person.uid, { 'totp.pendingEnc': deps.encrypt(secret, ctx(person.uid)), 'totp.pendingAt': now().toISOString() });
        return { secret, otpauthUrl: totp.otpauthUrl({ account: person.email || 'account', secret }), minutes: PENDING_MINUTES, shownOnce: true };
    }

    async function confirm(person, code) {
        const t = (person && person.totp) || {};
        if (statusOf(person).enabled) throw fail(409, 'already_on', 'An authenticator app is already set up.');
        const fresh = t.pendingEnc && t.pendingAt && now().getTime() - Date.parse(t.pendingAt) <= PENDING_MINUTES * 60000;
        if (!fresh) throw fail(409, 'start_again', 'Start the set-up again: it was not finished in time.');
        const secret = deps.decrypt(t.pendingEnc, ctx(person.uid));
        const r = totp.verify(secret, code, now().getTime());
        if (!r.ok) throw fail(400, 'wrong_code', 'That code is not right. Type the 6-digit code your app shows now.');
        await deps.save(person.uid, {
            totp: { secretEnc: deps.encrypt(secret, ctx(person.uid)), enabledAt: now().toISOString(), lastCounter: r.counter, attempts: 0, lockedUntil: null, lastUsedAt: null }
        });
        return { enabled: true };
    }

    async function remove(person, code) {
        const t = (person && person.totp) || {};
        if (!statusOf(person).enabled) {
            if (t.pendingEnc) await deps.save(person.uid, { totp: null }); // an unfinished set-up is simply dropped
            return { enabled: false };
        }
        if (t.lockedUntil && new Date(t.lockedUntil) > now()) throw fail(423, 'locked', 'Too many wrong codes. Try again in a few minutes.');
        const r = totp.verify(deps.decrypt(t.secretEnc, ctx(person.uid)), code, now().getTime(), { lastCounter: t.lastCounter });
        if (!r.ok) {
            const attempts = (t.attempts || 0) + 1;
            await deps.save(person.uid, attempts >= MAX_ATTEMPTS ? { 'totp.attempts': 0, 'totp.lockedUntil': new Date(now().getTime() + LOCK_MINUTES * 60000).toISOString() } : { 'totp.attempts': attempts });
            throw fail(400, 'wrong_code', 'That code is not right. Type the 6-digit code your app shows now.');
        }
        await deps.save(person.uid, { totp: null });
        return { enabled: false };
    }

    /** Someone who may manage this person switches their app off (the phone is lost). No code: that is the point. */
    async function removeFor(person) {
        const had = statusOf(person).enabled;
        await deps.save(person.uid, { totp: null });
        return { enabled: false, wasEnabled: had };
    }

    return { statusOf, begin, confirm, remove, removeFor };
}

/* ------------------------------- the real thing ------------------------------- */

const realDeps = () => {
    const { rawCollection } = require('../config/firebase');
    const { encryptField, decryptField } = require('./pii-crypto');
    const FV = () => require('../config/firebase-admin').firestore.FieldValue;
    return {
        encrypt: encryptField, decrypt: decryptField,
        // a patch of { totp: null } removes the whole object; dotted keys change one field
        save: (uid, patch) => rawCollection('users').doc(String(uid)).update(Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, k === 'totp' && v === null ? FV().delete() : v])))
    };
};
let real = null;
const service = () => { if (!real) real = create(realDeps()); return real; };

/**
 * For the sign-in: the decrypted secret and its counters, or null when no app is set up or the secret cannot be read
 * (a changed encryption key must not break sign-in by email or text).
 */
function forSignin(uid, stored) {
    const t = stored || {};
    if (!t.secretEnc || !t.enabledAt) return null;
    try {
        const secret = require('./pii-crypto').decryptField(t.secretEnc, ctx(uid));
        return secret ? { secret, lastCounter: t.lastCounter === undefined ? null : t.lastCounter, attempts: t.attempts || 0, lockedUntil: t.lockedUntil || null } : null;
    } catch (_) { return null; }
}

module.exports = { create, service, forSignin, PENDING_MINUTES };
