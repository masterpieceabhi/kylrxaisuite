/**
 * Stage 09: the owner's side of the product. API keys and the public API, the OpenAPI document, signed webhooks
 * (received by a small HTTP server this stage starts on 127.0.0.1 and stops at the end), an OAuth app with consent,
 * SCIM, a file-export connection, integration alerts, the API activity log, the audit log, roles and permissions,
 * billing in practice mode, the status page and support access.
 *
 * Everything this stage changes is its own: keys, apps, tokens, endpoints, a connection and a few throwaway people.
 * It can be run again on the same company (--reuse): names carry a time stamp and the subscription is cancelled at the end.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const I = '/api/us/integrations';
const V1 = '/api/v1';
const SCIM = '/scim/v2';
const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tiny receiver for webhooks and OAuth redirects. Keeps every request it gets. */
function startReceiver() {
    const got = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            got.push({ at: Date.now(), method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
            res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ got, port: server.address().port, stop: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }) }));
    });
}

/** The signature the app documents: X-Kylrx-Signature: t=<unix seconds>,v1=<hex of HMAC-SHA256(secret, "<t>.<body>")> */
function signatureIsGood(header, body, secret) {
    const parts = String(header || '').split(',').map((p) => p.trim());
    const t = (parts.find((p) => p.startsWith('t=')) || '').slice(2);
    const sigs = parts.filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
    if (!t || !sigs.length) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    return sigs.includes(expected) && Math.abs(Date.now() / 1000 - Number(t)) < 600;
}

