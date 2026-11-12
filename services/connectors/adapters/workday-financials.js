/**
 * Workday Financial Management: payroll accounting journal through the SOAP web service
 * (Financial_Management, operation Submit_Accounting_Journal).
 * TEMPLATE: element names and reference ID types follow the Workday Web Services directory but vary by service version and tenant
 * configuration; every item in `needsVerification` must be confirmed in your tenant's API explorer.
 * Auth: Integration System User with WS-Security UsernameToken.
 */
const J = require('../journal');
const { defineAdapter, journalEntity, ACCOUNT_FIELDS, accountsOf, xmlEscape } = require('./_base');

const NS = 'urn:com.workday/bsvc';

function soap(ctx, bodyXml) {
    const c = ctx.conn.credentials; const cfg = ctx.conn.config;
    return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:bsvc="${NS}" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><soapenv:Header><wsse:Security soapenv:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${xmlEscape(c.username)}@${xmlEscape(cfg.tenant)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${xmlEscape(c.password)}</wsse:Password></wsse:UsernameToken></wsse:Security></soapenv:Header><soapenv:Body>${bodyXml}</soapenv:Body></soapenv:Envelope>`;
}
const endpoint = (cfg) => `${cfg.baseUrl}/ccx/service/${encodeURIComponent(cfg.tenant)}/Financial_Management/${cfg.version || 'v43.0'}`;

module.exports = defineAdapter({
    key: 'workday-financials', name: 'Workday Financial Management', category: 'erp', vendor: 'Workday',
    description: 'Submits payroll as an accounting journal (template: verify against your tenant).',
    entities: [journalEntity],
    credentialFields: [{ key: 'username', label: 'Integration System User' }, { key: 'password', label: 'Password', secret: true }],
    configFields: [{ key: 'baseUrl', label: 'Web services host (https://wd2-impl-services1.workday.com)', required: true }, { key: 'tenant', label: 'Tenant name', required: true }, { key: 'version', label: 'Web service version', default: 'v43.0' }, { key: 'ledgerId', label: 'Ledger reference ID', required: true }, { key: 'journalSource', label: 'Journal source reference ID', default: 'Payroll' }, ...ACCOUNT_FIELDS],
    needsVerification: [
        'Integration System User, security group with Journals domain access, and the Financial_Management service version enabled in your tenant',
        'Reference ID TYPES (Ledger_Reference ID type, Ledger_Account_Reference, Currency_ID, Company_Reference_ID, Worktag references for cost center)',
        'Required worktags per ledger account and whether journals auto-post or wait for approval (Submit_Accounting_Journal returns a Journal_Entry_Reference)',
        'SOAP fault format and the exact request element nesting for your version (compare with the WSDL / Public Web Services directory)'
    ],
    defaultMappings: {
        journal: [
            { target: 'accountingDate', source: 'pay_date', transform: { fn: 'date', format: 'YYYY-MM-DD' }, required: true },
            { target: 'memo', source: 'memo', transform: { fn: 'truncate', length: 250 } },
            { target: 'externalId', source: 'id', required: true }
        ]
    },
    shape: {
        journal(flat, record, ctx) {
            const j = J.buildJournal(record, accountsOf(ctx)); const cfg = ctx.conn.config; const cur = record.currency || 'USD';
            const lines = j.lines.map((l, i) => `<bsvc:Journal_Entry_Line_Data><bsvc:Line_Order>${i + 1}</bsvc:Line_Order><bsvc:Ledger_Account_Reference><bsvc:ID bsvc:type="Ledger_Account_ID">${xmlEscape(l.account)}</bsvc:ID></bsvc:Ledger_Account_Reference><bsvc:${l.side === 'debit' ? 'Debit_Amount' : 'Credit_Amount'}>${l.amount}</bsvc:${l.side === 'debit' ? 'Debit_Amount' : 'Credit_Amount'}><bsvc:Memo>${xmlEscape(l.memo)}</bsvc:Memo>${l.department ? `<bsvc:Worktags_Reference><bsvc:ID bsvc:type="Cost_Center_Reference_ID">${xmlEscape((cfg.departmentIds || {})[l.department] || l.department)}</bsvc:ID></bsvc:Worktags_Reference>` : ''}</bsvc:Journal_Entry_Line_Data>`).join('');
            return {
                xml: `<bsvc:Submit_Accounting_Journal_Request bsvc:version="${xmlEscape(cfg.version || 'v43.0')}"><bsvc:Business_Process_Parameters><bsvc:Auto_Complete>false</bsvc:Auto_Complete></bsvc:Business_Process_Parameters><bsvc:Accounting_Journal_Data><bsvc:Ledger_Reference><bsvc:ID bsvc:type="Ledger_Reference_ID">${xmlEscape(cfg.ledgerId)}</bsvc:ID></bsvc:Ledger_Reference><bsvc:Accounting_Date>${xmlEscape(flat.accountingDate)}</bsvc:Accounting_Date><bsvc:Journal_Source_Reference><bsvc:ID bsvc:type="Journal_Source_ID">${xmlEscape(cfg.journalSource || 'Payroll')}</bsvc:ID></bsvc:Journal_Source_Reference><bsvc:Currency_Reference><bsvc:ID bsvc:type="Currency_ID">${xmlEscape(cur)}</bsvc:ID></bsvc:Currency_Reference><bsvc:Memo>${xmlEscape(flat.memo || '')}</bsvc:Memo><bsvc:External_Reference_ID>${xmlEscape(flat.externalId)}</bsvc:External_Reference_ID>${lines}</bsvc:Accounting_Journal_Data></bsvc:Submit_Accounting_Journal_Request>`,
                externalId: flat.externalId
            };
        }
    },
    validate(entity, payload, record, ctx) { return [...J.validateJournal(record, accountsOf(ctx)), ...(ctx.conn.config.tenant && ctx.conn.config.ledgerId ? [] : ['tenant and ledgerId must be configured'])]; },
    async authenticate() { return {}; },
    async healthCheck(ctx) {
        const r = await ctx.http.request({ method: 'POST', url: endpoint(ctx.conn.config), headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml' }, body: soap(ctx, `<bsvc:Get_Ledgers_Request bsvc:version="${xmlEscape(ctx.conn.config.version || 'v43.0')}"><bsvc:Response_Filter><bsvc:Count>1</bsvc:Count></bsvc:Response_Filter></bsvc:Get_Ledgers_Request>`), expect: false });
        if (r.status >= 400 || /<faultstring>/i.test(r.text)) throw new Error((r.text.match(/<faultstring>([^<]*)/i) || [])[1] || `HTTP ${r.status}`);
        return 'Financial_Management reachable';
    },
    async push(entity, payload, ctx, { remoteId }) {
        if (remoteId) throw Object.assign(new Error(`Journal ${remoteId} was already submitted to Workday; correct it there, then resend.`), { retryable: false });
        const r = await ctx.http.request({ method: 'POST', url: endpoint(ctx.conn.config), headers: { 'Content-Type': 'text/xml; charset=utf-8', Accept: 'text/xml' }, body: soap(ctx, payload.xml), expect: false });
        const fault = (r.text.match(/<faultstring>([^<]*)/i) || [])[1];
        if (fault || r.status >= 400) throw Object.assign(new Error(`Workday rejected the journal: ${fault || `HTTP ${r.status}`}`), { retryable: r.status >= 500 && !fault });
        const wid = (r.text.match(/<wd:ID[^>]*wd:type="WID"[^>]*>([^<]*)/i) || r.text.match(/<bsvc:ID[^>]*bsvc:type="WID"[^>]*>([^<]*)/i) || [])[1];
        return { remoteId: wid || payload.externalId };
    }
});
