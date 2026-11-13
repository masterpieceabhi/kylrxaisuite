/**
 * OAuth 2.0 token and revocation endpoints, mounted at /oauth (public: client authentication
 * happens here). Grants: client_credentials, authorization_code (PKCE), refresh_token (rotating).
 * The authorization step (admin consent) lives behind admin login in routes/us-integrations.js
 * and the page oauth-consent.html.
 */
const express = require('express');
const router = express.Router();
const auth = require('../services/api-auth');
const logger = require('../utils/logger');

router.use(express.urlencoded({ extended: false }));

function basic(req) {
    const m = (req.get('Authorization') || '').match(/^Basic\s+(.+)$/i);
    if (!m) return null;
    const raw = Buffer.from(m[1], 'base64').toString('utf8'); const i = raw.indexOf(':');
    return i < 0 ? null : { id: decodeURIComponent(raw.slice(0, i)), secret: decodeURIComponent(raw.slice(i + 1)) };
}

router.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' }); next(); });

router.post('/token', async (req, res) => {
    try {
        const r = await auth.tokenEndpoint(req.body || {}, basic(req));
        if (r.status === 401) res.set('WWW-Authenticate', 'Basic realm="oauth"');
        res.status(r.status).json(r.body);
    } catch (e) {
        logger.error(`oauth token: ${e.message}`);
        res.status(500).json({ error: 'server_error' });
    }
});

router.post('/revoke', async (req, res) => {
    try {
        const b = basic(req); const clientId = (b && b.id) || (req.body || {}).client_id; const secret = (b && b.secret) || (req.body || {}).client_secret;
        const app = await auth.loadApp(clientId);
        if (!app || app.data.active === false || (app.data.type === 'confidential' && auth.sha256(secret || '') !== app.data.secretHash)) return res.status(401).json({ error: 'invalid_client' });
        await auth.revokeToken((req.body || {}).token, app);
        res.status(200).json({});
    } catch (e) {
        logger.error(`oauth revoke: ${e.message}`);
        res.status(500).json({ error: 'server_error' });
    }
});

router.get('/.well-known/oauth-authorization-server', (req, res) => {
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({
        issuer: base, authorization_endpoint: `${base}/oauth-consent.html`, token_endpoint: `${base}/oauth/token`, revocation_endpoint: `${base}/oauth/revoke`,
        grant_types_supported: ['client_credentials', 'authorization_code', 'refresh_token'], response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'], scopes_supported: auth.SCOPE_LIST
    });
});

module.exports = router;
