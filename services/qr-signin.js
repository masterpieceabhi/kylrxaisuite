/**
 * Signing in by scanning a personal, one-time QR.
 *
 *   1. createLink(target, actor)   HR or the owner makes a link for ONE person (or a signed-in person makes one for
 *                                  themself, to open another device). The answer carries the secret once; only its
 *                                  hash is kept. Making a new one cancels that person's unused older ones.
 *   2. open(secret)                The scanned page asks who the QR is for: first name, a masked email, the company.
 *                                  Nothing is used up, so a link preview or a second look does no harm.
 *   3. confirm(secret, device)     The person taps Confirm. The link is used up (it can never work twice), this
 *                                  device becomes a known device, and they are signed in. They may now choose a PIN.
 *   4. setPin(setupToken, pin)     The PIN, only right after a confirm.
 *
 * How this fits the PIN sign-in (services/pin-signin.js): a PIN only signs in on a device that has already proved who
 * the person is. There the proof is a code sent by email. Here it is a QR that someone allowed to manage the person
 * put in their hand. Either proof makes the device known, so the PIN is the quick way in from then on, whichever way
 * the person first came in. The fields written are the same ones the PIN sign-in reads (signinDevices, pinHash ...).
 *
 * What a QR is: whoever holds it, until it is used or runs out, IS that person. So it lives a short time (a day by
 * default, three at most), works once, is cancelled by a newer one, cannot be made for someone the maker could not
 * otherwise manage, and every making and every use is written to the audit log by the routes.
 *
 * Everything outside (storage, people, tokens) is passed in, so this file can be tested on its own.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { weakPin } = require('./pin-signin');

const DEFAULT_HOURS = 24;
const MAX_HOURS = 72;
const MAX_DEVICES = 10;          // the same as the PIN sign-in
const SETUP_SECONDS = 600;       // time to choose a PIN after a confirm
const KEEP_DAYS = 30;            // how long a finished link's record is kept (the audit log keeps the history)
const TIDY_BATCH = 200;
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
function fail(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }
const GONE = () => fail(404, 'qr_not_valid', 'This QR code no longer works. Ask for a new one.');

/** "carlos@example.com" -> "ca•••@example.com": enough to recognise your own address, not enough to learn someone else's */
function maskEmail(email) {
    const [name, domain] = String(email || '').split('@');
    if (!name || !domain) return '';
    return `${name.slice(0, Math.min(2, Math.max(1, name.length - 1)))}•••@${domain}`;
}
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';

/**
 * deps:
 *   links.put(id, doc)             stores a link under its id (the hash of the secret)
 *   links.get(id)                  -> the link or null
 *   links.use(id, patch)           -> true when THIS call used the link up; false when it was already used (atomic)
 *   links.cancelOpen(uid, patch)   marks that person's unused links cancelled; resolves how many
 *   links.removeExpiredBefore(iso, max)  optional: deletes up to max links that ran out before that time
 *   loadPerson(uid)                -> { uid, orgId, name, email, active, pinHash, signinDevices, companyName } or null
 *   savePerson(uid, patch)
 *   mintToken(uid)                 -> a sign-in token for the browser (Firebase custom token)
 *   secret                         signing secret for the short-lived PIN set-up token
 *   now()                          -> Date (tests)
 */
