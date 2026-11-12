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
    return { orgId, store, client, opts, conn, log, org: deps.org, loadPeople: deps.loadPeople, loadLeave: deps.loadLeave, loadWeeks: deps.loadWeeks, pollOpts: deps.pollOpts };
}

module.exports = { makeContext, defaultLog };