module.exports = {
    id: '09',
    title: 'API, connectors, audit and billing',
    covers: ['US-K01', 'US-K02', 'US-K03', 'US-K04', 'US-K05', 'US-K06', 'US-K07', 'US-K10', 'US-K11', 'US-K12', 'US-K13', 'US-K14', 'US-A07', 'US-A10', 'US-L05', 'US-L07', 'US-L08'],
    async run(ctx) {
        const { call, check, U, state } = ctx;
        const run = state.run;
        const stamp = String(Date.now()).slice(-6);
        const ids = state.ids.integrations = state.ids.integrations || {};
        const domain = state.company.domain;
        const owner = await ctx.as('owner');
        const hr = await ctx.as('hr');
        const cashier = await ctx.as('cashier');
        const auditor = await ctx.as('auditor');
        const payroll = await ctx.as('payroll');
        const receiver = await startReceiver();
        const hookUrl = `http://127.0.0.1:${receiver.port}/hooks/kylrx`;
        const waitFor = async (test, ms = 25000) => { const end = Date.now() + ms; for (;;) { const hit = receiver.got.find(test); if (hit || Date.now() > end) return hit || null; await sleep(400); } };

        try {
            // ------------------------------------------------------------------------------------------- who may
            ctx.section('Who may open the integrations screen');
            const meta = await call('GET', `${I}/meta`, owner);
            const scopes = Object.keys(meta.b.scopes || {});
            check('the owner sees the list of API scopes and event types', meta.s === 200 && scopes.includes('people:read') && scopes.includes('documents:read') && JSON.stringify(meta.b.events || '').includes('person.updated'), meta.text.slice(0, 300));
            check('HR can look at the integrations screen but cannot create an API key (403)', (await call('GET', `${I}/keys`, hr)).s === 200 && (await call('POST', `${I}/keys`, hr, { name: 'hr key', scopes: ['people:read'] })).s === 403);
            check('an employee cannot open it (403)', (await call('GET', `${I}/keys`, cashier)).s === 403);
            check('no token is refused (401)', (await call('GET', `${I}/keys`, null)).s === 401);

            // ------------------------------------------------------------------------------------------ API keys
            ctx.section('API key and the public API');
            const badKey = await call('POST', `${I}/keys`, owner, { name: '', scopes: ['people:read'] });
            const badScope = await call('POST', `${I}/keys`, owner, { name: 'x', scopes: ['everything:all'] });
            check('a key without a name, or with an unknown scope, is refused (400)', badKey.s === 400 && badScope.s === 400, { badKey: badKey.b, badScope: badScope.b });
            const readScopes = ['people:read', 'people:write', 'time:read', 'time:write', 'leave:read', 'org:read', 'documents:read', 'webhooks:manage'];
            const keyName = `E2E reporting tool ${run}-${stamp}`;
            const made = await call('POST', `${I}/keys`, owner, { name: keyName, scopes: readScopes });
            const key = made.b.key;
            if (!check('[needed] the owner creates an API key; the key is shown once', made.s === 201 && typeof key === 'string' && key.length > 20 && made.b.record && made.b.record.id && /no-store/.test(made.headers.get('cache-control') || ''), { s: made.s, record: made.b.record, errors: made.b.errors })) return;
            ids.keyId = made.b.record.id;
            const listed = await call('GET', `${I}/keys`, owner);
            check('the key list shows it without the key itself', listed.s === 200 && (listed.b.data || []).some((k) => k.id === ids.keyId && k.name === keyName) && !listed.text.includes(key), listed.text.slice(0, 300));

            const me = await call('GET', `${V1}/me`, key);
            check('the key works on the public API and belongs to this company', me.s === 200 && me.b.data && me.b.data.org_id === state.company.orgId && me.b.data.principal.name === keyName, me.b);
            check('every answer carries a request id and rate-limit numbers', Boolean(me.headers.get('x-request-id')) && Number(me.headers.get('ratelimit-limit')) > 0 && me.headers.get('ratelimit-remaining') !== null, { id: me.headers.get('x-request-id'), limit: me.headers.get('ratelimit-limit') });
            const people = await call('GET', `${V1}/people?limit=200`, key);
            const rows = people.b.data || [];
            const mineOnly = rows.length >= 10 && rows.every((p) => !p.work_email || p.work_email.endsWith(`@${domain}`));
            check('people: everyone in this company and nobody from any other company', people.s === 200 && mineOnly && ['hr', 'cashier', 'manager'].every((k) => rows.some((p) => p.id === state.people[k].uid)), { count: rows.length, foreign: rows.filter((p) => p.work_email && !p.work_email.endsWith(`@${domain}`)).map((p) => p.work_email).slice(0, 5) });
            check('people: no SSN, bank or pay data in the answer (this key has no pay scope)', !/taxpayer|ssn|routingNumber|accountNumber|pay_rate|"compensation":\{/i.test(people.text) && !/5\d\d-\d\d-40\d\d/.test(people.text), (people.text.match(/.{60}(taxpayer|ssn|routingNumber|accountNumber|pay_rate|"compensation":\{).{60}/i) || [''])[0]);
            const cashierRow = rows.find((p) => p.id === state.people.cashier.uid) || {};
            check('a person has their number, name, work email, job title and manager', cashierRow.employee_number === state.people.cashier.employeeId && cashierRow.first_name === 'Carlos' && cashierRow.work_email === state.people.cashier.email && cashierRow.job && cashierRow.job.title === 'Cashier' && cashierRow.job.manager_id === state.people.manager.uid, cashierRow);
            const one = await call('GET', `${V1}/people/${state.people.cashier.uid}`, key);
            const byNumber = await call('GET', `${V1}/people?employee_number=${encodeURIComponent(state.people.cashier.employeeId)}`, key);
            check('one person can be read by id and found by employee number', one.s === 200 && one.b.data.id === state.people.cashier.uid && byNumber.s === 200 && (byNumber.b.data || []).length === 1, { one: one.s, byNumber: (byNumber.b.data || []).length });
            const etag = one.headers.get('etag');
            const notChanged = await call('GET', `${V1}/people/${state.people.cashier.uid}`, key, null, { 'If-None-Match': etag });
            check('an unchanged record answers "not modified" (304) when the ETag is sent back', Boolean(etag) && notChanged.s === 304, { etag, s: notChanged.s });
            const page1 = await call('GET', `${V1}/people?limit=3`, key);
            const page2 = page1.b.next_cursor ? await call('GET', `${V1}/people?limit=3&cursor=${encodeURIComponent(page1.b.next_cursor)}`, key) : { s: 0, b: {} };
            check('lists come in pages with a cursor, without repeats', page1.s === 200 && (page1.b.data || []).length === 3 && page1.b.has_more === true && page2.s === 200 && (page2.b.data || []).length === 3 && !(page2.b.data || []).some((p) => page1.b.data.some((q) => q.id === p.id)), { p1: (page1.b.data || []).map((p) => p.id), p2: (page2.b.data || []).map((p) => p.id) });
            check('a broken cursor is refused (400)', (await call('GET', `${V1}/people?cursor=nonsense`, key)).s === 400);
            const jobs = await call('GET', `${V1}/jobs?limit=200`, key);
            check('jobs: one per person with title and classification', jobs.s === 200 && (jobs.b.data || []).length >= 10 && /Cashier/.test(jobs.text), jobs.text.slice(0, 300));
            const units = await call('GET', `${V1}/org-units`, key);
            const locations = await call('GET', `${V1}/locations`, key);
            check('org: the three departments and the two locations', units.s === 200 && ['Office', 'Store', 'Cafe'].every((n) => (units.b.data || []).some((u) => u.name === n)) && locations.s === 200 && /Congress Ave Store/.test(locations.text) && /South Lamar Cafe/.test(locations.text), { units: (units.b.data || []).map((u) => u.name), locations: (locations.b.data || []).map((l) => l.name) });
            const firstUnit = (units.b.data || [])[0];
            check('one department can be read by id', firstUnit && (await call('GET', `${V1}/org-units/${firstUnit.id}`, key)).s === 200, firstUnit);
            const time = await call('GET', `${V1}/time-entries`, key);
            const timeBad = await call('GET', `${V1}/time-entries?period=day`, key);
            check('time: approved weekly hours read; daily hours need a person and dates (400)', time.s === 200 && Array.isArray(time.b.data) && timeBad.s === 400, { time: time.s, timeBad: timeBad.b });
            const punch = await call('POST', `${V1}/time-entries`, key, { person_id: state.people.cashier.uid, type: 'in' });
            check('time: posting a punch through the API is off until the owner turns it on (403)', punch.s === 403 && punch.b.error && punch.b.error.code === 'feature_disabled', punch.b);
            const leaveReq = await call('GET', `${V1}/leave/requests`, key);
            const leaveBal = await call('GET', `${V1}/leave/balances?person_id=${state.people.cashier.uid}`, key);
            const leaveNoPerson = await call('GET', `${V1}/leave/balances`, key);
            check('leave: requests and one person\'s balances read; balances without a person are refused (400)', leaveReq.s === 200 && Array.isArray(leaveReq.b.data) && leaveBal.s === 200 && leaveNoPerson.s === 400, { leaveReq: leaveReq.s, leaveBal: leaveBal.s, leaveNoPerson: leaveNoPerson.s });
            const docs = await call('GET', `${V1}/documents`, key);
            check('documents: details only, never the file', docs.s === 200 && Array.isArray(docs.b.data) && !/"(content|base64|storagePath|storage_path|path|file)":/.test(docs.text), docs.text.slice(0, 300));
            const pay = await call('GET', `${V1}/pay-results`, key);
            check('pay results are refused for a key without the pay scope (403)', pay.s === 403 && pay.b.error && pay.b.error.code === 'insufficient_scope', pay.b);

            ctx.section('Another company, a narrower key, a revoked key');
            // a person of another company: taken from another run's saved state when there is one, else the demo company
            let foreign = null;
            try {
                const dir = path.join(__dirname, '..', '.state');
                for (const f of fs.readdirSync(dir).filter((x) => /\.json$/.test(x) && !/-report\.json$/.test(x))) {
                    const other = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                    if (other.company && other.company.orgId !== state.company.orgId && other.people && other.people.hr) { foreign = { uid: other.people.hr.uid, employeeId: other.people.hr.employeeId, email: other.people.hr.email }; break; }
                }
            } catch (_) { /* no other run on this machine */ }
            if (foreign) {
                const a = await call('GET', `${V1}/people/${foreign.uid}`, key);
                const b = await call('GET', `${V1}/people?email=${encodeURIComponent(foreign.email)}`, key);
                check('a person of another company cannot be read by id (404) or found by email', a.s === 404 && b.s === 200 && (b.b.data || []).length === 0, { byId: a.s, byEmail: (b.b.data || []).length });
                const c = await call('PATCH', `${V1}/people/${foreign.uid}`, key, { job_title: 'Changed from another company' });
                check('and cannot be changed (404)', c.s === 404, c.b);
            } else ctx.skip('Reading a person of another company by id is refused', 'no other company\'s saved run was found on this machine to take an id from; the list check above still proves nobody else appears');

            const narrow = await call('POST', `${I}/keys`, owner, { name: `E2E org chart only ${run}-${stamp}`, scopes: ['org:read'], rateLimitPerMinute: 30 });
            const narrowKey = narrow.b.key;
            const nOrg = await call('GET', `${V1}/org-units`, narrowKey);
            const nPeople = await call('GET', `${V1}/people`, narrowKey);
            const nWrite = await call('POST', `${V1}/people`, narrowKey, { first_name: 'No', last_name: 'Body', work_email: `nobody-${stamp}@${domain}`, hire_date: ctx.today });
            check('a key limited to the org chart reads departments but is refused people (403) and writes (403)', narrow.s === 201 && nOrg.s === 200 && nPeople.s === 403 && nPeople.b.error.code === 'insufficient_scope' && nWrite.s === 403, { nOrg: nOrg.s, nPeople: nPeople.b, nWrite: nWrite.s });
            check('its own lower rate limit is what the answer reports', nOrg.headers.get('ratelimit-limit') === '30', nOrg.headers.get('ratelimit-limit'));
            const revoked = await call('DELETE', `${I}/keys/${narrow.b.record && narrow.b.record.id}`, owner);
            const afterRevoke = await call('GET', `${V1}/org-units`, narrowKey);
            check('the owner revokes that key and it stops working at once (401)', revoked.s === 200 && afterRevoke.s === 401 && /revoked|invalid/.test(afterRevoke.b.error.code), { revoked: revoked.s, after: afterRevoke.b });
            check('a made-up key is refused (401), and so is no key at all (401)', (await call('GET', `${V1}/people`, 'kx_live_not_a_real_key_000000000000')).s === 401 && (await call('GET', `${V1}/people`, null)).s === 401);
            check('a staff sign-in token is not an API key (401)', (await call('GET', `${V1}/people`, owner)).s === 401);

            ctx.section('Writing through the API');
            const apiEmail = `api-${stamp}@${domain}`;
            const body = { first_name: 'Api', last_name: `Person${stamp}`, work_email: apiEmail, hire_date: ctx.today, job: { title: 'Temp via API' } };
            const idem = `e2e-${run}-${stamp}`;
            const created = await call('POST', `${V1}/people`, key, body, { 'Idempotency-Key': idem });
            const apiPerson = created.b.data || {};
            check('a person is created through the API with an employee number', created.s === 201 && apiPerson.id && apiPerson.employee_number && apiPerson.work_email === apiEmail, created.b);
            ids.apiPersonId = apiPerson.id;
            const replay = await call('POST', `${V1}/people`, key, body, { 'Idempotency-Key': idem });
            check('sending the same request again with the same idempotency key does not create a second person', replay.s === 201 && replay.b.data && replay.b.data.id === apiPerson.id && replay.headers.get('idempotent-replayed') === 'true', { s: replay.s, id: replay.b.data && replay.b.data.id, header: replay.headers.get('idempotent-replayed') });
            const dupe = await call('POST', `${V1}/people`, key, body);
            check('the same work email a second time is refused (409)', dupe.s === 409, dupe.b);
            const invalid = await call('POST', `${V1}/people`, key, { first_name: 'Only' });
            check('a person without the required fields is refused (400) with the list of problems', invalid.s === 400 && Array.isArray(invalid.b.error.details) && invalid.b.error.details.length >= 2, invalid.b);
            const inStaffList = await call('GET', `${U}/employees`, hr);
            check('HR sees the new person in the people list', (inStaffList.b.data || []).some((p) => p.id === apiPerson.id), (inStaffList.b.data || []).length);

            const spec = await call('GET', `${V1}/openapi.json`, null);
            const paths = Object.keys(spec.b.paths || {});
            check('the OpenAPI document is public and describes people, jobs, org, time, leave and documents', spec.s === 200 && /^3\./.test(String(spec.b.openapi)) && ['/people', '/jobs', '/org-units', '/locations', '/time-entries', '/leave/requests', '/documents'].every((p) => paths.some((x) => x.endsWith(p))) && JSON.stringify(spec.b.components || {}).includes('Person'), { openapi: spec.b.openapi, paths });

            // ------------------------------------------------------------------------------------------ webhooks
            ctx.section('Webhooks: signed deliveries to a local receiver');
            const priv = await call('POST', `${I}/webhooks`, owner, { url: 'http://169.254.169.254/latest/meta-data', events: ['*'] });
            const internal = await call('POST', `${I}/webhooks`, owner, { url: 'http://payroll.internal/hook', events: ['*'] });
            check('an address inside a private network is refused (400)', priv.s === 400 && internal.s === 400, { priv: priv.b, internal: internal.b });
            const badFilter = await call('POST', `${I}/webhooks`, owner, { url: 'https://example.com/hook', events: ['Not An Event'] });
            check('a badly written event filter is refused (400)', badFilter.s === 400, badFilter.b);
            const hook = await call('POST', `${I}/webhooks`, owner, { url: hookUrl, description: `E2E receiver ${run}-${stamp}`, events: ['person.*', 'webhook.test'] });
            const loopbackRefused = hook.s === 400 && /private|internal|reserved/.test(JSON.stringify(hook.b));
            if (loopbackRefused) {
                ctx.skip('Webhook deliveries arrive signed, are listed and can be replayed', 'the running app refuses 127.0.0.1 as a webhook address; it accepts it only when started with WEBHOOK_ALLOW_LOOPBACK=true (never in production), and sending this company\'s events to an outside address is not something a local run should do');
            } else if (check('the owner registers a webhook address; the signing secret is shown once', hook.s === 201 && hook.b.endpoint && hook.b.endpoint.id && /^whsec_/.test(String(hook.b.secret)), hook.b)) {
                const ep = hook.b.endpoint; let secret = hook.b.secret; ids.webhookId = ep.id;
                const eps = await call('GET', `${I}/webhooks`, owner);
                check('the webhook list shows it without the secret', eps.s === 200 && (eps.b.data || []).some((e) => e.id === ep.id && e.active === true) && !eps.text.includes(secret), eps.text.slice(0, 300));
                check('HR cannot add a webhook (403)', (await call('POST', `${I}/webhooks`, hr, { url: hookUrl, events: ['*'] })).s === 403);

                const test = await call('POST', `${I}/webhooks/${ep.id}/test`, owner, {});
                const gotTest = await waitFor((r) => r.headers['x-kylrx-event'] === 'webhook.test' && r.headers['x-kylrx-delivery'] === test.b.delivery_id);
                check('a test event is sent and arrives at the receiver', test.s === 202 && Boolean(gotTest), { s: test.s, received: receiver.got.length });
                if (gotTest) {
                    check('it is signed, and the signature checks out with the secret', signatureIsGood(gotTest.headers['x-kylrx-signature'], gotTest.body, secret), gotTest.headers['x-kylrx-signature']);
                    check('a different secret, or a changed body, does not check out', !signatureIsGood(gotTest.headers['x-kylrx-signature'], gotTest.body, 'whsec_wrong') && !signatureIsGood(gotTest.headers['x-kylrx-signature'], `${gotTest.body} `, secret));
                    const evt = JSON.parse(gotTest.body);
                    check('the event says what it is, when, and for which company', evt.type === 'webhook.test' && evt.id === gotTest.headers['x-kylrx-event-id'] && JSON.stringify(evt).includes(state.company.orgId), evt);
                }

                // a real event: a person's record changes through the API
                const patched = await call('PATCH', `${V1}/people/${apiPerson.id}`, key, { job: { title: 'Temp, changed through the API' }, phone: '512-555-0142' });
                check('the throwaway person\'s job title is changed through the API', patched.s === 200 && patched.b.data.job.title === 'Temp, changed through the API', patched.b);
                const gotReal = await waitFor((r) => r.headers['x-kylrx-event'] === 'person.updated' && r.body.includes(apiPerson.id));
                check('a "person updated" event arrives for that change, signed', Boolean(gotReal) && signatureIsGood(gotReal.headers['x-kylrx-signature'], gotReal.body, secret), gotReal ? gotReal.headers : `received ${receiver.got.map((r) => r.headers['x-kylrx-event']).join(', ')}`);
                if (gotReal) {
                    const evt = JSON.parse(gotReal.body);
                    check('it names the person and the fields that changed, and carries no personal details beyond that', JSON.stringify(evt).includes('job.title') && !/512-555-0142/.test(gotReal.body), evt);
                }
                const gotCreated = receiver.got.find((r) => r.headers['x-kylrx-event'] === 'person.created' && r.body.includes(apiPerson.id)) || await waitFor((r) => r.headers['x-kylrx-event'] === 'person.created' && r.body.includes(apiPerson.id), 1000);
                check('no event from before the webhook existed is delivered late (the person was created earlier)', !gotCreated, gotCreated && gotCreated.body.slice(0, 200));

                await sleep(800);
                const deliveries = await call('GET', `${I}/webhooks/deliveries?endpointId=${ep.id}`, owner);
                const dl = deliveries.b.data || [];
                const realRow = dl.find((d) => gotReal && d.id === gotReal.headers['x-kylrx-delivery']);
                check('the delivery list shows both deliveries as delivered, with the answer code', deliveries.s === 200 && dl.length >= 2 && Boolean(realRow) && /delivered|success/.test(String(realRow.status)) && JSON.stringify(realRow).includes('200'), dl.slice(0, 3));
                if (realRow) {
                    const before = receiver.got.length;
                    const again = await call('POST', `${I}/webhooks/deliveries/${realRow.id}/replay`, owner, {});
                    const gotReplay = await waitFor((r) => r.headers['x-kylrx-delivery'] === again.b.delivery_id);
                    check('a delivery is replayed: the same event arrives again as a new, signed delivery', again.s === 201 && Boolean(gotReplay) && gotReplay.headers['x-kylrx-event-id'] === gotReal.headers['x-kylrx-event-id'] && signatureIsGood(gotReplay.headers['x-kylrx-signature'], gotReplay.body, secret) && receiver.got.length > before, { s: again.s, b: again.b });
                    check('replaying a delivery that does not exist is refused (404)', (await call('POST', `${I}/webhooks/deliveries/nope-${stamp}/replay`, owner, {})).s === 404);
                }
                const rotated = await call('POST', `${I}/webhooks/${ep.id}/rotate-secret`, owner, {});
                if (check('the signing secret is changed; the old one keeps working for a while', rotated.s === 200 && /^whsec_/.test(String(rotated.b.secret)) && rotated.b.secret !== secret && rotated.b.previous_secret_expires_at, rotated.b)) {
                    const t2 = await call('POST', `${I}/webhooks/${ep.id}/test`, owner, {});
                    const got2 = await waitFor((r) => r.headers['x-kylrx-delivery'] === t2.b.delivery_id);
                    check('the next delivery checks out with the new secret and still with the old one', Boolean(got2) && signatureIsGood(got2.headers['x-kylrx-signature'], got2.body, rotated.b.secret) && signatureIsGood(got2.headers['x-kylrx-signature'], got2.body, secret), got2 && got2.headers['x-kylrx-signature']);
                    secret = rotated.b.secret;
                }
                const paused = await call('PATCH', `${I}/webhooks/${ep.id}`, owner, { active: false });
                check('the owner pauses the webhook', paused.s === 200 && paused.b.endpoint.active === false, paused.b);
                const removed = await call('DELETE', `${I}/webhooks/${ep.id}`, owner);
                const epsAfter = await call('GET', `${I}/webhooks`, owner);
                check('and removes it', removed.s === 200 && !(epsAfter.b.data || []).some((e) => e.id === ep.id), removed.b);
            }

            // -------------------------------------------------------------------------------------------- OAuth
            ctx.section('OAuth app: consent, token, API call, revoke');
            const wellKnown = await call('GET', '/oauth/.well-known/oauth-authorization-server', null);
            check('the OAuth discovery document is public', wellKnown.s === 200 && /\/oauth\/token$/.test(wellKnown.b.token_endpoint) && (wellKnown.b.code_challenge_methods_supported || []).includes('S256'), wellKnown.b);
            const redirect = `http://127.0.0.1:${receiver.port}/oauth/callback`;
            const noRedirect = await call('POST', `${I}/oauth/apps`, owner, { name: 'no redirect', scopes: ['people:read'] });
            const plainHttp = await call('POST', `${I}/oauth/apps`, owner, { name: 'plain http', scopes: ['people:read'], redirectUris: ['http://example.com/cb'] });
            check('an app without a return address, or with a plain http one, is refused (400)', noRedirect.s === 400 && plainHttp.s === 400, { noRedirect: noRedirect.b, plainHttp: plainHttp.b });
            const app = await call('POST', `${I}/oauth/apps`, owner, { name: `E2E scheduling app ${run}-${stamp}`, description: 'Reads people and departments', redirectUris: [redirect], scopes: ['people:read', 'org:read'] });
            const clientId = app.b.app && app.b.app.client_id; const clientSecret = app.b.client_secret;
            if (check('the owner registers an OAuth app; the client secret is shown once', app.s === 201 && clientId && /^kxs_/.test(String(clientSecret)), { s: app.s, app: app.b.app, errors: app.b.errors })) {
                ids.oauthClientId = clientId;
                const verifier = crypto.randomBytes(32).toString('base64url');
                const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
                const ask = { client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: 'people:read org:read', state: `st-${stamp}`, code_challenge: challenge, code_challenge_method: 'S256' };
                const qs = new URLSearchParams(ask).toString();
                const info = await call('GET', `${I}/oauth/authorize-info?${qs}`, owner);
                check('the consent screen shows the app and, in words, what it asks for', info.s === 200 && info.b.app.client_id === clientId && info.b.scopes.length === 2 && /people/i.test(info.b.scope_descriptions['people:read']) && info.b.company_id === state.company.orgId, info.b);
                check('HR cannot approve apps (403)', (await call('GET', `${I}/oauth/authorize-info?${qs}`, hr)).s === 403 && (await call('POST', `${I}/oauth/authorize`, hr, { ...ask, decision: 'approve' })).s === 403);
                const tooMuch = await call('GET', `${I}/oauth/authorize-info?${new URLSearchParams({ ...ask, scope: 'people:read pay:read' })}`, owner);
                const wrongBack = await call('GET', `${I}/oauth/authorize-info?${new URLSearchParams({ ...ask, redirect_uri: 'https://evil.example/cb' })}`, owner);
                check('asking for more than the app was registered for, or another return address, is refused (400)', tooMuch.s === 400 && wrongBack.s === 400 && wrongBack.b.can_redirect === false, { tooMuch: tooMuch.b, wrongBack: wrongBack.b });
                const denied = await call('POST', `${I}/oauth/authorize`, owner, { ...ask, decision: 'deny' });
                check('when the owner says no, the app is told "access denied" and gets no code', denied.s === 200 && /error=access_denied/.test(denied.b.redirect_url) && !/[?&]code=/.test(denied.b.redirect_url), denied.b);
                const approved = await call('POST', `${I}/oauth/authorize`, owner, { ...ask, decision: 'approve' });
                const back = approved.b.redirect_url ? new URL(approved.b.redirect_url) : null;
                const code = back && back.searchParams.get('code');
                check('when the owner approves, the app is sent back to its own address with a one-time code and its state', approved.s === 200 && back && `${back.origin}${back.pathname}` === redirect && Boolean(code) && back.searchParams.get('state') === ask.state, approved.b);
                const tokenBody = { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, client_secret: clientSecret, code_verifier: verifier };
                const wrongSecret = await call('POST', '/oauth/token', null, { ...tokenBody, client_secret: 'kxs_wrong' });
                const wrongVerifier = await call('POST', '/oauth/token', null, { ...tokenBody, code_verifier: crypto.randomBytes(32).toString('base64url') });
                check('the code cannot be exchanged with a wrong client secret (401) or a wrong PKCE verifier (400)', wrongSecret.s === 401 && wrongVerifier.s === 400, { wrongSecret: wrongSecret.b, wrongVerifier: wrongVerifier.b });
                const tok = await call('POST', '/oauth/token', null, tokenBody);
                const access = tok.b.access_token;
                if (check('the code is exchanged for an access token and a refresh token', tok.s === 200 && /^kxat_/.test(String(access)) && /^kxrt_/.test(String(tok.b.refresh_token)) && tok.b.expires_in > 0 && /no-store/.test(tok.headers.get('cache-control') || ''), { ...tok.b, access_token: access ? '(given)' : null, refresh_token: tok.b.refresh_token ? '(given)' : null })) {
                    const who = await call('GET', `${V1}/me`, access);
                    const ppl = await call('GET', `${V1}/people?limit=5`, access);
                    check('the token reads this company\'s people through the public API', who.s === 200 && who.b.data.org_id === state.company.orgId && ppl.s === 200 && (ppl.b.data || []).length === 5, { who: who.b, ppl: ppl.s });
                    const outside = await call('GET', `${V1}/leave/requests`, access);
                    check('but nothing outside what was approved (leave: 403)', outside.s === 403 && outside.b.error.code === 'insufficient_scope', outside.b);
                    const grants = await call('GET', `${I}/oauth/grants`, owner);
                    const grant = (grants.b.data || []).find((g) => JSON.stringify(g).includes(clientId));
                    check('the approved app is listed under connected apps', grants.s === 200 && Boolean(grant), grants.text.slice(0, 300));
                    const refreshed = await call('POST', '/oauth/token', null, { grant_type: 'refresh_token', refresh_token: tok.b.refresh_token, client_id: clientId, client_secret: clientSecret });
                    check('the refresh token gives a new access token', refreshed.s === 200 && refreshed.b.access_token && refreshed.b.access_token !== access && refreshed.b.refresh_token, { s: refreshed.s, error: refreshed.b.error });
                    const reused = await call('POST', '/oauth/token', null, { grant_type: 'refresh_token', refresh_token: tok.b.refresh_token, client_id: clientId, client_secret: clientSecret });
                    const afterReuse = refreshed.b.access_token ? await call('GET', `${V1}/me`, refreshed.b.access_token) : { s: 0 };
                    check('using the old refresh token a second time is refused and ends that session (stolen-token protection)', reused.s === 400 && afterReuse.s === 401, { reused: reused.b, afterReuse: afterReuse.s });
                    // client credentials: the app acting for the company that owns it
                    const cc = await call('POST', '/oauth/token', null, { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'org:read' });
                    const ccUse = cc.b.access_token ? await call('GET', `${V1}/org-units`, cc.b.access_token) : { s: 0 };
                    const ccTooMuch = cc.b.access_token ? await call('GET', `${V1}/people`, cc.b.access_token) : { s: 0 };
                    check('the app can also get a token for itself, limited to the scope it asked for', cc.s === 200 && !cc.b.refresh_token && ccUse.s === 200 && ccTooMuch.s === 403, { cc: cc.s, ccUse: ccUse.s, ccTooMuch: ccTooMuch.s });
                    const revoke = await call('POST', '/oauth/revoke', null, { token: cc.b.access_token, client_id: clientId, client_secret: clientSecret });
                    const afterRevokeTok = await call('GET', `${V1}/org-units`, cc.b.access_token);
                    check('the app revokes a token and it stops working (401)', revoke.s === 200 && afterRevokeTok.s === 401, { revoke: revoke.s, after: afterRevokeTok.s });
                    // a second approval, then the owner disconnects the app
                    const approved2 = await call('POST', `${I}/oauth/authorize`, owner, { ...ask, decision: 'approve' });
                    const code2 = approved2.b.redirect_url && new URL(approved2.b.redirect_url).searchParams.get('code');
                    const tok2 = await call('POST', '/oauth/token', null, { ...tokenBody, code: code2 });
                    const usedTwice = await call('POST', '/oauth/token', null, { ...tokenBody, code: code2 });
                    check('a code works once: a second exchange is refused (400)', tok2.s === 200 && usedTwice.s === 400, { tok2: tok2.s, usedTwice: usedTwice.b });
                    const approved3 = await call('POST', `${I}/oauth/authorize`, owner, { ...ask, decision: 'approve' });
                    const tok3 = await call('POST', '/oauth/token', null, { ...tokenBody, code: new URL(approved3.b.redirect_url).searchParams.get('code') });
                    const grantId = grant && (grant.id || `${state.company.orgId}_${clientId}`);
                    const disconnect = await call('DELETE', `${I}/oauth/grants/${grantId}`, owner);
                    const afterDisconnect = tok3.b.access_token ? await call('GET', `${V1}/me`, tok3.b.access_token) : { s: 0 };
                    const refreshAfter = await call('POST', '/oauth/token', null, { grant_type: 'refresh_token', refresh_token: tok3.b.refresh_token, client_id: clientId, client_secret: clientSecret });
                    check('the owner disconnects the app: its tokens stop working and cannot be renewed', tok3.s === 200 && disconnect.s === 200 && afterDisconnect.s === 401 && refreshAfter.s === 400, { tok3: tok3.s, disconnect: disconnect.b, afterDisconnect: afterDisconnect.s, refreshAfter: refreshAfter.b });
                }
                const newSecret = await call('POST', `${I}/oauth/apps/${clientId}/rotate-secret`, owner, {});
                const oldSecretNow = await call('POST', '/oauth/token', null, { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret });
                check('the client secret is replaced and the old one stops working (401)', newSecret.s === 200 && /^kxs_/.test(String(newSecret.b.client_secret)) && oldSecretNow.s === 401, { newSecret: newSecret.s, oldSecretNow: oldSecretNow.s });
                const off = await call('PATCH', `${I}/oauth/apps/${clientId}`, owner, { active: false });
                const offToken = await call('POST', '/oauth/token', null, { grant_type: 'client_credentials', client_id: clientId, client_secret: newSecret.b.client_secret });
                check('the owner switches the app off: it can no longer get tokens (401)', off.s === 200 && offToken.s === 401, { off: off.s, offToken: offToken.s });
            }

            // --------------------------------------------------------------------------------------------- SCIM
            ctx.section('SCIM: an identity provider manages sign-in accounts');
            const st = await call('POST', `${I}/scim/tokens`, owner, { name: `E2E directory ${run}-${stamp}` });
            const scim = st.b.token;
            const scimCall = (method, url, token, body) => call(method, `${SCIM}${url}`, token, body);
            if (check('the owner creates a SCIM token; it is shown once', st.s === 201 && /^scim_[0-9a-f]{48}$/.test(String(scim)) && st.b.base_path === '/scim/v2', { s: st.s, id: st.b.id })) {
                ids.scimTokenId = st.b.id;
                const cfg = await scimCall('GET', '/ServiceProviderConfig', scim);
                const schemas = await scimCall('GET', '/Schemas', scim);
                check('the SCIM server describes itself', cfg.s === 200 && cfg.b.patch && cfg.b.patch.supported === true && schemas.s === 200, { cfg: cfg.b, schemas: schemas.s });
                const users = await scimCall('GET', '/Users?count=200', scim);
                const res = users.b.Resources || [];
                check('it lists this company\'s people and nobody else\'s', users.s === 200 && users.b.totalResults >= 10 && res.every((u) => String(u.userName).endsWith(`@${domain}`)) && res.some((u) => u.id === state.people.cashier.uid), { total: users.b.totalResults, foreign: res.filter((u) => !String(u.userName).endsWith(`@${domain}`)).map((u) => u.userName).slice(0, 5) });
                const found = await scimCall('GET', `/Users?filter=${encodeURIComponent(`userName eq "${state.people.cashier.email}"`)}`, scim);
                check('a person is found by user name', found.s === 200 && found.b.totalResults === 1 && found.b.Resources[0].id === state.people.cashier.uid && found.b.Resources[0].name.givenName === 'Carlos', found.b);
                check('a filter that cannot be read is refused (400)', (await scimCall('GET', `/Users?filter=${encodeURIComponent('userName ===')}`, scim)).s === 400);
                const scimEmail = `scim-${stamp}@${domain}`;
                const newUser = await scimCall('POST', '/Users', scim, { schemas: [SCIM_USER], userName: scimEmail, name: { givenName: 'Skye', familyName: `Directory${stamp}` }, emails: [{ value: scimEmail, type: 'work', primary: true }], title: 'Seasonal Helper', externalId: `idp-${stamp}`, active: true });
                const su = newUser.b || {};
                if (check('the identity provider creates a person', newUser.s === 201 && su.id && su.userName === scimEmail && su.active === true && su.externalId === `idp-${stamp}` && /\/scim\/v2\/Users\//.test(newUser.headers.get('location') || ''), su)) {
                    ids.scimUserId = su.id;
                    check('creating the same user name again is refused (409)', (await scimCall('POST', '/Users', scim, { schemas: [SCIM_USER], userName: scimEmail, name: { givenName: 'Skye', familyName: 'Twice' } })).s === 409);
                    const got = await scimCall('GET', `/Users/${su.id}`, scim);
                    check('and reads the person back, with an employee number', got.s === 200 && JSON.stringify(got.b).includes('employeeNumber'), got.b);
                    const patched = await scimCall('PATCH', `/Users/${su.id}`, scim, { schemas: [SCIM_PATCH], Operations: [{ op: 'replace', path: 'title', value: 'Shift Lead' }, { op: 'replace', path: 'name.familyName', value: `Directory${stamp}B` }] });
                    check('it changes the job title and last name', patched.s === 200 && patched.b.title === 'Shift Lead' && patched.b.name.familyName === `Directory${stamp}B`, patched.b);
                    const hrSees = await call('GET', `${U}/employees`, hr);
                    check('HR sees the change in the people list', (hrSees.b.data || []).some((p) => p.id === su.id && new RegExp(`Directory${stamp}B`).test(p.name)), (hrSees.b.data || []).find((p) => p.id === su.id));
                    const noSchema = await scimCall('PATCH', `/Users/${su.id}`, scim, { Operations: [{ op: 'replace', path: 'title', value: 'X' }] });
                    check('a change without the SCIM patch schema is refused (400)', noSchema.s === 400, noSchema.b);
                    const deact = await scimCall('PATCH', `/Users/${su.id}`, scim, { schemas: [SCIM_PATCH], Operations: [{ op: 'replace', path: 'active', value: false }] });
                    check('it deactivates the person', deact.s === 200 && deact.b.active === false, deact.b);
                    const inactive = await scimCall('GET', `/Users?filter=${encodeURIComponent(`userName eq "${scimEmail}"`)}`, scim);
                    check('the person is still on file, marked inactive (never deleted)', inactive.s === 200 && inactive.b.totalResults === 1 && inactive.b.Resources[0].active === false, inactive.b);
                    const react = await scimCall('PUT', `/Users/${su.id}`, scim, { schemas: [SCIM_USER], userName: scimEmail, active: true });
                    const del = await scimCall('DELETE', `/Users/${su.id}`, scim);
                    const afterDel = await scimCall('GET', `/Users/${su.id}`, scim);
                    check('it can switch the person back on, and "delete" only deactivates again', react.s === 200 && react.b.active === true && del.s === 204 && afterDel.s === 200 && afterDel.b.active === false, { react: react.b.active, del: del.s, afterDel: afterDel.b.active });
                }
                if (foreign) check('a person of another company is not found through SCIM (404)', (await scimCall('GET', `/Users/${foreign.uid}`, scim)).s === 404);
                check('groups are not offered: departments come from HR', (await scimCall('GET', '/Groups', scim)).s === 200 && (await scimCall('POST', '/Groups', scim, { displayName: 'x' })).s === 501);
                check('a made-up SCIM token, an API key or no token is refused (401)', (await scimCall('GET', '/Users', `scim_${'0'.repeat(48)}`)).s === 401 && (await scimCall('GET', '/Users', key)).s === 401 && (await scimCall('GET', '/Users', null)).s === 401);
                const tokens = await call('GET', `${I}/scim/tokens`, owner);
                check('the token list shows it without the token itself', tokens.s === 200 && (tokens.b.data || []).some((t) => t.id === st.b.id) && !tokens.text.includes(scim), tokens.text.slice(0, 300));
                const revokedT = await call('DELETE', `${I}/scim/tokens/${st.b.id}`, owner);
                check('the owner revokes the token and the identity provider is locked out (401)', revokedT.s === 200 && (await scimCall('GET', '/Users', scim)).s === 401, revokedT.b);
            }

            // ---------------------------------------------------------------------------------------- connector
            ctx.section('A file-export connection: mapping, preview, test, sync, runs, logs, reconciliation');
            const catalog = await call('GET', `${I}/connectors/catalog`, owner);
            const cat = catalog.b.data || [];
            check('the connector catalog lists file export, accounting, ERP and chat connectors', catalog.s === 200 && ['file-export', 'quickbooks', 'xero', 'slack'].every((k) => cat.some((c) => c.key === k)), cat.map((c) => c.key));
            check('an unknown connector is refused (400)', (await call('POST', `${I}/connectors/connections`, owner, { connector: 'fax-machine' })).s === 400);
            check('HR cannot add a connection (403)', (await call('POST', `${I}/connectors/connections`, hr, { connector: 'file-export' })).s === 403);
            const conn = await call('POST', `${I}/connectors/connections`, owner, { connector: 'file-export', name: `E2E nightly export ${run}-${stamp}`, config: { driver: 'local', folder: `e2e-${run}-${stamp}` } });
            const cid = conn.b.connection && conn.b.connection.id;
            if (check('the owner adds a file-export connection (local folder, no password needed)', conn.s === 201 && cid && conn.b.connection.status === 'active', conn.b)) {
                ids.connectionId = cid;
                const C = `${I}/connectors/connections/${cid}`;
                const read = await call('GET', C, owner);
                check('the connection reads back without any stored secret', read.s === 200 && read.b.connection.id === cid && !/credentialsEnc|sftpPassword":"[^"]/.test(read.text), read.text.slice(0, 300));
                const mapping = await call('GET', `${C}/mapping`, owner);
                const peopleMap = (mapping.b.entities || []).find((e) => e.key === 'people_csv');
                check('the mapping screen shows the people, hours and payroll journal files with their columns', mapping.s === 200 && ['people_csv', 'time_csv', 'journal_csv'].every((k) => (mapping.b.entities || []).some((e) => e.key === k)) && peopleMap && peopleMap.rules.length >= 5 && peopleMap.rules.every((r) => r.origin === 'default') && (mapping.b.transforms || []).length > 3, { entities: (mapping.b.entities || []).map((e) => e.key), transforms: mapping.b.transforms });
                const sample = { id: 'sample', employee_number: 'E-777', first_name: 'Dana', last_name: 'Sample', work_email: 'dana@sample.test', job: { title: 'Baker', org_unit_name: 'Cafe' } };
                const preview = await call('POST', `${C}/mapping/preview`, owner, { entity: 'people_csv', record: sample });
                check('the preview shows what one person becomes in the file', preview.s === 200 && /E-777/.test(preview.text) && /Baker/.test(preview.text) && /dana@sample\.test/.test(preview.text), preview.b);
                if (peopleMap) {
                    const edited = peopleMap.rules.map((r) => (r.target === 'email' ? { ...r, removed: true } : r)).concat([{ target: 'company_code', default: 'LSM01' }, { target: 'worker_email', source: 'work_email', transform_text: 'lower' }]);
                    const previewEdited = await call('POST', `${C}/mapping/preview`, owner, { entity: 'people_csv', record: sample, edited });
                    check('the preview of an edited mapping shows the new and removed columns before saving', previewEdited.s === 200 && /LSM01/.test(previewEdited.text) && /worker_email/.test(previewEdited.text), previewEdited.b);
                    const badRule = await call('PUT', `${C}/mapping`, owner, { entity: 'people_csv', rules: [...edited, { target: '__proto__', source: 'first_name' }] });
                    const badEntity = await call('PUT', `${C}/mapping`, owner, { entity: 'payslips', rules: edited });
                    check('a mapping into a forbidden field, or for a file this connector does not write, is refused (400)', badRule.s === 400 && badEntity.s === 400, { badRule: badRule.b, badEntity: badEntity.b });
                    const saved = await call('PUT', `${C}/mapping`, owner, { entity: 'people_csv', rules: edited });
                    check('the edited mapping is saved: one column removed, two added', saved.s === 200 && saved.b.changes === 3 && saved.b.rules.some((r) => r.target === 'company_code' && r.origin === 'added') && saved.b.rules.some((r) => r.target === 'email' && r.origin === 'removed'), saved.b);
                    check('HR can look at the mapping but not change it (403)', (await call('GET', `${C}/mapping`, hr)).s === 200 && (await call('PUT', `${C}/mapping`, hr, { entity: 'people_csv', reset: true })).s === 403);
                }
                const health = await call('POST', `${C}/test`, owner, {});
                check('the connection test passes (the folder can be written to)', health.s === 200 && health.b.health && health.b.health.ok === true, health.b);
                // Once the company has run payroll (stage 04 on the mock provider) the export also writes a payroll journal,
                // which needs the company's own account numbers, as a real owner sets them on the mapping screen.
                const accounts = { 'accounts.wages_expense': '6000', 'accounts.employer_tax_expense': '6100', 'accounts.tax_payable': '2100', 'accounts.deductions_payable': '2200', 'accounts.net_pay_clearing': '1010' };
                const setAccounts = await call('PATCH', C, owner, { config: accounts });
                check('the owner enters the company\'s accounts for the payroll journal', setAccounts.s === 200 && ((setAccounts.b.connection || {}).config || {}).accounts && setAccounts.b.connection.config.accounts.wages_expense === '6000', setAccounts.b);
                const sync = await call('POST', `${C}/sync`, owner, {});
                const runRec = sync.b.run || {};
                check('a sync runs and succeeds', sync.s === 200 && runRec.status === 'success', sync.b);
                check('it wrote the people of this company', JSON.stringify(runRec).match(/people_csv/) && /"(pushed|written|records|ok|success|sent|created|count|total)":\s*[1-9]/.test(JSON.stringify(runRec)), runRec);
                const runs = await call('GET', `${C}/runs`, owner);
                check('the run history shows it with its start and end', runs.s === 200 && (runs.b.data || []).length >= 1 && /success/.test(JSON.stringify(runs.b.data[0])), (runs.b.data || []).slice(0, 1));
                const logs = await call('GET', `${C}/logs`, owner);
                check('the connection log has entries from creation to the sync', logs.s === 200 && (logs.b.data || []).length >= 2 && /created/i.test(logs.text), logs.text.slice(0, 300));
                const errors = await call('GET', `${C}/errors`, owner);
                check('no records are waiting in the error list', errors.s === 200 && (errors.b.data || []).length === 0, errors.b);
                const recon = await call('GET', `${C}/reconciliation`, owner);
                check('the reconciliation report compares what was sent with what is on file', recon.s === 200 && recon.b.report && typeof recon.b.report === 'object' && Object.keys(recon.b.report).length > 0, recon.b);
                const overview = await call('GET', `${I}/overview`, owner);
                check('the integrations overview counts the key, the connection and today\'s API traffic', overview.s === 200 && overview.b.counts.active_keys >= 1 && overview.b.counts.connections >= 1 && overview.b.api_last_24h.requests >= 10 && (overview.b.connections || []).some((c) => c.id === cid), overview.b);
                const pausedC = await call('PATCH', C, owner, { status: 'paused' });
                check('the owner pauses the connection (its schedule stops)', pausedC.s === 200 && pausedC.b.connection.status === 'paused' && (await call('PATCH', C, owner, { status: 'broken' })).s === 400, pausedC.b);
                check('a connection of another id is not found (404)', (await call('GET', `${I}/connectors/connections/nope-${stamp}`, owner)).s === 404);
                const gone = await call('DELETE', C, owner);
                check('the owner removes the connection', gone.s === 200 && (await call('GET', C, owner)).s === 404, gone.b);
            }

            ctx.section('Integration alerts and settings');
            const alerts = await call('GET', `${I}/alerts`, owner);
            check('the alert list reads and says alerts are shown on the page only', alerts.s === 200 && Array.isArray(alerts.b.data) && typeof alerts.b.open_count === 'number' && /e-mail/i.test(alerts.b.note), alerts.b);
            const aSettings = await call('GET', `${I}/alerts/settings`, owner);
            const limits = aSettings.b.limits || {};
            check('the alert settings show the limits the owner can choose between', aSettings.s === 200 && limits.min >= 1 && limits.max > limits.min && aSettings.b.defaults, aSettings.b);
            const tooHigh = await call('PUT', `${I}/alerts/settings`, owner, { syncFailures: (limits.max || 50) + 1 });
            check('a limit outside the allowed range is refused (400)', tooHigh.s === 400, tooHigh.b);
            const setA = await call('PUT', `${I}/alerts/settings`, owner, { enabled: true, syncFailures: 2, webhookFailures: 4 });
            const readA = await call('GET', `${I}/alerts/settings`, owner);
            check('the owner sets "alert after 2 failed syncs or 4 failed webhook attempts in a row"', setA.s === 200 && readA.b.settings.syncFailures === 2 && readA.b.settings.webhookFailures === 4, { setA: setA.b, readA: readA.b.settings });
            check('HR sees alerts but cannot change the settings (403)', (await call('GET', `${I}/alerts`, hr)).s === 200 && (await call('PUT', `${I}/alerts/settings`, hr, { syncFailures: 3 })).s === 403);
            check('an unknown alert filter is refused (400), an unknown alert cannot be acknowledged (404)', (await call('GET', `${I}/alerts?status=loud`, owner)).s === 400 && (await call('POST', `${I}/alerts/nope-${stamp}/acknowledge`, owner, {})).s === 404);
            const iSet = await call('PUT', `${I}/settings`, owner, { allowTimeWrite: false });
            check('the "let the API post time punches" switch reads and saves (left off)', iSet.s === 200 && iSet.b.settings.allowTimeWrite === false && (await call('GET', `${I}/settings`, hr)).b.settings.allowTimeWrite === false, iSet.b);

            ctx.section('API activity log');
            await sleep(600); // the log line is written after the answer is sent
            const apiLog = await call('GET', `${I}/api-log?limit=200`, owner);
            const lg = apiLog.b.data || [];
            check('the activity log shows this stage\'s API calls: who, what, the answer code and how long it took', apiLog.s === 200 && lg.some((r) => r.principal === keyName && r.method === 'GET' && r.path === '/api/v1/people' && r.status === 200 && typeof r.ms === 'number') && lg.some((r) => r.method === 'POST' && r.path === '/api/v1/people' && r.status === 201), lg.slice(0, 3));
            check('refused calls are in it too (the 403 of the narrow key)', lg.some((r) => r.status === 403 && /org chart only/.test(String(r.principal))), lg.filter((r) => r.status === 403).slice(0, 2));
            check('an employee cannot read the API activity log (403)', (await call('GET', `${I}/api-log`, cashier)).s === 403);

            // ------------------------------------------------------------------------------------------ audit log
            ctx.section('Audit log');
            const actions = await call('GET', `${U}/audit/actions`, owner);
            check('the list of audit actions has plain names', actions.s === 200 && (actions.b.data || []).length > 30 && actions.b.data.every((a) => a.key && a.label), (actions.b.data || []).slice(0, 3));
            const audit = await call('GET', `${U}/audit?limit=50`, owner);
            const ad = audit.b.data || [];
            check('the audit log lists recent actions, newest first, with who did them', audit.s === 200 && ad.length === 50 && ad.every((e) => e.at && e.action) && ad[0].at >= ad[ad.length - 1].at && ad.some((e) => e.actorName), ad.slice(0, 2));
            const keyAudit = await call('GET', `${U}/audit?action=integration_key_created&limit=20`, owner);
            const keyRow = (keyAudit.b.data || []).find((e) => e.targetId === ids.keyId);
            check('creating the API key is in it, under the owner\'s name, without the key', keyAudit.s === 200 && keyRow && keyRow.actorId === state.people.owner.uid && keyRow.actorName === 'Olivia Carter' && !keyAudit.text.includes(key), keyAudit.text.slice(0, 400));
            const apiAudit = await call('GET', `${U}/audit?action=api_person_created&limit=20`, owner);
            check('the person created through the API is in it, marked as done by an integration', apiAudit.s === 200 && (apiAudit.b.data || []).some((e) => e.targetId === apiPerson.id && e.actorRole === 'integration'), apiAudit.text.slice(0, 400));
            const byActor = await call('GET', `${U}/audit?actor=${encodeURIComponent('Hannah')}&limit=20`, owner);
            check('the log can be searched by person', byActor.s === 200 && (byActor.b.data || []).length > 0 && byActor.b.data.every((e) => e.actorId === state.people.hr.uid), (byActor.b.data || []).slice(0, 2));
            const byDay = await call('GET', `${U}/audit?from=${ctx.addDays(ctx.today, -400)}&to=${ctx.addDays(ctx.today, -399)}`, owner);
            check('a day long before the company existed has no entries', byDay.s === 200 && (byDay.b.data || []).length === 0, byDay.b.count);
            const page = await call('GET', `${U}/audit?limit=5`, owner);
            const next = page.b.nextCursor ? await call('GET', `${U}/audit?limit=5&cursor=${encodeURIComponent(page.b.nextCursor)}`, owner) : { s: 0, b: {} };
            check('the log pages with a cursor, without repeats', page.s === 200 && page.b.hasMore === true && next.s === 200 && (next.b.data || []).length === 5 && !(next.b.data || []).some((e) => page.b.data.some((x) => x.id === e.id)), { page: (page.b.data || []).map((e) => e.id), next: (next.b.data || []).map((e) => e.id) });
            const csv = await call('GET', `${U}/audit/export.csv?action=integration_key_created`, owner);
            check('the log downloads as a CSV file', csv.s === 200 && /text\/csv/.test(csv.headers.get('content-type') || '') && /attachment; filename="audit-/.test(csv.headers.get('content-disposition') || '') && /time,action,action_label,actor_id/.test(csv.text) && csv.text.includes(ids.keyId), csv.text.slice(0, 300));
            const verify = await call('GET', `${U}/audit/verify`, owner);
            check('the integrity check says the log has not been altered', verify.s === 200 && verify.b.valid === true && verify.b.chained > 0, { s: verify.s, valid: verify.b.valid, chained: verify.b.chained, unchained: verify.b.unchained, summary: verify.b.summary, error: verify.b.error });
            check('every entry of this company carries the integrity chain', verify.s === 200 && verify.b.unchained === 0, { chained: verify.b.chained, unchained: verify.b.unchained, summary: verify.b.summary });
            const viewed = await call('GET', `${U}/audit?action=audit_exported&limit=5`, owner);
            check('downloading the log is itself written to the log', viewed.s === 200 && (viewed.b.data || []).length >= 1, viewed.b.count);
            check('the auditor and HR read the audit log', (await call('GET', `${U}/audit?limit=1`, auditor)).s === 200 && (await call('GET', `${U}/audit?limit=1`, hr)).s === 200);
            check('payroll and employees cannot (403), and no token is refused (401)', (await call('GET', `${U}/audit`, payroll)).s === 403 && (await call('GET', `${U}/audit`, cashier)).s === 403 && (await call('GET', `${U}/audit/export.csv`, cashier)).s === 403 && (await call('GET', `${U}/audit`, null)).s === 401);

            // ------------------------------------------------------------------------------ roles and permissions
            ctx.section('Roles and permissions');
            const roles = await call('GET', `${U}/roles`, owner);
            const rl = roles.b.roles || [];
            const eight = ['super_admin', 'hr_admin', 'payroll_admin', 'manager', 'employee', 'accountant', 'auditor', 'executive'];
            check('the roles screen shows the eight roles, what each may do and how many people hold it', roles.s === 200 && rl.length === 8 && eight.every((r) => rl.some((x) => x.role === r && x.label && x.description && Array.isArray(x.permissions))) && rl.find((x) => x.role === 'employee').userCount >= 4 && (roles.b.allPermissions || []).length > 30, rl.map((r) => `${r.role}:${r.permissions.length}:${r.userCount}`));
            const perm = (role) => (rl.find((x) => x.role === role) || { permissions: [] }).permissions;
            check('the owner may do everything; payroll runs payroll but cannot change people; the auditor only reads', perm('super_admin').length === roles.b.allPermissions.length && perm('payroll_admin').includes('payroll.run') && !perm('payroll_admin').includes('people.write') && perm('auditor').includes('audit.view') && !perm('auditor').some((p) => /\.(write|run|manage|decide)$/.test(p)) && perm('employee').length < perm('manager').length + 5, { payroll: perm('payroll_admin'), auditor: perm('auditor') });
            const preview = await call('GET', `${U}/roles/manager/permissions`, owner);
            check('one role can be previewed before giving it; an unknown role is not found (404)', preview.s === 200 && preview.b.permissions.includes('leave.decide_team') && (await call('GET', `${U}/roles/wizard/permissions`, owner)).s === 404, preview.b);
            check('HR cannot open the roles screen (403)', (await call('GET', `${U}/roles`, hr)).s === 403 && (await call('GET', `${U}/roles/users`, hr)).s === 403);

            const tmpEmail = `temp09-${stamp}@${domain}`;
            const tmpMade = await call('POST', `${U}/employees`, owner, { firstName: 'Rory', lastName: `Shift${stamp}`, email: tmpEmail, role: 'employee', startDate: ctx.today, jobTitle: 'Seasonal Helper' });
            const tmp = tmpMade.b.employee || {};
            if (check('a throwaway person is added', tmpMade.s === 201 && tmp.uid && tmp.temporaryPassword, tmpMade.b)) {
                // the pages' own sign-in (Firebase; here the local Auth emulator): gives a token, or null when refused
                const pageSignIn = async (email, password) => {
                    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9099';
                    const r = await fetch(`http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
                    return (await r.json().catch(() => ({}))).idToken || null;
                };
                const tmpPassword = `E2e-Role#${stamp}pass`;
                const t0 = await pageSignIn(tmpEmail, tmp.temporaryPassword);
                const chose = await call('POST', '/api/auth/change-password', t0, { currentPassword: tmp.temporaryPassword, newPassword: tmpPassword });
                // the app allows a limited number of password changes per quarter hour from one address; other runs on this machine share it
                const canSignIn = chose.s === 200;
                if (!canSignIn) ctx.skip('The throwaway person signs in before and after the role change and sees what the new role allows', `they could not choose their password in this run: ${chose.s} ${chose.b.error || ''}`);
                if (canSignIn) {
                    const t1 = await pageSignIn(tmpEmail, tmpPassword);
                    const asEmployee = await call('GET', `${U}/me/permissions`, t1);
                    check('as an employee they see only their own things', asEmployee.s === 200 && asEmployee.b.role === 'employee' && !asEmployee.b.permissions.includes('payroll.view') && (await call('GET', `${U}/leave/payouts`, t1)).s === 403, asEmployee.b);
                }
                check('a role that does not exist is refused (400)', (await call('PUT', `${U}/roles/users/${tmp.uid}`, owner, { role: 'wizard' })).s === 400);
                check('HR cannot change roles (403)', (await call('PUT', `${U}/roles/users/${tmp.uid}`, hr, { role: 'accountant' })).s === 403);
                const change = await call('PUT', `${U}/roles/users/${tmp.uid}`, owner, { role: 'accountant' });
                check('the owner makes them an accountant', change.s === 200 && change.b.role === 'accountant' && change.b.previousRole === 'employee' && change.b.permissions.includes('payroll.view'), change.b);
                if (canSignIn) {
                    const t2 = await pageSignIn(tmpEmail, tmpPassword);
                    const asAccountant = await call('GET', `${U}/me/permissions`, t2);
                    const canRead = await call('GET', `${U}/leave/payouts`, t2);
                    const cannotWrite = await call('POST', `${U}/leave/payouts`, t2, { userId: state.people.cashier.uid });
                    check('at the next sign-in they can read payroll data but still not change it', asAccountant.b.role === 'accountant' && asAccountant.b.permissions.includes('payroll.view') && canRead.s === 200 && cannotWrite.s === 403, { role: asAccountant.b.role, canRead: canRead.s, cannotWrite: cannotWrite.s });
                }
                const usersList = await call('GET', `${U}/roles/users`, owner);
                check('the list of sign-in accounts shows the new role', usersList.s === 200 && (usersList.b.data || []).some((u) => u.id === tmp.uid && u.role === 'accountant' && u.roleLabel), (usersList.b.data || []).find((u) => u.id === tmp.uid));
                const same = await call('PUT', `${U}/roles/users/${tmp.uid}`, owner, { role: 'accountant' });
                check('giving the same role again changes nothing', same.s === 200 && same.b.unchanged === true, same.b);
                const roleAudit = await call('GET', `${U}/audit?action=role_changed&target=${tmp.uid}`, owner);
                check('the role change is in the audit log with the old and the new role', roleAudit.s === 200 && (roleAudit.b.data || []).some((e) => JSON.stringify(e.details).includes('employee') && JSON.stringify(e.details).includes('accountant')), roleAudit.text.slice(0, 300));
                const backToEmployee = await call('PUT', `${U}/roles/users/${tmp.uid}`, owner, { role: 'employee' });
                const t3 = canSignIn ? await pageSignIn(tmpEmail, tmpPassword) : null;
                check('the owner makes them an employee again' + (canSignIn ? ' and the extra access is gone' : ''), backToEmployee.s === 200 && backToEmployee.b.role === 'employee' && (!canSignIn || (await call('GET', `${U}/leave/payouts`, t3)).s === 403), backToEmployee.b);
            }
            check('the owner cannot change their own role (403)', (await call('PUT', `${U}/roles/users/${state.people.owner.uid}`, owner, { role: 'employee' })).s === 403);
            check('a sign-in account of another id is not found (404)', (await call('PUT', `${U}/roles/users/nope-${stamp}`, owner, { role: 'manager' })).s === 404);
            if (foreign) check('a person of another company cannot be given a role here (404)', (await call('PUT', `${U}/roles/users/${foreign.uid}`, owner, { role: 'manager' })).s === 404);

            // -------------------------------------------------------------------------------------------- billing
            ctx.section('Billing in practice mode');
            check('only the owner opens billing: HR and employees are refused (403)', (await call('GET', `${U}/billing`, hr)).s === 403 && (await call('GET', `${U}/billing/invoices`, cashier)).s === 403 && (await call('GET', `${U}/billing`, null)).s === 401);
            const plansR = await call('GET', `${U}/billing/plans`, owner);
            const plans = (plansR.b.data || []).slice().sort((a, b) => (a.baseFeeCents + a.perEmployeeCents) - (b.baseFeeCents + b.perEmployeeCents));
            if (check('the plans are listed with a base fee and a price per employee', plansR.s === 200 && plans.length >= 2 && plans.every((p) => p.id && p.name && Number.isInteger(p.baseFeeCents) && Number.isInteger(p.perEmployeeCents)), plansR.b)) {
                const cheap = plans[0]; const dear = plans[plans.length - 1];
                let bill = await call('GET', `${U}/billing`, owner);
                if (bill.b.billing && bill.b.billing.subscribed && bill.b.billing.state !== 'cancelled') await call('POST', `${U}/billing/cancel`, owner, { confirm: 'CANCEL' }); // left over from an interrupted earlier run
                bill = await call('GET', `${U}/billing`, owner);
                check('billing runs on the practice provider, not a real card processor', bill.s === 200 && (bill.b.billing.provider === undefined || bill.b.billing.provider === 'mock'), bill.b.billing && bill.b.billing.provider);
                check('an unknown plan is refused (400)', (await call('POST', `${U}/billing/subscribe`, owner, { planId: 'platinum-unicorn' })).s === 400);
                const sub = await call('POST', `${U}/billing/subscribe`, owner, { planId: cheap.id, interval: 'monthly' });
                const b1 = sub.b.billing || {};
                check(`the owner subscribes to ${cheap.name}: a free trial starts, with the headcount and next month's estimate`, sub.s === 201 && b1.subscribed === true && b1.state === 'trial' && b1.plan.id === cheap.id && b1.trialEndsAt && b1.usage && b1.usage.billable >= 10 && b1.usage.estimateNextCents === cheap.baseFeeCents + cheap.perEmployeeCents * b1.usage.billable, { s: sub.s, error: sub.b.error, state: b1.state, usage: b1.usage, plan: cheap });
                check('subscribing twice is refused (409)', (await call('POST', `${U}/billing/subscribe`, owner, { planId: cheap.id })).s === 409);
                const status = await call('GET', `${U}/billing/status`, owner);
                check('the billing status says the account is in good standing (not read-only)', status.s === 200 && status.b.state === 'trial' && status.b.readOnly === false, status.b);
                const badCard = await call('POST', `${U}/billing/payment-method`, owner, { token: '4242 4242 4242 4242' });
                check('a raw card number is never accepted, only a token from the card form (400)', badCard.s === 400, badCard.b);
                const card = await call('POST', `${U}/billing/payment-method`, owner, { token: 'pm_card_visa' });
                check('a practice card is put on file; only its brand and last four digits are kept', card.s === 200 && card.b.paymentMethod && card.b.paymentMethod.last4 === '4242' && !/4242424242424242/.test(card.text), card.b);
                const link = await call('GET', `${U}/billing/payment-method-link`, owner);
                check('the "update card" page is a placeholder in practice mode', link.s === 200 && link.b.url === null && link.b.provider === 'mock', link.b);
                const inv0 = await call('GET', `${U}/billing/invoices`, owner);
                const before = (inv0.b.data || []).length;
                check('the invoice list reads', inv0.s === 200 && Array.isArray(inv0.b.data), inv0.b);

                // Invoices are made by the platform's daily billing job, not by the customer. On a local server any owner may
                // call the operator route, so the run asks it for the day the trial ends (first as a dry run).
                const day = String(b1.trialEndsAt || '').slice(0, 10);
                const dry = await call('POST', '/api/platform/billing/run', owner, { today: day, dryRun: true });
                if (dry.s !== 200) {
                    ctx.skip('An invoice is issued, listed, downloaded and paid; a plan change mid-period is prorated', `invoices are made only by the platform's billing job (POST /api/platform/billing/run), which answered ${dry.s} for a company owner here`);
                    const change = await call('PUT', `${U}/billing/plan`, owner, { planId: dear.id });
                    check(`the plan is changed to ${dear.name} during the trial at no charge`, change.s === 200 && change.b.billing.plan.id === dear.id, change.b);
                } else {
                    const mineDry = ((dry.b.result || {}).invoiced || []).find((i) => i.orgId === state.company.orgId);
                    check('the billing job, asked what it would do on the day the trial ends, lists an invoice for this company', Boolean(mineDry), dry.b.result);
                    const cycle = await call('POST', '/api/platform/billing/run', owner, { today: day, dryRun: false });
                    check('the billing job runs for that day without errors', cycle.s === 200 && ((cycle.b.result || {}).errors || []).length === 0, cycle.b);
                    const inv1 = await call('GET', `${U}/billing/invoices`, owner);
                    const invoice = (inv1.b.data || [])[0] || {};
                    const expected = cheap.baseFeeCents + cheap.perEmployeeCents * b1.usage.billable;
                    check('the first invoice appears: base fee plus a line per employee, paid with the practice card', (inv1.b.data || []).length === before + 1 && /^INV-/.test(String(invoice.number)) && invoice.status === 'paid' && invoice.subtotalCents === expected && (invoice.lines || []).length >= 2 && invoice.headcount, invoice);
                    const afterCycle = await call('GET', `${U}/billing`, owner);
                    check('the account is now active with a current period', afterCycle.b.billing.state === 'active' && afterCycle.b.billing.currentPeriodStart && afterCycle.b.billing.currentPeriodEnd > afterCycle.b.billing.currentPeriodStart, afterCycle.b.billing);
                    if (invoice.id) {
                        ids.invoiceId = invoice.id;
                        const oneInv = await call('GET', `${U}/billing/invoices/${invoice.id}`, owner);
                        const file = await call('GET', `${U}/billing/invoices/${invoice.id}/download`, owner);
                        check('the invoice opens and downloads as a file with the company name, number and total', oneInv.s === 200 && oneInv.b.invoice.number === invoice.number && file.s === 200 && /attachment; filename="INV-/.test(file.headers.get('content-disposition') || '') && file.text.includes(invoice.number) && file.text.includes(state.company.name) && file.text.includes((invoice.totalCents / 100).toFixed(2)), file.text.slice(0, 400));
                        check('an invoice that is paid cannot be paid again (409)', (await call('POST', `${U}/billing/invoices/${invoice.id}/pay`, owner, {})).s === 409);
                        check('HR cannot download it (403); an invoice id that does not exist is not found (404)', (await call('GET', `${U}/billing/invoices/${invoice.id}/download`, hr)).s === 403 && (await call('GET', `${U}/billing/invoices/nope-${stamp}`, owner)).s === 404);
                    }
                    const change = await call('PUT', `${U}/billing/plan`, owner, { planId: dear.id });
                    const res = change.b.result || {};
                    check(`the plan is changed to ${dear.name}: the rest of the period is charged pro rata`, change.s === 200 && res.planId === dear.id && res.previousPlanId === cheap.id && res.proration && res.proration.netCents > 0 && change.b.billing.plan.id === dear.id, change.b.result || change.b);
                    const inv2 = await call('GET', `${U}/billing/invoices`, owner);
                    const pro = (inv2.b.data || []).find((i) => i.kind === 'proration' && i.id === res.invoiceId) || {};
                    check('a second invoice shows the credit for the old plan and the charge for the new one', pro.totalCents === res.proration.netCents && (pro.lines || []).some((l) => l.amountCents < 0) && (pro.lines || []).some((l) => l.amountCents > 0) && pro.status === 'paid', pro);
                    check('changing to the plan already in use is refused (409)', (await call('PUT', `${U}/billing/plan`, owner, { planId: dear.id })).s === 409);
                }
                const contractors = await call('PUT', `${U}/billing/settings`, owner, { includeContractors: true });
                check('the owner chooses whether contractors count toward the bill', contractors.s === 200 && contractors.b.billing.includeContractors === true && (await call('PUT', `${U}/billing/settings`, owner, { includeContractors: 'yes' })).s === 400, contractors.b);
                const noConfirm = await call('POST', `${U}/billing/cancel`, owner, {});
                check('cancelling needs the word CANCEL (400)', noConfirm.s === 400, noConfirm.b);
                const cancelled = await call('POST', `${U}/billing/cancel`, owner, { confirm: 'CANCEL' });
                check('the owner cancels the subscription', cancelled.s === 200 && cancelled.b.billing.state === 'cancelled', cancelled.b);
                check('cancelling twice is refused (409), and so is a plan change after cancelling (409)', (await call('POST', `${U}/billing/cancel`, owner, { confirm: 'CANCEL' })).s === 409 && (await call('PUT', `${U}/billing/plan`, owner, { planId: cheap.id })).s === 409);
                const invEnd = await call('GET', `${U}/billing/invoices`, owner);
                check('the invoices stay available after cancelling', invEnd.s === 200 && (invEnd.b.data || []).length >= before, (invEnd.b.data || []).length);
                const stillWorks = await call('GET', `${U}/employees`, hr);
                check('the company can still read its data after cancelling', stillWorks.s === 200, stillWorks.s);
                const billAudit = await call('GET', `${U}/audit?q=billing_&limit=20`, owner);
                check('subscribing, the card and cancelling are in the audit log, without card details', billAudit.s === 200 && ['billing_subscribed', 'billing_payment_method_updated', 'billing_cancelled'].every((a) => (billAudit.b.data || []).some((e) => e.action === a)) && !/pm_card_visa/.test(billAudit.text), (billAudit.b.data || []).map((e) => e.action));
            }

            // ------------------------------------------------------------------------------ status and support
            ctx.section('Status page and support access');
            const status = await call('GET', '/api/status', null);
            check('the public status endpoint needs no sign-in and lists each part of the service', status.s === 200 && ['operational', 'degraded', 'outage'].includes(status.b.overall) && (status.b.components || []).length >= 3 && status.b.components.every((c) => c.key && c.name && c.status) && Array.isArray(status.b.incidents), status.b);
            check('it gives away nothing about any company', !status.text.includes(state.company.orgId) && !/@/.test(status.text), status.text.slice(0, 200));
            check('a visitor cannot post an incident to the status page (401)', (await call('POST', '/api/status/incidents', null, { title: 'x' })).s === 401);

            const S = '/api/support';
            check('only the owner can let support in: HR and employees are refused (403)', (await call('POST', `${S}/grants`, hr, { hours: 2, reason: 'Help with a report' })).s === 403 && (await call('GET', `${S}/grants`, cashier)).s === 403 && (await call('GET', `${S}/grants`, null)).s === 401);
            const tooLong = await call('POST', `${S}/grants`, owner, { hours: 500, reason: 'Help with a report' });
            const noWhy = await call('POST', `${S}/grants`, owner, { hours: 2, reason: '' });
            check('access for longer than three days, or without a reason, is refused (400)', tooLong.s === 400 && noWhy.s === 400, { tooLong: tooLong.b, noWhy: noWhy.b });
            const grant = await call('POST', `${S}/grants`, owner, { hours: 2, reason: `E2E run ${run}-${stamp}: help with the turnover report` });
            const g = grant.b.grant || {};
            if (check('the owner lets support in for two hours, read-only, with a reason', grant.s === 201 && g.id && g.mode === 'read_only' && g.orgId === state.company.orgId && new Date(g.expiresAt) - new Date(g.createdAt) === 2 * 3600000, grant.b)) {
                ids.supportGrantId = g.id;
                const gl = await call('GET', `${S}/grants`, owner);
                check('it is listed as active', gl.s === 200 && (gl.b.data || []).some((x) => x.id === g.id && x.active === true), (gl.b.data || []).slice(0, 2));
                const session = await call('POST', `${S}/session`, owner, { grantId: g.id });
                check('a company owner cannot start a support session themselves (support staff only, 403)', session.s === 403 && !session.b.token, session.b);
                const all = await call('GET', `${S}/platform/grants`, owner);
                check('nor see the grants of every company (support staff only, 403)', all.s === 403, { s: all.s, count: (all.b.data || []).length });
                const grantAudit = await call('GET', `${U}/audit?action=support_access_granted`, owner);
                check('letting support in is in the audit log with the reason', grantAudit.s === 200 && (grantAudit.b.data || []).some((e) => e.targetId === g.id && /turnover report/.test(JSON.stringify(e.details))), grantAudit.text.slice(0, 300));
                const end = await call('DELETE', `${S}/grants/${g.id}`, owner);
                const gl2 = await call('GET', `${S}/grants`, owner);
                check('the owner ends the access early and it shows as no longer active', end.s === 200 && (gl2.b.data || []).some((x) => x.id === g.id && x.active === false && x.revokedAt), (gl2.b.data || []).find((x) => x.id === g.id));
                check('a grant that does not exist cannot be ended (404)', (await call('DELETE', `${S}/grants/nope-${stamp}`, owner)).s === 404);
            }
            ctx.skip('A support session opened by support staff reads this company and cannot change anything', 'starting a session needs a sign-in named in the server setting PLATFORM_SUPPORT_EMAILS; a company owner cannot reach it through any route');
            ctx.skip('Backup and restore', 'these are command-line scripts run by the operator (see docs), not routes');

            // ---------------------------------------------------------------------------------------- tidying up
            ctx.section('Tidying up');
            const offKey = await call('PATCH', `${I}/keys/${ids.keyId}`, owner, { name: `${keyName} (finished)` });
            const revokeMain = await call('DELETE', `${I}/keys/${ids.keyId}`, owner);
            const dead = await call('GET', `${V1}/me`, key);
            check('the stage\'s API key is renamed, revoked and refused from then on (401)', offKey.s === 200 && revokeMain.s === 200 && dead.s === 401 && dead.b.error.code === 'token_revoked', { offKey: offKey.b, revokeMain: revokeMain.s, dead: dead.b });
            const keysEnd = await call('GET', `${I}/keys`, owner);
            check('the key list keeps it, marked revoked, for the record', (keysEnd.b.data || []).some((k) => k.id === ids.keyId && (k.status === 'revoked' || k.revoked_at || k.revokedAt)), (keysEnd.b.data || []).find((k) => k.id === ids.keyId));
        } finally {
            await receiver.stop();
            ctx.save();
        }
    }
};
