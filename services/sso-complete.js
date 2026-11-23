/**
 * Finishing a single sign-on (SSO) sign-in on the server.
 *
 * The browser signs in at the company's identity provider (Microsoft Entra ID, Okta, Google Workspace...) through
 * Firebase Identity Platform. That creates or reuses a Firebase account for the provider, which is NOT the person's
 * Onn HR account (that one signs in with a PIN). The browser cannot look the person up itself (the database rules
 * let it read only its own record), so it sends the provider's Firebase ID token here, and this:
 *
 *   1. checks the token (signature, expiry) and that it came from an OIDC or SAML provider,
 *   2. checks that the email's domain belongs to a company with SSO switched on, through THAT company's provider,
 *   3. finds the active person with that email inside that company (never in another company),
 *   4. answers with a one-time sign-in token for the person's own account, the same kind PIN sign-in uses,
 *   5. deletes the provider's separate Firebase account when it is not the person's own, so no second login lingers.
 *
 * Everything outside is passed in (verifyIdToken, findPerson, mintToken, deleteUser, discover), so the rules here
 * can be tested alone. Refusals are worded the same whatever the reason past the provider check, so the answer does
 * not reveal who works where.
 */
const STATUS_GONE = /^(terminated|inactive|offboarded|suspended|disabled|ended)$/i;

function fail(status, code, error) { return Object.assign(new Error(error), { status, code }); }

async function complete(idToken, deps) {
    if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 8000) throw fail(400, 'bad_token', 'The sign-in did not finish. Try again.');
    let decoded;
    try { decoded = await deps.verifyIdToken(idToken); } catch (_) { throw fail(401, 'bad_token', 'The sign-in did not finish. Try again.'); }
    const provider = decoded && decoded.firebase && decoded.firebase.sign_in_provider;
    if (!/^(oidc|saml)\./.test(String(provider || ''))) throw fail(401, 'not_sso', 'This was not a company single sign-on.');
    const email = String(decoded.email || (decoded.firebase.identities && decoded.firebase.identities.email && decoded.firebase.identities.email[0]) || '').trim().toLowerCase();
    if (!email) throw fail(403, 'no_email', 'Your company sign-in did not share your email address. Ask your IT team to send the email claim.');

    const NO = fail(403, 'no_account', `No Onn HR account is set up for ${email} with this company sign-in. Ask your HR team to add you with this email.`);
    const company = await deps.discover(email);
    if (!company || company.providerId !== provider) throw NO;
    const person = await deps.findPerson(company.orgId, email);
    if (!person || STATUS_GONE.test(String(person.status || 'active')) || person.disabled === true) throw NO;

    const token = await deps.mintToken(person.id);
    if (decoded.uid && decoded.uid !== person.id) { try { await deps.deleteUser(decoded.uid); } catch (_) { /* a leftover provider account only costs a row; never fails the sign-in */ } }
    return { token, orgId: company.orgId, userId: person.id, provider };
}

/* --------------------------------- the real thing --------------------------------- */

function realDeps() {
    const { admin, rawCollection } = require('../config/firebase');
    return {
        verifyIdToken: (t) => admin.auth().verifyIdToken(t),
        discover: (email) => require('./sso').discover(email),
        async findPerson(orgId, email) {
            const snap = await rawCollection('users').where('email', '==', email).get();
            const d = snap.docs.find((x) => x.data().orgId === orgId);
            return d ? { id: d.id, ...d.data() } : null;
        },
        mintToken: (uid) => admin.auth().createCustomToken(uid),
        deleteUser: (uid) => admin.auth().deleteUser(uid)
    };
}

module.exports = { complete, realDeps };
