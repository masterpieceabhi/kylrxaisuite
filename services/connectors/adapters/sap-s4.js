/**
 * SAP S/4HANA (Cloud or on-premise): payroll journal entry through the Journal Entry OData API.
 * TEMPLATE: field names and the action URL follow API_JOURNALENTRY (OData V4 "Post" action) as documented on
 * api.sap.com, but they differ by release. Every field marked in `needsVerification` must be confirmed against your system.
 * Auth: communication user (Basic) or OAuth 2.0 client credentials from the BTP/IAS token URL.
 */
const J = require('../journal');
const { defineAdapter, oauthToken, journalEntity, ACCOUNT_FIELDS, accountsOf, b64 } = require('./_base');

const POST_PATH = '/sap/opu/odata4/sap/api_journalentry/srvd_a2x/sap/journalentry/0001/JournalEntry/SAP__self.Post';
const HEALTH_PATH = '/sap/opu/odata/sap/API_COMPANYCODE_SRV/A_CompanyCode';

module.exports = defineAdapter({
    key: 'sap-s4hana', name: 'SAP S/4HANA', category: 'erp', vendor: 'SAP',
    description: 'Posts payroll as a general ledger journal entry (template: verify fields against your release).',
    entities: [journalEntity],
    credentialFields: [{ key: 'username', label: 'Communication user' }, { key: 'password', label: 'Password', secret: true }, { key: 'clientId', label: 'OAuth client ID (optional)' }, { key: 'clientSecret', label: 'OAuth client secret', secret: true }],
    configFields: [{ key: 'baseUrl', label: 'System URL (https://my123456-api.s4hana.cloud.sap)', required: true }, { key: 'tokenUrl', label: 'OAuth token URL (if using OAuth)' }, { key: 'companyCode', label: 'Company code', required: true }, { key: 'documentType', label: 'Accounting document type', default: 'SA' }, { key: 'postPath', label: 'Post action path override' }, ...ACCOUNT_FIELDS],
    needsVerification: [
        'The exact service and action: API_JOURNALENTRY OData V4 Post vs the SOAP JournalEntryBulkCreateRequest_In, per release and Cloud vs on-premise',
        'Communication arrangement/scenario SAP_COM_0002 (Journal Entry integration) activated and the user authorised for it',
        'Property names and shapes of items: GLAccount, AmountInTransactionCurrency (value vs object), DebitCreditCode S/H, CostCenter, document type SA/PR',
        'Whether a CSRF token must be fetched first (OData V2) and whether the response returns AccountingDocument for idempotency lookups',
        'Posting period open, G/L account existence per company code, tax-relevance flags'
    ],
    defaultMappings: {
        journal: [
            { target: 'CompanyCode', source: '', default: '' },
            { target: 'DocumentDate', source: 'pay_date', transform: { fn: 'date', format: 'YYYY-MM-DD' }, required: true },
            { target: 'PostingDate', source: 'pay_date', transform: { fn: 'date', format: 'YYYY-MM-DD' }, required: true },
            { target: 'DocumentHeaderText', source: 'memo', transform: { fn: 'truncate', length: 25 } },
            { target: 'DocumentReferenceID', source: 'id', transform: { fn: 'truncate', length: 16 }, required: true }
        ]
    },
    shape: {
        journal(flat, record, ctx) {
            const j = J.buildJournal(record, accountsOf(ctx)); const cfg = ctx.conn.config;
            return {
                ...flat, CompanyCode: String(cfg.companyCode || ''), AccountingDocumentType: cfg.documentType || 'SA', OriginalReferenceDocumentType: 'BKPFF', BusinessTransactionType: 'RFBU',
                _Item: j.lines.map((l, i) => ({
                    ReferenceDocumentItem: String(i + 1), GLAccount: String(l.account), DocumentItemText: String(l.memo).slice(0, 50), ...(l.department ? { CostCenter: String((cfg.costCenters || {})[l.department] || '') } : {}),
                    AmountInTransactionCurrency: { Currency: record.currency || 'USD', Amount: (l.side === 'debit' ? 1 : -1) * l.amount }, DebitCreditCode: l.side === 'debit' ? 'S' : 'H'
                }))
            };
        }
    },
    validate(entity, payload, record, ctx) { return [...J.validateJournal(record, accountsOf(ctx)), ...(ctx.conn.config.companyCode ? [] : ['companyCode is not configured'])]; },
    async authenticate(ctx) {
        const c = ctx.conn.credentials; const cfg = ctx.conn.config;
        if (cfg.tokenUrl && c.clientId) { const t = await oauthToken(ctx, { url: cfg.tokenUrl, basic: { id: c.clientId, secret: c.clientSecret }, form: { grant_type: 'client_credentials' } }); return { headers: { Authorization: `Bearer ${t.token}`, Accept: 'application/json' } }; }
        return { headers: { Authorization: `Basic ${b64(`${c.username}:${c.password}`)}`, Accept: 'application/json' } };
    },
    async healthCheck(ctx) {
        await ctx.http.request({ url: `${ctx.conn.config.baseUrl}${HEALTH_PATH}`, headers: ctx.auth.headers, query: { $top: 1, $format: 'json' } });
        return 'company code service reachable';
    },
    async push(entity, payload, ctx) {
        const cfg = ctx.conn.config; const h = { ...ctx.auth.headers };
        const probe = await ctx.http.request({ url: `${cfg.baseUrl}${HEALTH_PATH}`, headers: { ...h, 'x-csrf-token': 'fetch' }, query: { $top: 1 }, expect: false });
        if (probe.headers && probe.headers['x-csrf-token'] && probe.headers['x-csrf-token'] !== 'Required') h['x-csrf-token'] = probe.headers['x-csrf-token'];
        const r = await ctx.http.request({ method: 'POST', url: `${cfg.baseUrl}${cfg.postPath || POST_PATH}`, headers: h, json: payload });
        const body = r.json || {};
        return { remoteId: String(body.AccountingDocument || body.d && body.d.AccountingDocument || payload.DocumentReferenceID) };
    }
});
