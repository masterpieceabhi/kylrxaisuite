/**
 * Microsoft Dynamics 365 Finance: general journal header + lines through the Finance and Operations OData endpoint.
 * TEMPLATE: entity and field names (LedgerJournalHeaders / LedgerJournalLines) must be verified against your environment.
 * Auth: Microsoft Entra ID (Azure AD) client credentials, scope <environment URL>/.default.
 * The two calls are not atomic: if the lines fail after the header was created the error names the journal batch number so it can be removed.
 */
const J = require('../journal');
const { defineAdapter, oauthToken, journalEntity, ACCOUNT_FIELDS, accountsOf } = require('./_base');

module.exports = defineAdapter({
    key: 'dynamics365', name: 'Microsoft Dynamics 365 Finance', category: 'erp', vendor: 'Microsoft',
    description: 'Creates a general journal with one line per posting (template: verify fields against your environment).',
    entities: [journalEntity],
    credentialFields: [{ key: 'clientId', label: 'App (client) ID' }, { key: 'clientSecret', label: 'Client secret', secret: true }],
    configFields: [{ key: 'baseUrl', label: 'Environment URL (https://contoso.operations.dynamics.com)', required: true }, { key: 'tenantId', label: 'Entra tenant ID', required: true }, { key: 'legalEntity', label: 'Legal entity (dataAreaId)', required: true }, { key: 'journalName', label: 'Journal name', default: 'GenJrn' }, { key: 'tokenUrl', label: 'Token URL override' }, ...ACCOUNT_FIELDS],
    needsVerification: [
        'Azure app registration registered in Dynamics (System administration > Microsoft Entra ID applications) mapped to a user with journal-entry rights',
        'Entity names and fields: LedgerJournalHeaders (JournalName, Description), LedgerJournalLines (AccountDisplayValue, AmountCurDebit/Credit, TransDate, Text, CurrencyCode)',
        'AccountDisplayValue must be the full ledger dimension string (e.g. 600100-001-022) including your financial dimensions',
        'Journal name must exist in General ledger > Journal setup > Journal names and allow API posting; posting itself is a separate step (not done here)',
        'Whether your environment supports the lines in a single $batch changeset (recommended for atomicity)'
    ],
    defaultMappings: {
        journal: [
            { target: 'Description', source: 'memo', transform: { fn: 'truncate', length: 60 }, required: true },
            { target: 'TransDate', source: 'pay_date', transform: { fn: 'date', format: 'YYYY-MM-DD' }, required: true }
        ]
    },
    shape: {
        journal(flat, record, ctx) {
            const j = J.buildJournal(record, accountsOf(ctx)); const cfg = ctx.conn.config;
            return {
                header: { dataAreaId: cfg.legalEntity, JournalName: cfg.journalName || 'GenJrn', Description: flat.Description },
                lines: j.lines.map((l, i) => ({
                    dataAreaId: cfg.legalEntity, LineNumber: i + 1, AccountType: 'Ledger', AccountDisplayValue: String(l.account), TransDate: flat.TransDate, Text: String(l.memo).slice(0, 60),
                    CurrencyCode: record.currency || 'USD', AmountCurDebit: l.side === 'debit' ? l.amount : 0, AmountCurCredit: l.side === 'credit' ? l.amount : 0
                }))
            };
        }
    },
    validate(entity, payload, record, ctx) { return [...J.validateJournal(record, accountsOf(ctx)), ...(ctx.conn.config.legalEntity ? [] : ['legalEntity is not configured'])]; },
    async authenticate(ctx) {
        const c = ctx.conn.credentials; const cfg = ctx.conn.config;
        const url = cfg.tokenUrl || `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`;
        const t = await oauthToken(ctx, { url, form: { grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.clientSecret, scope: `${cfg.baseUrl}/.default` } });
        return { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } };
    },
    async healthCheck(ctx) {
        await ctx.http.request({ url: `${ctx.conn.config.baseUrl}/data/LedgerJournalHeaders`, headers: ctx.auth.headers, query: { $top: 1, 'cross-company': 'true' } });
        return 'OData endpoint reachable';
    },
    async push(entity, payload, ctx, { remoteId }) {
        if (remoteId) throw Object.assign(new Error(`Journal ${remoteId} already exists in Dynamics; edit or delete it there, then resend.`), { retryable: false });
        const cfg = ctx.conn.config; const url = `${cfg.baseUrl}/data`;
        const h = await ctx.http.request({ method: 'POST', url: `${url}/LedgerJournalHeaders`, headers: ctx.auth.headers, json: payload.header });
        const batch = h.json && h.json.JournalBatchNumber;
        if (!batch) throw Object.assign(new Error('Dynamics did not return a JournalBatchNumber'), { retryable: false });
        try {
            for (const line of payload.lines) await ctx.http.request({ method: 'POST', url: `${url}/LedgerJournalLines`, headers: ctx.auth.headers, json: { ...line, JournalBatchNumber: batch } });
        } catch (e) { throw Object.assign(new Error(`Journal ${batch} was created but a line failed (${e.message}). Remove journal ${batch} in Dynamics before resending.`), { retryable: false }); }
        return { remoteId: String(batch) };
    }
});
