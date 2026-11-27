/**
 * Codes from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password and the like).
 *
 * The standard way these apps work (RFC 6238, "TOTP"): the app and the server share a secret, and both turn the
 * secret and the current half-minute into a 6-digit code. Nothing is sent anywhere, so it works with no mail server
 * and no text messages, and the code cannot be read off an email account.
 *
 * Settings used are the ones every app supports and assumes: SHA-1, 6 digits, 30 seconds.
 * No library: the whole algorithm is one HMAC.
 */
const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
    let bits = 0; let value = 0; let out = '';
    for (const byte of buf) {
        value = (value << 8) | byte; bits += 8;
        while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += B32[(value << (5 - bits)) & 31];
    return out;
}
function base32Decode(text) {
    const clean = String(text || '').toUpperCase().replace(/[\s=-]/g, '');
    if (!clean || /[^A-Z2-7]/.test(clean)) return null;
    let bits = 0; let value = 0; const out = [];
    for (const ch of clean) {
        value = (value << 5) | B32.indexOf(ch); bits += 5;
        if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    return Buffer.from(out);
}

/** A new secret: 20 random bytes, written the way authenticator apps take it (32 letters and digits) */
const newSecret = () => base32Encode(crypto.randomBytes(20));

const counterAt = (timeMs) => Math.floor(timeMs / 1000 / STEP_SECONDS);

/** The code for one half-minute. counter: the number of the half-minute since 1970. */
function codeFor(secret, counter) {
    const key = base32Decode(secret);
    if (!key || !key.length) return null;
    const msg = Buffer.alloc(8);
    msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
    msg.writeUInt32BE(counter >>> 0, 4);
    const h = crypto.createHmac('sha1', key).update(msg).digest();
    const o = h[h.length - 1] & 15;
    const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
    return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Is this the right code now?
 *   window: how many half-minutes either side of now are accepted (1: a phone clock half a minute off still works)
 *   lastCounter: the half-minute of the last code this person used. A code from that half-minute or earlier is
 *                refused, so a code read over someone's shoulder cannot be used a second time.
 * Returns { ok, counter } (counter: the half-minute the code belongs to, to store as the new lastCounter).
 */
function verify(secret, code, timeMs, { window = 1, lastCounter = null } = {}) {
    const typed = String(code || '').replace(/\s/g, '');
    if (!/^\d{6}$/.test(typed)) return { ok: false };
    const nowCounter = counterAt(timeMs);
    let found = null;
    for (let d = -window; d <= window; d += 1) { // every candidate is compared, so the time taken says nothing
        const c = nowCounter + d;
        const expected = codeFor(secret, c);
        if (expected && same(expected, typed) && (lastCounter === null || lastCounter === undefined || c > lastCounter)) found = found === null ? c : Math.max(found, c);
    }
    return found === null ? { ok: false } : { ok: true, counter: found };
}

/** What the app scans as a QR, or takes as a link: otpauth://totp/Onn%20HR:ann%40example.com?secret=...&issuer=Onn%20HR */
function otpauthUrl({ issuer = 'Onn HR', account, secret }) {
    const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(String(account || 'account'))}`;
    return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;
}

module.exports = { newSecret, codeFor, counterAt, verify, otpauthUrl, base32Encode, base32Decode, STEP_SECONDS, DIGITS };
