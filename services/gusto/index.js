/**
 * Builds the per-company context used by every Gusto service: stored connection, resolved config, HTTP client.
 */
const config = require('./config');
const { createClient } = require('./client');
const { defaultStore } = require('./store');

const defaultLog = (() => {
    let logger = null;
    const l = () => { if (!logger) logger = require('../../utils/logger'); return logger; };
    const wrap = (level) => (msg, fields) => l()[level](fields ? `${msg} ${JSON.stringify(fields)}` : msg);
    return { info: wrap('info'), warn: wrap('warn'), error: wrap('error') };
})();

/**
 * @param {string} orgId
 * @param {object} [deps] { store, fetchImpl, log, org, loadPeople, loadLeave, loadWeeks, pollOpts }  (test seams)
 */
async function makeContext(orgId, deps = {}) {
    const store = deps.store || defaultStore();
    const conn = (await store.getConnection(orgId)) || {};
    const stored = { mode: conn.mode, clientId: conn.clientId || null, clientSecret: null };
    if (!process.env.GUSTO_CLIENT_SECRET && conn.clientSecretEnc) stored.clientSecret = await store.getClientSecret(orgId);
    const opts = { ...config.resolve(stored), ...(deps.optsOverride || {}) };
    const log = deps.log || defaultLog;
    const client = createClient({ orgId, opts, store, log, fetchImpl: deps.fetchImpl, sleep: deps.sleep });
    return { orgId, store, client, opts, conn, log, org: deps.org, loadPeople: deps.loadPeople, loadLeave: deps.loadLeave, loadWeeks: deps.loadWeeks, pollOpts: deps.pollOpts,
        // optional storage and event hooks (tests pass in-memory ones; production uses Firestore and the event outbox)
        savePayResults: deps.savePayResults, listPayResults: deps.listPayResults, deletePayResults: deps.deletePayResults, emitEvent: deps.emitEvent,
        // seams for the extra features: local contractors, the 1099 ledger, the benefit deduction feed, today's date, saving a person's state tax answers
        loadContractors: deps.loadContractors, ledger: deps.ledger, loadDeductionFeed: deps.loadDeductionFeed, today: deps.today, fetchImpl: deps.fetchImpl };
}

module.exports = { makeContext, defaultLog };
