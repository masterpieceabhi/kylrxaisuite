/**
 * Tiny Prometheus-style metrics registry (no dependencies).
 *   const m = require('./metrics');
 *   m.counter('kylrx_things_total', 'Things done', { kind: 'x' });            // increments by 1
 *   m.observe('kylrx_job_seconds', 'Job time', { job: 'a' }, 0.42);           // histogram
 *   m.registerGauge('kylrx_queue_depth', 'Jobs waiting', () => queue.length); // sampled at scrape time
 *   m.registerGauge('kylrx_x', 'help', async () => [{ labels: { org: 'a' }, value: 3 }]);  // labelled gauge
 * render() returns the text exposition format served at /api/metrics.
 */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const counters = new Map(); // name -> { help, series: Map(labelKey -> { labels, value }) }
const histos = new Map();   // name -> { help, series: Map(labelKey -> { labels, counts[], sum, count }) }
const gauges = new Map();   // name -> { help, fn }

const keyOf = (labels) => Object.keys(labels || {}).sort().map((k) => `${k}=${labels[k]}`).join('|');
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmtLabels = (labels, extra) => {
    const all = { ...(labels || {}), ...(extra || {}) };
    const parts = Object.keys(all).map((k) => `${k}="${esc(all[k])}"`);
    return parts.length ? `{${parts.join(',')}}` : '';
};
const validName = (n) => /^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(n);

function counter(name, help, labels = {}, by = 1) {
    if (!validName(name)) throw new Error(`Bad metric name ${name}`);
    if (!counters.has(name)) counters.set(name, { help, series: new Map() });
    const c = counters.get(name); const k = keyOf(labels);
    if (!c.series.has(k)) c.series.set(k, { labels, value: 0 });
    c.series.get(k).value += by;
}

function observe(name, help, labels = {}, value) {
    if (!validName(name)) throw new Error(`Bad metric name ${name}`);
    if (!histos.has(name)) histos.set(name, { help, series: new Map() });
    const h = histos.get(name); const k = keyOf(labels);
    if (!h.series.has(k)) h.series.set(k, { labels, counts: BUCKETS.map(() => 0), sum: 0, count: 0 });
    const s = h.series.get(k);
    BUCKETS.forEach((b, i) => { if (value <= b) s.counts[i] += 1; });
    s.sum += value; s.count += 1;
}

function registerGauge(name, help, fn) {
    if (!validName(name)) throw new Error(`Bad metric name ${name}`);
    gauges.set(name, { help, fn });
}

async function render() {
    const out = [];
    for (const [name, c] of counters) {
        out.push(`# HELP ${name} ${c.help}`, `# TYPE ${name} counter`);
        for (const s of c.series.values()) out.push(`${name}${fmtLabels(s.labels)} ${s.value}`);
    }
    for (const [name, h] of histos) {
        out.push(`# HELP ${name} ${h.help}`, `# TYPE ${name} histogram`);
        for (const s of h.series.values()) {
            BUCKETS.forEach((b, i) => out.push(`${name}_bucket${fmtLabels(s.labels, { le: b })} ${s.counts[i]}`));
            out.push(`${name}_bucket${fmtLabels(s.labels, { le: '+Inf' })} ${s.count}`, `${name}_sum${fmtLabels(s.labels)} ${s.sum}`, `${name}_count${fmtLabels(s.labels)} ${s.count}`);
        }
    }
    for (const [name, g] of gauges) {
        out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
        try {
            const v = await g.fn();
            const list = Array.isArray(v) ? v : [{ labels: {}, value: v }];
            for (const item of list) if (Number.isFinite(Number(item.value))) out.push(`${name}${fmtLabels(item.labels)} ${Number(item.value)}`);
        } catch (e) { out.push(`# gauge ${name} failed: ${esc(e.message)}`); }
    }
    return out.join('\n') + '\n';
}

function reset() { counters.clear(); histos.clear(); gauges.clear(); installProcessGauges(); }

function installProcessGauges() {
    registerGauge('process_uptime_seconds', 'Process uptime', () => process.uptime());
    registerGauge('process_resident_memory_bytes', 'Resident memory', () => process.memoryUsage().rss);
    registerGauge('nodejs_heap_used_bytes', 'V8 heap used', () => process.memoryUsage().heapUsed);
    registerGauge('nodejs_active_handles', 'Active handles', () => (process._getActiveHandles ? process._getActiveHandles().length : 0));
}
installProcessGauges();

module.exports = { counter, observe, registerGauge, render, reset, BUCKETS };
