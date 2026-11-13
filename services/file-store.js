/**
 * Encrypted file storage for the document vault.
 *
 * Files are encrypted (AES-256-GCM, bound to the company and document id) before they touch disk and
 * live OUTSIDE the web root: VAULT_DIR, default a "kylrxaisuite-vault" folder next to the app. This
 * local driver is the simplest thing that works on one server; a multi-server deployment should
 * replace these three functions with Firebase Storage or S3 using the same encrypt/decrypt calls.
 */
const fs = require('fs');
const path = require('path');
const { encryptBuffer, decryptBuffer } = require('./pii-crypto');

const ROOT = path.resolve(process.env.VAULT_DIR || path.join(__dirname, '..', '..', 'kylrxaisuite-vault'));
const SAFE = /^[A-Za-z0-9_-]{1,128}$/;

function locate(orgId, docId) {
    if (!SAFE.test(String(orgId)) || !SAFE.test(String(docId))) throw new Error('Invalid storage id');
    return { dir: path.join(ROOT, orgId), file: path.join(ROOT, orgId, `${docId}.bin`) };
}

async function saveFile(orgId, docId, buffer) {
    const { dir, file } = locate(orgId, docId);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(file, encryptBuffer(buffer, `${orgId}:${docId}`), { flag: 'wx' });
}

async function readFile(orgId, docId) {
    const { file } = locate(orgId, docId);
    return decryptBuffer(await fs.promises.readFile(file), `${orgId}:${docId}`);
}

async function removeFile(orgId, docId) {
    const { file } = locate(orgId, docId);
    await fs.promises.rm(file, { force: true });
}

module.exports = { ROOT, saveFile, readFile, removeFile };
