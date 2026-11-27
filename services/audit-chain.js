/**
 * Tamper-evident audit trail. Each audit entry written by audit() in routes/us-hr.js carries
 *   chain: { seq, prev, hash }   with   hash = HMAC-SHA256(key, `${prev}|${seq}|${canonicalJson(entryWithoutChain)}`)
 * so editing, deleting or re-ordering any entry breaks every hash after it, and truncating the tail is caught
 * by comparing with the stored head (organizations/{org}/audit_chain/head).
 * Key: AUDIT_CHAIN_KEY (any long random string); dev falls back to JWT_SECRET. Rotate by starting a new chain epoch (not covered here).
 *
 * audit() in routes/us-hr.js writes through writeAudit(): chained when possible, and a plain (unchained) entry when the
 * chain cannot be written (no key, the database refused the transaction, it took too long). The audit entry itself is
 * never dropped because of the chain, and a chain problem never reaches the request.
 * Entries written without a chain (older ones, a few direct writers) still show in the viewer as "unchained".
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
function verifyChain(entries, { key, head, partial = false } = {}) {
    const k = key || getKey();
    const chained = entries.filter((e) => e.chain && Number.isInteger(e.chain.seq)).sort((a, b) => a.chain.seq - b.chain.seq);
    const report = { total: entries.length, chained: chained.length, unchained: entries.length - chained.length, valid: true, firstBreak: null, gaps: [], checkedThroughSeq: null };
    let prevHash = GENESIS; let expectSeq = 1;
    // partial: only the newest entries were loaded (a very long log), so the check starts at the oldest one loaded
    if (partial && chained.length && chained[0].chain.seq > 1) { expectSeq = chained[0].chain.seq; prevHash = chained[0].chain.prev; report.partialFromSeq = expectSeq; }
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

/**
 * What is hashed must be exactly what the database gives back later, so the entry is reduced to plain JSON first:
 * dates become ISO text, undefined fields go away, NaN becomes null.
 */
const plain = (entry) => JSON.parse(JSON.stringify(entry));

const CHAIN_TIMEOUT_MS = 15000;
const tails = new Map(); // orgId -> the last chain write of this process, so writes for one company go one after another
let warnedNoKey = false;

const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`audit chain write took longer than ${ms} ms`)), ms);
    if (typeof t.unref === 'function') t.unref();
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

/**
 * The audit writer. Tries a chained entry; if that fails for any reason, writes the same entry without a chain.
 * Never rejects. Resolves to { id, chained } or, when even the plain write failed, { id: null, chained: false, error }.
 * deps (tests only): { append, addPlain, log, timeoutMs }.
 */
function writeAudit(orgId, entry, deps = {}) {
    const log = deps.log || ((msg) => { try { require('../utils/logger').error(msg); } catch (_) { console.error(msg); } });
    const append = deps.append || appendAudit;
    const addPlain = deps.addPlain || ((o, e) => require('../config/firebase').rawCollection('organizations').doc(o).collection('audit_logs').add(e).then((ref) => ref.id));
    const timeoutMs = deps.timeoutMs || CHAIN_TIMEOUT_MS;
    const stamped = { at: new Date().toISOString(), ...entry }; // the time of the action, not of the write

    const fallback = async (why) => {
        if (why) log(`Audit chain write failed, entry kept without a chain: ${why}`);
        try { return { id: await addPlain(orgId, stamped), chained: false }; } catch (e) { log(`Audit write failed: ${e.message}`); return { id: null, chained: false, error: e.message }; }
    };

    let body;
    try { getKey(); body = plain(stamped); } catch (e) {
        if (/AUDIT_CHAIN_KEY/.test(e.message)) { const first = !warnedNoKey; warnedNoKey = true; return fallback(first ? 'AUDIT_CHAIN_KEY is not set (this is logged once)' : null); }
        return fallback(e.message);
    }
    const prevTail = tails.get(orgId) || Promise.resolve();
    const run = prevTail.then(() => withTimeout(Promise.resolve().then(() => append(orgId, body)), timeoutMs))
        .then((id) => ({ id, chained: true }), (e) => fallback(e && e.message ? e.message : String(e)));
    const tail = run.then(() => undefined, () => undefined);
    tails.set(orgId, tail);
    tail.then(() => { if (tails.get(orgId) === tail) tails.delete(orgId); });
    return run;
}

module.exports = { GENESIS, canonical, hashFor, seal, verifyChain, appendAudit, writeAudit, plain };