function create(deps) {
    const now = deps.now || (() => new Date());

    // Links that ran out more than KEEP_DAYS ago are of no use to anyone (a link lives three days at most, so that
    // covers used and cancelled ones too). They are removed a few at a time, at most once an hour, when a new link
    // is made. Never awaited and never allowed to fail the request: it is housekeeping.
    let lastTidy = 0;
    function tidy() {
        const t = now().getTime();
        if (!deps.links.removeExpiredBefore || t - lastTidy < 3600000) return null;
        lastTidy = t;
        return Promise.resolve().then(() => deps.links.removeExpiredBefore(new Date(t - KEEP_DAYS * 86400000).toISOString(), TIDY_BATCH)).catch(() => 0);
    }

    async function createLink({ uid, actorId, hours }) {
        const person = await deps.loadPerson(uid);
        if (!person || !person.uid) throw fail(404, 'not_found', 'Person not found');
        if (person.active === false) throw fail(409, 'inactive', 'This person no longer works here, so they cannot be given a way in.');
        if (!person.email) throw fail(409, 'no_signin', 'This person has no sign-in yet. Add them with their email first.');
        let h = hours === undefined || hours === null || hours === '' ? DEFAULT_HOURS : Number(hours);
        if (!Number.isFinite(h) || h < 1 || h > MAX_HOURS) throw fail(400, 'bad_input', `hours must be between 1 and ${MAX_HOURS}`);
        h = Math.round(h);
        const secret = crypto.randomBytes(32).toString('base64url');
        const at = now();
        const expiresAt = new Date(at.getTime() + h * 3600000).toISOString();
        await deps.links.cancelOpen(person.uid, { cancelledAt: at.toISOString(), cancelledBy: actorId || null, cancelReason: 'replaced' });
        tidy();
        await deps.links.put(sha(secret), { orgId: person.orgId, uid: person.uid, createdBy: actorId || null, forSelf: actorId === person.uid, createdAt: at.toISOString(), expiresAt, usedAt: null, cancelledAt: null });
        return { secret, expiresAt, hours: h, person: { id: person.uid, name: person.name || null, emailHint: maskEmail(person.email) } };
    }

    /** The link and its person when the secret is good right now; otherwise the one "no longer works" answer */
    async function live(secret) {
        if (!SECRET_RE.test(String(secret || ''))) throw GONE();
        const id = sha(secret);
        const link = await deps.links.get(id);
        if (!link || link.usedAt || link.cancelledAt || !(new Date(link.expiresAt) > now())) throw GONE();
        const person = await deps.loadPerson(link.uid);
        if (!person || person.active === false || person.orgId !== link.orgId) throw GONE();
        return { id, link, person };
    }

    async function open({ secret }) {
        const { link, person } = await live(secret);
        return { name: firstName(person.name), emailHint: maskEmail(person.email), company: person.companyName || null, expiresAt: link.expiresAt, hasPin: Boolean(person.pinHash) };
    }

    async function confirm({ secret, deviceToken: held }) {
        const { id, link, person } = await live(secret);
        const at = now().toISOString();
        if (!(await deps.links.use(id, { usedAt: at }))) throw GONE(); // someone else used it in the same moment
        // a device that already holds a token keeps it, so two people who share a screen do not push each other out
        const deviceToken = /^[a-f0-9]{64}$/.test(String(held || '')) ? String(held) : crypto.randomBytes(32).toString('hex');
        const devices = [{ h: sha(deviceToken), at }, ...(person.signinDevices || []).filter((d) => d && d.h !== sha(deviceToken))].slice(0, MAX_DEVICES);
        await deps.savePerson(person.uid, { signinDevices: devices, lastQrSigninAt: at });
        return {
            next: 'signed_in', token: await deps.mintToken(person.uid), deviceToken, uid: person.uid, orgId: person.orgId,
            madeBy: link.createdBy || null, forSelf: Boolean(link.forSelf),
            hasPin: Boolean(person.pinHash),
            setupToken: jwt.sign({ type: 'qr_pin_setup', uid: person.uid }, deps.secret, { expiresIn: SETUP_SECONDS })
        };
    }

    async function setPin({ setupToken, pin }) {
        let d;
        try { d = jwt.verify(String(setupToken || ''), deps.secret); } catch (_) { d = null; }
        if (!d || d.type !== 'qr_pin_setup' || !d.uid) throw fail(401, 'expired', 'That took too long. Sign in again to choose a PIN.');
        const why = weakPin(pin);
        if (why) throw fail(400, 'weak_pin', why);
        const person = await deps.loadPerson(d.uid);
        if (!person || person.active === false) throw fail(401, 'expired', 'That took too long. Sign in again to choose a PIN.');
        await deps.savePerson(d.uid, { pinHash: await bcrypt.hash(String(pin), 10), pinAttempts: 0, pinLockedUntil: null, pinSetAt: now().toISOString() });
        return { saved: true, uid: d.uid, orgId: person.orgId };
    }

    /** Cancel a person's unused links (they lost the printout, or it was made by mistake) */
    async function cancel({ uid, actorId }) {
        const n = await deps.links.cancelOpen(uid, { cancelledAt: now().toISOString(), cancelledBy: actorId || null, cancelReason: 'cancelled' });
        return { cancelled: n };
    }

    return { createLink, open, confirm, setPin, cancel, _tidy: tidy };
}

module.exports = { create, maskEmail, DEFAULT_HOURS, MAX_HOURS, KEEP_DAYS };
