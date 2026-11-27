/**
 * SCIM 2.0 client: provisions our people into any app that exposes a SCIM 2.0 server (RFC 7644):
 * create, update, and deactivate (active=false). Idempotent: finds an existing user by userName first.
 * Use it for apps that do not support Okta/Entra pull but do speak SCIM.
 */
const S = require('../../scim');
const { defineAdapter, peopleEntity } = require('./_base');

const url = (cfg, p = '') => `${String(cfg.baseUrl).replace(/\/$/, '')}${p}`;
const SCIM_HEADERS = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/scim+json', Accept: 'application/scim+json' });

module.exports = defineAdapter({
    key: 'scim-client', name: 'SCIM 2.0 provisioning (push to an app)', category: 'identity', vendor: 'Generic',
    description: 'Creates, updates and deactivates users in any application that has a SCIM 2.0 endpoint.',
    entities: [peopleEntity('user', 'People as users')],
    credentialFields: [{ key: 'token', label: 'SCIM bearer token', secret: true }],
    configFields: [{ key: 'baseUrl', label: 'SCIM base URL (e.g. https://app.example.com/scim/v2)', required: true }, { key: 'sendEnterprise', label: 'Send enterprise extension (employee number, department, manager)', default: true }],
    needsVerification: [
        'The target app: which SCIM attributes it requires/ignores (many apps need emails[type work] and name.givenName/familyName)',
        'PATCH vs PUT support and whether the app accepts the enterprise extension',
        'Pagination and filter support for userName lookups; behaviour on deactivation (some apps need DELETE)'
    ],
    defaultMappings: {
        user: [
            { target: 'externalId', source: 'id', required: true },
            { target: 'userName', source: 'work_email', transform: 'lower', required: true },
            { target: 'name.givenName', source: 'first_name', required: true },
            { target: 'name.familyName', source: 'last_name', required: true },
            { target: 'displayName', source: 'display_name' },
            { target: 'title', source: 'job.title' },
            { target: 'phone', source: 'phone' },
            { target: 'department', source: 'job.org_unit_name' },
            { target: 'employeeNumber', source: 'employee_number' },
            { target: 'active', source: 'status', transform: { fn: 'lookup', map: { active: true, pending: true, inactive: false, terminated: false }, default: true } }
        ]
    },
    shape: {
        user(flat, record, ctx) {
            const out = { schemas: [S.SCHEMA_USER], externalId: flat.externalId, userName: flat.userName, name: flat.name, displayName: flat.displayName, title: flat.title, active: flat.active, emails: [{ value: flat.userName, type: 'work', primary: true }] };
            if (flat.phone) out.phoneNumbers = [{ value: flat.phone, type: 'work' }];
            if (ctx.conn.config.sendEnterprise !== false && (flat.department || flat.employeeNumber)) { out.schemas.push(S.SCHEMA_ENT); out[S.SCHEMA_ENT] = { ...(flat.employeeNumber ? { employeeNumber: flat.employeeNumber } : {}), ...(flat.department ? { department: flat.department } : {}) }; }
            return JSON.parse(JSON.stringify(out));
        }
    },
    validate(entity, payload, record, ctx) { return ctx.conn.config.baseUrl ? [] : ['baseUrl is not configured']; },
    async authenticate(ctx) { return { headers: SCIM_HEADERS(ctx.conn.credentials.token) }; },
    async healthCheck(ctx) {
        const r = await ctx.http.request({ url: url(ctx.conn.config, '/ServiceProviderConfig'), headers: ctx.auth.headers });
        return `SCIM endpoint reachable${r.json && r.json.patch && r.json.patch.supported ? ' (PATCH supported)' : ''}`;
    },
    async push(entity, payload, ctx, { remoteId }) {
        const cfg = ctx.conn.config; const h = ctx.auth.headers;
        let id = remoteId;
        if (!id) {
            const q = await ctx.http.request({ url: url(cfg, '/Users'), headers: h, query: { filter: `userName eq "${payload.userName.replace(/"/g, '\\"')}"` } });
            id = q.json && q.json.Resources && q.json.Resources[0] && q.json.Resources[0].id;
        }
        if (!id) {
            const r = await ctx.http.request({ method: 'POST', url: url(cfg, '/Users'), headers: h, json: payload });
            return { remoteId: r.json.id };
        }
        const ops = [{ op: 'replace', path: 'active', value: payload.active }, { op: 'replace', path: 'name.givenName', value: payload.name.givenName }, { op: 'replace', path: 'name.familyName', value: payload.name.familyName }, { op: 'replace', path: 'userName', value: payload.userName }];
        if (payload.title !== undefined) ops.push({ op: 'replace', path: 'title', value: payload.title });
        if (payload.displayName !== undefined) ops.push({ op: 'replace', path: 'displayName', value: payload.displayName });
        await ctx.http.request({ method: 'PATCH', url: url(cfg, `/Users/${id}`), headers: h, json: { schemas: [S.SCHEMA_PATCH], Operations: ops } });
        return { remoteId: id };
    }
});
