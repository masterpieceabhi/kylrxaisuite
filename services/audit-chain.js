/**
 * Tamper-evident audit trail (optional; adopt when ready). Each audit entry can carry
 *   chain: { seq, prev, hash }   with   hash = HMAC-SHA256(key, `${prev}|${seq}|${canonicalJson(entryWithoutChain)}`)
 * so editing, deleting or re-ordering any entry breaks every hash after it, and truncating the tail is caught
 * by comparing with the stored head (organizations/{org}/audit_chain/head).
 * Key: AUDIT_CHAIN_KEY (any long random string); dev falls back to JWT_SECRET. Rotate by starting a new chain epoch (not covered here).
 *
 * To adopt, replace the body of audit() in routes/us-hr.js with `appendAudit(orgId, entry)`.
 * Entries written without it still show in the viewer as "unchained".
 */
const crypto = require('crypto');

const GENESIS = '0'.repeat(64);

function getKey() {
    const k = process.env.AUDIT_CHAIN_KEY || (process.env.NODE_ENV !== 'production' ? process.env.JWT_SECRET : null);
    if (!k) throw new Error('AUDIT_CHAIN_KEY is not set');
    return k;
}

/** JSON with sorted keys so the same data always hashes the same, whatever order Firestore returns fields in */
function canonical(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
    return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

function hashFor(entry, prev, seq, key = getKey()) {
    const { chain, _id, ...body } = entry;
    return crypto.createHmac('sha256', key).update(`${prev}|${seq}|${canonical(body)}`).digest('hex');
}

function seal(entry, prev, seq, key) {
    return { ...entry, chain: { seq, prev, hash: hashFor(entry, prev, seq, key) } };
}

/**
 * Checks entries (any order). Returns { total, chained, unchained, valid, firstBreak, gaps }.
 * `head` is the stored { seq, hash } to detect a truncated tail (optional).
 */
function verifyChain(entries, { key, head } = {}) {
    const k = key || getKey();
    const chained = entries.filter((e) => e.chain && Number.isInteger(e.chain.seq)).sort((a, b) => a.chain.seq - b.chain.seq);
    const report = { total: entries.length, chained: chained.length, unchained: entries.length - chained.length, valid: true, firstBreak: null, gaps: [], checkedThroughSeq: null };
    let prevHash = GENESIS; let expectSeq = 1;
    const breakAt = (e, reason) => { if (!report.firstBreak) report.firstBreak = { seq: e.chain.seq, id: e._id || null, reason }; report.valid = false; };
    for (const e of chained) {
        if (e.chain.seq !== expectSeq) {
            report.gaps.push({ expected: expectSeq, found: e.chain.seq });
            breakAt(e, e.chain.seq > expectSeq ? 'entries are missing before this one' : 'duplicate or out-of-order sequence number');
            expectSeq = e.chain.seq; prevHash = e.chain.prev; // resync so later entries are still checked
        }
        if (e.chain.prev !== prevHash) breakAt(e, 'link to the previous entry does not match');
        const good = hashFor(e, e.chain.prev, e.chain.seq, k);
        const a = Buffer.from(good); const b = Buffer.from(String(e.chain.hash || ''));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) breakAt(e, 'entry content was changed after it was written');
        prevHash = e.chain.hash; expectSeq = e.chain.seq + 1; report.checkedThroughSeq = e.chain.seq;
    }
    if (head && head.seq !== undefined) {
        const last = chained[chained.length - 1];
        if (!last || last.chain.seq < head.seq || (last.chain.seq === head.seq && last.chain.hash !== head.hash)) {
            report.valid = false; report.headMismatch = true;
            if (!report.firstBreak) report.firstBreak = { seq: head.seq, id: null, reason: 'the newest entries are missing (the stored head is ahead of the log)' };
        }
    }
    return report;
}

/** Appends a sealed entry inside a transaction (serialises writers per company) */
async function appendAudit(orgId, entry) {
    const { db, rawCollection } = require('../config/firebase');
    const org = rawCollection('organizations').doc(orgId);
    const headRef = org.collection('audit_chain').doc('head');
    const entryRef = org.collection('audit_logs').doc();
    return db.runTransaction(async (tx) => {
        const h = await tx.get(headRef);
        const prev = h.exists ? h.data().hash : GENESIS;
        const seq = h.exists ? h.data().seq + 1 : 1;
        const base = { at: new Date().toISOString(), ...entry };
        const sealed = seal(base, prev, seq);
        tx.set(entryRef, sealed);
        tx.set(headRef, { seq, hash: sealed.chain.hash, at: base.at });
        return entryRef.id;
    });
}

module.exports = { GENESIS, canonical, hashFor, seal, verifyChain, appendAudit };
