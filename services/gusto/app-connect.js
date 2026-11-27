/**
 * Connecting a customer's OWN Gusto account (Gusto "App Integration", set with GUSTO_INTEGRATION=app).
 *
 * This is the other way of working with Gusto from onboarding.connectCompany():
 *   embedded  we create the company at Gusto and run payroll inside this product
 *   app       the customer already has Gusto; an admin approves this application there and Gusto sends
 *             them back to us with a one-time code, which we swap for that company's tokens
 *
 * Flow:
 *   1. startAuthorization()    a signed-in owner asks to connect; we remember a one-time `state` and hand
 *                              back the Gusto address to send the browser to
 *   2. Gusto shows its own sign-in and approval screens, then redirects to /api/us/gusto/oauth/callback
 *   3. completeAuthorization() checks the state, swaps the code for tokens, asks Gusto which company the
 *                              token belongs to, and saves the connection
 *
 * The callback arrives without our sign-in token, so the `state` is the only thing tying it to a company
 * and a person. It is random, stored only as a hash, valid for ten minutes and usable once.
 *
 * Checked against Gusto's App Integrations pages on 2026-11-16 (OAuth2, Authentication, token_info):
 *   - authorize: GET {host}/oauth/authorize?client_id&redirect_uri&response_type=code&state   (no scope parameter;
 *     Gusto assigns scopes to the application during its review)
 *   - token:     POST {host}/oauth/token, JSON body, grant_type=authorization_code with code and redirect_uri
 *   - which company: GET /v1/token_info -> { scope, resource: { type: 'Company', uuid }, resource_owner }
 *   - each token covers exactly one company
 * The pages name only api.gusto.com for the approval page. For demo we use the demo API host; a request to
 * https://api.gusto-demo.com/oauth/authorize on 2026-11-16 redirected to the demo sign-in page, so it exists.
 * GUSTO_AUTHORIZE_URL overrides it. NOT found in the docs: an endpoint for revoking a token, so disconnecting
 * forgets the tokens here and the owner removes the app inside Gusto.
 */
const crypto = require('crypto');
const { GustoError } = require('./client');
const { defaultStore } = require('./store');

const STATE_TTL_MS = 10 * 60 * 1000;
const nowIso = () => new Date().toISOString();
const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64url');
const unb64 = (s) => Buffer.from(String(s), 'base64url').toString('utf8');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHash = (a, b) => {
    const x = Buffer.from(String(a), 'hex'); const y = Buffer.from(String(b), 'hex');
    return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
const fail = (message, status, code) => new GustoError(message, { status, code });

/** Step 1. Returns the Gusto address to send the owner's browser to. */
async function startAuthorization(ctx, { actor = null, now = Date.now } = {}) {
    const { store, orgId, opts } = ctx;
    if (opts.integration !== 'app') throw fail('This server is set up for Gusto Embedded Payroll, not for connecting a customer\'s own Gusto account', 409, 'not_app_integration');
    if (!opts.redirectUri || !opts.authorizeUrl) throw fail('The Gusto return address is not set on this server', 503, 'not_configured');
    const existing = await store.getConnection(orgId);
    if (existing && existing.companyUuid && existing.status === 'connected') throw fail('This company is already connected to Gusto', 409, 'already_connected');

    const nonce = crypto.randomBytes(32).toString('base64url');
    const expiresAt = now() + STATE_TTL_MS;
    // only the hash is kept; a newer request replaces an older one, so an abandoned attempt cannot be finished later
    await store.saveConnection(orgId, { oauth: { stateHash: sha(nonce), expiresAt, actor, redirectUri: opts.redirectUri, startedAt: nowIso() } });

    const url = new URL(opts.authorizeUrl);
    url.searchParams.set('client_id', opts.clientId);
    url.searchParams.set('redirect_uri', opts.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', `${b64(orgId)}.${nonce}`);
    return { url: url.toString(), expiresAt };
}

/** The state is "<company id, base64url>.<random>". Returns null for anything else. */
function readState(state) {
    const parts = String(state || '').split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1] || parts[1].length > 200) return null;
    let orgId;
    try { orgId = unb64(parts[0]); } catch (_) { return null; }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(orgId)) return null;
    return { orgId, nonce: parts[1] };
}

/**
 * Step 3. Called from the public callback route.
 * @param {object} q     { state, code, error } from Gusto's redirect
 * @param {object} deps  { store, makeContext, now } and anything makeContext accepts (test seams)
 * @returns {{orgId, companyUuid, companyName, scope}}
 */
