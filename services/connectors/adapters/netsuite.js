/**
 * NetSuite (SuiteTalk REST): employees and payroll journal entries, upserted by external ID.
 * REST record service: https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1544736012.html
 * Auth: OAuth 2.0 machine-to-machine (client credentials with a signed JWT client assertion) or a pre-issued access token.
 */
const crypto = require('crypto');
const J = require('../journal');
const { defineAdapter, oauthToken, journalEntity, peopleEntity, ACCOUNT_FIELDS, accountsOf } = require('./_base');

const host = (c) => c.baseUrl || `https://${String(c.accountId || '').toLowerCase().replace(/_/g, '-')}.suitetalk.api.netsuite.com`;
const b64url = (b) => Buffer.from(b).toString('base64url');

/** Signed client assertion (RS256). TODO(verify): NetSuite also accepts PS256 and ES256; match the algorithm of the uploaded certificate. */
function clientAssertion({ clientId, certificateId, privateKey, audience, now = Math.floor(Date.now() / 1000) }) {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: certificateId }));
    const body = b64url(JSON.stringify({ iss: clientId, scope: ['rest_webservices'], aud: audience, iat: now, exp: now + 3000 }));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url');
    return `${head}.${body}.${sig}`;
}

module.exports = defineAdapter({
    key: 'netsuite', name: 'NetSuite', category: 'erp', vendor: 'Oracle NetSuite',
    description: 'Creates or updates employee records and posts payroll journal entries (idempotent by external ID).',
    entities: [peopleEntity('employee', 'Employees'), journalEntity],
    credentialFields: [{ key: 'clientId', label: 'Integration client ID' }, { key: 'certificateId', label: 'Certificate ID (kid)' }, { key: 'privateKey', label: 'Private key (PEM)', secret: true }, { key: 'accessToken', label: 'Access token (alternative to the key)', secret: true }],
    configFields: [{ key: 'accountId', label: 'Account ID (e.g. 1234567 or 1234567_SB1)', required: true }, { key: 'subsidiaryId', label: 'Subsidiary internal ID', required: true }, { key: 'baseUrl', label: 'API base URL override' }, ...ACCOUNT_FIELDS],
    needsVerification: [
        'A NetSuite account with an Integration record, OAuth 2.0 M2M certificate mapping and a role that may create Employees and Journal Entries',
        'Account/department internal IDs (not names); subsidiary internal ID; whether Journal Entry approval routing is on (field approved)',
        'Employee required fields differ per account customisation (e.g. custom forms, mandatory custom fields) and supervisor needs an internal ID',
        'JWT algorithm (RS256 vs PS256) matching the uploaded certificate; external ID upsert via PUT .../eid:<externalId>'
    ],
    defaultMappings: {
        employee: [
            { target: 'externalId', source: 'id', required: true },
            { target: 'firstName', source: 'first_name', required: true },
            { target: 'lastName', source: 'last_name', required: true },
            { target: 'email', source: 'work_email' },
            { target: 'phone', source: 'phone' },
            { target: 'title', source: 'job.title' },
            { target: 'hireDate', source: 'hire_date' },
            { target: 'isInactive', source: 'status', transform: { fn: 'lookup', map: { active: false, pending: false, inactive: true, terminated: true }, default: false } }
        ],
        journal: [
            { target: 'externalId', source: 'id', required: true },
            { target: 'tranDate', source: 'pay_date', transform: { fn: 'date', format: 'YYYY-MM-DD' }, required: true },
            { target: 'memo', source: 'memo', transform: { fn: 'truncate', length: 999 } }
        ]
    },
    shape: {
        employee(flat, record, ctx) { return { ...flat, subsidiary: { id: String(ctx.conn.config.subsidiaryId || '') } }; },
        journal(flat, record, ctx) {
            const j = J.buildJournal(record, accountsOf(ctx)); const deptIds = ctx.conn.config.departmentIds || {};
            return {
                ...flat, approved: true, subsidiary: { id: String(ctx.conn.config.subsidiaryId || '') }, currency: { refName: record.currency || 'USD' },
                line: { items: j.lines.map((l) => ({ account: { id: String(l.account) }, [l.side === 'debit' ? 'debit' : 'credit']: l.amount, memo: l.memo, ...(l.department && deptIds[l.department] ? { department: { id: String(deptIds[l.department]) } } : {}) })) }
            };
        }
    },
    validate(entity, payload, record, ctx) {
        const errs = [];
        if (!ctx.conn.config.subsidiaryId) errs.push('subsidiaryId is not configured');
        if (!ctx.conn.config.accountId && !ctx.conn.config.baseUrl) errs.push('accountId is not configured');
        if (entity === 'journal') errs.push(...J.validateJournal(record, accountsOf(ctx)));
        return errs;
    },
    async authenticate(ctx) {
        const c = ctx.conn.credentials; const cfg = ctx.conn.config;
        if (c.accessToken) return { headers: { Authorization: `Bearer ${c.accessToken}`, Accept: 'application/json' } };
        const url = `${host(cfg)}/services/rest/auth/oauth2/v1/token`;
        const assertion = clientAssertion({ clientId: c.clientId, certificateId: c.certificateId, privateKey: c.privateKey, audience: url });
        const t = await oauthToken(ctx, { url, form: { grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion } });
        return { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } };
    },
    async healthCheck(ctx) {
        await ctx.http.request({ url: `${host(ctx.conn.config)}/services/rest/record/v1/employee`, headers: ctx.auth.headers, query: { limit: 1 } });
        return 'REST record service reachable';
    },
    async push(entity, payload, ctx) {
        const record = entity === 'journal' ? 'journalEntry' : 'employee';
        const url = `${host(ctx.conn.config)}/services/rest/record/v1/${record}/eid:${encodeURIComponent(payload.externalId)}`;
        const r = await ctx.http.request({ method: 'PUT', url, headers: ctx.auth.headers, json: payload });
        const loc = r.headers.location || r.headers.Location || '';
        return { remoteId: loc ? loc.split('/').pop() : `eid:${payload.externalId}` };
    }
});
module.exports.clientAssertion = clientAssertion;
