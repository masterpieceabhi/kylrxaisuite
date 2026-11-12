/**
 * Google Workspace: provisions users through the Admin SDK Directory API (users.insert / users.update).
 * Google can also pull from our SCIM server for SAML apps; this adapter is for creating/suspending Google accounts themselves.
 * Auth: service account with domain-wide delegation (JWT bearer grant), acting as an admin user.
 * Docs: https://developers.google.com/admin-sdk/directory/reference/rest/v1/users
 */
const crypto = require('crypto');
const { defineAdapter, oauthToken, peopleEntity } = require('./_base');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://admin.googleapis.com/admin/directory/v1';
const SCOPE = 'https://www.googleapis.com/auth/admin.directory.user';
const b64url = (b) => Buffer.from(b).toString('base64url');

function assertion({ clientEmail, privateKey, adminEmail, audience = TOKEN_URL, now = Math.floor(Date.now() / 1000) }) {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ iss: clientEmail, sub: adminEmail, scope: SCOPE, aud: audience, iat: now, exp: now + 3000 }));
    return `${head}.${body}.${crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
const randomPassword = () => crypto.randomBytes(18).toString('base64url') + 'aA1!';

module.exports = defineAdapter({
    key: 'google-workspace', name: 'Google Workspace', category: 'identity', vendor: 'Google',
    description: 'Creates, updates and suspends Google accounts to match HR (new hires get an account; leavers are suspended).',
    entities: [peopleEntity('user', 'People as Google users')],
    credentialFields: [{ key: 'clientEmail', label: 'Service account email' }, { key: 'privateKey', label: 'Service account private key (PEM)', secret: true }],
    configFields: [{ key: 'adminEmail', label: 'Admin to act as (domain-wide delegation)', required: true }, { key: 'domain', label: 'Primary domain for new accounts (e.g. example.com)', required: true }, { key: 'orgUnitPath', label: 'Org unit path', default: '/' }, { key: 'baseUrl', label: 'API base URL override' }, { key: 'tokenUrl', label: 'Token URL override' }],
    needsVerification: [
        'Service account with domain-wide delegation authorised for the admin.directory.user scope in the Google Admin console',
        'Which address becomes primaryEmail (here: work_email must already be on your Google domain) and the org unit path',
        'Password policy: new users get a random password and must change it at next sign-in; use SSO/SAML in practice',
        'Directory API quotas and the 409 duplicate path (handled by looking the user up and updating)'
    ],
    defaultMappings: {
        user: [
            { target: 'primaryEmail', source: 'work_email', transform: 'lower', required: true },
            { target: 'name.givenName', source: 'first_name', required: true },
            { target: 'name.familyName', source: 'last_name', required: true },
            { target: 'suspended', source: 'status', transform: { fn: 'lookup', map: { active: false, pending: false, inactive: true, terminated: true }, default: false } },
            { target: 'title', source: 'job.title' },
            { target: 'department', source: 'job.org_unit_name' },
            { target: 'employeeId', source: 'employee_number' },
            { target: 'phone', source: 'phone' }
        ]
    },
    shape: {
        user(flat, record, ctx) {
            const out = { primaryEmail: flat.primaryEmail, name: flat.name, suspended: flat.suspended, orgUnitPath: ctx.conn.config.orgUnitPath || '/' };
            if (flat.title || flat.department) out.organizations = [{ title: flat.title || '', department: flat.department || '', primary: true, type: 'work' }];
            if (flat.employeeId) out.externalIds = [{ value: flat.employeeId, type: 'organization' }];
            if (flat.phone) out.phones = [{ value: flat.phone, type: 'work' }];
            return out;
        }
    },
    validate(entity, payload, record, ctx) {
        const errs = [];
        const dom = String(ctx.conn.config.domain || '').toLowerCase();
        if (!dom) errs.push('domain is not configured');
        else if (!String(payload.primaryEmail || '').endsWith(`@${dom}`)) errs.push(`work_email must be on the ${dom} domain`);
        return errs;
    },
    async authenticate(ctx) {
        const c = ctx.conn.credentials; const cfg = ctx.conn.config; const url = cfg.tokenUrl || TOKEN_URL;
        const t = await oauthToken(ctx, { url, form: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion({ clientEmail: c.clientEmail, privateKey: c.privateKey, adminEmail: cfg.adminEmail, audience: url }) } });
        return { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } };
    },
    async healthCheck(ctx) {
        await ctx.http.request({ url: `${ctx.conn.config.baseUrl || API}/users`, headers: ctx.auth.headers, query: { domain: ctx.conn.config.domain, maxResults: 1 } });
        return 'Directory API reachable';
    },
    async push(entity, payload, ctx, { remoteId }) {
        const api = ctx.conn.config.baseUrl || API; const h = ctx.auth.headers;
        const update = async (key) => { await ctx.http.request({ method: 'PUT', url: `${api}/users/${encodeURIComponent(key)}`, headers: h, json: payload }); return { remoteId: key }; };
        if (remoteId) return update(remoteId);
        const existing = await ctx.http.request({ url: `${api}/users/${encodeURIComponent(payload.primaryEmail)}`, headers: h, expect: false });
        if (existing.status === 200 && existing.json) return update(existing.json.id || payload.primaryEmail);
        const r = await ctx.http.request({ method: 'POST', url: `${api}/users`, headers: h, json: { ...payload, password: randomPassword(), changePasswordAtNextLogin: true } });
        return { remoteId: r.json.id || payload.primaryEmail };
    }
});
module.exports.assertion = assertion;
