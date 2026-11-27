/**
 * Alerts for whoever runs the server: an email to ALERT_EMAIL_TO when something is wrong that nobody would
 * otherwise notice until a customer calls.
 *
 * What raises an alert:
 *   - health    the deep health check (database, sign-in service, document folder, disk, clock) fails twice in a row
 *   - http-5xx  ALERT_5XX_COUNT or more server errors (5xx answers) within five minutes, on this copy of the server
 *   - daily-run the once-a-day retention and backup run failed, threw, or has not run for more than a day
 *   - recovered a health alert that was sent clears again (one email, so the person knows it is over)
 *
 * Each kind of alert is sent at most once per ALERT_COOLDOWN_MINUTES (60). Every alert is also written to the
 * error log and kept in memory (the newest 50) for GET /api/platform/alerts. Without ALERT_EMAIL_TO, or with
 * ALERTS=off, nothing is emailed; alerts are still logged. A failed email never fails anything else.
 *
 * The checks run every ALERT_CHECK_MINUTES (5) on one copy of the server (services/job-lock.js). Server errors are
 * counted per copy. A crash of the server process itself cannot email (the process is gone): watch /api/health from
 * outside for that (docs/DEPLOY.md).
 */

const MINUTE = 60 * 1000;
const WINDOW_5XX_MS = 5 * MINUTE;
const KEEP = 50;

function settings(env = process.env) {
    const num = (v, d, min) => { const n = Number(v); return Number.isFinite(n) && n >= min ? Math.floor(n) : d; };
    const to = String(env.ALERT_EMAIL_TO || '').split(',').map((s) => s.trim()).filter((s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s));
    return {
        off: String(env.ALERTS || '').toLowerCase() === 'off',
        to,
        cooldownMs: num(env.ALERT_COOLDOWN_MINUTES, 60, 1) * MINUTE,
        count5xx: num(env.ALERT_5XX_COUNT, 20, 1),
        checkMs: num(env.ALERT_CHECK_MINUTES, 5, 1) * MINUTE,
        where: String(env.APP_URL || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '') || 'this server'
    };
}

/** The day (YYYY-MM-DD, UTC) before which a daily run counts as missed: two days back, so one late run is fine. */
function missedBefore(now) { return new Date(now.getTime() - 2 * 24 * 60 * MINUTE).toISOString().slice(0, 10); }

/**
 * deps: { now(), send({ to, subject, text }), log(level, message), deepHealth(), dailyStatus(), env }
 * All are given in tests; realDeps() gives the real ones.
 */
