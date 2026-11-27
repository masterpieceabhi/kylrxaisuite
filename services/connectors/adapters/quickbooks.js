/**
 * QuickBooks Online: payroll journal entries + employees as vendors.
 * API: https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry (JournalEntry, Vendor)
 * Auth: OAuth 2.0 refresh-token grant (Intuit rotates the refresh token; the new one is saved back encrypted).
 */
const crypto = require('crypto');
const J = require('../journal');
const { defineAdapter, oauthToken, journalEntity, peopleEntity, ACCOUNT_FIELDS, accountsOf, HttpError } = require('./_base');

const HOSTS = { production: 'https://quickbooks.api.intuit.com', sandbox: 'https://sandbox-quickbooks.api.intuit.com' };
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const MINOR = 70;
const base = (c) => `${c.baseUrl || HOSTS[c.environment === 'sandbox' ? 'sandbox' : 'production']}/v3/company/${c.realmId}`;
const requestId = (...p) => crypto.createHash('sha256').update(p.join('|')).digest('hex').slice(0, 30);

module.exports = defineAdapter({
    key: 'quickbooks', name: 'QuickBooks Online', category: 'accounting', vendor: 'Intuit',
    description: 'Posts each payroll as a journal entry and keeps employees as vendors (for expense reimbursement).',
    entities: [journalEntity, peopleEntity('vendor', 'Employees as vendors')],
    credentialFields: [{ key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client secret', secret: true }, { key: 'refreshToken', label: 'Refresh token', secret: true }],
    configFields: [{ key: 'realmId', label: 'Company (realm) ID', required: true }, { key: 'environment', label: 'Environment', default: 'production', help: 'production or sandbox' }, { key: 'baseUrl', label: 'API base URL override', help: 'Leave empty. Used for testing.' }, ...ACCOUNT_FIELDS],
    needsVerification: [
        'Real OAuth app (client id/secret) and a connected company to confirm the refresh-token flow and token rotation',
        'AccountRef values are QuickBooks account IDs (not names): copy them from Chart of Accounts',
        'Whether your company has "Class" or "Department" tracking turned on (then add ClassRef/DepartmentRef mapping rules)',
        'minorversion 70 and duplicate-name behaviour (Fault code 6240) against a live company'
    ],
    defaultMappings: {
        journal: [
            { target: 'TxnDate', source: 'pay_date', transform: { fn: 'date', format: 'YYYY-MM-DD' }, required: true },
            { target: 'PrivateNote', source: 'memo', transform: { fn: 'truncate', length: 4000 } },
            { target: 'DocNumber', source: 'id', transform: [{ fn: 'replace', pattern: '^pj_', with: 'PR-' }, { fn: 'truncate', length: 21 }] },
            { target: 'CurrencyRef.value', source: 'currency', default: 'USD' }
        ],
        vendor: [
            { target: 'DisplayName', source: 'display_name', transform: ['trim', { fn: 'truncate', length: 100 }], required: true },
            { target: 'GivenName', source: 'first_name', transform: { fn: 'truncate', length: 25 } },
            { target: 'FamilyName', source: 'last_name', transform: { fn: 'truncate', length: 25 } },
            { target: 'PrimaryEmailAddr.Address', source: 'work_email' },
            { target: 'PrimaryPhone.FreeFormNumber', source: 'phone' },
            { target: 'AcctNum', source: 'employee_number' },
            { target: 'Active', source: 'status', transform: { fn: 'lookup', map: { active: true, pending: true, inactive: false, terminated: false }, default: true } }
        ]
    },
    shape: {
        journal(flat, record, ctx) {
            const j = J.buildJournal(record, accountsOf(ctx));
            return {
                ...flat,
                Line: j.lines.map((l, i) => ({
                    Id: String(i), Description: l.memo, Amount: l.amount, DetailType: 'JournalEntryLineDetail',
                    JournalEntryLineDetail: { PostingType: l.side === 'debit' ? 'Debit' : 'Credit', AccountRef: { value: String(l.account) }, ...(l.department && ctx.conn.config.departmentIds && ctx.conn.config.departmentIds[l.department] ? { DepartmentRef: { value: String(ctx.conn.config.departmentIds[l.department]) } } : {}) }
                }))
            };
        }
    },
    validate(entity, payload, record, ctx) {
        if (entity === 'journal') return J.validateJournal(record, accountsOf(ctx)).concat(ctx.conn.config.realmId ? [] : ['realmId is not configured']);
        return ctx.conn.config.realmId ? [] : ['realmId is not configured'];
    },
    async authenticate(ctx) {
        const c = ctx.conn.credentials; const cfg = ctx.conn.config;
        const t = await oauthToken(ctx, { url: cfg.tokenUrl || TOKEN_URL, basic: { id: c.clientId, secret: c.clientSecret }, form: { grant_type: 'refresh_token', refresh_token: c.refreshToken } });
        if (t.raw.refresh_token && t.raw.refresh_token !== c.refreshToken && ctx.saveCredentials) { await ctx.saveCredentials({ refreshToken: t.raw.refresh_token }); c.refreshToken = t.raw.refresh_token; }
        return { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } };
    },
    async healthCheck(ctx) {
        const r = await ctx.http.request({ url: `${base(ctx.conn.config)}/companyinfo/${ctx.conn.config.realmId}`, headers: ctx.auth.headers, query: { minorversion: MINOR } });
        return `connected to ${(r.json && r.json.CompanyInfo && r.json.CompanyInfo.CompanyName) || 'company'}`;
    },
    async push(entity, payload, ctx, { remoteId, hash, record }) {
        const cfg = ctx.conn.config; const h = ctx.auth.headers;
        const rid = requestId(ctx.conn.id, entity, record.id, hash);
        if (entity === 'journal') {
            if (remoteId) {
                const cur = await ctx.http.request({ url: `${base(cfg)}/journalentry/${remoteId}`, headers: h, query: { minorversion: MINOR } });
                const r = await ctx.http.request({ method: 'POST', url: `${base(cfg)}/journalentry`, headers: h, query: { minorversion: MINOR, requestid: rid }, json: { ...payload, Id: remoteId, SyncToken: cur.json.JournalEntry.SyncToken } });
                return { remoteId: r.json.JournalEntry.Id };
            }
            const r = await ctx.http.request({ method: 'POST', url: `${base(cfg)}/journalentry`, headers: h, query: { minorversion: MINOR, requestid: rid }, json: payload });
            return { remoteId: r.json.JournalEntry.Id };
        }
        // vendor
        const update = async (id) => {
            const cur = await ctx.http.request({ url: `${base(cfg)}/vendor/${id}`, headers: h, query: { minorversion: MINOR } });
            const r = await ctx.http.request({ method: 'POST', url: `${base(cfg)}/vendor`, headers: h, query: { minorversion: MINOR, requestid: rid }, json: { ...payload, Id: id, SyncToken: cur.json.Vendor.SyncToken, sparse: true } });
            return { remoteId: r.json.Vendor.Id };
        };
        if (remoteId) return update(remoteId);
        try {
            const r = await ctx.http.request({ method: 'POST', url: `${base(cfg)}/vendor`, headers: h, query: { minorversion: MINOR, requestid: rid }, json: payload });
            return { remoteId: r.json.Vendor.Id };
        } catch (e) {
            const dup = e instanceof HttpError && e.status === 400 && /6240|Duplicate/i.test(JSON.stringify(e.body || e.message));
            if (!dup) throw e;
            const q = await ctx.http.request({ url: `${base(cfg)}/query`, headers: h, query: { minorversion: MINOR, query: `select Id from Vendor where DisplayName = '${String(payload.DisplayName).replace(/'/g, "\\'")}'` } });
            const found = q.json && q.json.QueryResponse && q.json.QueryResponse.Vendor && q.json.QueryResponse.Vendor[0];
            if (!found) throw Object.assign(e, { retryable: false });
            return update(found.Id);
        }
    }
});
