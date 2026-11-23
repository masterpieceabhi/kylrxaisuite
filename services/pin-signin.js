/**
 * Signing in with a PIN, with a code sent by email as the way back in.
 *
 *   1. start(login, secret, deviceToken)       login: an email OR a US mobile number on record; secret: a PIN OR a password
 *        The password or the PIN is right                                   ->  signed in (on any device)
 *        Something else was typed (wrong, locked, or someone we do not know) ->  "try again"; nothing is sent
 *        Nothing was typed ("Forgot password or PIN?")                      ->  a code is sent at once (see below)
 *        A mobile number finds the person only when exactly one active person has it on record; otherwise it is
 *        treated like an unknown email (same answer, nothing sent).
 *      When a code is needed it is SENT AT ONCE, the person's way: their choice in My details (codeVia), else the phone
 *      when they signed in with their mobile number (WhatsApp if they used it last on this device, else text), else
 *      email. The answer never says which way, so it says nothing about the account. "Send it another way" is step 2.
 *      On a device the person used before, a wrong PIN or password only says "try again" (a typo should not send a code).
 *   2. requestCode(challenge, via, phone)
 *        via "email": the code goes to the email typed in step 1.
 *        via "phone": the person types their mobile number; the code is texted only when that number is the one
 *                     on their record. A code is never sent to a number or address that is not already on file.
 *   3. verifyCode(challenge, code)  ->  signed in; the device is remembered; a PIN may now be chosen.
 *      verifyLink(link)              ->  the same, from the one-tap link in the same email, text or WhatsApp message.
 *                                        A link works once, for 10 minutes, and is tied to the code: whichever is used
 *                                        first, the other stops working. Only a hash of the link is kept, in memory
 *                                        like the codes themselves.
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
 *   findPersonByPhone(ten)   -> the one person with that mobile on record (same shape as findPerson), or null (optional)
 *   checkPassword(email, pw) -> true when that is the person's password (optional; without it a password just leads to a code)
 *   sendCode(email, code)    -> emails the code; resolves true when it was handed to a mail server
 *   sendCode(email, code, link), sendText(phone, code, link), sendWhatsApp(phone, code, link): link is the one-tap address
 *   linkUrl(id)              -> the full address of a one-tap link (optional; without it no link is sent)
 *   sendText(phone, code)    -> texts the code to a +1XXXXXXXXXX number; resolves true when a provider took it
 *   sendWhatsApp(phone, code)-> sends the code by WhatsApp to that number; resolves true when a provider took it (optional)
 *   note(reason, detail)     -> a line for the server log when a code was NOT sent (never shown on the page; optional)
 *   secret                   -> signing secret for the short-lived tokens here
 *   showCode                 -> true only on a development server: the code is also returned to the page
 *   now()                    -> Date (tests)
 */
