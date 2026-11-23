/**
 * Stage 10: a real (headless) browser signs in as each role on the login page and opens every US page that role is
 * meant to use. A page passes when it loads with no script error, no failed call to the server and no error banner.
 * This does not click the buttons on the pages; the route stages before it cover what the buttons do.
 *
 * Needs Chrome or Edge on this PC (or CHROME_PATH). Without a browser the stage is listed as not proven.
 */
const fs = require('fs');

const BROWSERS = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);

const EMPLOYEE_PAGES = ['us-home.html', 'punch.html', 'timesheet.html', 'leave.html', 'my-profile.html', 'my-schedule.html', 'my-pay.html', 'my-benefits.html', 'my-documents.html', 'my-policies.html', 'my-goals.html', 'my-reviews.html', 'my-surveys.html', 'my-news.html', 'my-assets.html', 'my-training.html', 'my-privacy.html'];
const ADMIN_PAGES = fs.readdirSync(require('path').join(__dirname, '..', '..', '..')).filter((f) => /^admin-us-.*\.html$/.test(f)).sort();

/** Who opens what. "menu" means: also every page linked from that role's own home page (us-home.html builds it from permissions). */
const WALKS = [
    { key: 'owner', lands: /admin-dashboard\.html|us-home\.html/, pages: ['us-home.html', ...ADMIN_PAGES], menu: true },
    { key: 'hr', lands: /us-home\.html|admin-/, pages: ['us-home.html'], menu: true },
    { key: 'payroll', lands: /us-home\.html/, pages: ['us-home.html'], menu: true },
    { key: 'manager', lands: /us-home\.html|admin-/, pages: ['us-home.html'], menu: true },
    { key: 'accountant', lands: /us-home\.html/, pages: ['us-home.html'], menu: true },
    { key: 'auditor', lands: /us-home\.html/, pages: ['us-home.html'], menu: true },
    { key: 'executive', lands: /us-home\.html/, pages: ['us-home.html'], menu: true },
    { key: 'cashier', lands: /punch\.html|us-home\.html/, pages: EMPLOYEE_PAGES, menu: true }
];

/**
 * Refusals a page asks for on purpose, so they are not faults:
 *  - the owner page asks whether the person is platform support staff (a 403 means "no" and hides the link)
 *  - the compliance calendar reads each source on its own and leaves out the ones this role may not see
 */
const EXPECTED_REFUSALS = [
    { page: /./, call: /^403 GET \/api\/support\/grants/ },
    { page: /^admin-us-calendar\.html/, call: /^403 GET \/api\/us\// },
    // the owner page opens for anyone who may read the activity log; it asks for roles and billing and hides those tabs on a 403
    { page: /^admin-us-owner\.html/, call: /^403 GET \/api\/us\/(roles|roles\/users|billing)(\?|$)/ }
];

/** Console lines that say nothing about the page itself */
const NOISE = [/favicon/i, /Failed to load resource/i, /ERR_BLOCKED_BY_CLIENT/i, /Download the React DevTools/i, /tailwindcss/i, /third-party cookie/i];

async function openPage(page, url) {
    const seen = { errors: [], api: [] };
    const onConsole = (m) => { if (m.type() === 'error' && !NOISE.some((n) => n.test(m.text()))) seen.errors.push(`console: ${m.text().slice(0, 200)}`); };
    const onError = (e) => seen.errors.push(`script error: ${String(e.message || e).slice(0, 200)}`);
    const here = url.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0];
    // only answers to requests this page made: a slow answer to the page opened before must not be counted here
    const fromHere = (r) => { const ref = (r.request().headers().referer || '').replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0]; return !ref || ref === here; };
    const onResponse = (r) => { const u = r.url(); if (/\/(api|scim|oauth)\//.test(u) && r.status() >= 400 && fromHere(r)) seen.api.push(`${r.status()} ${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/, '').slice(0, 110)}`); };
    page.on('console', onConsole); page.on('pageerror', onError); page.on('response', onResponse);
    let finalUrl = url; let banner = '';
    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
        await new Promise((r) => setTimeout(r, 700)); // pages load their data after sign-in is restored
        finalUrl = page.url();
        banner = await page.evaluate(() => { const m = document.querySelector('#msg.err, .msg.err, .error-banner:not([hidden])'); return m && m.offsetParent !== null ? (m.textContent || '').trim().slice(0, 200) : ''; });
    } catch (e) { seen.errors.push(`did not load: ${String(e.message).slice(0, 160)}`); }
    page.off('console', onConsole); page.off('pageerror', onError); page.off('response', onResponse);
    return { ...seen, finalUrl, banner };
}

