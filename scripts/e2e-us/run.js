/**
 * US end-to-end run: one brand-new US company taken through every module, through the app's real routes.
 *
 *   node scripts/e2e-us/run.js                 a new company, every stage in order
 *   node scripts/e2e-us/run.js --reuse         the company of the last run (for working on one stage)
 *   node scripts/e2e-us/run.js --reuse --only=04,05
 *   node scripts/e2e-us/run.js --state=mine --only=01      keep this company under its own name (.state/mine.json), then
 *   node scripts/e2e-us/run.js --state=mine --reuse --only=05   work on one stage against it without touching other runs
 *   node scripts/e2e-us/run.js --from=03       a new company, stages 01, then 03 onward... (01 always runs for a new company)
 *
 * Needs the local app on http://localhost:3000, the Firebase emulators, and for payroll the mock provider
 * (node scripts/mock-gusto.js). Local only: it refuses to run against anything that is not this machine.
 * Results: the console, and scripts/e2e-us/.state/<state>-report.json and <state>-report.md (state is "last" unless --state is given).
 */
const fs = require('fs');
const path = require('path');
const { APP, STATE_DIR, call, createContext } = require('./lib');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : null; };

function loadStages() {
    const dir = path.join(__dirname, 'stages');
    return fs.readdirSync(dir).filter((f) => /^\d\d-.*\.js$/.test(f)).sort().map((f) => ({ file: f, ...require(path.join(dir, f)) }));
}

(async () => {
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(APP)) { console.error(`Refusing to run against ${APP}: this run is for the local app only.`); process.exit(2); }
    const health = await call('GET', '/api/health').catch(() => null);
    if (!health || health.s !== 200) { console.error(`The app does not answer on ${APP}. Start it first (docs/LOCAL_TESTING.md).`); process.exit(2); }

    const stateName = (opt('state') || 'last').replace(/[^a-z0-9_-]/gi, '');
    const lastFile = path.join(STATE_DIR, `${stateName}.json`);
    let state;
    if (flag('reuse')) {
        if (!fs.existsSync(lastFile)) { console.error('No earlier run to reuse. Run once without --reuse.'); process.exit(2); }
        state = JSON.parse(fs.readFileSync(lastFile, 'utf8'));
    } else {
        const run = String(Date.now()).slice(-8);
        state = { run, startedAt: new Date().toISOString(), people: {}, ids: {} };
    }
    const ctx = createContext(state, lastFile);

    const only = opt('only') ? opt('only').split(',') : null;
    const from = opt('from');
    let stages = loadStages();
    if (only) stages = stages.filter((s) => only.includes(s.id));
    else if (from) stages = stages.filter((s) => s.id === '01' || s.id >= from);
    if (flag('reuse') && !only) stages = stages.filter((s) => s.id !== '01'); // the company already exists

    console.log(`US end-to-end run ${state.run} against ${APP}${flag('reuse') ? ' (reusing the last company)' : ''}`);
    for (const stage of stages) {
        const rec = ctx._begin(stage);
        console.log(`\n===== ${stage.id} ${stage.title}`);
        const t0 = Date.now();
        try { await stage.run(ctx); } catch (e) {
            rec.error = String(e.stack || e.message).slice(0, 900);
            console.log(`  FAIL  the stage stopped: ${rec.error}`);
        }
        rec.ms = Date.now() - t0;
        ctx.save();
        if (stage.id === '01' && (rec.error || rec.checks.some((c) => !c.pass && c.name.startsWith('[needed]')))) { console.log('\nThe company could not be set up, so the later stages were not run.'); break; }
    }

    // ---- report
    const rows = ctx._results.map((r) => ({ id: r.id, title: r.title, covers: r.covers, passed: r.checks.filter((c) => c.pass).length, failed: r.checks.filter((c) => !c.pass).length + (r.error ? 1 : 0), skipped: r.skipped.length, seconds: Math.round(r.ms / 100) / 10 }));
    const total = rows.reduce((t, r) => ({ passed: t.passed + r.passed, failed: t.failed + r.failed, skipped: t.skipped + r.skipped }), { passed: 0, failed: 0, skipped: 0 });
    console.log('\n===== Result');
    for (const r of rows) console.log(`  ${r.id} ${r.title.padEnd(44)} ${String(r.passed).padStart(4)} ok ${String(r.failed).padStart(3)} failed ${String(r.skipped).padStart(3)} skipped  ${r.seconds}s`);
    console.log(`  ${'Total'.padEnd(47)} ${String(total.passed).padStart(4)} ok ${String(total.failed).padStart(3)} failed ${String(total.skipped).padStart(3)} skipped`);
    if (state.company) console.log(`\n  Company: ${state.company.name} (${state.company.orgId}). Sign-ins are in scripts/e2e-us/.state/${stateName}.json`);

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, `${stateName}-report.json`), JSON.stringify({ run: state.run, at: new Date().toISOString(), total, stages: ctx._results }, null, 2));
    const md = [`# US end-to-end run ${state.run}`, '', `${new Date().toISOString()} against ${APP}`, '', '| Stage | Functions | Passed | Failed | Skipped |', '|---|---|---|---|---|',
        ...rows.map((r) => `| ${r.id} ${r.title} | ${r.covers.join(', ')} | ${r.passed} | ${r.failed} | ${r.skipped} |`), `| **Total** | | **${total.passed}** | **${total.failed}** | **${total.skipped}** |`, '',
        '## Failed', '', ...ctx._results.flatMap((r) => [...(r.error ? [`- ${r.id}: the stage stopped: ${r.error.split('\n')[0]}`] : []), ...r.checks.filter((c) => !c.pass).map((c) => `- ${r.id}: ${c.name}: ${c.detail}`)]), '',
        '## Not proven here', '', ...ctx._results.flatMap((r) => r.skipped.map((s) => `- ${r.id}: ${s.name} (${s.why})`)), ''].join('\n');
    fs.writeFileSync(path.join(STATE_DIR, `${stateName}-report.md`), md);
    process.exit(total.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
