/**
 * Scheduled file drops (CSV) for legacy ERPs and payroll/GL systems that import files.
 * Drivers: local folder (dev/test, and a mounted share in production) and SFTP (interface ready; needs ssh2-sftp-client).
 * Columns are the mapping targets, so each company renames/reorders them in the mapping editor.
 */
const J = require('../journal');
const { toCsv, createFileDriver } = require('../file-drivers');
const { defineAdapter, accountsOf, ACCOUNT_FIELDS } = require('./_base');

const stamp = (d = new Date()) => d.toISOString().replace(/[-:T]/g, '').slice(0, 14);

module.exports = defineAdapter({
    key: 'file-export', name: 'CSV file export (local folder / SFTP)', category: 'file', vendor: 'Generic',
    description: 'Writes people, approved hours and payroll journal CSV files on a schedule for ERPs that import files.',
    entities: [
        { key: 'people_csv', direction: 'push', source: 'people', label: 'People' },
        { key: 'time_csv', direction: 'push', source: 'time_weeks', label: 'Approved weekly hours' },
        { key: 'journal_csv', direction: 'push', source: 'payroll_journal', label: 'Payroll journal lines' }
    ],
    credentialFields: [{ key: 'sftpPassword', label: 'SFTP password (SFTP driver)', secret: true }, { key: 'sftpPrivateKey', label: 'SFTP private key (SFTP driver)', secret: true }],
    configFields: [{ key: 'driver', label: 'Driver', default: 'local', help: 'local or sftp' }, { key: 'folder', label: 'Folder name (local driver)', default: 'default' }, { key: 'sftp.host', label: 'SFTP host' }, { key: 'sftp.port', label: 'SFTP port', default: 22 }, { key: 'sftp.username', label: 'SFTP user' }, { key: 'sftp.remoteDir', label: 'SFTP remote directory' }, ...ACCOUNT_FIELDS],
    needsVerification: [
        'SFTP: install ssh2-sftp-client, load the host key fingerprint, and test against the real server (the interface is implemented but has only been exercised through the local-folder driver)',
        'The receiving ERP\'s required file layout (column names/order, date format, header row, line endings) — adjust in the mapping editor',
        'Where the importing job picks files up and how it signals success (this connector only drops files)'
    ],
    defaultMappings: {
        people_csv: [
            { target: 'employee_number', source: 'employee_number' }, { target: 'first_name', source: 'first_name' }, { target: 'last_name', source: 'last_name' },
            { target: 'email', source: 'work_email' }, { target: 'phone', source: 'phone' }, { target: 'job_title', source: 'job.title' }, { target: 'department', source: 'job.org_unit_name' },
            { target: 'manager_id', source: 'job.manager_id' }, { target: 'location', source: 'job.location_id' }, { target: 'hire_date', source: 'hire_date' }, { target: 'status', source: 'status' }
        ],
        time_csv: [
            { target: 'person_id', source: 'person_id' }, { target: 'employee_number', source: 'employee_number' }, { target: 'week_start', source: 'date' }, { target: 'week_end', source: 'end_date' },
            { target: 'worked_hours', source: 'hours.worked' }, { target: 'regular_hours', source: 'hours.regular' }, { target: 'overtime_hours', source: 'hours.overtime' }, { target: 'double_time_hours', source: 'hours.double_time' }
        ],
        journal_csv: [
            { target: 'journal_id', source: 'id' }, { target: 'pay_date', source: 'pay_date', transform: { fn: 'date', format: 'MM/DD/YYYY' } }, { target: 'memo', source: 'memo' }, { target: 'currency', source: 'currency', default: 'USD' }
        ]
    },
    shape: {
        journal_csv(flat, record, ctx) {
            const j = J.buildJournal(record, accountsOf(ctx));
            return { rows: j.lines.map((l, i) => ({ ...flat, line: i + 1, account: l.account, debit: l.side === 'debit' ? l.amount : '', credit: l.side === 'credit' ? l.amount : '', department: l.department || '', line_memo: l.memo })) };
        }
    },
    validate(entity, payload, record, ctx) { return entity === 'journal_csv' ? J.validateJournal(record, accountsOf(ctx)) : []; },
    async authenticate() { return {}; },
    async healthCheck(ctx) {
        const d = createFileDriver(ctx.conn.orgId, driverConfig(ctx));
        const r = await d.ping();
        return r.detail || 'ok';
    },
    async pushBatch(entity, items, ctx) {
        const rows = items.flatMap((i) => (i.payload.rows ? i.payload.rows : [i.payload]));
        const columns = undefined; // column order = order of the mapping rules (the company can reorder them)
        const name = `${entity.replace('_csv', '')}_${stamp(ctx.now ? ctx.now() : new Date())}.csv`;
        const out = await createFileDriver(ctx.conn.orgId, driverConfig(ctx)).put(name, toCsv(rows, columns));
        return { file: name, bytes: out.bytes, rows: rows.length };
    }
});

function driverConfig(ctx) {
    const cfg = ctx.conn.config || {}; const cred = ctx.conn.credentials || {};
    return { driver: cfg.driver, folder: cfg.folder, sftp: { ...(cfg.sftp || {}), password: cred.sftpPassword, privateKey: cred.sftpPrivateKey } };
}
