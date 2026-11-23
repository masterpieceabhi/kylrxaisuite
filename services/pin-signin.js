/**
 * Signing in with a PIN, with a code sent by email as the way back in.
 *
 *   1. start(email, pin, deviceToken)
 *        The PIN is right AND this device has signed in with a code before  ->  signed in.
 *        Anything else (wrong PIN, no PIN yet, a device we have not seen, an email we do not know)
 *                                                                           ->  answer "choose": where should the code go?
 *   2. requestCode(challenge, via, phone)
 *        via "email": the code goes to the email typed in step 1.
 *        via "phone": the person types their mobile number; the code is texted only when that number is the one
 *                     on their record. A code is never sent to a number or address that is not already on file.
 *   3. verifyCode(challenge, code)  ->  signed in; the device is remembered; a PIN may now be chosen.
 *   4. setPin(setupToken, pin)      ->  a new PIN, only right after a code was accepted.
 *
 * Why the device matters: a 4 to 6 digit PIN on its own could be guessed across many accounts ("1234" for everyone).
 * A PIN only signs in on a device that has already proved it can read the person's email, so the two together are
 * two checks. The answer to start() never says whether the PIN was right or the email exists; that is only told
 * after the code is accepted.
 *
 * Everything outside (people, codes, tokens, email) is passed in, so this file can be tested on its own.
 */
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const PIN_MAX_ATTEMPTS = 5;      // the same numbers as the shared-screen clock PIN (routes/time.js): it is the same PIN
const PIN_LOCK_MINUTES = 15;
const CODE_TTL_SECONDS = 600;
const CODE_MAX_ATTEMPTS = 5;
const MAX_DEVICES = 10;
const DUMMY_HASH = '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvali';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const cleanEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 254);
const looksLikeEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const validPin = (pin) => /^\d{4,6}$/.test(String(pin || ''));
/** A US mobile number as its ten digits (a leading 1 is dropped), or '' when it is not one. */
const tenDigits = (phone) => { const d = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? d : ''; };

/** Why a PIN may not be chosen, or null when it is fine. */
function weakPin(pin) {
    const p = String(pin || '');
    if (!validPin(p)) return 'A PIN is 4 to 6 digits.';
    if (/^(\d)\1+$/.test(p)) return 'Choose a PIN that is not one digit repeated.';
    const steps = p.split('').slice(1).map((d, i) => Number(d) - Number(p[i]));
    if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'Choose a PIN that is not a run like 1234.';
    return null;
}

function fail(status, code, message) { const e = new Error(message); e.status = status; e.code = code; return e; }

/**
 * deps:
 *   findPerson(email)        -> { uid, email, pinHash, pinAttempts, pinLockedUntil, signinDevices, active } or null
 *   savePerson(uid, patch)   -> stores fields on that person
 *   otp                      -> { generateOtp({identifier,purpose,ttlSeconds,maxAttempts}), verifyOtp({otpId,identifier,purpose,code}) }
 *   mintToken(uid)           -> a sign-in token for the browser (Firebase custom token)
 *   sendCode(email, code)    -> emails the code; resolves true when it was handed to a mail server
 *   sendText(phone, code)    -> texts the code to a +1XXXXXXXXXX number; resolves true when a provider took it
 *   sendWhatsApp(phone, code)-> sends the code by WhatsApp to that number; resolves true when a provider took it (optional)
 *   note(reason, detail)     -> a line for the server log when a code was NOT sent (never shown on the page; optional)
 *   secret                   -> signing secret for the short-lived tokens here
 *   showCode                 -> true only on a development server: the code is also returned to the page
 *   now()                    -> Date (tests)
 */
