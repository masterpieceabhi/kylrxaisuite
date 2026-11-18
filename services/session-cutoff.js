/**
 * Ending the sessions a person already has.
 *
 * A sign-in token is good until it runs out: up to an hour for a Firebase ID token, and it carries the role it was
 * made with. Revoking the refresh token (which the role and access routes already do) stops a NEW token being
 * made, but the one in hand keeps working. So when a person's role is changed or their sign-in is reset, the server
 * also writes the moment on their record (`sessionsValidAfter`), and the sign-in check on every request refuses
 * any token made before it. The person signs in again and gets a token with the new role.
 *
 * The record is already read on every request, so this costs nothing extra. The field is one a browser cannot
 * write (firestore.rules, serverKeptUserFields).
 */
const SKEW_MS = 5000; // the token's clock (Google's) and this server's may differ by a little

/** The field to merge into the person's record when their sessions must end now */
function stamp(now = new Date()) {
    return { sessionsValidAfter: now.toISOString() };
}

/**
 * decoded: the verified token ({ iat, auth_time } in seconds). user: the stored person record.
 * true when the token was made before the person's sessions were ended.
 */
function tokenTooOld(decoded, user) {
    const cut = user && user.sessionsValidAfter ? Date.parse(user.sessionsValidAfter) : NaN;
    if (!Number.isFinite(cut)) return false;
    const iat = decoded && Number(decoded.iat);
    if (!Number.isFinite(iat) || iat <= 0) return true; // a cutoff is set and the token cannot say when it was made
    return iat * 1000 + SKEW_MS < cut;
}

module.exports = { stamp, tokenTooOld, SKEW_MS };