module.exports = {
    id: '10',
    title: 'Every page, opened as each role',
    covers: ['US-A04', 'US-A05', 'US-A07'],
    async run(ctx) {
        const { check, state } = ctx;
        const exe = BROWSERS.find((f) => fs.existsSync(f));
        if (!exe) { ctx.skip('opening the pages in a browser', 'no Chrome or Edge found on this PC; set CHROME_PATH'); return; }
        const puppeteer = require('puppeteer');
        const browser = await puppeteer.launch({ headless: true, executablePath: exe, args: ['--no-first-run', '--disable-extensions'] });
        const opened = {};
        try {
            // the roles are walked side by side (each in its own private window); results are listed role by role afterwards
            const walkRole = async (walk) => {
                const out = [];
                const note = (name, ok, detail) => { out.push({ name, ok: Boolean(ok), detail }); return Boolean(ok); };
                const person = state.people[walk.key];
                if (!person) return { walk, person: null, out };
                const context = await browser.createBrowserContext();
                const page = await context.newPage();
                await page.setViewport(person.role === 'employee' ? { width: 375, height: 812 } : { width: 1366, height: 900 });
                try {
                    // ---- sign in on the real login page
                    await page.goto(`${ctx.APP}/login.html`, { waitUntil: 'domcontentloaded', timeout: 45000 });
                    await page.waitForSelector('#email', { timeout: 20000 });
                    await page.type('#email', person.email);
                    // the box is a PIN box (maxlength 6): typing a password would be cut short, so the value is set directly;
                    // on a local demo server the page still accepts a password there
                    await page.$eval('#password', (el, v) => { el.value = v; }, person.password);
                    await page.click('#loginBtn');
                    await page.waitForFunction(() => !/login\.html/.test(location.pathname), { timeout: 30000 }).catch(() => null);
                    const landed = page.url().replace(/^https?:\/\/[^/]+\//, '').split('?')[0];
                    if (!note(`${person.role} signs in on the login page and lands on a US page (${landed})`, walk.lands.test(landed), `landed on ${landed}`)) {
                        if (/login\.html/.test(landed)) return { walk, person, out }; // could not sign in at all: nothing else to open
                    }
                    // ---- the pages: the fixed list, plus what this person's own menu links to
                    const pages = [...walk.pages];
                    if (walk.menu) {
                        await page.goto(`${ctx.APP}/us-home.html`, { waitUntil: 'networkidle2', timeout: 45000 }).catch(() => null);
                        // the menu is built after the page has asked the server what this person may do
                        await page.waitForFunction(() => { const r = document.querySelector('#role'); const m = document.querySelector('#msg'); return (r && r.textContent.trim()) || (m && m.textContent.trim()); }, { timeout: 20000 }).catch(() => null);
                        await new Promise((r) => setTimeout(r, 300));
                        const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')).filter((h) => /^[\w-]+\.html/.test(h)));
                        for (const l of links) { const name = l.split(/[?#]/)[0]; if (!pages.includes(name) && !/^(login|index|signup)\.html$/.test(name)) pages.push(name); }
                        note(`${person.role}'s home page offers a menu (${links.length} links)`, links.length > 0, 'no links on us-home.html');
                    }
                    opened[walk.key] = pages.length;
                    for (const name of pages) {
                        const r = await openPage(page, `${ctx.APP}/${name}`);
                        const bouncedToLogin = /login\.html/.test(r.finalUrl);
                        const refused = r.api.filter((a) => /^(401|403|5\d\d) /.test(a) && !EXPECTED_REFUSALS.some((x) => x.page.test(name) && x.call.test(a)));
                        const problems = [...r.errors, ...refused, ...(bouncedToLogin ? ['sent back to the login page'] : []), ...(r.banner ? [`error shown on the page: ${r.banner}`] : [])];
                        note(`${walk.key} opens ${name}`, problems.length === 0, problems.concat(r.api.filter((a) => !refused.includes(a)).map((a) => `(also) ${a}`)).join(' | '));
                    }
                } catch (e) { note(`${walk.key}: the walk finished`, false, String(e.message).slice(0, 300)); } finally { await context.close().catch(() => null); }
                return { walk, person, out };
            };
            for (const done of await Promise.all(WALKS.map(walkRole))) {
                if (!done.person) { ctx.skip(`pages as ${done.walk.key}`, 'the run has no such person'); continue; }
                ctx.section(`${done.person.name} (${done.person.role})`);
                for (const c of done.out) check(c.name, c.ok, c.detail);
            }
            // ---- pages nobody signs in for
            ctx.section('Public pages');
            const context = await browser.createBrowserContext();
            const page = await context.newPage();
            for (const name of ['status.html', `careers.html?org=${encodeURIComponent(state.company.orgId)}`, 'login.html', 'signup.html']) {
                const r = await openPage(page, `${ctx.APP}/${name}`);
                const problems = [...r.errors, ...r.api.filter((a) => /^5\d\d /.test(a))];
                check(`anyone opens ${name.split('?')[0]}`, problems.length === 0, problems.join(' | '));
            }
            await context.close();
            ctx.info(`pages opened per role: ${JSON.stringify(opened)}`);
            ctx.skip('clicking every button on every page', 'this stage opens pages; what the buttons do is covered by the route stages');
            ctx.skip('camera capture on the clock page', 'a headless browser has no camera');
        } finally { await browser.close(); }
    }
};
