/**
 * File export drivers for legacy ERPs that take CSV drops.
 *   LocalFolderDriver  writes into a folder under CONNECTOR_EXPORT_DIR (the test/dev driver)
 *   SftpDriver         same interface; needs the optional `ssh2-sftp-client` package.
 *                      TODO(prod): npm i ssh2-sftp-client, pin the host key fingerprint, test against a real SFTP host.
 */
const fs = require('fs');
const path = require('path');

const EXPORT_ROOT = () => path.resolve(process.env.CONNECTOR_EXPORT_DIR || path.join(__dirname, '..', '..', 'data', 'exports'));

/** CSV cell with RFC 4180 quoting; text starting with = + - @ is prefixed to stop spreadsheet formula injection */
function csvCell(v, { raw = false } = {}) {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (!raw && typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns) {
    const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const head = cols.map((c) => csvCell(c, { raw: true })).join(',');
    return `${[head, ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n')}\r\n`;
}

function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
        else if (c === '"') q = true;
        else if (c === ',') { row.push(cell); cell = ''; }
        else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
        else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    const [head, ...body] = rows;
    return head ? body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? '']))) : [];
}

const safeName = (n) => {
    const s = String(n);
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(s) || s.includes('..')) throw new Error('unsafe file name');
    return s;
};

class LocalFolderDriver {
    /** `folder` is a simple name; the driver can only write inside EXPORT_ROOT/<orgId>/<folder> */
    constructor({ orgId, folder = 'default' }) {
        if (!/^[A-Za-z0-9_-]{1,60}$/.test(String(folder)) || !/^[A-Za-z0-9_-]{1,80}$/.test(String(orgId))) throw new Error('invalid export folder');
        this.dir = path.join(EXPORT_ROOT(), orgId, folder);
    }
    async put(name, content) { fs.mkdirSync(this.dir, { recursive: true }); const p = path.join(this.dir, safeName(name)); fs.writeFileSync(p, content); return { path: p, bytes: Buffer.byteLength(content) }; }
    async list() { return fs.existsSync(this.dir) ? fs.readdirSync(this.dir).sort() : []; }
    async get(name) { return fs.readFileSync(path.join(this.dir, safeName(name)), 'utf8'); }
    async ping() { fs.mkdirSync(this.dir, { recursive: true }); fs.accessSync(this.dir, fs.constants.W_OK); return { ok: true, detail: 'local folder is writable' }; }
}

class SftpDriver {
    /** config: { host, port, username, password | privateKey, remoteDir }. `client` may be injected (tests). */
    constructor(config, client) { this.config = config || {}; this.client = client || null; }
    async _connect() {
        if (this.client) return this.client;
        let Sftp;
        try { Sftp = require('ssh2-sftp-client'); } catch (_) { throw new Error('SFTP driver is not installed on this server (npm i ssh2-sftp-client). Use the local folder driver until it is.'); }
        const c = new Sftp();
        await c.connect({ host: this.config.host, port: this.config.port || 22, username: this.config.username, password: this.config.password, privateKey: this.config.privateKey, readyTimeout: 15000 });
        return c;
    }
    async _done(c) { if (c.end && !this.client) await c.end(); }
    async put(name, content) { const c = await this._connect(); const remote = `${String(this.config.remoteDir || '').replace(/\/$/, '')}/${safeName(name)}`; await c.put(Buffer.from(content), remote); await this._done(c); return { path: remote, bytes: Buffer.byteLength(content) }; }
    async list() { const c = await this._connect(); const l = await c.list(this.config.remoteDir || '/'); await this._done(c); return l.map((x) => x.name).sort(); }
    async get() { throw new Error('not implemented'); }
    async ping() { const c = await this._connect(); await this._done(c); return { ok: true, detail: String(this.config.host) }; }
}

function createFileDriver(orgId, config, deps = {}) {
    if (config.driver === 'sftp') return new SftpDriver(config.sftp || {}, deps.sftpClient);
    return new LocalFolderDriver({ orgId, folder: config.folder || 'default' });
}

module.exports = { csvCell, toCsv, parseCsv, LocalFolderDriver, SftpDriver, createFileDriver, EXPORT_ROOT };