function create(deps) {
    const now = deps.now || (() => new Date());
    const sign = (payload, seconds) => jwt.sign(payload, deps.secret, { expiresIn: seconds });
    const read = (token, type) => {
        let d;
        try { d = jwt.verify(String(token || ''), deps.secret); } catch (_) { throw fail(401, 'expired', 'That took too long. Start again.'); }
        if (!d || d.type !== type) throw fail(401, 'expired', 'That took too long. Start again.');
        return d;
    };

    async function start({ email, pin, deviceToken }) {
        const address = cleanEmail(email);
        if (!looksLikeEmail(address)) throw fail(400, 'bad_input', 'Enter your email address.');
        const person = await deps.findPerson(address);
        const usable = person && person.uid && person.active !== false;

        // the PIN is always compared, against a dummy when there is nobody, so the time taken says nothing
        let pinOk = false;
        const locked = usable && person.pinLockedUntil && new Date(person.pinLockedUntil) > now();
        if (usable && person.pinHash && validPin(pin) && !locked) {
            pinOk = await bcrypt.compare(String(pin), person.pinHash);
            if (!pinOk) {
                const attempts = (person.pinAttempts || 0) + 1;
                await deps.savePerson(person.uid, attempts >= PIN_MAX_ATTEMPTS
                    ? { pinAttempts: 0, pinLockedUntil: new Date(now().getTime() + PIN_LOCK_MINUTES * 60000).toISOString() }
                    : { pinAttempts: attempts });
            } else if (person.pinAttempts) await deps.savePerson(person.uid, { pinAttempts: 0 });
        } else await bcrypt.compare(String(pin || ''), DUMMY_HASH);

        const known = usable && deviceToken && (person.signinDevices || []).some((d) => d && d.h === sha(deviceToken));
        if (pinOk && known) return { next: 'signed_in', token: await deps.mintToken(person.uid) };

        // everything else goes through a code; the answer is the same whether or not the person exists
        const choice = usable
            ? { type: 'signin_choose', uid: person.uid, email: address, pinOk, hasPin: Boolean(person.pinHash) }
            : { type: 'signin_choose', none: true, n: crypto.randomBytes(8).toString('hex') };
        return { next: 'choose', challenge: sign(choice, CODE_TTL_SECONDS), message: 'Choose where to get your sign-in code.' };
    }

    /** Sends the code by email or by text. The answer is the same whether or not anything was sent. */
    async function requestCode({ challenge, via, phone }) {
        const c = read(challenge, 'signin_choose');
        if (via === 'app') {
            // A code from an authenticator app (services/totp.js). Nothing is sent, and the answer does not say whether
            // this person has set an app up: that is only learnt by typing a code that works.
            const usableChoice = !c.none && c.uid;
            return {
                next: 'code', via: 'app', message: 'Open your authenticator app and type the 6-digit code for Onn HR.',
                challenge: sign(usableChoice ? { type: 'signin_code', uid: c.uid, email: c.email, pinOk: Boolean(c.pinOk), hasPin: Boolean(c.hasPin), via: 'app' }
                    : { type: 'signin_code', none: true, n: crypto.randomBytes(8).toString('hex') }, CODE_TTL_SECONDS)
            };
        }
        if (via !== 'email' && via !== 'phone' && via !== 'whatsapp') throw fail(400, 'bad_input', 'Choose email, text message, WhatsApp or authenticator app.');
        const byPhone = via === 'phone' || via === 'whatsapp';
        const typed = tenDigits(phone);
        if (byPhone && !typed) throw fail(400, 'bad_input', 'Enter your mobile number with its area code.');
        const note = (reason, detail) => { try { if (deps.note) deps.note(reason, { via, ...(detail || {}) }); } catch (_) { /* a log line never fails sign-in */ } };
        const out = {
            next: 'code', via,
            message: via === 'email' ? 'If that email is registered, a code is on its way to it. It works for 10 minutes.'
                : via === 'whatsapp' ? 'If that number is the one on your record, a code is on its way by WhatsApp. It works for 10 minutes.'
                    : 'If that number is the one on your record, a code is on its way by text. It works for 10 minutes.'
        };
        const nothing = () => { out.challenge = sign({ type: 'signin_code', none: true, n: crypto.randomBytes(8).toString('hex') }, CODE_TTL_SECONDS); return out; };
        if (c.none) { note('no_such_person'); return nothing(); }
        const person = await deps.findPerson(c.email);
        if (!person || person.uid !== c.uid || person.active === false) { note('person_not_usable'); return nothing(); }
        if (byPhone && !tenDigits(person.phone)) { note('no_mobile_on_record', { uid: person.uid }); return nothing(); }
        if (byPhone && tenDigits(person.phone) !== typed) { note('number_does_not_match_record', { uid: person.uid }); return nothing(); } // nothing is sent
        let made;
        try { made = deps.otp.generateOtp({ identifier: c.email, purpose: 'pin_signin', ttlSeconds: CODE_TTL_SECONDS, maxAttempts: CODE_MAX_ATTEMPTS }); }
        catch (e) { throw fail(429, 'slow_down', 'A code was just sent. Wait half a minute, then try again.'); }
        const send = via === 'email' ? deps.sendCode(c.email, made.code)
            : via === 'whatsapp' ? (deps.sendWhatsApp ? deps.sendWhatsApp(`+1${typed}`, made.code) : false)
                : deps.sendText(`+1${typed}`, made.code);
        const sent = await Promise.resolve(send).catch(() => false);
        if (!sent) note('provider_did_not_take_it', { uid: person.uid });
        out.challenge = sign({ type: 'signin_code', uid: person.uid, email: c.email, otpId: made.otpId, pinOk: Boolean(c.pinOk), hasPin: Boolean(c.hasPin), via }, CODE_TTL_SECONDS);
        if (deps.showCode) {
            out.devCode = made.code;
            out.devNote = sent ? 'Shown here because this is a development server.'
                : `${via === 'email' ? 'Email' : via === 'whatsapp' ? 'WhatsApp' : 'Text messaging'} is not set up on this server, so the code is shown here. A real server never shows it.`;
        }
        return out;
    }

    async function verifyCode({ challenge, code, deviceToken: held }) {
        const c = read(challenge, 'signin_code');
        const wrong = () => fail(401, 'wrong_code', 'That code is not right, or it has run out.');
        if (c.none || !/^\d{4,8}$/.test(String(code || ''))) throw wrong();
        let person;
        let appPatch = {};
        if (c.via === 'app') {
            person = await deps.findPerson(c.email);
            if (!person || person.uid !== c.uid || person.active === false) throw wrong();
            const t = person.totp;
            if (!t || !t.secret) throw wrong(); // no app set up: the same answer as a wrong code
            if (t.lockedUntil && new Date(t.lockedUntil) > now()) throw wrong();
            const r = deps.totp.verify(t.secret, code, now().getTime(), { lastCounter: t.lastCounter });
            if (!r.ok) {
                const attempts = (t.attempts || 0) + 1;
                await deps.savePerson(person.uid, attempts >= CODE_MAX_ATTEMPTS
                    ? { 'totp.attempts': 0, 'totp.lockedUntil': new Date(now().getTime() + PIN_LOCK_MINUTES * 60000).toISOString() }
                    : { 'totp.attempts': attempts });
                throw wrong();
            }
            appPatch = { 'totp.lastCounter': r.counter, 'totp.attempts': 0, 'totp.lockedUntil': null, 'totp.lastUsedAt': now().toISOString() };
        } else {
            const res = deps.otp.verifyOtp({ otpId: c.otpId, identifier: c.email, purpose: 'pin_signin', code: String(code) });
            if (!res || !(res.success || res.valid || res.verified)) throw wrong();
            person = await deps.findPerson(c.email);
            if (!person || person.uid !== c.uid || person.active === false) throw wrong();
        }

        // a device that already holds a token keeps it, so two people who share a screen do not push each other out
        const deviceToken = /^[a-f0-9]{64}$/.test(String(held || '')) ? String(held) : crypto.randomBytes(32).toString('hex');
        const devices = [{ h: sha(deviceToken), at: now().toISOString() }, ...(person.signinDevices || []).filter((d) => d && d.h !== sha(deviceToken))].slice(0, MAX_DEVICES);
        await deps.savePerson(person.uid, { signinDevices: devices, lastCodeSigninAt: now().toISOString(), ...appPatch });
        return {
            next: 'signed_in', token: await deps.mintToken(person.uid), deviceToken,
            hasPin: Boolean(person.pinHash), pinWasRight: Boolean(c.pinOk),
            setupToken: sign({ type: 'pin_setup', uid: person.uid }, CODE_TTL_SECONDS)
        };
    }

    async function setPin({ setupToken, pin }) {
        const s = read(setupToken, 'pin_setup');
        const why = weakPin(pin);
        if (why) throw fail(400, 'weak_pin', why);
        await deps.savePerson(s.uid, { pinHash: await bcrypt.hash(String(pin), 10), pinAttempts: 0, pinLockedUntil: null, pinSetAt: now().toISOString() });
        return { saved: true };
    }

    /**
     * Remembers this device for a person who has just proved who they are somewhere else (company sign-up, a personal
     * set-up link). Those steps hand the page a short-lived grant; the page brings it here, where the device cookie is
     * sent (its path is /api/auth/pin), so a device already known for other people keeps its one token.
     */
    async function rememberDevice({ grant, deviceToken: held }) {
        const g = read(grant, 'device_grant');
        const person = await deps.findPerson(cleanEmail(g.email));
        if (!person || person.uid !== g.uid || person.active === false) throw fail(401, 'expired', 'That took too long. Start again.');
        const deviceToken = /^[a-f0-9]{64}$/.test(String(held || '')) ? String(held) : crypto.randomBytes(32).toString('hex');
        const devices = [{ h: sha(deviceToken), at: now().toISOString() }, ...(person.signinDevices || []).filter((d) => d && d.h !== sha(deviceToken))].slice(0, MAX_DEVICES);
        await deps.savePerson(person.uid, { signinDevices: devices });
        return { remembered: true, deviceToken };
    }

    return { start, requestCode, verifyCode, setPin, rememberDevice };
}

/** The grant another step hands out for rememberDevice: ten minutes, one person. */
function deviceGrant(secret, uid, email) {
    return jwt.sign({ type: 'device_grant', uid, email: cleanEmail(email) }, secret, { expiresIn: CODE_TTL_SECONDS });
}

module.exports = { create, deviceGrant, weakPin, validPin, tenDigits, PIN_MAX_ATTEMPTS, PIN_LOCK_MINUTES, CODE_TTL_SECONDS };