function create(deps) {
    const env = () => deps.env || process.env;
    const lastSent = new Map();     // kind -> ms when last emailed
    const recent = [];              // newest first
    const errors5xx = [];           // ms of each 5xx in the window
    let healthFails = 0;
    let healthAlerted = false;
    let dailyRaised = null;         // the daily-run problem already raised, so each is raised once

    async function raise(kind, subject, detail = '') {
        const s = settings(env());
        const at = deps.now();
        const item = { kind, subject, detail: String(detail).slice(0, 2000), at: at.toISOString(), emailed: false };
        recent.unshift(item); recent.length = Math.min(recent.length, KEEP);
        deps.log(kind === 'recovered' ? 'info' : 'error', `[Alert] ${kind}: ${subject}${detail ? ` - ${String(detail).slice(0, 300)}` : ''}`);
        if (s.off || !s.to.length) return item;
        const last = lastSent.get(kind);
        if (last && at.getTime() - last < s.cooldownMs) { item.held = true; return item; }
        lastSent.set(kind, at.getTime());
        try {
            await deps.send({ to: s.to.join(', '), subject: `[Onn HR alert] ${s.where}: ${subject}`, text: `${subject}\n\n${detail}\n\nTime: ${item.at}\nServer: ${s.where}\n\nThe same kind of alert is not emailed again for ${Math.round(s.cooldownMs / MINUTE)} minutes. Recent alerts: GET /api/platform/alerts (operator token).` });
            item.emailed = true;
        } catch (e) {
            deps.log('error', `[Alert] could not email the ${kind} alert: ${e.message}`);
        }
        return item;
    }

    /** Called for every 5xx answer (middleware/observability.js). Synchronous and cheap; the email goes out in the background. */
    function noteServerError(route = '') {
        const s = settings(env());
        const t = deps.now().getTime();
        errors5xx.push(t);
        while (errors5xx.length && errors5xx[0] < t - WINDOW_5XX_MS) errors5xx.shift();
        if (errors5xx.length >= s.count5xx) {
            const n = errors5xx.length;
            errors5xx.length = 0; // the next alert needs a fresh burst
            raise('http-5xx', `${n} server errors in five minutes`, `The latest was on ${route || 'an unnamed route'}. Details are in the error log (LOG_DIR/errors.jsonl).`).catch(() => {});
        }
    }

    async function checkHealth() {
        let h;
        try { h = await deps.deepHealth(); } catch (e) { h = { status: 'fail', checks: { health: { status: 'fail', error: e.message } } }; }
        if (h.status === 'fail') {
            healthFails += 1;
            if (healthFails >= 2 && !healthAlerted) {
                const failing = Object.entries(h.checks || {}).filter(([, c]) => c && c.status === 'fail').map(([k, c]) => `${k}: ${c.error || 'failed'}`);
                healthAlerted = true;
                await raise('health', `Health check failing: ${failing.map((f) => f.split(':')[0]).join(', ') || 'unknown'}`, failing.join('\n'));
            }
        } else {
            if (healthAlerted) await raise('recovered', 'Health check passing again', `After ${healthFails} failed checks.`);
            healthFails = 0; healthAlerted = false;
        }
        return h.status;
    }

    async function checkDailyRun() {
        let st;
        try { st = await deps.dailyStatus(); } catch (e) { return null; } // the health check covers an unreachable database
        if (!st || !st.on) return null;
        const now = deps.now();
        // A new server has no run yet, so only a run that is too old counts. Each problem is raised once per run day
        // (a failed run is not emailed again every hour until the next day's run).
        let problem = null;
        if (st.last && st.last.day < missedBefore(now)) problem = ['missed', 'The daily retention and backup run has not run for more than a day', `Last run: ${st.last.day} (${st.last.summary || ''}).`];
        else if (st.last && st.last.ok === false) problem = ['failed', 'The daily retention and backup run failed', `${st.last.day}: ${st.last.summary || ''}`];
        if (!problem) return 'ok';
        const key = `${problem[0]}:${st.last.day}:${problem[0] === 'missed' ? now.toISOString().slice(0, 10) : ''}`;
        if (dailyRaised !== key) { dailyRaised = key; await raise('daily-run', problem[1], problem[2]); }
        return problem[0];
    }

    /** One round of checks (every few minutes, on one copy of the server). */
    async function tick() {
        return { health: await checkHealth(), daily: await checkDailyRun() };
    }

    return { raise, noteServerError, tick, checkHealth, checkDailyRun, recent: () => recent.slice() };
}

/* --------------------------------- the real thing --------------------------------- */

function realDeps() {
    const logger = require('../utils/logger');
    return {
        now: () => new Date(),
        send: ({ to, subject, text }) => require('../utils/email').sendEmail({ to, subject, text, html: `<pre style="font-family:inherit;white-space:pre-wrap">${text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>` }),
        log: (level, message) => (logger[level] || logger.info).call(logger, message),
        deepHealth: () => require('../routes/ops').helpers.deepHealth(),
        dailyStatus: () => require('./daily-jobs').status()
    };
}

let shared = null;
/** The one alert keeper of this process. */
function instance() { if (!shared) shared = create(realDeps()); return shared; }

let timer = null;
function startJobs() {
    const s = settings();
    if (timer || s.off) return false;
    const jobLock = require('./job-lock');
    const tick = jobLock.guard('ops-alerts', s.checkMs, () => instance().tick());
    const run = () => Promise.resolve().then(tick).catch((e) => require('../utils/logger').error(`[Alert] check failed: ${e.message}`));
    setTimeout(run, MINUTE).unref();
    timer = setInterval(run, s.checkMs); timer.unref();
    return true;
}

module.exports = { create, settings, missedBefore, instance, startJobs, realDeps };
