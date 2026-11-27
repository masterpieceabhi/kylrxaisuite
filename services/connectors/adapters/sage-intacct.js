/**
 * Sage Intacct: payroll as a GL batch (GLBATCH with GLENTRY lines) through the XML gateway.
 * Docs: https://developer.intacct.com/api/general-ledger/journal-entries/  (create GLBATCH)
 * Auth: Web Services sender ID/password (from Sage) plus a company user/password in the request itself.
 * TEMPLATE: object and field names are standard Intacct; confirm your journal symbol, dimensions and required custom fields.
 */
const crypto = require('crypto');
const J = require('../journal');
const { defineAdapter, journalEntity, ACCOUNT_FIELDS, accountsOf, xmlEscape } = require('./_base');

const GATEWAY = 'https://api.intacct.com/ia/xml/xmlgw.phtml';

function envelope(ctx, func, controlId) {
    const c = ctx.conn.credentials; const cfg = ctx.conn.config;
    return `<?xml version="1.0" encoding="UTF-8"?><request><control><senderid>${xmlEscape(c.senderId)}</senderid><password>${xmlEscape(c.senderPassword)}</password><controlid>${xmlEscape(controlId)}</controlid><uniqueid>false</uniqueid><dtdversion>3.0</dtdversion><includewhitespace>false</includewhitespace></control><operation><authentication><login><userid>${xmlEscape(c.userId)}</userid><companyid>${xmlEscape(cfg.companyId)}</companyid><password>${xmlEscape(c.userPassword)}</password></login></authentication><content><function controlid="${xmlEscape(controlId)}">${func}</function></content></operation></request>`;
}

/** Reads <status>, <errormessage> and <RECORDNO> out of a gateway response without a full XML parser */
function parseResponse(xml) {
    const tag = (n) => { const m = String(xml).match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`)); return m ? m[1] : null; };
    const statuses = [...String(xml).matchAll(/<status>([^<]*)<\/status>/g)].map((m) => m[1]);
    const ok = statuses.length > 0 && statuses.every((s) => s === 'success');
    const err = [...String(xml).matchAll(/<description2>([^<]*)<\/description2>/g)].map((m) => m[1]).join('; ') || tag('errormessage');
    return { ok, recordNo: tag('RECORDNO'), error: err };
}

module.exports = defineAdapter({
    key: 'sage-intacct', name: 'Sage Intacct', category: 'accounting', vendor: 'Sage',
    description: 'Creates a general ledger batch for each payroll.',
    entities: [journalEntity],
    credentialFields: [{ key: 'senderId', label: 'Web Services sender ID' }, { key: 'senderPassword', label: 'Sender password', secret: true }, { key: 'userId', label: 'Web Services user' }, { key: 'userPassword', label: 'User password', secret: true }],
    configFields: [{ key: 'companyId', label: 'Company ID', required: true }, { key: 'journalSymbol', label: 'GL journal symbol', default: 'PRJ', required: true }, { key: 'baseUrl', label: 'Gateway URL override' }, ...ACCOUNT_FIELDS],
    needsVerification: [
        'A Web Services authorization for our sender ID on your company (Company > Admin > Web Services authorizations), and a Web Services user',
        'The GL journal symbol exists and accepts API entries; ACCOUNTNO values are your account numbers; department/location dimensions are required or not per company setup',
        'Date format (mm/dd/yyyy) and whether your company requires BATCH_TITLE uniqueness',
        'The response shape for RECORDNO and error descriptions (parsed here with a small reader, not a full XML parser)'
    ],
    defaultMappings: {
        journal: [
            { target: 'BATCH_DATE', source: 'pay_date', transform: { fn: 'date', format: 'MM/DD/YYYY' }, required: true },
            { target: 'BATCH_TITLE', source: 'memo', transform: { fn: 'truncate', length: 80 }, required: true },
            { target: 'REFERENCENO', source: 'id', transform: { fn: 'truncate', length: 40 } }
        ]
    },
    shape: {
        journal(flat, record, ctx) {
            const j = J.buildJournal(record, accountsOf(ctx)); const cfg = ctx.conn.config;
            const entries = j.lines.map((l) => `<GLENTRY><DOCUMENT>${xmlEscape(flat.REFERENCENO || '')}</DOCUMENT><ACCOUNTNO>${xmlEscape(l.account)}</ACCOUNTNO><TRX_AMOUNT>${l.amount}</TRX_AMOUNT><TR_TYPE>${l.side === 'debit' ? 1 : -1}</TR_TYPE>${l.department ? `<DEPARTMENT>${xmlEscape((cfg.departmentIds || {})[l.department] || l.department)}</DEPARTMENT>` : ''}<DESCRIPTION>${xmlEscape(l.memo)}</DESCRIPTION></GLENTRY>`).join('');
            return { functionXml: `<create><GLBATCH><JOURNAL>${xmlEscape(cfg.journalSymbol || 'PRJ')}</JOURNAL><BATCH_DATE>${xmlEscape(flat.BATCH_DATE)}</BATCH_DATE><BATCH_TITLE>${xmlEscape(flat.BATCH_TITLE)}</BATCH_TITLE><REFERENCENO>${xmlEscape(flat.REFERENCENO || '')}</REFERENCENO><ENTRIES>${entries}</ENTRIES></GLBATCH></create>`, controlId: `pj-${crypto.createHash('sha1').update(String(flat.REFERENCENO)).digest('hex').slice(0, 12)}` };
        }
    },
    validate(entity, payload, record, ctx) { return [...J.validateJournal(record, accountsOf(ctx)), ...(ctx.conn.config.companyId ? [] : ['companyId is not configured'])]; },
    async authenticate(ctx) { return {}; },
    async healthCheck(ctx) {
        const r = await ctx.http.request({ method: 'POST', url: ctx.conn.config.baseUrl || GATEWAY, headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' }, body: envelope(ctx, '<getAPISession/>', 'health') });
        const p = parseResponse(r.text);
        if (!p.ok) throw new Error(p.error || 'Intacct rejected the credentials');
        return 'session opened';
    },
    async push(entity, payload, ctx, { remoteId }) {
        if (remoteId) throw Object.assign(new Error(`GL batch ${remoteId} already exists in Intacct; edit or reverse it there, then resend.`), { retryable: false });
        const r = await ctx.http.request({ method: 'POST', url: ctx.conn.config.baseUrl || GATEWAY, headers: { 'Content-Type': 'application/xml', Accept: 'application/xml' }, body: envelope(ctx, payload.functionXml, payload.controlId) });
        const p = parseResponse(r.text);
        if (!p.ok) throw Object.assign(new Error(`Intacct rejected the batch: ${p.error || 'unknown error'}`), { retryable: false });
        return { remoteId: p.recordNo || payload.controlId };
    }
});
module.exports.parseResponse = parseResponse;
