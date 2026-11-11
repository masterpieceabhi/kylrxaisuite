/**
 * Field-level encryption for sensitive personal data (SSN/ITIN, later bank numbers).
 * AES-256-GCM; the ciphertext is bound to a context string (organization + record), so a value
 * copied onto another record fails to decrypt.
 *
 * Key: PII_ENCRYPTION_KEY = 32 random bytes, base64 (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))").
 * Production refuses to run without it. Outside production a key is derived from JWT_SECRET so
 * local testing works; data written that way must not be kept.
 */
const crypto = require('crypto');

const VERSION = 'v1';
let devKeyWarned = false;

function getKey() {
    const raw = process.env.PII_ENCRYPTION_KEY;
    if (raw) {
        const key = Buffer.from(raw, 'base64');
        if (key.length !== 32) {
            throw new Error('PII_ENCRYPTION_KEY must be 32 bytes encoded as base64');
        }
        return key;
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error('PII_ENCRYPTION_KEY is required in production');
    }
    if (!process.env.JWT_SECRET) {
        throw new Error('PII_ENCRYPTION_KEY is not set');
    }
    if (!devKeyWarned) {
        devKeyWarned = true;
        console.warn('PII_ENCRYPTION_KEY not set: using a key derived from JWT_SECRET (local testing only).');
    }
    return crypto.scryptSync(process.env.JWT_SECRET, 'kylrx-pii-dev', 32);
}

function encryptField(plain, context) {
    if (plain === undefined || plain === null || plain === '') return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    cipher.setAAD(Buffer.from(String(context || '')));
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

function decryptField(payload, context) {
    if (!payload) return null;
    const parts = String(payload).split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) {
        throw new Error('Unrecognized encrypted value');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(parts[1], 'base64'));
    decipher.setAAD(Buffer.from(String(context || '')));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

/** Whole-file encryption for the document vault: [1 version byte][12 byte IV][16 byte tag][ciphertext] */
function encryptBuffer(buf, context) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    cipher.setAAD(Buffer.from(String(context || '')));
    const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
}

function decryptBuffer(blob, context) {
    if (!blob || blob.length < 30 || blob[0] !== 1) throw new Error('Unrecognized encrypted file');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), blob.slice(1, 13));
    decipher.setAAD(Buffer.from(String(context || '')));
    decipher.setAuthTag(blob.slice(13, 29));
    return Buffer.concat([decipher.update(blob.slice(29)), decipher.final()]);
}

module.exports = { encryptField, decryptField, encryptBuffer, decryptBuffer };
