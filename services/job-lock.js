/**
 * One copy of the server runs each background job.
 *
 * The jobs (outgoing webhooks, connector schedules, scheduled report copies, due pay changes, exits taking effect,
 * the photo purge, the Gusto poll) are timers inside the server process. With two copies of the server each one
 * would fire in both: some things sent twice, some copies made twice. A lease in the database decides which copy
 * runs a job: the copy that holds it runs, the other skips that tick. If the holder stops, its lease runs out and
 * the other copy takes over at its next tick.
 *
 *   const guarded = jobLock.guard('webhooks', 5000, tick);   // use `guarded` where `tick` was used
 *
 * - The lease lasts one and a half intervals (at least 30 seconds) and is renewed by its holder when under half is
 *   left, so a frequent job does not write to the database on every tick.
 * - If the lease cannot be read or written (the database is unreachable, or a test stand-in has no transactions),
 *   the job RUNS. Skipping would silently stop every job on a single server, which is the usual set-up; the worst
 *   case of running is what happened before this file existed.
 * - JOB_LOCKS=off switches the leases off (every copy runs every job, as before).
 */
const crypto = require('crypto');

const ME = `${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
const COLLECTION = 'job_locks';
const MIN_LEASE_MS = 30000;
const leaseFor = (intervalMs) => Math.max(MIN_LEASE_MS, Math.round(Number(intervalMs || 0) * 1.5));

/** What this process believes it holds: name -> expiry (ms). Saves a database read while a lease is fresh. */
const mine = new Map();
let warned = false;

function defaultStore() {
    const { admin, rawCollection } = require('../config/firebase');
    return {
        /** fn(current) -> next document or null (no change). Resolves what fn decided. */
        async transact(name, fn) {
            const ref = rawCollection(COLLECTION).doc(name);
            return admin.firestore().runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                const cur = (typeof snap.exists === 'function' ? snap.exists() : snap.exists) ? snap.data() : null;
                const out = fn(cur);
                if (out.write) tx.set(ref, out.write);
                return out.result;
            });
        }
    };
}

/**
 * May this copy run the job now? true = run. deps (tests): { store, now, holder, env, log }.
 */
async function acquire(name, intervalMs, deps = {}) {
    const env = deps.env || process.env;
    if (env.JOB_LOCKS === 'off') return true;
    const now = deps.now ? deps.now() : Date.now();
    const holder = deps.holder || ME;
    const lease = leaseFor(intervalMs);
    const held = deps.memory || mine;
    const key = `${holder}:${name}`;
    if ((held.get(key) || 0) - now > lease / 2) return true; // still comfortably ours: no database call
    try {
        const store = deps.store || defaultStore();
        const got = await store.transact(name, (cur) => {
            if (cur && cur.holder !== holder && Number(cur.expiresAt) > now) return { result: false };
            return { write: { name, holder, expiresAt: now + lease, renewedAt: new Date(now).toISOString() }, result: true };
        });
        if (got) held.set(key, now + lease); else held.delete(key);
        return Boolean(got);
    } catch (e) {
        held.delete(key);
        if (!warned) { warned = true; const log = deps.log || ((m) => { try { require('../utils/logger').warn(m); } catch (_) { /* logging must not throw */ } }); log(`[JobLock] the lease for background jobs could not be checked (${e.message}); jobs run without it (logged once)`); }
        return true;
    }
}

/** Wraps a job's tick: it runs only on the copy that holds the lease. The wrapper resolves what the tick resolves, or undefined when skipped. */
function guard(name, intervalMs, fn, deps) {
    return async (...args) => {
        if (!(await acquire(name, intervalMs, deps))) return undefined;
        return fn(...args);
    };
}

module.exports = { acquire, guard, leaseFor, COLLECTION, _reset: () => { mine.clear(); warned = false; } };