function create(deps) {
    const links = new Map(); // sha(link id) -> { payload, code, expiresAt }: one-tap links, kept like the codes, in memory
    const makeLink = (payload, code) => {
        if (!deps.linkUrl) return null;
        const t = now().getTime();
        for (const [k, v] of links) if (v.expiresAt < t) links.delete(k);
        if (links.size > 5000) links.clear();
        const id = crypto.randomBytes(18).toString('base64url');
        links.set(sha(id), { payload, code, expiresAt: t + CODE_TTL_SECONDS * 1000 });
        return deps.linkUrl(id);
    };
    const now = deps.now || (() => new Date());
    const sign = (payload, seconds) => jwt.sign(payload, deps.secret, { expiresIn: seconds });
    const read = (token, type) => {
        let d;
        try { d = jwt.verify(String(token || ''), deps.secret); } catch (_) { throw fail(401, 'expired', 'That took too long. Start again.'); }
        if (!d || d.type !== type) throw fail(401, 'expired', 'That took too long. Start again.');
        return d;
    };

    async function start({ email, login, pin, deviceToken, prefer }) {
        const typed = String(login || email || '').trim();
        const byEmail = looksLikeEmail(cleanEmail(typed));
        const phone = byEmail ? '' : tenDigits(typed);
        if (!byEmail && !phone) throw fail(400, 'bad_input', 'Enter your email address or mobile number.');
        let person = null;
        if (byEmail) person = await deps.findPerson(cleanEmail(typed));
        else if (deps.findPersonByPhone) person = await deps.findPersonByPhone(phone);
        const address = person && person.email ? cleanEmail(person.email) : (byEmail ? cleanEmail(typed) : '');
        const usable = person && person.uid && person.active !== false;
        const locked = usable && person.pinLockedUntil && new Date(person.pinLockedUntil) > now();
        const secret = String(pin || '');
        const wrongTry = async () => {
            const attempts = (person.pinAttempts || 0) + 1;
            await deps.savePerson(person.uid, attempts >= PIN_MAX_ATTEMPTS
                ? { pinAttempts: 0, pinLockedUntil: new Date(now().getTime() + PIN_LOCK_MINUTES * 60000).toISOString() }
                : { pinAttempts: attempts });
        };

        // a password (anything that is not a 4-6 digit PIN): right -> signed in on any device; wrong -> counts like a wrong PIN
        if (secret && !validPin(secret) && usable && !locked && deps.checkPassword) {
            const ok = await Promise.resolve(deps.checkPassword(address, secret)).catch(() => false);
            if (ok) {
                if (person.pinAttempts) await deps.savePerson(person.uid, { pinAttempts: 0 });
                return { next: 'signed_in', token: await deps.mintToken(person.uid) };
            }
            await wrongTry();
        }

        // the PIN is always compared, against a dummy when there is nobody, so the time taken says nothing
        let pinOk = false;
        if (usable && person.pinHash && validPin(secret) && !locked) {
            pinOk = await bcrypt.compare(secret, person.pinHash);
            if (!pinOk) await wrongTry();
            else if (person.pinAttempts) await deps.savePerson(person.uid, { pinAttempts: 0 });
        } else await bcrypt.compare(secret, DUMMY_HASH);

        // a right PIN signs in on any device (decided 2026-11-22: "either should work"), like a right password
        if (pinOk) return { next: 'signed_in', token: await deps.mintToken(person.uid) };
        // something was typed and it was not right (or the person is unknown, or locked): try again, nothing is sent.
        // A code is sent only when they ask for one ("Forgot password or PIN?" sends an empty box).
        // one wording for every refusal, a locked PIN included: "locked" would tell a stranger that the account exists
        if (secret) return { next: 'retry', message: 'That did not work. Try again, or press "Forgot password or PIN?" to get a code.', ...(deps.showCode && !usable ? { devNote: 'Local only: there is no active account with that email or number in this test database. Use a demo account.' } : {}) };

        // everything else goes through a code, sent at once; the answer is the same whether or not the person exists
        const choice = usable
            ? { type: 'signin_choose', uid: person.uid, email: address, pinOk, hasPin: Boolean(person.pinHash) }
            : { type: 'signin_choose', none: true, n: crypto.randomBytes(8).toString('hex') };
        const choiceToken = sign(choice, CODE_TTL_SECONDS);
        if (!deps.autoSend) return { next: 'choose', challenge: choiceToken, message: 'Choose where to get your sign-in code.' };
        const via = usable ? pickWay(person, { byPhone: Boolean(phone), prefer }) : 'email';
        const sent = await requestCode({ challenge: choiceToken, via, phone: via === 'email' ? undefined : person.phone }).catch((e) => { if (e && e.code === 'slow_down') throw e; return null; });
        if (!sent) return { next: 'choose', challenge: choiceToken, message: 'Choose where to get your sign-in code.' };
        return { next: 'code', challenge: sent.challenge, choice: choiceToken, message: 'We sent you a sign-in code, the way you chose (email, text or WhatsApp). It works for 10 minutes.', ...(sent.devCode ? { devCode: sent.devCode, devNote: sent.devNote } : {}), ...(sent.devLink ? { devLink: sent.devLink } : {}) };
    }

    /** The way a code goes when nobody chose on the page: My details, then how they signed in, then email. */
    function pickWay(person, { byPhone, prefer }) {
        const ways = deps.ways ? deps.ways() : { text: true, whatsapp: Boolean(deps.sendWhatsApp) };
        const has = (w) => w === 'email' || (Boolean(tenDigits(person.phone)) && (w === 'phone' ? ways.text : w === 'whatsapp' ? ways.whatsapp : false));
        if (person.codeVia && has(person.codeVia)) return person.codeVia;
        if (byPhone) {
            if (prefer === 'whatsapp' && has('whatsapp')) return 'whatsapp';
            if (has('phone')) return 'phone';
            if (has('whatsapp')) return 'whatsapp';
        }
        return 'email';
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
            message: via === 'email' ? 'If you have an account, a code is on its way to the email on it. It works for 10 minutes.'
                : via === 'whatsapp' ? 'If that number is the one on your record, a code is on its way by WhatsApp. It works for 10 minutes.'
                    : 'If that number is the one on your record, a code is on its way by text. It works for 10 minutes.'
        };
        const nothing = () => {
            out.challenge = sign({ type: 'signin_code', none: true, n: crypto.randomBytes(8).toString('hex') }, CODE_TTL_SECONDS);
            // only a development server says why nothing came (a real one gives the same answer either way)
            if (deps.showCode) { out.devCode = undefined; out.devNote = 'Local only: no code was made, because there is no active account with that email or number in this test database. Use a demo account.'; }
            return out;
        };
        if (c.none) { note('no_such_person'); return nothing(); }
        const person = await deps.findPerson(c.email);
        if (!person || person.uid !== c.uid || person.active === false) { note('person_not_usable'); return nothing(); }
        if (byPhone && !tenDigits(person.phone)) { note('no_mobile_on_record', { uid: person.uid }); return nothing(); }
        if (byPhone && tenDigits(person.phone) !== typed) { note('number_does_not_match_record', { uid: person.uid }); return nothing(); } // nothing is sent
        let made;
        try { made = deps.otp.generateOtp({ identifier: c.email, purpose: 'pin_signin', ttlSeconds: CODE_TTL_SECONDS, maxAttempts: CODE_MAX_ATTEMPTS }); }
        catch (e) { throw fail(429, 'slow_down', 'A code was just sent. Wait half a minute, then try again.'); }
        const payload = { type: 'signin_code', uid: person.uid, email: c.email, otpId: made.otpId, pinOk: Boolean(c.pinOk), hasPin: Boolean(c.hasPin), via };
        const link = makeLink(payload, made.code);
        const send = via === 'email' ? deps.sendCode(c.email, made.code, link)
            : via === 'whatsapp' ? (deps.sendWhatsApp ? deps.sendWhatsApp(`+1${typed}`, made.code, link) : false)
                : deps.sendText(`+1${typed}`, made.code, link);
        const sent = await Promise.resolve(send).catch(() => false);
        if (!sent) note('provider_did_not_take_it', { uid: person.uid });
        out.challenge = sign(payload, CODE_TTL_SECONDS);
        if (deps.showCode && link) out.devLink = link;
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

    /** The one-tap link from a code message: used once, then it is gone; a used or typed code ends it too. */
    async function verifyLink({ link, deviceToken }) {
        const used = fail(401, 'link_used', 'This sign-in link has been used or has run out. Ask for a new code.');
        const key = sha(String(link || ''));
        const entry = links.get(key);
        links.delete(key);
        if (!entry || !/^[A-Za-z0-9_-]{20,40}$/.test(String(link || '')) || entry.expiresAt < now().getTime()) throw used;
        try { return await verifyCode({ challenge: sign(entry.payload, CODE_TTL_SECONDS), code: entry.code, deviceToken }); }
        catch (e) { if (e && e.code === 'wrong_code') throw used; throw e; }
    }

    return { start, requestCode, verifyCode, verifyLink, setPin, rememberDevice };
}

/** The grant another step hands out for rememberDevice: ten minutes, one person. */
function deviceGrant(secret, uid, email) {
    return jwt.sign({ type: 'device_grant', uid, email: cleanEmail(email) }, secret, { expiresIn: CODE_TTL_SECONDS });
}

module.exports = { create, deviceGrant, weakPin, validPin, tenDigits, PIN_MAX_ATTEMPTS, PIN_LOCK_MINUTES, CODE_TTL_SECONDS };
