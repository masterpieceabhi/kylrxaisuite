/**
 * Shared helpers for the US end-to-end run (scripts/e2e-us/run.js).
 *
 * The run talks to the local app only through its real routes, the way the pages do. It never writes to the
 * database directly. Each stage is a file in scripts/e2e-us/stages that exports { id, title, covers, run(ctx) }.
 *
 * ctx gives a stage:
 *   ctx.call(method, url, token, body, headers)  -> { s: status, b: parsed JSON or {}, text }
 *   ctx.as(key)                                  -> a sign-in token for a person of the run ('owner', 'hr', 'payroll',
 *                                                   'manager', 'cashier', ...; see state.people), signed in once and kept
 *   ctx.check(name, ok, detail)                  -> records one check; returns ok
 *   ctx.section(title), ctx.info(text)
 *   ctx.state                                    -> what earlier stages made (company, people, ids); saved after every stage
 *   ctx.U                                        -> '/api/us'
 *   ctx.today, ctx.addDays(iso, n), ctx.weekStart(iso)
 */
const fs = require('fs');
const path = require('path');

const APP = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
const STATE_DIR = path.join(__dirname, '.state');

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (day, n) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
/** Day of week 0 (Sunday) to 6 for a YYYY-MM-DD date */
const dayOfWeek = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

async function call(method, url, token, body, headers = {}) {
    const res = await fetch(APP + url, {
        method,
        headers: { ...(body === undefined || body === null ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined || body === null ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let b = {};
    try { b = JSON.parse(text); } catch (_) { /* not JSON (a CSV, a PDF, a page) */ }
    return { s: res.status, b, text, headers: res.headers };
}

/**
 * Signs in the way the pages do: with the Firebase sign-in (here the local Auth emulator), which gives the ID token
 * the pages send to every route. Accounts made by company signup and by "add employee" have no password for the
 * older POST /api/auth/login route, so that route is tried only when the Firebase sign-in is refused.
 */
const AUTH_EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
async function signIn(email, password) {
    const res = await fetch(`http://${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
    const j = await res.json().catch(() => ({}));
    if (j.idToken) return j.idToken;
    const a = await call('POST', '/api/auth/login', null, { email, password });
    if (a.b.accessToken) return a.b.accessToken;
    if (!a.b.mfaToken || !a.b.code) throw new Error(`sign-in for ${email} failed: Firebase said ${(j.error && j.error.message) || res.status}, the login route said ${a.s} ${a.text.slice(0, 120)}`);
    const v = await call('POST', '/api/auth/verify-mfa', null, { mfaToken: a.b.mfaToken, code: a.b.code });
    if (!v.b.accessToken) throw new Error(`one-time code for ${email} failed (${v.s}): ${v.text.slice(0, 200)}`);
    return v.b.accessToken;
}

function createContext(state, stateFile) {
    const tokens = {};
    const results = [];
    let current = null;
    const ctx = {
        APP, U: '/api/us', state, call, signIn, addDays, dayOfWeek,
        today: iso(new Date()),
        save() { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); },
        /** A token for one of the run's people; signs in on first use, and again when asked to renew */
        async as(key, { renew = false } = {}) {
            const p = state.people && state.people[key];
            if (!p) throw new Error(`the run has no person called "${key}" (have: ${Object.keys(state.people || {}).join(', ')})`);
            if (!tokens[key] || renew) tokens[key] = await signIn(p.email, p.password);
            return tokens[key];
        },
        forget(key) { delete tokens[key]; },
        section(title) { console.log(`\n  -- ${title}`); },
        info(text) { console.log(`        ${text}`); },
        check(name, ok, detail) {
            const pass = Boolean(ok);
            current.checks.push({ name, pass, detail: pass ? undefined : (typeof detail === 'string' ? detail : JSON.stringify(detail === undefined ? null : detail)).slice(0, 700) });
            if (pass) console.log(`  ok    ${name}`);
            else console.log(`  FAIL  ${name}\n        ${current.checks[current.checks.length - 1].detail}`);
            return pass;
        },
        /** Something the run cannot prove here (needs an outside account, a camera, an email inbox). Listed in the report, not a failure. */
        skip(name, why) { current.skipped.push({ name, why }); console.log(`  skip  ${name} (${why})`); },
        _begin(stage) { current = { id: stage.id, title: stage.title, covers: stage.covers || [], checks: [], skipped: [], error: null }; results.push(current); return current; },
        _results: results
    };
    return ctx;
}

module.exports = { APP, STATE_DIR, call, signIn, createContext, iso, addDays, dayOfWeek };
