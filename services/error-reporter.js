/**
 * Pluggable error reporter (Sentry-style). Default reporter writes one JSON line to stderr and appends to
 * LOG_DIR/errors.jsonl (default ./logs). If SENTRY_DSN is set and the optional `@sentry/node` package is
 * installed it forwards there too. Replace it any time: setReporter((evt) => ...).
 *   captureException(err, { requestId, userId, orgId })   captureMessage('text', 'warning', ctx)
 * Never include secrets in ctx. Stacks are kept, request bodies never are.
 */
const fs = require('fs');
const path = require('path');
const metrics = require('./metrics');

let reporter = null;
let sentry = null;
let sentryTried = false;

/**
 * Blanks anything in an error text that looks like a Social Security number, a long account number or an email
 * address, so such details never leave the server in an error report, even if one ends up in a message by mistake.
 */
function scrub(text) {
    return String(text == null ? '' : text)
        .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[hidden]')
        .replace(/\b\d{9,17}\b/g, '[hidden]')
        .replace(/[^\s@<>"']+@[^\s@<>"']+\.[a-z]{2,}/gi, '[email]');
}

function loadSentry() {
    if (sentryTried) return sentry;
    sentryTried = true;
    if (!process.env.SENTRY_DSN) return null;
    try {
        sentry = require('@sentry/node');
        sentry.init({
            dsn: process.env.SENTRY_DSN, environment: process.env.NODE_ENV, release: process.env.BUILD_ID || undefined,
            sendDefaultPii: false, // no request contents, cookies, IP addresses or user details
            beforeSend(event) {
                try {
                    if (event.message) event.message = scrub(event.message);
                    for (const ex of (event.exception && event.exception.values) || []) if (ex.value) ex.value = scrub(ex.value);
                    delete event.request; delete event.user;
                } catch (_) { /* never fail a report */ }
                return event;
            }
        });
    } catch (_) { sentry = null; }
    return sentry;
}

function defaultReporter(evt) {
    const line = JSON.stringify(evt);
    try { process.stderr.write(line + '\n'); } catch (_) {}
    try {
        const dir = path.resolve(process.env.LOG_DIR || path.join(__dirname, '..', 'logs'));
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(path.join(dir, 'errors.jsonl'), line + '\n');
    } catch (_) {}
    const s = loadSentry();
    if (s) { try { if (evt.error) s.captureException(Object.assign(new Error(scrub(evt.error.message)), { stack: scrub(evt.error.stack), name: evt.error.name })); else s.captureMessage(scrub(evt.message), evt.level); } catch (_) {} }
}

function setReporter(fn) { reporter = typeof fn === 'function' ? fn : null; }

function emit(evt) {
    metrics.counter('kylrx_errors_reported_total', 'Errors and messages sent to the error reporter', { level: evt.level });
    try { (reporter || defaultReporter)(evt); } catch (_) {}
}

function captureException(err, ctx = {}) {
    const e = err instanceof Error ? err : new Error(String(err));
    emit({ ts: new Date().toISOString(), level: 'error', error: { name: e.name, message: e.message, stack: e.stack }, ctx });
}

function captureMessage(message, level = 'info', ctx = {}) {
    emit({ ts: new Date().toISOString(), level, message: String(message), ctx });
}

let installed = false;
/** Adds listeners for crashes; they only report, the existing process handlers decide whether to exit. */
function installProcessHooks() {
    if (installed) return; installed = true;
    process.on('uncaughtException', (err) => captureException(err, { source: 'uncaughtException' }));
    process.on('unhandledRejection', (reason) => captureException(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' }));
}

module.exports = { scrub, captureException, captureMessage, setReporter, installProcessHooks };
