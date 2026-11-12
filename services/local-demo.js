/**
 * Local demo sign-in helper (developer machines only).
 *
 * The sign-in page used to carry the demo password in its own script. It no longer does: on localhost the quick sign-in
 * buttons ask GET /api/auth/dev-demo-login, and that route exists only when ALL of these hold:
 *   - NODE_ENV is not "production"
 *   - the server is talking to the Firebase emulators (both FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST are set)
 *   - the request comes from this same machine (loopback address, Host localhost / 127.0.0.1, not through a proxy)
 * The accounts are the throwaway ones made by `npm run seed:local` (scripts/seed-emulator.js); they exist only in the emulator.
 * This file is server code: middleware/static-guard.js never serves it to a browser.
 */

const ACCOUNTS = {
    superAdmin: 'superadmin@us.demo.local',
    hrAdmin: 'hr@us.demo.local',
    manager: 'manager@us.demo.local',
    employee: 'employee@us.demo.local'
};

/** Same default as scripts/seed-emulator.js (SEED_PASSWORD overrides both) */
const seedPassword = (env) => env.SEED_PASSWORD || 'LocalTest#2026';

/** Is the helper allowed to exist at all in this process? */
function enabled(env = process.env) {
    return env.NODE_ENV !== 'production' && Boolean(env.FIREBASE_AUTH_EMULATOR_HOST) && Boolean(env.FIRESTORE_EMULATOR_HOST);
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Did this request come straight from a browser on this machine? */
function isLocalRequest(req) {
    const remote = req && req.socket && req.socket.remoteAddress; // the real peer, not a forwarded header
    if (!LOOPBACK.has(String(remote || ''))) return false;
    const h = (req.headers || {});
    if (h['x-forwarded-for'] || h['x-forwarded-host'] || h.forwarded) return false; // came through a proxy or tunnel
    const host = String(h.host || '').toLowerCase().replace(/:\d+$/, '');
    return LOCAL_HOSTS.has(host);
}

/** { status, body } for a request. Anything not allowed looks like the route does not exist (404). */
function respond(req, env = process.env) {
    const notFound = { status: 404, body: { success: false, error: 'Not found' } };
    if (!enabled(env) || !isLocalRequest(req)) return notFound;
    const key = req.query && req.query.account;
    if (key === undefined || key === '') return { status: 200, body: { success: true, accounts: Object.keys(ACCOUNTS) } };
    if (!Object.prototype.hasOwnProperty.call(ACCOUNTS, String(key))) return { status: 400, body: { success: false, error: `account must be one of: ${Object.keys(ACCOUNTS).join(', ')}` } };
    return { status: 200, body: { success: true, email: ACCOUNTS[key], password: seedPassword(env) } };
}

function handler(req, res) {
    const r = respond(req, process.env);
    res.set('Cache-Control', 'no-store');
    res.status(r.status).json(r.body);
}

module.exports = { ACCOUNTS, enabled, isLocalRequest, respond, handler };
