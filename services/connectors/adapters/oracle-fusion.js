/**
 * Oracle Fusion Cloud Financials: GL journal import through the ERP Integration REST service
 * (erpintegrations / importBulkData with a zipped GlInterface CSV, then the Journal Import job).
 * TEMPLATE: the GL interface column layout is ledger-specific (chart-of-accounts segments); verify before use.
 * Auth: HTTP Basic with an integration user (or a JWT bearer token supplied as accessToken).
 */
const zlib = require('zlib');
const J = require('../journal');
const { toCsv } = require('../file-drivers');
const { defineAdapter, journalEntity, ACCOUNT_FIELDS, accountsOf, b64 } = require('./_base');

const PATH = '/fscmRestApi/resources/11.13.18.05/erpintegrations';

/** Minimal ZIP writer (single file, stored). Uses zlib.crc32 (Node 22+). */
function zipStore(name, data) {
    const nameBuf = Buffer.from(name); const crc = zlib.crc32(data) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(0, 42);
    const cd = Buffer.concat([central, nameBuf]); const off = local.length + nameBuf.length + data.length;
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([local, nameBuf, data, cd, end]);
}

const COLUMNS = ['Status', 'Ledger ID', 'Effective Date of Transaction', 'Journal Source', 'Journal Category', 'Currency Code', 'Journal Entry Creation Date', 'Actual Flag', 'Segment1', 'Segment2', 'Entered Debit Amount', 'Entered Credit Amount', 'Batch Name', 'Journal Entry Name', 'Journal Entry Line Description', 'END'];

module.exports = defineAdapter({
    key: 'oracle-fusion', name: 'Oracle Fusion Cloud Financials', category: 'erp', vendor: 'Oracle',
    description: 'Submits payroll as a GL journal import file (template: verify the interface layout for your ledger).',
    entities: [journalEntity],
    credentialFields: [{ key: 'username', label: 'Integration user' }, { key: 'password', label: 'Password', secret: true }, { key: 'accessToken', label: 'Bearer token (alternative)', secret: true }],
    configFields: [{ key: 'baseUrl', label: 'Fusion URL (https://xxx.fa.us2.oraclecloud.com)', required: true }, { key: 'ledgerId', label: 'Ledger ID', required: true }, { key: 'journalSource', label: 'Journal source', default: 'Payroll' }, { key: 'journalCategory', label: 'Journal category', default: 'Payroll' }, { key: 'importJobParams', label: 'Journal Import job parameter list' }, ...ACCOUNT_FIELDS],
    needsVerification: [
        'The Journal Source and Category names must exist (Setup and Maintenance), and the Journal Import job needs the data access set / ledger ID parameter list',
        'GlInterface column order and the SEGMENT columns: your chart of accounts may have 3 to 30 segments; account values here fill Segment1',
        'Whether your pod exposes REST 11.13.18.05 and permits erpintegrations importBulkData for the integration user (roles: Financial Integration Specialist)',
        'Document account (fin$/generalLedger$/import$), the job name oracle/apps/ess/financials/generalLedger/programs/common,JournalImportLauncher and status polling of the returned ReqstId'
    ],
    defaultMappings: {
        journal: [
            { target: 'effectiveDate', source: 'pay_date', transform: { fn: 'date', format: 'YYYY/MM/DD' }, required: true },
            { target: 'batchName', source: 'id', transform: { fn: 'truncate', length: 80 }, required: true },
            { target: 'journalName', source: 'memo', transform: { fn: 'truncate', length: 100 } }
        ]
    },
    shape: {
        journal(flat, record, ctx) {
            const j = J.buildJournal(record, accountsOf(ctx)); const cfg = ctx.conn.config;
            const rows = j.lines.map((l) => ({
                Status: 'NEW', 'Ledger ID': cfg.ledgerId, 'Effective Date of Transaction': flat.effectiveDate, 'Journal Source': cfg.journalSource || 'Payroll', 'Journal Category': cfg.journalCategory || 'Payroll', 'Currency Code': record.currency || 'USD',
                'Journal Entry Creation Date': flat.effectiveDate, 'Actual Flag': 'A', Segment1: l.account, Segment2: l.department || '', 'Entered Debit Amount': l.side === 'debit' ? l.amount : '', 'Entered Credit Amount': l.side === 'credit' ? l.amount : '',
                'Batch Name': flat.batchName, 'Journal Entry Name': flat.journalName || flat.batchName, 'Journal Entry Line Description': l.memo, END: 'END'
            }));
            return { fileName: `GlInterface_${String(flat.batchName).replace(/[^A-Za-z0-9_-]/g, '')}`, csv: toCsv(rows, COLUMNS) };
        }
    },
    validate(entity, payload, record, ctx) { return [...J.validateJournal(record, accountsOf(ctx)), ...(ctx.conn.config.ledgerId ? [] : ['ledgerId is not configured'])]; },
    async authenticate(ctx) {
        const c = ctx.conn.credentials;
        return { headers: { Authorization: c.accessToken ? `Bearer ${c.accessToken}` : `Basic ${b64(`${c.username}:${c.password}`)}`, Accept: 'application/json' } };
    },
    async healthCheck(ctx) {
        await ctx.http.request({ url: `${ctx.conn.config.baseUrl}${PATH}`, headers: ctx.auth.headers, query: { limit: 1 }, expect: true });
        return 'ERP integration service reachable';
    },
    async push(entity, payload, ctx) {
        const cfg = ctx.conn.config;
        const zip = zipStore(`${payload.fileName}.csv`, Buffer.from(payload.csv));
        const r = await ctx.http.request({
            method: 'POST', url: `${cfg.baseUrl}${PATH}`, headers: ctx.auth.headers,
            json: {
                OperationName: 'importBulkData', DocumentContent: zip.toString('base64'), ContentType: 'zip', FileName: `${payload.fileName}.zip`, DocumentAccount: 'fin$/generalLedger$/import$',
                JobName: 'oracle/apps/ess/financials/generalLedger/programs/common,JournalImportLauncher', ParameterList: cfg.importJobParams || `${cfg.ledgerId},${cfg.journalSource || 'Payroll'},#NULL,N,N,N`, NotificationCode: '30'
            }
        });
        const id = r.json && (r.json.ReqstId || r.json.requestId);
        if (!id) throw Object.assign(new Error('Oracle did not return a request id (ReqstId)'), { retryable: false });
        return { remoteId: String(id) };
    }
});
module.exports.zipStore = zipStore;
