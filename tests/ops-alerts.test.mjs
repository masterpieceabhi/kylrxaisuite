// Alerts for whoever runs the server (services/ops-alerts.js): health, bursts of server errors, the daily run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../services/ops-alerts.js');

function world({ env = { ALERT_EMAIL_TO: 'ops@example.com', APP_URL: 'https://app.example.com' }, health = 'ok', daily = null, sendFails = false } = {}) {
    let clock = new Date('2026-11-20T12:00:00Z');
    const sent = []; const logs = [];
    const state = { health, daily };
    const alerts = A.create({
        env,
        now: () => clock,
        send: async (m) => { if (sendFails) throw new Error('mail server down'); sent.push(m); },
        log: (level, message) => logs.push([level, message]),
        deepHealth: async () => {
            if (state.health === 'throw') throw new Error('database unreachable');
            return { status: state.health, checks: state.health === 'fail' ? { firestore: { status: 'fail', error: 'Firestore read timed out after 4000 ms' }, vault: { status: 'ok' } } : { firestore: { status: 'ok' } } };
        },
        dailyStatus: async () => state.daily
    });
    return { alerts, sent, logs, state, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}
const MIN = 60 * 1000;

test('settings: defaults, a list of addresses, and bad values ignored', () => {
    const s = A.settings({});
    assert.equal(s.off, false); assert.deepEqual(s.to, []); assert.equal(s.cooldownMs, 60 * MIN); assert.equal(s.count5xx, 20); assert.equal(s.checkMs, 5 * MIN);
    const t = A.settings({ ALERT_EMAIL_TO: 'a@x.com, not-an-address ,b@y.org', ALERT_COOLDOWN_MINUTES: '0', ALERT_5XX_COUNT: 'many', ALERTS: 'OFF', APP_URL: 'https://app.onnhr.com/x' });
    assert.deepEqual(t.to, ['a@x.com', 'b@y.org']);
    assert.equal(t.cooldownMs, 60 * MIN, 'zero is not a cooldown');
    assert.equal(t.count5xx, 20);
    assert.equal(t.off, true);
    assert.equal(t.where, 'app.onnhr.com');
});

test('health: one failed check is not an alert, two in a row are, and passing again sends one "recovered"', async () => {
    const w = world({ health: 'fail' });
    await w.alerts.tick();
    assert.equal(w.sent.length, 0, 'a single blip is not emailed');
    await w.alerts.tick();
    assert.equal(w.sent.length, 1);
    assert.match(w.sent[0].subject, /^\[Onn HR alert\] app\.example\.com: Health check failing: firestore$/);
    assert.match(w.sent[0].text, /Firestore read timed out/);
    assert.equal(w.sent[0].to, 'ops@example.com');
    await w.alerts.tick(); await w.alerts.tick();
    assert.equal(w.sent.length, 1, 'still failing: not emailed again');
    w.state.health = 'ok';
    await w.alerts.tick();
    assert.equal(w.sent.length, 2);
    assert.match(w.sent[1].subject, /Health check passing again/);
    await w.alerts.tick();
    assert.equal(w.sent.length, 2);
});

test('health: a check that throws counts as failing', async () => {
    const w = world({ health: 'throw' });
    await w.alerts.tick(); await w.alerts.tick();
    assert.equal(w.sent.length, 1);
    assert.match(w.sent[0].text, /database unreachable/);
});

test('server errors: a burst within five minutes is one email; scattered errors are none', async () => {
    const w = world({ env: { ALERT_EMAIL_TO: 'ops@example.com', ALERT_5XX_COUNT: '5' } });
    for (let i = 0; i < 4; i += 1) { w.alerts.noteServerError('/api/x'); w.advance(2 * MIN); }
    await new Promise((r) => setImmediate(r));
    assert.equal(w.sent.length, 0, 'four errors spread over eight minutes never reach five in a window');
    for (let i = 0; i < 5; i += 1) w.alerts.noteServerError('/api/us/people');
    await new Promise((r) => setImmediate(r));
    assert.equal(w.sent.length, 1);
    assert.match(w.sent[0].subject, /server errors in five minutes/);
    assert.match(w.sent[0].text, /\/api\/us\/people/);
    for (let i = 0; i < 5; i += 1) w.alerts.noteServerError('/api/us/people');
    await new Promise((r) => setImmediate(r));
    assert.equal(w.sent.length, 1, 'a second burst inside the cooldown is held');
    assert.equal(w.alerts.recent()[0].held, true);
    w.advance(61 * MIN);
    for (let i = 0; i < 5; i += 1) w.alerts.noteServerError('/api/us/people');
    await new Promise((r) => setImmediate(r));
    assert.equal(w.sent.length, 2, 'after the cooldown it is emailed again');
});

test('daily run: a failed run is raised once for that day; an old last run is "missed"; none yet is fine', async () => {
    const w = world({ daily: { on: true, last: { day: '2026-11-20', ok: false, summary: 'backup: disk full' } } });
    assert.equal(await w.alerts.checkDailyRun(), 'failed');
    assert.equal(w.sent.length, 1);
    assert.match(w.sent[0].text, /disk full/);
    w.advance(3 * 60 * MIN);
    assert.equal(await w.alerts.checkDailyRun(), 'failed');
    assert.equal(w.sent.length, 1, 'the same failed day is not emailed every hour');

    w.state.daily = { on: true, last: { day: '2026-11-17', ok: true, summary: 'ok' } };
    assert.equal(await w.alerts.checkDailyRun(), 'missed');
    assert.equal(w.sent.length, 2);
    assert.match(w.sent[1].subject, /has not run for more than a day/);

    w.state.daily = { on: true, last: { day: '2026-11-19', ok: true, summary: 'ok' } };
    assert.equal(await w.alerts.checkDailyRun(), 'ok', 'yesterday\'s run is fine at noon');
    w.state.daily = { on: true, last: null, runs: [] };
    assert.equal(await w.alerts.checkDailyRun(), 'ok', 'a new server has no run yet');
    w.state.daily = { on: false, last: { day: '2026-01-01', ok: false } };
    assert.equal(await w.alerts.checkDailyRun(), null, 'switched off: nothing to check');
});

test('without ALERT_EMAIL_TO, or with ALERTS=off, alerts are logged and kept but never emailed', async () => {
    for (const env of [{}, { ALERT_EMAIL_TO: 'ops@example.com', ALERTS: 'off' }]) {
        const w = world({ env, health: 'fail' });
        await w.alerts.tick(); await w.alerts.tick();
        assert.equal(w.sent.length, 0);
        assert.equal(w.alerts.recent()[0].kind, 'health');
        assert.equal(w.alerts.recent()[0].emailed, false);
        assert.ok(w.logs.some(([level, m]) => level === 'error' && /\[Alert\] health/.test(m)));
    }
});

test('a failed email is logged and never throws', async () => {
    const w = world({ health: 'fail', sendFails: true });
    await w.alerts.tick();
    await assert.doesNotReject(() => w.alerts.tick());
    assert.ok(w.logs.some(([, m]) => /could not email the health alert: mail server down/.test(m)));
    assert.equal(w.alerts.recent()[0].emailed, false);
});

test('only the newest 50 alerts are kept', async () => {
    const w = world({ env: {} });
    for (let i = 0; i < 60; i += 1) await w.alerts.raise(`k${i}`, `alert ${i}`);
    const r = w.alerts.recent();
    assert.equal(r.length, 50);
    assert.equal(r[0].subject, 'alert 59');
});
