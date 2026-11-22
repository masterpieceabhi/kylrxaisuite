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

/**
 * Accepts the host key fingerprint either as OpenSSH prints it ("SHA256:<base64>") or as hex (with or without colons).
 * Returns lowercase hex, or null when nothing was given.
 */
function normaliseFingerprint(fp) {
    const s = String(fp || '').trim();
    if (!s) return null;
    if (/^SHA256:/i.test(s)) return Buffer.from(s.slice(7), 'base64').toString('hex');
    const hex = s.replace(/:/g, '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

class SftpDriver {
    /**
     * config: { host, port, username, password | privateKey, remoteDir, hostFingerprint }.
     * hostFingerprint is required for a real connection: the server's key must match it, or the connection is refused.
     * `client` (a ready client) and `loadSftp` (returns the library's constructor) may be injected for tests.
     */
    constructor(config, client, loadSftp) { this.config = config || {}; this.client = client || null; this.loadSftp = loadSftp || (() => require('ssh2-sftp-client')); }
    async _connect() {
        if (this.client) return this.client;
        let Sftp;
        try { Sftp = this.loadSftp(); } catch (_) { throw new Error('SFTP driver is not installed on this server (npm i ssh2-sftp-client). Use the local folder driver until it is.'); }
        const want = normaliseFingerprint(this.config.hostFingerprint);
        if (!want) throw new Error('SFTP server fingerprint is not set: add the server SHA256 fingerprint to this connection before using SFTP');
        const c = new Sftp();
        const opts = { host: this.config.host, port: this.config.port || 22, username: this.config.username, password: this.config.password, privateKey: this.config.privateKey, readyTimeout: 15000 };
        opts.hostHash = 'sha256';
        opts.hostVerifier = (hexDigest) => String(hexDigest).toLowerCase() === want;
        await c.connect(opts);
        return c;
    }
    async _done(c) { if (c.end && !this.client) await c.end(); }
    _remote(name) { return `${String(this.config.remoteDir || '').replace(/\/$/, '')}/${safeName(name)}`; }
    async put(name, content) { const c = await this._connect(); const remote = this._remote(name); try { await c.put(Buffer.from(content), remote); } finally { await this._done(c); } return { path: remote, bytes: Buffer.byteLength(content) }; }
    async list() { const c = await this._connect(); try { const l = await c.list(this.config.remoteDir || '/'); return l.map((x) => x.name).sort(); } finally { await this._done(c); } }
    async get(name) { const c = await this._connect(); try { const buf = await c.get(this._remote(name)); return Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf); } finally { await this._done(c); } }
    async ping() { const c = await this._connect(); await this._done(c); return { ok: true, detail: String(this.config.host) }; }
}

function createFileDriver(orgId, config, deps = {}) {
    if (config.driver === 'sftp') return new SftpDriver(config.sftp || {}, deps.sftpClient, deps.loadSftp);
    return new LocalFolderDriver({ orgId, folder: config.folder || 'default' });
}

module.exports = { csvCell, toCsv, parseCsv, LocalFolderDriver, SftpDriver, createFileDriver, normaliseFingerprint, EXPORT_ROOT };