async function completeAuthorization(q, deps = {}) {
    const now = deps.now || Date.now;
    const parsed = readState(q && q.state);
    if (!parsed) throw fail('The connection request could not be recognised. Start again from the payroll page.', 400, 'bad_state');
    const { orgId, nonce } = parsed;
    const store = deps.store || defaultStore();
    const conn = await store.getConnection(orgId);
    const pending = conn && conn.oauth;
    if (!pending || !pending.stateHash) throw fail('There is no connection request waiting for this company. Start again from the payroll page.', 400, 'bad_state');
    if (!sameHash(sha(nonce), pending.stateHash)) throw fail('The connection request could not be recognised. Start again from the payroll page.', 400, 'bad_state');
    // one use only: whatever happens next, this state cannot be presented again
    await store.saveConnection(orgId, { oauth: null });
    if (now() > Number(pending.expiresAt || 0)) throw fail('The connection request took too long. Start again from the payroll page.', 400, 'state_expired');
    if (q.error) throw fail(q.error === 'access_denied' ? 'The connection was not approved in Gusto.' : 'Gusto reported a problem with the connection.', 400, q.error === 'access_denied' ? 'declined' : 'provider_error');
    const code = String(q.code || '');
    if (!code || code.length > 2000) throw fail('Gusto did not send a code to finish the connection.', 400, 'bad_code');

    const makeContext = deps.makeContext || require('./index').makeContext;
    const ctx = await makeContext(orgId, { ...deps, store });
    if (ctx.opts.integration !== 'app') throw fail('This server is set up for Gusto Embedded Payroll', 409, 'not_app_integration');

    const redirectUri = pending.redirectUri || ctx.opts.redirectUri;
    const tok = await ctx.client.exchangeCode(code, redirectUri);
    if (!tok.refresh_token) throw fail('Gusto did not return the tokens for this company', 502, 'bad_response');
    await store.saveCompanyTokens(orgId, { accessToken: tok.access_token, refreshToken: tok.refresh_token, expiresAt: now() + (Number(tok.expires_in) || 7200) * 1000 });

    // The token response does not say which company approved; token_info does.
    let info;
    try { info = await ctx.client.get('/v1/token_info'); } catch (e) { await store.clearCompanyTokens(orgId); throw e; }
    const res = info && info.resource;
    if (!res || res.type !== 'Company' || !res.uuid) {
        await store.clearCompanyTokens(orgId);
        throw fail('Gusto did not say which company approved the connection', 502, 'no_company');
    }
    let companyName = null; let company = null;
    try { const c = await ctx.client.get(`/v1/companies/${res.uuid}`); company = c && typeof c === 'object' ? c : null; companyName = (c && (c.name || c.trade_name)) || null; } catch (_) { /* the name is a nicety; the scope may not allow it */ }

    // A different company than before: ids remembered for the old one must not carry over.
    if (conn.companyUuid && conn.companyUuid !== res.uuid) {
        for (const l of await store.listLinks(orgId)) await store.deleteLink(orgId, l.kind, l.ourId);
    }
    await store.saveConnection(orgId, {
        mode: ctx.opts.mode, integration: 'app', companyUuid: res.uuid, status: 'connected', statusNote: null,
        connectedAt: nowIso(), connectedBy: pending.actor || null, companyName, redirectUri,
        scope: typeof info.scope === 'string' ? info.scope.slice(0, 2000) : null,
        approvedByType: (info.resource_owner && info.resource_owner.type) || null
    });
    // `company` lets the caller fill the empty company-profile fields (EIN, legal name, address) from Gusto: services/company-ein.js
    return { orgId, companyUuid: res.uuid, companyName, scope: info.scope || null, company };
}

/**
 * Disconnect a customer's own Gusto account: ask Gusto to cancel the tokens we hold, then forget them.
 * The second half always happens; the first is best effort and its outcome is returned, so the page can say
 * whether the owner should also remove the application inside Gusto.
 */
async function disconnect(ctx) {
    const { store, orgId } = ctx;
    let revoked = false;
    try {
        const t = await store.getCompanyTokens(orgId);
        if (t && t.refreshToken) revoked = await ctx.client.revokeToken(t.refreshToken);
        if (t && t.accessToken) revoked = (await ctx.client.revokeToken(t.accessToken)) || revoked;
    } catch (_) { /* tokens that cannot be read cannot be revoked; they are forgotten below */ }
    await store.clearCompanyTokens(orgId);
    await store.saveConnection(orgId, { status: 'disconnected', disconnectedAt: nowIso(), revokedAtGusto: revoked, autoSendHours: false });
    ctx.conn = await store.getConnection(orgId);
    return { revokedAtGusto: revoked };
}

module.exports = { disconnect, startAuthorization, completeAuthorization, readState, STATE_TTL_MS };
