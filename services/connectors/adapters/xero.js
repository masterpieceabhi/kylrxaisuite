/**
 * Xero: payroll as manual journals.
 * API: https://developer.xero.com/documentation/api/accounting/manualjournals
 * Debits are positive LineAmount, credits negative; a journal must sum to zero.
 * Auth: OAuth 2.0 client credentials (Custom Connection) or refresh token; header xero-tenant-id on every call.
 */
const crypto = require('crypto');
const J = require('../journal');
const { defineAdapter, oauthToken, journalEntity, ACCOUNT_FIELDS, accountsOf, HttpError } = require('./_base');

const API = 'https://api.xero.com/api.xro/2.0';
const TOKEN_URL = 'https://identity.xero.com/connect/token';

module.exports = defineAdapter({
    key: 'xero', name: 'Xero', category: 'accounting', vendor: 'Xero',
    description: 'Creates one manual journal per payroll (draft by default so your bookkeeper can review).',
    entities: [journalEntity],
    credentialFields: [{ key: 'clientId', label: 'Client ID' }, { key: 'clientSecret', label: 'Client secret', secret: true }, { key: 'refreshToken', label: 'Refresh token (leave empty for a Custom Connection)', secret: true }],
    configFields: [{ key: 'tenantId', label: 'Xero tenant ID', required: true }, { key: 'journalStatus', label: 'Journal status', default: 'DRAFT', help: 'DRAFT or POSTED' }, { key: 'baseUrl', label: 'API base URL override' }, ...ACCOUNT_FIELDS],
    needsVerification: [
        'Real Xero app: Custom Connection (client credentials) needs a paid Xero organisation; otherwise authorization code + refresh token',
        'AccountCode values are chart-of-accounts CODES (e.g. 477), not names; Xero rejects archived or system accounts',
        'Tracking categories for departments (add a mapping rule for JournalLines[].Tracking)',
        'Rate limit behaviour (60 calls/minute, 5000/day) and that a POSTED journal can no longer be edited through the API'
    ],
    defaultMappings: {
        journal: [
            { target: 'Date', source: 'pay_date', transform: { fn: 'date', format: 'YYYY-MM-DD' }, required: true },
            { target: 'Narration', source: 'memo', transform: { fn: 'truncate', length: 500 }, required: true },
            { target: 'Status', source: '', default: 'DRAFT' }
        ]
    },
    shape: {
        journal(flat, record, ctx) {
            const j = J.buildJournal(record, accountsOf(ctx));
            const status = (ctx.conn.config.journalStatus || flat.Status || 'DRAFT').toUpperCase();
            return {
                ManualJournals: [{
                    ...flat, Status: status, LineAmountTypes: 'NoTax',
                    JournalLines: j.lines.map((l) => ({ LineAmount: l.side === 'debit' ? l.amount : -l.amount, AccountCode: String(l.account), Description: l.memo, TaxType: 'NONE' }))
                }]
            };
        }
    },
    validate(entity, payload, record, ctx) {
        const errs = J.validateJournal(record, accountsOf(ctx));
        if (!ctx.conn.config.tenantId) errs.push('tenantId is not configured');
        const sum = Math.round(payload.ManualJournals[0].JournalLines.reduce((s, l) => s + l.LineAmount * 100, 0));
        if (sum !== 0) errs.push('journal lines do not sum to zero');
        return errs;
    },
    async authenticate(ctx) {
        const c = ctx.conn.credentials; const cfg = ctx.conn.config;
        const form = c.refreshToken ? { grant_type: 'refresh_token', refresh_token: c.refreshToken } : { grant_type: 'client_credentials', scope: 'accounting.transactions accounting.settings' };
        const t = await oauthToken(ctx, { url: cfg.tokenUrl || TOKEN_URL, basic: { id: c.clientId, secret: c.clientSecret }, form });
        if (t.raw.refresh_token && c.refreshToken && t.raw.refresh_token !== c.refreshToken && ctx.saveCredentials) { await ctx.saveCredentials({ refreshToken: t.raw.refresh_token }); c.refreshToken = t.raw.refresh_token; }
        return { headers: { Authorization: `Bearer ${t.token}`, 'xero-tenant-id': cfg.tenantId, Accept: 'application/json' } };
    },
    async healthCheck(ctx) {
        const r = await ctx.http.request({ url: `${ctx.conn.config.baseUrl || API}/Organisation`, headers: ctx.auth.headers });
        return `connected to ${(r.json && r.json.Organisations && r.json.Organisations[0] && r.json.Organisations[0].Name) || 'organisation'}`;
    },
    async push(entity, payload, ctx, { remoteId, hash, record }) {
        const api = ctx.conn.config.baseUrl || API;
        const idem = crypto.createHash('sha256').update(`${ctx.conn.id}|${record.id}|${hash}`).digest('hex').slice(0, 40);
        if (remoteId) {
            if (payload.ManualJournals[0].Status === 'POSTED') throw Object.assign(new HttpError('This journal was already posted in Xero and cannot be edited by the API. Reverse it in Xero, then resend.', { retryable: false }), { retryable: false });
            const r = await ctx.http.request({ method: 'POST', url: `${api}/ManualJournals/${remoteId}`, headers: { ...ctx.auth.headers, 'Idempotency-Key': idem }, json: { ManualJournals: [{ ...payload.ManualJournals[0], ManualJournalID: remoteId }] } });
            return { remoteId: r.json.ManualJournals[0].ManualJournalID };
        }
        const r = await ctx.http.request({ method: 'POST', url: `${api}/ManualJournals`, headers: { ...ctx.auth.headers, 'Idempotency-Key': idem }, json: payload });
        const created = r.json && r.json.ManualJournals && r.json.ManualJournals[0];
        if (!created || created.HasValidationErrors) throw Object.assign(new Error(`Xero rejected the journal: ${JSON.stringify((created && created.ValidationErrors) || r.json).slice(0, 300)}`), { retryable: false });
        return { remoteId: created.ManualJournalID };
    }
});
